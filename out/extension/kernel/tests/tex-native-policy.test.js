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
let installed = true, constructorCalls = 0;
stub.workspace.getConfiguration = () => ({ get: (key, fallback) =>
    ({ mapEngine: configuredMapEngine, wlatexDirectory: '/built/wlatex', authoritativeDelayMs: 0 })[key] ?? fallback });
let nativeCalls = 0, conventionalCalls = 0, cancel = false, nativeFailure = false;
const oldLoad = Module._load;
Module._load = function (req, ...args) {
    if (req === 'vscode') return stub;
    if (req === './nativeCompileService') return { NativeBuildLane: class {
        constructor() { constructorCalls++; if (!installed) throw Error('runtime missing'); this.directory = '/built/wlatex'; }
        async compile(o) {
            nativeCalls++;
            if (nativeFailure) throw Error('runtime cannot start');
            if (cancel) throw Object.assign(Error('superseded'), { name: 'AbortError' });
            return { ok:true, runner:'wlatex', generation:nativeCalls, pdfPath:'unused', pdfHash:'native',
                sourceSnapshotHash:o.sourceSnapshotHash, nativeCompiledSources:new Map(),
                pageCount:1, rerunWanted:true, diagnostics:[] };
        }
        invalidate() { this.invalidated = true; }
        async close() {}
    } };
    const result = oldLoad.call(this, req, ...args);
    if (req === './compileService') return { ...result,
        loadGeneration: () => null, saveGeneration: () => false,
        compile: async o => { conventionalCalls++; return { ok:true, generation:100,
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
