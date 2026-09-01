'use strict';

// The lines of a cell that are running RIGHT NOW.
//
//   node out/extension/kernel/tests/running-lines.test.js
//
// checkout.js already evaluates a cell one top-level expression at a time, and
// each part already carries the line range it came from — so this feature is
// about SHOWING something that was known, not computing it. What can go wrong
// is therefore not arithmetic but lifetime: a mark left behind says a
// computation is running when none is, which is worse than never painting it.
//
// The vscode-facing half is driven through a stub so the decoration calls
// themselves are observable.

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

let pass = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// --- a vscode stub that records every decoration call ----------------------

const decoCalls = [];        // { editor, typeId, ranges }
let visibleEditors = [];
let config = {};
let disposedTypes = 0;
let nextTypeId = 0;

function makeEditor(uriString, lineCount, lineLen = 40) {
    const ed = {
        document: {
            uri: { toString: () => uriString },
            lineCount,
            lineAt: (n) => {
                if (n < 0 || n >= lineCount) throw new RangeError('no such line');
                return { text: 'x'.repeat(lineLen) };
            },
        },
        setDecorations: (type, ranges) => decoCalls.push({ uri: uriString, typeId: type.id, ranges }),
    };
    return ed;
}

const stub = {
    window: {
        get visibleTextEditors() { return visibleEditors; },
        createTextEditorDecorationType: (opts) => ({
            id: nextTypeId++, opts, dispose: () => { disposedTypes++; },
        }),
        onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    },
    workspace: {
        getConfiguration: (section) => ({
            get: (key, dflt) => {
                const k = `${section}.${key}`;
                return Object.prototype.hasOwnProperty.call(config, k) ? config[k] : dflt;
            },
        }),
    },
    Range: class { constructor(a, b, c, d) { Object.assign(this, { sl: a, sc: b, el: c, ec: d }); } },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4 },
};

const RL = (() => {
    const orig = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') return stub;
        return orig.call(this, req, ...rest);
    };
    try { return require('../../execution/running-lines'); }
    finally { Module._load = orig; }
})();

const reset = () => {
    decoCalls.length = 0;
    visibleEditors = [];
    config = {};
    RL.clearRunning();
    decoCalls.length = 0;
};
/** Ranges actually painted (non-empty) in the recorded calls. */
const painted = () => decoCalls.filter(c => c.ranges && c.ranges.length);

// ── the breath ────────────────────────────────────────────────────────────

console.log('pulseAlpha — the breath curve');

t('stays inside the band at every step', () => {
    for (let i = 0; i < RL.STEPS * 3; i++) {
        const a = RL.pulseAlpha(i);
        assert.ok(a >= RL.ALPHA_LO - 1e-9 && a <= RL.ALPHA_HI + 1e-9,
            `step ${i} gave ${a}, outside [${RL.ALPHA_LO}, ${RL.ALPHA_HI}]`);
    }
});

t('is a closed loop — the cycle rejoins itself', () => {
    // A curve that jumped at the wrap would read as a flicker, not a breath.
    assert.ok(Math.abs(RL.pulseAlpha(0) - RL.pulseAlpha(RL.STEPS)) < 1e-9);
    assert.ok(Math.abs(RL.pulseAlpha(1) - RL.pulseAlpha(RL.STEPS + 1)) < 1e-9);
});

t('rises then falls, rather than sawtoothing', () => {
    const xs = Array.from({ length: RL.STEPS }, (_, i) => RL.pulseAlpha(i));
    const peak = xs.indexOf(Math.max(...xs));
    assert.ok(peak > 0 && peak < RL.STEPS - 1, `peak at ${peak} of ${RL.STEPS}`);
    for (let i = 1; i <= peak; i++) assert.ok(xs[i] >= xs[i - 1], 'rises to the peak');
    for (let i = peak + 1; i < xs.length; i++) assert.ok(xs[i] <= xs[i - 1], 'falls after it');
});

t('never reaches an alpha that would compete with the text', () => {
    // The point of the feature is to be noticeable and then ignorable.
    assert.ok(RL.ALPHA_HI <= 0.25, `high end ${RL.ALPHA_HI} is too strong for text to sit on`);
    assert.ok(RL.ALPHA_LO >= 0.04, `low end ${RL.ALPHA_LO} would be invisible`);
});

t('breathes slowly — this is ambient state, not a progress bar', () => {
    assert.ok(RL.CYCLE_MS >= 1200, `a ${RL.CYCLE_MS}ms cycle beside text is a strobe`);
});

t('negative and huge steps are handled, not thrown on', () => {
    assert.ok(Number.isFinite(RL.pulseAlpha(-3)));
    assert.ok(Number.isFinite(RL.pulseAlpha(1e6)));
    assert.strictEqual(RL.pulseAlpha(0, 0), RL.ALPHA_LO, 'zero steps degrades to the low end');
});

// ── the range ─────────────────────────────────────────────────────────────

console.log('rangeFor — clamped to the document that will receive it');

t('an ordinary range passes through', () => {
    assert.deepStrictEqual(RL.rangeFor({ startLine: 2, endLine: 5 }, 10), { startLine: 2, endLine: 5 });
});

t('a range past the end is CLAMPED, not dropped', () => {
    // The cell can be edited while it runs; the split ran against older text.
    assert.deepStrictEqual(RL.rangeFor({ startLine: 2, endLine: 99 }, 6), { startLine: 2, endLine: 5 });
});

t('a range entirely past the end returns null, not the last line', () => {
    // Painting the last line as though it were running is a wrong answer;
    // painting nothing is an honest one.
    assert.strictEqual(RL.rangeFor({ startLine: 40, endLine: 44 }, 6), null);
});

t('reversed bounds are normalised', () => {
    assert.deepStrictEqual(RL.rangeFor({ startLine: 7, endLine: 3 }, 10), { startLine: 3, endLine: 7 });
});

t('a single-line expression is a one-line range', () => {
    assert.deepStrictEqual(RL.rangeFor({ startLine: 4, endLine: 4 }, 10), { startLine: 4, endLine: 4 });
});

t('rubbish input yields null rather than an exception', () => {
    assert.strictEqual(RL.rangeFor(null, 10), null);
    assert.strictEqual(RL.rangeFor({ startLine: NaN, endLine: 2 }, 10), null);
    assert.strictEqual(RL.rangeFor({ startLine: 0, endLine: 0 }, 0), null);
});

// ── reduced motion ────────────────────────────────────────────────────────

console.log('reduced motion');

t('workbench.reduceMotion:on stops the animation', () => {
    assert.strictEqual(RL.shouldAnimate('on'), false);
    assert.strictEqual(RL.shouldAnimate('off'), true);
    assert.strictEqual(RL.shouldAnimate('auto'), true);
    assert.strictEqual(RL.shouldAnimate(undefined), true);
});

t('but the lines are STILL marked — which ones run is information', () => {
    reset();
    config['workbench.reduceMotion'] = 'on';
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 1, endLine: 3 });
    assert.ok(painted().length >= 1, 'the mark must still be painted');
    RL.clearRunning();
});

// ── painting ──────────────────────────────────────────────────────────────

console.log('painting');

t('marks exactly the sub-expression’s lines, not the whole cell', () => {
    reset();
    const ed = makeEditor('cell:1', 30);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 12, endLine: 14 });
    const p = painted();
    assert.strictEqual(p.length, 1, 'exactly one decoration type carries the range');
    const r = p[0].ranges[0];
    assert.strictEqual(r.sl, 12);
    assert.strictEqual(r.el, 14);
    RL.clearRunning();
});

t('only ONE step of the breath is painted at a time', () => {
    // Every other type must be explicitly emptied, or the alphas stack up and
    // the mark gets darker every tick until it is a solid block.
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 1 });
    const nonEmpty = decoCalls.filter(c => c.ranges.length).length;
    const empty = decoCalls.filter(c => !c.ranges.length).length;
    assert.strictEqual(nonEmpty, 1, `${nonEmpty} types painted at once`);
    assert.strictEqual(empty, RL.STEPS - 1, 'all the others are cleared');
    RL.clearRunning();
});

t('a second call replaces the first mark', () => {
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 0 });
    decoCalls.length = 0;
    RL.showRunning({ document: ed.document }, { startLine: 5, endLine: 6 });
    const p = painted();
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].ranges[0].sl, 5, 'the new range, and only it');
    RL.clearRunning();
});

t('a cell not currently visible is simply not painted', () => {
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [];                      // scrolled out of view
    assert.doesNotThrow(() =>
        RL.showRunning({ document: ed.document }, { startLine: 1, endLine: 2 }));
    RL.clearRunning();
});

t('scrolling back into view re-applies the mark', () => {
    // A cell editor that comes back is a NEW object with no decorations on it,
    // so without this the mark vanishes part-way through a long computation.
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [];
    RL.showRunning({ document: ed.document }, { startLine: 1, endLine: 2 });
    visibleEditors = [ed];
    decoCalls.length = 0;
    RL.refresh();
    assert.strictEqual(painted().length, 1, 'refresh must repaint');
    RL.clearRunning();
});

// ── it actually breathes ──────────────────────────────────────────────────
//
// A pulse that never ticks is the silent-failure mode: everything above would
// still pass while the mark sat perfectly still. So watch it move, and then
// watch it stop.

console.log('the animation runs');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const asyncTests = [];
const at = (name, fn) => asyncTests.push({ name, fn });

at('the painted step advances on its own', async () => {
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 1 });
    const first = painted()[0].typeId;
    decoCalls.length = 0;
    await sleep(Math.round(RL.CYCLE_MS / RL.STEPS) + 120);
    const later = painted();
    assert.ok(later.length >= 1, 'the timer must repaint');
    assert.notStrictEqual(later[later.length - 1].typeId, first,
        'a different step of the breath — otherwise the mark is static');
    RL.clearRunning();
});

at('and stops the moment it is cleared', async () => {
    // A timer left running after the cell finishes would keep repainting for
    // the rest of the session.
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 1 });
    RL.clearRunning();
    decoCalls.length = 0;
    await sleep(Math.round(RL.CYCLE_MS / RL.STEPS) * 2 + 120);
    assert.strictEqual(decoCalls.length, 0, 'no repaints after clearing');
});

at('reduced motion really does stand still', async () => {
    reset();
    config['workbench.reduceMotion'] = 'on';
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 1 });
    decoCalls.length = 0;
    await sleep(Math.round(RL.CYCLE_MS / RL.STEPS) * 2 + 120);
    assert.strictEqual(decoCalls.length, 0, 'marked, but not animated');
    RL.clearRunning();
});

// ── the lifetime, which is the part that matters ──────────────────────────

console.log('clearing');

t('clearRunning empties every decoration type', () => {
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 1, endLine: 2 });
    decoCalls.length = 0;
    RL.clearRunning();
    assert.strictEqual(painted().length, 0, 'nothing may remain painted');
    assert.strictEqual(decoCalls.length, RL.STEPS, 'every type is explicitly emptied');
});

t('it clears editors it never painted, too', () => {
    // A cell editor can be recreated while a decoration is on it, so clearing
    // only the last editor we happened to paint is not enough.
    reset();
    const a = makeEditor('cell:1', 10);
    visibleEditors = [a];
    RL.showRunning({ document: a.document }, { startLine: 1, endLine: 2 });
    const b = makeEditor('cell:2', 10);
    visibleEditors = [a, b];
    decoCalls.length = 0;
    RL.clearRunning();
    assert.ok(decoCalls.some(c => c.uri === 'cell:2'), 'the other editor is cleared as well');
});

t('refresh after clearing paints nothing', () => {
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 1, endLine: 2 });
    RL.clearRunning();
    decoCalls.length = 0;
    RL.refresh();
    assert.strictEqual(decoCalls.length, 0, 'there is nothing to refresh');
});

t('clearing twice is harmless', () => {
    reset();
    assert.doesNotThrow(() => { RL.clearRunning(); RL.clearRunning(); });
});

t('a range that has fallen off the end clears instead of painting', () => {
    reset();
    const ed = makeEditor('cell:1', 3);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 40, endLine: 41 });
    assert.strictEqual(painted().length, 0);
});

// ── the setting ───────────────────────────────────────────────────────────

console.log('the setting');

t('turning it off paints nothing at all', () => {
    reset();
    config['wolfbook.notebook.highlightRunningLines'] = false;
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 1, endLine: 2 });
    assert.strictEqual(painted().length, 0);
});

t('it is declared, with a default of true', () => {
    const pkg = require('../../../../package.json');
    const cfg = pkg.contributes.configuration;
    const props = Array.isArray(cfg) ? Object.assign({}, ...cfg.map(c => c.properties)) : cfg.properties;
    const dec = props['wolfbook.notebook.highlightRunningLines'];
    assert.ok(dec, 'an undeclared setting is one nobody can find');
    assert.strictEqual(dec.default, true);
});

// ── the wiring ────────────────────────────────────────────────────────────

console.log('wiring into the execution loop');

const CHECKOUT = fs.readFileSync(
    path.join(__dirname, '..', '..', 'execution', 'checkout.js'), 'utf8');

t('a comment-only part is not marked as running', () => {
    // It is stepped over, not evaluated. Marking it would claim a computation
    // on a line where none is happening, and a heavily commented cell would
    // have the mark racing down it for no reason.
    const i = CHECKOUT.indexOf('runningLines.showRunning');
    const before = CHECKOUT.slice(Math.max(0, i - 400), i);
    assert.ok(/startsWith\('\(\*'\)[\s\S]{0,40}endsWith\('\*\)'\)/.test(before),
        'the call must be gated on the part being real code');
});

t('the mark is set from the sub-expression loop, with its own range', () => {
    assert.ok(/runningLines\.showRunning\(currentExecution\.execution\.cell, subExprs\[i\]\)/.test(CHECKOUT),
        'it must use the range the split already produced, not a re-derived one');
});

t('it is cleared in the cell’s finally, so every ending clears it', () => {
    // Success, failure, abort, kernel death all leave through there. This is
    // the whole safety argument for the feature.
    const i = CHECKOUT.indexOf('} finally {');
    assert.ok(i > 0, 'the cell-level finally must exist');
    const body = CHECKOUT.slice(i, i + 500);
    assert.ok(/runningLines\.clearRunning\(\)/.test(body),
        'clearRunning must be in the finally, not on the success path');
});

t('the finally encloses the sub-expression loop', () => {
    // A clear that cannot run for the paths that paint would be no clear.
    const loop = CHECKOUT.indexOf('for (let i = 0; i < subExprs.length');
    const fin = CHECKOUT.indexOf('} finally {');
    assert.ok(loop > 0 && fin > loop, 'the loop must sit inside the guarded block');
});

t('a decoration can never stop an evaluation', () => {
    // The rule EditorFlash already records: decoration is decoration.
    const i = CHECKOUT.indexOf('runningLines.showRunning');
    const around = CHECKOUT.slice(Math.max(0, i - 200), i + 200);
    assert.ok(/try \{[\s\S]{0,120}runningLines\.showRunning/.test(around),
        'the call must be wrapped');
    assert.ok(/catch \(_\)/.test(around), 'and its failure swallowed');
});

t('it is disposed when the extension shuts down', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', '..', 'extension.js'), 'utf8');
    const i = ext.indexOf('function deactivate()');
    assert.ok(i > 0);
    assert.ok(/running-lines'\)\.dispose\(\)/.test(ext.slice(i, i + 400)),
        'deactivate must dispose the decoration types');
});

t('dispose releases every type it made', () => {
    reset();
    const before = disposedTypes;
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 1 });
    RL.dispose();
    assert.strictEqual(disposedTypes - before, RL.STEPS, 'all of them');
});

(async () => {
    for (const a of asyncTests) {
        try { await a.fn(); pass++; console.log(`  ✓ ${a.name}`); }
        catch (e) { console.error(`  ✗ ${a.name}\n    ${e.message}`); process.exitCode = 1; }
    }
    RL.dispose();
    console.log(`\n${pass} assertions passed`);
})();
