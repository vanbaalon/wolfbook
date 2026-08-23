// tex-overlay.test.js — what the compiler is handed, and when it is spared.
//
//   node out/extension/kernel/tests/tex-overlay.test.js
//
// `RenderCoordinator.liveOverlay` decides which text each source file has FOR
// THIS COMPILE. Two things ride on it, and neither is visible anywhere else:
//
//   · unsaved buffers shadow their files, which is the live render;
//   · folded sections are left out — and ONLY here, because the .tex is shared
//     and a colleague must see the whole paper.
//
// A fold that never reached the overlay would be a control that does nothing,
// and the fold module's own suite would still be green — it tests a text
// transform, not whether anybody calls it.
//
// The last section covers the OTHER half of a rebuild: whether it is allowed
// to finish. A live build that is killed a moment before it lands is work paid
// for and thrown away, and on a paper whose compile outlasts the pause that
// triggers it that is most of them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- the smallest vscode RenderCoordinator needs to be constructed ----------
const docs = [];
const stub = {
    workspace: {
        get textDocuments() { return docs; },
        getConfiguration: () => ({ get: (_k, d) => d }),
        workspaceFolders: [],
        onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
        createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
        createTextEditorDecorationType: () => ({ dispose() {} }),
        get visibleTextEditors() { return []; },
    },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
    Range: class { constructor(a, b) { this.start = a; this.end = b; } },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: { createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
};

const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? stub : origLoad.call(this, req, ...rest); };
for (const m of ['../../tex/renderUi', '../../tex/collapse']) {
    try { delete require.cache[require.resolve(m)]; } catch (_) { /* first run */ }
}
const { RenderCoordinator } = require('../../tex/renderUi');
const { MARK, MARK_END, PREFIX } = require('../../tex/collapse');
Module._load = origLoad;

// --- a paper on disk --------------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-overlay-'));
const ROOT = path.join(DIR, 'paper.tex');
const CHILD = path.join(DIR, 'sections', 'two.tex');

const PLAIN = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{The pairing}',
    'First prose line.',
    '\\input{sections/two}',
    '\\end{document}',
].join('\n');

const FOLDED = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{The pairing}',
    `${MARK} The pairing`,
    'First prose line.',
    MARK_END,
    '\\input{sections/two}',
    '\\end{document}',
].join('\n');

const CHILD_FOLDED = [
    '\\section{The measure}',
    `${MARK} The measure`,
    'A line of the second section.',
    MARK_END,
].join('\n');

fs.mkdirSync(path.dirname(CHILD), { recursive: true });

function coord(files) {
    const c = new RenderCoordinator({ get: () => ({ model: { objects: [] } }) }, { appendLine() {} });
    c.roots.set(ROOT, { files, generation: null });
    return c;
}
const write = (f, text) => fs.writeFileSync(f, text, 'utf8');

test('NO FOLDS AND NOTHING UNSAVED MEANS NO OVERLAY AT ALL', () => {
    // The common case must cost nothing: with no overlay the compile reads the
    // project directly and latexmk keeps its .aux cache.
    write(ROOT, PLAIN);
    write(CHILD, '\\section{The measure}\nA line of the second section.\n');
    docs.length = 0;
    assert.strictEqual(coord([ROOT, CHILD]).liveOverlay(ROOT), null);
});

test('A FOLDED SECTION IS LEFT OUT OF THE COPY THE COMPILER IS HANDED', () => {
    write(ROOT, FOLDED);
    write(CHILD, '\\section{The measure}\nA line of the second section.\n');
    docs.length = 0;
    const m = coord([ROOT, CHILD]).liveOverlay(ROOT);
    assert.ok(m, 'a fold alone is reason enough for an overlay');
    const text = m.get(ROOT);
    assert.ok(text, 'the root is shadowed');
    assert.ok(text.includes(PREFIX + 'First prose line.'), 'the folded line is commented in the copy');
    assert.ok(/^\\section\{The pairing\}$/m.test(text), 'the heading still typesets');
    assert.ok(/^\\end\{document\}$/m.test(text), 'and the document still ends');
});

test('AND THE FILE ON DISK IS NOT TOUCHED — the whole point', () => {
    // If this ever fails, a colleague on Overleaf is missing a section.
    assert.strictEqual(fs.readFileSync(ROOT, 'utf8'), FOLDED,
        'the .tex still holds every word it did');
    assert.ok(!fs.readFileSync(ROOT, 'utf8').includes(PREFIX),
        'and nothing in it is commented out');
});

test('THE COPY IS LINE FOR LINE WITH THE FILE', () => {
    // The render map records source line numbers; a copy whose lines had
    // shifted would put every click below the fold a few lines out.
    write(ROOT, FOLDED);
    docs.length = 0;
    const text = coord([ROOT]).liveOverlay(ROOT).get(ROOT);
    assert.strictEqual(text.split('\n').length, FOLDED.split('\n').length);
});

test('A FOLD IN AN \\input FILE IS APPLIED TOO', () => {
    // Papers here are split across files, and a fold in a child must work the
    // same — the overlay covers every source file, not just the root.
    write(ROOT, PLAIN);
    write(CHILD, CHILD_FOLDED);
    docs.length = 0;
    const m = coord([ROOT, CHILD]).liveOverlay(ROOT);
    assert.ok(m && m.has(CHILD), 'the child is shadowed');
    assert.ok(m.get(CHILD).includes(PREFIX + 'A line of the second section.'));
    assert.ok(!m.has(ROOT), 'and the root, which has no fold, is left alone');
});

test('AN UNSAVED BUFFER STILL WINS, AND ITS OWN FOLDS ARE APPLIED', () => {
    // The reader folds a section and keeps typing: the overlay must carry
    // their unsaved text, folded — not the file, and not their text unfolded.
    write(ROOT, PLAIN);
    const buffer = FOLDED.replace('First prose line.', 'First prose line, just typed.');
    docs.length = 0;
    docs.push({ uri: { fsPath: ROOT }, isDirty: true, isClosed: false, getText: () => buffer });
    const text = coord([ROOT]).liveOverlay(ROOT).get(ROOT);
    assert.ok(text.includes(PREFIX + 'First prose line, just typed.'),
        'the unsaved words are there, and folded');
    assert.ok(!text.includes('First prose line.\n'), 'the file\'s older text is not');
});

test('an unsaved buffer with no folds is shadowed exactly as before', () => {
    write(ROOT, PLAIN);
    docs.length = 0;
    const typed = PLAIN.replace('First prose line.', 'Typed.');
    docs.push({ uri: { fsPath: ROOT }, isDirty: true, isClosed: false, getText: () => typed });
    assert.strictEqual(coord([ROOT]).liveOverlay(ROOT).get(ROOT), typed);
});

test('THE READ CACHE NEVER SERVES A STALE FILE', () => {
    // The overlay reads every source file on every rebuild — once per typing
    // pause — so the reads are cached on (mtime, size). A cache that missed an
    // edit would compile yesterday's paper, which is worse than any saving it
    // could buy, so the invalidation is asserted for the hardest case: a file
    // whose LENGTH does not change.
    write(ROOT, FOLDED);
    docs.length = 0;
    const first = coord([ROOT]).liveOverlay(ROOT).get(ROOT);
    assert.ok(first.includes(PREFIX + 'First prose line.'));

    const sameLength = FOLDED.replace('First prose line.', 'First prose LINE!');
    assert.strictEqual(sameLength.length, FOLDED.length, 'the fixture really is the same size');
    write(ROOT, sameLength);
    const second = coord([ROOT]).liveOverlay(ROOT).get(ROOT);
    assert.ok(second.includes(PREFIX + 'First prose LINE!'),
        'the edit is picked up, not served from the cache');
});

test('a source file that has gone missing does not break the build', () => {
    write(ROOT, PLAIN);
    docs.length = 0;
    const m = coord([ROOT, path.join(DIR, 'not-there.tex')]).liveOverlay(ROOT);
    assert.strictEqual(m, null, 'nothing to shadow, and nothing thrown');
});

// --- AND WHETHER A REBUILD IS ALLOWED TO FINISH ------------------------------

/** A document stub good enough for build() to resolve a root from. */
const docFor = (f) => ({ uri: { fsPath: f, scheme: 'file', path: f }, isDirty: false, isClosed: false,
    getText: () => fs.readFileSync(f, 'utf8'), version: 1, lineCount: 1 });

function coordForBuild() {
    // mapEngine anything but auto/lualatex, so build() does not probe for one.
    stub.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'mapEngine' ? 'pdflatex' : d) });
    const c = new RenderCoordinator({ get: () => ({ model: { objects: [] } }) }, { appendLine() {} });
    const st = c.roots.get(ROOT) || { root: ROOT, files: [ROOT] };
    c.roots.set(ROOT, Object.assign(st, {
        root: ROOT, files: [ROOT],
        // A generation that does NOT match the sources, so build() gets past
        // "nothing changed" and reaches the decision under test.
        generation: { sourceSnapshotHash: 'stale', ok: true, pageCount: 1 },
        map: null, compiling: false, liveCompiling: false, liveQueued: false, running: null,
    }));
    c.rootOf.set(ROOT, ROOT);
    return c;
}

test('A LIVE REBUILD DOES NOT KILL THE LIVE REBUILD ALREADY RUNNING', async () => {
    // Measured on the real paper: a rebuild takes ~1.4 s and the pause that
    // triggers it is 900 ms, so a reader typing in ordinary bursts used to
    // abort build after build a moment before each one landed — the page
    // updating rarely, or never, and worse as the paper grows.
    write(ROOT, PLAIN);
    docs.length = 0;
    const c = coordForBuild();
    const st = c.roots.get(ROOT);
    let aborted = 0;
    st.running = { abort: () => { aborted++; } };
    st.compiling = true;
    st.liveCompiling = true;

    let scheduled = 0;
    c.scheduleLive = () => { scheduled++; };

    await c.build(docFor(ROOT), { live: true });
    assert.strictEqual(aborted, 0, 'the build in flight was left to finish');
    assert.strictEqual(st.liveQueued, true, 'and another round is asked for instead');
    assert.strictEqual(scheduled, 0, 'not started yet — the one running has not landed');
});

test('but a SAVE still takes precedence and aborts it', async () => {
    // A deliberate build is the reader asking for it NOW. Only the automatic
    // per-keystroke rebuild waits its turn.
    write(ROOT, PLAIN);
    docs.length = 0;
    const c = coordForBuild();
    const st = c.roots.get(ROOT);
    let aborted = 0;
    st.running = { abort: () => { aborted++; throw new Error('stop here'); } };
    st.compiling = true;
    st.liveCompiling = true;

    try { await c.build(docFor(ROOT), { authoritative: true }); } catch (_) { /* the stub stops it */ }
    assert.strictEqual(aborted, 1, 'the live build was aborted for it');
    assert.strictEqual(st.liveQueued, false, 'and nothing was queued');
});

test('a live rebuild with NOTHING running is not queued behind a ghost', async () => {
    write(ROOT, PLAIN);
    docs.length = 0;
    const c = coordForBuild();
    const st = c.roots.get(ROOT);
    st.running = null;
    st.liveCompiling = false;
    // It will try to compile for real, so stop it at the first thing after the
    // decision: a compile that cannot spawn still proves we got past the guard.
    c.log = () => {};
    const p = c.build(docFor(ROOT), { live: true });
    assert.strictEqual(st.liveQueued, false, 'nothing was queued');
    if (st.running) st.running.abort();
    try { await p; } catch (_) { /* aborted on purpose */ }
});

(async () => {
    console.log('what the compiler is handed, and when, executed\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log('  ok   ' + name); }
        catch (e) {
            fail++;
            console.log('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* fine */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
