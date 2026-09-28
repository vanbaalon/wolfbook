'use strict';

// Kernel-state paint must reach only the notebooks that kernel actually drives.
//
// vscode.notebooks.createRendererMessaging() is a channel per RENDERER, not per
// controller, and every WolframNotebookKernel subscribes to it and posts on it.
// So a bare postMessage() reaches EVERY renderer in the window, and a
// 'renderer-ready' from one notebook is delivered to EVERY controller.
//
// A window holds more than one controller as a matter of course: extension.js
// attaches a remote proxy for every OTHER window's kernel, on a 1.5 s
// reconciler. Two live symptoms followed:
//
//   1. Switching windows turned a live notebook gray and deleted all its
//      Out[N]= headers. Switching reloads the output webview, which re-sends
//      'renderer-ready'; every controller answered, and the last answer won.
//      A proxy that was momentarily not 'resolved' painted kernel-offline over
//      a perfectly live notebook, and — because each controller carries its own
//      RANDOM _sessionEpoch — its 'session-changed' made every header the real
//      kernel had just stamped look stale, so the renderer removed them.
//   2. An agent inserting and running a cell produced output that showed up
//      under a gray "dead kernel" body. Same mechanism: a fresh output brings up
//      the webview, which says 'renderer-ready', which starts the same race.
//
// These pin the routing law for kernel state: a controller answers a
// renderer-ready only for a notebook it owns, and it answers that editor alone.

const assert = require('assert');
const path = require('path');
const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');

const noop = () => ({ dispose() {} });

// A vscode stub rich enough to construct the real WolframNotebookKernel. The
// point is to exercise the shipped constructor and its shipped message handler,
// not a re-implementation of them.
function buildStub(posted, rendererHandlers) {
    const stub = makeVscodeStub({
        extensions: { getExtension: () => ({ extensionPath: '/x', extensionUri: { fsPath: '/x' }, packageJSON: { version: '0.0.0-test' } }), all: [] },
        languages: {
            createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }),
            registerCompletionItemProvider: noop, registerHoverProvider: noop,
            registerDocumentFormattingEditProvider: noop,
        },
        notebooks: {
            // One shared channel for the whole window — exactly as VS Code does it.
            createRendererMessaging: () => ({
                postMessage: async (message, editor) => { posted.push({ message, editor }); return true; },
                onDidReceiveMessage: (fn) => { rendererHandlers.push(fn); return { dispose() {} }; },
            }),
            registerNotebookCellStatusBarItemProvider: noop,
            createNotebookController: () => ({
                supportedLanguages: [], supportsExecutionOrder: true, dispose() {},
                createNotebookCellExecution: () => ({}), updateNotebookAffinity() {},
                onDidChangeSelectedNotebooks: noop,
            }),
        },
        debug: { registerDebugAdapterDescriptorFactory: noop, onDidStartDebugSession: noop, onDidTerminateDebugSession: noop },
        commands: { registerCommand: noop, executeCommand: async () => {} },
    });
    Object.assign(stub, {
        StatusBarAlignment: { Left: 1, Right: 2 },
        OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
        DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1 },
        TextEditorRevealType: { Default: 0, InCenter: 1 },
        ProgressLocation: { Notification: 15, Window: 10 },
        NotebookEdit: { replaceCells: () => ({}), updateCellMetadata: () => ({}) },
        WorkspaceEdit: class { set() {} },
        NotebookCellData: class { constructor(k, v, l) { this.kind = k; this.value = v; this.languageId = l; } },
        NotebookCellOutput: class { constructor(items) { this.items = items; } },
        NotebookCellOutputItem: { text: (v, m) => ({ data: v, mime: m }), error: e => ({ error: e }) },
        ThemeColor: class { constructor(id) { this.id = id; } },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        Position: class { constructor(l, c) { this.line = l; this.character = c; } },
        Range: class { constructor(a, b) { this.start = a; this.end = b; } },
        MarkdownString: class { constructor(v) { this.value = v; } appendMarkdown(v) { this.value = (this.value || '') + v; return this; } },
        Disposable: class { constructor(fn) { this._fn = fn; } dispose() { this._fn && this._fn(); } },
    });
    Object.assign(stub.window, {
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
        createTextEditorDecorationType: () => ({ dispose() {} }),
    });
    // Event subscriptions the constructor makes that this test does not drive.
    const lenient = obj => new Proxy(obj, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'string' && /^on(Did|Will)/.test(k)) return noop;
            return undefined;
        },
    });
    stub.window = lenient(stub.window);
    stub.workspace = lenient(stub.workspace);
    return stub;
}

function makeEditor(fsPath) {
    const notebook = {
        uri: { fsPath, scheme: 'file', path: fsPath, toString: () => `file://${fsPath}` },
        notebookType: 'extended-wolfram-notebook',
        getCells: () => [],
    };
    return { notebook };
}

const posted = [];
const rendererHandlers = [];
const stub = buildStub(posted, rendererHandlers);
const controllerPath = path.join(__dirname, '..', '..', 'controller.js');
const { WolframNotebookKernel } = withVscodeStub(() => require(controllerPath), stub);

function makeContext() {
    return {
        subscriptions: [],
        globalState: { get: () => undefined, update: async () => {} },
        workspaceState: { get: () => undefined, update: async () => {} },
        extensionPath: '/x', extensionUri: { fsPath: '/x' },
    };
}

// Two notebooks, two kernels: `mine.wb` is driven by the local kernel, and
// `theirs.wb` by a second kernel standing in for another window's, the way a
// remote proxy does.
const mine = makeEditor('/tmp/mine.wb');
const theirs = makeEditor('/tmp/theirs.wb');
stub.window.visibleNotebookEditors = [mine, theirs];

const local = new WolframNotebookKernel(makeContext(), {
    controllerId: 'local', controllerLabel: 'Wolfram K1',
    claimNotebook: nb => nb === mine.notebook,
});
const proxy = new WolframNotebookKernel(makeContext(), {
    controllerId: 'proxy', controllerLabel: 'Wolfram K2',
    claimNotebook: nb => nb === theirs.notebook,
});

// Both kernels subscribed to the one shared channel — the precondition for the bug.
assert.ok(rendererHandlers.length >= 2,
    'both controllers must be on the shared renderer channel (else this test proves nothing)');

const deliverRendererReady = (editor) => {
    posted.length = 0;
    for (const fn of rendererHandlers) {
        // VS Code delivers to EVERY subscriber, not just the notebook's owner.
        try { fn({ message: { type: 'renderer-ready' }, editor }); } catch (_) {}
    }
};

(async () => {
    // ---- The window-switch case -------------------------------------------
    // The live local kernel; the proxy is mid-reconcile and not resolved, which
    // is precisely when it used to paint its offline state over everything.
    local.kernelStatusString = 'resolved';
    proxy.kernelStatusString = 'error';

    deliverRendererReady(mine);
    await new Promise(r => setImmediate(r));

    const forMine = posted.filter(p => p.editor === mine);
    const leaked = posted.filter(p => p.editor !== mine);

    assert.strictEqual(leaked.length, 0,
        'a renderer-ready from mine.wb must produce no message aimed elsewhere or broadcast; got ' +
        JSON.stringify(leaked.map(p => p.message)));
    assert.ok(forMine.some(p => p.message.type === 'kernel-online'),
        'the kernel that owns mine.wb must answer it');
    assert.ok(!posted.some(p => p.message.type === 'kernel-offline'),
        'the unresolved proxy must not paint mine.wb offline — this was the gray-on-window-switch bug');

    // Exactly one epoch reaches this notebook, and it is its own kernel's, so the
    // headers that kernel stamped survive instead of being culled as stale.
    const epochs = posted.filter(p => p.message.type === 'session-changed').map(p => p.message.epoch);
    assert.strictEqual(epochs.length, 1, 'exactly one session-changed per renderer-ready, got ' + epochs.length);
    assert.strictEqual(epochs[0], local._sessionEpoch, 'the epoch must be the owning kernel\'s');
    assert.notStrictEqual(local._sessionEpoch, proxy._sessionEpoch,
        'kernels carry independent random epochs — that is why a stray broadcast wiped headers');

    // ---- The agent case ----------------------------------------------------
    // A freshly inserted output brings the webview up and it says renderer-ready.
    // The local kernel is alive, so nothing may paint it dead.
    deliverRendererReady(mine);
    await new Promise(r => setImmediate(r));
    assert.ok(!posted.some(p => p.message.type === 'kernel-offline'),
        'a live kernel\'s notebook must never be painted offline after an insert+evaluate');

    // ---- The other notebook still gets its own state -----------------------
    deliverRendererReady(theirs);
    await new Promise(r => setImmediate(r));
    assert.ok(posted.every(p => p.editor === theirs), 'theirs.wb\'s renderer-ready must stay on theirs.wb');
    assert.ok(posted.some(p => p.message.type === 'kernel-offline'),
        'the notebook whose own kernel is faulted SHOULD be painted offline');
    assert.ok(posted.some(p => p.message.type === 'session-changed' && p.message.epoch === proxy._sessionEpoch),
        'and it gets its own kernel\'s epoch');

    // ---- Ownership is the filter, not visibility ---------------------------
    // A kernel driving nothing on screen paints nothing at all.
    assert.strictEqual(local._ownedVisibleEditors().length, 1);
    stub.window.visibleNotebookEditors = [theirs];
    assert.strictEqual(local._ownedVisibleEditors().length, 0,
        'with its notebook hidden the local kernel owns no visible editor');
    posted.length = 0;
    assert.strictEqual(local._postToOwnedRenderers({ type: 'kernel-offline' }), 0);
    assert.strictEqual(posted.length, 0, 'a kernel with nothing on screen must not post to the window');
    stub.window.visibleNotebookEditors = [mine, theirs];

    // ---- The same law on the lifecycle paint path --------------------------
    // applyKernelOfflineUI/clearKernelOfflineUI are called from the launch and
    // quit paths, not from renderer-ready, and must obey the same filter.
    const lifecycle = withVscodeStub(() => require(path.join(__dirname, '..', 'lifecycle.js')), stub);
    posted.length = 0;
    lifecycle.applyKernelOfflineUI(local);
    assert.ok(posted.length > 0 && posted.every(p => p.editor === mine && p.message.type === 'kernel-offline'),
        'applyKernelOfflineUI must reach the kernel\'s own notebook only');
    posted.length = 0;
    lifecycle.clearKernelOfflineUI(local);
    assert.ok(posted.length > 0 && posted.every(p => p.editor === mine && p.message.type === 'kernel-online'),
        'clearKernelOfflineUI must reach the kernel\'s own notebook only');

    console.log('kernel-state-routing: ok');
})().catch(err => { console.error(err); process.exit(1); });
