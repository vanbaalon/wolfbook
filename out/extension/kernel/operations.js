'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeCaption } = require('./arbiter');
const eventBus = require('../remote/eventBus');

function emitOperation(action, operation, extra = {}) {
    if (!operation || eventBus.listenerCount('operation') === 0) return;
    eventBus.emit('operation', { action, ts: Date.now(), operation: {
        id: operation.id, tool: operation.tool, notebook: operation.notebook,
        cellId: operation.cellId, cellNumber: operation.cellNumber,
        kernelId: operation.kernelId, kernelLabel: operation.kernelLabel,
        caption: operation.caption, owner: operation.owner,
        agentSessionId: operation.agentSessionId, agentName: operation.agentName,
        traceId: operation.traceId,
        state: operation.state, phase: operation.phase, startedAt: operation.startedAt,
        endedAt: operation.endedAt, resultPreview: operation.resultPreview,
        error: operation.error, background: operation.background || false,
    }, ...extra });
}

class OperationRegistry {
    constructor(options = {}) {
        this.maxOperations = options.maxOperations || 50;
        this.maxProgressBytes = options.maxProgressBytes || 32768;
        this.retrievalTtlMs = options.retrievalTtlMs || 60 * 60 * 1000;
        this._items = new Map();
        this._order = [];
        this._latestCells = new Map();
        this.hasRestarted = false;
        this._persistencePath = null;
    }

    /** Attach a stable per-kernel-slot journal after KernelManager assigns the
     * slot. Any nonterminal record from the previous extension host is made
     * explicit as lost-on-reload instead of silently disappearing. */
    setPersistence(file) {
        if (!file || this._persistencePath === file) return;
        this._persistencePath = file;
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const raw of Array.isArray(saved?.operations) ? saved.operations.slice(-this.maxOperations) : []) {
                if (!raw?.id || this._items.has(raw.id)) continue;
                const wasActive = ['pending', 'running'].includes(raw.state);
                const op = { ...raw,
                    state: wasActive ? 'lost-on-reload' : raw.state,
                    phase: wasActive ? 'lost-on-reload' : raw.phase,
                    endedAt: wasActive ? Date.now() : raw.endedAt,
                    retrievalExpiry: raw.retrievalExpiry || (Date.now() + this.retrievalTtlMs),
                    error: wasActive ? 'Extension host reloaded before the operation completed.' : raw.error,
                    cancellation: wasActive ? { requestedBy: 'system', reason: 'extension host reload', ts: Date.now() } : raw.cancellation,
                };
                op.progress = Array.isArray(op.progress) ? op.progress : [];
                op.cells = Array.isArray(op.cells) ? op.cells : [];
                op.promise = Promise.resolve(op);
                op._resolveDone = () => {};
                this._items.set(op.id, op);
                this._order.push(op.id);
                for (const cell of op.cells) this._latestCells.set(this._cellKey(cell.notebook, cell.cellId), cell);
            }
            this._trim();
            this._persist();
        } catch (_) {
            this._persist();
        }
    }

    create(spec = {}) {
        const id = spec.id || crypto.randomUUID();
        const source = spec.source == null ? null : String(spec.source).slice(0, 1048576);
        const op = {
            id, tool: spec.tool || 'unknown', argsSummary: String(spec.argsSummary || '').slice(0, 500),
            notebook: spec.notebook || null, cellId: spec.cellId || null,
            kernelId: spec.kernelId || null, kernelLabel: spec.kernelLabel || null,
            cellNumber: spec.cellNumber || null,
            caption: sanitizeCaption(spec.caption, spec.tool || 'Wolfram operation'),
            owner: spec.owner || 'agent', state: spec.state || 'pending',
            agentSessionId: spec.agentSessionId || null, agentName: spec.agentName || null,
            traceId: spec.traceId || spec.id || id,
            background: !!spec.background,
            phase: spec.phase || 'queued', startedAt: spec.startedAt || Date.now(), endedAt: null,
            retrievalExpiry: spec.retrievalExpiry || null,
            result: null, resultPreview: null, error: null, cancellation: null,
            progress: [], progressBytes: 0, progressSequence: 0,
            // Source is deliberately separate from argsSummary. argsSummary is
            // small and often becomes invalid JSON when a long expression is
            // truncated; the status indicator needs the original WL source.
            source, sourceTruncated: spec.source != null && String(spec.source).length > 1048576,
            cells: [],
        };
        let resolveDone;
        op.promise = new Promise(resolve => { resolveDone = resolve; });
        op._resolveDone = resolveDone;
        this._items.set(id, op);
        this._order.push(id);
        this._trim();
        this._persist();
        emitOperation('created', op);
        return op;
    }

    get(id) { return this._items.get(id) || null; }
    active() { return [...this._items.values()].find(op => op.state === 'running' || op.state === 'pending') || null; }

    start(id, phase = 'evaluating') {
        const op = this.get(id); if (!op) return null;
        op.state = 'running'; op.phase = phase; this._persist(); emitOperation('started', op); return op;
    }

    complete(id, result, preview) { return this._settle(id, 'completed', { result, resultPreview: preview ?? _preview(result) }); }
    fail(id, error) { return this._settle(id, 'failed', { error: String(error?.message || error), resultPreview: String(error?.message || error).slice(0, 1000) }); }
    abort(id, cancellation = {}) { return this._settle(id, 'aborted', { cancellation, resultPreview: 'Evaluation aborted.' }); }
    expire(id) { return this._settle(id, 'expired', { resultPreview: 'Operation expired.' }); }

    appendProgress(id, kind, value) {
        const op = this.get(id); if (!op) return null;
        const item = { sequence: ++op.progressSequence, kind, value: String(value), ts: Date.now() };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        op.progress.push(item); op.progressBytes += bytes;
        while (op.progress.length && op.progressBytes > this.maxProgressBytes) {
            const removed = op.progress.shift();
            op.progressBytes -= Buffer.byteLength(JSON.stringify(removed));
        }
        emitOperation('progress', op, { progress: item });
        return item;
    }

    beginCell(id, spec = {}) {
        const op = this.get(id); if (!op) return null;
        const rawSource = String(spec.source || '');
        const sourceHash = crypto.createHash('sha256').update(rawSource).digest('hex');
        const record = {
            operationId: id, notebook: spec.notebook || null, cellId: spec.cellId || null,
            cellNumber: spec.cellNumber ?? null, sourceHash, status: 'running',
            startedAt: Date.now(), completedAt: null, currentSourceHash: null,
            outputCount: 0, messageCount: 0, resultPreview: null,
            source: rawSource.slice(0, 1048576), sourceTruncated: rawSource.length > 1048576,
        };
        // The latest actually-dispatched cell is the best representation of a
        // multi-cell operation in the kernel activity UI.
        op.source = record.source;
        op.sourceTruncated = record.sourceTruncated;
        op.notebook = record.notebook || op.notebook;
        op.cellId = record.cellId || op.cellId;
        op.cellNumber = record.cellNumber ?? op.cellNumber;
        op.cells.push(record);
        this._latestCells.set(this._cellKey(record.notebook, record.cellId), record);
        this._persist();
        return record;
    }

    finishCell(id, spec = {}) {
        const op = this.get(id); if (!op) return null;
        const record = [...op.cells].reverse().find(c => c.cellId === spec.cellId && c.status === 'running');
        if (!record) return null;
        const currentSourceHash = crypto.createHash('sha256').update(String(spec.currentSource || '')).digest('hex');
        const stale = currentSourceHash !== record.sourceHash;
        Object.assign(record, {
            currentSourceHash, completedAt: Date.now(),
            status: stale ? 'stale' : (spec.status || 'success'),
            outputCount: stale ? 0 : Number(spec.outputCount || 0), messageCount: Number(spec.messageCount || 0),
            // A stale result must not be attached to the edited cell, but it is
            // retained here so the operation journal remains auditable.
            resultPreview: String(spec.resultPreview || '').slice(0, 16384),
        });
        this._persist();
        return record;
    }

    cellState(notebook, cellId) {
        const value = this._latestCells.get(this._cellKey(notebook, cellId));
        return value ? { ...value } : null;
    }

    snapshot(id, options = {}) {
        const op = this.get(id); if (!op) return null;
        const result = {
            operation_id: op.id, tool: op.tool, caption: op.caption, owner: op.owner,
            agent_session_id: op.agentSessionId, agent_name: op.agentName, trace_id: op.traceId,
            kernel_id: op.kernelId, kernel_label: op.kernelLabel,
            state: op.state, phase: op.phase, notebook: op.notebook, cell_id: op.cellId,
            cell_number: op.cellNumber, started_at: new Date(op.startedAt).toISOString(),
            ended_at: op.endedAt ? new Date(op.endedAt).toISOString() : null,
            elapsed_ms: (op.endedAt || Date.now()) - op.startedAt,
            retrieval_expiry: op.retrievalExpiry ? new Date(op.retrievalExpiry).toISOString() : null,
            result_preview: op.resultPreview, error: op.error, cancellation: op.cancellation,
            has_structured_result: op.structured != null || typeof op.structuredJson === 'string',
            source_preview: op.source == null ? null : op.source.slice(0, 4000),
            source_length: op.source == null ? 0 : op.source.length,
            source_truncated: !!op.sourceTruncated,
            cells: op.cells.map(cell => {
                const { source, ...rest } = cell;
                return { ...rest, sourcePreview: source == null ? null : source.slice(0, 4000),
                    sourceLength: source == null ? 0 : source.length };
            }),
            assertion: op.assertion || null,   // expect outcome — assertions are journaled acts
            next_action: ['pending', 'running'].includes(op.state) ? 'wait'
                : (op.result != null || op.structured != null || typeof op.structuredJson === 'string') ? 'getResult' : 'none',
        };
        if (options.includeProgress) {
            const after = Number(options.afterSequence || 0);
            result.progress = op.progress.filter(p => p.sequence > after).map(p => ({ ...p }));
            result.progress_sequence = op.progressSequence;
        }
        return result;
    }

    journal(limit = 20) {
        return this._order.slice(-Math.max(1, Math.min(50, limit))).reverse()
            .map(id => this.snapshot(id)).filter(Boolean);
    }

    async wait(id, timeoutMs) {
        const op = this.get(id); if (!op) return { found: false };
        if (!['pending', 'running'].includes(op.state)) return { found: true, settled: true, operation: op };
        let timer;
        const timed = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
        const settled = await Promise.race([op.promise.then(() => true), timed]);
        clearTimeout(timer);
        return { found: true, settled, operation: op };
    }

    async waitForChange(id, afterSequence, timeoutMs) {
        const op = this.get(id); if (!op) return { found: false };
        const after = Math.max(0, Number(afterSequence || 0));
        if (!['pending', 'running'].includes(op.state) || op.progressSequence > after) {
            return { found: true, settled: !['pending', 'running'].includes(op.state), changed: true, operation: op };
        }
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const remaining = timeoutMs - (Date.now() - started);
            await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, remaining))));
            const current = this.get(id);
            if (!current) return { found: false };
            if (!['pending', 'running'].includes(current.state) || current.progressSequence > after) {
                return { found: true, settled: !['pending', 'running'].includes(current.state), changed: true, operation: current };
            }
        }
        return { found: true, settled: false, changed: false, operation: this.get(id) };
    }

    invalidateAll(reason = 'kernel restart') {
        this.hasRestarted = true;
        this._latestCells.clear();
        for (const op of this._items.values()) {
            if (op.state === 'pending' || op.state === 'running') this.abort(op.id, { requestedBy: 'system', reason, ts: Date.now() });
        }
    }

    markLost(reason = 'extension host reload') {
        for (const op of this._items.values()) {
            if (!['pending', 'running'].includes(op.state)) continue;
            const endedAt = Date.now();
            Object.assign(op, { state: 'lost-on-reload', phase: 'lost-on-reload', endedAt,
                retrievalExpiry: endedAt + this.retrievalTtlMs,
                error: `Operation lost: ${reason}.`,
                cancellation: { requestedBy: 'system', reason, ts: endedAt } });
            op._resolveDone(op);
            emitOperation('settled', op);
        }
        this._persist();
    }

    _settle(id, state, patch) {
        const op = this.get(id); if (!op) return null;
        if (!['pending', 'running'].includes(op.state)) return op;
        const endedAt = Date.now();
        Object.assign(op, patch, { state, phase: state, endedAt,
            retrievalExpiry: endedAt + this.retrievalTtlMs });
        op._resolveDone(op);
        this._trim();
        this._persist();
        emitOperation('settled', op);
        return op;
    }

    _trim() {
        while (this._order.length > this.maxOperations) {
            const idx = this._order.findIndex(id => {
                const op = this._items.get(id); return op && !['pending', 'running'].includes(op.state);
            });
            if (idx < 0) break;
            const [id] = this._order.splice(idx, 1); this._items.delete(id);
            for (const [key, value] of this._latestCells) {
                if (value.operationId === id) this._latestCells.delete(key);
            }
        }
    }

    _cellKey(notebook, cellId) {
        let normalizedId = String(cellId || '');
        try { normalizedId = decodeURIComponent(normalizedId); } catch (_) {}
        normalizedId = normalizedId.replace(/=+$/, '');
        return `${String(notebook || '')}::${normalizedId}`;
    }

    _persist() {
        if (!this._persistencePath) return;
        try {
            fs.mkdirSync(path.dirname(this._persistencePath), { recursive: true });
            const operations = this._order.map(id => this._items.get(id)).filter(Boolean).map(op => {
                const { promise, _resolveDone, result, structured, fullResult, ...safe } = op;
                return safe;
            });
            const tmp = `${this._persistencePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, operations }), 'utf8');
            fs.renameSync(tmp, this._persistencePath);
        } catch (_) {}
    }
}

function _preview(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result.slice(0, 1000);
    try { return JSON.stringify(result).slice(0, 1000); } catch (_) { return String(result).slice(0, 1000); }
}

module.exports = { OperationRegistry };
