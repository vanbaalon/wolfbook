'use strict';

// A disposed kernel must leave nothing behind.
//
// This window creates a remote-proxy WolframNotebookKernel for every OTHER
// window's kernel and evicts it when that owner goes away. The constructor
// registered ~10 window/workspace listeners and dispose() released none, so each
// evicted proxy lived on as a zombie. dispose() had set it "unresolved", and its
// visible-editors listener auto-launched on every tab switch — an HTTP call into
// the dead owner: "Auto-launch failed: Remote kernel owner is unavailable".
//
// Pinned here against the REAL controller, not a mirror of its predicates:
//   1. every listener the constructor subscribes is released by dispose();
//   2. a disposed kernel never auto-launches;
//   3. a live kernel stays dormant even for a notebook it OWNS — an unrelated
//      tab appearing (e.g. an in-memory notebook getting its first editor) must
//      not start a never-used isolated kernel or call into a remote owner.

const assert = require('assert');
const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');

// Every vscode event subscription is counted live and can be fired by name.
const live = new Map();   // event name -> Set<listener>
const subscribe = name => fn => {
    if (!live.has(name)) live.set(name, new Set());
    live.get(name).add(fn);
    return { dispose: () => live.get(name).delete(fn) };
};
const fire = (name, v) => { for (const fn of [...(live.get(name) || [])]) fn(v); };
const liveCount = () => [...live.values()].reduce((n, s) => n + s.size, 0);

// Anything the controller touches that this test does not care about.
const inert = () => new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : (typeof k === 'string' && k.startsWith('onDid')) ? subscribe(k) : inert()),
    apply: () => inert(),
});

const stub = makeVscodeStub();
for (const ns of ['window', 'workspace', 'notebooks', 'languages', 'commands', 'env']) {
    const base = stub[ns] || {};
    stub[ns] = new Proxy(base, {
        get: (t, k) => {
            if (typeof k === 'string' && k.startsWith('onDid')) return subscribe(`${ns}.${k}`);
            if (k in t) return t[k];
            return inert();
        },
    });
}
stub.notebooks = new Proxy({}, {
    get: (_t, k) => {
        if (k === 'createNotebookController') return () => ({
            id: 'stub', label: 'stub', dispose: () => {}, updateNotebookAffinity: () => {},
            onDidChangeSelectedNotebooks: subscribe('controller.onDidChangeSelectedNotebooks'),
        });
        if (k === 'createRendererMessaging') return () => ({
            postMessage: () => true, onDidReceiveMessage: subscribe('renderer.onDidReceiveMessage'),
        });
        return inert();
    },
});
stub.StatusBarAlignment = { Left: 1, Right: 2 };
stub.ThemeColor = class { constructor(id) { this.id = id; } };
stub.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
stub.OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };

// Unknown top-level namespaces (extensions, debug, …) are inert too.
const vscodeStub = new Proxy(stub, { get: (t, k) => (k in t ? t[k] : inert()) });
const { WolframNotebookKernel } = withVscodeStub(() => require('../../controller'), vscodeStub);

const ctx = {
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [], extensionPath: '/tmp',
};
const wolframEditor = { notebook: { notebookType: 'extended-wolfram-notebook', uri: { toString: () => 'file:///tmp/other.wb', fsPath: '/tmp/other.wb' }, cellCount: 0 } };

(async () => {
    const baseline = liveCount();

    // --- A remote-proxy-shaped kernel: owns nothing, launch goes over HTTP. ---
    const proxy = new WolframNotebookKernel(ctx, {
        controllerId: 'wolfram-remote-x', autoQuitWhenUnselected: false, autoSelectActive: false,
        claimNotebook: () => false,
    });
    const registered = liveCount() - baseline;
    assert.ok(registered >= 8, `the constructor should subscribe its listeners (saw ${registered})`);

    let launches = 0;
    proxy.session = { isRemote: true };
    proxy.launchKernel = async () => { launches++; throw new Error('Remote kernel owner is unavailable: connect ECONNREFUSED'); };
    proxy.quitKernel = () => { proxy.kernelStatusString = 'unresolved'; };
    proxy.kernelStatusString = 'resolved';

    proxy.dispose();
    for (const [n, set] of live) if (set.size) console.error("LEAK:", n, set.size);
    assert.strictEqual(liveCount(), baseline, `dispose() must release every listener (${liveCount() - baseline} leaked)`);

    // Tab switch after eviction: the zombie path.
    stub.window.visibleNotebookEditors.push(wolframEditor);
    fire('window.onDidChangeVisibleNotebookEditors');
    await new Promise(r => setTimeout(r, 900));
    assert.strictEqual(launches, 0, 'an evicted proxy must never auto-launch');

    // --- A live, never-started isolated kernel bound to nothing visible. ---
    let isoLaunches = 0;
    const iso = new WolframNotebookKernel(ctx, {
        controllerId: 'wolfram-iso', autoQuitWhenUnselected: false, autoSelectActive: false,
        claimNotebook: () => false,
    });
    iso.launchKernel = async () => { isoLaunches++; };
    fire('window.onDidChangeVisibleNotebookEditors');
    await new Promise(r => setTimeout(r, 900));
    assert.strictEqual(isoLaunches, 0, 'a kernel must not auto-launch for a notebook it does not own');

    // --- The same kernel, now owning the visible notebook: it SHOULD launch. ---
    let owned = false;
    const k1 = new WolframNotebookKernel(ctx, {
        controllerId: 'wolfram-k1', autoQuitWhenUnselected: false, autoSelectActive: false,
        claimNotebook: () => owned,
    });
    let k1Launches = 0;
    k1.launchKernel = async () => { k1Launches++; };
    owned = true;
    fire('window.onDidChangeVisibleNotebookEditors');
    await new Promise(r => setTimeout(r, 900));
    assert.strictEqual(k1Launches, 0, 'visibility must not start even the owning kernel');

    iso.dispose(); k1.dispose();
    assert.strictEqual(liveCount(), baseline, 'all kernels disposed → no listeners left');
    console.log('controller-dispose: all assertions passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
