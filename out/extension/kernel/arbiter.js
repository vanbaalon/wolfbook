'use strict';

const crypto = require('crypto');

const JOURNAL_LIMIT = 100;

function _caption(value, fallback = 'Wolfram kernel operation') {
    const clean = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (clean || fallback).slice(0, 160);
}

function _physicalBusy(ctrl) {
    return !!(ctrl?._evalDispatched || ctrl?.isAborting || ctrl?._abortPending ||
        Number(ctrl?._directEvaluationCount || 0) > 0 ||
        Number(ctrl?.executionQueue?.queueLength?.() || 0) > 0);
}

class KernelArbiter {
    constructor() {
        this._active = null;
        this._journal = [];
        this._lastCompleted = null;
        this._lastAbort = null;
    }

    status(ctrl) {
        const queueDepth = Number(ctrl?.executionQueue?.queueLength?.() || 0);
        const dispatched = !!ctrl?._evalDispatched;
        const aborting = !!(ctrl?.isAborting || ctrl?._abortPending);
        const linkBusy = Number(ctrl?._directEvaluationCount || 0) > 0;
        const kernel = ctrl?.kernelStatusString || 'unresolved';
        let lifecycle = 'offline';
        if (kernel === 'launching') lifecycle = 'launching';
        else if (kernel === 'resolved') lifecycle = ctrl?._abortUncertain ? 'faulted' : (aborting ? 'aborting' : (this._active || dispatched || linkBusy || queueDepth > 0 ? 'busy' : 'idle'));
        else if (kernel === 'error') lifecycle = 'faulted';

        const active = this._active ? { ...this._active } : null;
        const now = Date.now();
        if (active) active.elapsedMs = Math.max(0, now - active.startedAt);
        return {
            kernel_id: ctrl?.kernelIdentity?.kernel_id || null,
            kernel_label: ctrl?.kernelIdentity?.label || null,
            lifecycle,
            kernelStatus: kernel,
            linkHealth: kernel === 'resolved' ? (ctrl?._abortUncertain ? 'uncertain' : 'connected') :
                (kernel === 'error' ? 'faulted' : 'disconnected'),
            busy: lifecycle === 'busy' || lifecycle === 'aborting',
            activeOperation: active,
            queueDepth,
            queuedOperations: [],
            abortPending: !!ctrl?._abortPending,
            isAborting: !!ctrl?.isAborting,
            abortRequest: this._lastAbort ? { ...this._lastAbort } : null,
            evalDispatched: dispatched,
            directEvaluationCount: Number(ctrl?._directEvaluationCount || 0),
            dynamicCellCount: Number(ctrl?._dynCells?.size || 0),
            silentExecution: !!ctrl?._silentExecution,
            safeDocumentReadTools: [
                'wolfbook_getNotebookContext', 'wolfbook_getCellOutput',
                'wolfbook_searchCells', 'wolfbook_kernelStatus',
                'wolfbook_operationStatus', 'wolfbook_evaluationJournal'
            ],
            lastCompleted: this._lastCompleted ? { ...this._lastCompleted } : null,
            lastAbort: this._lastAbort ? { ...this._lastAbort } : null,
        };
    }

    async acquire(ctrl, options = {}) {
        const owner = String(options.owner || 'agent');
        const kind = String(options.kind || 'kernel-operation');
        const policy = options.policy === 'preempt' ? 'preempt' : 'reject';
        const status = this.status(ctrl);
        if (status.busy || this._active) {
            if (policy !== 'preempt') return { busy: this._busyPayload(ctrl) };
            const victim = this._active ? { ...this._active } : null;
            this._record('preempt-requested', { requestedBy: owner, victimOperationId: victim?.operationId || null });
            await ctrl.abortAndWait?.(10000, { notifyPriority: true, requestedBy: owner });
            this._lastAbort = {
                operationId: victim?.operationId || null,
                requestedBy: owner,
                reason: options.reason || 'explicit preempt policy',
                requestedAt: Date.now(),
            };
            if (_physicalBusy(ctrl)) return { busy: this._busyPayload(ctrl) };
            if (victim && this._active?.operationId === victim.operationId) this._active = null;
        }

        const lease = Object.freeze({
            operationId: options.operationId || crypto.randomUUID(),
            kernelId: ctrl?.kernelIdentity?.kernel_id || null,
            owner,
            kind,
            caption: _caption(options.caption, `${kind} by ${owner}`),
            notebook: options.notebook || null,
            cellId: options.cellId || null,
            cellNumber: options.cellNumber || null,
            sourcePreview: options.sourcePreview ? String(options.sourcePreview).slice(0, 160) : null,
            startedAt: Date.now(),
        });
        this._active = lease;
        this._record('acquired', lease);
        return { lease };
    }

    release(lease, outcome = 'completed') {
        if (!lease || this._active?.operationId !== lease.operationId) return false;
        const completed = { ...this._active, outcome, endedAt: Date.now() };
        this._active = null;
        this._lastCompleted = completed;
        this._record('released', completed);
        return true;
    }

    async abort(ctrl, options = {}) {
        const active = this._active ? { ...this._active } : null;
        if (options.operationId && active && options.operationId !== active.operationId) {
            return { aborted: false, reason: 'operation-mismatch', active: this._busyPayload(ctrl) };
        }
        const record = {
            operationId: active?.operationId || null,
            requestedBy: options.requestedBy || 'unknown',
            reason: options.reason || 'explicit abort',
            requestedAt: Date.now(),
        };
        this._lastAbort = record;
        this._record('abort-requested', record);
        await ctrl?.abortAndWait?.(options.timeoutMs || 10000, {
            notifyPriority: false, requestedBy: record.requestedBy, reason: record.reason
        });
        record.acknowledgedAt = Date.now();
        // The lease itself makes status() busy until it is released, so abort
        // acknowledgement must inspect only physical/queued kernel activity.
        record.uncertain = _physicalBusy(ctrl);
        if (!record.uncertain && active && this._active?.operationId === active.operationId) {
            this.release(active, 'aborted');
        }
        this._record(record.uncertain ? 'abort-uncertain' : 'abort-acknowledged', record);
        return { aborted: !record.uncertain, ...record };
    }

    invalidate(reason = 'kernel restart', requestedBy = 'system') {
        if (this._active) {
            this._record('invalidated', { ...this._active, reason, requestedBy, endedAt: Date.now() });
            this._lastCompleted = { ...this._active, outcome: 'invalidated', reason, endedAt: Date.now() };
            this._active = null;
        }
    }

    journal() { return this._journal.map(entry => ({ ...entry })); }

    _busyPayload(ctrl) {
        const s = this.status(ctrl);
        const active = s.activeOperation;
        return {
            state: s.lifecycle,
            kernel_id: ctrl?.kernelIdentity?.kernel_id || null,
            kernel_label: ctrl?.kernelIdentity?.label || null,
            operation_id: active?.operationId || null,
            caption: active?.caption || (s.isAborting ? 'Kernel abort in progress' : 'User or notebook evaluation'),
            owner: active?.owner || (s.silentExecution ? 'agent' : 'notebook-ui'),
            kind: active?.kind || 'notebook-evaluation',
            notebook: active?.notebook || null,
            cell_id: active?.cellId || null,
            cell_number: active?.cellNumber || null,
            started_at: active?.startedAt ? new Date(active.startedAt).toISOString() : null,
            elapsed_ms: active?.elapsedMs || null,
            queue_depth: s.queueDepth,
            abort_pending: s.abortPending || s.isAborting,
            allowed_actions: active?.operationId ? ['wait', 'abort'] : ['status', 'abort'],
        };
    }

    _record(event, details = {}) {
        this._journal.push({ event, ts: Date.now(), ...details });
        if (this._journal.length > JOURNAL_LIMIT) this._journal.splice(0, this._journal.length - JOURNAL_LIMIT);
    }
}

module.exports = { KernelArbiter, sanitizeCaption: _caption, JOURNAL_LIMIT };
