'use strict';

// Stability: several kernels in one window, one shared renderer channel.
//
// This window always holds more than one WolframNotebookKernel once a second
// window is open (a remote proxy per foreign kernel) or an isolated kernel is
// started. createRendererMessaging() is per RENDERER, so every message reaches
// every kernel. Each case below was a user-visible bug:
//
//   * "Cannot expand: output info not found." — one toast per NON-owning kernel
//     for a click the owner handled fine;
//   * doc lookup / go-to-source ran once per kernel;
//   * a non-owner's "No dialog open" raced the owner's real Dialog[] result;
//   * nb-default-format was broadcast, so every visible notebook took the LAST
//     visible notebook's saved default format;
//   * an in-memory notebook getting its first tab made every never-started
//     kernel auto-launch (a stray WolframKernel, or an HTTP call into a dead
//     window: "Auto-launch failed: Remote kernel owner is unavailable").

const assert = require('assert');
const h = require('./_stub-controller').makeControllerHarness();

(async () => {
    const A = h.notebook('/tmp/stab/a.wb');
    const B = h.notebook('/tmp/stab/b.wb');
    const edA = h.editor(A), edB = h.editor(B);

    // K1 owns A (default kernel id, like extension.js); K2 owns B; P is a
    // remote proxy owning nothing here.
    const K1 = h.kernel({ id: 'wolfram-notebook-kernel', owns: nb => nb === A });
    const K2 = h.kernel({ owns: nb => nb === B });
    const P  = h.kernel({ owns: () => false });
    P.session = { isRemote: true, isDialogOpen: false };
    P.launchKernel = async () => { P.launches++; throw new Error('Remote kernel owner is unavailable: connect ECONNREFUSED'); };
    for (const k of [K1, K2, P]) k.kernelStatusString = 'resolved';

    // --- 1. Unknown output id: the owner alone may complain. -----------------
    h.reset();
    await h.rendererMessage({ type: 'expand-truncated-output', uuid: 'nope' }, edA);
    assert.strictEqual(h.calls.warn.length, 1, `exactly one "not found" toast, got ${h.calls.warn.length}`);
    h.reset();
    await h.rendererMessage({ type: 'open-truncated-as-text', uuid: 'nope' }, edB);
    await h.rendererMessage({ type: 'open-output-as-text', outputId: 'nope' }, edB);
    assert.strictEqual(h.calls.warn.length, 2, `one toast per click, got ${h.calls.warn.length}`);

    // --- 2. Side-effecting UI actions run once. ------------------------------
    h.reset();
    await h.rendererMessage({ type: 'doc-lookup', symbol: 'Plot' }, edA);
    const lookups = h.calls.commands.filter(c => c.id === 'wolfbook.expandHoverDoc');
    assert.strictEqual(lookups.length, 1, `doc lookup must run once, ran ${lookups.length}×`);

    // Editor-less event (older VS Code): the default kernel answers, nobody else.
    h.reset();
    await h.rendererMessage({ type: 'doc-lookup', symbol: 'Sin' }, undefined);
    assert.strictEqual(h.calls.commands.filter(c => c.id === 'wolfbook.expandHoverDoc').length, 1,
        'editor-less doc lookup must run exactly once (default kernel)');

    // --- 3. Dialog: no spurious "No dialog open" from non-owners. ------------
    h.reset();
    await h.rendererMessage({ type: 'dialog-eval-request', expr: '1+1', requestId: 'r1' }, edA);
    const errs = h.calls.posts.filter(p => p.message.type === 'dialog-eval-error');
    assert.strictEqual(errs.length, 1, `one "No dialog open" reply, got ${errs.length}`);

    // Owner has a Dialog open: only its result may come back, no error at all.
    h.reset();
    K1.session = { isDialogOpen: true, dialogEval: async () => '2', exitDialog: async () => {} };
    await h.rendererMessage({ type: 'dialog-eval-request', expr: '1+1', requestId: 'r2' }, edA);
    const types = h.calls.posts.map(p => p.message.type);
    assert.deepStrictEqual(types.filter(t => t.startsWith('dialog-eval')), ['dialog-eval-result'],
        `owner's result must be the only reply, got ${JSON.stringify(types)}`);
    K1.session = undefined;

    // --- 4. nb-default-format reaches ITS notebook only. ---------------------
    h.reset();
    h.globalState.set('wolfbook.nbDefaultFmtGfx.' + A.uri.toString(), 'SVG');
    h.globalState.set('wolfbook.nbDefaultFmtGfx.' + B.uri.toString(), 'PNG');
    const K3 = h.kernel({ owns: () => false });   // fresh kernel: nothing restored yet
    K3.kernelStatusString = 'resolved';
    h.stub.window.visibleNotebookEditors.push(edA, edB);
    h.fire('window.onDidChangeVisibleNotebookEditors');
    await h.tick(20);
    const fmt = h.calls.posts.filter(p => p.message.type === 'nb-default-format');
    assert.ok(fmt.length >= 2, 'saved defaults are restored');
    for (const p of fmt) {
        assert.ok(p.editor, 'nb-default-format must be addressed to an editor, never broadcast');
        const want = p.editor === edA ? 'SVG' : 'PNG';
        assert.strictEqual(p.message.formatGfx, want, 'each notebook gets its OWN saved default');
    }
    K3.dispose();

    // --- 5. In-memory notebook → first tab: revealing tabs never launches a kernel. -------
    h.stub.window.visibleNotebookEditors.length = 0;
    const C = h.notebook('/tmp/stab/in-memory.wb');   // opened by an agent, no editor
    const K4 = h.kernel({ owns: nb => nb === C });      // bound, never started
    const K5 = h.kernel({ owns: () => false });         // isolated, never started, owns nothing
    P.kernelStatusString = 'unresolved';               // the zombie state dispose() used to leave
    h.fire('workspace.onDidOpenNotebookDocument', C);
    h.reset();
    h.stub.window.visibleNotebookEditors.push(h.editor(C));
    h.fire('window.onDidChangeVisibleNotebookEditors');
    await h.tick(900);   // allow any old auto-launch debounce to fire
    assert.strictEqual(K4.launches, 0, 'revealing the notebook leaves its kernel dormant');
    assert.strictEqual(K5.launches, 0, 'an unrelated never-started kernel must not launch');
    assert.strictEqual(P.launches, 0, 'a remote proxy must never auto-launch');
    assert.strictEqual(h.calls.error.length, 0, `no error toasts, got ${JSON.stringify(h.calls.error)}`);

    // Switching tabs repeatedly must not re-launch or toast.
    for (let i = 0; i < 5; i++) h.fire('window.onDidChangeVisibleNotebookEditors');
    await h.tick(900);
    assert.strictEqual(K4.launches, 0, 'tab switching must not launch'); assert.strictEqual(K5.launches + P.launches, 0, 'tab switching stays quiet');
    assert.strictEqual(h.calls.error.length, 0, 'still no error toasts after tab switching');

    // --- 6. Everything goes away with the kernels. ---------------------------
    for (const k of [K1, K2, P, K4, K5]) k.dispose();
    assert.strictEqual(h.liveCount(), 0, `listeners leaked: ${h.leaks().join(', ')}`);
    const undisposed = h.calls.resources.filter(r => !r.disposed).map(r => r.kind);
    assert.deepStrictEqual(undisposed, [], `per-kernel resources not released: ${undisposed.join(', ')}`);

    console.log('stability-renderer-channel: all assertions passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
