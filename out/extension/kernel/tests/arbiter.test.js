'use strict';

const assert = require('assert');
const { KernelArbiter } = require('../arbiter');

function ctrl(overrides = {}) {
    return {
        kernelStatusString: 'resolved', _evalDispatched: false,
        isAborting: false, _abortPending: false, _dynCells: new Map(),
        _silentExecution: false, executionQueue: { queueLength: () => 0 },
        abortAndWait: async function () { this._evalDispatched = false; },
        ...overrides,
    };
}

async function run() {
    const a = new KernelArbiter();
    const c = ctrl();
    const first = await a.acquire(c, { owner: 'mcp', kind: 'cell', caption: ' test\ncaption ' });
    assert(first.lease);
    assert.strictEqual(first.lease.caption, 'test caption');
    assert.strictEqual(a.status(c).lifecycle, 'busy');
    assert.strictEqual(a.status(c).linkHealth, 'connected');
    assert(a.status(c).safeDocumentReadTools.includes('wolfbook_kernelStatus'));
    const rejected = await a.acquire(c, { owner: 'other' });
    assert.strictEqual(rejected.busy.operation_id, first.lease.operationId);
    assert.strictEqual(a.release(first.lease, 'success'), true);
    assert.strictEqual(a.release(first.lease, 'success'), false);

    let sessionTouched = false;
    const pure = ctrl({ session: new Proxy({}, { get() { sessionTouched = true; return undefined; } }) });
    a.status(pure);
    assert.strictEqual(sessionTouched, false);

    const busyCtrl = ctrl({ _evalDispatched: true });
    let preempted = false;
    busyCtrl.abortAndWait = async () => { preempted = true; busyCtrl._evalDispatched = false; };
    const preempt = await a.acquire(busyCtrl, { owner: 'mcp', policy: 'preempt' });
    assert(preempt.lease && preempted);
    a.invalidate('restart', 'test');
    assert.strictEqual(a.status(busyCtrl).activeOperation, null);
    assert(a.journal().some(e => e.event === 'preempt-requested'));

    const ownedCtrl = ctrl();
    const victim = await a.acquire(ownedCtrl, { owner: 'first-agent', operationId: 'victim-op' });
    ownedCtrl._evalDispatched = true;
    const replacement = await a.acquire(ownedCtrl, { owner: 'second-agent', policy: 'preempt' });
    assert(replacement.lease, 'preempt must replace an arbiter-owned lease after physical abort acknowledgement');
    assert.notStrictEqual(replacement.lease.operationId, victim.lease.operationId);
    a.release(replacement.lease);

    const abortCtrl = ctrl();
    let abortOptions;
    abortCtrl.abortAndWait = async (_timeout, options) => {
        abortOptions = options;
        abortCtrl._evalDispatched = false;
    };
    const held = await a.acquire(abortCtrl, { owner: 'mcp', operationId: 'owned-op' });
    abortCtrl._evalDispatched = true;
    assert.strictEqual((await a.abort(abortCtrl, {
        operationId: 'wrong-op', requestedBy: 'test', reason: 'must not abort'
    })).reason, 'operation-mismatch');
    assert.strictEqual(abortCtrl._evalDispatched, true);
    const aborted = await a.abort(abortCtrl, {
        operationId: held.lease.operationId, requestedBy: 'user', reason: 'test abort'
    });
    assert.strictEqual(aborted.aborted, true);
    assert.strictEqual(abortOptions.notifyPriority, false);
    assert.strictEqual(a.status(abortCtrl).lastAbort.requestedBy, 'user');

    for (let i = 0; i < 150; i++) {
        const x = await a.acquire(c, { operationId: `ring-${i}` });
        a.release(x.lease);
    }
    assert(a.journal().length <= 100);
    console.log('arbiter tests: OK');
}

run().catch(err => { console.error(err); process.exit(1); });
