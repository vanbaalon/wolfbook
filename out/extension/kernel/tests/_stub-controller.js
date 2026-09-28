'use strict';

// Harness for tests that need REAL WolframNotebookKernel instances.
//
// Everything the constructor touches is stubbed, and three things are modelled
// faithfully because the stability bugs lived in them:
//
//   * every vscode event subscription is live, countable, and fireable by name;
//   * createRendererMessaging() returns objects that all feed ONE channel — as in
//     VS Code, where the channel is per renderer, not per kernel — so a message
//     fired once reaches every kernel in the window;
//   * every toast, command, renderer post and created resource is recorded.
//
// Usage (one harness per process — the controller module is loaded once):
//   const h = require('./_stub-controller').makeControllerHarness();
//   const k = h.kernel({ owns: nb => nb.uri.fsPath === '/tmp/a.wb' });

const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');

function makeControllerHarness() {
    const live = new Map();   // event name -> Set<listener>
    const subscribe = name => fn => {
        if (!live.has(name)) live.set(name, new Set());
        live.get(name).add(fn);
        return { dispose: () => live.get(name).delete(fn) };
    };
    const fire = (name, v) => { for (const fn of [...(live.get(name) || [])]) fn(v); };
    const liveCount = () => [...live.values()].reduce((n, s) => n + s.size, 0);
    const leaks = () => [...live].filter(([, s]) => s.size).map(([n, s]) => `${n} ×${s.size}`);

    const calls = { error: [], warn: [], info: [], commands: [], posts: [], resources: [] };
    const resource = kind => {
        const r = { kind, disposed: false, dispose() { this.disposed = true; },
            appendLine() {}, append() {}, show() {}, hide() {}, clear() {}, set() {}, delete() {} };
        calls.resources.push(r);
        return r;
    };

    const inert = () => new Proxy(function () {}, {
        get: (_t, k) => (k === 'then' ? undefined
            : (typeof k === 'string' && k.startsWith('onDid')) ? subscribe(k) : inert()),
        apply: () => inert(),
    });

    const stub = makeVscodeStub();
    Object.assign(stub.window, {
        visibleNotebookEditors: [], visibleTextEditors: [],
        showErrorMessage: async (m) => { calls.error.push(m); },
        showWarningMessage: async (m) => { calls.warn.push(m); },
        showInformationMessage: async (m) => { calls.info.push(m); },
        createOutputChannel: () => resource('outputChannel'),
        createTextEditorDecorationType: () => resource('decoration'),
    });
    stub.commands = { executeCommand: async (id, ...args) => { calls.commands.push({ id, args }); } };
    stub.languages = { createDiagnosticCollection: () => resource('diagnostics') };
    for (const ns of ['window', 'workspace', 'languages', 'commands', 'env']) {
        const base = stub[ns] || {};
        stub[ns] = new Proxy(base, {
            get: (t, k) => {
                if (typeof k === 'string' && k.startsWith('onDid')) return subscribe(`${ns}.${k}`);
                if (k in t) return t[k];
                return inert();
            },
        });
    }
    stub.notebooks = {
        createNotebookController: (id, _type, label) => ({
            id, label, affinity: new Map(), disposed: false,
            dispose() { this.disposed = true; },
            updateNotebookAffinity(nb, a) { this.affinity.set(nb.uri.fsPath, a); },
            onDidChangeSelectedNotebooks: subscribe('controller.onDidChangeSelectedNotebooks'),
        }),
        // ONE channel for all kernels — the property the ownership gates exist for.
        createRendererMessaging: () => ({
            postMessage: (message, editor) => { calls.posts.push({ message, editor }); return Promise.resolve(true); },
            onDidReceiveMessage: subscribe('renderer.onDidReceiveMessage'),
        }),
    };
    stub.StatusBarAlignment = { Left: 1, Right: 2 };
    stub.ThemeColor = class { constructor(id) { this.id = id; } };
    stub.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
    stub.OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };
    stub.NotebookEditorRevealType = { Default: 0, InCenter: 1, AtTop: 3 };
    const vscode = new Proxy(stub, { get: (t, k) => (k in t ? t[k] : inert()) });

    const { WolframNotebookKernel } = withVscodeStub(() => require('../../controller'), vscode);

    const globalState = new Map();
    const ctx = {
        globalState: { get: (k, d) => (globalState.has(k) ? globalState.get(k) : d), update: async (k, v) => { globalState.set(k, v); } },
        workspaceState: { get: (_k, d) => d, update: async () => {} },
        subscriptions: [], extensionPath: '/tmp',
    };

    const notebook = (fsPath) => ({
        notebookType: 'extended-wolfram-notebook', cellCount: 0,
        uri: { fsPath, toString: () => `file://${fsPath}`, scheme: 'file' },
        cellAt: () => { throw new Error('no cells'); },
    });
    const editor = (nb) => ({ notebook: nb, revealRange() {}, selections: [], visibleRanges: [] });

    let n = 0;
    /** A real kernel. `owns(nb)` is its claimNotebook predicate. */
    const kernel = ({ owns = () => false, id } = {}) => {
        const k = new WolframNotebookKernel(ctx, {
            controllerId: id || `wolfram-test-${++n}`, autoQuitWhenUnselected: false, autoSelectActive: false,
            claimNotebook: owns,
        });
        k.launches = 0;
        k.launchKernel = async () => { k.launches++; k.kernelStatusString = 'resolved'; };
        return k;
    };

    const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
    /** Deliver one renderer message on the shared channel and let handlers settle. */
    const rendererMessage = async (message, ed) => {
        fire('renderer.onDidReceiveMessage', { message, editor: ed });
        await tick(20);
    };
    const reset = () => { for (const k of Object.keys(calls)) if (k !== 'resources') calls[k].length = 0; };

    return { vscode, stub, WolframNotebookKernel, ctx, globalState, calls, fire, liveCount, leaks,
        notebook, editor, kernel, rendererMessage, tick, reset };
}

module.exports = { makeControllerHarness };
