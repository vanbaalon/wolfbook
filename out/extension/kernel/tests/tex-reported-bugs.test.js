'use strict';
// Regression tests for the user-reported WPaper bugs in docs/tex-reported-bugs.md.
//
//   node out/extension/kernel/tests/tex-reported-bugs.test.js
//
// One test (or more) per bug id in scope: the rows classified headless-unit or
// host-harness for WPaper (WP) or engine behaviour seen from WPaper (EN). Each
// is named with its id and drives the real code path (TexViewer.prototype
// methods, RenderCoordinator, exported helpers) against fakes, so it fails on
// the reported behaviour and passes on the fix. Webview-only and desktop rows
// are tested elsewhere.
//
// #11 needs the whole extension registration (registerTexSupport) against a
// wide vscode stub; it runs in a child process of this same file so its
// prototype patches and timers cannot leak into the other tests.

if (process.env.WPAPER_BUG11_CHILD) { runBug11Child(); return; }

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { makeVscodeStub } = require('./_stub-vscode');

const EXT = path.resolve(__dirname, '..', '..', '..', '..');
const TEX_DIR = path.join(EXT, 'out', 'extension', 'tex');
const VIEWER_SRC = fs.readFileSync(path.join(TEX_DIR, 'texViewer.js'), 'utf8');

// ── vscode stub ────────────────────────────────────────────────────────────
const stub = makeVscodeStub();
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
    constructor(a, b, c, d) {
        this.start = typeof a === 'object' ? a : new Position(a, b);
        this.end = typeof a === 'object' ? b : new Position(c, d);
    }
}
class Selection extends Range {
    constructor(anchor, active) {
        const forward = anchor.line < active.line || (anchor.line === active.line && anchor.character <= active.character);
        super(forward ? anchor : active, forward ? active : anchor);
        this.anchor = anchor; this.active = active;
        this.isEmpty = anchor.line === active.line && anchor.character === active.character;
    }
}
stub.Position = Position; stub.Range = Range; stub.Selection = Selection;
stub.TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2 };
stub.WorkspaceEdit = class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } };
stub.workspace.textDocuments = [];
const cfg = { mapEngine: 'wlatex', wlatexDirectory: '/built/wlatex', compileTimeoutMs: 180000, authoritativeDelayMs: 0 };
stub.workspace.getConfiguration = () => ({ get: (k, d) => (k in cfg ? cfg[k] : d), update: async () => {} });
const warnings = [];
stub.window.showWarningMessage = async (message, ...choices) => { warnings.push({ message, choices }); return undefined; };
stub.window.showInformationMessage = async (message) => { warnings.push({ message, choices: [] }); return undefined; };

// A WLaTeX lane and a latexmk compile that record what was asked of them.
const lane = { installed: true, settled: false, constructed: 0, compiles: 0 };
const conventional = { calls: 0, next: null };
const oldLoad = Module._load;
Module._load = function (req, ...args) {
    if (req === 'vscode') return stub;
    if (req === './nativeCompileService') return { NativeBuildLane: class {
        constructor() { lane.constructed++; if (!lane.installed) throw Error('runtime missing'); this.directory = '/built/wlatex'; }
        async compile(o) {
            lane.compiles++;
            return { ok: true, runner: 'wlatex', generation: 1000 + lane.compiles, pdfPath: 'unused', pdfHash: 'native',
                sourceSnapshotHash: o.sourceSnapshotHash, nativeCompiledSources: new Map(),
                pageCount: 1, rerunWanted: !lane.settled, diagnostics: [] };
        }
        invalidate() {}
        async close() { this.closed = true; }
    } };
    const result = oldLoad.call(this, req, ...args);
    if (req === './compileService') return { ...result,
        loadGeneration: () => null, saveGeneration: () => false,
        compile: async o => {
            conventional.calls++;
            const next = conventional.next; conventional.next = null;
            return { ok: true, generation: 100 + conventional.calls, pdfPath: 'unused', sourceSnapshotHash: o.sourceSnapshotHash,
                pageCount: 1, errors: 0, warnings: 0, diagnostics: [], ...(next || {}) };
        } };
    return result;
};
let RenderCoordinator, TexViewer;
try {
    ({ RenderCoordinator } = require('../../tex/renderUi'));
    ({ TexViewer } = require('../../tex/texViewer'));
} finally { Module._load = oldLoad; }
const { FLAG } = require('../../tex/renderMap');
const { NativeMap } = require('../../tex/nativeMap');
const { scanTex } = require('../../tex/texScanner');
const { buildModel } = require('../../tex/texModel');
const { caretAt, keyEdit } = require('../../tex/inkEdit');
const { decideFollow } = require('../../tex/viewerFollow');
const { describeExit, describeCompileFailure } = require('../../tex/compileService');

// ── shared fakes ───────────────────────────────────────────────────────────

/** A VS Code-shaped document over `text` (mutable with `set`). */
function textDoc(fsPath, text) {
    const lines = () => text.split('\n');
    const offsetAt = p => { const ls = lines(); let o = 0; for (let i = 0; i < p.line; i++) o += ls[i].length + 1; return o + p.character; };
    const positionAt = off => { const ls = lines(); let i = 0; let rem = off;
        while (i < ls.length - 1 && rem > ls[i].length) { rem -= ls[i].length + 1; i++; } return new Position(i, rem); };
    return {
        uri: { fsPath, scheme: 'file', path: fsPath }, version: 1, isDirty: false,
        get lineCount() { return lines().length; },
        lineAt: i => ({ text: lines()[i], range: new Range(new Position(i, 0), new Position(i, lines()[i].length)) }),
        getText: range => (range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text),
        offsetAt, positionAt,
        set(next) { text = next; this.version++; },
    };
}

/** A RenderCoordinator on a one-file paper, with the fake lane and compile above. */
function coordinatorFixture(source = '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-bugs-'));
    const root = path.join(dir, 'paper.tex');
    fs.writeFileSync(root, source);
    const log = [];
    const coordinator = new RenderCoordinator({}, { appendLine: l => log.push(l), show() {} });
    coordinator._luaOk = false;
    const state = { root, files: [root], generation: null, map: null };
    coordinator.roots.set(root, state);
    coordinator.rootOf.set(root, root);
    return { coordinator, state, root, log, doc: { uri: { fsPath: root } },
        close() { coordinator.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const PAPER = path.join(os.tmpdir(), 'wpaper-bugs', 'paper.tex');

/**
 * _syncNativeCursor on a native map whose worker answers `forwardAt` by source
 * column (`glyphs[col]`, a rect or null) and `forwardRange` with `range`.
 */
function nativeCursorFixture({ text, anchor, active = anchor, glyphs = {}, range = [], sourceAhead = false }) {
    const posts = [];
    const doc = textDoc(PAPER, text);
    const calls = [];
    const map = { native: true, available: true, projectDir: path.dirname(PAPER), view: { artifact: { pdf_hash: 'pdf' } },
        source: { files: new Map([['paper.tex', { text }]]) },
        forwardAt: async (file, line, column) => { calls.push(['at', line, column]); const g = glyphs[`${line}:${column}`]; return g ? [g] : []; },
        forwardRange: async () => { calls.push(['range']); return range; } };
    const state = { root: PAPER, map, sourceAhead };
    const editor = { document: doc, selection: new Selection(new Position(...anchor), new Position(...active)) };
    const viewer = { root: PAPER, panel: {}, followCursor: true, _openedPdfHash: 'pdf', _nativeCursorRequest: 1,
        coord: { stateFor: () => state, roots: new Map([[PAPER, state]]) }, _post: m => posts.push(m),
        _setTracePaused() {}, _mayScroll: () => true, _invertedAt: 0, _log() {}, _postEditSelection() {} };
    return { viewer, state, map, doc, editor, posts, calls,
        run: (opts = {}) => TexViewer.prototype._syncNativeCursor.call(viewer, state, editor, opts, viewer._nativeCursorRequest) };
}

/**
 * A page click (_jumpToSource) or right-click (_openEditSession) on the native
 * map: `hit` names the clicked glyph's source (1-based line, UTF-16 column).
 */
function nativeClickFixture({ text, line, column, file = PAPER, exact = true }) {
    const posts = [], cards = [], calls = [];
    const doc = textDoc(file, text);
    const hit = { file, line, flag: 'fresh', exact,
        sourceRange: { start: { line, column_utf16: column }, end: { line, column_utf16: column + 1 } },
        glyph: { page: 1, x: 100, y: 80, w: 5, boxHeight: 9 } };
    const map = { native: true, available: true, projectDir: path.dirname(file), view: { artifact: { pdf_hash: 'pdf' } },
        source: { files: new Map([[path.basename(file), { text }]]) }, renderToSource: () => hit };
    const state = { root: file, map, sourceAhead: true, nativeLane: {} };
    let selection = null;
    const editor = { document: doc, get selection() { return selection; }, set selection(s) { selection = s; }, revealRange() {} };
    stub.workspace.openTextDocument = async () => doc;
    stub.window.showTextDocument = async () => editor;
    stub.window.visibleTextEditors = [];
    const viewer = Object.create(TexViewer.prototype);
    Object.assign(viewer, { root: file, panel: {}, _openedPdfHash: 'pdf', _openedGeneration: 1, _nativeInverseRequest: 0,
        _editSeq: 0, coord: { roots: new Map([[file, state]]), stateFor: () => state, proDisabled: false },
        _post: m => posts.push(m), _log() {}, _rememberCursor() {}, _rememberEditState() {}, _ensureDocListener() {},
        _postEditSelection: (...a) => cards.push(a), _editRects: () => [] });
    const click = (m = {}) => ({ generation: 1, page: 1, xBp: 102, yTopBp: 84, ...m });
    return { viewer, state, map, doc, hit, editor, posts, cards, calls,
        leftClick: m => viewer._jumpToSource(click(m)),
        rightClick: m => viewer._openEditSession(click(m)) };
}

/** An unexported top-level function of texViewer.js, compiled from its source. */
function viewerFunction(name) {
    const start = VIEWER_SRC.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `${name} is defined in texViewer.js`);
    const end = VIEWER_SRC.indexOf('\n}\n', start);
    return new Function(`${VIEWER_SRC.slice(start, end + 3)}\nreturn ${name};`)();
}

// ── #1 inverse search: the editor caret and the page caret disagree ──────────

/** "wavefunction" on line 5 at columns 16.., one 10-bp glyph per letter. */
function exactWord(word = 'wavefunction', line = 5, startCol = 16) {
    const tokens = [], glyphs = [], srcToRen = [], renToSrc = [];
    [...word].forEach((ch, i) => {
        tokens.push({ ch, line, startCol: startCol + i, endLine: line, endCol: startCol + i + 1, inMath: false });
        glyphs.push({ page: 1, x: 100 + 10 * i, y: 200, w: 10, h: 12, ch });
        srcToRen.push(i); renToSrc.push(i);
    });
    return { tokens, glyphs, srcToRen, renToSrc, exact: true };
}
const PROSE = ['\\documentclass{article}', '\\begin{document}', '', '',
    'We write the transformed wavefunction as a thing worth reading twice.', '\\end{document}'].join('\n');
const WAVE = PROSE.split('\n')[4].indexOf('wavefunction');

/** A real TexViewer on the classic (non-native) exact map. */
function classicViewer({ hit = null } = {}) {
    const doc = textDoc('/paper/main.tex', PROSE);
    const model = buildModel(scanTex(PROSE), { file: doc.uri.fsPath });
    const st = { root: doc.uri.fsPath, generation: { generation: 1, pageCount: 1 }, map: {
        available: true, exact: true, _baseFlag: () => FLAG.FRESH,
        renderToSource: () => hit, lineAtPoint: () => hit && { file: hit.file, line: hit.line, dx: 0 },
        lineRows: () => [{ page: 1, x: 100, y: 200, w: 300, h: 12 }], objectAtLine: () => null,
        sourceToRender: () => ({ page: 1, flag: FLAG.FRESH }) } };
    const coord = { roots: new Map([[doc.uri.fsPath, st]]), rootFor: () => doc.uri.fsPath, stateFor: () => st };
    const v = new TexViewer({ extensionUri: { fsPath: '/ext' } }, coord, { get: () => ({ model }) });
    v.root = doc.uri.fsPath;
    v.posted = [];
    v.panel = { webview: { postMessage: m => v.posted.push(m) } };
    v._alignMap = () => exactWord('wavefunction', 5, WAVE);
    return { v, doc, st };
}

test('#1 after an inverse click the page caret sits at the selection\'s ACTIVE end, not its start', () => {
    const { v, doc } = classicViewer();
    // The click selected "wavefunction"; VS Code left the cursor at its end.
    const start = new Position(4, WAVE), end = new Position(4, WAVE + 12);
    v._selfRange = { file: doc.uri.fsPath, kind: 'click', sl: 4, sc: WAVE, el: 4, ec: WAVE + 12, at: Date.now() };
    v.syncFromEditor({ document: doc, selection: new Selection(start, end) });
    const h = v.posted.filter(m => m.type === 'highlight').at(-1);
    assert.ok(h && h.caret, 'a highlight with a caret was posted');
    assert.equal(h.word, 'wavefunction', 'the word is still resolved from the start');
    assert.equal(h.caret.x, 100 + 12 * 10, 'the caret is drawn at the end of the word, where the editor cursor is');
    assert.equal(h.caret.at, 'after');
});

test('#1 a caret column of 0 is honoured, not treated as missing', () => {
    const { v } = classicViewer();
    v._alignMap = () => exactWord('half', 5, 0);
    const doc = textDoc('/paper/main.tex', 'x\nx\nx\nx\nhalf more');
    v.posted.length = 0;
    TexViewer.prototype._postAlignedGlyph.call(v, v.coord.stateFor(), doc, 5, 2, 'line 5', 0);
    assert.equal(v.posted.at(-1).caret.x, 100, 'column 0 is the word\'s left edge, not the resolution column 2');
    TexViewer.prototype._postAlignedGlyph.call(v, v.coord.stateFor(), doc, 5, 0, 'line 5', 3);
    assert.equal(v.posted.at(-1).caret.x, 130, 'and an active end inside the word lands inside it');
});

// ── #2 a click mid-word puts the caret at the clicked letter ────────────────

test('#2 a click on the k-th letter of a prose word collapses the editor selection there and outlines the word', async () => {
    const hit = { file: '/paper/main.tex', line: 5, flag: FLAG.FRESH, object: null };
    const { v, doc } = classicViewer({ hit });
    let selection = null, revealed = null;
    stub.workspace.openTextDocument = async () => doc;
    stub.window.showTextDocument = async () => ({ document: doc,
        get selection() { return selection; }, set selection(s) { selection = s; }, revealRange: r => { revealed = r; } });
    // The pointer is on the 3rd glyph, "v" (x 120..130).
    await v._jumpToSource({ page: 1, xBp: 125, yTopBp: 206, word: 'wavefunction', rowFraction: 0.2 });
    assert.ok(selection, 'the editor selection was set');
    assert.equal(selection.isEmpty, true, 'a caret, not the whole word');
    assert.equal(selection.start.character, WAVE + 2, 'at the clicked letter');
    assert.equal(doc.lineAt(4).text.slice(revealed.start.character, revealed.end.character), 'wavefunction',
        'the WORD is what is revealed/outlined');
    // Setting it off restores whole-word selection.
    cfg.inverseClickCaret = false;
    try {
        selection = null;
        await v._jumpToSource({ page: 1, xBp: 125, yTopBp: 206, word: 'wavefunction', rowFraction: 0.2 });
        assert.equal(doc.lineAt(4).text.slice(selection.start.character, selection.end.character), 'wavefunction');
    } finally { delete cfg.inverseClickCaret; }
});

test('#2 on the native map a click puts the cursor and the red caret at the clicked character', async () => {
    const f = nativeClickFixture({ text: 'Alpha Alpha', line: 1, column: 8 });
    await f.leftClick();
    assert.equal(f.editor.selection.start.character, 8);
    assert.equal(f.editor.selection.isEmpty, true, 'collapsed at the clicked letter');
    const h = f.posts.filter(p => p.type === 'highlight').at(-1);
    assert.deepEqual(h.caret, { page: 1, x: 100, y: 80, h: 9, at: 'before', offset: 0 }, 'the page caret before the clicked glyph');
});

// ── #7 shortcuts leak to other file types and kill VSCodeVim ───────────────

test('#7 no source registers the single-owner editor commands (type, paste, cut, …)', () => {
    const files = [];
    const walk = dir => { for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === 'tests') continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full); else if (name.endsWith('.js')) files.push(full);
    } };
    walk(path.join(EXT, 'out', 'extension'));
    assert.ok(files.length > 50);
    const re = /register(?:TextEditor)?Command\(\s*['"`](type|replacePreviousChar|compositionType|paste|cut)['"`]/;
    const code = f => fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l));
    assert.deepEqual(files.filter(f => code(f).some(l => re.test(l))).map(f => path.relative(EXT, f)), []);
});

test('#7 every keybinding is scoped and can be switched off; .tex keys need the open viewer', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
    const kb = pkg.contributes.keybindings;
    assert.ok(kb.length > 20);
    const label = k => `${k.key} -> ${k.command}`;
    assert.deepEqual(kb.filter(k => !(k.when || '').trim()).map(label), [], 'no binding is live everywhere');
    assert.deepEqual(kb.filter(k => !/wolfbook\.keys(Tex|Notebook)/.test(k.when)).map(label), [], 'every binding has an off switch');
    const tex = kb.filter(k => /resourceExtname == \.tex/.test(k.when));
    assert.ok(tex.length > 0);
    // Opening the viewer, and the explicit Git keys, are the documented exceptions.
    const free = new Set(['wolfbook.tex.openViewer', 'wolfbook.tex.commitChanges', 'wolfbook.tex.pushChanges']);
    const ungated = tex.filter(k => !/wolfbook\.texViewerOpen/.test(k.when) && !free.has(k.command));
    assert.deepEqual(ungated.map(label), [], '.tex shortcuts exist only while the viewer is open');
    const props = [].concat(pkg.contributes.configuration).reduce((a, c) => Object.assign(a, c.properties), {});
    assert.ok(props['wolfbook.keybindings.tex'], 'a setting turns the .tex shortcuts off');
});

// ── #8 the viewer disappears when an agent tab or panel is clicked ──────────

test('#8 only a real non-tex file beside the paper hides it; agent tabs, terminals and empty groups never do', () => {
    const VIEW = 'wolfbook.texViewer';
    const uri = p => ({ fsPath: p, scheme: 'file' });
    const group = (viewColumn, tabs, active, isActive = false) => ({ viewColumn, tabs, activeTab: tabs[active], isActive });
    const viewer = { input: { viewType: `mainThreadWebview-${VIEW}` } };
    const beside = tab => [group(1, tab ? [tab] : [], 0), group(2, [viewer], 0)];
    const agents = { input: { viewType: 'mainThreadWebview-anthropic.claude-code.chat' } };
    for (const tab of [agents, { input: {} }, { input: undefined }, null]) {
        // The reader clicked an agent tab in a third group: it is active, but not beside the paper.
        const groups = [...beside({ input: { uri: uri('/p/main.tex') } }), group(3, [agents], 0, true)];
        assert.notEqual(decideFollow(groups, { viewType: VIEW }).action, 'hide');
        assert.equal(decideFollow(beside(tab), { viewType: VIEW }).action, 'none', `nothing to judge: ${JSON.stringify(tab)}`);
    }
    assert.equal(decideFollow(beside({ input: { uri: uri('/p/notes.md') } }), { viewType: VIEW }).action, 'hide');
    assert.equal(decideFollow(beside({ input: { uri: uri('/p/main.tex') } }), { viewType: VIEW }).action, 'restore');
});

// ── #10 a heading's plain title doubles "qq" and drops the maths ────────────

test('#10 \\texorpdfstring keeps one spelling and renders the maths symbols (⟨qq⟩)', () => {
    const title = src => scanTex(`\\documentclass{a}\\begin{document}\n${src}\nx\n\\end{document}\n`, { file: 't.tex' })
        .objects.find(o => o.kind === 'section-heading').title;
    assert.equal(title('\\subsection{\\texorpdfstring{$\\langle qq\\rangle$}{qq}}'), '⟨qq⟩');
    assert.equal(title('\\subsection{Preview in \\texorpdfstring{$\\langle qq\\rangle$}{qq} notation}'), 'Preview in ⟨qq⟩ notation');
});

// ── #12 Windows compile fails with "no PDF (unknown reason)" ────────────────

test('#12 a Windows exit code is named, and a run that wrote no log never reports "0 error(s)"', () => {
    assert.match(describeExit(3221226505, 'win32'), /3221226505 \(0xC0000409 STATUS_STACK_BUFFER_OVERRUN\)/);
    const lines = describeCompileFailure({ ok: false, logWritten: false, pdfPath: null, exit: 3221226505, ms: 112,
        stderr: '', command: 'latexmk -lualatex main.tex', commandCwd: 'C:\\out', errors: 0 }, 'win32');
    const text = lines.join('\n');
    assert.match(text, /never ran/);
    assert.match(text, /0xC0000409/);
    assert.match(text, /without writing a log/);
    assert.match(text, /command: latexmk -lualatex main\.tex/);
    assert.match(text, /cwd: C:\\out/);
    assert.doesNotMatch(text, /0 error/);
});

test('#12 on win32 latexmk is spawned undetached and hidden, and cancel kills the tree with taskkill /T /F', async () => {
    const src = fs.readFileSync(path.join(TEX_DIR, 'compileService.js'), 'utf8');
    const start = src.indexOf('function spawnCollect(');
    const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
    const spawns = [];
    const spawn = (cmd, args, opts) => {
        const child = new EventEmitter();
        child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
        spawns.push({ cmd, args, opts, child });
        return child;
    };
    const spawnCollect = new Function('spawn', '_WIN', `${body}\nreturn spawnCollect;`)(spawn, true);
    const ac = new AbortController();
    const done = spawnCollect('latexmk', ['main.tex'], { cwd: 'C:\\out', signal: ac.signal });
    assert.equal(spawns[0].opts.detached, false, 'detached gives latexmk its own console and it dies with 0xC0000409');
    assert.equal(spawns[0].opts.windowsHide, true);
    ac.abort();
    const kill = spawns.find(s => s.cmd === 'taskkill');
    assert.ok(kill, 'cancel uses taskkill');
    assert.deepEqual(kill.args, ['/pid', '4242', '/T', '/F']);
    spawns[0].child.emit('close', 1);
    assert.equal((await done).cancelled, true);
});

test('#12 the build log names the exit and "no log written" instead of "0 error(s)"', async () => {
    const f = coordinatorFixture();
    cfg.mapEngine = 'auto';
    conventional.next = { ok: false, pdfPath: null, logWritten: false, exit: 3221226505, errors: 0, warnings: 0,
        ms: 112, stderr: '', command: 'latexmk main.tex', commandCwd: '/out' };
    try {
        await f.coordinator.build(f.doc, { quiet: true });
        const log = f.log.join('\n');
        assert.match(log, /FAILED/);
        assert.match(log, /no log written/);
        assert.doesNotMatch(log, /FAILED[^\n]*0 error\(s\)/);
        assert.match(f.state.lastError, /without running|exited/);
    } finally { cfg.mapEngine = 'wlatex'; f.close(); }
});

// ── #11 "page behind editor" shows, but a change on disk never recompiles ───

test('#11 an external write to a watched .tex of the open paper schedules a build', () => {
    const res = spawnSync(process.execPath, [__filename], { encoding: 'utf8', timeout: 60000,
        env: { ...process.env, WPAPER_BUG11_CHILD: '1' } });
    const line = (res.stdout || '').split('\n').find(l => l.startsWith('BUG11 '));
    assert.ok(line, `the child harness reported nothing:\n${res.stdout}\n${res.stderr}`);
    const got = JSON.parse(line.slice(6));
    assert.deepEqual(got.root, [got.files.root], 'a shell/agent/git write to the root .tex queues a rebuild');
    assert.deepEqual(got.child, [got.files.child], 'so does a write to an \\input-ed file of the same paper');
    assert.deepEqual(got.other, [], 'a paper the viewer is not showing is left alone');
});

/** Child process of #11: registerTexSupport against a wide stub, firing its file watcher. */
function runBug11Child() {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
    const EXT = path.resolve(__dirname, '..', '..', '..', '..');
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-bug11-'));
    const ROOT = path.join(DIR, 'paper.tex'), CHILD = path.join(DIR, 'section.tex'), OTHER = path.join(DIR, 'other.tex');
    fs.writeFileSync(ROOT, '\\documentclass{article}\n\\begin{document}\n\\input{section}\n\\end{document}\n');
    fs.writeFileSync(CHILD, 'Hello.\n');
    fs.writeFileSync(OTHER, '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');
    const stub = require('./_stub-vscode.js').makeVscodeStub();
    const noDispose = { dispose() {} };
    const watchers = [];
    const cls = () => class { constructor(...a) { this.args = a; } };
    Object.assign(stub, {
        Position: class { constructor(l, c) { this.line = l; this.character = c; } },
        Range: class { constructor(a, b) { this.start = a; this.end = b; } },
        Selection: class { constructor(a, b) { this.anchor = a; this.active = b; this.start = a; this.end = b; } },
        ThemeColor: cls(), ThemeIcon: cls(), Diagnostic: cls(), CodeLens: cls(), Hover: cls(), FoldingRange: cls(),
        DocumentLink: cls(), Location: cls(), RelativePattern: cls(), DocumentSymbol: cls(), CompletionItem: cls(), SnippetString: cls(),
        MarkdownString: class { constructor(v) { this.value = v || ''; } appendMarkdown(v) { this.value += v; return this; } },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 }, StatusBarAlignment: { Left: 1, Right: 2 },
        DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
        OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
        TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
        CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => noDispose }; } cancel() {} dispose() {} },
        TextEdit: { replace: (r, t) => ({ range: r, newText: t }), insert: (p, t) => ({ position: p, newText: t }) },
        WorkspaceEdit: class { replace() {} insert() {} delete() {} },
        SymbolKind: {}, CompletionItemKind: {}, ProgressLocation: { Notification: 15, Window: 10 },
        extensions: { getExtension: () => undefined, all: [] },
        env: { clipboard: { readText: async () => '', writeText: async () => {} }, openExternal: async () => true },
        commands: { registerCommand: () => noDispose, executeCommand: async () => undefined, getCommands: async () => [] },
    });
    const fill = obj => new Proxy(obj, { get(t, k) {
        if (k in t) return t[k];
        if (typeof k === 'string' && /^(register|on[A-Z]|create)/.test(k)) return () => noDispose;
        return undefined;
    } });
    Object.assign(stub.window, { activeTextEditor: undefined, visibleTextEditors: [],
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        createTextEditorDecorationType: () => ({ dispose() {} }),
        withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
        tabGroups: { all: [], activeTabGroup: undefined, onDidChangeTabs: () => noDispose, onDidChangeTabGroups: () => noDispose } });
    Object.assign(stub.workspace, { textDocuments: [], workspaceFolders: [{ uri: { fsPath: DIR }, name: 'w', index: 0 }],
        getConfiguration: () => ({ get: (_k, d) => d, update: async () => {}, has: () => false, inspect: () => undefined }),
        openTextDocument: async () => ({ uri: { fsPath: ROOT }, getText: () => '', isDirty: false }), asRelativePath: p => p,
        fs: { readFile: async () => Buffer.from(''), writeFile: async () => {}, stat: async () => ({}) },
        createFileSystemWatcher: pattern => {
            const w = { pattern, change: [], onDidChange: fn => { w.change.push(fn); return noDispose; },
                onDidCreate: () => noDispose, onDidDelete: () => noDispose, dispose() {} };
            watchers.push(w); return w;
        } });
    stub.languages = fill({ createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }) });
    stub.window = fill(stub.window);
    stub.workspace = fill(stub.workspace);
    const origLoad = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? stub : origLoad.call(this, req, ...rest); };
    const renderUi = require(path.join(EXT, 'out/extension/tex/renderUi.js'));
    const { TexViewer } = require(path.join(EXT, 'out/extension/tex/texViewer.js'));
    const tex = require(path.join(EXT, 'out/extension/tex/index.js'));
    Module._load = origLoad;
    const scheduled = [];
    renderUi.RenderCoordinator.prototype.scheduleLive = function (doc) { scheduled.push(doc.uri.fsPath); };
    TexViewer.prototype.isOpen = () => true;
    TexViewer.prototype.preserveViewerLayoutAfterExternalChange = () => true;
    Object.defineProperty(TexViewer.prototype, 'root', { configurable: true, get: () => ROOT, set: () => {} });
    const memento = { get: () => undefined, update: async () => {} };
    tex.registerTexSupport({ subscriptions: [], extensionUri: { fsPath: EXT }, globalState: memento, workspaceState: memento,
        secrets: { get: async () => undefined, store: async () => {} } }, {});
    const watcher = watchers.find(w => String(w.pattern).includes('tex'));
    const fire = async file => {
        scheduled.length = 0;
        fs.appendFileSync(file, '% written outside VS Code\n');
        for (const fn of watcher.change) await fn({ fsPath: file, scheme: 'file', path: file });
        await new Promise(r => setTimeout(r, 10));
        return [...scheduled];
    };
    (async () => {
        const out = { files: { root: ROOT, child: CHILD } };
        out.root = await fire(ROOT);
        out.child = await fire(CHILD);
        out.other = await fire(OTHER);
        console.log(`BUG11 ${JSON.stringify(out)}`);
        try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* fine */ }
        process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
}

// ── #13 search misses must still land close ────────────────────────────────

/** A NativeMap over "ABC" typed at line 4, columns 0..2, ten points apart. */
function nativeMapFixture() {
    const root = path.join(os.tmpdir(), 'wpaper-bugs-native');
    const file = path.join(root, 'paper.tex');
    const SP = 65536;
    const location = column => ({ compiled_revision: 0, current_revision: 1,
        start: { line: 4, column_utf16: column }, end: { line: 4, column_utf16: column + 1 }, accuracy: 'Exact' });
    const hits = [0, 1, 2].map(i => ({ item_id: i, preferred_source: { file: 'paper.tex', location: location(i) },
        mapped_origins: [{ span: { tag: 1, line: 4, column: i, length: 1 }, source: { file: 'paper.tex', location: location(i) } }],
        box_path: [[8, { kind: 'Horizontal' }]],
        item: { page: 1, kind: 'Glyph', provenance: { definition: { line: 4 } }, glyph: { font: 1, code: 65 + i },
            geometry: { position: { x: i * 10 * SP, y: 20 * SP }, width: 8 * SP, height: 7 * SP, depth: 2 * SP } } }));
    const view = { generation: 2, sequence: 1, artifact: { page_count: 1, pdf_hash: 'paired' },
        pages: [{ page: 1, header: { magnification: 1000 }, hits }] };
    const source = { isCurrentView: v => v === view, forward: async () => ({ hits: [] }) };
    const map = new NativeMap({ generation: { pdfHash: 'paired', projectDir: root }, nativeView: view, nativeSource: source });
    return { map, file };
}

test('#13 a page click with no exact hit lands on the nearest glyph within a line height and an inch, flagged approximate', () => {
    const { map, file } = nativeMapFixture();
    const [first, second] = map.glyphsForLine(file, 4);
    const gap = map.renderToSource(1, second.x - 0.5, second.y + second.boxHeight / 2);
    assert.equal(gap.approximate, true, 'between two glyphs: the nearer one, flagged');
    assert.equal(gap.column, 1);
    assert.equal(map.renderToSource(1, first.x + first.w / 2, first.y - 3).column, 0, 'just above the line: still that line');
    assert.equal(map.renderToSource(1, first.x + first.w / 2, first.y - 40).flag, 'unmapped', 'two lines above: nowhere');
    assert.equal(map.renderToSource(1, second.x + second.w + 90, second.y + 2).flag, 'unmapped', 'more than an inch along: nowhere');
});

test('#13 a cursor on text that prints nothing lights the nearest printed glyph, labelled as such', async () => {
    const { map, file } = nativeMapFixture();
    const near = await map.forwardAt(file, 4, 2);          // the worker has no hit for column 2
    assert.equal(near.length, 1);
    assert.equal(near[0].approximate, true);
    assert.equal(near[0].x, map.glyphsForLine(file, 4)[2].x);
    assert.deepEqual(await map.forwardAt(file, 9, 0), [], 'nothing printed within two lines: nothing');
    // The viewer says so instead of claiming an exact answer.
    const f = nativeCursorFixture({ text: 'a\nb\nc\nABC\n', anchor: [3, 2] });
    f.map.forwardAt = async () => near;
    await f.run();
    const h = f.posts.filter(p => p.type === 'highlight').at(-1);
    assert.equal(h.exact, false);
    assert.match(h.label, /nearest printed text to line 4/);
});

// ── #19 WPaper silently uses the old engine though WLaTeX is installed ──────

test('#19 with mapEngine=wlatex and an installed runtime the paper builds on the WLaTeX lane and the badge reads live', async () => {
    const f = coordinatorFixture();
    const before = { lane: lane.compiles, latexmk: conventional.calls };
    try {
        await f.coordinator.build(f.doc, { live: true, quiet: true });
        assert.equal(lane.compiles, before.lane + 1, 'built by WLaTeX');
        assert.equal(conventional.calls, before.latexmk, 'not by the old engine');
        assert.equal(f.state.generation.runner, 'wlatex');
        const posts = [];
        const viewer = { coord: f.coordinator, context: { globalState: { get: () => true } }, _post: m => posts.push(m) };
        // Typing: the live preview is newer than the last key.
        Object.assign(f.state, { sourceAhead: true, lastEditAt: 10, livePreviewAt: 20 });
        TexViewer.prototype._postEngine.call(viewer, f.state);
        assert.equal(posts.at(-1).state, 'live');
    } finally { f.close(); }
});

test('#19 when WPaper falls back to its own compiler it says why', async () => {
    const f = coordinatorFixture();
    lane.installed = false;
    const shown = warnings.length;
    try {
        await f.coordinator.build(f.doc, { quiet: true });
        assert.match(f.state.nativeUnavailable, /WLaTeX unavailable: runtime missing\. Using the normal WPaper compiler/);
        assert.ok(f.log.some(l => /WLaTeX unavailable: runtime missing/.test(l)), 'in the output channel');
        assert.ok(warnings.slice(shown).some(w => /WLaTeX unavailable: runtime missing/.test(w.message)), 'and in a notification');
    } finally { lane.installed = true; f.close(); }
});

// ── #23 Pro: an editor cursor move no longer scrolls the viewer or draws the caret

test('#23 on the native lane an editor cursor move scrolls to the word and draws the red caret in it', async () => {
    const text = 'x\nWe write the wavefunction here.\n';
    const col = text.split('\n')[1].indexOf('wavefunction');
    const glyphs = {};
    for (let i = 0; i < 12; i++) glyphs[`2:${col + i}`] = { page: 3, x: 100 + 5 * i, y: 200, w: 5, h: 9 };
    for (const sourceAhead of [false, true]) {      // after the first build, and after an edit
        const f = nativeCursorFixture({ text, anchor: [1, col + 4], glyphs, sourceAhead,
            range: Array.from({ length: 12 }, (_, i) => glyphs[`2:${col + i}`]) });
        await f.run();
        const h = f.posts.filter(p => p.type === 'highlight').at(-1);
        assert.equal(h.reveal, true, 'the viewer scrolls to it');
        assert.equal(h.rects.length, 12, 'the word is washed');
        assert.deepEqual(h.caret, { page: 3, x: 120, y: 200, h: 9, at: 'inside', offset: 4 }, 'the red caret before the 5th letter');
    }
});

test('#23 the cursor keeps tracing on the native lane while the source is ahead of the page', async () => {
    const st = { map: { native: true, available: true }, sourceAhead: true, nativeLane: {} };
    let traced = 0;
    const viewer = { panel: {}, root: PAPER, followCursor: true, _tracePaused: true,
        coord: { stateFor: () => st, roots: new Map([[PAPER, st]]) }, _post() {},
        _noteEditorNavigation() {}, _rememberCursor() {}, _syncNativeCursor: async () => { traced++; } };
    const doc = textDoc(PAPER, 'abc');
    TexViewer.prototype.syncFromEditor.call(viewer, { document: doc, selection: new Selection(new Position(0, 1), new Position(0, 1)) }, { userCursorGesture: true });
    assert.equal(traced, 1, 'the native map answers; the stale-page pause does not swallow the move');
});

// ── #24 Pro: a left click opens the card, its caret not at the click ────────

const EQ_DOC = ['\\documentclass{article}', '\\begin{document}', 'Text before.', '\\begin{equation}', '  a + \\hat{b} = c', '\\end{equation}', '\\end{document}'].join('\n');
const EQ_LINE = 5, EQ_COL = EQ_DOC.split('\n')[4].indexOf('\\hat');

test('#24 a left click in an equation only moves the cursor; it does not open the card', async () => {
    const f = nativeClickFixture({ text: EQ_DOC, line: EQ_LINE, column: EQ_COL });
    let opened = 0;
    Object.assign(f.viewer, { _inkEnabled: () => true, _inkPlace: () => false, _inkClear() {},
        _openEditSession: async () => { opened++; } });
    await f.leftClick();
    assert.equal(f.editor.selection.start.line, EQ_LINE - 1);
    assert.equal(f.editor.selection.start.character, EQ_COL, 'the cursor moved to the clicked symbol');
    await new Promise(r => setImmediate(r));
    assert.equal(opened, 0, 'no card on a left click');
});

test('#24 a right-click opens the card with its caret at the clicked symbol', async () => {
    const f = nativeClickFixture({ text: EQ_DOC, line: EQ_LINE, column: EQ_COL });
    f.viewer._blockAt = () => ({ startLine: 4, endLine: 6, label: 'equation' });
    const s = await f.rightClick();
    assert.ok(s, 'a card opened');
    const open = f.posts.find(p => p.type === 'editOpen');
    const blockStart = f.doc.offsetAt(new Position(3, 0));
    const at = f.doc.offsetAt(new Position(EQ_LINE - 1, EQ_COL)) - blockStart;
    assert.equal(open.text.slice(at, at + 4), '\\hat');
    assert.equal(open.caretStart, at, 'the card\'s caret is at the clicked symbol, not the block start');
    assert.equal(open.caretEnd, at);
});

// ── #26 Pro: live typing fights the old "updating from editor" pause ────────

/** A viewer on PAPER for noteSourceChanged / _setTracePaused. */
function traceViewer({ proDisabled = false, native = true } = {}) {
    const posts = [];
    const st = { root: PAPER, map: { native, available: true }, nativeLane: native ? {} : null, compiling: false };
    const viewer = Object.create(TexViewer.prototype);
    Object.assign(viewer, { panel: {}, root: PAPER, _post: m => posts.push(m),
        coord: { rootFor: () => PAPER, roots: new Map([[PAPER, st]]), proDisabled } });
    return { viewer, posts, st };
}

test('#26 on the live lane typing never raises the "updating from editor" pause', () => {
    const { viewer, posts } = traceViewer();
    const doc = textDoc(PAPER, 'abc');
    for (let i = 0; i < 5; i++) { doc.set(`abc${i}`); assert.equal(viewer.noteSourceChanged(doc), true); }
    assert.ok(!posts.some(p => p.type === 'traceState' && p.paused), 'no pause shown while the live lane keeps up');
    assert.equal(viewer._tracePaused, false, 'and the caret is not blanked');
    // The same keys without the live lane (Pro off) still pause, as before Pro.
    const off = traceViewer({ proDisabled: true });
    off.viewer.noteSourceChanged(doc);
    assert.ok(off.posts.some(p => p.type === 'traceState' && p.paused && p.source === 'editor'));
});

// ── #27 with Pro off, WPaper equals the pre-Pro release ─────────────────────

test('#27 with Pro switched off the paper builds with the ordinary compiler and the lane is retired', async () => {
    const f = coordinatorFixture();
    try {
        await f.coordinator.build(f.doc, { live: true, quiet: true });
        const oldLane = f.state.nativeLane;
        assert.ok(oldLane, 'on the WLaTeX lane first');
        f.coordinator.proDisabled = true;
        const before = { lane: lane.compiles, latexmk: conventional.calls };
        fs.appendFileSync(f.root, '% typed\n');
        await f.coordinator.build(f.doc, { live: true, quiet: true });
        assert.equal(lane.compiles, before.lane, 'WLaTeX is not asked');
        assert.equal(conventional.calls, before.latexmk + 1, 'the ordinary compiler builds it');
        assert.equal(oldLane.closed, true, 'the WLaTeX worker is closed');
        assert.equal(f.state.nativeLane, null);
        const posts = [];
        TexViewer.prototype._postEngine.call({ coord: f.coordinator, _post: m => posts.push(m) }, f.state);
        assert.equal(posts.at(-1).state, 'disabled', 'the badge is grey');
    } finally { f.close(); }
});

test('#27 without Pro the section drag, figure move, image drop and page formats do nothing', async () => {
    for (const pro of [false, true]) {
        const { viewer } = traceViewer({ proDisabled: !pro });
        const did = [];
        Object.assign(viewer, { _tourObserve() {}, _sectionMove: async () => did.push('section'),
            _figureMove: async () => did.push('figure'), _imageDrop: async () => did.push('image') });
        for (const type of ['sectionMove', 'figureMove', 'imageDrop']) await viewer._onMessage({ type });
        const doc = textDoc(PAPER, 'some words here');
        const range = new Range(new Position(0, 5), new Position(0, 10));
        Object.assign(viewer, { _selectionTarget: async () => ({ doc, range, sel: { file: PAPER } }),
            _applyReaderEdit: async () => { did.push('format'); return true; }, _afterSelectionEdit() {} });
        await viewer._selectionAction({ action: 'bold' });
        assert.deepEqual(did, pro ? ['section', 'figure', 'image', 'format'] : [], pro ? 'with Pro they run' : 'without Pro nothing edits the paper');
    }
});

test('#27 without the native map a right-click jumps to the source even where no card opens', async () => {
    const { viewer } = traceViewer({ proDisabled: true, native: false });
    let jumped = 0;
    Object.assign(viewer, { _tourObserve() {}, _openEditSession: async () => undefined, _jumpToSource: async () => { jumped++; } });
    await viewer._onMessage({ type: 'editHere', page: 1, xBp: 10, yTopBp: 10 });
    assert.equal(jumped, 1);
});

test('#27 the Pro badge switch is kept across sessions', async () => {
    const saved = new Map();
    const globalState = { get: k => saved.get(k), update: async (k, v) => { saved.set(k, v); } };
    const { viewer } = traceViewer();
    Object.assign(viewer, { root: null, context: { globalState }, _tourObserve() {}, _log() {}, _postEngine() {} });
    await viewer._onMessage({ type: 'proToggle' });
    assert.equal(viewer.coord.proDisabled, true);
    assert.equal(saved.get('wpaper.pro.disabled'), true);
    const coord = { roots: new Map(), rootFor: () => null };
    new TexViewer({ extensionUri: { fsPath: '/ext' }, globalState }, coord, { get: () => ({ model: null }) });
    assert.equal(coord.proDisabled, true, 'a new window starts with Pro off');
});

// ── #31 the typing caret is misplaced after space, text, Backspace ──────────

/** Glyph entries for "ab cd" on line 5, one row: a b _ c d, five points wide. */
const inkGlyphs = [[0, 10], [1, 15], [3, 25], [4, 30]].map(([col, x]) => ({ page: 2, row: 7, x, y: 100, w: 5, boxHeight: 10,
    hit: { preferred_source: { location: { accuracy: 'Exact', start: { line: 5, column_utf16: col }, end: { line: 5, column_utf16: col + 1 } } } } }));

test('#31 after a space the typing caret sits one space past the word, and Backspace returns it there', () => {
    let text = 'ab cd', caret = 5;
    const key = k => { const e = keyEdit(text, caret, k);
        if (e.insert !== undefined) text = text.slice(0, e.start) + e.insert + text.slice(e.end); caret = e.caret; };
    assert.equal(caretAt(inkGlyphs, 5, caret, text).x, 35, 'at the end of "cd"');
    key(' ');
    assert.equal(caretAt(inkGlyphs, 5, caret, text).x, 40, 'one interword space (5 pt, measured on this row) past the word');
    key('x'); key('Backspace');
    assert.equal(text, 'ab cd ');
    assert.equal(caretAt(inkGlyphs, 5, caret, text).x, 40, 'back after the space, not glued to the word');
});

test('#31 the typing caret waits for the live page\'s map instead of jumping to the settled PDF\'s', async () => {
    const doc = textDoc(PAPER, 'x\nx\nx\nx\nab cd more');
    const posts = [];
    const st = { map: { available: true, glyphsForLine: () => inkGlyphs }, sourceAhead: true };
    const viewer = Object.create(TexViewer.prototype);
    Object.assign(viewer, { panel: {}, root: PAPER, coord: { roots: new Map([[PAPER, st]]) }, _post: m => posts.push(m),
        _ink: { root: PAPER, file: PAPER, offset: doc.offsetAt(new Position(4, 6)), version: doc.version, caret: { page: 2, x: 1, y: 1, h: 1 } } });
    const savedDocs = stub.workspace.textDocuments;
    stub.workspace.textDocuments = [doc];
    try {
        await viewer._inkRefresh();
        assert.equal(posts.length, 0, 'the page is behind: the settled map is not asked');
        st.sourceAhead = false;
        await viewer._inkRefresh();
        assert.equal(posts.at(-1).type, 'inkCaret');
        assert.equal(posts.at(-1).x, 40, 'once current, one space past "cd"');
    } finally { stub.workspace.textDocuments = savedDocs; }
});

// ── #32 the TikZ editor does not open on figures ────────────────────────────

const TIKZ_DOC = ['\\documentclass{article}', '\\usepackage{tikz}', '\\begin{document}', 'Text.',
    '\\begin{figure}', '\\centering', '\\begin{tikzpicture}[scale=0.5]', '  \\draw[red] (0,0) -- (2,1);',
    '  \\node (a) at (1,1) {label};', '\\end{tikzpicture}', '\\caption{A picture.}', '\\end{figure}', '\\end{document}'].join('\n');

test('#32 a statement inside a picture resolves to its enclosing \\begin{tikzpicture}', () => {
    const enclosingPicture = viewerFunction('enclosingPicture');
    const begin = TIKZ_DOC.indexOf('\\begin{tikzpicture}');
    assert.equal(enclosingPicture(TIKZ_DOC, TIKZ_DOC.indexOf('\\node')), begin);
    assert.equal(enclosingPicture(TIKZ_DOC, TIKZ_DOC.indexOf('{label}') + 2), begin, 'a node label');
    assert.equal(enclosingPicture(TIKZ_DOC, TIKZ_DOC.indexOf('\\caption')), null, 'the caption is outside it');
    const nested = 'A\\begin{tikzpicture}X\\begin{tikzpicture}Y\\end{tikzpicture}Q\\end{tikzpicture}B';
    assert.equal(enclosingPicture(nested, nested.indexOf('Y')), nested.indexOf('\\begin', 5), 'inside the nested picture: it');
    assert.equal(enclosingPicture(nested, nested.indexOf('Q')), 1, 'past a nested picture: the outer one');
    assert.equal(enclosingPicture(nested, nested.indexOf('B')), null);
});

test('#32 the engine names the picture by a \\node inside it, and the TikZ editor still gets its paths', async () => {
    const root = PAPER;
    const doc = textDoc(root, TIKZ_DOC);
    const pos = off => { const p = doc.positionAt(off); return { line: p.line + 1, column_utf16: p.character }; };
    const node = TIKZ_DOC.indexOf('\\node'), draw = TIKZ_DOC.indexOf('\\draw');
    // Picture 7's first mark was drawn by the \node; special 17 by the \draw.
    const tikzLane = { liveSpecials: async (page, keys) => keys.map(k => ({ definition: null,
        invocation: { file: root, location: { start: pos(k === 17 ? draw + 6 : node), end: pos(node + 5) } } })) };
    const posts = [];
    const viewer = Object.create(TexViewer.prototype);
    Object.assign(viewer, { root, panel: {}, coord: { roots: new Map([[root, { nativeLane: tikzLane }]]) }, _post: m => posts.push(m) });
    const savedDocs = stub.workspace.textDocuments;
    stub.workspace.textDocuments = [doc];
    try {
        await viewer._tikzResolve({ key: 'k', page: 1, specials: [17], pictures: [7] });
    } finally { stub.workspace.textDocuments = savedDocs; }
    const reply = posts.pop();
    assert.equal(reply.error, null);
    const pic = reply.pictures[7];
    assert.ok(pic, 'the picture was parsed');
    assert.equal(pic.begin, TIKZ_DOC.indexOf('\\begin{tikzpicture}'));
    assert.deepEqual(pic.statements.map(s => s.kind), ['draw', 'node']);
    assert.deepEqual(reply.paths[17], { picture: 7, stmt: pic.statements[0].start }, 'the path is matched');
});

test('#32 a right-click on a node label inside a figure\'s picture opens the TikZ editor (Pro only)', async () => {
    const line = TIKZ_DOC.split('\n').findIndex(l => l.includes('{label}')) + 1;
    for (const pro of [true, false]) {
        const f = nativeClickFixture({ text: TIKZ_DOC, line, column: TIKZ_DOC.split('\n')[line - 1].indexOf('label') });
        f.viewer.coord.proDisabled = !pro;
        f.viewer._modelFor = () => buildModel(scanTex(TIKZ_DOC), { file: PAPER });
        await f.rightClick({ page: 2, xBp: 150, yTopBp: 300 });
        const tikz = f.posts.find(p => p.type === 'tikzOpenAt');
        if (pro) assert.deepEqual(tikz, { type: 'tikzOpenAt', page: 2, xBp: 150, yTopBp: 300 });
        else {
            assert.equal(tikz, undefined, 'without Pro: no TikZ editor');
            assert.ok(f.posts.some(p => p.type === 'editOpen'), 'the text card, as before Pro');
        }
    }
});

// ── #33 the table editor takes seconds to open, with no UI indication ───────

test('#33 a right-click just after a keystroke re-reads the map and opens the card instead of being dropped', async () => {
    const f = nativeClickFixture({ text: EQ_DOC, line: EQ_LINE, column: EQ_COL });
    f.viewer._blockAt = () => ({ startLine: 4, endLine: 6, label: 'equation' });
    f.map.available = false;                      // typing invalidated the cold map
    let reads = 0;
    f.viewer.coord.ensureNativeMap = async st => { reads++; st.map.available = true; };
    const s = await f.rightClick();
    assert.equal(reads, 1, 'the map is read now');
    assert.ok(s && f.posts.some(p => p.type === 'editOpen'), 'and the card opens');
});

test('#33 when the card cannot open yet, the reason is shown', async () => {
    const f = nativeClickFixture({ text: EQ_DOC, line: EQ_LINE, column: EQ_COL });
    f.map.available = false;
    f.viewer.coord.ensureNativeMap = async () => {};   // still re-reading
    assert.equal(await f.rightClick(), undefined);
    const status = f.posts.find(p => p.type === 'status');
    assert.ok(status, 'not silent');
    assert.match(status.text, /still updating — right-click again/);
});

// ── #34 an unnecessary full recompile freezes the viewer and editor ─────────

// The "full recompile" is WLaTeX's own settle build (a separate process; the
// user's logs show no latexmk). The freeze was this thread re-reading the
// source map around it: once after the pause, again while the settle build
// ran (thrown away when it landed). A re-read now waits for a running build,
// and runs afterwards only if the map is still behind.
test('#34 a source-map re-read waits while a build runs, and is skipped when the build left a current map', async () => {
    const runs = [];
    const map = { native: true, available: false, hasPage: () => true };
    const st = { compiling: true, map, lastEditAt: 0, lastInkAt: 0 };
    const coord = Object.create(RenderCoordinator.prototype);
    coord._runNativeRefresh = async () => { runs.push(Date.now()); };
    coord._nativeWindow = () => [1, 2];
    const lane = { interactive: true };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    coord._scheduleNativeRefresh(st, lane, 0);
    await sleep(150);
    assert.equal(runs.length, 0, 'no map read while the build compiles');
    // The build lands with a current map: nothing to read.
    map.available = true; st.compiling = false;
    await sleep(700);
    assert.equal(runs.length, 0, 'the build installed a current map; the re-read is skipped');
    // A build that left the map behind (failed / superseded): the read runs.
    map.available = false;
    coord._scheduleNativeRefresh(st, lane, 0);
    await sleep(100);
    assert.equal(runs.length, 1, 'the map is re-read once no build is running and it is still behind');
    clearTimeout(st.nativeRefreshTimer);
});

// ── #36 the range selection is drawn wrongly ────────────────────────────────

// "a \dot Z, b" on line 2, baseline 109 (cmr10-like boxes): the raised dot is
// the highest box and sits over the middle of Z; the comma is the lowest.
const DOT_LINE = 'Let a \\dot Z, b hold.';
const DOT = { a: { page: 1, x: 10, y: 104.7, w: 5, h: 4.3 }, dot: { page: 1, x: 32, y: 99.8, w: 2, h: 6.7 },
    Z: { page: 1, x: 30, y: 102.2, w: 6, h: 6.8 }, comma: { page: 1, x: 37, y: 108, w: 2, h: 3 }, b: { page: 1, x: 45, y: 102.1, w: 5, h: 6.9 } };
const dotSelection = glyphs => nativeCursorFixture({ text: `x\n${DOT_LINE}\n`, anchor: [1, DOT_LINE.indexOf('a ')],
    active: [1, DOT_LINE.indexOf('b ') + 1], glyphs,
    // forwardRange's order: by page, then top, then left.
    range: [DOT.dot, DOT.b, DOT.Z, DOT.a, DOT.comma] });

test('#36 selection brackets sit at the glyphs of the first and last selected characters, not the extreme boxes', async () => {
    const f = dotSelection({ [`2:${DOT_LINE.indexOf('a ')}`]: DOT.a, [`2:${DOT_LINE.indexOf('b ')}`]: DOT.b });
    await f.run();
    const sel = f.posts.find(p => p.type === 'selection' && p.span);
    assert.deepEqual(sel.span.start.exactEdge, { page: 1, x: 10, y: 104.7, h: 4.3 }, 'left of "a", not on the dot of \\dot Z');
    assert.deepEqual(sel.span.end.exactEdge, { page: 1, x: 50, y: 102.1, h: 6.9 }, 'right of "b", not after the comma');
});

test('#36 without the end glyphs, brackets take the ends of the first and last printed lines', async () => {
    const f = dotSelection({});                     // the worker names no glyph for either end
    await f.run();
    const sel = f.posts.find(p => p.type === 'selection' && p.span);
    assert.equal(sel.span.start.exactEdge.x, 10, 'the leftmost box of the line the accent and comma belong to');
    assert.equal(sel.span.end.exactEdge.x, 50, 'the rightmost');
    assert.equal(sel.span.start.exactEdge.y, 99.8, 'one line, from the accent\'s top ...');
    assert.ok(Math.abs(sel.span.start.exactEdge.h - 11.2) < 1e-9, '... to the comma\'s bottom');
});

// ── #37 no red caret on some symbols ────────────────────────────────────────

test('#37 the red caret is drawn on maths symbols: before the glyph printed at the cursor', async () => {
    const line = 'Then $(a)^{2} + \\hat{b}$ holds.';
    for (const [at, glyph] of [[line.indexOf('\\hat'), { page: 1, x: 70, y: 100, w: 5, h: 9 }],
        [line.indexOf('^'), { page: 1, x: 40, y: 96, w: 4, h: 6 }]]) {
        const f = nativeCursorFixture({ text: `x\n${line}\n`, anchor: [1, at], glyphs: { [`2:${at}`]: glyph } });
        await f.run();
        const h = f.posts.filter(p => p.type === 'highlight').at(-1);
        assert.ok(h.caret, `a caret at ${JSON.stringify(line[at])}`);
        assert.deepEqual([h.caret.x, h.caret.at], [glyph.x, 'before']);
    }
});

test('#37 ... else after the glyph printed before it', async () => {
    const line = 'Then $(a) + b$ holds.';
    const at = line.indexOf(') ') + 1;          // the space after ")": prints nothing of its own
    const paren = { page: 1, x: 50, y: 100, w: 3, h: 9 };
    const f = nativeCursorFixture({ text: `x\n${line}\n`, anchor: [1, at], glyphs: { [`2:${at}`]: paren, [`2:${at - 1}`]: paren } });
    await f.run();
    const h = f.posts.filter(p => p.type === 'highlight').at(-1);
    assert.deepEqual([h.caret.x, h.caret.at], [53, 'after']);
});

// ── #39 the viewer stuck on "starting…" ─────────────────────────────────────
// VS Code could not read the panel's script (the extension was being updated
// under a reloading window): no `ready`, and every PDF went nowhere.
test('#39 a panel that never says ready is loaded again, twice at most, then the reader is told', async () => {
    const saved = TexViewer.READY_TIMEOUT_MS;
    TexViewer.READY_TIMEOUT_MS = 15;
    const warnings = [];
    const savedWarn = stub.window.showWarningMessage;
    stub.window.showWarningMessage = (m) => { warnings.push(m); return Promise.resolve(undefined); };
    try {
        let loads = 0;
        const panel = { visible: true, webview: { set html(_) { loads++; } } };
        const viewer = Object.create(TexViewer.prototype);
        Object.assign(viewer, { panel, _html: () => '<html>', _log() {} });
        viewer._armReadyWatchdog(panel, 0);
        await new Promise(r => setTimeout(r, 120));
        assert.equal(loads, 2, 'reloaded twice');
        assert.equal(warnings.length, 1, 'then the reader is told');
        // A panel that answers is left alone.
        loads = 0;
        viewer._armReadyWatchdog(panel, 0);
        viewer._webviewReady = true;
        await new Promise(r => setTimeout(r, 60));
        assert.equal(loads, 0, 'a ready panel is not reloaded');
        // A hidden panel is waited for, not reloaded.
        const hidden = { visible: false, webview: { set html(_) { loads++; } } };
        viewer.panel = hidden;
        viewer._armReadyWatchdog(hidden, 0);
        await new Promise(r => setTimeout(r, 60));
        assert.equal(loads, 0, 'a hidden panel is not reloaded');
        viewer.panel = null;
        clearTimeout(viewer._readyWatchdog);
    } finally { TexViewer.READY_TIMEOUT_MS = saved; stub.window.showWarningMessage = savedWarn; }
});

// ── #41 folding: the count took the whole rebuild to appear ─────────────────
test('#41 a folded section keeps its place while the map is behind, so its chip and count show at once', () => {
    const file = '/p/paper.tex';
    const text = ['\\documentclass{article}', '\\begin{document}', '\\section{Intro}', 'Body line.', '\\end{document}'].join('\n');
    const map = { available: true, lineRows: (f, line) => (map.available && line === 3 ? [{ page: 2, x: 72, y: 100, w: 60, h: 10 }] : []),
        rangeRows: () => [] };
    const st = { map };
    const viewer = Object.create(TexViewer.prototype);
    Object.assign(viewer, {
        _projectModels: () => new Map([[file, { objects: [{ kind: 'section-heading', cmd: 'section', level: 1, title: 'Intro',
            stableKey: 'intro', sourceRange: { startLine: 3, endLine: 3 } }] }]]),
        _textOf: () => text,
    });
    const first = viewer._sectionControls(st).find(i => i.key === 'intro');
    assert.equal(first.page, 2);
    map.available = false;          // an edit (the fold itself) invalidated the map
    const again = viewer._sectionControls(st).find(i => i.key === 'intro');
    assert.ok(again, 'the section is still offered');
    assert.equal(again.page, 2, 'at the place it last had');
    assert.equal(again.x, 72);
});

// ── #43 the card follows its block while typing adds lines ──────────────────
test('#43 a live page near the card re-measures its block and moves it (one page read, not the whole map)', async () => {
    const SP = 65536, file = path.join(os.tmpdir(), 'wpaper-follow', 'paper.tex');
    const text = 'x\nFirst line of the block\nsecond line\n';
    const hit = (id, line, y) => ({ item_id: id, preferred_source: { file: 'paper.tex', location: { start: { line, column_utf16: 0 }, end: { line, column_utf16: 1 }, accuracy: 'Exact' } },
        mapped_origins: [{ source: { file: 'paper.tex', location: { start: { line, column_utf16: 0 }, end: { line, column_utf16: 1 }, accuracy: 'Exact' } } }],
        box_path: [[id, { kind: 'Horizontal' }]],
        item: { page: 3, kind: 'Glyph', glyph: { font: 1, code: 65 }, geometry: { position: { x: 10 * SP, y: y * SP }, width: 8 * SP, height: 7 * SP, depth: 2 * SP } } });
    // The live page: the block (lines 2–3) now prints a third row.
    const view = { live: true, pages: [{ page: 3, header: { magnification: 1000 }, hits: [hit(1, 2, 20), hit(2, 3, 32), hit(3, 3, 44)] }] };
    const reads = [];
    const lane = { projectDir: path.dirname(file), source: { isCurrentView: v => v === view }, liveView: async pages => { reads.push(pages); return view; } };
    const posts = [];
    const viewer = Object.create(TexViewer.prototype);
    Object.assign(viewer, { _post: m => posts.push(m), _liveMapReady: new Map([[3, 'h3'], [9, 'h9']]), _liveOverlays: new Map([[3, 'h3'], [9, 'h9']]),
        _editRectsLast: [{ page: 3, x: 10, y: 20, w: 8, h: 9 }],
        _edit: { id: 7, file, startOffset: 2, endOffset: text.length - 1 } });
    const saved = stub.workspace.openTextDocument;
    stub.workspace.openTextDocument = async () => ({ positionAt: off => { const before = text.slice(0, off).split('\n'); return { line: before.length - 1, character: before.at(-1).length }; } });
    try { await viewer._editFollowLiveNow(lane); } finally { stub.workspace.openTextDocument = saved; }
    assert.deepEqual(reads, [[3]], 'only the page near the card is read');
    const a = posts.find(p => p.type === 'editAnchor');
    assert.ok(a && a.live && a.editId === 7, 'a live anchor for the card');
    assert.equal(a.rects.length, 3, 'the block\'s three printed rows, the new one included');
});

// ── #44 the Pro red caret lagged behind the classic one ─────────────────────
test('#44 a caret move in text is answered from the map in memory: no worker round trip, word and red caret at once', async () => {
    const SP = 65536, root = path.join(os.tmpdir(), 'wpaper-fastcaret'), file = path.join(root, 'paper.tex');
    const text = 'Line one\nAlpha beta gamma\n';
    // "beta" is columns 6..10 on line 2; one glyph per letter.
    const glyph = (id, col) => ({ item_id: id, preferred_source: { file: 'paper.tex', location: { start: { line: 2, column_utf16: col }, end: { line: 2, column_utf16: col + 1 }, accuracy: 'Exact' } },
        mapped_origins: [{ source: { file: 'paper.tex', location: { start: { line: 2, column_utf16: col }, end: { line: 2, column_utf16: col + 1 }, accuracy: 'Exact' } } }],
        box_path: [[1, { kind: 'Horizontal' }]],
        item: { page: 1, kind: 'Glyph', glyph: { font: 1, code: 65 }, geometry: { position: { x: (10 + 5 * col) * SP, y: 40 * SP }, width: 5 * SP, height: 7 * SP, depth: 2 * SP } } });
    const view = { generation: 1, sequence: 1, artifact: { page_count: 1, pdf_hash: 'h' },
        pages: [{ page: 1, header: { magnification: 1000 }, hits: [...'Alpha beta gamma'].map((c, i) => c === ' ' ? null : glyph(i + 1, i)).filter(Boolean) }] };
    let workerCalls = 0;
    const source = { isCurrentView: v => v === view, forward: async () => { workerCalls++; return { hits: [] }; } };
    const map = new NativeMap({ generation: { pdfHash: 'h', projectDir: root }, nativeView: view, nativeSource: source });
    const st = { map, root };
    const posts = [];
    const doc = { uri: { fsPath: file }, version: 1, lineAt: n => ({ text: text.split('\n')[n] }) };
    const at = { line: 1, character: 8 };            // inside "beta", after "be"
    const editor = { document: doc, selection: { start: at, end: at, active: at } };
    const viewer = { panel: {}, followCursor: true, root, _openedPdfHash: 'h', _nativeCursorRequest: 1,
        coord: { stateFor: () => st }, _post: m => posts.push(m), _setTracePaused() {}, _mayScroll: () => true, _invertedAt: 0, _log() {} };
    await TexViewer.prototype._syncNativeCursor.call(viewer, st, editor, {}, 1);
    assert.equal(workerCalls, 0, 'no worker round trip');
    const h = posts.find(p => p.type === 'highlight' && p.rects?.length);
    assert.ok(h, 'a highlight');
    assert.equal(h.rects.length, 4, 'the word "beta"');
    assert.ok(h.caret && h.caret.at === 'inside' && h.caret.offset === 2, `the red caret two letters in (${JSON.stringify(h.caret)})`);
    assert.ok(!posts.some(p => p.type === 'highlight' && !p.rects?.length), 'no blank frame before it');
});

test('#44 the editor echo of a mini-editor caret move does not answer it a second time', () => {
    const viewer = { _cardEcho: { file: '/p/a.tex', line: 3, ch: 7, at: Date.now() }, _nativeCursorRequest: 5, panel: null };
    const editor = { document: { uri: { fsPath: '/p/a.tex' } }, selection: { active: { line: 3, character: 7 } } };
    TexViewer.prototype.syncFromEditor.call(viewer, editor, {});
    assert.equal(viewer._nativeCursorRequest, 5, 'the echo neither supersedes the card\'s own sync nor starts another');
    assert.equal(viewer._cardEcho, null);
    TexViewer.prototype.syncFromEditor.call(viewer, editor, {});
    assert.equal(viewer._nativeCursorRequest, 6, 'a later, real move is answered');
});
