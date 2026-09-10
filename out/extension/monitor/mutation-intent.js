'use strict';

// VS Code notebook-change events are not guaranteed to retain the
// AsyncLocalStorage scope of the WorkspaceEdit that caused them. Keep a tiny,
// short-lived correlation table so audit events can still be attributed to the
// MCP request that initiated the mutation.
const intents = [];
const TTL_MS = 10000;

function normalizeNotebook(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

function beginMutationIntent(spec = {}) {
    const notebook = normalizeNotebook(spec.notebook);
    if (!notebook) return null;
    const now = Date.now();
    prune(now);
    const intent = {
        id: spec.operationId || `${now}-${Math.random().toString(36).slice(2)}`,
        notebook,
        operationId: spec.operationId || null,
        traceId: spec.traceId || spec.operationId || null,
        agentSessionId: spec.agentSessionId || null,
        agentName: spec.agentName || null,
        source: spec.source || 'mcp',
        tool: spec.tool || null,
        startedAt: now,
        expiresAt: now + TTL_MS,
    };
    intents.push(intent);
    return intent;
}

function endMutationIntent(intent) {
    if (!intent) return;
    // Change notifications may be delivered just after applyEdit resolves.
    intent.expiresAt = Math.min(intent.expiresAt, Date.now() + 1500);
}

function findMutationIntent(notebook) {
    const now = Date.now();
    prune(now);
    const wanted = normalizeNotebook(notebook);
    for (let i = intents.length - 1; i >= 0; i--) {
        if (intents[i].notebook === wanted) return { ...intents[i] };
    }
    return null;
}

function prune(now = Date.now()) {
    for (let i = intents.length - 1; i >= 0; i--) {
        if (intents[i].expiresAt <= now) intents.splice(i, 1);
    }
}

module.exports = { beginMutationIntent, endMutationIntent, findMutationIntent, normalizeNotebook };
