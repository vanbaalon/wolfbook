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
const typesById = new Map();
/** The line wash carries a backgroundColor; the outline carries a border. */
const isWash = (typeId) => !!(typesById.get(typeId) || {}).backgroundColor;

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
        createTextEditorDecorationType: (opts) => {
            const t = { id: nextTypeId++, opts, dispose: () => { disposedTypes++; } };
            typesById.set(t.id, opts);
            return t;
        },
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
/** The lines carrying the running-lines WASH (as opposed to the cell outline). */
const washedLines = () => {
    const out = [];
    for (const c of decoCalls) {
        if (!isWash(c.typeId)) continue;
        for (const r of (c.ranges || [])) out.push(r.sl);
    }
    return out.sort((a, b) => a - b);
};

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

// ── painting ──────────────────────────────────────────────────────────────

console.log('painting');

t('shades exactly the sub-expression’s lines, not the whole cell', () => {
    reset();
    const ed = makeEditor('cell:1', 30);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 12, endLine: 14 });
    assert.deepStrictEqual(washedLines(), [12, 13, 14]);
    RL.clearRunning();
});

t('the whole cell is outlined while only the running lines are shaded', () => {
    // The two marks answer different questions: which CELL, and which LINES.
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 3, endLine: 4 });
    const shaded = [];
    const bordered = new Set();
    for (const c of decoCalls) {
        for (const r of (c.ranges || [])) {
            if (isWash(c.typeId)) shaded.push(r.sl); else bordered.add(r.sl);
        }
    }
    assert.strictEqual(bordered.size, 10, 'every line of the cell is bordered');
    assert.deepStrictEqual(shaded.sort((a, b) => a - b), [3, 4],
        'only the running lines are shaded');
    RL.clearRunning();
});

t('the outline is a box, not a box per line', () => {
    reset();
    const ed = makeEditor('cell:1', 5);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 0 });
    // top on the first line, bottom on the last, sides in between.
    assert.strictEqual(RL.edgeFor(0, 0, 4), 'top');
    assert.strictEqual(RL.edgeFor(2, 0, 4), 'middle');
    assert.strictEqual(RL.edgeFor(4, 0, 4), 'bottom');
    assert.strictEqual(RL.edgeFor(0, 0, 0), 'single', 'a one-line cell is closed on all sides');
    RL.clearRunning();
});

t('nothing animates', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'execution', 'running-lines.js'), 'utf8');
    assert.ok(!/setInterval/.test(src), 'no timer — a moving mark beside text cannot be ignored');
    assert.ok(!/pulse|blink|breath\w*\(/.test(src), 'and no pulse left behind');
});

t('the cell outline is a hairline, and translucent', () => {
    // It runs the whole way round the cell, so it has much more length to be
    // loud with than the wash has area. A solid 2px gold frame read as exactly
    // that; reported.
    assert.ok(RL.BORDER_PX <= 1, `${RL.BORDER_PX}px reads as a frame, not a hint`);
    assert.ok(RL.BORDER_ALPHA <= 0.55,
        `${RL.BORDER_ALPHA} is too strong for a line that long`);
    assert.ok(RL.BORDER_ALPHA >= 0.2,
        `${RL.BORDER_ALPHA} would not be findable`);
});

t('the outline is still stronger than the wash', () => {
    // They answer different questions at different scales: the border says
    // WHICH CELL from across the page, the wash says which lines once you are
    // reading it. Inverting that would make the cell hard to find.
    assert.ok(RL.BORDER_ALPHA > RL.LINE_ALPHA,
        'the coarse mark must not be fainter than the fine one');
});

t('the wash is faint enough to read code through', () => {
    assert.ok(RL.LINE_ALPHA <= 0.12, `${RL.LINE_ALPHA} would compete with the syntax colours`);
    assert.ok(RL.LINE_ALPHA >= 0.05, `${RL.LINE_ALPHA} would be invisible`);
});

t('a second call replaces the first mark', () => {
    reset();
    const ed = makeEditor('cell:1', 10);
    visibleEditors = [ed];
    RL.showRunning({ document: ed.document }, { startLine: 0, endLine: 0 });
    decoCalls.length = 0;
    RL.showRunning({ document: ed.document }, { startLine: 5, endLine: 6 });
    assert.deepStrictEqual(washedLines(), [5, 6], 'the new range, and only it');
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
    assert.deepStrictEqual(washedLines(), [1, 2], 'refresh must repaint the wash');
    assert.ok(painted().some(c => !isWash(c.typeId)), 'and the outline with it');
    RL.clearRunning();
});

// ── the queue ─────────────────────────────────────────────────────────────
//
// A queued cell is accepted but not started. It gets the same outline, DASHED:
// a broken line is what "not yet" looks like without needing a legend.

console.log('queued cells');

t('a queued cell is outlined dashed, and more faintly than a running one', () => {
    assert.ok(RL.QUEUED_ALPHA < RL.BORDER_ALPHA,
        'waiting must read as quieter than running');
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'execution', 'running-lines.js'), 'utf8');
    assert.ok(/borderStyle: 'dashed'/.test(src), 'dashed says "not yet" with no legend');
    assert.ok(/borderStyle: 'solid'/.test(src), 'and solid stays for the running cell');
});

t('queued cells are marked, and the running one is not among them', () => {
    reset();
    const a = makeEditor('cell:1', 4);
    const b = makeEditor('cell:2', 4);
    const c = makeEditor('cell:3', 4);
    visibleEditors = [a, b, c];
    RL.showRunning({ document: a.document }, { startLine: 0, endLine: 1 });
    RL.setQueued([{ document: b.document }, { document: c.document }]);
    const marked = new Set(painted().map(x => x.uri));
    assert.ok(marked.has('cell:2') && marked.has('cell:3'), 'both waiting cells are marked');
    assert.ok(marked.has('cell:1'), 'and the running one still has its own mark');
    RL.clearRunning(); RL.setQueued([]);
});

t('a cell in BOTH lists is drawn as running, not as queued', () => {
    // Running is the stronger and more specific claim.
    reset();
    const a = makeEditor('cell:1', 3);
    visibleEditors = [a];
    RL.showRunning({ document: a.document }, { startLine: 0, endLine: 0 });
    decoCalls.length = 0;
    RL.setQueued([{ document: a.document }]);
    const dashedUsed = painted().some(x => /dashed/.test((typesById.get(x.typeId) || {}).borderStyle || ''));
    assert.ok(!dashedUsed, 'the running cell must not also be outlined as waiting');
    RL.clearRunning(); RL.setQueued([]);
});

t('emptying the queue removes the dashed marks', () => {
    reset();
    const b = makeEditor('cell:2', 3);
    visibleEditors = [b];
    RL.setQueued([{ document: b.document }]);
    assert.ok(painted().length > 0, 'marked while waiting');
    decoCalls.length = 0;
    RL.setQueued([]);
    assert.strictEqual(painted().length, 0, 'and unmarked when the queue drains');
});

t('a finishing cell does not clear the rest of the queue', () => {
    // One cell finishing is not the queue emptying; they are separate calls for
    // exactly that reason.
    reset();
    const a = makeEditor('cell:1', 3);
    const b = makeEditor('cell:2', 3);
    visibleEditors = [a, b];
    RL.showRunning({ document: a.document }, { startLine: 0, endLine: 0 });
    RL.setQueued([{ document: b.document }]);
    decoCalls.length = 0;
    RL.clearRunning();
    assert.ok(painted().some(x => x.uri === 'cell:2'),
        'the cell still waiting keeps its mark');
    RL.setQueued([]);
});

t('turning the feature off marks nothing, queued included', () => {
    reset();
    config['wolfbook.notebook.highlightRunningLines'] = false;
    const b = makeEditor('cell:2', 3);
    visibleEditors = [b];
    RL.setQueued([{ document: b.document }]);
    assert.strictEqual(painted().length, 0);
});

t('the marks are driven from the QUEUE, not tracked beside it', () => {
    // One source of truth: a mark cannot then survive a path that forgot to
    // update it.
    const fs = require('fs');
    const path = require('path');
    const ctrl = fs.readFileSync(path.join(__dirname, '..', '..', 'controller.js'), 'utf8');
    const co = fs.readFileSync(path.join(__dirname, '..', '..', 'execution', 'checkout.js'), 'utf8');
    assert.ok(/setQueued\(this\.executionQueue\.pendingCells\(\)\)/.test(ctrl),
        'the controller reads the queue');
    assert.ok((co.match(/setQueued\(self\.executionQueue\.pendingCells\(\)\)/g) || []).length >= 2,
        'and checkout re-reads it when a cell starts AND when one ends');
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
    assert.strictEqual(decoCalls.length, 9,
        'the wash, the four running edges and the four queued edges are all emptied');
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
    assert.strictEqual(disposedTypes - before, 9,
        'the wash plus four running edges plus four queued edges');
});

RL.dispose();
console.log(`\n${pass} assertions passed`);
