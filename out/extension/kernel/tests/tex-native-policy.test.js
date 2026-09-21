const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { makeVscodeStub } = require('./_stub-vscode');
const stub = makeVscodeStub();
stub.workspace.textDocuments = [];
stub.workspace.getConfiguration = () => ({ get: (key, fallback) =>
    ({ mapEngine: 'wlatex', wlatexDirectory: '/built/wlatex', authoritativeDelayMs: 0 })[key] ?? fallback });
let nativeCalls = 0, conventionalCalls = 0, cancel = false;
const oldLoad = Module._load;
Module._load = function (req, ...args) {
    if (req === 'vscode') return stub;
    if (req === './nativeCompileService') return { NativeBuildLane: class {
        constructor() { this.directory = '/built/wlatex'; }
        async compile(o) {
            nativeCalls++;
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
