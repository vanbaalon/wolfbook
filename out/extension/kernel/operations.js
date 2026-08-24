'use strict';

const crypto = require('crypto');
const { sanitizeCaption } = require('./arbiter');
const eventBus = require('../remote/eventBus');

function emitOperation(action, operation, extra = {}) {
    if (!operation || eventBus.listenerCount('operation') === 0) return;
    eventBus.emit('operation', { action, ts: Date.now(), operation: {
        id: operation.id, tool: operation.tool, notebook: operation.notebook,
        cellId: operation.cellId, cellNumber: operation.cellNumber,
        kernelId: operation.kernelId, kernelLabel: operation.kernelLabel,
        caption: operation.caption, owner: operation.owner,
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
    }

    create(spec = {}) {
        const id = spec.id || crypto.randomUUID();
        const op = {
            id, tool: spec.tool || 'unknown', argsSummary: String(spec.argsSummary || '').slice(0, 500),
            notebook: spec.notebook || null, cellId: spec.cellId || null,
            kernelId: spec.kernelId || null, kernelLabel: spec.kernelLabel || null,
            cellNumber: spec.cellNumber || null,
            caption: sanitizeCaption(spec.caption, spec.tool || 'Wolfram operation'),
            owner: spec.owner || 'agent', state: spec.state || 'pending',
            background: !!spec.background,
            phase: spec.phase || 'queued', startedAt: spec.startedAt || Date.now(), endedAt: null,
            retrievalExpiry: spec.retrievalExpiry || null,
            result: null, resultPreview: null, error: null, cancellation: null,
            progress: [], progressBytes: 0, progressSequence: 0,
            cells: [],
        };
        let resolveDone;
        op.promise = new Promise(resolve => { resolveDone = resolve; });
        op._resolveDone = resolveDone;
        this._items.set(id, op);
        this._order.push(id);
        this._trim();
        emitOperation('created', op);
        return op;
    }

    get(id) { return this._items.get(id) || null; }
    active() { return [...this._items.values()].find(op => op.state === 'running' || op.state === 'pending') || null; }

    start(id, phase = 'evaluating') {
        const op = this.get(id); if (!op) return null;
        op.state = 'running'; op.phase = phase; emitOperation('started', op); return op;
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
        const sourceHash = crypto.createHash('sha256').update(String(spec.source || '')).digest('hex');
        const record = {
            operationId: id, notebook: spec.notebook || null, cellId: spec.cellId || null,
            cellNumber: spec.cellNumber ?? null, sourceHash, status: 'running',
            startedAt: Date.now(), completedAt: null, currentSourceHash: null,
            outputCount: 0, messageCount: 0, resultPreview: null,
        };
        op.cells.push(record);
        this._latestCells.set(this._cellKey(record.notebook, record.cellId), record);
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
            kernel_id: op.kernelId, kernel_label: op.kernelLabel,
            state: op.state, phase: op.phase, notebook: op.notebook, cell_id: op.cellId,
            cell_number: op.cellNumber, started_at: new Date(op.startedAt).toISOString(),
            ended_at: op.endedAt ? new Date(op.endedAt).toISOString() : null,
            elapsed_ms: (op.endedAt || Date.now()) - op.startedAt,
            retrieval_expiry: op.retrievalExpiry ? new Date(op.retrievalExpiry).toISOString() : null,
            result_preview: op.resultPreview, error: op.error, cancellation: op.cancellation,
            has_structured_result: op.structured != null || typeof op.structuredJson === 'string',
            cells: op.cells.map(cell => ({ ...cell })),
            assertion: op.assertion || null,   // expect outcome — assertions are journaled acts
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

    invalidateAll(reason = 'kernel restart') {
        this.hasRestarted = true;
        this._latestCells.clear();
        for (const op of this._items.values()) {
            if (op.state === 'pending' || op.state === 'running') this.abort(op.id, { requestedBy: 'system', reason, ts: Date.now() });
        }
    }

    _settle(id, state, patch) {
        const op = this.get(id); if (!op) return null;
        if (!['pending', 'running'].includes(op.state)) return op;
        const endedAt = Date.now();
        Object.assign(op, patch, { state, phase: state, endedAt,
            retrievalExpiry: endedAt + this.retrievalTtlMs });
        op._resolveDone(op);
        this._trim();
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
}

function _preview(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result.slice(0, 1000);
    try { return JSON.stringify(result).slice(0, 1000); } catch (_) { return String(result).slice(0, 1000); }
}

module.exports = { OperationRegistry };
