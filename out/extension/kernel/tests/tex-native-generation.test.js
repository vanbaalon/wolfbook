const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeBuildLane } = require('../../tex/nativeCompileService');
const { nextGeneration } = require('../../tex/compileService');
const { shipDecision } = require('../../tex/livePolicy');

test('native display generations share the conventional allocator across session reconstruction', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-generation-'));
    const root = path.join(directory, 'paper.tex');
    const pdf = path.join(directory, 'paper.pdf');
    fs.writeFileSync(root, 'Alpha'); fs.writeFileSync(pdf, 'PDF fixture');
    const calls = [];
    const createLane = () => {
        const files = new Map();
        const lane = Object.create(NativeBuildLane.prototype);
        Object.assign(lane, { root, projectDir:directory, buildNumber:0, version:0, edits:Promise.resolve(),
            source:{ files, open:async (file, text) => files.set(file, { text }),
                capture:async () => ({ files:{} }), publish:async () => {}, readPages:async () => ({}) },
            compiler:{ compile:async options => {
                calls.push(options.generation);
                assert.equal(options.timeoutMs, 45000);
                return { success:true, generation:options.generation, pdf, diagnostics:[],
                    build:{ source_bindings:[], page_count:1, pages:[{width_pt:612,height_pt:792}],
                        passes:[], pdf_hash:`pdf-${calls.length}` } };
            } } });
        return lane;
    };
    try {
        const conventionalBefore = nextGeneration();
        const first = await createLane().compile({ timeoutMs:45000 });
        const conventionalBetween = nextGeneration();
        const second = await createLane().compile({ timeoutMs:45000 });
        const conventionalAfter = nextGeneration();
        assert.ok(conventionalBefore < first.generation);
        assert.ok(first.generation < conventionalBetween);
        assert.ok(conventionalBetween < second.generation);
        assert.ok(second.generation < conventionalAfter);
        assert.deepEqual(calls, [1,1], 'SDK numbering starts independently in each session');
        for (const shownGeneration of [first.generation, conventionalBetween]) {
            assert.equal(shipDecision({ shownGeneration, shownPdfHash:first.pdfHash, gen:second }).ship, true);
        }
        assert.equal(shipDecision({ shownGeneration:first.generation, shownPdfHash:second.pdfHash,
            gen:second }).reason, 'identical pdf', 'fresh maps do not require resending unchanged pixels');
    } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});

test('a live preview sends only what differs from disk (and what the engine will not read there)', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-overlays-'));
    const root = path.join(directory, 'paper.tex');
    fs.writeFileSync(root, '\\input{a}\\input{.hidden/b}\\input{link}');
    fs.writeFileSync(path.join(directory, 'a.tex'), 'A');
    fs.mkdirSync(path.join(directory, '.hidden'));
    fs.writeFileSync(path.join(directory, '.hidden', 'b.tex'), 'B');
    fs.writeFileSync(path.join(directory, 'target.tex'), 'T');
    fs.symlinkSync(path.join(directory, 'target.tex'), path.join(directory, 'link.tex'));
    const lane = Object.create(NativeBuildLane.prototype);
    Object.assign(lane, { root, projectDir:directory, source:{ files:new Map([['a.tex', {}]]) } });
    const sourceFiles = ['a.tex', '.hidden/b.tex', 'link.tex', 'missing.tex'].map(f => path.join(directory, f));
    // Nothing edited: only the files the engine skips on disk.
    assert.deepEqual([...lane._interactiveOverlays({ sourceFiles })].sort(),
        [['.hidden/b.tex', 'B'], ['link.tex', 'T']]);
    // An unsaved buffer goes as it is in the editor.
    const overlay = new Map([[path.join(directory, 'a.tex'), 'A edited']]);
    assert.deepEqual(lane._interactiveOverlays({ sourceFiles, overlay }).get('a.tex'), 'A edited');
    assert.equal(lane._interactiveOverlays({ sourceFiles, overlay }).has('paper.tex'), false, 'the saved main file is read from disk');
    fs.rmSync(root);
    assert.throws(() => lane._interactiveOverlays({ sourceFiles }), /ENOENT/, 'a missing main file is still an error');
});

test('shell escape comes only from the user\'s own setting, in a trusted workspace', () => {
    const Module = require('node:module');
    const { coldBuildEnv } = require('../../tex/nativeCompileService');
    const resolve = Module._resolveFilename, load = Module._load;
    let settings = {}, trusted = true;
    const fake = { workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({
        get: (key, fallback) => settings[key]?.effective ?? fallback,
        inspect: key => settings[key] ? { globalValue: settings[key].global, workspaceValue: settings[key].workspace } : undefined,
    }) } };
    Module._load = function (request, ...rest) { return request === 'vscode' ? fake : load.call(this, request, ...rest); };
    try {
        assert.deepEqual(coldBuildEnv(), {});
        settings = { shellEscape: { global: true, effective: true } };
        assert.deepEqual(coldBuildEnv(), { WLATEX_SHELL_ESCAPE: '1' });
        settings = { shellEscape: { workspace: true, effective: true } };
        assert.deepEqual(coldBuildEnv(), {}, 'a workspace settings file cannot turn it on');
        settings = { shellEscape: { global: true, effective: true }, synctex: { effective: true } };
        trusted = false;
        assert.deepEqual(coldBuildEnv(), { WLATEX_SYNCTEX: '1' }, 'not in an untrusted workspace');
    } finally { Module._load = load; Module._resolveFilename = resolve; }
});

test('the settled build is kept for the next session: its first build and first live pages start from it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-kept-seed-'));
    const root = path.join(directory, 'paper.tex');
    const artifacts = path.join(directory, 'artifacts');
    const settledSeed = path.join(directory, 'cache', 'settled', 'paper');
    fs.mkdirSync(artifacts);
    fs.writeFileSync(root, 'Alpha');
    fs.writeFileSync(path.join(artifacts, 'paper.pdf'), 'PDF fixture');
    fs.writeFileSync(path.join(artifacts, 'paper.aux'), '\\newlabel{x}{{1}{1}}');
    fs.writeFileSync(path.join(artifacts, 'paper.bbl'), '\\begin{thebibliography}{1}\\end{thebibliography}');
    const seeds = [];
    const createLane = settled => {
        const files = new Map();
        const lane = Object.create(NativeBuildLane.prototype);
        Object.assign(lane, { root, projectDir:directory, buildNumber:0, version:0, edits:Promise.resolve(),
            settledSeed, _keptSeed:null, coldReport:null,
            source:{ files, open:async (file, text) => files.set(file, { text }),
                capture:async () => ({ files:{} }), publish:async () => {}, readPages:async () => ({}) },
            compiler:{ compile:async options => {
                seeds.push(options.seed);
                return { success:true, generation:options.generation, pdf:path.join(artifacts, 'paper.pdf'),
                    artifact_directory:artifacts, diagnostics:[],
                    build:{ source_bindings:[], page_count:1, pages:[{width_pt:612,height_pt:792}], passes:[],
                        pdf_hash:'pdf', settled, main_file:'paper.tex',
                        auxiliary_files:{ 'paper.aux':'h1', 'paper.bbl':'h2' },
                        tool_inputs:{ bibtex:{ key:'k', outputs:['paper.bbl'] } } } };
            } } });
        return lane;
    };
    try {
        // A new project: nothing kept, nothing seeds the first build.
        const first = createLane(true);
        assert.deepEqual(first._auxiliaryTexts(), {});
        await first.compile({ timeoutMs:1000 });
        assert.equal(seeds[0], null);
        const kept = JSON.parse(fs.readFileSync(path.join(settledSeed, 'build.json'), 'utf8'));
        assert.deepEqual(kept, { main_file:'paper.tex', settled:true, auxiliary_files:{ 'paper.aux':'h1', 'paper.bbl':'h2' },
            tool_inputs:{ bibtex:{ key:'k', outputs:['paper.bbl'] } } });
        assert.equal(fs.readFileSync(path.join(settledSeed, 'paper.aux'), 'utf8'), '\\newlabel{x}{{1}{1}}');
        // The next session: its live pages read the kept files before any
        // build of its own, and its first build is seeded with them.
        const next = createLane(false);
        assert.deepEqual(Object.keys(next._auxiliaryTexts()).sort(), ['paper.aux', 'paper.bbl']);
        await next.compile({ timeoutMs:1000 });
        assert.equal(seeds[1], settledSeed);
        // An unsettled build is not kept over the settled one.
        assert.equal(JSON.parse(fs.readFileSync(path.join(settledSeed, 'build.json'), 'utf8')).settled, true);
        // A kept build of another main file is not this one's seed.
        fs.writeFileSync(path.join(settledSeed, 'build.json'), JSON.stringify({ ...kept, main_file:'other.tex' }));
        const other = createLane(false);
        assert.deepEqual(other._auxiliaryTexts(), {});
        await other.compile({ timeoutMs:1000 });
        assert.equal(seeds[2], null);
    } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});
