// tex-external-rebuild.test.js — a change that arrives on DISK must rebuild.
//
//   node out/extension/kernel/tests/tex-external-rebuild.test.js
//
// Reported as: the Page view shows "page behind editor" and nothing ever takes
// it down; pressing Compile by hand is the only way forward.
//
// The flag and the work were driven by two different events. A keystroke fires
// onDidChangeTextDocument, which BOTH marks the paper behind and schedules the
// rebuild. A write that never passes through a VS Code buffer — an agent
// editing the .tex, a git checkout, a Dropbox sync, a shell heredoc — reaches
// the file-system watcher instead, and that path called coord.invalidate()
// (which raises the badge) and stopped there.
//
// So this drives the REAL registerTexSupport against a stub and asserts the
// wiring, not a policy helper. The bug was that nobody asked the question; a
// suite that only tested the answer would have stayed green through it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const EXT = path.resolve(__dirname, '..', '..', '..', '..');
const R = (p) => path.join(EXT, p);

// --- a workspace on disk, because rootFor really walks the project ---------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ext-rebuild-'));
const ROOT = path.join(DIR, 'paper.tex');
const CHILD = path.join(DIR, 'section.tex');
const OTHER = path.join(DIR, 'unrelated.tex');
fs.writeFileSync(ROOT, '\\documentclass{article}\n\\begin{document}\n\\input{section}\n\\end{document}\n');
fs.writeFileSync(CHILD, 'Hello.\n');
fs.writeFileSync(OTHER, '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');

// --- the stub -------------------------------------------------------------
const { makeVscodeStub } = require('./_stub-vscode.js');
const stub = makeVscodeStub();
const watchers = [];
const noDispose = { dispose() {} };
const evt = () => () => noDispose;

Object.assign(stub, {
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    Range: class { constructor(a, b) { this.start = a; this.end = b; } },
    Selection: class { constructor(a, b) { this.anchor = a; this.active = b; this.start = a; this.end = b; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v) { this.value = v || ''; } appendMarkdown(v) { this.value += v; return this; } },
    Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeLens: class { constructor(r, c) { this.range = r; this.command = c; } },
    Hover: class { constructor(c) { this.contents = c; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    FoldingRange: class { constructor(s2, e2) { this.start = s2; this.end = e2; } },
    DocumentLink: class { constructor(r, t) { this.range = r; this.target = t; } },
    Location: class { constructor(u, r) { this.uri = u; this.range = r; } },
    CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }; } cancel() {} dispose() {} },
    RelativePattern: class { constructor(base, pat) { this.base = base; this.pattern = pat; } },
    TextEdit: { replace: (r, t) => ({ range: r, newText: t }), insert: (p, t) => ({ position: p, newText: t }) },
    WorkspaceEdit: class { replace() {} insert() {} delete() {} },
    DocumentSymbol: class {},
    SymbolKind: {},
    CompletionItem: class { constructor(l) { this.label = l; } },
    CompletionItemKind: {},
    SnippetString: class { constructor(v) { this.value = v; } },
    ProgressLocation: { Notification: 15, Window: 10 },
    extensions: { getExtension: () => undefined, all: [] },
    env: { clipboard: { readText: async () => '', writeText: async () => {} }, openExternal: async () => true },
    commands: { registerCommand: () => noDispose, executeCommand: async () => undefined, getCommands: async () => [] },
    languages: {
        registerCodeLensProvider: () => noDispose,
        registerHoverProvider: () => noDispose,
        registerDocumentSymbolProvider: () => noDispose,
        registerCompletionItemProvider: () => noDispose,
        registerDefinitionProvider: () => noDispose,
        registerDocumentLinkProvider: () => noDispose,
        registerFoldingRangeProvider: () => noDispose,
        registerDocumentFormattingEditProvider: () => noDispose,
        createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }),
    },
});
Object.assign(stub.window, {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    registerWebviewViewProvider: () => noDispose,
    registerWebviewPanelSerializer: () => noDispose,
    registerCustomEditorProvider: () => noDispose,
    createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: evt(), postMessage: async () => true, asWebviewUri: (u) => u, cspSource: '' }, onDidDispose: evt(), onDidChangeViewState: evt(), reveal() {}, dispose() {} }),
    withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
    showTextDocument: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showSaveDialog: async () => undefined,
    onDidChangeActiveTextEditor: evt(),
    onDidChangeVisibleTextEditors: evt(),
    onDidChangeTextEditorSelection: evt(),
    onDidChangeTextEditorVisibleRanges: evt(),
    onDidChangeWindowState: evt(),
    tabGroups: { all: [], activeTabGroup: undefined, onDidChangeTabs: evt(), onDidChangeTabGroups: evt() },
});
Object.assign(stub.workspace, {
    textDocuments: [],
    workspaceFolders: [{ uri: { fsPath: DIR }, name: 'w', index: 0 }],
    getConfiguration: () => ({ get: (_k, d) => d, update: async () => {}, has: () => false, inspect: () => undefined }),
    onDidChangeTextDocument: evt(),
    onDidSaveTextDocument: evt(),
    onDidOpenTextDocument: evt(),
    onDidCloseTextDocument: evt(),
    onDidChangeConfiguration: evt(),
    onWillSaveTextDocument: evt(),
    onDidRenameFiles: evt(),
    applyEdit: async () => true,
    openTextDocument: async () => ({ uri: { fsPath: ROOT }, getText: () => '', isDirty: false }),
    asRelativePath: (p) => p,
    fs: { readFile: async () => Buffer.from(''), writeFile: async () => {}, stat: async () => ({}) },
    createFileSystemWatcher: (pattern) => {
        const w = { pattern, _change: [], _create: [], _delete: [],
            onDidChange: (fn) => { w._change.push(fn); return noDispose; },
            onDidCreate: (fn) => { w._create.push(fn); return noDispose; },
            onDidDelete: (fn) => { w._delete.push(fn); return noDispose; },
            dispose() {} };
        watchers.push(w);
        return w;
    },
});

// Registration surfaces are a long tail and none of them is what this suite
// measures: any `register*`/`on*` we have not named answers with a disposable,
// so the stub stays about the watcher rather than about the API list.
const fillRegistrars = (obj) => new Proxy(obj, {
    get(t, k) {
        if (k in t) return t[k];
        if (typeof k === 'string' && /^(register|on[A-Z]|create)/.test(k)) return () => noDispose;
        return undefined;
    },
});
stub.languages = fillRegistrars(stub.languages);
stub.window = fillRegistrars(stub.window);
stub.workspace = fillRegistrars(stub.workspace);

// --- load the real modules against it --------------------------------------
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? stub : origLoad.call(this, req, ...rest); };
const renderUi = require(R('out/extension/tex/renderUi.js'));
const { TexViewer } = require(R('out/extension/tex/texViewer.js'));
const tex = require(R('out/extension/tex/index.js'));
Module._load = origLoad;

// The two things the wiring consults, and the one thing it must call.
const scheduled = [];
const guarded = [];
renderUi.RenderCoordinator.prototype.scheduleLive = function (doc) {
    scheduled.push(doc && doc.uri && doc.uri.fsPath);
};
let viewerOpen = true;
let viewerRoot = ROOT;
TexViewer.prototype.isOpen = () => viewerOpen;
TexViewer.prototype.preserveViewerLayoutAfterExternalChange = function () {
    guarded.push(viewerRoot);
    return true;
};
Object.defineProperty(TexViewer.prototype, 'root', {
    configurable: true, get: () => viewerRoot, set: () => {},
});

tex.registerTexSupport({ subscriptions: [], extensionUri: { fsPath: EXT }, globalState: { get: () => undefined, update: async () => {} }, workspaceState: { get: () => undefined, update: async () => {} }, secrets: { get: async () => undefined, store: async () => {} } }, {});

const texWatcher = watchers.find(w => String(w.pattern).includes('tex'));
const fire = async (fsPath) => {
    scheduled.length = 0;
    guarded.length = 0;
    for (const fn of texWatcher._change) await fn({ fsPath, scheme: 'file', path: fsPath });
    await new Promise(r => setTimeout(r, 10));
};

// --- the cases -------------------------------------------------------------

test('the watcher for .tex/.bib is actually registered', () => {
    assert.ok(texWatcher, `no .tex watcher among ${watchers.map(w => w.pattern).join(', ') || 'none'}`);
});

test('a write that never passed through a buffer SCHEDULES THE REBUILD', async () => {
    fs.writeFileSync(ROOT, fs.readFileSync(ROOT, 'utf8') + '\n% an agent wrote this\n');
    await fire(ROOT);
    assert.deepStrictEqual(scheduled, [ROOT],
        'the badge went up and nothing was queued to take it down');
    assert.deepStrictEqual(guarded, [ROOT],
        'and an external reload cannot expose the editor over viewer-only mode');
});

test('...and so does a write to an \\input-ed file of the same paper', async () => {
    fs.writeFileSync(CHILD, 'Hello again.\n');
    await fire(CHILD);
    assert.deepStrictEqual(scheduled, [CHILD]);
    assert.deepStrictEqual(guarded, [ROOT]);
});

test('a paper the Page view is NOT showing is left alone', async () => {
    fs.writeFileSync(OTHER, '\\documentclass{article}\\begin{document}y\\end{document}\n');
    await fire(OTHER);
    assert.deepStrictEqual(scheduled, [],
        'a branch switch touching fifty files must not start fifty compiles');
    assert.deepStrictEqual(guarded, [], 'nor does it disturb the current reading layout');
});

test('with the Page view closed nothing is built', async () => {
    viewerOpen = false;
    fs.writeFileSync(ROOT, fs.readFileSync(ROOT, 'utf8') + '% more\n');
    await fire(ROOT);
    assert.deepStrictEqual(scheduled, []);
    assert.deepStrictEqual(guarded, []);
    viewerOpen = true;
});

test('a DELETED source does not queue a compile of a file that is gone', async () => {
    const gone = path.join(DIR, 'gone.tex');
    fs.writeFileSync(gone, 'x\n');
    fs.unlinkSync(gone);
    await fire(gone);
    assert.deepStrictEqual(scheduled, []);
});

test('the rebuild is SCHEDULED, not run on the spot', async () => {
    // scheduleLive is debounced per root and arms the authoritative pass
    // behind itself; calling build() directly here would compile a 139-page
    // paper on every keystroke a sync happens to land between.
    const src = fs.readFileSync(R('out/extension/tex/index.js'), 'utf8');
    const fn = src.slice(src.indexOf('const rebuildAfterExternal'),
                         src.indexOf('const watcher = vscode.workspace.createFileSystemWatcher'));
    assert.ok(/coord\.scheduleLive\(/.test(fn), 'it must go through the debounced path');
    assert.ok(!/coord\.build\(/.test(fn), 'and must not compile inline');
});

(async () => {
    console.log('an external change rebuilds the paper on screen\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log('  ok   ' + name); }
        catch (e) {
            fail++;
            console.log('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 3).join('\n         '));
        }
    }
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* fine */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
