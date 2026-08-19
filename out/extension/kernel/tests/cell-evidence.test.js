'use strict';

// Phase 1 regression tests for the phantom-run fix: success must be backed by
// evidence (provenance tier A / execution-record tier B), a skipped dispatch
// must surface as not-dispatched, and absence of activity must never classify
// as an evaluated state.

const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');

const { classifyEvidence, runCellViaPipeline, readCommittedOutputs } =
    withVscodeStub(() => require('../../tools/cell-pipeline'));

// ── classifyEvidence (pure) ─────────────────────────────────────────────────

const emptyCommitted = { outputs: [], messages: [], failed: false, aborted: false, plain: '' };

// Not dispatched → not-dispatched with the skip reason.
{
    const ev = classifyEvidence({
        dispatched: false, skipReason: 'not-associated', timedOut: false,
        cancelled: false, before: { endTime: 0 }, cell: null, provenance: null,
        committed: emptyCommitted,
    });
    assert.strictEqual(ev.state, 'not-dispatched');
    assert.strictEqual(ev.reason, 'not-associated');
}

// Dispatched but zero evidence and no timeout → dispatched-unconfirmed (the
// exact phantom-run signature: idle queue, no record, ~500 ms elapsed).
{
    const cell = { executionSummary: undefined };
    const ev = classifyEvidence({
        dispatched: true, timedOut: false, cancelled: false,
        before: { endTime: 0 }, cell, provenance: null, committed: emptyCommitted,
    });
    assert.strictEqual(ev.state, 'dispatched-unconfirmed');
}

// Execution record advanced + committed output → tier B evaluated-with-output.
{
    const cell = { executionSummary: { timing: { startTime: 10, endTime: 20 }, success: true } };
    const ev = classifyEvidence({
        dispatched: true, timedOut: false, cancelled: false,
        before: { endTime: 0 }, cell, provenance: null,
        committed: { ...emptyCommitted, outputs: ['4'], plain: '4' },
    });
    assert.strictEqual(ev.state, 'evaluated-with-output');
    assert.strictEqual(ev.tier, 'B');
}

// Execution record advanced, no outputs (definition cell) → evaluated-no-output,
// still tier B — this is the honest replacement for "definition or suppressed".
{
    const cell = { executionSummary: { timing: { startTime: 10, endTime: 20 }, success: true } };
    const ev = classifyEvidence({
        dispatched: true, timedOut: false, cancelled: false,
        before: { endTime: 0 }, cell, provenance: null, committed: emptyCommitted,
    });
    assert.strictEqual(ev.state, 'evaluated-no-output');
    assert.strictEqual(ev.tier, 'B');
}

// Provenance beats the summary: tier A wins with per-cell status.
{
    const cell = { executionSummary: { timing: { startTime: 10, endTime: 20 } } };
    const ev = classifyEvidence({
        dispatched: true, timedOut: false, cancelled: false,
        before: { endTime: 0 }, cell,
        provenance: { status: 'success-with-output', outputCount: 1 },
        committed: emptyCommitted,
    });
    assert.strictEqual(ev.state, 'evaluated-with-output');
    assert.strictEqual(ev.tier, 'A');
}

// Provenance failure classifies as failed even with committed outputs.
{
    const cell = { executionSummary: { timing: { endTime: 20 } } };
    const ev = classifyEvidence({
        dispatched: true, timedOut: false, cancelled: false,
        before: { endTime: 0 }, cell,
        provenance: { status: 'failed', outputCount: 0 },
        committed: { ...emptyCommitted, outputs: ['$Failed'] , failed: true },
    });
    assert.strictEqual(ev.state, 'failed');
    assert.strictEqual(ev.tier, 'A');
}

// Deadline hit with no evidence → timeout, not success.
{
    const ev = classifyEvidence({
        dispatched: true, timedOut: true, cancelled: false,
        before: { endTime: 0 }, cell: { executionSummary: undefined },
        provenance: null, committed: emptyCommitted,
    });
    assert.strictEqual(ev.state, 'timeout');
}

// ── runCellViaPipeline with a fake controller ───────────────────────────────

function makeFakes({ executeImpl }) {
    const cell = {
        index: 0,
        kind: 2,
        executionSummary: undefined,
        document: { uri: { toString: () => 'cell://0' }, getText: () => 'testA = 2 + 2' },
        outputs: [],
        notebook: null,
    };
    const notebook = {
        uri: { fsPath: '/tmp/fake.wb', toString: () => 'file:///tmp/fake.wb' },
        cellCount: 1,
        cellAt: () => cell,
    };
    cell.notebook = notebook;
    const ctrl = {
        kernelStatusString: 'resolved',
        _evalDispatched: false,
        executionQueue: { queueLength: () => 0 },
        execute: executeImpl,
        operations: { cellState: () => null },
    };
    return { ctrl, editor: { notebook }, cell, notebook };
}

(async () => {
    // execute() reports the cell skipped (not-associated) → the pipeline must
    // return dispatched:false / not-dispatched, in well under the timeout.
    {
        const { ctrl, editor } = makeFakes({
            executeImpl: async () => ({ dispatched: [], skipped: [{ index: 0, reason: 'not-associated' }] }),
        });
        const t0 = Date.now();
        const res = await withVscodeStubAsync(() => runCellViaPipeline(ctrl, editor, 0, { timeoutMs: 5000 }));
        assert.strictEqual(res.dispatched, false);
        assert.strictEqual(res.state, 'not-dispatched');
        assert.ok(Date.now() - t0 < 2000, 'skip must return promptly');
    }

    // execute() dispatches and the execution record advances → tier B success.
    {
        const fakes = makeFakes({
            executeImpl: async () => {
                setTimeout(() => {
                    fakes.cell.executionSummary = { timing: { startTime: Date.now() - 5, endTime: Date.now() }, success: true };
                }, 30);
                return { dispatched: [{ index: 0 }], skipped: [] };
            },
        });
        const res = await withVscodeStubAsync(() => runCellViaPipeline(fakes.ctrl, fakes.editor, 0, { timeoutMs: 5000 }));
        assert.strictEqual(res.dispatched, true);
        assert.strictEqual(res.state, 'evaluated-no-output');
        assert.strictEqual(res.evidence.tier, 'B');
    }

    // execute() dispatches but nothing ever runs → timeout at the deadline,
    // never an evaluated state.
    {
        const { ctrl, editor } = makeFakes({
            executeImpl: async () => ({ dispatched: [{ index: 0 }], skipped: [] }),
        });
        const res = await withVscodeStubAsync(() => runCellViaPipeline(ctrl, editor, 0, { timeoutMs: 400 }));
        assert.strictEqual(res.dispatched, true);
        assert.ok(['timeout', 'dispatched-unconfirmed'].includes(res.state),
            `expected timeout/unconfirmed, got ${res.state}`);
        assert.notStrictEqual(res.state, 'evaluated-no-output');
    }

    console.log('cell-evidence: all assertions passed');
})().catch(err => { console.error(err); process.exit(1); });

// The pipeline requires 'vscode' lazily inside waitForCompletion — keep the
// stub installed across the async span of each pipeline call.
function withVscodeStubAsync(fn) {
    const Module = require('module');
    const { makeVscodeStub } = require('./_stub-vscode');
    const stub = makeVscodeStub();
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return stub;
        return originalLoad.apply(this, arguments);
    };
    return Promise.resolve().then(fn).finally(() => { Module._load = originalLoad; });
}
