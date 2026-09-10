'use strict';

const TERMINAL_STATES = new Set([
    'completed', 'failed', 'aborted', 'timed-out', 'rejected-busy', 'expired', 'lost-on-reload',
]);
const ACTIVE_STATES = new Set(['running', 'running-background', 'queued', 'waiting-kernel', 'pending']);

function stateOf(event) {
    if (event?.background && event?.state === 'running') return 'running-background';
    if (event?.state) return event.state;
    if (/failed|error/.test(event?.type || '')) return 'failed';
    if (/completed|saved/.test(event?.type || '')) return 'completed';
    return 'observed';
}

function actorOf(event) {
    if (event?.agentSessionId || event?.agentName || event?.source === 'mcp' || event?.source === 'copilot') {
        const sessionId = event.agentSessionId || null;
        return {
            kind: 'agent',
            name: event.agentName || (event.source === 'copilot' ? 'Copilot' : 'MCP client'),
            sessionId,
            label: `${event.agentName || (event.source === 'copilot' ? 'Copilot' : 'MCP client')}${sessionId ? ` · ${sessionId.slice(0, 6)}` : ''}`,
        };
    }
    return { kind: 'system', name: 'VS Code', sessionId: null, label: 'VS Code system' };
}

function meaningfulStandalone(event) {
    if (!event || event.operationId) return false;
    if (event.type?.startsWith('notebook.cell.')) return true;
    if (event.type === 'notebook.saved') return true;
    if (event.type?.startsWith('tool.')) return true;
    return false;
}

function projectActivity(events = [], topology = {}) {
    const ordered = [...events].filter(Boolean).sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    const byOperation = new Map();
    const standalone = [];
    const diagnostics = [];

    for (const event of ordered) {
        if (!event.operationId) {
            if (meaningfulStandalone(event)) standalone.push(fromStandalone(event));
            else diagnostics.push(event);
            continue;
        }
        let operation = byOperation.get(event.operationId);
        if (!operation) {
            operation = {
                id: event.operationId,
                operationId: event.operationId,
                actor: actorOf(event),
                tool: event.payload?.tool || event.payload?.initiatingTool || null,
                caption: event.payload?.caption || null,
                state: stateOf(event),
                startedAt: Number(event.timestamp || 0),
                completedAt: null,
                durationMs: null,
                input: null,
                output: null,
                error: null,
                progress: [],
                notebook: event.notebook || null,
                cellId: event.payload?.cellId || null,
                cellNumber: event.payload?.cellNumber ?? null,
                kernelId: event.kernelId || null,
                kernelLabel: event.kernelLabel || null,
                source: event.source || null,
                clientId: event.clientId || null,
                workspace: event.workspace || null,
                changes: [],
                events: [],
            };
            byOperation.set(event.operationId, operation);
        }
        mergeEvent(operation, event);
    }

    const operations = [...byOperation.values(), ...standalone]
        .map(finalize)
        .sort((a, b) => (b.completedAt || b.startedAt) - (a.completedAt || a.startedAt));
    const sessions = projectSessions(ordered, topology, operations);
    const activeOperations = operations.filter(operation => ACTIVE_STATES.has(operation.state));
    const failures = operations.filter(operation => ['failed', 'timed-out', 'rejected-busy', 'lost-on-reload'].includes(operation.state));
    return {
        version: 1,
        now: Date.now(),
        operations,
        activeOperations,
        sessions,
        diagnostics,
        summary: {
            connectedAgents: sessions.filter(session => session.connected).length,
            runningOperations: activeOperations.length,
            issues: failures.length,
        },
    };
}

function mergeEvent(operation, event) {
    const payload = event.payload || {};
    const state = stateOf(event);
    operation.events.push(event);
    operation.startedAt = Math.min(operation.startedAt, Number(event.timestamp || operation.startedAt));
    if (operation.actor.kind !== 'agent' || event.agentName || (event.agentSessionId && !operation.actor.sessionId)) {
        operation.actor = actorOf({ ...event, agentName: event.agentName || (operation.actor.kind === 'agent' ? operation.actor.name : null),
            agentSessionId: event.agentSessionId || operation.actor.sessionId });
    }
    operation.tool = payload.tool || payload.initiatingTool || payload.operation?.tool || operation.tool;
    operation.caption = payload.caption || payload.operation?.caption || operation.caption;
    operation.notebook = event.notebook || payload.notebook || payload.operation?.notebook || operation.notebook;
    operation.cellId = payload.cellId || payload.operation?.cellId || operation.cellId;
    operation.cellNumber = payload.cellNumber ?? payload.operation?.cellNumber ?? operation.cellNumber;
    operation.kernelId = event.kernelId || payload.kernelId || payload.operation?.kernelId || operation.kernelId;
    operation.kernelLabel = event.kernelLabel || payload.kernelLabel || payload.operation?.kernelLabel || operation.kernelLabel;
    operation.clientId = event.clientId || operation.clientId;
    operation.workspace = event.workspace || operation.workspace;

    if (event.type?.startsWith('tool.')) operation.input = payload.input ?? payload.args ?? operation.input;
    if (String(operation.tool || '').startsWith('paper_') && operation.input && typeof operation.input === 'object') {
        if (typeof operation.input.file === 'string') operation.notebook = operation.input.file;
        operation.selector = operation.input.selector || operation.input.stable_key || operation.input.label || null;
    }
    if (event.type === 'tool.completed') operation.output = payload.output ?? payload.result ?? operation.output;
    if (event.type === 'tool.failed') operation.error = payload.error ?? payload.output ?? payload.result ?? operation.error;
    if (payload.progress) operation.progress.push(payload.progress);
    if (event.type?.startsWith('notebook.')) operation.changes.push({
        type: event.type, timestamp: event.timestamp, notebook: event.notebook, ...payload,
    });

    const embedded = payload.operation || (/^kernel\.operation\./.test(event.type || '') ? payload : null);
    if (embedded) {
        operation.tool = embedded.tool || operation.tool;
        operation.caption = embedded.caption || operation.caption;
        operation.input = embedded.source || embedded.argsSummary || operation.input;
        operation.output = embedded.resultPreview || operation.output;
        operation.error = embedded.error || operation.error;
        operation.cellId = embedded.cellId || operation.cellId;
        operation.cellNumber = embedded.cellNumber ?? operation.cellNumber;
    }

    const execution = event.type?.startsWith('kernel.operation.');
    if (execution && !operation.hasExecution) {
        operation.hasExecution = true;
        operation.completedAt = null;
    }
    // A save/edit event is evidence of a mutation, not completion of its parent.
    // Transport acceptance must never settle a detached kernel evaluation.
    const controlsState = execution || (event.type?.startsWith('tool.') && !operation.hasExecution);
    if (!controlsState) return;
    if (state === 'accepted') {
        operation.state = 'running-background';
    } else if (TERMINAL_STATES.has(state)) {
        operation.state = state;
        operation.completedAt = Number(event.timestamp || 0);
    } else if (!operation.completedAt) {
        operation.state = state;
    }
    if (payload.durationMs != null) operation.durationMs = Number(payload.durationMs);
}

function finalize(operation) {
    if (operation.completedAt && operation.durationMs == null) {
        operation.durationMs = Math.max(0, operation.completedAt - operation.startedAt);
    }
    if (!operation.tool) operation.tool = operation.changes.length ? 'Notebook change' : 'Wolfram operation';
    if (!operation.caption && typeof operation.input === 'object' && operation.input) {
        operation.caption = operation.input.caption || operation.input.action || null;
    }
    return operation;
}

function fromStandalone(event) {
    const payload = event.payload || {};
    return finalize({
        id: event.eventId,
        operationId: null,
        actor: actorOf(event),
        tool: payload.tool || payload.initiatingTool || (/^notebook\.cell\./.test(event.type) ? 'Notebook change' : event.type),
        caption: payload.action || null,
        state: stateOf(event),
        startedAt: Number(event.timestamp || 0),
        completedAt: Number(event.timestamp || 0),
        durationMs: payload.durationMs ?? null,
        input: payload.input ?? payload.args ?? payload.source ?? null,
        output: payload.output ?? payload.result ?? null,
        error: payload.error ?? null,
        progress: payload.progress ? [payload.progress] : [],
        notebook: event.notebook || null,
        cellId: payload.cellId || null,
        cellNumber: payload.cellNumber ?? null,
        kernelId: event.kernelId || null,
        kernelLabel: event.kernelLabel || null,
        source: event.source || null,
        clientId: event.clientId || null,
        workspace: event.workspace || null,
        changes: event.type?.startsWith('notebook.') ? [{ type: event.type, timestamp: event.timestamp, notebook: event.notebook, ...payload }] : [],
        events: [event],
    });
}

function projectSessions(events, topology, operations) {
    const sessions = new Map();
    const authoritative = Array.isArray(topology?.sessions);
    for (const raw of Array.isArray(topology?.sessions) ? topology.sessions : []) {
        if (!raw?.sessionId) continue;
        sessions.set(raw.sessionId, {
            sessionId: raw.sessionId,
            name: raw.agentName || 'MCP client',
            label: `${raw.agentName || 'MCP client'} · ${raw.sessionId.slice(0, 6)}`,
            profile: raw.profile || 'full',
            connected: true,
            hostClientId: raw.hostClientId || null,
            hostWorkspace: raw.hostWorkspace || null,
            targetClientId: raw.targetClientId || null,
            targetWorkspace: raw.targetWorkspace || null,
            notebook: raw.notebook || null,
        });
    }
    for (const event of events) {
        if (!event.agentSessionId) continue;
        const current = sessions.get(event.agentSessionId) || {
            sessionId: event.agentSessionId,
            name: event.agentName || 'MCP client',
            profile: event.payload?.profile || 'full',
            connected: false,
        };
        if (event.agentName) current.name = event.agentName;
        if (!authoritative) {
            if (event.type === 'agent.connected' || event.type === 'agent.initialized') current.connected = true;
            if (event.type === 'agent.disconnected') current.connected = false;
        }
        current.label = `${current.name} · ${event.agentSessionId.slice(0, 6)}`;
        sessions.set(event.agentSessionId, current);
    }
    for (const operation of operations) {
        const session = operation.actor?.sessionId && sessions.get(operation.actor.sessionId);
        if (!session) continue;
        if (!session.lastOperation || operation.startedAt > session.lastOperation.startedAt) session.lastOperation = operation;
    }
    return [...sessions.values()].filter(session => session.connected || ACTIVE_STATES.has(session.lastOperation?.state))
        .sort((a, b) => Number(b.lastOperation?.startedAt || 0) - Number(a.lastOperation?.startedAt || 0));
}

module.exports = { projectActivity, actorOf, stateOf, ACTIVE_STATES, TERMINAL_STATES };
