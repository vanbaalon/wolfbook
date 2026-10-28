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
let configuredCompiler = 'pdflatex';
let configuredTimeout = 180000;
let configuredAuthoritativeDelay = 0;
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
stub.workspace.openTextDocument = async file => docOf(file.fsPath || file);
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
    ({ engine:configuredCompiler, compileTimeoutMs:configuredTimeout, mapEngine: configuredMapEngine, wlatexDirectory: '/built/wlatex', authoritativeDelayMs: configuredAuthoritativeDelay })[key] ?? fallback });
let nativeCalls = 0, conventionalCalls = 0, cancel = false, nativeFailure = false, nativeSettled = false, nativeDocumentError = false;
let buildHook, conventionalResult;
const oldLoad = Module._load;
Module._load = function (req, ...args) {
    if (req === 'vscode') return stub;
    if (req === './nativeRuntime') return { hasNativeRuntime: () => installed };
    if (req === './nativeCompileService') return { NativeBuildLane: class {
        constructor() { constructorCalls++; if (!installed) throw Error('runtime missing'); this.directory = '/built/wlatex'; }
        async compile(o) {
            nativeCalls++;
            if (buildHook) await buildHook(o, 'native');
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
        async noteChange() {}
        async close() {}
    } };
    const result = oldLoad.call(this, req, ...args);
    if (req === './compileService') return { ...result,
        loadGeneration: () => null, saveGeneration: () => false,
        compile: async o => { conventionalCalls++; if (buildHook) await buildHook(o, 'conventional'); observedTimeouts.push(['conventional', o.timeoutMs]); observedEngines.push(o.engine); return { ok:true, generation:100,
            pdfPath:'unused', sourceSnapshotHash:o.sourceSnapshotHash, pageCount:1, errors:0, diagnostics:[], ...(conventionalResult || {}) }; } };
    return result;
};
let RenderCoordinator, TexViewer, renderDiagnostics;
try {
    ({ RenderCoordinator, renderDiagnostics } = require('../../tex/renderUi'));
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

test('save metadata alone cannot mark either rendering mode behind or invalidate its map', () => {
    for (const native of [false, true]) {
        const f = fixture(); let invalidated = 0;
        try {
            Object.assign(f.state, { sourceAhead: false, lastEditAt: 123,
                map: { native, noteEdit: () => { invalidated++; } },
                nativeLane: native ? { noteChange: async () => { invalidated++; }, close: async () => {} } : null });
            f.coordinator.noteChange({ document: f.doc, contentChanges: [] });
            assert.equal(f.state.sourceAhead, false);
            assert.equal(f.state.lastEditAt, 123);
            assert.equal(invalidated, 0);
        } finally { f.close(); }
    }
});

test('blank-line typing with a current PDF schedules no preview or full compile but keeps native source edits', async t=>{
    t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
    const {snapshotSources}=require('../../tex/compileService');
    for (const native of [false,true]) {
        const f=fixture();let text='Paragraph.\n\nNext.',builds=0,previews=0,sourceEdits=0,mapReads=0;
        try {
            fs.writeFileSync(f.state.root,text);
            Object.assign(f.doc,{getText:()=>text,isDirty:true,version:1});
            stub.workspace.textDocuments=[f.doc];
            f.state.generation={ok:true,sourceSnapshotHash:snapshotSources(f.state.files),pdfPath:'PDF'};
            f.state.sourceAhead=false;
            f.state.map=native ? {native:true,noteEdit(){},available:true} : null;
            f.state.nativeLane=native ? {async noteChange(){sourceEdits++;},async close(){}} : null;
            f.coordinator._scheduleNativeRefresh=()=>{mapReads++;};
            f.coordinator._schedulePreview=()=>{previews++;return true;};
            f.coordinator.build=async()=>{builds++;};
            const at=text.indexOf('\n\n')+1;
            text=text.slice(0,at)+' '+text.slice(at);f.doc.version++;
            const impact=f.coordinator.noteChange({document:f.doc,contentChanges:[{
                rangeOffset:at,rangeLength:0,text:' ',range:{start:{line:1},end:{line:1}}}]});
            assert.equal(impact.renderChanged,false);
            f.coordinator.scheduleLive(f.doc);t.mock.timers.tick(10000);
            await Promise.resolve();
            assert.equal(builds,0);assert.equal(previews,0);
            assert.equal(f.state.sourceAhead,false);
            assert.equal(f.coordinator.isCurrent(f.state,snapshotSources(f.state.files,new Map([[f.state.root,text]]))),true);
            assert.equal(sourceEdits,native?1:0,'native coordinates still follow actual buffer bytes');
            assert.equal(mapReads,native?1:0,'only source-coordinate refresh remains; no typesetting');
        } finally {stub.workspace.textDocuments=[];f.close();}
    }
});

test('full builds wait for a real pause during mini-editor typing or Pro live preview', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    for (const [pro, origin] of [[true, 'editor'], [true, 'mini-editor'], [false, 'mini-editor'], [false, 'editor']]) {
        const f = fixture(); let builds = 0, previews = 0;
        try {
            f.coordinator.noteChange({ document: f.doc,
                contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }] }, { origin });
            assert.equal(f.state.lastEditOrigin, origin, 'the edit origin reaches the scheduling policy');
            f.coordinator._schedulePreview = () => { if (pro) previews++; return pro; };
            f.coordinator.build = async () => { builds++; };
            for (let i = 0; i < 30; i++) {
                f.coordinator.scheduleLive(f.doc);
                t.mock.timers.tick(500);
            }
            assert.equal(builds, 0, `${pro ? 'Pro' : 'standard'} ${origin}: no deadline-forced full build`);
            if (pro) assert.equal(previews, 30, 'live preview still follows every edit');
            t.mock.timers.tick(2500);
            assert.equal(builds, 1, 'one full build after the typing pause');
        } finally { f.close(); }
    }
});

test('automatic full builds are invisible, merge current results and discard results after typing resumes', async () => {
    const oldEngine = configuredMapEngine;
    try {
        for (const engine of ['wlatex', 'off']) {
            configuredMapEngine = engine;
            for (const resumed of [false, true]) {
                const f = fixture();
                let release, started;
                const entered = new Promise(resolve => { started = resolve; });
                const held = new Promise(resolve => { release = resolve; });
                let signal;
                buildHook = async opts => { signal = opts.signal; started(); await held; };
                const prior = { generation: 0, sourceSnapshotHash: 'older', ok: true, pdfPath: 'unused' };
                f.state.generation = prior;
                f.state.map = { available: true };
                const viewer = new TexViewer({}, f.coordinator, {}), posted = [];
                viewer.root = f.state.root;
                viewer._webviewReady = true;
                viewer.panel = { webview: { postMessage: msg => { posted.push(msg); return true; } } };
                viewer._postEngine = () => {};
                viewer._postNativeMapState = () => {};
                let pending;
                try {
                    pending = f.coordinator.build(f.doc, { live: true, authoritative: true });
                    await entered;
                    await viewer.refresh();
                    assert.ok(!posted.some(m => m.type === 'compileState' && m.compiling),
                        `${engine}: the actual viewer never requests the blue shade`);
                    assert.equal(f.state.generation, prior, 'the existing paper stays on screen while building');
                    if (resumed) {
                        f.coordinator.noteChange({ document: f.doc,
                            contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }] });
                        assert.ok(signal.aborted, `${engine}: typing immediately kills the automatic build`);
                    }
                    release(); // Simulate a worker replying even after cancellation.
                    await pending;
                    if (resumed) {
                        assert.equal(f.state.generation, prior, 'a late obsolete PDF is never merged');
                        assert.ok(f.state.sourceAhead, 'the new text still needs its own idle build');
                    } else {
                        assert.notEqual(f.state.generation, prior, 'the current PDF merges after idle');
                        assert.equal(f.state.sourceAhead, false);
                    }
                } finally {
                    release();
                    await pending?.catch(() => {});
                    buildHook = null;
                    f.close();
                }
            }
        }
    } finally { configuredMapEngine = oldEngine; buildHook = null; }
});

test('typing during asynchronous preparation prevents an obsolete automatic build from starting', async () => {
    const f = fixture(), oldEngine = configuredMapEngine;
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let pending;
    try {
        configuredMapEngine = 'off';
        const prior = f.state.generation = { generation: 0, sourceSnapshotHash: 'older' };
        f.state.nativeLane = { close: async () => { entered(); await held; } };
        const before = conventionalCalls;
        pending = f.coordinator.build(f.doc, { live: true });
        await started;
        f.coordinator.noteChange({ document: f.doc,
            contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }] });
        release();
        await pending;
        assert.equal(conventionalCalls, before, 'no compiler is launched for text superseded during preparation');
        assert.equal(f.state.generation, prior);
    } finally { release(); await pending?.catch(() => {}); configuredMapEngine = oldEngine; f.close(); }
});

test('a native background settlement does not display compile progress', async () => {
    const f = fixture();
    const oldProgress = stub.window.withProgress;
    let progress = 0;
    stub.window.withProgress = (_options, task) => {
        progress++;
        return task({ report() {} }, { onCancellationRequested() {} });
    };
    try {
        f.state.generation = { runner: 'wlatex', sourceSnapshotHash: 'older', generation: 0 };
        await f.coordinator.build(f.doc, { authoritative: true });
        assert.equal(progress, 0, 'only a deliberate Compile or first open needs progress');
        assert.ok(f.state.generation.generation > 0, 'the idle native build still completes');
    } finally { stub.window.withProgress = oldProgress; f.close(); }
});

test('a queued Pro settlement retains its cooldown instead of acquiring a conventional deadline', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 20000 });
    const f = fixture(); let builds = 0;
    try {
        f.state.nativeLane = { interactive: true, close: async () => {} };
        f.coordinator.build = async () => { builds++; };
        f.coordinator._liveFirst.set(f.state.root, 1000);
        f.coordinator.scheduleLive(f.doc, 5000);
        t.mock.timers.tick(4000);
        assert.equal(builds, 0, 'a previous deadline cannot shorten the explicit cooldown');
        t.mock.timers.tick(1000);
        assert.equal(builds, 1);
    } finally { f.close(); }
});

test('a native map request has a bounded deadline even when the worker never replies', async () => {
    const f = fixture(); let release;
    try {
        const source = {};
        f.state.map = { native: true, available: false, materializedPages: [] };
        f.state.generation = { nativeSource: source };
        f.state.nativeLane = { source, close: async () => {}, refresh: () => new Promise(r => { release = r; }) };
        const answer = await Promise.race([
            f.coordinator.ensureNativeMap(f.state, 20),
            new Promise(r => setTimeout(() => r('hung'), 200)),
        ]);
        assert.equal(answer, false, 'the click returns instead of hanging behind the worker');
    } finally { release?.(null); f.close(); }
});

test('switching Pro off stops previews immediately and disposal cancels all delayed native work', async () => {
    const f = fixture(); let refreshed = 0;
    try {
        const lane = { interactive: true, close: async () => {} };
        f.state.nativeLane = lane;
        f.coordinator.proDisabled = true;
        assert.equal(f.coordinator._schedulePreview(f.state.root, f.state), false);
        f.coordinator.proDisabled = false;
        f.coordinator._runNativeRefresh = async () => { refreshed++; };
        f.coordinator._scheduleNativeRefresh(f.state, lane, 10);
        f.coordinator.dispose();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(refreshed, 0, 'no map work after coordinator disposal');
        assert.equal(f.coordinator._previewTimers.size, 0);
    } finally { f.close(); }
});

test('an older completed preview cannot claim to contain a later keystroke', async () => {
    const f = fixture(); let release;
    try {
        f.state.lastEditAt = 100;
        const lane = { close: async () => {}, interactiveBuild: () => new Promise(r => { release = r; }) };
        f.state.nativeLane = lane;
        const pending = f.coordinator._runInteractive(f.state, lane, f.state.root, {});
        f.state.lastEditAt = 200;
        release({ ok: true, diagnostics: [], report: {}, pageCount: 1 });
        await pending;
        assert.ok(f.state.livePreviewAt < f.state.lastEditAt, 'preview freshness belongs to its input text');
    } finally { f.close(); }
});

test('rendering configuration changes retire the old lane and invalidate pending preparation', async () => {
    const f = fixture(); let closed = false;
    try {
        f.state.nativeLane = { close: async () => { closed = true; } };
        f.state.buildPreparation = 4;
        f.state.nativeRefusedSnapshot = 'old-source';
        assert.equal(f.coordinator.configurationChanged({ affectsConfiguration: key => key === 'wolfbook.tex.mapEngine' }), true);
        assert.equal(f.state.nativeLane, null);
        assert.equal(f.state.buildPreparation, 5);
        assert.equal(f.state.nativeRefusedSnapshot, null);
        await Promise.resolve();
        assert.equal(closed, true);
        assert.equal(f.coordinator.configurationChanged({ affectsConfiguration: () => false }), false);
    } finally { f.close(); }
});

test('fresh WPaper waits for the webview ready handshake before shipping a PDF', async () => {
    const viewer = Object.create(TexViewer.prototype);
    const messages = [];
    Object.assign(viewer, { panel: {}, root: '/paper.tex', _webviewReady: false,
        coord: { roots: new Map() }, _post: message => messages.push(message) });
    await viewer.refresh({ force: true });
    assert.deepEqual(messages, []);
});

test('native previews select sidecar; authoritative and explicit builds select configured compiler', async () => {
    const f = fixture();
    const before = { native: nativeCalls, conventional: conventionalCalls };
    try {
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, before.native + 1);
        assert.equal(conventionalCalls, before.conventional);
        assert.equal(f.state.generation.runner, 'wlatex');
        assert.equal(f.state.sourceAhead, false);
        await f.coordinator.build(f.doc, { authoritative:true, quiet:true });
        assert.equal(conventionalCalls, before.conventional + 1);
        await f.coordinator.build(f.doc, { force:true, quiet:true });
        assert.equal(conventionalCalls, before.conventional + 2);
    } finally { f.close(); }
});

test('viewer Compile publishes one pass before any necessary quiet convergence, using the same engine', async t => {
    t.mock.timers.enable({ apis:['Date','setTimeout'], now:1000 });
    const f = fixture(), calls = [], beforeNative = nativeCalls;
    let release, settling;
    const gate = new Promise(resolve => { release = resolve; });
    const original = f.coordinator.buildAuthoritative.bind(f.coordinator);
    f.coordinator.buildAuthoritative = (...args) => settling = original(...args);
    configuredAuthoritativeDelay = 4000;
    f.coordinator._capOk = true;
    conventionalResult = { runner:'latexmk', engine:'pdflatex', pdfHash:'first', passes:1, passesLimited:true, rerunWanted:true };
    buildHook = async (opts, producer) => {
        calls.push({ ...opts, producer });
        if (calls.length > 1) await gate;
    };
    try {
        await f.coordinator.build(f.doc, { force:true, firstPass:true, quiet:true });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].maxPasses, 1);
        assert.equal(f.state.generation.pdfHash, 'first', 'the first PDF is published without waiting for convergence');
        assert.equal(f.state.compiling, false);
        t.mock.timers.tick(3999);
        assert.equal(calls.length, 1, 'no immediate duplicate compile');
        conventionalResult = { runner:'latexmk', engine:'pdflatex', pdfHash:'settled', passes:2, passesLimited:false, rerunWanted:false };
        t.mock.timers.tick(1);
        for (let i=0; i<30 && calls.length<2; i++) await Promise.resolve();
        assert.equal(calls.length, 2);
        assert.equal(calls[1].maxPasses, null, 'only the follow-up may converge fully');
        assert.equal(calls[1].engine, 'pdflatex');
        assert.equal(nativeCalls, beforeNative, 'Pro does not replace the manual compiler during convergence');
        assert.equal(f.state.backgroundCompiling, true);
        assert.equal(f.state.forcedCompiling, false);
        assert.equal(f.state.generation.pdfHash, 'first', 'the usable first PDF stays visible while settling');
        release(); await settling;
        assert.equal(f.state.generation.pdfHash, 'settled');
        t.mock.timers.tick(60000); await Promise.resolve();
        assert.equal(calls.length, 2, 'a settled result never schedules another build');
    } finally {
        release(); if (settling) await settling;
        configuredAuthoritativeDelay = 0; buildHook = null; conventionalResult = null; f.close();
    }
});

test('a clean viewer first pass needs no follow-up; export/verification remain uncapped', async () => {
    const f = fixture(), calls = [];
    configuredAuthoritativeDelay = 4000;
    f.coordinator._capOk = true;
    conventionalResult = { runner:'latexmk', engine:'pdflatex', passes:1, passesLimited:false, rerunWanted:false };
    buildHook = async opts => { calls.push(opts); };
    try {
        await f.coordinator.build(f.doc, { force:true, firstPass:true, quiet:true });
        assert.equal(calls[0].maxPasses, 1);
        assert.equal(f.coordinator._idleTimers.size, 0, 'no reference work means no background work');
        await f.coordinator.build(f.doc, { force:true, quiet:true });
        assert.equal(calls[1].maxPasses, null);
        await f.coordinator.build(f.doc, { force:true, firstPass:true, authoritative:true, quiet:true });
        assert.equal(calls[2].maxPasses, null, 'authoritative takes precedence over firstPass');
    } finally { configuredAuthoritativeDelay = 0; buildHook = null; conventionalResult = null; f.close(); }
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

test('fontspec stays native for live builds and selects XeLaTeX for explicit Compile and fallback', async () => {
    const f = fixture();
    fs.writeFileSync(f.state.root, '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{EBGaramond-Regular.otf}\n\\begin{document}Oxford\\end{document}');
    const before = nativeCalls;
    try {
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, before + 1, 'Unicode fonts remain supported by the live native engine');
        assert.equal(f.state.nativeOff, null);
        await f.coordinator.build(f.doc, { force:true, quiet:true });
        assert.equal(observedEngines.at(-1), 'xelatex', 'explicit Compile must not run fontspec under pdfLaTeX');
        fs.appendFileSync(f.state.root, '\n% next source');
        nativeFailure = true;
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(observedEngines.at(-1), 'xelatex', 'a producer failure uses the same compatible compiler');
    } finally { nativeFailure = false; f.close(); }
});

test('engine declarations and font packages select the conventional compiler with Pro switched off', async () => {
    const oldEngine = configuredMapEngine;
    configuredMapEngine = 'auto';
    try {
        for (const [source, expected] of [
            ['\\usepackage{fontspec}', 'xelatex'],
            ['% !TEX program = xelatex\n\\usepackage{fontspec}', 'xelatex'],
            ['% !TEX program = lualatex\n\\usepackage{fontspec}', 'lualatex'],
            ['% !TEX program = pdflatex\n\\usepackage{fontspec}', 'pdflatex'],
            ['% \\usepackage{fontspec}', 'lualatex'],
            ['', 'lualatex'],
        ]) {
            const f = fixture();
            fs.writeFileSync(f.state.root, source + '\n\\documentclass{article}');
            try {
                f.coordinator._luaOk = true;
                await f.coordinator.build(f.doc, { force:true, quiet:true });
                assert.equal(observedEngines.at(-1), expected, source || 'ordinary document');
            } finally { f.close(); }
        }
    } finally { configuredMapEngine = oldEngine; }
});

test('full-PDF engine selection reads unsaved preamble changes and retains a configured LuaLaTeX', async () => {
    const f = fixture(); const docs = stub.workspace.textDocuments;
    try {
        stub.workspace.textDocuments = [{ uri:f.doc.uri, isDirty:true, version:1,
            getText:() => '\\documentclass{article}\n\\usepackage{fontspec}' }];
        await f.coordinator.build(f.doc, { force:true, quiet:true });
        assert.equal(observedEngines.at(-1), 'xelatex', 'fontspec was added in the buffer, not on disk');
        configuredCompiler = 'lualatex';
        await f.coordinator.build(f.doc, { force:true, quiet:true });
        assert.equal(observedEngines.at(-1), 'lualatex');
    } finally { configuredCompiler = 'pdflatex'; stub.workspace.textDocuments = docs; f.close(); }
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
        // Repeating this exact source does not pay for the same failure.
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0 + 1);
        // A corrected body retries Pro even when the preamble is unchanged.
        nativeDocumentError = false;
        fs.appendFileSync(f.state.root, ' more body text');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0 + 2);
        assert.equal(f.state.nativeOff, null);
        // A changed preamble also retries it.
        fs.writeFileSync(f.state.root, '\\documentclass{article}\n\\begin{document}y');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, native0 + 3);
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

test('a best-effort pdfLaTeX PDF with document errors cannot disable Pro; corrected body text stays native', async () => {
    const f = fixture();
    const beforeNotices = notices.length;
    nativeDocumentError = true;
    conventionalResult = { errors:12, diagnostics:[{ severity:'error', message:'Argument of \\math@egroup has an extra }.' }] };
    try {
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(f.state.nativeOff, null, 'writing a PDF with twelve errors does not prove compatibility');
        assert.ok(!f.state.nativeIncompatible);
        assert.ok(f.state.nativeLane, 'the live lane survives a temporary syntax error');
        assert.equal(notices.length, beforeNotices, 'typing errors produce no incompatibility popup');
        const nativeBefore = nativeCalls;
        nativeDocumentError = false; conventionalResult = undefined;
        fs.appendFileSync(f.state.root, '\n% corrected body');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(nativeCalls, nativeBefore + 1);
        assert.equal(f.state.generation.runner, 'wlatex');
    } finally { nativeDocumentError = false; conventionalResult = undefined; f.close(); }
});

test('engine comparisons of old text cannot disable Pro when typing continues during a priority build', async () => {
    const f = fixture();
    nativeDocumentError = true;
    let changed = false;
    buildHook = async (_o, kind) => {
        if (changed || kind !== 'conventional') return;
        // The comparison compiler runs after the native failure. Its result
        // still describes the frozen earlier source, not the new keystroke.
        if (!changed) {
            changed = true;
            fs.appendFileSync(f.state.root, '\n% new key');
            f.coordinator.noteChange({ document:f.doc, contentChanges:[{ range:{ start:{ line:0 }, end:{ line:0 } }, text:'x' }] });
        }
    };
    try {
        await f.coordinator.build(f.doc, { live:true, quiet:true, priority:true });
        assert.equal(changed, true);
        assert.equal(f.state.nativeOff, null, 'an obsolete comparison never becomes current engine policy');
        assert.ok(!f.state.nativeIncompatible);
        assert.ok(!f.state.nativeIncompatibleTried, 'obsolete comparisons leave no backoff');
    } finally { nativeDocumentError = false; buildHook = undefined; f.close(); }
});

test('a Pro document error preserves displayed provenance without passing compilation or verification', async () => {
    const f = fixture();
    try {
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        const previous = f.state.generation, map = f.state.map, prevMap = f.state.prevMap, lane = f.state.nativeLane;
        // A source edit invalidates indexed geometry until the same native
        // source worker remaps it. A failed build must keep that worker/map.
        fs.appendFileSync(f.state.root, '\n\\UndefinedCommand');
        nativeDocumentError = true;
        conventionalResult = { ok:false, pdfPath:null, errors:1, diagnostics:[{ severity:'error', message:'Undefined control sequence.' }] };
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(f.state.nativeLane, lane);
        assert.equal(f.state.map, map, 'last displayed map is not replaced with an empty map');
        assert.equal(f.state.prevMap, prevMap, 'previous displayed provenance is not evicted');
        assert.equal(f.state.generation.pdfPath, previous.pdfPath);
        assert.equal(f.state.generation.pdfHash, previous.pdfHash);
        assert.equal(f.state.generation.generation, previous.generation, 'display identity remains bound to its bytes');
        assert.equal(f.state.generation.sourceSnapshotHash, previous.sourceSnapshotHash, 'old pixels cannot claim the failed source snapshot');
        assert.equal(f.state.generation.ok, false, 'verification still fails');
        assert.equal(f.state.generation.failedBuild.ok, false);
        assert.equal(f.state.sourceAhead, true);
        assert.match(f.state.lastError, /compile produced no PDF/);
        assert.match(f.state.compileDiagnostics.list[0].message, /Undefined/);
        // Multiple failures retain only the latest failed report, rather
        // than chaining whole maps/PDFs from every attempt.
        await f.coordinator.build(f.doc, { force:true, quiet:true });
        assert.equal(f.state.map, map);
        assert.equal(f.state.generation.failedBuild.failedBuild, undefined);
        nativeDocumentError = false; conventionalResult = undefined;
        fs.appendFileSync(f.state.root, '\n% corrected');
        await f.coordinator.build(f.doc, { live:true, quiet:true });
        assert.equal(f.state.generation.ok, true);
        assert.equal(f.state.generation.failedBuild, undefined);
        assert.equal(f.state.sourceAhead, false);
        assert.equal(f.state.lastError, null);
        assert.deepEqual(f.state.compileDiagnostics.list, []);
        assert.equal(f.state.nativeLane, lane);
    } finally { nativeDocumentError = false; conventionalResult = undefined; f.close(); }
});

test('a temporary live TeX error crosses the badge through its reason and clears after a current successful preview', async () => {
    const f = fixture();
    const posts = [];
    const lane = { interactive:true, close:async () => {}, interactiveBuild:async () => ({ ok:false,
        diagnostics:[{ severity:'error', line:42, message:'Argument of \\math@egroup has an extra }.' }] }) };
    const engine = () => {
        TexViewer.prototype._postEngine.call({ coord:f.coordinator, context:{ globalState:{ get:() => true } },
            _post:m => posts.push(m) }, f.state);
        return posts.at(-1);
    };
    try {
        f.state.nativeLane = lane; f.state.sourceRevision = 1;
        await f.coordinator._runInteractive(f.state, lane, f.state.root, {});
        assert.equal(f.state.nativeOff, undefined, 'temporary syntax errors do not change engine policy');
        assert.equal(f.state.nativeLane, lane);
        assert.match(engine().previewError, /Line 42: Argument of \\math@egroup/);
        assert.notEqual(engine().state, 'off');
        f.state.sourceRevision++;
        lane.interactiveBuild = async () => ({ ok:true, diagnostics:[], pages:[], pageCount:1, report:{} });
        await f.coordinator._runInteractive(f.state, lane, f.state.root, {});
        assert.equal(engine().previewError, null, 'a current successful preview clears the error');
        f.state.sourceRevision++;
        lane.interactiveBuild = async () => { f.state.sourceRevision++; return { ok:false,
            diagnostics:[{ severity:'error', line:42, message:'older failure' }] }; };
        await f.coordinator._runInteractive(f.state, lane, f.state.root, {});
        assert.equal(engine().previewError, null, 'a failure superseded by a key cannot cross the current badge');
    } finally { f.close(); }
});

test('editor diagnostics follow the newest current report while a failed compile retains an old PDF', () => {
    const f = fixture();
    const oldDiagnostic = stub.Diagnostic, oldSeverity = stub.DiagnosticSeverity;
    stub.Diagnostic = class { constructor(range,message,severity) { Object.assign(this,{range,message,severity}); } };
    stub.DiagnosticSeverity = {Error:0,Warning:1,Information:2};
    const doc = {...f.doc,lineCount:1,lineAt:() => ({range:{}})};
    const projection = {get:() => ({model:{objects:[]}})};
    const error = {file:f.state.root,line:1,severity:'error',message:'Undefined control sequence.'};
    try {
        f.state.sourceRevision = 2;
        f.state.sourceAhead = true;
        f.state.generation = {diagnostics:[error],finishedAt:100};
        f.state.compileDiagnostics = {revision:2,sequence:5,at:100,list:[error]};
        assert.equal(renderDiagnostics(doc,f.coordinator,projection).length,1);
        f.state.liveDiagnostics = {revision:2,sequence:6,at:100,list:[]};
        assert.deepEqual(renderDiagnostics(doc,f.coordinator,projection),[], 'a clean live correction clears old compile errors immediately');
        f.state.liveDiagnostics = {revision:2,sequence:7,at:101,list:[error]};
        assert.equal(renderDiagnostics(doc,f.coordinator,projection)[0].source,'wolfbook-tex (live)');
        f.state.sourceRevision = 3;
        assert.deepEqual(renderDiagnostics(doc,f.coordinator,projection),[], 'older source reports cannot annotate a new revision');
    } finally {stub.Diagnostic=oldDiagnostic;stub.DiagnosticSeverity=oldSeverity;f.close();}
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
    const context = vm.createContext({ sourceFocusEpoch:0, state:{ tracePaused:true, nativeMapAvailable:true, generation:7 },
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
    const f = fixture(); const builds = conventionalCalls, warningCount = warnings.length, noticeCount = notices.length; installed = false;
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(conventionalCalls, builds + 1);
        assert.ok(!f.state.lastError);
        assert.match(f.state.nativeUnavailable, /normal WPaper compiler/);
        assert.equal(warnings.length, warningCount);
        assert.equal(notices.length, noticeCount);
        for (const disabled of [false, true]) {
            f.coordinator.proDisabled = disabled;
            const posts = [];
            TexViewer.prototype._postEngine.call({ coord:f.coordinator, _post:m => posts.push(m) }, f.state);
            assert.equal(posts.at(-1).state, null);
            assert.equal(posts.at(-1).intro, false);
        }
        f.coordinator.proDisabled = false;
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
    f.doc.getText = () => 'abcdefgh';
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
    f.doc.positionAt = offset => new NativePosition(0,offset);
    f.doc.getText = range => range ? text.slice(range.start.character, range.end.character) : text;
    f.viewer._editSeq = 0;
    // This fixture has no webview transport: a recovery request waits for
    // the test's explicit opened acknowledgement instead of probing a browser.
    f.viewer._viewerReloading = true;
    f.viewer._deferEditOpen = TexViewer.prototype._deferEditOpen;
    f.viewer._replayPendingEditOpen = TexViewer.prototype._replayPendingEditOpen;
    f.viewer._sameSourceSelection = TexViewer.prototype._sameSourceSelection;
    f.viewer._selectionSourceCurrent = TexViewer.prototype._selectionSourceCurrent;
    f.viewer.status = TexViewer.prototype.status;
    f.viewer._resolvePoint = TexViewer.prototype._resolvePoint;
    f.viewer._nearestEditable = TexViewer.prototype._nearestEditable;
    f.viewer._blockAt = () => ({ startLine:1, endLine:1, label:'paragraph' });
    f.viewer._editCellStarts = TexViewer.prototype._editCellStarts;
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
    assert.equal(f.posts.at(-1).caretStart, 6, 'native glyph source column initializes the card');
    assert.equal(f.posts.at(-1).caretEnd, 6, 'native opens with a collapsed caret');
});

test('right-click loads the clicked native page even when another map window is available',async()=>{
    const f=openFixture();let page;
    f.map.hasPage=()=>false;
    f.viewer.coord.ensureNativeMap=async(st,timeout,want)=>{
        assert.equal(st,f.state);assert.equal(timeout,1500);page=want;f.map.hasPage=()=>true;return true;
    };
    assert.ok(await f.open({page:44}));assert.equal(page,44);
});

test('a settled PDF opens the editor immediately instead of waiting for a redundant live overlay map',async()=>{
    const f=openFixture(),identity='redundant-preview';
    Object.assign(f.viewer,{_retireSettledPreviews:TexViewer.prototype._retireSettledPreviews,
        _displayMatchesSource:TexViewer.prototype._displayMatchesSource,
        _liveOverlays:new Map([[1,identity]]),_liveMapReady:new Map([[1,identity]]),
        _ensureLiveMap:()=>{throw Error('the editor must use the current PDF without live map work');}});
    f.state.sourceAhead=false;f.state.generation={generation:1,pdfHash:'pdf'};f.state.nativeLane={};
    assert.ok(await f.open({overlay:identity}));
    assert.deepEqual(f.posts.find(m=>m.type==='retireLivePreview').pages,{1:identity});
    assert.equal(f.viewer._liveOverlays.size,0);
});

test('a newer source never loses its live overlay to the settled-preview recovery',()=>{
    const f=openFixture(),identity='new-typing';
    f.viewer._displayMatchesSource=TexViewer.prototype._displayMatchesSource;
    f.viewer._liveOverlays=new Map([[1,identity]]);f.state.generation={generation:1,pdfHash:'pdf'};
    assert.equal(TexViewer.prototype._retireSettledPreviews.call(f.viewer,f.state,1,identity),false);
    assert.equal(f.viewer._liveOverlays.get(1),identity);assert.equal(f.posts.length,0);
});

test('preview retirement cannot erase newer ink queued behind an older visible overlay',()=>{
    const vm=require('node:vm');
    const src=fs.readFileSync(path.join(__dirname,'../../../client/tex-viewer.js'),'utf8');
    const handler=src.slice(src.indexOf("case 'retireLivePreview':"),src.indexOf("case 'nativeMapState':"));
    const state={generation:1,txdl:{pages:new Map([[44,{identity:'old'}]])},
        txdlPending:new Map([[44,{msg:{identity:'new'}}]])};
    let removed=0;
    vm.runInNewContext(`switch(msg.type){${handler}}`,{state,msg:{type:'retireLivePreview',generation:1,pages:{44:'old'}},
        removeTxdlOverlay:()=>{removed++;},restorePdfLinks(){},invalidateSelectionGeometry(){},renderReview(){},renderEditNav(){}});
    assert.equal(removed,0);assert.equal(state.txdlPending.get(44).msg.identity,'new');
});

test('reopening a live mini-editor recovers a missed map-ready event by page identity',async()=>{
    const f=openFixture(), identity='visible-page';
    Object.assign(f.viewer,{_liveOverlays:new Map([[1,identity]]),_liveMapReady:new Map(),
        _ensureLiveMap:TexViewer.prototype._ensureLiveMap});
    f.state.nativeLane={liveMapIdentity:()=>identity};
    f.map.hasPage=page=>page===1;
    f.viewer._buildLiveMap=async()=>{f.viewer._liveMap=f.map;f.viewer._liveMapIdentities=new Map([[1,identity]]);};
    const first=await f.open({overlay:identity});assert.ok(first);
    f.viewer._edit=null;
    f.viewer._liveMap=null;f.viewer._liveMapReady.clear();
    const reopened=await f.open({overlay:identity});
    assert.ok(reopened);assert.notEqual(reopened.id,first.id);
    assert.equal(f.posts.filter(m=>m.type==='editOpen').length,2);
});

test('a hung live source worker has a bounded right-click wait and leaves the event loop free',async()=>{
    const f=openFixture(), identity='visible-page';
    Object.assign(f.viewer,{_liveOverlays:new Map([[1,identity]]),_liveMapReady:new Map([[1,identity]]),
        _liveMapClickWaitMs:30,_buildLiveMap:()=>new Promise(()=>{})});
    f.state.nativeLane={};
    let ticks=0;const timer=setInterval(()=>ticks++,3),before=Date.now();
    try {
        assert.equal(await TexViewer.prototype._ensureLiveMap.call(f.viewer,1,identity),false);
        assert.ok(Date.now()-before<500,'worker deadline actually limits awaiting the promise');
        assert.ok(ticks>=2,'viewer events continue while waiting');
    } finally {clearInterval(timer);}
});

test('a ready event for new ink cannot admit an older materialized live map',async()=>{
    const f=openFixture(),identity='new-page';let reads=0;
    f.map.hasPage=()=>true;
    Object.assign(f.viewer,{_liveOverlays:new Map([[1,identity]]),_liveMapReady:new Map([[1,identity]]),
        _liveMap:f.map,_liveMapIdentities:new Map([[1,'old-page']]),_buildLiveMap:async()=>{
            reads++;f.viewer._liveMapIdentities=new Map([[1,identity]]);
        }});
    f.state.nativeLane={};
    assert.equal(await TexViewer.prototype._ensureLiveMap.call(f.viewer,1,identity),true);
    assert.equal(reads,1,'geometry is rematerialized for the identity actually visible');
});

test('a right-click map request does not wait behind a stalled background window',async()=>{
    const f=openFixture(),identity='editor-page';let requested;
    f.map.hasPage=()=>true;
    Object.assign(f.viewer,{_liveOverlays:new Map([[1,identity]]),_liveMapReady:new Map([[1,identity]]),
        _liveMapBuilding:new Promise(()=>{}),_liveMapClickWaitMs:50,
        _buildLiveMap:async(lane,page)=>{
            requested=page;f.viewer._liveMap=f.map;f.viewer._liveMapIdentities=new Map([[1,identity]]);
        }});
    f.state.nativeLane={};
    assert.equal(await TexViewer.prototype._ensureLiveMap.call(f.viewer,1,identity),true);
    assert.equal(requested,1);
});

test('a redraw keeps an untouched source range across surrounding edits and never guesses between repeated quotes',()=>{
    const before='Before\nchosen fragment\nAfter chosen fragment';
    const selected={sourceText:before,start:{line:1,character:0},end:{line:1,character:15},direction:'backward'};
    const doc=text=>({version:2,getText:()=>text,positionAt:offset=>{
        const lines=text.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};
    }});
    const rebase=text=>TexViewer.prototype._rebaseSelectedRange(selected,doc(text));
    const shifted=rebase('Inserted\n'+before);
    assert.deepEqual(shifted.start,{line:2,character:0});
    assert.deepEqual(shifted.end,{line:2,character:15});assert.equal(shifted.direction,'backward');
    assert.deepEqual(rebase(before+' appended').start,selected.start);
    assert.equal(rebase(before.replace('chosen fragment','changed fragment')),null,'a changed selection is retired');
    assert.equal(rebase(before.replace('chosen fragment\n','')),null,'the duplicate quote cannot steal the deleted range');
});

test('live editor recovery retries a preview once and replays only the same visible page',async()=>{
    for (const changed of [false,true]) {
        const f=openFixture(),identity='visible-page';let previews=0;
        Object.assign(f.viewer,{_editOpenRequest:1,_liveOverlays:new Map([[1,identity]]),
            _liveMapReady:new Map(),_liveMap:null});
        f.viewer.coord._schedulePreview=()=>previews++;
        f.viewer._onMessage=message=>f.open(message);
        f.viewer._ensureLiveMap=async()=>true;
        f.state.nativeLane={};
        const frame={root:f.viewer.root,request:1,previous:f.viewer._edit,
            navigation:f.viewer._nativeInverseRequest,caretRequest:f.viewer._miniCaretRequest};
        const message={generation:1,page:1,overlay:identity,xBp:102,yTopBp:84};
        assert.equal(TexViewer.prototype._deferLiveEditOpen.call(f.viewer,message,frame),true);
        assert.equal(TexViewer.prototype._deferLiveEditOpen.call(f.viewer,message,frame),true);
        assert.equal(previews,1,'repeated requests never trigger repeated full builds');
        await f.viewer._replayPendingEditOpen();
        assert.ok(f.viewer._pendingEditOpen,'wait for an admitted map');
        f.map.hasPage=()=>true;f.viewer._liveMap=f.map;f.viewer._liveMapReady.set(1,identity);
        if(changed)f.viewer._liveOverlays.set(1,'new-page');
        await f.viewer._replayPendingEditOpen();await f.viewer._replayPendingEditOpen();
        assert.equal(f.posts.filter(m=>m.type==='editOpen').length,changed?0:1);
        assert.equal(f.viewer._pendingEditOpen,null);
        clearTimeout(f.viewer._pendingEditOpenTimer);
    }
});

test('an unchanged finalized page still replaces a paragraph fragment and its map identity',()=>{
    const f=openFixture();
    Object.assign(f.viewer,{shownAnything:true,_liveOverlays:new Map([[1,'fragment']]),
        _previewPages:new Map(),_postEngine:()=>{},_postErrorAnnotations:()=>{}});
    TexViewer.prototype._onInteractive.call(f.viewer,{root:f.viewer.root,kind:'page',page:1,
        generation:2,changed:false,identity:'final-page',txdl:{items:[]}});
    const page=f.posts.find(m=>m.type==='txdlPage');
    assert.ok(page);assert.equal(page.identity,'final-page');
    assert.equal(f.viewer._liveOverlays.get(1),'final-page');
});

test('right-click names the visible fragment rather than the live page underneath',async()=>{
    const js=fs.readFileSync(path.resolve(__dirname,'../../../client/tex-viewer.js'),'utf8');
    const from=js.indexOf('function sendClick('),body=js.slice(from,js.indexOf('\n}',from)+2);
    const posted=[],fragment={canvas:{isConnected:true},msg:{mapIdentity:'fragment-map',generation:9,index:2}};
    const context=require('vm').createContext({
        state:{nativeMapAvailable:true,generation:3,txdl:{pages:new Map([[1,{identity:'old-page',canvas:{isConnected:true}}]])},
            txdlFragments:new Map([[1,fragment]])},
        sourceFocusEpoch:0,vscode:{postMessage:msg=>posted.push(msg)},Promise,
    });
    require('vm').runInContext(body,context);
    for (const expected of ['fragment-map','fragment-pending:9:1:2','old-page']) {
        if(expected.startsWith('fragment-pending'))delete fragment.msg.mapIdentity;
        if(expected==='old-page')fragment.canvas.isConnected=false;
        context.sendClick(1,{xBp:100,yTopBp:90},100,90,{},'editHere');
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(posted.at(-1).overlay,expected);
    }
});

test('native right-click opens the selected source, preserving direction and refusing stale ranges', async () => {
    for (const mode of ['current', 'version', 'map', 'source']) {
        const f = openFixture();
        f.viewer._selectionTarget = TexViewer.prototype._selectionTarget;
        f.viewer._lastSelection = { file:f.doc.uri.fsPath, nativeMap:f.map, documentVersion:f.doc.version,
            start:new NativePosition(0,0), end:new NativePosition(0,5), direction:'backward' };
        if (mode === 'version') f.viewer._lastSelection.documentVersion = -1;
        if (mode === 'map') f.viewer._lastSelection.nativeMap = { ...f.map };
        if (mode === 'source') f.doc.getText = () => 'changed source';
        f.viewer._resolvePoint = () => { throw new Error('must use the selection, not the clicked glyph'); };
        await f.open({ preserveSelection:true });
        const open = f.posts.find(m => m.type === 'editOpen');
        if (mode === 'current') {
            assert.ok(open);
            assert.equal(open.text.slice(open.caretStart, open.caretEnd), 'Alpha');
            assert.equal(open.caretDirection, 'backward');
        } else assert.ok(!open, mode);
    }
});

test('a mini-editor click during a same-PDF handoff retries with the new map', async () => {
    const f = openFixture(); let release;
    f.viewer._onMessage = message => f.open(message);
    stub.workspace.openTextDocument = () => new Promise(resolve => { release = resolve; });
    const opening = f.open();
    const previous = f.map;
    f.state.map = { ...previous };
    f.viewer._openedGeneration = 2;
    stub.workspace.openTextDocument = async () => f.doc;
    release(f.doc); await opening;
    assert.equal(f.posts.filter(m => m.type === 'editOpen').length, 1);
    assert.equal(f.viewer._edit.lastText, 'Alpha Alpha');
    assert.equal(f.viewer._pendingEditOpen, null);
});

test('a deferred mini-editor never reuses coordinates on changed PDF bytes', async () => {
    const f = openFixture(); let release;
    f.viewer._onMessage = () => { throw Error('old coordinates replayed'); };
    stub.workspace.openTextDocument = () => new Promise(resolve => { release = resolve; });
    const opening = f.open();
    f.state.map = { ...f.map, view:{ artifact:{ pdf_hash:'new-pdf' } } };
    f.viewer._openedPdfHash = 'new-pdf';
    f.viewer._openedGeneration = 2;
    release(f.doc); await opening;
    assert.ok(!f.posts.some(m => m.type === 'editOpen'));
    assert.equal(f.viewer._pendingEditOpen, null);
    assert.ok(f.posts.some(m => m.type === 'status' && m.text === 'Page updated — right-click to edit.'));
});

test('a waiting editor opens once after recovery, and still verifies source bytes', async () => {
    for (const changedSource of [false, true]) {
        const f = openFixture();
        f.viewer._openedPdfHash = 'old-pdf';
        f.viewer._onMessage = message => f.open(message);
        await f.open();
        assert.ok(f.viewer._pendingEditOpen, 'the mismatched map waits for its PDF');
        f.state.map = { ...f.map, view:{ artifact:{ pdf_hash:'old-pdf' } } };
        f.viewer._openedGeneration = 2;
        if (changedSource) f.doc.getText = () => 'new source text';
        await f.viewer._replayPendingEditOpen();
        await f.viewer._replayPendingEditOpen();
        assert.equal(f.posts.filter(m => m.type === 'editOpen').length, changedSource ? 0 : 1);
        assert.equal(f.viewer._pendingEditOpen, null);
    }
});

test('a stepped card is measured on the pages as shown: a live page from its own map', () => {
    const cold = { lineRows: () => [{ page:3, x:1, y:700, w:5, h:9 }, { page:4, x:1, y:60, w:5, h:9 }] };
    const live = { available:true, hasPage: p => p === 4,
        lineRows: () => [{ page:3, x:1, y:500, w:5, h:9 }, { page:4, x:1, y:90, w:5, h:9 }] };
    const viewer = { _liveMap:live, _liveOverlays:new Map([[4, 'id']]),
        _editRects:TexViewer.prototype._editRects };
    const rects = TexViewer.prototype._editRectsShown.call(viewer, { map:cold }, 'a.tex', 1, 1);
    assert.deepEqual(rects.map(r => [r.page, r.y]), [[3, 700], [4, 90]],
        'the PDF page from the settled map, the live page from its own');
    viewer._liveOverlays = new Map();
    assert.deepEqual(TexViewer.prototype._editRectsShown.call(viewer, { map:cold }, 'a.tex', 1, 1).map(r => r.y), [700, 60]);
});

test('a right-click outside the text opens the block nearest to it', async () => {
    const f = openFixture(); const asked = [];
    const glyph = f.map.renderToSource(1, 102, 84);
    f.map.renderToSource = () => ({ flag:'unmapped', reason:'no native source box contains this point' });
    f.map.nearestExact = (page, x, y) => { asked.push([page, x, y]); return glyph; };
    const session = await f.open({ xBp:560, yTopBp:84, sourceOffset:3 });
    assert.deepEqual(asked, [[1, 560, 84]]);
    assert.equal(session, f.viewer._edit);
    const open = f.posts.at(-1);
    assert.equal(open.type, 'editOpen');
    assert.equal(open.clickOffset, undefined, 'no caret at a point that is not in the block');
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

test('native selection painting is one band per printed line, touching the next, and never searches PDF text rows', async () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const painted = [];
    const context = vm.createContext({ state:{ rendered:new Set([1]), edit:true },
        document:{ querySelectorAll:() => [], createElement:() => ({ style:{}, dataset:{} }) },
        pagesEl:() => ({ querySelector:() => ({ appendChild:node => painted.push(node) }) }),
        renderPage:async () => { throw Error('a selection on visible ink must not request PDF rendering'); },
        rectToViewport:(page, rect) => rect, markToPx:mark => mark,
        textItems:() => { throw Error('native selection must not infer text rows'); },
        paintSelectionActions() {} });
    for (const name of ['function nativeBands(', 'function selectionGeometryCurrent(', 'async function paintSelection(', 'async function paintSelectionNow(']) {
        const start = js.indexOf(name);
        vm.runInContext(js.slice(start, js.indexOf('\n}\n', start) + 2), context);
    }
    await context.paintSelection({ native:true, reveal:false,
        // Line 1: a capital, an x-height letter and a dot above; line 2 one glyph.
        rows:[{ page:1, x:10, y:10, w:5, h:10 }, { page:1, x:16, y:13, w:5, h:7 }, { page:1, x:17, y:9, w:2, h:1.5 },
            { page:1, x:50, y:24, w:5, h:10 }],
        start:{ exactEdge:{ page:1, x:10, y:10, h:10 } },
        end:{ exactEdge:{ page:1, x:55, y:24, h:10 } } });
    const fills = painted.filter(node => node.className === 'selfill');
    assert.equal(fills.length, 2, 'one band per printed line, not per glyph');
    assert.equal(fills[0].style.left, '10px'); assert.equal(fills[0].style.width, '11px');
    assert.equal(fills[0].style.top, '9px', 'from the line\'s highest symbol');
    assert.equal(fills[0].style.height, '15px', 'down to the next line: no gap');
    assert.equal(fills[1].style.left, '50px'); assert.equal(fills[1].style.height, '10px');
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

test('a drag step in whitespace snaps to the nearest character and keeps the anchor', async () => {
    const f = pickFixture(); await f.pick(0);
    const glyph = f.map.renderToSource(1, 102, 84);
    const near = { ...glyph, sourceRange:{ start:{ line:1, column_utf16:4 }, end:{ line:1, column_utf16:5 } } };
    f.map.renderToSource = () => ({ flag:'unmapped' });
    f.map.nearestExact = () => near;
    await f.pick(9, { live:true });
    assert.ok(f.viewer._pickAnchor, 'the anchor survives a step between lines');
    assert.deepEqual(f.queries, [[0,5]], 'the selection runs to the nearest character');
    assert.ok(!f.posts.some(p => p.type === 'selection' && p.span === null), 'the selection is never erased mid-drag');
    f.map.nearestExact = () => null;
    const posted = f.posts.length;
    await f.pick(9, { live:true });
    assert.equal(f.posts.length, posted, 'with nothing near, what is shown stays');
});

test('a bracket drag keeps the other end when a live page\'s map answers', async () => {
    const f = pickFixture(); await f.pick(0);
    // The anchor was taken on the settled map; the step lands on a live page.
    f.viewer._pickAnchor.nativeMap = { other:true };
    await f.pick(6, { live:true });
    assert.deepEqual(f.queries, [[0,7]], 'from the kept end, not restarted under the pointer');
});

test('drag steps are answered one at a time: none is lost to the next, the newest waiting one is kept', async () => {
    const answered = []; const releases = [];
    const viewer = { _jumpToSource: m => new Promise(resolve => { answered.push(m.n); releases.push(resolve); }),
        _livePick: TexViewer.prototype._livePick };
    const first = viewer._livePick({ n:1 });
    viewer._livePick({ n:2 }); viewer._livePick({ n:3 });
    assert.deepEqual(answered, [1], 'the others wait for the first to paint');
    releases[0](); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(answered, [1, 3], 'then the newest');
    releases[1](); await first;
    assert.deepEqual(answered, [1, 3]);
});

// Bug #40: a drag's anchor pick could be superseded in flight by the next move,
// and the selection then started late or never. Every drag pick now carries
// its press point, and the extension anchors on it in the same request.
test('#40 a drag pick that names its press point selects from there even if every earlier pick was lost', async () => {
    const f = pickFixture();
    const at = f.map.renderToSource;
    f.map.renderToSource = (page, x, y) => {
        const h = at(page, x, y);
        if (x !== 1) return h;
        return { ...h, sourceRange: { start: { ...h.sourceRange.start, column_utf16: 0 }, end: { ...h.sourceRange.end, column_utf16: 1 } } };
    };
    await f.pick(6, { from: { page: 1, xBp: 1, yTopBp: 84 } });
    assert.deepEqual(f.queries, [[0, 7]], 'one selection from the press point to the release point');
    assert.equal(f.editor.selection.start.character, 0);
    assert.equal(f.editor.selection.end.character, 7);
    assert.equal(f.viewer._pickAnchor, null);
    assert.ok(!f.posts.some(p => p.span?.pendingStart), 'no half-armed selection');
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
            f.coordinator.noteChange({ document:f.doc, contentChanges:[{ range:{ start:{line:0}, end:{line:0} }, text:'x' }] });
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
        f.coordinator.noteChange({ document:f.doc, contentChanges:[{ range:{ start:{line:0}, end:{line:0} }, text:'x' }] });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, true);
        assert.equal(f.state.nativeLane, null);
    } finally { f.close(); }
});
test('a superseded native refresh retries without retiring a healthy worker',async()=>{
 for(const name of ['AbortError','StaleBuild','Cancelled']){
  const f=fixture();let closed=0,retries=0;
  const lane={source:{},refresh:async()=>{throw Object.assign(Error('Native preview source superseded'),{name});},close:async()=>closed++};
  Object.assign(f.state,{nativeLane:lane,generation:{nativeSource:lane.source},map:{native:true,available:false}});
  f.coordinator._scheduleNativeRefresh=()=>retries++;
  try{await f.coordinator._runNativeRefresh(f.state,lane);assert.equal(f.state.nativeLane,lane);assert.equal(closed,0);assert.equal(retries,1);}
  finally{f.close();}
 }
});
test('a cancelled source-edit task never closes the native session or announces a compiler fallback',async()=>{
 const f=fixture();let closes=0,retries=0;
 const lane={noteChange:async()=>{throw Object.assign(Error('superseded'),{name:'AbortError'});},close:async()=>closes++};
 f.state.nativeLane=lane;f.coordinator._scheduleNativeRefresh=()=>retries++;
 try{
  f.coordinator.noteChange({document:f.doc,contentChanges:[{range:{start:{line:0},end:{line:0}},text:'x'}]});
  await new Promise(r=>setImmediate(r));assert.equal(f.state.nativeLane,lane);assert.equal(closes,0);assert.equal(retries,1);
 }finally{f.close();}
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

test('typing and deleting in either mini-editor sends text and caret immediately', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf("ta.addEventListener('input', () => {", js.indexOf('function buildEditCard('));
    const end = js.indexOf('\n    });', start) + '\n    });'.length;
    for (const native of [false, true]) for (const value of ['abcd', 'ab']) {
        const posts = [], timers = [];
        const e = { id: 1, native, text: 'abc' };
        let handler;
        const context = vm.createContext({ e, state: { edit: e },
            ta: { value, selectionStart: value.length, addEventListener: (_, fn) => { handler = fn; } },
            beforeInput: { text: 'abc' }, miniInputOperation: () => null,
            boundaryArm: null, debounce: null, card: {},
            caretSnapshot: () => ({ start: value.length, end: value.length, direction: 'forward' }),
            syncHighlight() {}, sendCaret() {}, clearTimeout() {},
            setTimeout: fn => { timers.push(fn); return 1; },
            vscode: { postMessage: m => posts.push(m) } });
        vm.runInContext(js.slice(js.indexOf('function rebaseCellStarts('), js.indexOf('/** Dividers are decorations')), context);
        vm.runInContext(js.slice(start, end), context);
        handler();
        assert.equal(posts.length, 1, 'no pause before the source hears typing');
        assert.equal(timers.length, 0, 'no trailing typing debounce');
        assert.equal(posts[0].text, value);
        assert.equal(posts[0].caret.start, value.length);
        assert.equal(posts[0].beforeText, 'abc');
    }
});

test('both mini-editor engines apply verified ranges and retain insertions at card boundaries', async () => {
    for (const native of [false, true]) for (const at of [0,1,4,'invalid']) {
        let text = 'aaaa'; let applied;
        const doc = { uri:{ fsPath:'/paper.tex' }, positionAt:n => new NativePosition(0,n),
            getText:range => range ? text.slice(range.start.character, range.end.character) : text };
        stub.workspace.openTextDocument = async () => doc;
        stub.WorkspaceEdit = class { replace(uri, range, value) { this.range=range; this.value=value; } };
        const s = { id:1, native, file:'/paper.tex', startOffset:0, endOffset:4, lastText:text };
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
    for (const native of [false, true]) {
    const source = 'External'; const posts = []; let writes = 0;
    const s = { id:1, native, file:'/paper.tex', startOffset:0, endOffset:source.length, lastText:source };
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
    }
});

test('rapid mini-editor inputs reach the source in order before Esc closes either engine session', async () => {
    for (const native of [false, true]) {
        let text = 'abc', release;
        const posts = [];
        const doc = { uri: { fsPath: '/paper.tex' }, positionAt: n => new NativePosition(0, n),
            getText: range => range ? text.slice(range.start.character, range.end.character) : text };
        const gate = new Promise(resolve => { release = resolve; });
        stub.workspace.openTextDocument = async () => { await gate; return doc; };
        stub.WorkspaceEdit = class { replace(uri, range, value) { this.range = range; this.value = value; } };
        const s = { id: 1, native, file: doc.uri.fsPath, startOffset: 0, endOffset: 3, lastText: text };
        const viewer = Object.create(TexViewer.prototype);
        Object.assign(viewer, { _edit: s, _rememberEditState() {}, _post: m => posts.push(m),
            _onEditCaret: async () => {}, _applyReaderEdit: async (_, edit) => {
                const start = edit.range.start.character, end = edit.range.end.character;
                text = text.slice(0, start) + edit.value + text.slice(end);
                viewer._onEditDocChange({ document: doc,
                    contentChanges: [{ rangeOffset: start, rangeLength: end - start, text: edit.value }] });
                return true;
            } });
        const work = [];
        let before = text;
        for (const after of ['abcd', 'abcde', 'abcd', 'abcdf']) {
            work.push(viewer._applyEditChange({ editId: s.id, text: after, beforeText: before,
                caret: { start: after.length, end: after.length } }));
            before = after;
        }
        const closed = viewer._closeEditSession({ editId: s.id });
        assert.equal(viewer._edit, s, 'closing waits for the document writes');
        release();
        assert.ok((await Promise.all(work)).every(Boolean));
        await closed;
        assert.equal(text, 'abcdf');
        assert.equal(s.endOffset, 5);
        assert.equal(viewer._edit, null);
        assert.equal(posts.length, 0, 'no echo, conflict or failure from our own rapid edits');
    }
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


test('both modes use textarea offsets for CRLF card edits and bidirectional selections', async () => {
    for (const native of [false, true]) {
    let source = 'aa\r\n😀bb\r\ncc'; const posts = []; let applied;
    const doc = { uri:{ fsPath:'/crlf.tex' }, eol:2,
        positionAt:n => new NativePosition(0,n), offsetAt:p => p.character,
        getText:range => range ? source.slice(range.start.character,range.end.character) : source };
    stub.workspace.openTextDocument = async () => doc;
    stub.window.visibleTextEditors = [];
    stub.WorkspaceEdit = class { replace(uri, range, value) { this.range=range; this.value=value; } };
    const card = { id:1, native, file:doc.uri.fsPath, startOffset:0, endOffset:source.length, lastText:source };
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
    }
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


test('legacy live error messages cannot overwrite annotations covering failed and conventional builds', () => {
    const vm = require('node:vm');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const start = js.indexOf('function paintLiveErrors(');
    const updates = [];
    const context = vm.createContext({ state:{ errorAnnotationsOwned:true },
        setErrorAnnotations:(items, owned) => updates.push({ items, owned }) });
    vm.runInContext(js.slice(start, js.indexOf('\n}\n', start) + 2), context);
    context.paintLiveErrors([]);
    assert.equal(updates.length, 0, 'a later txdlBuilt does not clear mapped compiler errors');
    context.state.errorAnnotationsOwned = false;
    context.paintLiveErrors([{ page:2, file:'/p/paper.tex', line:5, message:'Undefined control sequence.' }]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].items[0].page, 2);
    assert.equal(updates[0].items[0].messages[0], 'Undefined control sequence.');
    assert.equal(updates[0].items[0].exact, false);
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

test('a keystroke with no preview build running starts one at once; a burst while one runs coalesces (#42)', async () => {
    const f = fixture();
    try {
        const { coordinator, state, root } = { ...f, root: f.state.root };
        state.nativeLane = { interactive: true, close: async () => {}, invalidate() {} };
        coordinator.liveOverlay = () => new Map();
        coordinator._nativeWindow = () => [];
        const started = [];
        let finish = null, cur = null;
        coordinator._runInteractive = (st, lane, r, opts, c) => { started.push(Date.now()); cur = c; return new Promise(resolve => { finish = resolve; }); };
        const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
        assert.equal(coordinator._schedulePreview(root, state), true);
        await tick(5);
        assert.equal(started.length, 1, 'idle: the build starts at once, not after the throttle');
        for (let i = 0; i < 20; i++) { coordinator._schedulePreview(root, state); await tick(1); }
        assert.equal(started.length, 1, 'while it runs, keystrokes wait');
        await tick(60);
        // (#42) A build that has shown nothing yet is not cancelled by the burst…
        assert.equal(started.length, 1, 'no key cancels a build before its first page');
        // …which starts the burst's one build as soon as its page is on screen.
        coordinator._previewShown(root, state, cur);
        await tick(5);
        assert.equal(started.length, 2, 'the burst becomes one build once the first page is shown');
        finish(); await tick(5);
        finish(); await tick(5);
        coordinator._schedulePreview(root, state);
        await tick(5);
        assert.equal(started.length, 3, 'idle again: at once');
        finish();
    } finally { f.close(); }
});

// ── Paragraph-first live preview ────────────────────────────────────────────
// The engine sends the paragraph being typed ahead of its page (a
// `paragraph_fragment`), placed on the page shown. See WLaTeX
// docs/paragraph-preview-plan.md.

test('a placed paragraph fragment reaches the panel and counts as the build shown (#42); an unplaced one does not', async () => {
    const f = fixture();
    try {
        const { coordinator, state } = f;
        const root = state.root;
        const fired = [];
        coordinator.onDidInteractive(e => fired.push(e));
        const fragment = { generation: 3, page: 4, index: 0, txdl: { ops: [] }, fonts: {},
            placement: { page: 4, identity: 'h4', dx: 1, dy: 2, clip: [0, 0, 10, 10], clear: [0, 1, 10, 2], below: [0, 2, 10, 10], shift: 0, lines: 3, old_lines: 3 } };
        for (const [placement, shown] of [[null, false], [fragment.placement, true]]) {
            const lane = { close: async () => {}, invalidate() {}, interactiveBuild: async o => { o.onFragment({ ...fragment, placement }); return null; } };
            state.nativeLane = lane;
            const cur = { shown: false, pending: false };
            await coordinator._runInteractive(state, lane, root, {}, cur);
            assert.equal(cur.shown, shown, placement ? 'a placed fragment is the build shown' : 'nothing drawn, nothing shown');
        }
        assert.deepEqual(fired.map(e => [e.kind, e.page, !!e.placement]), [['fragment', 4, false], ['fragment', 4, true]]);
    } finally { f.close(); }
});

test('the webview paints a fragment over the page shown: old paragraph cleared, the band below moved, the fragment at its offset', async () => {
    const vm = require('node:vm');
    const { pathToFileURL } = require('node:url');
    const js = fs.readFileSync(path.resolve(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const txdlCanvas = await import(pathToFileURL(path.resolve(__dirname, '../../../client/txdl-canvas.js')).href);
    const fn = name => { const start = js.indexOf(`function ${name}(`); return js.slice(js.lastIndexOf('\n', start) + 1, js.indexOf('\n}\n', start) + 2); };
    const SP = 65536;
    // A canvas whose context records its calls.
    const canvases = [];
    const canvas = () => {
        const calls = [];
        const ctx = new Proxy({ calls }, { get: (t, k) => k in t ? t[k] : (...a) => calls.push([k, ...a]), set: (t, k, v) => { calls.push([`${String(k)}=`, v]); return true; } });
        const c = { width: 0, height: 0, style: {}, ctx, removed: false, className: '', isConnected: true,
            getContext: () => ctx, remove() { c.removed = true; } };
        canvases.push(c);
        return c;
    };
    const pdf = canvas();
    pdf.width = 1200; pdf.height = 1600;
    const wrap = { inserted: [], querySelector: sel => sel === 'canvas:not(.txdl-overlay)' ? pdf : null,
        insertBefore(el) { this.inserted.push(el); } };
    const state = { openInFlight: false, openSeq: 5, txdl: { pages: new Map() } };
    const renderer = txdlCanvas.createTxdlRenderer({ requestOutlines: async () => ({}) });
    const context = vm.createContext({
        state, window: { devicePixelRatio: 2 }, PT_PER_BP: 72.27 / 72,
        document: { createElement: () => canvas() },
        pagesEl: () => ({ querySelector: () => wrap }),
        txdlPageBox: () => ({ width: 600, height: 800, widthBp: 300 * 72 / 72.27, heightBp: 400 * 72 / 72.27 }),
        visiblePages: () => [4], txdlShouldDefer: () => false, txdlRendererInstance: () => renderer,
    });
    vm.runInContext(['fragmentGeometry', 'removeTxdlFragment', 'clearTxdlFragments', 'selectionGeometryCurrent', 'invalidateSelectionGeometry', 'drawTxdlFragment'].map(fn).join('\n'), context);
    // 2 CSS px per pt at dpr 2: 4 device px per pt; the page origin one inch in.
    const placement = { page: 4, identity: null, dx: 10 * SP, dy: 100 * SP, clip: [0, 0, 200 * SP, 300 * SP],
        clear: [0, 80 * SP, 200 * SP, 120 * SP], below: [0, 120 * SP, 200 * SP, 300 * SP], shift: 12 * SP, lines: 4, old_lines: 3 };
    const txdl = { fonts: [], ops: [{ op: 'rule', x: 0, y: 5 * SP, width: 50 * SP, height: 5 * SP }] };
    const g = context.fragmentGeometry(placement, 2, 2);
    const at = pt => (72.27 + pt) * 4;
    assert.deepEqual([g.clear.y, g.clear.h, g.below.y, g.shift], [at(80), 220 * 4, at(120), 48]);
    await context.drawTxdlFragment({ page: 4, placement, txdl });
    const [base, overlay] = [canvases[1], canvases[2]];
    assert.deepEqual(wrap.inserted, [overlay], 'a canvas of its own, over the PDF');
    assert.ok(base.ctx.calls.some(c => c[0] === 'drawImage' && c[1] === pdf), 'the base is the page as shown');
    const names = overlay.ctx.calls.map(c => c[0]);
    const steps = ['drawImage', 'clip', 'fillRect', 'drawImage', 'translate'].map((n, i, all) => names.indexOf(n, i && names.indexOf(all[i - 1]) + 1));
    assert.ok(steps.every((s, i) => s >= 0 && (i === 0 || s > steps[i - 1])), `base, clip, clear, band, fragment in order: ${names.join(' ')}`);
    const band = overlay.ctx.calls.filter(c => c[0] === 'drawImage')[1];
    assert.equal(band[1], base);
    assert.equal(band[7], at(120) + 48, 'the band below moves down by one line (12 pt)');
    const offset = overlay.ctx.calls.find(c => c[0] === 'translate');
    assert.deepEqual(offset.slice(1), [20, 200], 'the fragment moved by dx, dy in CSS px (under the dpr scale)');
    // The next keystroke's fragment repaints from the same base, not over the last one.
    await context.drawTxdlFragment({ page: 4, placement: { ...placement, shift: 0 }, txdl });
    assert.equal(canvases.length, 3, 'the same canvas and base');
    assert.equal(overlay.ctx.calls.filter(c => c[0] === 'drawImage' && c[1] === base && c.length === 4).length, 2);
    // An overlay of another page than the one measured stays as it is.
    state.txdl.pages.set(4, { canvas: pdf, identity: 'other' });
    const before = overlay.ctx.calls.length;
    await context.drawTxdlFragment({ page: 4, placement: { ...placement, identity: 'h4' }, txdl });
    assert.equal(overlay.ctx.calls.length, before);
    // The page itself replaces it.
    context.removeTxdlFragment(4);
    assert.equal(overlay.removed, true);
});

test('preview timeout preserves source diagnostics and retries only twice without another edit', async t => {
    t.mock.timers.enable({ apis:['Date', 'setTimeout'], now:100000 });
    const f = fixture();
    let retries = 0;
    const lane = { interactive:true, close:async () => {}, interactiveBuild:async () => ({ ok:false,
        diagnostics:[{ severity:'error', producer:true, message:'the live preview made no progress for 20 s' }] }) };
    try {
        Object.assign(f.state, { nativeLane:lane, sourceRevision:1,
            liveDiagnostics:{ revision:1, sequence:1, list:[{severity:'error', line:42, message:'real TeX error'}] } });
        const prior = f.state.liveDiagnostics;
        f.coordinator._schedulePreview = () => { retries++; };
        for (let i = 0; i < 4; i++) {
            await f.coordinator._runInteractive(f.state, lane, f.state.root, {});
            t.mock.timers.tick(3000);
        }
        assert.equal(retries, 2, 'bounded retries cannot create a compilation loop');
        assert.equal(f.state.liveDiagnostics, prior, 'a watchdog cannot replace a real TeX diagnostic');
        assert.equal(f.state.livePreviewError.producer, true);
        const posts = [];
        TexViewer.prototype._postEngine.call({ coord:f.coordinator, context:{ globalState:{ get:() => true } },
            _post:m => posts.push(m) }, f.state);
        assert.equal(posts.at(-1).previewErrorKind, 'producer');
        f.state.sourceRevision++;
        await f.coordinator._runInteractive(f.state, lane, f.state.root, {});
        t.mock.timers.tick(1000);
        assert.equal(retries, 3, 'a fresh edit has its own recovery budget');
        await f.coordinator._runInteractive(f.state, lane, f.state.root, {});
        f.coordinator._clearNativeWork(f.state);
        t.mock.timers.tick(3000);
        assert.equal(retries, 3, 'closing or retiring a lane cancels recovery');
    } finally { f.close(); }
});

test('late live failures and successes cannot replace a newer full compile for the same source', async () => {
    for (const result of [
        {ok:false, diagnostics:[{severity:'error', producer:true, message:'preview timed out'}]},
        {ok:false, diagnostics:[{severity:'error', line:42, message:'older source error'}]},
        {ok:true, diagnostics:[], report:{}}
    ]) {
        const f = fixture(); let release;
        const lane = {close:async () => {}, interactiveBuild:() => new Promise(r => { release = r; })};
        try {
            Object.assign(f.state, { nativeLane:lane, sourceRevision:1, diagnosticsSequence:1 });
            const run = f.coordinator._runInteractive(f.state, lane, f.state.root, {});
            const full = { revision:1, sequence:2, list:[{severity:'error', line:99, message:'latest full compile'}] };
            f.state.compileDiagnostics = full; f.state.diagnosticsSequence = 2;
            f.state.livePreviewError = {revision:1, reason:'latest full compile'};
            release(result); await run;
            assert.equal(f.state.livePreviewError.reason, 'latest full compile');
            assert.equal(f.state.compileDiagnostics, full);
            assert.equal(f.state.liveDiagnostics, undefined);
            assert.equal(f.coordinator._previewRecovery.size, 0);
        } finally { f.close(); }
    }
});

test('successful conventional compilation clears a stale native preview error', async () => {
    const oldEngine = configuredMapEngine;
    const f = fixture();
    configuredMapEngine = 'off';
    try {
        f.state.livePreviewError = {revision:0, reason:'old preview timeout', producer:true};
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(f.state.livePreviewError, null);
    } finally { configuredMapEngine = oldEngine; f.close(); }
});

test('the preview badge distinguishes worker recovery from a source error', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../../../client/tex-viewer.js'), 'utf8');
    const paint = source.slice(source.indexOf('function paintPreviewFallbackBadge()'), source.indexOf('function closeProPanel()'));
    for (const producer of [true, false]) {
        const label = {}, head = {replaceChildren() {}}, reason = {};
        const badge = {dataset:{}, setAttribute() {}, querySelector:() => label};
        const state = {engine:{previewError:'no progress', previewErrorKind:producer ? 'producer' : 'source'}, txdlFallbacks:new Map()};
        vm.runInNewContext(paint + '\npaintPreviewFallbackBadge();', {state, proActive:() => true,
            visiblePages:() => [], el:id => id === 'probadge' ? badge : {querySelector:q => q === '.pro-headstate' ? head : reason}});
        assert.match(badge.title, producer ? /Live preview: no progress/ : /Current source: no progress/);
        assert.equal(badge.title.includes('earlier revision'), !producer,
            'a producer timeout does not claim that the current PDF is obsolete');
        assert.equal(reason.textContent, badge.title);
    }
});

test('a whole-paper text sweep cannot grow the native mapping window', () => {
    const f = fixture();
    try {
        f.state.generation = { pageCount:200 };
        f.state.nativeLane = {close:async()=>{}};
        f.state.map = { native:true, hasPage:() => false, materializedPages:Array.from({length:200},(_,i)=>i+1) };
        const requested = [];
        f.coordinator._scheduleNativeRefresh = () => requested.push(f.coordinator._nativeWindow(f.state));
        for (let page=1;page<=200;page++) f.coordinator.noteRenderedPage(f.state.root,1,page);
        assert.deepEqual(f.coordinator._nativeWindow(f.state),[1,2]);
        assert.equal(requested.length,2);
        f.coordinator.noteNativeViewport(f.state.root,90);
        assert.deepEqual(f.coordinator._nativeWindow(f.state),[89,90,91]);
        f.coordinator.noteNativeViewport(f.state.root,200);
        assert.deepEqual(f.coordinator._nativeWindow(f.state),[199,200]);
    } finally { f.close(); }
});

test('a live map with no saved viewport reads only the first reading window',async()=>{
    const identities = new Map(Array.from({length:104},(_,i)=>[i+1,'page-'+(i+1)]));
    let requested;
    const lane = { liveView:async pages => {requested=pages;return null;} };
    const viewer = {panel:{},root:'/paper/main.tex',coord:{roots:new Map()},
        _liveMapReady:identities,_liveOverlays:identities,_postErrorAnnotations(){},_log(){}};
    await TexViewer.prototype._buildLiveMap.call(viewer,lane);
    assert.deepEqual(requested,[1,2,3,4]);
    await TexViewer.prototype._buildLiveMap.call(viewer,lane,80);
    assert.deepEqual(requested,[80], 'an explicit click reads its page ahead of neighbouring background maps');
});

test('opening and reopening a viewer returns while its first compile is pending',async()=>{
    const root='/paper/main.tex',doc={uri:{fsPath:root}},state={generation:null,compiling:false};
    let builds=0,finish;
    const pending=new Promise(resolve=>{finish=resolve;});
    const viewer={root,panel:{viewColumn:2,reveal(){}},_webviewReady:false,
        coord:{roots:new Map([[root,state]]),rootFor:()=>root,build:()=>{builds++;state.compiling=true;return pending;}},
        _rememberRoot(){},_restoreCursor(){},_postTheme(){},_postSourceDirty(){},_scheduleSourceSave(){},
        refresh:async()=>{},_post(){}};
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;finish();},100);
    try {
        await TexViewer.prototype.open.call(viewer,doc);
        await TexViewer.prototype.open.call(viewer,doc);
        assert.equal(timedOut,false,'opening does not await the producer');
        assert.equal(builds,1,'reopening does not launch a duplicate compile');
    } finally {clearTimeout(timer);finish();}
});

test('coalesced viewer refreshes yield to input and compiler callbacks',async()=>{
    const viewer={_refreshNow:async()=>{viewer.passes++;if(viewer.passes<10)viewer.refresh();},passes:0};
    viewer.refresh=o=>TexViewer.prototype.refresh.call(viewer,o);
    let passesAtCallback;
    const callback=new Promise(resolve=>setImmediate(()=>{passesAtCallback=viewer.passes;resolve();}));
    await viewer.refresh();await callback;
    assert.equal(viewer.passes,10);
    assert.equal(passesAtCallback,1,'reentrant notifications cannot starve the event loop');
});

test('a click on a distant PDF page materializes that window even with an available old map',async()=>{
    const f=fixture();
    try {
        f.state.generation={pageCount:104};
        f.state.nativeLane={close:async()=>{}};
        f.state.map={native:true,available:true,hasPage:p=>p===1};
        let requested;
        f.coordinator._runNativeRefresh=async st=>{
            requested=f.coordinator._nativeWindow(st);
            st.map={native:true,available:true,hasPage:p=>requested.includes(p)};
        };
        assert.equal(await f.coordinator.ensureNativeMap(f.state,100,90),true);
        assert.deepEqual(requested,[89,90,91]);
    } finally {f.close();}
});

test('a distant review change locates one native window without compiling the paper',async()=>{
    const root='/paper/main.tex',h={id:'change',startLine:2,endLine:3},source={
        files:new Map([['main.tex',{text:'header\nchanged paragraph\n'}]]),
        forward:async(file,line,column)=>{assert.deepEqual([file,line,column],['main.tex',2,0]);return {hits:[{item:{page:90}}]};}};
    const lane={source,relative:()=> 'main.tex'},state={nativeLane:lane,map:{native:true,available:true},generation:{pdfHash:'pdf'}};
    let refreshed=0;
    const viewer=Object.assign(Object.create(TexViewer.prototype),{root,_openedPdfHash:'pdf',_review:{focused:new Map([[root,h.id]]),refresh:async()=>{refreshed++;}},
        coord:{roots:new Map([[root,state]]),noteNativeViewport:(r,p)=>{assert.deepEqual([r,p],[root,90]);},
            ensureNativeMap:async(st,timeout,page)=>{assert.equal(st,state);assert.equal(page,90);return true;},
            build:()=>{throw Error('a mapping request cannot compile');}}});
    assert.equal(await TexViewer.prototype.ensureReviewPlacement.call(viewer,root,h),true);
    assert.equal(refreshed,1);
    source.forward=async()=>{state.sourceAhead=true;return {hits:[{item:{page:91}}]};};
    assert.equal(await TexViewer.prototype.ensureReviewPlacement.call(viewer,root,h),false);
    assert.equal(refreshed,1,'a changed source cannot publish an old placement');
});


test('missing runtime stays silent before a paper-engine compatibility warning can run', async () => {
    const f = fixture(), warningCount = warnings.length, noticeCount = notices.length, starts = constructorCalls;
    installed = false;
    fs.writeFileSync(f.state.root, '% !TEX program = pdflatex\n\\documentclass{article}');
    try {
        await f.coordinator.build(f.doc, { quiet:true });
        assert.equal(constructorCalls, starts);
        assert.equal(warnings.length, warningCount);assert.equal(notices.length, noticeCount);
        assert.ok(f.state.generation.ok);assert.ok(!f.state.lastError);
        const posts = [];
        TexViewer.prototype._postEngine.call({coord:f.coordinator,_post:m=>posts.push(m)},
            {...f.state,generation:{runner:'wlatex'},nativeOff:'old compatibility warning'});
        assert.equal(posts.at(-1).state,null,'old native output cannot advertise absent Pro');
    } finally { installed = true; f.close(); }
});


test('hiding unavailable Pro also dismisses an already open introduction', () => {
    const vm=require('node:vm');
    const source=fs.readFileSync(path.join(__dirname,'../../../client/tex-viewer.js'),'utf8');
    const code=source.slice(source.indexOf('function setEngineBadge('),source.indexOf('function paintPreviewFallbackBadge('));
    const badge={hidden:false},panel={hidden:false},intro={hidden:false};
    const state={engine:{state:'disabled'}};
    vm.runInNewContext(code+'\nsetEngineBadge({state:null});', {state,
        el:id=>({probadge:badge,propanel:panel,prointro:intro})[id],
        proActive:()=>false,closeProPanel:()=>{panel.hidden=true;}});
    assert.equal(badge.hidden,true);assert.equal(panel.hidden,true);assert.equal(intro.hidden,true);
    assert.equal(state.engine,null);
});
