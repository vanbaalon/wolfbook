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

const EXT = process.env.WPAPER_EXT_ROOT || path.resolve(__dirname, '..', '..', '..', '..');
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
const willSaveHandlers = [];
const openHandlers = [];
const saveHandlers = [], changeHandlers = [];
const warnings = [];
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
    showWarningMessage: async (...args) => { warnings.push(args); },
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
    onDidChangeTextDocument: fn => { changeHandlers.push(fn); return noDispose; },
    onDidSaveTextDocument: fn => { saveHandlers.push(fn); return noDispose; },
    onDidOpenTextDocument: fn => { openHandlers.push(fn); return noDispose; },
    onDidCloseTextDocument: evt(),
    onDidChangeConfiguration: evt(),
    onWillSaveTextDocument: fn => { willSaveHandlers.push(fn); return noDispose; },
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
const liveScheduled = [];
const guarded = [];
const scheduleLive = renderUi.RenderCoordinator.prototype.scheduleLive;
const scheduleExternal = renderUi.RenderCoordinator.prototype.scheduleExternal;
renderUi.RenderCoordinator.prototype.scheduleExternal = function (doc) {
    scheduled.push(doc && doc.uri && doc.uri.fsPath);
};
renderUi.RenderCoordinator.prototype.scheduleLive = function (doc) {
    liveScheduled.push(doc && doc.uri && doc.uri.fsPath);
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

const registered = tex.registerTexSupport({ subscriptions: [], extensionUri: { fsPath: EXT }, globalState: { get: () => undefined, update: async () => {} }, workspaceState: { get: () => undefined, update: async () => {} }, secrets: { get: async () => undefined, store: async () => {} } }, {});

const texWatcher = watchers.find(w => String(w.pattern).includes('tex'));
const fire = async (fsPath) => {
    scheduled.length = 0;
    guarded.length = 0;
    for (const fn of texWatcher._change) await fn({ fsPath, scheme: 'file', path: fsPath });
    await new Promise(r => setTimeout(r, 10));
};

// --- the cases -------------------------------------------------------------

test('external figures in a paper outside the workspace are watched recursively and invalidate the PDF cache', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-outside-assets-'));
    const root = path.join(dir, 'paper.tex'), image = path.join(dir, 'figures', 'plot.png');
    fs.mkdirSync(path.dirname(image));
    fs.writeFileSync(root, '\\documentclass{article}\n\\begin{document}\\includegraphics{figures/plot}\\end{document}');
    fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 0, 1]));
    const doc = { uri:{ fsPath:root, scheme:'file' }, languageId:'latex', isDirty:false, getText:()=>fs.readFileSync(root,'utf8') };
    const { snapshotSources, generationIsCurrent } = require(R('out/extension/tex/compileService'));
    viewerRoot = root;
    try {
        for (const fn of openHandlers) await fn(doc);
        const w = watchers.find(w => w.pattern?.base?.fsPath === dir && w.pattern.pattern.includes('**/') && w.pattern.pattern.includes('png'));
        assert.ok(w, 'a workspace glob cannot observe the nested figure of an outside paper');
        registered.coord.rootFor(doc);
        const st = registered.coord.roots.get(root);
        st.generation = { sourceSnapshotHash:snapshotSources([root]), ok:true, passesLimited:false };
        assert.ok(registered.coord.isCurrent(st, st.generation.sourceSnapshotHash));
        const before = fs.readFileSync(root);
        for (const kind of ['_change','_create','_delete']) {
            scheduled.length = 0;
            for (const fn of w[kind]) await fn({ fsPath:image });
            assert.deepStrictEqual(scheduled, [root], `${kind} rebuilds the visible paper`);
            assert.equal(st.sourceAhead, true, 'the page must remain stale until the new figure is compiled');
            assert.equal(registered.coord.isCurrent(st, st.generation.sourceSnapshotHash), false, 'unchanged TeX cannot reuse the old PDF');
        }
        const generation = { ...st.generation, assetFiles:[image], assetSnapshotHash:snapshotSources([image]) };
        st.generation = generation;
        assert.ok(registered.coord.isCurrent(st, generation.sourceSnapshotHash), 'the updated PDF can be reused');
        assert.ok(generationIsCurrent(generation, [root]));
        fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 0, 2]));
        assert.equal(generationIsCurrent(generation, [root]), false, 'reload cannot restore a cached PDF with stale image bytes');
        assert.deepStrictEqual(fs.readFileSync(root), before, 'no TeX edits needed');
    } finally { viewerRoot = ROOT; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('asset events ignore the paper export, unrelated folders and a closed viewer', async () => {
    const w = watchers.find(w => typeof w.pattern === 'string' && w.pattern.includes('png'));
    assert.ok(w);
    scheduled.length = 0;
    for (const file of [ROOT.replace(/\.tex$/i,'.pdf'), path.join(os.tmpdir(),'unrelated-figure.png')]) {
        for (const fn of w._change) await fn({fsPath:file});
    }
    viewerOpen = false;
    for (const fn of w._change) await fn({fsPath:path.join(DIR,'plot.png')});
    viewerOpen = true;
    assert.deepStrictEqual(scheduled, []);
});

test('a burst of asset events settles once, without running a text-only checkpoint preview', async () => {
    let builds=0, previews=0, arms=0;
    const coord={ rootFor:()=>ROOT, roots:new Map([[ROOT,{}]]), _liveTimers:new Map(), _liveFirst:new Map(), _externalBuilds:{has:()=>false},
        _schedulePreview:()=>{previews++;return true;}, _armAuthoritative:()=>{arms++;},
        build:async()=>{builds++;} };
    const priorConfig=stub.workspace.getConfiguration;
    stub.workspace.getConfiguration=()=>({get:(key,fallback)=>key === 'liveRenderDelayMs' ? 200 : fallback});
    try {
        for (let i=0;i<5;i++) scheduleLive.call(coord,{uri:{fsPath:ROOT}},0,{preview:false});
        await new Promise(r=>setTimeout(r,10));
        assert.equal(previews,0);
        assert.equal(builds,1,'the timer coalesces the write burst');
        assert.equal(arms,5,'the ordinary convergence schedule remains armed');
        stub.workspace.getConfiguration=()=>({get:(key,fallback)=>key === 'compile' ? 'off' : fallback});
        scheduleLive.call(coord,{uri:{fsPath:ROOT}},0,{preview:false});
        await new Promise(r=>setTimeout(r,10));
        assert.equal(builds,1,'compile-off is respected');
    } finally { stub.workspace.getConfiguration=priorConfig; }
});

test('startup does not reopen an approved review from an older disk cursor', async () => {
    const { ReviewSession } = require('../../tex/reviewSession');
    const { ReviewStore } = require('../../tex/reviewStore');
    const storage = fs.mkdtempSync(path.join(DIR, 'approved-reload-'));
    const original = fs.readFileSync(ROOT, 'utf8');
    const approved = original.replace('\\input{section}', 'Approved paragraph.\n\\input{section}');
    const session = new ReviewSession({ file:ROOT, baseText:original });
    session.noteBatch({ source:'paper_applyEdit' });
    session.update({ currentText:approved }); session.keepAll(); session.update({ currentText:approved });
    // Also exercises records saved before the checkpoint field existed.
    new ReviewStore(path.join(storage, 'paper-reviews')).save({ file:ROOT, observed:original, session:session.serialize() });
    const beforeDocs = stub.workspace.textDocuments;
    const counts = [watchers.length, openHandlers.length, saveHandlers.length, changeHandlers.length, willSaveHandlers.length];
    const context = { subscriptions:[], extensionUri:{ fsPath:EXT }, globalStorageUri:{ fsPath:storage },
        globalState:{ get:()=>undefined, update:async()=>{} }, workspaceState:{ get:()=>undefined, update:async()=>{} },
        secrets:{ get:async()=>undefined, store:async()=>{} } };
    try {
        fs.writeFileSync(ROOT, approved);
        stub.workspace.textDocuments = [{ uri:{ fsPath:ROOT, scheme:'file' }, languageId:'latex', version:1,
            isDirty:false, isClosed:false, getText:()=>approved }];
        const activated = tex.registerTexSupport(context, {});
        await new Promise(r => setTimeout(r, 20));
        assert.equal(activated.viewer._review.sessionFor(ROOT), null, 'the actual reopen wiring preserves approval');
        const saved = new ReviewStore(path.join(storage, 'paper-reviews')).load()[0];
        assert.equal(ReviewSession.restore(saved.session).pendingCount, 0);
        assert.equal(saved.session.baseText, approved);
        assert.equal(saved.observed, approved, 'the disk cursor catches up without resetting the accepted baseline');
    } finally {
        for (const d of context.subscriptions) d.dispose?.();
        stub.workspace.textDocuments = beforeDocs;
        [watchers, openHandlers, saveHandlers, changeHandlers, willSaveHandlers].forEach((list, i) => { list.length=counts[i]; });
        fs.writeFileSync(ROOT, original);
    }
});

test('a viewer deletion previews new text before VS Code marks its buffer dirty', () => {
    const priorDocs = stub.workspace.textDocuments;
    const before = fs.readFileSync(ROOT, 'utf8');
    const after = before.replace('\\input{section}', '');
    const doc = { uri: { fsPath: ROOT }, version: 2, isDirty: false, isClosed: false, getText: () => after };
    const st = { files: [ROOT], map: null };
    const coord = Object.create(renderUi.RenderCoordinator.prototype);
    coord.roots = new Map([[ROOT, st]]);
    coord.rootOf = new Map([[ROOT, ROOT]]);
    stub.workspace.textDocuments = [doc];
    try {
        coord.noteChange({ document: doc, contentChanges: [{ text: '', rangeLength: 15 }] });
        assert.equal(coord.liveOverlay(ROOT).get(ROOT), after,
            'the first preview must compile the deletion, not unchanged disk bytes');
        doc.isDirty = true;
        coord.noteChange({ document: doc, contentChanges: [] });
        assert.equal(coord.liveOverlay(ROOT).get(ROOT), after, 'the dirty buffer takes over');
        doc.isDirty = false;
        coord.noteChange({ document: doc, contentChanges: [] });
        assert.equal(coord.liveOverlay(ROOT), null,
            'after saving, a clean buffer cannot shadow later external disk changes');
    } finally { stub.workspace.textDocuments = priorDocs; }
});

test('mini-editor and page typing keep live scheduling instead of forcing an agent full build', async () => {
    const bus = require(R('out/extension/tex/reviewBus'));
    const oldCompile = TexViewer.prototype.compileForAgent;
    const oldApply = stub.workspace.applyEdit;
    const forced = [];
    TexViewer.prototype.compileForAgent = file => forced.push(file);
    const doc = { uri:{ fsPath:ROOT,scheme:'file' },languageId:'latex',isDirty:true,isClosed:false,
        getText:() => fs.readFileSync(ROOT,'utf8') };
    try {
        scheduled.length = 0; liveScheduled.length = 0;
        stub.workspace.applyEdit = async () => {
            // Drive the actual document-change wiring between the reader's
            // begin/end announcements, as VS Code does during WorkspaceEdit.
            for (const handler of changeHandlers) await handler({ document:doc,
                contentChanges:[{ range:{ start:{ line:1 },end:{ line:1 } },rangeOffset:0,rangeLength:0,text:'x' }] });
            return true;
        };
        const viewer = Object.create(TexViewer.prototype);
        for (let i=0;i<5;i++) await viewer._applyReaderEdit(doc, {});
        for (let i=0;i<5;i++) await viewer._asReaderEdit(ROOT, () => stub.workspace.applyEdit({}));
        assert.equal(liveScheduled.filter(f => f === ROOT).length,10,'every reader key still reaches live rendering');
        assert.deepStrictEqual(forced,[],'reader announcements cannot request priority full builds');
        bus.announceAgentEdit({ file:ROOT,phase:'begin',source:'paper_applyEdit' });
        assert.deepStrictEqual(forced,[],'an unfinished agent edit also waits');
        bus.announceAgentEdit({ file:ROOT,phase:'end',source:'paper_applyEdit' });
        assert.deepStrictEqual(forced,[ROOT],'a genuine agent completion retains its priority build');
        bus.announceAgentEdit({ file:ROOT,origin:'user',phase:'end',source:'wpaper.viewer' });
        assert.deepStrictEqual(forced,[ROOT],'reader typing cannot restart that priority build');
    } finally {
        TexViewer.prototype.compileForAgent = oldCompile;
        stub.workspace.applyEdit = oldApply;
    }
});

test('save metadata does not re-arm live rendering, and idle saves reuse the edit schedule', async () => {
    const doc = { uri: { fsPath: ROOT, scheme: 'file' }, languageId: 'latex', isDirty: false,
        isClosed: false, getText: () => fs.readFileSync(ROOT, 'utf8') };
    const oldBuild = renderUi.RenderCoordinator.prototype.build;
    const oldEnsure = renderUi.RenderCoordinator.prototype.ensureLiveRefresh;
    const builds = []; let ensured = 0;
    renderUi.RenderCoordinator.prototype.build = async (_doc, opts) => { builds.push(opts); };
    renderUi.RenderCoordinator.prototype.ensureLiveRefresh = () => { ensured++; };
    TexViewer.prototype._automaticSourceSaves = new Set([ROOT]);
    try {
        scheduled.length = 0;
        for (const fn of changeHandlers) await fn({ document: doc, contentChanges: [] });
        assert.deepStrictEqual(scheduled, [], 'a dirty-flag update cannot reset the typing pause');
        // The final save handler owns rendering; earlier ones update caches and disk baselines.
        await saveHandlers.at(-1)(doc);
        assert.deepStrictEqual(builds, [], 'an idle save cannot restart or force a full compile');
        assert.equal(ensured, 1, 'a missing schedule still has the normal recovery path');
        TexViewer.prototype._automaticSourceSaves.clear();
        await saveHandlers.at(-1)(doc);
        assert.deepStrictEqual(builds, [{ authoritative: true, quiet: false }],
            'explicit saving still requests an authoritative build');
    } finally {
        delete TexViewer.prototype._automaticSourceSaves;
        renderUi.RenderCoordinator.prototype.build = oldBuild;
        renderUi.RenderCoordinator.prototype.ensureLiveRefresh = oldEnsure;
    }
});

test('a restored dirty buffer does not turn an unchanged disk notification into a conflict', async () => {
    const file = path.join(DIR, 'restored.tex');
    const disk = '\\documentclass{article}\n\\begin{document}\nSaved paragraph.\n\\end{document}\n';
    fs.writeFileSync(file, disk);
    const doc = { uri: { fsPath: file, scheme: 'file' }, languageId: 'latex', isDirty: true,
        isClosed: false, getText: () => disk.replace('Saved', 'My unsaved') };
    const priorDocs = stub.workspace.textDocuments;
    stub.workspace.textDocuments = [doc]; viewerRoot = file;
    try {
        for (const fn of openHandlers) await fn(doc);
        const warned = warnings.length;
        await fire(file);
        assert.equal(warnings.length, warned, 'no modal for unchanged disk');
        assert.deepStrictEqual(scheduled, [], 'no external rebuild');
        assert.deepStrictEqual(guarded, [], 'no layout jump');
        assert.ok(doc.getText().includes('My unsaved paragraph'));
        fs.writeFileSync(file, disk.replace('Saved', 'Their changed'));
        await fire(file);
        assert.ok(scheduled.includes(file), 'a real external change still rebuilds');
    } finally { stub.workspace.textDocuments = priorDocs; viewerRoot = ROOT; }
});

test('reopening a behind viewer arms one rebuild without postponing pending work', async () => {
    const st = { sourceAhead: true, compiling: false, lastError: null };
    const timers = new Map(), calls = [];
    const coord = { roots: new Map([[ROOT, st]]), rootFor: () => ROOT, _liveTimers: timers,
        scheduleLive: (doc, delay) => { calls.push([doc.uri.fsPath, delay]); timers.set(ROOT, true); } };
    const ensure = () => renderUi.RenderCoordinator.prototype.ensureLiveRefresh.call(coord, { uri: { fsPath: ROOT } });
    ensure(); ensure();
    assert.deepStrictEqual(calls, [[ROOT, 3000]]);
    timers.clear(); st.compiling = true; ensure();
    st.compiling = false; st.lastError = 'invalid TeX'; ensure();
    st.lastError = null; st.sourceAhead = false; ensure();
    assert.equal(calls.length, 1, 'no duplicate compile, error retry loop, or current-page rebuild');
    // Exercise refresh itself: the stale badge and recovery must share a path.
    const viewer = Object.create(TexViewer.prototype);
    viewer.panel = {}; viewer.coord = { roots: coord.roots, ensureLiveRefresh: ensure };
    viewer._post = () => {}; viewer._setTracePaused = () => {};
    st.sourceAhead = true;
    await viewer.refresh();
    assert.equal(calls.length, 2, 'refresh on reopen/switch triggers recovery without any edit event');
});

test('save then type then watcher is not an external change or navigation request', async () => {
    const priorDocs = stub.workspace.textDocuments;
    viewerRoot = ROOT;
    let text = 'Saved by the mini-editor.\n';
    const doc = { uri:{fsPath:CHILD,scheme:'file'}, languageId:'latex',isDirty:true,isClosed:false,getText:()=>text };
    stub.workspace.textDocuments = [doc];
    try {
        for (const fn of willSaveHandlers) await fn({document:doc,waitUntil:()=>{}});
        fs.writeFileSync(CHILD,text);
        text += 'More typing before the watcher arrives.';
        await fire(CHILD);
        assert.equal(scheduled.length,0,'our save cannot queue an external rebuild');
        assert.equal(guarded.length,0,'our save cannot trigger layout restoration');
        assert.ok(doc.getText().endsWith('arrives.'),'unsaved typing remains intact');
        fs.writeFileSync(CHILD,'A genuinely external rewrite.\n');
        await fire(CHILD);
        assert.ok(scheduled.includes(CHILD),'different disk contents still enter external-change handling: '+JSON.stringify(scheduled));
    } finally { stub.workspace.textDocuments = priorDocs; viewerRoot = ROOT; }
});

test('the watcher for .tex/.bib is actually registered', () => {
    assert.ok(texWatcher, `no .tex watcher among ${watchers.map(w => w.pattern).join(', ') || 'none'}`);
});

test('save participants and resumed mini-editor typing cannot turn saved bytes into an external conflict', async () => {
    const file = path.join(DIR, 'save-participant.tex');
    const base = '\\documentclass{article}\n\\begin{document}\nOriginal.\n\\end{document}\n';
    fs.writeFileSync(file, base);
    let text = base.replace('Original.', 'My paragraph.   ');
    const doc = { uri: { fsPath: file, scheme: 'file' }, languageId: 'latex', isDirty: true,
        isClosed: false, getText: () => text };
    const oldDocs = stub.workspace.textDocuments;
    stub.workspace.textDocuments = [doc]; viewerRoot = file;
    const emitChange = async () => { for (const fn of changeHandlers) await fn({ document: doc,
        contentChanges: [{ range: new stub.Range(new stub.Position(2, 0), new stub.Position(2, 9)), text }] }); };
    try {
        for (const fn of openHandlers) await fn(doc);
        for (const fn of willSaveHandlers) await fn({ document: doc, waitUntil: () => {} });
        // Save-time whitespace cleanup chooses bytes different from will-save.
        text = text.replace('paragraph.   ', 'paragraph.');
        await emitChange();
        const saved = text;
        fs.writeFileSync(file, saved);
        // The did-save event carries a live TextDocument, already dirty again.
        text = text.replace('paragraph.', 'paragraph. Typing continues.');
        await emitChange();
        for (const fn of saveHandlers.slice(0, -1)) await fn(doc);
        const warned = warnings.length;
        await fire(file);
        assert.equal(warnings.length, warned, 'no false conflict modal');
        assert.deepStrictEqual(scheduled, [], 'no agent/external rebuild for our saved snapshot');
        assert.deepStrictEqual(guarded, [], 'no external layout restoration');
        assert.equal(doc.getText(), text, 'newer typing remains intact');
        assert.equal(fs.readFileSync(file, 'utf8'), saved, 'the watcher never writes the dirty buffer');
        // A later mtime-only event must still use the persisted baseline.
        await fire(file);
        assert.deepStrictEqual(scheduled, []);
        fs.writeFileSync(file, base.replace('Original.', 'A real outside edit.'));
        await fire(file);
        assert.ok(scheduled.includes(file), 'a genuine external change is still handled');
    } finally { stub.workspace.textDocuments = oldDocs; viewerRoot = ROOT; }
});

test('a watcher event that beats save completion is rechecked against the completed save', async () => {
    const file = path.join(DIR, 'save-notification-first.tex');
    const base = '\\documentclass{article}\n\\begin{document}\nOriginal.\n\\end{document}\n';
    fs.writeFileSync(file, base);
    let text = base.replace('Original.', 'Mini editor edit. ');
    const doc = { uri: { fsPath: file, scheme: 'file' }, languageId: 'latex', isDirty: true,
        isClosed: false, getText: () => text };
    const oldDocs = stub.workspace.textDocuments;
    stub.workspace.textDocuments = [doc]; viewerRoot = file;
    try {
        for (const fn of openHandlers) await fn(doc);
        for (const fn of willSaveHandlers) await fn({ document: doc, waitUntil: () => {} });
        text = text.replace('edit. ', 'edit.');
        fs.writeFileSync(file, text);
        const warned = warnings.length;
        const pending = fire(file); // watcher IPC arrives before document/save IPC
        doc.isDirty = false;
        for (const fn of saveHandlers.slice(0, -1)) await fn(doc);
        text = text.replace('edit.', 'edit. More typing.'); doc.isDirty = true;
        await pending;
        assert.equal(warnings.length, warned);
        assert.deepStrictEqual(scheduled, [], 'a delayed save notification is not an external edit');
        assert.ok(text.includes('More typing.'), 'typing is not reverted');
    } finally { stub.workspace.textDocuments = oldDocs; viewerRoot = ROOT; }
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

test('a deleted included source joins the surviving main file batch', async () => {
    const before = fs.readFileSync(CHILD);
    scheduled.length = 0;
    registered.coord.rootFor({ uri: { fsPath: ROOT } });
    try {
        fs.unlinkSync(CHILD);
        for (const fn of texWatcher._delete) await fn({ fsPath: CHILD });
        assert.deepStrictEqual(scheduled, [CHILD]);
        assert.equal(registered.coord.rootOf.get(CHILD), ROOT);
        assert.ok(fs.existsSync(ROOT));
    } finally { fs.writeFileSync(CHILD, before); }
});

test('review groups use chapter through subsubsection, never paragraph or subparagraph', () => {
    const priorDocs = stub.workspace.textDocuments, priorText = fs.readFileSync(ROOT, 'utf8');
    const text = ['\\documentclass{book}', '\\begin{document}', '\\chapter{Chapter}',
        '\\paragraph{Before section}', 'Chapter text.', '\\section{Section}',
        '\\paragraph{Section detail}', 'Section text.', '\\subsection{Subsection}',
        '\\paragraph{Subsection detail}', 'Subsection text.', '\\subsubsection{Subsubsection}',
        '\\paragraph{Deep detail}', 'Deep text.', '\\subparagraph{Smaller detail}', 'Smaller text.',
        '\\section{Next section}', '\\paragraph{Next detail}', 'Next text.', '\\end{document}'].join('\n');
    const doc = { uri: { fsPath: ROOT, scheme: 'file' }, languageId: 'latex', isClosed: false,
        version: 9001, lineCount: text.split('\n').length, getText: () => text };
    try {
        fs.writeFileSync(ROOT, text); stub.workspace.textDocuments = [doc];
        const view = registered.viewer._review.mapView(ROOT);
        assert.equal(view.sectionAt(1), null);
        for (const [line, title, level] of [[4, 'Chapter', 1], [7, 'Section', 2],
            [10, 'Subsection', 3], [13, 'Subsubsection', 4], [15, 'Subsubsection', 4], [18, 'Next section', 2]]) {
            const group = view.sectionAt(line);
            assert.equal(group.title, title, `line ${line} belongs to its enclosing structural section`);
            assert.equal(group.level, level);
        }
    } finally { stub.workspace.textDocuments = priorDocs; fs.writeFileSync(ROOT, priorText); }
});

test('the rebuild is SCHEDULED, not run on the spot', async () => {
    // The external queue collects one whole-paper batch. Calling build()
    // directly here would compile a 139-page
    // paper on every keystroke a sync happens to land between.
    const src = fs.readFileSync(R('out/extension/tex/index.js'), 'utf8');
    const fn = src.slice(src.indexOf('const rebuildAfterExternal'),
                         src.indexOf('const watcher = vscode.workspace.createFileSystemWatcher'));
    assert.ok(/coord\.scheduleExternal\(/.test(fn), 'it must go through the debounced path');
    assert.ok(!/coord\.build\(/.test(fn), 'and must not compile inline');
});

test('a changed closed source queues before slow review processing, with no second schedule afterward', async () => {
    const { ReviewUi } = require(R('out/extension/tex/reviewUi.js'));
    await fire(CHILD); // establish the observed bytes, even if no review is open
    const old = ReviewUi.prototype.noteAgentChange;
    const before = fs.readFileSync(CHILD, 'utf8'); let release, entered = false;
    ReviewUi.prototype.noteAgentChange = () => { entered = true; return new Promise(resolve => { release = resolve; }); };
    try {
        fs.writeFileSync(CHILD, before + '\nA collaborator added this paragraph.\n'); scheduled.length = 0;
        const jobs = texWatcher._change.map(fn => fn({ fsPath: CHILD, scheme: 'file', path: CHILD }));
        assert.equal(entered, true);
        assert.deepStrictEqual(scheduled, [CHILD], 'the batch starts collecting before the review awaits');
        release(); await Promise.all(jobs);
        assert.deepStrictEqual(scheduled, [CHILD], 'completion cannot request a competing build');
    } finally { ReviewUi.prototype.noteAgentChange = old; fs.writeFileSync(CHILD, before); }
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
