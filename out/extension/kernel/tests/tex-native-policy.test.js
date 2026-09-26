const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { makeVscodeStub } = require('./_stub-vscode');
const stub = makeVscodeStub();
stub.workspace.textDocuments = [];
let configuredMapEngine = 'wlatex';
let configuredTimeout = 180000;
const observedTimeouts = [], observedEngines = [], notices = [], warnings = [];
stub.window.showInformationMessage = async message => { notices.push(message); };
// The writer's answer to "preview with WLaTeX anyway?" (undefined: dismissed).
let warningPick;
stub.window.showWarningMessage = async (message, ...choices) => { warnings.push({ message, choices }); return warningPick; };
// A line/column range, installed by the tests that edit (others install theirs).
class EditRange { constructor(l0, c0, l1, c1) { Object.assign(this, { l0, c0, l1, c1 }); } }
stub.WorkspaceEdit = class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } };
const docOf = file => { const lines = () => fs.readFileSync(file, 'utf8').split('\n');
    return { uri: { fsPath: file }, get lineCount() { return lines().length; }, lineAt: n => ({ text: lines()[n] }) }; };
stub.workspace.openTextDocument = async file => docOf(file);
stub.workspace.applyEdit = async edit => {
    for (const { uri, range, text } of edit.edits) {
        const lines = fs.readFileSync(uri.fsPath, 'utf8').split('\n');
        lines[range.l0] = lines[range.l0].slice(0, range.c0) + text + lines[range.l0].slice(range.c1);
        fs.writeFileSync(uri.fsPath, lines.join('\n'));
    }
    return true;
};
let installed = true, constructorCalls = 0;
stub.workspace.getConfiguration = () => ({ get: (key, fallback) =>
    ({ compileTimeoutMs:configuredTimeout, mapEngine: configuredMapEngine, wlatexDirectory: '/built/wlatex', authoritativeDelayMs: 0 })[key] ?? fallback });
let nativeCalls = 0, conventionalCalls = 0, cancel = false, nativeFailure = false, nativeSettled = false, nativeDocumentError = false;
const oldLoad = Module._load;
Module._load = function (req, ...args) {
    if (req === 'vscode') return stub;
    if (req === './nativeCompileService') return { NativeBuildLane: class {
        constructor() { constructorCalls++; if (!installed) throw Error('runtime missing'); this.directory = '/built/wlatex'; }
        async compile(o) {
            nativeCalls++;
            observedTimeouts.push(['native', o.timeoutMs]);
            if (nativeFailure) throw Error('runtime cannot start');
            if (cancel) throw Object.assign(Error('superseded'), { name: 'AbortError' });
            if (nativeDocumentError) return { ok:false, runner:'wlatex', generation:nativeCalls, pdfPath:null,
                sourceSnapshotHash:o.sourceSnapshotHash, nativeCompiledSources:new Map(), errors:1, warnings:0,
                diagnostics:[{ severity:'error', message:'Undefined control sequence \\pdfoutput' }] };
            return { ok:true, runner:'wlatex', generation:nativeCalls, pdfPath:'unused', pdfHash:'native',
                sourceSnapshotHash:o.sourceSnapshotHash, nativeCompiledSources:new Map(),
                pageCount:1, rerunWanted:!nativeSettled, diagnostics:[] };
        }
        invalidate() { this.invalidated = true; }
        async close() {}
    } };
    const result = oldLoad.call(this, req, ...args);
    if (req === './compileService') return { ...result,
        loadGeneration: () => null, saveGeneration: () => false,
        compile: async o => { conventionalCalls++; observedTimeouts.push(['conventional', o.timeoutMs]); observedEngines.push(o.engine); return { ok:true, generation:100,
            pdfPath:'unused', sourceSnapshotHash:o.sourceSnapshotHash, pageCount:1, diagnostics:[] }; } };
    return result;
};
let RenderCoordinator, TexViewer;
try {
    ({ RenderCoordinator } = require('../../tex/renderUi'));
    ({ TexViewer } = require('../../tex/texViewer'));
} finally { Module._load = oldLoad; }

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-policy-'));
    const root = path.join(dir, 'paper.tex');
    fs.writeFileSync(root, '\\documentclass{article}');
    const coordinator = new RenderCoordinator({}, { appendLine() {} });
    coordinator._luaOk = false;
    const state = { root, files:[root], generation:null, map:null };
    coordinator.roots.set(root, state);
    coordinator.rootOf.set(root, root);
    return { coordinator, state, doc:{ uri:{ fsPath:root } }, close() {
        coordinator.dispose(); fs.rmSync(dir, { recursive:true, force:true });
    } };
}

test('native previews select sidecar; authoritative and explicit builds select configured compiler', async () => {
    const f = fixture();
    try {
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, 1);
        assert.equal(conventionalCalls, 0);
        assert.equal(f.state.generation.runner, 'wlatex');
        assert.equal(f.state.sourceAhead, false);
        await f.coordinator.build(f.doc, { authoritative:true, quiet:true });
        assert.equal(conventionalCalls, 1);
        await f.coordinator.build(f.doc, { force:true, quiet:true });
        assert.equal(conventionalCalls, 2);
    } finally { f.close(); }
});

test('a save of a settled native build stays native; an unsettled one still gets latexmk', async () => {
    const f = fixture();
    const before = { native:nativeCalls, conventional:conventionalCalls };
    nativeSettled = true;
    try {
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, before.native + 1);
        // A save of a settled build never runs latexmk.
        await f.coordinator.build(f.doc, { authoritative:true, quiet:true });
        assert.equal(conventionalCalls, before.conventional);
        assert.equal(f.state.generation.runner, 'wlatex');
        // New text on save: the native lane builds it.
        const nativeBefore = nativeCalls;
        fs.appendFileSync(f.state.root, '\n% saved');
        await f.coordinator.build(f.doc, { authoritative:true, quiet:true });
        assert.ok(nativeCalls > nativeBefore);
        assert.equal(conventionalCalls, before.conventional);
    } finally { nativeSettled = false; f.close(); }
});

test('a paper for another engine leaves the native lane: declared, or proven by a native-only failure', async () => {
    const f = fixture();
    try {
        fs.writeFileSync(f.state.root, '% !TEX program = pdflatex\n\\documentclass{article}');
        const native0 = nativeCalls, conventional0 = conventionalCalls;
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0, 'a declared pdflatex paper never reaches the native lane');
        assert.equal(conventionalCalls, conventional0 + 1);
        assert.match(f.state.nativeOff, /asks for pdflatex \(% !TEX program = pdflatex, line 1\)/);
        assert.equal(observedEngines.at(-1), 'pdflatex', 'built with the engine the paper asks for');
        // arXiv's pdfLaTeX marker says so too, before any native build fails.
        fs.writeFileSync(f.state.root, '\\pdfoutput=1\n\\documentclass{article}\n\\begin{document}a');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0);
        assert.equal(conventionalCalls, conventional0 + 2);
        assert.match(f.state.nativeOff, /written for pdflatex \(\\pdfoutput=1, line 1\)/);
        assert.equal(observedEngines.at(-1), 'pdflatex');
        // No sign at all, but WLaTeX fails where the configured compiler works.
        fs.writeFileSync(f.state.root, '\\documentclass{article}\n\\usepackage{pdftexonly}\n\\begin{document}a');
        nativeDocumentError = true;
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0 + 1);
        assert.equal(conventionalCalls, conventional0 + 3);
        assert.equal(f.state.generation.ok, true);
        assert.match(f.state.nativeOff, /cannot build this paper/);
        // The next pause does not try WLaTeX again for the same preamble...
        fs.appendFileSync(f.state.root, ' more body text');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0 + 1);
        // ...but a changed preamble does.
        nativeDocumentError = false;
        fs.writeFileSync(f.state.root, '\\documentclass{article}\n\\begin{document}y');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0 + 2);
        assert.equal(f.state.nativeOff, null);
        // Each reason was said once: the declared engine and the failed build
        // as notices, the one only shown (\pdfoutput) as a warning with a choice.
        assert.equal(notices.filter(m => /^Live preview is off for paper\.tex/.test(m)).length, 2);
        const offered = warnings.filter(w => /^Live preview is off for paper\.tex/.test(w.message));
        assert.equal(offered.length, 1);
        assert.match(offered[0].message, /written for pdflatex \(\\pdfoutput=1, line 1\).*may differ slightly.*line 1 to "\\ifdefined\\pdfoutput\\pdfoutput=1\\fi"/);
        assert.deepEqual(offered[0].choices, ['Preview with WLaTeX', 'Keep pdflatex', 'Show log']);
    } finally { nativeDocumentError = false; f.close(); }
});

test('the writer may preview a pdfLaTeX paper with WLaTeX after the warning', async () => {
    const f = fixture();
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    const savedRange = stub.Range;
    stub.Range = EditRange;
    try {
        // Keep pdflatex: nothing changes.
        warningPick = 'Keep pdflatex';
        fs.writeFileSync(f.state.root, '\\pdfoutput=1 % for arXiv\n\\documentclass{article}\n\\begin{document}a');
        const native0 = nativeCalls;
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        await settle();
        assert.equal(nativeCalls, native0);
        assert.match(fs.readFileSync(f.state.root, 'utf8'), /^\\pdfoutput=1 % for arXiv/);
        // Preview with WLaTeX: line 1 becomes engine-neutral and the paper builds natively.
        warningPick = 'Preview with WLaTeX';
        f.coordinator._nativeOffNotices.clear();
        f.state.nativeOffLogged = null;
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        await settle(); await settle();
        assert.equal(fs.readFileSync(f.state.root, 'utf8').split('\n')[0], '\\ifdefined\\pdfoutput\\pdfoutput=1\\fi % for arXiv');
        assert.ok(nativeCalls > native0, 'the rebuild after the choice ran on WLaTeX');
        assert.equal(f.state.nativeOff, null);
        // pdfTeX-only code without \pdfoutput: previewed as it is, for this preamble.
        const before = nativeCalls;
        fs.writeFileSync(f.state.root, '\\documentclass{article}\n\\input{glyphtounicode}\n\\begin{document}a');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        await settle(); await settle();
        assert.ok(nativeCalls > before, 'the override applies to this preamble');
        assert.match(fs.readFileSync(f.state.root, 'utf8'), /\\input\{glyphtounicode\}/, 'nothing rewritten');
    } finally { warningPick = undefined; stub.Range = savedRange; f.close(); }
});

test('superseded native builds preserve last generation and do not report an error', async () => {
    const f = fixture();
    try {
        const previous = f.state.generation = { generation:7 };
        cancel = true;
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(f.state.generation, previous);
        assert.ok(!f.state.lastError);
        assert.equal(f.state.compiling, false);
        assert.equal(f.state.running, null);
    } finally { cancel = false; f.close(); }
});

test('external file invalidation rejects native map and in-flight build', () => {
    const f = fixture();
    try {
        let lane = 0, map = 0;
        f.state.nativeLane = { invalidate() { lane++; }, async close() {} };
        f.state.map = { native:true, noteEdit() { map++; } };
        assert.ok(f.coordinator.invalidate(f.doc.uri.fsPath));
        assert.equal(lane, 1);
        assert.equal(map, 1);
        assert.equal(f.state.sourceAhead, true);
    } finally { f.close(); }
});

test('native inverse points preserve source columns without nearest-row heuristics', () => {
    const hit = { file:'paper.tex', line:3, column:8, flag:'fresh' };
    const map = { native:true, renderToSource: () => hit,
        lineAtPoint() { throw Error('must not guess a nearby row'); } };
    assert.equal(TexViewer.prototype._resolvePoint({ map }, { page:1, xBp:80, yTopBp:90 }), hit);
});


function cursorFixture() {
    const posts = [];
    const rects = [{ page:1, x:72, y:80, w:5, h:9 }];
    const map = { native:true, available:true, view:{ artifact:{ pdf_hash:'pdf' } },
        forwardAt:async () => rects };
    const state = { map, sourceAhead:true };
    const doc = { uri:{ fsPath:'paper.tex' }, version:1 };
    // Real VS Code Position exposes getters, not enumerable line fields.
    const position = { get line() { return 3; }, get character() { return 7; } };
    const editor = { document:doc, selection:{ start:position, end:position } };
    const viewer = { panel:{}, followCursor:true, _openedPdfHash:'pdf', _nativeCursorRequest:1,
        coord:{ stateFor:() => state }, _post:m => posts.push(m), _setTracePaused() {},
        _mayScroll:() => true, _invertedAt:0, _log() {} };
    return { viewer, state, map, doc, editor, posts, rects,
        run:() => TexViewer.prototype._syncNativeCursor.call(viewer, state, editor, {}, 1) };
}

test('native cursor can trace current anchors against an older displayed PDF', async () => {
    const f = cursorFixture();
    f.map.forwardAt = async (file, line, column) => {
        assert.equal(file, 'paper.tex'); assert.equal(line, 4); assert.equal(column, 7);
        return f.rects;
    };
    await f.run();
    assert.deepEqual(f.posts.at(-1).rects, f.rects);
    assert.equal(f.state.sourceAhead, true, 'mapping does not claim PDF is current source');
});

test('native cursor ignores late answers after cursor, source, map or display changes', async () => {
    const changes = [
        f => { f.viewer._nativeCursorRequest++; },
        f => { f.doc.version++; },
        f => { f.state.map = {}; },
        f => { f.viewer._openedPdfHash = 'other'; },
        f => { f.map.available = false; },
        f => { f.editor.selection = { start:{ line:9, character:0 }, end:{ line:9, character:0 } }; },
    ];
    for (const change of changes) {
        const f = cursorFixture();
        let resolve;
        f.map.forwardAt = () => new Promise(r => { resolve = r; });
        const pending = f.run();
        change(f); resolve(f.rects); await pending;
        assert.ok(!f.posts.some(p => p.rects?.length));
    }
});

test('new source with no worker membership clears the old cursor highlight', async () => {
    const f = cursorFixture(); f.map.forwardAt = async () => [];
    await f.run();
    assert.deepEqual(f.posts.at(-1).rects, []);
    assert.match(f.posts.at(-1).label, /no printed source/);
});


test('forward-sync handler selects native caret queries before the stale-source pause', async () => {
    const f = cursorFixture();
    f.doc.uri.fsPath = 'paper.tex';
    f.viewer._noteEditorNavigation = () => {};
    f.viewer._rememberCursor = () => {};
    let called = false;
    f.viewer._syncNativeCursor = async (state, editor, opts, request) => {
        called = true; assert.equal(state, f.state); assert.equal(editor, f.editor);
        assert.equal(request, 2);
    };
    await TexViewer.prototype.syncFromEditor.call(f.viewer, f.editor);
    assert.equal(called, true);
});

class NativePosition {
    constructor(line, character) { this.line = line; this.character = character; }
}
class NativeRange {
    constructor(start, end) { this.start = start; this.end = end; }
}
stub.Position = NativePosition;
stub.Range = NativeRange;
stub.Selection = NativeRange;
stub.TextEditorRevealType = { InCenterIfOutsideViewport:0 };
function inverseFixture() {
    const root = path.join(os.tmpdir(), 'native-inverse', 'paper.tex');
    const text = 'Alpha Alpha';
    const posts = [], cards = [];
    const doc = { uri:{ fsPath:root }, version:1, lineCount:1,
        getText:() => text, lineAt:() => ({ text }) };
    const hit = { file:root, flag:'fresh', exact:true,
        sourceRange:{ start:{ line:1, column_utf16:6 }, end:{ line:1, column_utf16:7 } },
        glyph:{ page:1, x:100, y:80, w:5, boxHeight:9 } };
    const map = { native:true, available:true, projectDir:path.dirname(root),
        view:{ artifact:{ pdf_hash:'pdf' } },
        source:{ files:new Map([['paper.tex', { text }]]) }, renderToSource:() => hit };
    const state = { root, map, sourceAhead:true };
    const editor = { document:doc, revealRange() {} };
    stub.workspace.openTextDocument = async () => doc;
    stub.window.showTextDocument = async () => editor;
    stub.window.visibleTextEditors = [];
    const viewer = { root, panel:{}, _openedPdfHash:'pdf', _openedGeneration:1, _nativeInverseRequest:0,
        coord:{ roots:new Map([[root, state]]) }, _tracePaused:true,
        _post:m => posts.push(m), _rememberCursor() {},
        _postEditSelection:(...args) => cards.push(args),
        _jumpToNativeSource:TexViewer.prototype._jumpToNativeSource };
    return { viewer, state, map, doc, hit, editor, posts, cards,
        run:(m={}) => TexViewer.prototype._jumpToSource.call(viewer, { generation:1, page:1, xBp:102, yTopBp:84, ...m }) };
}

test('native inverse dispatch uses exact repeated-text column even while source is ahead', async () => {
    const f = inverseFixture(); await f.run();
    assert.equal(f.editor.selection.start.character, 6);
    assert.equal(f.editor.selection.end.character, 6);
    assert.equal(f.cards[0][3].character, 6);
    assert.equal(f.posts.find(p => p.type === 'highlight').exact, true);
});

test('native take-me selects only the verified source range', async () => {
    const f = inverseFixture(); await f.run({ takeMe:true });
    assert.equal(f.editor.selection.start.character, 6);
    assert.equal(f.editor.selection.end.character, 7);
});

test('native displaced ranges navigate to a seam but cannot replace inserted text', async () => {
    const f = inverseFixture(); f.hit.exact = false; f.hit.sourceRange.end.column_utf16 = 11;
    await f.run({ takeMe:true });
    assert.equal(f.editor.selection.start.character, 6);
    assert.equal(f.editor.selection.end.character, 6);
    f.editor.selection = null; f.cards.length = 0;
    await f.run({ typingRequest:1 });
    assert.equal(f.editor.selection, null);
    assert.equal(f.cards.length, 0);
});

test('native inverse refuses mismatched source bytes, invalid locations and wrong PDFs', async () => {
    for (const change of [
        f => { f.doc.getText = () => 'different'; },
        f => { f.hit.sourceRange.start.column_utf16 = 100; },
        f => { f.viewer._openedPdfHash = 'other'; },
        f => { f.map.renderToSource = () => ({ flag:'unmapped' }); },
    ]) {
        const f = inverseFixture(); change(f); await f.run();
        assert.equal(f.editor.selection, undefined);
        assert.equal(f.cards.length, 0);
    }
});

test('native inverse drops replies after an asynchronous editor open becomes stale', async () => {
    for (const change of [
        f => { f.doc.version++; },
        f => { f.map.available = false; },
        f => { f.viewer._nativeInverseRequest++; },
        f => { f.viewer._openedPdfHash = 'new'; },
    ]) {
        const f = inverseFixture();
        stub.window.showTextDocument = async () => { change(f); return f.editor; };
        await f.run(); assert.equal(f.editor.selection, undefined);
    }
});

test('native inverse preserves focused layout and sends the verified caret to the card', async () => {
    const f = inverseFixture(); f.viewer._fsActions = {};
    stub.window.showTextDocument = async () => { throw Error('must not expose source editor'); };
    await f.run(); assert.equal(f.cards[0][3].character, 6);
});


test('native inverse rejects queued clicks from a different PDF generation', async () => {
    const f = inverseFixture(); await f.run({ generation:0 });
    assert.equal(f.editor.selection, undefined);
});


test('native client sends generation-bound clicks without text-layer guesses while paused', async () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const sent = [];
    const context = vm.createContext({ state:{ tracePaused:true, nativeMapAvailable:true, generation:7 },
        vscode:{ postMessage:m => sent.push(m) }, pendingPaperTyping:null, paperTargetSeq:0,
        clearPaperTypingTarget() {}, wordAtPoint() { throw Error('native clicks must not guess text'); } });
    const start = js.indexOf('function sendClick(');
    vm.runInContext(js.slice(start, js.indexOf("\nel('zoomin')", start)), context);
    context.sendClick(1, { xBp:100, yTopBp:80 }, 100, 80, {});
    await context.paperTypingResolving;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'click');
    assert.equal(sent[0].generation, 7);
    assert.equal(sent[0].word, undefined);
    context.sendClick(1, { xBp:100, yTopBp:80 }, 100, 80, { widen:true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].widen, true);
    assert.equal(sent[1].word, undefined);
});

test('native-map client availability only accepts the displayed generation', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf("case 'nativeMapState':");
    const handler = 'switch(msg.type){' + js.slice(start, js.indexOf("case 'traceState':", start)) + '}';
    const context = vm.createContext({ state:{ generation:7, nativeMapAvailable:false },
        msg:{ type:'nativeMapState', generation:6, available:true } });
    vm.runInContext(handler, context); assert.equal(context.state.nativeMapAvailable, false);
    context.msg.generation = 7; vm.runInContext(handler, context);
    assert.equal(context.state.nativeMapAvailable, true);
    context.msg.available = false; vm.runInContext(handler, context);
    assert.equal(context.state.nativeMapAvailable, false);
});


test('WPaper defaults do not require or initialize optional WLaTeX', async () => {
    const f = fixture(); const before = constructorCalls; const builds = conventionalCalls;
    configuredMapEngine = 'auto'; installed = false;
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(constructorCalls, before);
        assert.equal(conventionalCalls, builds + 1);
        assert.ok(!f.state.lastError);
    } finally { configuredMapEngine = 'wlatex'; installed = true; f.close(); }
});

test('an opted-in but unavailable WLaTeX falls back without breaking normal builds', async () => {
    const f = fixture(); const builds = conventionalCalls; installed = false;
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(conventionalCalls, builds + 1);
        assert.ok(!f.state.lastError);
        assert.match(f.state.nativeUnavailable, /normal WPaper compiler/);
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(conventionalCalls, builds + 1, 'unchanged normal generation is reusable');
    } finally { installed = true; f.close(); }
});

test('switching back to normal mode closes the optional worker', async () => {
    const f = fixture(); let closed = false;
    f.state.nativeLane = { async close() { closed = true; } };
    configuredMapEngine = 'auto';
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(closed, true); assert.equal(f.state.nativeLane, null);
    } finally { configuredMapEngine = 'wlatex'; f.close(); }
});


test('an optional runtime failure falls back once and reuses the successful normal PDF', async () => {
    const f = fixture(); const builds = conventionalCalls; const previews = nativeCalls;
    nativeFailure = true;
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(conventionalCalls, builds + 1);
        assert.ok(!f.state.lastError);
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(nativeCalls, previews + 1);
        assert.equal(conventionalCalls, builds + 1);
    } finally { nativeFailure = false; f.close(); }
});

function miniFixture() {
    const f = cursorFixture();
    f.doc.uri.fsPath = 'paper.tex';
    f.doc.positionAt = offset => new NativePosition(3, offset);
    f.viewer._edit = { id:12, file:'paper.tex', startOffset:3, endOffset:11 };
    f.viewer._rememberEditState = () => {};
    f.viewer._noteEditorNavigation = () => {};
    f.viewer._rememberCursor = () => {};
    f.viewer.syncFromEditor = TexViewer.prototype.syncFromEditor;
    f.viewer._syncNativeCursor = TexViewer.prototype._syncNativeCursor;
    stub.workspace.openTextDocument = async () => f.doc;
    stub.window.visibleTextEditors = [];
    f.runMini = start => TexViewer.prototype._onEditCaret.call(f.viewer, { editId:12, start, end:start });
    return f;
}

test('mini-editor caret uses native worker geometry against the displayed older PDF', async () => {
    const f = miniFixture();
    f.map.forwardAt = async (file, line, column) => {
        assert.equal(file, 'paper.tex'); assert.equal(line, 4); assert.equal(column, 5);
        return f.rects;
    };
    await f.runMini(2);
    assert.deepEqual(f.posts.at(-1).rects, f.rects);
    assert.equal(f.posts.at(-1).reveal, false, 'the card does not scroll the PDF');
});

test('an older mini-editor document open cannot overwrite a newer caret', async () => {
    const f = miniFixture(); let release; let opens = 0; const columns = [];
    stub.workspace.openTextDocument = () => ++opens === 1
        ? new Promise(resolve => { release = resolve; }) : Promise.resolve(f.doc);
    f.map.forwardAt = async (file, line, column) => { columns.push(column); return f.rects; };
    const older = f.runMini(1);
    await f.runMini(4);
    release(f.doc); await older;
    assert.deepEqual(columns, [7]);
    assert.equal(f.viewer._lastEditCaret.start, 4);
});

test('closing or replacing the card while an edit applies discards its old caret', async () => {
    const f = miniFixture(); let release; let opens = 0;
    f.viewer._editApplyQueue = new Promise(resolve => { release = resolve; });
    stub.workspace.openTextDocument = async () => { opens++; return f.doc; };
    const pending = f.runMini(1);
    f.viewer._edit = { id:13, file:'other.tex', startOffset:0, endOffset:5 };
    release(); await pending;
    assert.equal(opens, 0);
    assert.equal(f.posts.length, 0);
});

test('native mini-editor answers are discarded after card closure or block movement', async () => {
    for (const change of [f => { f.viewer._edit = null; }, f => { f.viewer._edit.startOffset++; }]) {
        const f = miniFixture(); let release;
        f.map.forwardAt = () => new Promise(resolve => { release = resolve; });
        const pending = f.runMini(1);
        await Promise.resolve();
        assert.equal(typeof release, 'function');
        change(f); release(f.rects); await pending;
        assert.ok(!f.posts.some(p => p.rects?.length));
    }
});


function openFixture() {
    const f = inverseFixture();
    f.hit.line = 1;
    const text = f.doc.getText();
    f.doc.offsetAt = pos => pos.character;
    f.doc.getText = range => range ? text.slice(range.start.character, range.end.character) : text;
    f.viewer._editSeq = 0;
    f.viewer._resolvePoint = TexViewer.prototype._resolvePoint;
    f.viewer._blockAt = () => ({ startLine:1, endLine:1, label:'paragraph' });
    f.viewer._ensureDocListener = () => {};
    f.viewer._rememberEditState = () => {};
    f.viewer._editRects = () => [];
    f.open = (message={}) => TexViewer.prototype._openEditSession.call(f.viewer,
        { generation:1, page:1, xBp:102, yTopBp:84, ...message });
    return f;
}

test('an exact current native glyph opens a card while source is ahead', async () => {
    const f = openFixture(); const session = await f.open({ typingRequest:9 });
    assert.equal(session, f.viewer._edit);
    assert.equal(session.lastText, 'Alpha Alpha');
    assert.equal(f.posts.at(-1).type, 'editOpen');
    assert.equal(f.posts.at(-1).typingRequest, 9);
});

test('native card opening refuses displaced, stale and mismatched-source points', async () => {
    for (const change of [
        f => { f.hit.exact = false; },
        f => { f.viewer._openedPdfHash = 'other'; },
        f => { f.doc.getText = () => 'other text'; },
    ]) {
        const f = openFixture(); change(f);
        assert.equal(await f.open(), undefined);
        assert.ok(!f.posts.some(m => m.type === 'editOpen'));
    }
});

test('delayed card opening cannot replace a newer card or follow newer navigation', async () => {
    for (const change of [
        f => { f.viewer._edit = { id:99 }; },
        f => { f.viewer._editOpenRequest++; },
        f => { f.viewer._nativeInverseRequest++; },
        f => { f.viewer._miniCaretRequest = 1; },
        f => { f.map.available = false; },
    ]) {
        const f = openFixture(); let release;
        stub.workspace.openTextDocument = () => new Promise(resolve => { release = resolve; });
        const pending = f.open(); change(f); release(f.doc);
        assert.equal(await pending, undefined);
        assert.ok(!f.posts.some(m => m.type === 'editOpen'));
    }
});

test('only the newest of two asynchronous card opens can publish', async () => {
    const f = openFixture(); const releases = [];
    stub.workspace.openTextDocument = () => new Promise(resolve => releases.push(resolve));
    const older = f.open(); const newer = f.open();
    releases[1](f.doc); const current = await newer;
    releases[0](f.doc); assert.equal(await older, undefined);
    assert.equal(f.viewer._edit, current);
    assert.equal(f.posts.filter(m => m.type === 'editOpen').length, 1);
});

test('native source ranges publish only admitted rectangles and retain source action bounds', async () => {
    const f = cursorFixture();
    f.doc.uri.fsPath = path.join(os.tmpdir(), 'paper.tex');
    f.doc.getText = () => 'abc';
    f.map.projectDir = os.tmpdir();
    f.map.source = { files:new Map([['paper.tex', { text:'abc' }]]) };
    f.editor.selection = { start:{ line:0, character:0 }, end:{ line:0, character:2 } };
    f.map.forwardRange = async (file, start, end, options) => {
        assert.equal(start.column_utf16, 0); assert.equal(end.column_utf16, 2);
        assert.equal(options.isCurrent(), true); return f.rects;
    };
    f.viewer._postEditSelection = () => {};
    await f.run();
    const selected = f.posts.at(-1);
    assert.equal(selected.type, 'selection'); assert.equal(selected.span.native, true);
    assert.deepEqual(selected.span.rows, f.rects);
    assert.equal(f.viewer._lastSelection.end.character, 2);
});

test('native selection painting preserves glyph gaps and never searches PDF text rows', async () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const painted = [];
    const context = vm.createContext({ state:{ rendered:new Set([1]), edit:true },
        document:{ querySelectorAll:() => [], createElement:() => ({ style:{} }) },
        pagesEl:() => ({ querySelector:() => ({ appendChild:node => painted.push(node) }) }),
        renderPage:async () => {}, rectToViewport:(page, rect) => rect, markToPx:mark => mark,
        textItems:() => { throw Error('native selection must not infer text rows'); },
        paintSelectionActions() {} });
    const start = js.indexOf('async function paintSelection(');
    vm.runInContext(js.slice(start, js.indexOf('\n}\n', start) + 2), context);
    await context.paintSelection({ native:true, reveal:false,
        rows:[{ page:1, x:10, y:10, w:5, h:8 }, { page:1, x:50, y:20, w:5, h:8 }],
        start:{ exactEdge:{ page:1, x:10, y:10, h:8 } },
        end:{ exactEdge:{ page:1, x:55, y:20, h:8 } } });
    const fills = painted.filter(node => node.className === 'selfill');
    assert.equal(fills.length, 2);
    assert.equal(fills[0].style.width, '5px'); assert.equal(fills[0].style.height, '8px');
    assert.equal(fills[1].style.left, '50px');
});

function pickFixture() {
    const f = inverseFixture(); const queries = [];
    f.viewer.followCursor = true;
    f.viewer.coord.stateFor = () => f.state;
    f.viewer._syncNativeCursor = TexViewer.prototype._syncNativeCursor;
    f.viewer._setTracePaused = () => {};
    f.viewer._log = () => {};
    f.map.forwardRange = async (file, start, end) => {
        queries.push([start.column_utf16, end.column_utf16]);
        return [{ page:1, x:100, y:80, w:5, h:9 }];
    };
    f.pick = (column, options={}) => {
        f.hit.sourceRange.start.column_utf16 = column;
        f.hit.sourceRange.end.column_utf16 = column + 1;
        return f.run({ pick:true, ...options });
    };
    f.queries = queries; return f;
}

test('native shift-pick selects both endpoint tokens in either source direction', async () => {
    for (const columns of [[0,6], [6,0]]) {
        const f = pickFixture();
        await f.pick(columns[0]);
        assert.equal(f.posts.at(-1).span.pendingStart, true);
        assert.equal(f.queries.length, 0);
        await f.pick(columns[1]);
        assert.deepEqual(f.queries, [[0,7]]);
        assert.equal(f.editor.selection.start.character, 0);
        assert.equal(f.editor.selection.end.character, 7);
        assert.equal(f.viewer._pickAnchor, null);
        assert.equal(f.posts.at(-1).span.native, true);
    }
});

test('native live picking keeps its anchor and can shrink before mouse release', async () => {
    const f = pickFixture(); await f.pick(0);
    await f.pick(6, { live:true }); assert.ok(f.viewer._pickAnchor);
    await f.pick(2, { live:false });
    assert.deepEqual(f.queries, [[0,7], [0,3]]);
    assert.equal(f.viewer._pickAnchor, null);
});

test('native picking restarts after a document revision instead of using a stale endpoint', async () => {
    const f = pickFixture(); await f.pick(0);
    f.doc.version++; await f.pick(6);
    assert.equal(f.queries.length, 0);
    assert.equal(f.viewer._pickAnchor.position.character, 6);
    assert.equal(f.posts.at(-1).span.pendingStart, true);
});

test('a displaced native point cannot become a shift-pick endpoint', async () => {
    const f = pickFixture(); f.hit.exact = false; await f.pick(0);
    assert.ok(!f.viewer._pickAnchor);
    assert.equal(f.queries.length, 0);
});

test('an unmapped plain click abandons a pending native shift-pick', async () => {
    const f = pickFixture(); await f.pick(0);
    f.map.renderToSource = () => ({ flag:'unmapped' });
    await f.run(); assert.equal(f.viewer._pickAnchor, null);
});

function widenFixture(text = 'Alpha. Beta.') {
    const f = pickFixture();
    f.doc.getText = () => text;
    f.doc.lineCount = text.split('\n').length;
    f.doc.lineAt = n => ({ text:text.split('\n')[n] });
    f.map.source.files.get('paper.tex').text = text;
    f.hit.sourceRange.start.column_utf16 = 8;
    f.hit.sourceRange.end.column_utf16 = 9;
    f.viewer._modelFor = TexViewer.prototype._modelFor;
    return f;
}

test('native widen and shrink traverse current source containers back to the exact token', async () => {
    const f = widenFixture();
    await f.run({ widen:true });
    await f.run({ widen:true });
    await f.run({ widen:true, shrink:true });
    await f.run({ widen:true, shrink:true });
    assert.deepEqual(f.queries, [[7,12], [0,12], [7,12], [8,9]]);
    assert.equal(f.posts.at(-1).span.native, true);
    assert.equal(f.cards.at(-1)[1].start.character, 8);
});

test('native widening discards ladders from earlier documents, maps and click locations', async () => {
    for (const invalidate of [
        f => { f.doc.version++; },
        f => { f.viewer._ladder.nativeMap = {}; },
        f => { f.viewer._ladder.file = '/other.tex'; },
        f => { f.viewer._ladder.xBp += 100; },
    ]) {
        const f = widenFixture(); await f.run({ widen:true });
        invalidate(f); await f.run({ widen:true });
        assert.deepEqual(f.queries, [[7,12], [7,12]]);
    }
});

test('native widening requires an exact source point and the displayed PDF generation', async () => {
    for (const options of [{ displaced:true }, { generation:0 }]) {
        const f = widenFixture();
        if (options.displaced) f.hit.exact = false;
        await f.run({ widen:true, ...options });
        assert.equal(f.queries.length, 0);
        assert.equal(f.editor.selection, undefined);
    }
});

test('native widening never truncates a verified multiline source seed', async () => {
    const f = widenFixture('Alpha\nBeta');
    f.hit.sourceRange.start = { line:1, column_utf16:3 };
    f.hit.sourceRange.end = { line:2, column_utf16:2 };
    await f.run({ widen:true });
    assert.equal(f.editor.selection.start.line, 0);
    assert.equal(f.editor.selection.start.character, 0);
    assert.equal(f.editor.selection.end.line, 1);
    assert.equal(f.editor.selection.end.character, 4);
    await f.run({ widen:true, shrink:true });
    assert.equal(f.editor.selection.start.character, 3);
    assert.equal(f.editor.selection.end.line, 1);
    assert.equal(f.editor.selection.end.character, 2);
});

test('late native widening rectangles cannot repaint after another source gesture', async () => {
    const f = widenFixture(); let release;
    f.map.forwardRange = () => new Promise(resolve => { release = resolve; });
    const pending = f.run({ widen:true });
    while (!release) await Promise.resolve();
    await f.run();
    const count = f.posts.length;
    release([{ page:1, x:1, y:1, w:1, h:1 }]);
    await pending;
    assert.equal(f.posts.length, count);
});

test('rapid native picking retains its first endpoint while document opens finish out of order', async () => {
    for (const order of [[0,1,2], [2,1,0]]) {
        const f = pickFixture(); const releases = [];
        // Native page views are immutable; return distinct hits for each event.
        f.map.renderToSource = () => structuredClone(f.hit);
        stub.workspace.openTextDocument = () => new Promise(resolve => releases.push(resolve));
        const requests = [f.pick(0), f.pick(6, { live:true }), f.pick(2)];
        for (const i of order) releases[i](f.doc);
        await Promise.all(requests);
        assert.deepEqual(f.queries, [[0,3]]);
        assert.equal(f.editor.selection.start.character, 0);
        assert.equal(f.editor.selection.end.character, 3);
        assert.equal(f.viewer._pickAnchor, null);
    }
});

test('a plain click cancels a native endpoint reserved by a pending document open', async () => {
    const f = pickFixture(); const releases = [];
    f.map.renderToSource = () => structuredClone(f.hit);
    stub.workspace.openTextDocument = () => new Promise(resolve => releases.push(resolve));
    const first = f.pick(0); const plain = f.run();
    releases[1](f.doc); await plain;
    releases[0](f.doc); await first;
    assert.equal(f.viewer._pickAnchor, null);
    assert.equal(f.queries.length, 0);
});

test('rapid native picking also retains its endpoint while source editors are opening', async () => {
    const f = pickFixture(); const releases = [];
    f.map.renderToSource = () => structuredClone(f.hit);
    stub.window.showTextDocument = () => new Promise(resolve => releases.push(resolve));
    const first = f.pick(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 1);
    const last = f.pick(6);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 2);
    releases[1](f.editor); await last;
    releases[0](f.editor); await first;
    assert.deepEqual(f.queries, [[0,7]]);
    assert.equal(f.viewer._pickAnchor, null);
});

test('failed native workers are retired and reconstructed after sources change', async () => {
    const f = fixture();
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        const old = f.state.nativeLane;
        let closed = false;
        old.close = async () => { closed = true; };
        old.compile = async () => { throw Error('source worker exited'); };
        fs.appendFileSync(f.doc.uri.fsPath, '\n% changed');
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(closed, true);
        assert.equal(f.state.nativeLane, null);
        assert.ok(!f.state.lastError);
        const before = constructorCalls;
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(constructorCalls, before, 'failed snapshot must not start a restart loop');
        fs.appendFileSync(f.doc.uri.fsPath, '\n% retry');
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(constructorCalls, before + 1);
        assert.notEqual(f.state.nativeLane, old);
        assert.equal(f.state.generation.runner, 'wlatex');
    } finally { f.close(); }
});

test('an old edit completion cannot refresh or retire a replacement native worker', async () => {
    for (const reject of [false, true]) {
        const f = fixture(); let finish, oldClosed = false, refreshed = false;
        const old = { source:{}, noteChange:() => new Promise((resolve, fail) => {
            finish = reject ? () => fail(Error('old worker exited')) : resolve;
        }), refresh:async () => { throw Error('retired worker must not refresh'); },
        close:async () => { oldClosed = true; } };
        const replacement = { refresh:async () => { refreshed = true; }, close:async () => {} };
        try {
            f.state.nativeLane = old;
            f.coordinator.noteChange({ document:f.doc, contentChanges:[] });
            f.state.nativeLane = replacement;
            finish(); await new Promise(resolve => setImmediate(resolve));
            assert.equal(f.state.nativeLane, replacement);
            assert.equal(refreshed, false);
            assert.equal(oldClosed, reject);
        } finally { f.close(); }
    }
});

test('mapping failures retire their source session even if shutdown rejects', async () => {
    const f = fixture(); let closed = false;
    try {
        f.state.nativeLane = { noteChange:async () => { throw Error('worker exited'); },
            close:async () => { closed = true; throw Error('already dead'); } };
        f.coordinator.noteChange({ document:f.doc, contentChanges:[] });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, true);
        assert.equal(f.state.nativeLane, null);
    } finally { f.close(); }
});

test('disposal during native replacement prevents later construction and compilation', async () => {
    const f = fixture(); let release;
    const before = constructorCalls, builds = nativeCalls;
    f.state.nativeLane = { directory:'/old-runtime', close:() => new Promise(resolve => { release = resolve; }) };
    try {
        const pending = f.coordinator.build(f.doc, { quiet:true });
        f.coordinator.dispose(); release(); await pending;
        assert.equal(constructorCalls, before);
        assert.equal(nativeCalls, builds);
        assert.equal(f.state.nativeLane, null);
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(constructorCalls, before);
    } finally { f.close(); }
});

test('an older pending runtime replacement cannot overwrite a newer lane', async () => {
    const f = fixture(); let release;
    f.state.nativeLane = { directory:'/old-runtime', close:() => new Promise(resolve => { release = resolve; }) };
    try {
        const first = f.coordinator.build(f.doc, { quiet:true });
        await f.coordinator.build(f.doc, { quiet:true });
        const replacement = f.state.nativeLane;
        const before = constructorCalls;
        release(); await first;
        assert.equal(f.state.nativeLane, replacement);
        assert.equal(constructorCalls, before);
    } finally { f.close(); }
});


test('configured compiler timeout reaches native builds and their conventional fallback', async () => {
    const f = fixture();
    configuredTimeout = 45000; nativeFailure = true;
    const start = observedTimeouts.length;
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        assert.deepEqual(observedTimeouts.slice(start), [['native',45000], ['conventional',45000]]);
    } finally { configuredTimeout = 180000; nativeFailure = false; f.close(); }
});

test('native mini-input operations preserve the actual insertion position in repeated text', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf('function miniInputOperation(');
    const context = vm.createContext({});
    vm.runInContext(js.slice(start, js.indexOf('\n}\n',start) + 2), context);
    const cases = [
        [{ text:'aaaa', start:1, end:1, type:'insertText' }, 'aaaaa', 2, [1,1,'a']],
        [{ text:'A😀B', start:3, end:3, type:'deleteContentBackward' }, 'AB', 1, [1,3,'']],
        [{ text:'abc', start:1, end:1, type:'deleteContentForward' }, 'ac', 1, [1,2,'']],
        [{ text:'abc', start:1, end:2, type:'insertFromPaste' }, 'aXYc', 3, [1,2,'XY']],
    ];
    for (const [before, after, caret, expected] of cases) {
        const op = context.miniInputOperation(before, after, caret);
        assert.deepEqual([op.start,op.end,op.text], expected);
    }
    assert.equal(context.miniInputOperation({ text:'abc', start:3, end:3, type:'historyUndo' }, 'ac', 1), null);
    assert.equal(context.miniInputOperation({ text:'abc', start:1, end:1, type:'insertText' }, 'unrelated', 3), null);
});

test('native mini-editor applies verified ranges and retains insertions at card boundaries', async () => {
    for (const at of [0,1,4,'invalid']) {
        let text = 'aaaa'; let applied;
        const doc = { uri:{ fsPath:'/paper.tex' }, positionAt:n => new NativePosition(0,n),
            getText:range => range ? text.slice(range.start.character, range.end.character) : text };
        stub.workspace.openTextDocument = async () => doc;
        stub.WorkspaceEdit = class { replace(uri, range, value) { this.range=range; this.value=value; } };
        const s = { id:1, native:true, file:'/paper.tex', startOffset:0, endOffset:4, lastText:text };
        const viewer = { _edit:s, _rememberEditState() {}, _post() {},
            _applyReaderEdit:async (document, edit) => {
                applied = edit;
                const start = edit.range.start.character, end = edit.range.end.character;
                text = text.slice(0,start)+edit.value+text.slice(end);
                TexViewer.prototype._onEditDocChange.call(viewer, { document:doc,
                    contentChanges:[{ rangeOffset:start, rangeLength:end-start, text:edit.value }] });
                return true;
            } };
        const before = text;
        assert.equal(await TexViewer.prototype._applyEditChangeNow.call(viewer, s, 'aaaaa',
            { before, start:at === 'invalid' ? 99 : at,
                end:at === 'invalid' ? 99 : at, text:'a' }), true);
        assert.equal(applied.range.start.character, at === 'invalid' ? 0 : at);
        assert.equal(applied.range.end.character, at === 'invalid' ? 4 : at);
        assert.equal(s.startOffset, 0);
        assert.equal(s.endOffset, 5);
        assert.equal(s.lastText, text);
    }
});


test('stale native card operations cannot overwrite external changes or later save the stale block', async () => {
    const source = 'External'; const posts = []; let writes = 0;
    const s = { id:1, native:true, file:'/paper.tex', startOffset:0, endOffset:source.length, lastText:source };
    const doc = { uri:{ fsPath:s.file }, positionAt:n => new NativePosition(0,n), getText:() => source };
    stub.workspace.openTextDocument = async () => doc;
    const viewer = { _edit:s, _post:message => posts.push(message), _applyReaderEdit:async () => { writes++; } };
    assert.equal(await TexViewer.prototype._applyEditChangeNow.call(viewer, s, 'Old draft',
        { before:'Old', start:3, end:3, text:' draft' }), false);
    assert.equal(s.conflict, true);
    assert.equal(posts[0].type, 'editConflict');
    assert.equal(posts[0].text, 'Old draft');
    assert.equal(await TexViewer.prototype._applyEditChangeNow.call(viewer, s, 'Old draft'), false);
    assert.equal(writes, 0);
    assert.equal(s.lastText, source);
});

test('native card writes are rejected if their session closes during document opening', async () => {
    let release; let writes = 0;
    const s = { native:true, lastText:'old', file:'/paper.tex' };
    const viewer = { _edit:s, _post() {}, _applyReaderEdit:async () => { writes++; } };
    stub.workspace.openTextDocument = () => new Promise(resolve => { release = resolve; });
    const pending = TexViewer.prototype._applyEditChangeNow.call(viewer, s, 'new');
    viewer._edit = null; release({});
    assert.equal(await pending, false);
    assert.equal(writes, 0);
});


test('native conflict UI preserves the newest local draft against queued source updates', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const conflict = js.slice(js.indexOf("case 'editConflict':"), js.indexOf("case 'editOpen':"));
    const update = js.slice(js.indexOf("case 'editUpdate':"), js.indexOf("case 'mmaOpen':"));
    const textarea = { value:'External source' }, label = {};
    const context = vm.createContext({ state:{ edit:{ id:1, _localText:'Latest local draft' } },
        document:{ querySelector:selector => selector.endsWith('textarea') ? textarea : label },
        msg:{ type:'editConflict', editId:1, text:'Older local draft' } });
    const handler = 'switch(msg.type){' + conflict + update + '}';
    vm.runInContext(handler, context);
    assert.equal(textarea.value, 'Latest local draft');
    assert.match(label.textContent, /Source changed/);
    context.msg = { type:'editUpdate', editId:1, text:'New external source' };
    vm.runInContext(handler, context);
    assert.equal(textarea.value, 'Latest local draft');
    assert.equal(context.state.edit.text, 'Latest local draft');
});


test('native canvas reuse requires matching page identities, scale and display density', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf('function reusableNativePages(');
    const context = vm.createContext({});
    vm.runInContext(js.slice(start, js.indexOf('\n}\n',start) + 2), context);
    const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
    const rendered = new Map([[1,{scale:1.5,dpr:2}], [2,{scale:1.5,dpr:2}]]);
    const reuse = (old, next, scale=1.5, dpr=2) => [...context.reusableNativePages(old,next,rendered,scale,dpr).keys()];
    assert.deepEqual(reuse([a,b],[a,c]), [1]);
    assert.deepEqual(reuse([a,b],[a]), [1]);
    assert.deepEqual(reuse([a,b],[a,b],2), []);
    assert.deepEqual(reuse([a,b],[a,b],1.5,1), []);
    assert.deepEqual(reuse(null,[a,b]), []);
    assert.deepEqual(reuse([a,b],null), []);
    assert.deepEqual(reuse(['invalid',b],['invalid',c]), []);
});


test('native CRLF card edits and bidirectional selections use textarea offsets', async () => {
    let source = 'aa\r\n😀bb\r\ncc'; const posts = []; let applied;
    const doc = { uri:{ fsPath:'/crlf.tex' }, eol:2,
        positionAt:n => new NativePosition(0,n), offsetAt:p => p.character,
        getText:range => range ? source.slice(range.start.character,range.end.character) : source };
    stub.workspace.openTextDocument = async () => doc;
    stub.window.visibleTextEditors = [];
    stub.WorkspaceEdit = class { replace(uri, range, value) { this.range=range; this.value=value; } };
    const card = { id:1, native:true, file:doc.uri.fsPath, startOffset:0, endOffset:source.length, lastText:source };
    let selection;
    const viewer = { panel:{}, _edit:card, _rememberEditState() {}, _post:m => posts.push(m),
        syncFromEditor:async e => { selection=e.selection; },
        _applyReaderEdit:async (_, edit) => {
            applied=edit;
            const start=edit.range.start.character, end=edit.range.end.character;
            source=source.slice(0,start)+edit.value+source.slice(end);
            TexViewer.prototype._onEditDocChange.call(viewer, { document:doc,
                contentChanges:[{ rangeOffset:start, rangeLength:end-start, text:edit.value }] });
            return true;
        } };
    const before='aa\n😀bb\ncc', text='aa\n😀X\nYbb\ncc';
    assert.equal(await TexViewer.prototype._applyEditChangeNow.call(viewer,card,text,
        { before,start:5,end:5,text:'X\nY' },before),true);
    assert.equal(applied.range.start.character,6);
    assert.equal(applied.range.end.character,6);
    assert.equal(applied.value,'X\r\nY');
    assert.equal(source,'aa\r\n😀X\r\nYbb\r\ncc');
    assert.equal(card.lastText,source);
    assert.equal(card.endOffset,source.length);
    assert.ok(!posts.some(m => m.type==='editConflict' || m.type==='editUpdate'));
    await TexViewer.prototype._onEditCaret.call(viewer,{ editId:1,start:7,end:8,direction:'backward' });
    assert.equal(selection.start.character,9);
    assert.equal(selection.end.character,10);
    assert.equal(selection.active.character,9);
    TexViewer.prototype._postEditSelection.call(viewer,doc,
        { start:new NativePosition(0,9),end:new NativePosition(0,10) },false,new NativePosition(0,9));
    const message=posts.findLast(m => m.type==='editSelect');
    assert.equal(message.start,7); assert.equal(message.end,8); assert.equal(message.caret,7);
    applied=null;
    assert.equal(await TexViewer.prototype._applyEditChangeNow.call(viewer,card,text,null,text),true);
    assert.equal(applied,null,'unchanged LF textarea must not rewrite the CRLF source');
    assert.equal(card.lastText,source);
    assert.equal(await TexViewer.prototype._applyEditChangeNow.call(viewer,card,text+'!',null,text),true);
    assert.equal(source,'aa\r\n😀X\r\nYbb\r\ncc!','full-block fallback preserves EOL');
});

function textSweepFixture() {
    const vm=require('node:vm');
    const js=fs.readFileSync(path.resolve(__dirname,'../../../client/tex-viewer.js'),'utf8');
    const code=js.slice(js.indexOf('const nativeTextPages = new Map();'),js.indexOf('const wordKey ='));
    const posts=[], reads=[];
    const makeDoc=label => ({ getPage:async page => {
        reads.push(`${label}:${page}`);
        return { getViewport:()=>({ transform:[1,0,0,1,0,0] }), getTextContent:async()=>({ items:[
            { str:`${label} page ${page}`,transform:[1,0,0,10,0,20],width:10,fontName:'font' } ] }) };
    } });
    const state={ generation:1,pageCount:2,nativePageHashes:['a'.repeat(64),'b'.repeat(64)],doc:makeDoc('old') };
    const context=vm.createContext({ state,vscode:{ postMessage:m=>posts.push(m) },now:()=>0,
        mul:(_,b)=>b,setTimeout:fn=>fn() });
    vm.runInContext(code,context);
    return { state,posts,reads,makeDoc,run:g=>context.sendTextLayer(g) };
}

test('native text sweeps reuse unchanged pages but re-extract changed and conventional pages', async () => {
    const f=textSweepFixture();
    await f.run(1);
    f.state.generation=2; f.state.doc=f.makeDoc('new');
    f.state.nativePageHashes=['a'.repeat(64),'c'.repeat(64)];
    await f.run(2);
    assert.deepEqual(f.reads,['old:1','old:2','new:2']);
    const pages=f.posts.filter(m=>m.type==='textLayer' && m.generation===2);
    assert.equal(pages[0].items[0].str,'old page 1');
    assert.equal(pages[1].items[0].str,'new page 2');
    assert.deepEqual(Array.from(f.posts.at(-1).reusedPages),[1]);
    f.state.generation=3; f.state.doc=f.makeDoc('ordinary'); f.state.nativePageHashes=null;
    await f.run(3);
    assert.deepEqual(f.reads.slice(-2),['ordinary:1','ordinary:2']);
    assert.deepEqual(Array.from(f.posts.at(-1).reusedPages),[]);
});

test('a text sweep superseded during PDF extraction cannot post or cache its result', async () => {
    for (const sameGeneration of [false,true]) {
        const f=textSweepFixture(); let release, started;
        const pending=new Promise(resolve=>{ started=resolve; });
        f.state.doc={ getPage:async()=>({ getViewport:()=>({ transform:[] }),getTextContent:()=>{
            started(); return new Promise(resolve=>{ release=resolve; });
        } }) };
        const run=f.run(1); await pending;
        f.state.doc=f.makeDoc('replacement');
        f.state.generation=sameGeneration ? 1 : 2;
        release({ items:[] }); await run;
        assert.equal(f.posts.length,0);
        await f.run(f.state.generation);
        assert.deepEqual(f.reads,['replacement:1','replacement:2']);
    }
});

test('host ignores stale PDF text rather than replacing the displayed generation cache', () => {
    const text={ generation:7,pages:new Map(),symbolFonts:new Set() };
    const viewer={ shownGeneration:7,_text:text,_objMaps:new Map([['retained',1]]) };
    TexViewer.prototype._onTextLayer.call(viewer,{ generation:6,page:1,items:[] });
    assert.equal(viewer._text,text);
    assert.equal(viewer._objMaps.size,1);
    TexViewer.prototype._onTextLayer.call(viewer,{ generation:7,page:1,items:[] });
    assert.equal(viewer._text.pages.size,1);
});

test('failed PDF text extraction is not cached as a successful empty page', async () => {
    const f=textSweepFixture();
    const healthy=f.state.doc;
    f.state.doc={ getPage:async page => {
        if (page===1) throw Error('temporary PDF read failure');
        return healthy.getPage(page);
    } };
    await f.run(1);
    assert.equal(f.posts.find(m=>m.type==='textLayer' && m.page===1).items.length,0);
    f.state.generation=2; f.state.doc=f.makeDoc('recovered');
    await f.run(2);
    assert.deepEqual(f.reads,['old:2','recovered:1']);
    assert.equal(f.posts.find(m=>m.type==='textLayer' && m.generation===2 && m.page===1).items[0].str,'recovered page 1');
    assert.deepEqual(Array.from(f.posts.at(-1).reusedPages),[2]);
});

test('unqualified page hashes and changed page indices cannot reuse native text', async () => {
    for (const hashes of [['invalid','invalid'],['a'.repeat(63),'b'.repeat(65)]]) {
        const f=textSweepFixture(); f.state.nativePageHashes=hashes;
        await f.run(1);
        f.state.generation=2; f.state.doc=f.makeDoc('new');
        await f.run(2);
        assert.deepEqual(f.reads,['old:1','old:2','new:1','new:2']);
        assert.deepEqual(Array.from(f.posts.at(-1).reusedPages),[]);
    }
    const f=textSweepFixture(); await f.run(1);
    f.state.generation=2; f.state.doc=f.makeDoc('reordered');
    f.state.nativePageHashes=['b'.repeat(64),'a'.repeat(64)];
    await f.run(2);
    assert.deepEqual(f.reads.slice(-2),['reordered:1','reordered:2']);
    assert.deepEqual(Array.from(f.posts.at(-1).reusedPages),[]);
});

test('removing native pages evicts their text instead of reusing it if the page later returns', async () => {
    const f=textSweepFixture(); await f.run(1);
    f.state.generation=2; f.state.doc=f.makeDoc('short'); f.state.pageCount=1;
    f.state.nativePageHashes=['a'.repeat(64)]; await f.run(2);
    f.state.generation=3; f.state.doc=f.makeDoc('restored'); f.state.pageCount=2;
    f.state.nativePageHashes=['a'.repeat(64),'b'.repeat(64)]; await f.run(3);
    assert.deepEqual(f.reads,['old:1','old:2','restored:2']);
    assert.deepEqual(Array.from(f.posts.at(-1).reusedPages),[1]);
});


test('live overlay pages carry their own hyperlinks and destinations', async () => {
    const vm = require('node:vm');
    const { pathToFileURL } = require('node:url');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const txdlCanvas = await import(pathToFileURL(path.resolve(__dirname, '../../../client/txdl-canvas.js')).href);
    const fn = name => { const start = js.indexOf(`function ${name}(`); return js.slice(start, js.indexOf('\n}\n', start) + 2); };
    const sp = pt => Math.round(pt * 65536);
    const txdl = { media_size_sp: [sp(600), sp(800)], fonts: [{ definition_digest: 'f', size_sp: sp(10) }], ops: [
        { op: 'dest', name: 'section.1', x: 0, y: sp(100) },
        { op: 'link', rect: { x0: sp(10), y0: sp(20), x1: sp(30), y1: sp(32) }, target: 'section.1' },
        { op: 'glyphs', font: 'f', glyphs: [[49, sp(10), sp(30)]] },
        { op: 'link', rect: { x0: 0, y0: sp(20), x1: sp(400), y1: sp(60) }, target: 'https://example.org' },
        { op: 'glyphs', font: 'f', glyphs: [[50, sp(300), sp(30)]] },
    ] };
    const made = [];
    const node = () => { const el = { style: {}, classList: new Set(), attrs: {}, removed: false,
        setAttribute(k, v) { el.attrs[k] = v; }, remove() { el.removed = true; } };
        Object.defineProperty(el, 'className', { set(v) { el._class = v; for (const c of v.split(' ')) el.classList.add(c); }, get() { return el._class; } });
        return el; };
    const wrap = { offsetTop: 1000, children: [], appendChild(el) { this.children.push(el); made.push(el); },
        querySelectorAll(sel) { return this.children.filter(el => !el.removed && sel.split('.').slice(1).every(c => el.classList.has(c))); } };
    let scrolled = null, relinked = [];
    const context = vm.createContext({
        linkLayer: txdlCanvas.linkLayer, pageToCss: txdlCanvas.pageToCss, PT_PER_BP: 72.27 / 72,
        state: { txdl: { pages: new Map([[3, { txdl }]]) }, rendered: new Map([[3, {}]]) },
        document: { createElement: () => node(), querySelector: () => ({ clientHeight: 400, scrollTo: o => { scrolled = o; } }) },
        pagesEl: () => ({ querySelector: () => wrap }),
        txdlPageBox: () => ({ width: 1200, height: 1600, widthBp: 600 * 72 / 72.27 }),
        paintLinks: async page => { relinked.push(page); }, status: () => {},
    });
    vm.runInContext(fn('paintLiveLinks') + fn('restorePdfLinks') + fn('followLiveDest'), context);
    // CSS px per pt = 1200 / 600 = 2; the page origin sits one inch (72.27 pt) in.
    context.paintLiveLinks(3, wrap, txdl, 2, [600, 800]);
    assert.equal(made.length, 1, 'the wrapped link (40 pt tall over 10 pt text) is left out');
    const [link] = made;
    assert.equal(link._dest, 'section.1');
    assert.ok(link.classList.has('live') && link.classList.has('pdflink'));
    assert.equal(parseFloat(link.style.left), (72.27 + 10) * 2);
    assert.equal(parseFloat(link.style.top), (72.27 + 20) * 2);
    assert.equal(parseFloat(link.style.width), 40);
    // The destination is found on the live page: 1000 + (72.27 + 100) * 2 - 400 / 4.
    assert.equal(context.followLiveDest('section.1'), true);
    assert.ok(Math.abs(scrolled.top - (1000 + (72.27 + 100) * 2 - 100)) < 1e-6);
    assert.equal(context.followLiveDest('elsewhere'), false, 'unknown names go to the PDF');
    // The overlay goes: the live links go and the PDF's come back.
    context.restorePdfLinks(3);
    assert.equal(link.removed, true);
    assert.deepEqual(relinked, [3]);
});


test('exported SyncTeX names project inputs by absolute path and is gzipped', () => {
    const zlib = require('node:zlib');
    const os = require('node:os');
    const load = Module._load;
    Module._load = function (req, ...args) { return req === 'vscode' ? stub : load.call(this, req, ...args); };
    let exportSynctex;
    try { ({ exportSynctex } = require('../../tex/index.js')); } finally { Module._load = load; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-synctex-'));
    try {
        fs.mkdirSync(path.join(dir, 'ch'));
        fs.writeFileSync(path.join(dir, 'main.tex'), '');
        fs.writeFileSync(path.join(dir, 'ch/one.tex'), '');
        const text = 'SyncTeX Version:1\nInput:1:main.tex\nInput:2:article.cls\nInput:6:ch/one.tex\nInput:7:/abs/x.tex\nOutput:pdf\n';
        const out = zlib.gunzipSync(exportSynctex(text, dir)).toString('utf8');
        assert.equal(out, 'SyncTeX Version:1\n' +
            `Input:1:${path.join(dir, 'main.tex')}\nInput:2:article.cls\n` +
            `Input:6:${path.join(dir, 'ch/one.tex')}\nInput:7:/abs/x.tex\nOutput:pdf\n`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('live TeX errors are marked on the page they were typeset on', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf('function paintLiveErrors(');
    const made = [], posted = [];
    const node = () => { const el = { listeners: {}, removed: false, className: '',
        addEventListener(type, fn) { el.listeners[type] = fn; }, remove() { el.removed = true; } }; return el; };
    const wraps = new Map([[2, { appendChild(el) { made.push(el); } }]]);
    const context = vm.createContext({
        state: {}, vscode: { postMessage: m => posted.push(m) },
        document: { createElement: () => node(), querySelectorAll: () => made.filter(el => !el.removed) },
        pagesEl: () => ({ querySelector: sel => wraps.get(Number(/data-page="(\d+)"/.exec(sel)[1])) || null }),
    });
    vm.runInContext(js.slice(start, js.indexOf('\n}\n', start) + 2), context);
    context.paintLiveErrors([
        { page: 2, file: '/p/paper.tex', name: 'paper.tex', line: 5, message: 'Undefined control sequence.' },
        { page: 2, file: '/p/paper.tex', name: 'paper.tex', line: 6, message: 'Missing $ inserted.' },
        { page: 5, file: '/p/paper.tex', name: 'paper.tex', line: 40, message: 'not on screen' },
        { page: null, file: null, line: null, message: 'Emergency stop.' },
    ]);
    assert.equal(made.length, 1, 'one mark per page that is on screen');
    assert.equal(made[0].className, 'live-error');
    assert.equal(made[0].textContent, 'Undefined control sequence. — paper.tex:5 (+1 more on this page)');
    made[0].listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'openSourceLine', file: '/p/paper.tex', line: 5 }]);
    assert.equal(context.state.liveErrors.length, 4, 'kept for a zoom to repaint');
    // A build without errors clears the marks.
    context.paintLiveErrors([]);
    assert.equal(made[0].removed, true);
    assert.equal(context.state.liveErrors, null);
});


test('live overlays are drawn near the viewport only, and their number is bounded', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const fn = name => { const start = js.indexOf(`function ${name}(`); return js.slice(start, js.indexOf('\n}\n', start) + 2); };
    const constant = name => { const start = js.indexOf(`const ${name} =`); return js.slice(start, js.indexOf(';', start) + 1); };
    const context = vm.createContext({});
    vm.runInContext(constant('TXDL_DRAW_MARGIN') + constant('TXDL_MAX_OVERLAYS') + fn('txdlShouldDefer') + fn('txdlEvictions')
        + 'this.margin = TXDL_DRAW_MARGIN; this.cap = TXDL_MAX_OVERLAYS;', context);
    const { txdlShouldDefer, txdlEvictions, margin, cap } = context;
    assert.equal(margin, 2);
    // Viewing pages 10-11: 8..13 draw now, the rest wait.
    assert.deepEqual([7, 8, 13, 14].map(p => txdlShouldDefer(p, [10, 11])), [true, false, false, true]);
    assert.equal(txdlShouldDefer(90, []), false, 'without a viewport everything draws');
    // Over the cap, the farthest from view go first (ties: the later page).
    const pages = Array.from({ length: cap + 3 }, (_, i) => i + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(txdlEvictions(pages, [3], cap))), [cap + 3, cap + 2, cap + 1]);
    assert.deepEqual(JSON.parse(JSON.stringify(txdlEvictions(pages, [cap + 3], cap))), [1, 2, 3]);
    assert.equal(txdlEvictions(pages.slice(0, cap), [1], cap).length, 0);
});


test('a change of screen density redraws the pages at the same scale', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf('(function watchDensity() {');
    const source = js.slice(start, js.indexOf('})();', start) + 5);
    const queries = [], calls = [];
    const window = { devicePixelRatio: 2, matchMedia(query) {
        const mq = { query, listeners: new Set(), addEventListener(_, fn) { this.listeners.add(fn); },
            removeEventListener(_, fn) { this.listeners.delete(fn); } };
        queries.push(mq); return mq; } };
    const context = vm.createContext({ window, state: { doc: {}, scale: 1.5 },
        setScale: (...args) => calls.push(args), scrollAnchor: () => 'anchor' });
    vm.runInContext(source, context);
    assert.equal(queries[0].query, '(resolution: 2dppx)');
    window.devicePixelRatio = 1;
    [...queries[0].listeners][0]();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[1.5, 'anchor', true]]);
    assert.equal(queries[0].listeners.size, 0, 'the old query is released');
    assert.equal(queries[1].query, '(resolution: 1dppx)', 'and the new density is watched');
});


test('the TikZ editor resolves paths to statements, edits them as one undo step, and undoes', async () => {
    const root = '/paper/main.tex';
    let text = 'A\n\\begin{tikzpicture}[scale=0.5]\n  \\draw[red] (0,0) -- (2,1);\n  \\node (a) at (1,1) {x};\n\\end{tikzpicture}\n';
    const lineStarts = () => [0, ...[...text].flatMap((c, i) => c === '\n' ? [i + 1] : [])];
    const doc = { uri: { fsPath: root }, version: 1, isDirty: false,
        getText: () => text,
        positionAt: offset => ({ offset }),
        offsetAt: p => lineStarts()[p.line] + p.character };
    const posts = [];
    const saved = { ...stub.workspace };
    stub.workspace.textDocuments = [doc];
    stub.Position = class { constructor(line, character) { this.line = line; this.character = character; } };
    stub.Range = class { constructor(start, end) { this.start = start; this.end = end; } };
    stub.Selection = class { constructor(a, b) { this.anchor = a; this.active = b; } };
    stub.TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
    stub.window.showTextDocument = async () => ({ selection: null, revealRange() {} });
    stub.WorkspaceEdit = class { constructor() { this.ops = []; }
        replace(uri, range, value) { this.ops.push([range.start.offset, range.end.offset, value]); } };
    stub.workspace.applyEdit = async edit => {
        for (const [s0, e0, v] of [...edit.ops].sort((x, y) => y[0] - x[0])) text = text.slice(0, s0) + v + text.slice(e0);
        doc.version++;
        return true;
    };
    const draw = text.indexOf('\\draw'), begin = text.indexOf('\\begin');
    const at = offset => { const starts = lineStarts(); const line = starts.filter(s => s <= offset).length;
        return { line, column_utf16: offset - starts[line - 1] }; };
    const lane = { liveSpecials: async (page, ordinals) => ordinals.map(n => ({ definition: null,
        invocation: { file: root, location: { start: at(n === 17 ? draw + 6 : begin), end: at(draw) } } })) };
    const viewer = Object.create(TexViewer.prototype);
    Object.assign(viewer, { root, panel: {}, coord: { roots: new Map([[root, { nativeLane: lane }]]) }, _post: m => posts.push(m) });
    const original = text;
    try {
        await viewer._tikzResolve({ key: 'k', page: 1, specials: [17], pictures: [7] });
        const resolved = posts.pop();
        assert.equal(resolved.error, null);
        const pic = resolved.pictures[7];
        assert.equal(pic.scale, 0.5);
        assert.deepEqual(pic.statements.map(s => [s.kind, s.name]), [['draw', null], ['node', 'a']]);
        // The span pointed inside the \draw: the path belongs to that statement.
        assert.deepEqual(resolved.paths[17], { picture: 7, stmt: pic.statements[0].start });
        const node = pic.statements[1];

        // A move of 1 cm on the page is 2 units in a picture at scale 0.5; a node moves by its coordinates.
        const cm = 72 / 2.54;
        await viewer._tikzEdit({ key: 1, op: 'move', picture: { file: root, begin: pic.begin }, refs: [{ start: node.start, text: node.text }], dx: cm, dy: 0, snap: false });
        const edited = posts.filter(m => m.type === 'tikzEdited').pop();
        assert.equal(edited.ok, true, edited.error);
        assert.match(text, /\\node \(a\) at \(3,1\) \{x\};/);

        // A stale statement is refused; nothing changes.
        const before = text;
        await viewer._tikzEdit({ key: 2, op: 'move', picture: { file: root, begin: pic.begin }, refs: [{ start: node.start, text: 'other' }], dx: cm, dy: 0 });
        assert.match(posts.filter(m => m.type === 'tikzEdited').pop().error, /changed/);
        assert.equal(text, before);

        // The editor's undo restores the source; redo re-applies.
        await viewer._tikzEdit({ key: 3, op: 'undo' });
        assert.equal(text, original);
        await viewer._tikzEdit({ key: 4, op: 'redo' });
        assert.match(text, /\(a\) at \(3,1\)/);

        // Files outside the paper's folder are never edited.
        await viewer._tikzEdit({ key: 5, op: 'delete', picture: { file: '/elsewhere/x.tex', begin: 0 }, refs: [] });
        assert.equal(posts.filter(m => m.type === 'tikzEdited').pop().ok, false);
    } finally { Object.assign(stub.workspace, saved); }
});

test('TikZ drags become moves, snapped scales and 15° rotations', async () => {
    const vm = require('node:vm');
    const { pathToFileURL } = require('node:url');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf('function tikzDragTransform(');
    const tikzGeom = await import(pathToFileURL(path.resolve(__dirname, '../../../client/tikz-geom.mjs')).href);
    const context = vm.createContext({ tikz: { snap: true, selection: null, pages: new Map() }, tikzGeom, TIKZ_GUIDE_PX: 7 });
    vm.runInContext(js.slice(start, js.indexOf('\n}\n', start) + 2), context);
    const drag = (kind, x, y, ev) => JSON.parse(JSON.stringify(context.tikzDragTransform({ kind, x0: 110, y0: 100, cx: 100, cy: 100 }, x, y, ev)));
    assert.deepEqual(drag('move', 130, 90), { svg: 'translate(20 -10)', none: false, op: 'move', dx: 20, dy: -10, guides: [] });
    assert.equal(drag('move', 110.5, 100).none, true, 'a click is not a move');
    assert.equal(drag('scale', 124, 100).factor, 2.4);
    assert.equal(drag('scale', 124.3, 100, { metaKey: true }).factor.toFixed(3), '2.430', '⌘ turns snapping off');
    // Screen angles run clockwise; the rotation snaps to 15°.
    assert.equal(drag('rotate', 100, 111).deg, 90);
    assert.equal(drag('rotate', 110, 101).none, true);
});

test('a keystroke with no preview build running starts one at once; a burst while one runs coalesces', async () => {
    const f = fixture();
    try {
        const { coordinator, state, root } = { ...f, root: f.state.root };
        state.nativeLane = { interactive: true, close: async () => {}, invalidate() {} };
        coordinator.liveOverlay = () => new Map();
        coordinator._nativeWindow = () => [];
        const started = [];
        let finish = null;
        coordinator._runInteractive = () => { started.push(Date.now()); return new Promise(resolve => { finish = resolve; }); };
        const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
        assert.equal(coordinator._schedulePreview(root, state), true);
        await tick(5);
        assert.equal(started.length, 1, 'idle: the build starts at once, not after the throttle');
        for (let i = 0; i < 20; i++) { coordinator._schedulePreview(root, state); await tick(1); }
        assert.equal(started.length, 1, 'while it runs, keystrokes wait');
        await tick(60);
        assert.equal(started.length, 2, 'the burst becomes one build after the throttle');
        finish(); await tick(5);
        finish(); await tick(5);
        coordinator._schedulePreview(root, state);
        await tick(5);
        assert.equal(started.length, 3, 'idle again: at once');
        finish();
    } finally { f.close(); }
});
