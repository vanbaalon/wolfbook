'use strict';

const util = require('util');

/** Decode only outputs committed to the VS Code notebook cell. */
function readCommittedOutputs(cell) {
    const decoder = new util.TextDecoder();
    const outputs = [];
    const messages = [];
    for (const output of (cell?.outputs || [])) {
        const mimes = output.items.map(item => item.mime);
        const plain = output.items.find(item => item.mime === 'text/plain');
        if (!plain) continue;
        let value = '';
        try { value = decoder.decode(plain.data); } catch (_) { continue; }
        if (!value.trim()) continue;
        const sentinel = mimes.includes('x-application/wolfram-language-html') &&
            mimes.includes('application/vnd.code.notebook.error');
        (sentinel ? messages : outputs).push(value);
    }
    const failed = outputs.some(value => /^\s*\$Failed\s*$/.test(value));
    const aborted = outputs.some(value => /^\s*\$Aborted\s*$/.test(value));
    return {
        outputs, messages, failed, aborted,
        plain: [...outputs, ...messages].join('\n'),
    };
}

/**
 * Classify the run from the strongest available evidence.
 * Tier A — per-cell provenance (only MCP operation-tracked runs produce it).
 * Tier B — the VS Code execution record: executionSummary.timing.endTime
 *          advanced past its pre-dispatch value (always available).
 * Tier C — committed outputs appeared (positive evidence only).
 * "✓" without any of these is exactly the phantom-run bug — never claim it.
 */
function classifyEvidence({ dispatched, skipReason, timedOut, cancelled, before, cell, provenance, committed }) {
    if (!dispatched) {
        return { state: 'not-dispatched', tier: null, reason: skipReason || 'unknown' };
    }
    if (cancelled) return { state: 'aborted', tier: null, reason: 'cancelled' };
    const provDone = provenance && provenance.status && provenance.status !== 'running';
    const endTime = cell?.executionSummary?.timing?.endTime ?? 0;
    const summaryAdvanced = endTime > (before?.endTime ?? 0);
    if (provDone) {
        const s = provenance.status;
        const state = s === 'aborted' ? 'aborted'
            : s === 'failed' ? 'failed'
            : s === 'completed-with-messages' ? 'evaluated-with-messages'
            : (provenance.outputCount > 0 || committed.outputs.length > 0) ? 'evaluated-with-output'
            : 'evaluated-no-output';
        return { state, tier: 'A', reason: null };
    }
    if (summaryAdvanced) {
        const success = cell?.executionSummary?.success;
        const state = committed.failed ? 'failed'
            : committed.aborted ? 'aborted'
            : committed.messages.length > 0 ? 'evaluated-with-messages'
            : committed.outputs.length > 0 ? 'evaluated-with-output'
            : success === false ? 'failed'
            : 'evaluated-no-output';
        return { state, tier: 'B', reason: null };
    }
    if (timedOut) return { state: 'timeout', tier: null, reason: 'deadline' };
    // Dispatched, deadline not hit, but no execution record ever advanced:
    // the honest answer is "we cannot confirm this ran".
    return { state: 'dispatched-unconfirmed', tier: null,
        reason: 'no execution record; the cell may not have reached the kernel' };
}

/** Wait for the cell's execution to finish: event-driven with a cheap poll backstop. */
async function waitForCompletion(ctrl, cell, before, { deadline, token, provenanceProbe }) {
    let vscode = null;
    try { vscode = require('vscode'); } catch (_) {}
    const cellUri = cell?.document?.uri?.toString?.();
    return await new Promise(resolve => {
        let sub = null;
        let settled = false;
        const finish = (how) => {
            if (settled) return;
            settled = true;
            try { sub?.dispose(); } catch (_) {}
            resolve(how);
        };
        const isDone = () => {
            const endTime = cell?.executionSummary?.timing?.endTime ?? 0;
            if (endTime > (before?.endTime ?? 0) &&
                !ctrl._evalDispatched && ctrl.executionQueue.queueLength() === 0) return true;
            const prov = provenanceProbe?.();
            if (prov && prov.status && prov.status !== 'running' &&
                !ctrl._evalDispatched && ctrl.executionQueue.queueLength() === 0) return true;
            return false;
        };
        try {
            sub = vscode?.workspace?.onDidChangeNotebookDocument?.(ev => {
                if (ev.notebook !== cell.notebook) return;
                const touched = (ev.cellChanges || []).some(ch =>
                    ch.cell?.document?.uri?.toString?.() === cellUri &&
                    (ch.executionSummary || ch.outputs));
                if (touched && isDone()) finish('event');
            });
        } catch (_) {}
        const poll = () => {
            if (settled) return;
            if (token.isCancellationRequested) return finish('cancelled');
            if (isDone()) return finish('poll');
            if (Date.now() >= deadline) return finish('deadline');
            setTimeout(poll, 50);
        };
        setTimeout(poll, 50);
    });
}

/**
 * Run one code cell through the controller's canonical checkout pipeline and
 * return a view derived exclusively from evidence: the dispatch report from
 * execute(), per-cell provenance, the VS Code execution record, and committed
 * outputs.  Success is never inferred from mere absence of activity.
 */
async function runCellViaPipeline(ctrl, editor, idx, options = {}) {
    if (!ctrl || typeof ctrl.execute !== 'function' || ctrl.kernelStatusString !== 'resolved') {
        throw new Error('Wolfram kernel is not running.');
    }
    const notebook = editor.notebook;
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 30000);
    const token = options.token || { isCancellationRequested: false };
    const snapshot = options.snapshotViewport?.(notebook) || null;
    if (snapshot) {
        ctrl._scrollGuardSavedViewport = snapshot.viewport;
        ctrl._scrollGuardSavedSelections = snapshot.selections;
        ctrl._agentGuardActive = true;
    }

    const targetCell = notebook.cellAt(idx);
    const before = {
        endTime: targetCell.executionSummary?.timing?.endTime ?? 0,
        order:   targetCell.executionSummary?.executionOrder ?? null,
    };
    const cellId = options.getCellId?.(targetCell) || null;
    const provenanceProbe = () =>
        ctrl.operations?.cellState?.(notebook.uri.fsPath, cellId) || null;

    ctrl._silentExecution = true;
    let report = null;
    let waitOutcome = 'deadline';
    try {
        ctrl._wolframExecPending = true;
        // Awaited: execute() now performs controller association up front and
        // reports per-cell dispatch, so "not associated → silently skipped"
        // can no longer masquerade as success.
        report = await ctrl.execute([targetCell], notebook, ctrl._controller);
        const skipped = report?.skipped?.find(s => s.index === targetCell.index) || null;
        if (!skipped) {
            waitOutcome = await waitForCompletion(ctrl, targetCell, before, {
                deadline: Date.now() + timeoutMs, token, provenanceProbe,
            });
            // Settle window: let trailing output commits land before reading.
            if (waitOutcome === 'event' || waitOutcome === 'poll') {
                await new Promise(r => setTimeout(r, 120));
            }
        }
    } finally {
        ctrl._silentExecution = false;
        ctrl._agentGuardActive = false;
    }

    if (options.flashCell) await options.flashCell(editor, idx);
    const cell = notebook.cellAt(idx);
    const committed = readCommittedOutputs(cell);
    const skipEntry = report?.skipped?.find(s => s.index === cell.index) || null;
    const dispatched = !skipEntry && (report?.dispatched?.some(d => d.index === cell.index)
        // Older execute() (worker windows on a previous build) returns undefined:
        // treat as dispatched and let the evidence tiers decide.
        || report === undefined || report === null);
    const provenance = provenanceProbe();
    const timedOut = waitOutcome === 'deadline' &&
        !!(ctrl._evalDispatched || ctrl.executionQueue.queueLength() > 0);
    const evidence = classifyEvidence({
        dispatched, skipReason: skipEntry?.reason,
        timedOut: waitOutcome === 'deadline', cancelled: token.isCancellationRequested,
        before, cell, provenance, committed,
    });
    return {
        cell,
        dispatched,
        state: evidence.state,
        evidence: { tier: evidence.tier, reason: evidence.reason,
            executionEndTime: cell.executionSummary?.timing?.endTime ?? null },
        timedOut: evidence.state === 'timeout' || timedOut,
        cancelled: !!token.isCancellationRequested,
        provenance,
        ...committed,
    };
}

module.exports = { readCommittedOutputs, runCellViaPipeline, classifyEvidence, waitForCompletion };
