'use strict';

// Stability under churn: a long session, compressed.
//
// Every time another window starts, restarts or closes a kernel, this window
// attaches a new remote proxy and later evicts it. The original leak grew with
// session length — one zombie listener set, output channel and decoration trio
// per dead generation, and one extra "Auto-launch failed" toast per tab switch
// per zombie. This drives 50 generations with tab switches in between and
// requires that NOTHING accumulates.

const assert = require('assert');
const h = require('./_stub-controller').makeControllerHarness();

(async () => {
    const A = h.notebook('/tmp/churn/a.wb');
    const edA = h.editor(A);
    const K1 = h.kernel({ id: 'wolfram-notebook-kernel', owns: nb => nb === A });
    K1.kernelStatusString = 'resolved';
    h.stub.window.visibleNotebookEditors.push(edA);

    const baseListeners = h.liveCount();
    const baseResources = h.calls.resources.filter(r => !r.disposed).length;
    let proxyLaunches = 0;

    for (let gen = 0; gen < 50; gen++) {
        // Attach, exactly as extension.js _attachRemoteKernel shapes a proxy.
        const P = h.kernel({ id: `wolfram-remote-gen${gen}`, owns: () => false });
        P.session = { isRemote: true };
        P.kernelStatusString = 'resolved';
        P.launchKernel = async () => { proxyLaunches++; throw new Error('Remote kernel owner is unavailable'); };
        P.quitKernel = () => { P.kernelStatusString = 'unresolved'; };
        h.fire('window.onDidChangeVisibleNotebookEditors');      // tab switch while alive
        await h.rendererMessage({ type: 'expand-truncated-output', uuid: `u${gen}` }, edA);
        // Owner goes away → eviction → dispose.
        P.kernelStatusString = 'error';
        P.dispose();
        h.fire('window.onDidChangeVisibleNotebookEditors');      // tab switch after eviction
    }
    await h.tick(900);   // let every debounced auto-launch fire

    assert.strictEqual(proxyLaunches, 0, `evicted proxies launched ${proxyLaunches}×`);
    assert.strictEqual(h.calls.error.length, 0, `error toasts: ${h.calls.error.slice(0, 3).join(' | ')}`);
    // One "not found" per click (the owner's), never one per live kernel.
    assert.strictEqual(h.calls.warn.length, 50, `expected 50 owner warnings, got ${h.calls.warn.length}`);
    assert.strictEqual(h.liveCount(), baseListeners, `listeners grew: ${h.leaks().join(', ')}`);
    const liveRes = h.calls.resources.filter(r => !r.disposed).length;
    assert.strictEqual(liveRes, baseResources, `resources grew from ${baseResources} to ${liveRes}`);
    assert.strictEqual(K1.launches, 0, 'the live owner was never disturbed');

    K1.dispose();
    assert.strictEqual(h.liveCount(), 0, 'clean at the end');
    console.log('stability-churn: all assertions passed (50 proxy generations)');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
