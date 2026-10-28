'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { ExternalBuildQueue, gitWorktreeBusy } = require('../../tex/externalBuildQueue');

function clock() {
    let time = 0, id = 0; const timers = new Map();
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    return { now: () => time, setTimer: (fn, delay) => { timers.set(++id, { fn, at: time + delay }); return id; },
        clearTimer: id => timers.delete(id), settle,
        async tick(ms) {
            const end = time + ms;
            while (true) {
                const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                time = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
            }
            time = end; await settle();
        } };
}
const pending = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

test('hundreds of file/reload/review arrivals form one compile of the final source', async () => {
    const c = clock(), builds = []; let version = 0, compiled = -1;
    const q = new ExternalBuildQueue({ ...c, needed: () => compiled !== version,
        run: async () => { builds.push(version); compiled = version; } });
    for (let i = 0; i < 100; i++) {
        version++;
        q.notify('paper'); q.notify('paper'); q.notify('paper'); // disk, reload, review
        await c.tick(20);
    }
    assert.equal(builds.length, 0, 'no compiler starts in the middle of the burst');
    await c.tick(1000); assert.deepEqual(builds, [100]);
    for (let i = 0; i < 200; i++) q.notify('paper'); // slow review preparation finishes late
    await c.tick(1000); assert.deepEqual(builds, [100], 'late notifications for included bytes do not recompile');
    q.dispose();
});
test('a burst during a running build gets one follow-up, after the writes settle', async () => {
    const c = clock(), gate = pending(), builds = []; let version = 1, compiled = 0;
    const q = new ExternalBuildQueue({ ...c, needed: () => compiled !== version, run: async () => {
        const captured = version; builds.push(captured); if (builds.length === 1) await gate.promise; compiled = captured;
    } });
    q.notify('paper'); await c.tick(1000);
    for (let i = 0; i < 50; i++) { version++; q.notify('paper'); await c.tick(20); }
    assert.deepEqual(builds, [1]); gate.release(); await c.settle();
    await c.tick(979); assert.deepEqual(builds, [1]);
    await c.tick(1); assert.deepEqual(builds, [1, 51]);
    assert.equal(q.has('paper'), false); q.dispose();
});
test('notifications during a build which already contains them do not create another compile', async () => {
    const c = clock(), gate = pending(); let count = 0, needed = true;
    const q = new ExternalBuildQueue({ ...c, needed: () => needed, run: async () => {
        count++; await gate.promise; needed = false;
    } });
    q.notify('paper'); await c.tick(1000);
    for (let i = 0; i < 300; i++) q.notify('paper');
    gate.release(); await c.settle(); await c.tick(1000);
    assert.equal(count, 1); q.dispose();
});
test('an existing manual build/preparation is allowed to finish before the batch starts', async () => {
    const c = clock(); let busy = true, count = 0;
    const q = new ExternalBuildQueue({ ...c, busy: () => busy, run: async () => { count++; } });
    q.notify('paper'); await c.tick(6000); assert.equal(count, 0);
    busy = false; await c.tick(100); assert.equal(count, 1); q.dispose();
});
test('Git worktree locks keep a long checkout together across quiet gaps', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-git-burst-'));
    try {
        const root = path.join(directory, 'parts', 'paper.tex'); fs.mkdirSync(path.dirname(root));
        fs.mkdirSync(path.join(directory, '.git')); const lock = path.join(directory, '.git', 'index.lock'); fs.writeFileSync(lock, '');
        const c = clock(); let count = 0;
        const q = new ExternalBuildQueue({ ...c, busy: () => gitWorktreeBusy(root), run: async () => { count++; } });
        q.notify(root); await c.tick(4000); assert.equal(count, 0, 'no partial checkout is compiled');
        fs.unlinkSync(lock); await c.tick(100); assert.equal(count, 1);
        const gitDir = path.join(directory, 'worktree-metadata'); fs.mkdirSync(gitDir);
        fs.rmSync(path.join(directory, '.git'), { recursive: true }); fs.writeFileSync(path.join(directory, '.git'), 'gitdir: worktree-metadata\n');
        fs.writeFileSync(path.join(gitDir, 'index.lock'), ''); assert.equal(gitWorktreeBusy(root), true);
        fs.unlinkSync(path.join(gitDir, 'index.lock')); assert.equal(gitWorktreeBusy(root), false); q.dispose();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('papers have independent batches, and cancellation/disposal leave no delayed work', async () => {
    const c = clock(), builds = [];
    const q = new ExternalBuildQueue({ ...c, run: async root => builds.push(root) });
    q.notify('one'); q.notify('two'); q.cancel('one'); await c.tick(1000);
    assert.deepEqual(builds, ['two']);
    q.notify('three'); q.dispose(); await c.tick(1000); assert.deepEqual(builds, ['two']);
});
test('a cancelled active batch cannot requeue old notifications after manual Compile supersedes it', async () => {
    const c = clock(), gate = pending(); let count = 0;
    const q = new ExternalBuildQueue({ ...c, run: async () => { count++; await gate.promise; } });
    q.notify('paper'); await c.tick(1000); q.notify('paper'); q.cancel('paper');
    gate.release(); await c.settle(); await c.tick(1000); assert.equal(count, 1); assert.equal(q.has('paper'), false);
});

module.exports = { clock };

// Drive the real coordinator and build admission path; only the compiler and
// map decoder are stubbed. Count actual compile calls, not just queue callbacks.
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');
const stub = makeVscodeStub();
let mapEngine = 'synctex', compilingOff = false, compileHook = null;
const compilerCalls = [];
stub.workspace.getConfiguration = () => ({ get: (key, fallback) => ({
    mapEngine, engine: 'xelatex', compile: compilingOff ? 'off' : 'onSave', authoritativeDelayMs: 0,
    liveRenderDelayMs: 1000, wlatexDirectory: '/test/wlatex',
})[key] ?? fallback });
stub.workspace.openTextDocument = async uri => ({ uri: typeof uri === 'string' ? stub.Uri.file(uri) : uri,
    getText: () => fs.readFileSync(typeof uri === 'string' ? uri : uri.fsPath, 'utf8'), isDirty: false });
async function fakeCompile(options, runner) {
    compilerCalls.push({ options, runner });
    if (compileHook) await compileHook(options);
    return { ok: true, runner, generation: compilerCalls.length, pdfPath: 'fixture.pdf', pdfHash: options.sourceSnapshotHash,
        sourceSnapshotHash: options.sourceSnapshotHash, pageCount: 1, pageSize: { widthBp: 612, heightBp: 792 },
        nativeCompiledSources: new Map(), passesLimited: false, rerunWanted: false, diagnostics: [], errors: 0 };
}
const originalLoad = Module._load;
Module._load = function (request, ...args) {
    if (request === 'vscode') return stub;
    if (request === './nativeRuntime') return {hasNativeRuntime:()=>true};
    if (request === './nativeCompileService') return { NativeBuildLane: class {
        constructor() { this.directory = '/test/wlatex'; }
        compile(options) { return fakeCompile(options, 'wlatex'); }
        invalidate() {} async close() {} async noteChange() {}
    } };
    const original = originalLoad.call(this, request, ...args);
    if (request === './compileService') return { ...original, compile: options => fakeCompile(options, 'latexmk'),
        loadGeneration: () => null, saveGeneration: () => {}, probeLualatex: async () => false };
    if (request === './renderMap') return { ...original, RenderMap: class {
        constructor({ generation }) { this.available = true; this.native = generation.runner === 'wlatex'; this.exact = this.native; }
        noteEdit() { this.available = false; } lineRows() { return []; }
    } };
    return original;
};
let RenderCoordinator;
try { ({ RenderCoordinator } = require('../../tex/renderUi')); }
finally { Module._load = originalLoad; }
async function coordinatorFixture(engine) {
    mapEngine = engine; compilingOff = false; compileHook = null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-batch-coordinator-'));
    const root = path.join(dir, 'paper.tex'), child = path.join(dir, 'child.tex');
    fs.writeFileSync(root, '\\documentclass{article}\n\\begin{document}\\input{child}\\end{document}');
    fs.writeFileSync(child, 'Original child.');
    const coord = new RenderCoordinator({ get: () => ({ model: { objects: [] } }) }, { appendLine() {} });
    const doc = await stub.workspace.openTextDocument(root); stub.workspace.textDocuments = [doc];
    coord.rootFor(doc); coord._luaOk = false;
    await coord.build(doc, { quiet: true }); compilerCalls.length = 0;
    const c = clock(); Object.assign(coord._externalBuilds, { now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    return { dir, root, child, doc, coord, c, st: coord.roots.get(root),
        close() { compileHook = null; coord.dispose(); stub.workspace.textDocuments = []; fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('real coordinator unifies disk, buffer, saves and review builds in standard and Pro modes', async () => {
    for (const engine of ['synctex', 'wlatex']) {
        const f = await coordinatorFixture(engine);
        try {
            f.coord.scheduleLive(f.doc); // old typing timer must be superseded
            for (let i = 0; i < 50; i++) {
                fs.writeFileSync(f.child, `Git revision ${i}.`);
                f.coord.invalidate(f.child);
                f.coord.scheduleExternal({ uri: stub.Uri.file(f.child) });
                f.coord.scheduleLive(f.doc); // clean buffer reload
                await f.coord.build(f.doc, { authoritative: true, quiet: true }); // save echo
                f.coord.scheduleExternal(f.doc); // review notification
                await f.c.tick(10);
            }
            assert.equal(compilerCalls.length, 0);
            assert.equal(f.coord._liveTimers.size, 0);
            assert.equal(f.coord._idleTimers.size, 0);
            await f.c.tick(1000); await f.c.settle();
            assert.equal(compilerCalls.length, 1, engine);
            assert.equal(compilerCalls[0].options.maxPasses, engine === 'synctex' ? null : undefined);
            assert.equal(f.st.sourceAhead, false);
            for (let i = 0; i < 200; i++) f.coord.scheduleExternal(f.doc);
            await f.c.tick(1000); assert.equal(compilerCalls.length, 1, 'late review preparation must not compile again');
        } finally { f.close(); }
    }
});
test('a late reload of identical bytes does not cancel or discard the completed external build', async () => {
    const f = await coordinatorFixture('wlatex'), gate = pending();
    try {
        fs.writeFileSync(f.child, 'New git content.'); f.coord.invalidate(f.child);
        compileHook = () => gate.promise;
        f.coord.scheduleExternal(f.doc); await f.c.tick(1000); await f.c.settle();
        assert.equal(compilerCalls.length, 1); const signal = compilerCalls[0].options.signal;
        f.coord.invalidate(f.child); f.coord.scheduleExternal(f.doc); // duplicate arrival, same source
        gate.release(); await f.c.settle(); await f.c.tick(1000);
        assert.equal(signal.aborted, false);
        assert.equal(compilerCalls.length, 1, 'accept the bytes already built despite the revision bump');
        assert.equal(f.st.sourceAhead, false);
        assert.equal(f.st.compileDiagnostics.revision, f.st.sourceRevision, 'diagnostics describe the identical current source');
    } finally { f.close(); }
});
test('manual Compile supersedes the pending batch and disabling compilation prevents automatic work', async () => {
    const f = await coordinatorFixture('synctex');
    try {
        fs.writeFileSync(f.child, 'Manual compile content.'); f.coord.invalidate(f.child); f.coord.scheduleExternal(f.doc);
        await f.coord.build(f.doc, { force: true, quiet: true });
        await f.c.tick(1000); assert.equal(compilerCalls.length, 1); assert.equal(f.coord._externalBuilds.has(f.root), false);
        compilerCalls.length = 0; compilingOff = true; f.coord.scheduleExternal(f.doc); await f.c.tick(2000);
        assert.equal(compilerCalls.length, 0);
    } finally { f.close(); compilingOff = false; }
});
test('reader typing retains incremental preview while its full build joins the external batch', async () => {
    const f = await coordinatorFixture('wlatex'); let previews = 0;
    try {
        fs.writeFileSync(f.child, 'Incoming change.'); f.coord.invalidate(f.child); f.coord.scheduleExternal(f.doc);
        f.coord._schedulePreview = () => { previews++; return true; };
        f.coord.scheduleLive(f.doc); assert.equal(previews, 0, 'a clean Git reload does not start partial preview builds');
        f.doc.isDirty = true; f.coord.scheduleLive(f.doc);
        assert.equal(previews, 1, 'the reader can still preview typing immediately');
        assert.equal(f.coord._liveTimers.size, 0, 'no second full-build timer');
        await f.c.tick(1000); assert.equal(compilerCalls.length, 1);
    } finally { f.close(); }
});
test('an identical disk echo recovers the native map without compiling the document again', async () => {
    const f = await coordinatorFixture('wlatex'); let refreshes = 0;
    try {
        f.coord._scheduleNativeRefresh = () => { refreshes++; };
        f.coord.invalidate(f.root); f.coord.scheduleExternal(f.doc);
        await f.c.tick(1000);
        assert.equal(compilerCalls.length, 0);
        assert.equal(refreshes, 1);
        assert.equal(f.st.sourceAhead, false);
    } finally { f.close(); }
});
test('external arrivals cannot supersede a manual Compile still preparing its engine', async () => {
    const f = await coordinatorFixture('synctex'), gate = pending();
    try {
        const original = f.coord._build; let preparing = true;
        f.coord._build = async function(doc, options) {
            if (preparing) { preparing = false; await gate.promise; }
            return original.call(this, doc, options);
        };
        const manual = f.coord.build(f.doc, { force: true, quiet: true });
        fs.writeFileSync(f.child, 'Changed while the manual compiler was preparing.'); f.coord.invalidate(f.child);
        f.coord.scheduleExternal(f.doc); await f.c.tick(5000);
        assert.equal(compilerCalls.length, 0, 'external work waits during preparation');
        gate.release(); await manual; await f.c.tick(100);
        assert.equal(compilerCalls.length, 1, 'the manual build already includes the batch');
    } finally { f.close(); }
});
test('a lagging clean Git reload cannot overlay newer disk bytes with an intermediate version', async () => {
    const f = await coordinatorFixture('wlatex');
    try {
        const original = fs.readFileSync(f.root, 'utf8');
        f.doc.getText = () => original + '\nIntermediate loaded version.';
        f.doc.version = 2;
        f.st.pendingOverlayVersions = new Map([[f.root, 2]]);
        fs.writeFileSync(f.root, original + '\nFinal Git version.');
        f.coord.noteChange({ document: f.doc, contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } },
            rangeOffset: 0, rangeLength: original.length, text: f.doc.getText() }] }, { origin: 'external-reload' });
        assert.equal(f.coord.liveOverlay(f.root), null, 'the clean document cannot shadow Git');
        f.coord.scheduleExternal(f.doc); await f.c.tick(1000);
        assert.equal(compilerCalls.length, 1);
        const { snapshotSources } = require('../../tex/compileService');
        assert.equal(compilerCalls[0].options.sourceSnapshotHash, snapshotSources(f.st.files));
        assert.equal(f.st.sourceAhead, false);
    } finally { f.close(); }
});
test('switching automatic compilation off cancels a batch which has not started yet', async () => {
    const f = await coordinatorFixture('synctex');
    try {
        fs.writeFileSync(f.child, 'An incoming change.'); f.coord.invalidate(f.child); f.coord.scheduleExternal(f.doc);
        compilingOff = true; await f.c.tick(1000);
        assert.equal(compilerCalls.length, 0); assert.equal(f.coord._externalBuilds.has(f.root), false);
    } finally { f.close(); compilingOff = false; }
});
test('late review arrivals cannot retry a failed build of identical bytes', async () => {
    const f = await coordinatorFixture('synctex');
    try {
        fs.writeFileSync(f.child, 'An incoming change which fails compilation.'); f.coord.invalidate(f.child);
        compileHook = async () => { throw Error('fixture compiler failed'); };
        f.coord.scheduleExternal(f.doc); await f.c.tick(1000);
        assert.equal(compilerCalls.length, 1); assert.match(f.st.lastError, /fixture compiler failed/);
        for (let i = 0; i < 100; i++) f.coord.scheduleExternal(f.doc);
        await f.c.tick(1000); assert.equal(compilerCalls.length, 1);
        fs.writeFileSync(f.child, 'A later actual source change.'); f.coord.invalidate(f.child); f.coord.scheduleExternal(f.doc);
        await f.c.tick(1000); assert.equal(compilerCalls.length, 2, 'new source may retry');
    } finally { f.close(); }
});
test('external notifications cannot cancel the reader preview queued by the actual live-preview scheduler', async () => {
    const f = await coordinatorFixture('wlatex'); let previews = 0;
    try {
        f.st.nativeLane.interactive = {};
        f.coord._runInteractive = async () => { previews++; };
        f.coord.scheduleExternal(f.doc); f.doc.isDirty = true; f.coord.scheduleLive(f.doc);
        assert.equal(f.coord._previewTimers.has(f.root), true, 'reader preview remains queued after joining the batch');
        f.coord.scheduleExternal(f.doc); // another incoming change before that preview runs
        assert.equal(f.coord._previewTimers.has(f.root), true, 'incoming changes cannot remove it');
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(previews, 1);
        assert.equal(compilerCalls.length, 0, 'the preview runs before the full batch compiler');
    } finally { f.close(); }
});
