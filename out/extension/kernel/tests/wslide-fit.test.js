'use strict';

// Headless tests for the .wslide layout/fit analysis and the two webview
// wires it rides on. Run: node out/extension/kernel/tests/wslide-fit.test.js
//
// The fit report exists to replace ~37 screenshot reads per session with ~90
// tokens of arithmetic, so the arithmetic has to be right. Every case below
// is a shape that actually occurred in the 2026-08-30 Tropea deck.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = require('../../tools/wslide-fit');

let pass = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ── fixtures ──────────────────────────────────────────────────────────────

/** Two-column slide: left column of text boxes, right column with a figure. */
function twoColSlide() {
    return {
        id: 's1', label: 'ABJM vs N=4', layout: 'column',
        children: [
            { id: 'title', type: 'heading', level: 2, content: 'ABJM vs N=4' },
            {
                id: 'row', type: 'container', layout: 'row', align: 'center',
                children: [
                    {
                        id: 'left', type: 'container', layout: 'column',
                        children: [
                            { id: 'punch', type: 'text', content: 'A' },
                            { id: 'hfun', type: 'text', content: 'B' },
                        ],
                    },
                    {
                        id: 'right', type: 'container', layout: 'column',
                        style: { width: '100%' },
                        children: [{ id: 'fig', type: 'image', src: 'f.png', w: 600, h: 400 }],
                    },
                ],
            },
        ],
    };
}

/** Measurement payload matching the field report's slide 31. */
function overflowMeasurement() {
    return {
        canvas: { w: 1920, h: 1080 },
        contentBottom: 1187,
        blocks: {
            title: { x: 0,    y: 0,   w: 1920, h: 80,   visible: true },
            row:   { x: 0,    y: 88,  w: 1920, h: 1099, visible: true },
            left:  { x: 0,    y: 88,  w: 1040, h: 1099, visible: true },
            punch: { x: 0,    y: 968, w: 1040, h: 136,  visible: true },
            hfun:  { x: 0,    y: 1112, w: 1040, h: 75,  visible: true },
            right: { x: 1080, y: 88,  w: 612,  h: 602,  visible: true },
            fig:   { x: 1080, y: 88,  w: 600,  h: 400,  visible: true,
                     natural: { w: 1200, h: 800 } },
        },
    };
}

// ── overflow arithmetic ───────────────────────────────────────────────────

console.log('computeFit — overflow');

t('reports the overflow in pixels, not just "something is cut off"', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    assert.strictEqual(fit.fits, false);
    assert.strictEqual(fit.contentBottom, 1187);
    assert.strictEqual(fit.overflow, 107);
});

t('distinguishes a clipped block from one fully out of frame', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    const punch = fit.recById.get('punch');   // y=968..1104, straddles 1080
    const hfun  = fit.recById.get('hfun');    // y=1112, starts past the canvas
    assert.ok(punch.clippedBottom && !punch.fullyOut, 'punch is clipped, not fully out');
    assert.ok(hfun.clippedBottom && hfun.fullyOut, 'hfun is fully out of frame');
});

t('treats the children of a top-level row as the columns', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    const ids = fit.columns.map(c => c.id);
    assert.ok(ids.includes('left') && ids.includes('right'), `got ${ids}`);
    assert.ok(!ids.includes('row'), 'the row itself is not a column');
});

t('a fitting slide reports fits:true and no hints', () => {
    const m = overflowMeasurement();
    m.contentBottom = 900;
    m.blocks.left.h = 812; m.blocks.row.h = 812;
    m.blocks.punch.y = 700; m.blocks.punch.h = 100;
    m.blocks.hfun.y = 810;  m.blocks.hfun.h = 80;
    const fit = F.computeFit(twoColSlide(), m);
    assert.strictEqual(fit.fits, true);
    assert.strictEqual(fit.hints.length, 0);
});

// ── the fit hint: closed-form rescale ────────────────────────────────────

console.log('rescaleHint — the arithmetic that replaces guessing');

t('scale is available/actual, floored so it cannot round back into overflow', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    const h = fit.hints.find(x => x.blockId === 'left');
    assert.ok(h, 'a hint for the overflowing column');
    // left: y=88, h=1099, no fixed-size leaf inside → (1080-88)/1099 = 0.9026
    assert.strictEqual(h.scale, 0.90);
    assert.ok(h.estBottom <= 1080, `est ${h.estBottom} must fit`);
    assert.ok(/fontSize: 0\.9em/.test(h.text), h.text);
});

t('an existing em fontSize is COMPOSED with, not reset', () => {
    const slide = twoColSlide();
    // The column has already been reduced once; a second pass must not
    // silently undo that by emitting a bare 0.90em.
    slide.children[1].children[0].style = { fontSize: '0.88em' };
    const fit = F.computeFit(slide, overflowMeasurement());
    const h = fit.hints.find(x => x.blockId === 'left');
    // 0.88 × 0.9026 = 0.794, which snaps DOWN to the 0.75 step.
    assert.ok(h.applied < 0.88, `must be smaller than the current size, got ${h.applied}`);
    assert.strictEqual(h.applied, 0.75);
    assert.ok(h.call.includes('0.75em'), h.call);
});

t('the hint snaps DOWN to a type-scale step, so one call is enough', () => {
    // The report suggested 0.96; the author tried 0.95 (+1px), then 0.94 (✓) —
    // two round trips lost to a value that only just fits. Snapping down to a
    // step means the first application provably fits.
    assert.strictEqual(F.snapDown(0.96, F.DEFAULT_TYPE_SCALE), 0.95);
    assert.strictEqual(F.snapDown(0.9026, F.DEFAULT_TYPE_SCALE), 0.9);
    assert.strictEqual(F.snapDown(0.999, F.DEFAULT_TYPE_SCALE), 0.95);
    // Below every step → the smallest, never undefined.
    assert.strictEqual(F.snapDown(0.1, F.DEFAULT_TYPE_SCALE), 0.6);
});

t('a snapped hint provably fits — never merely almost', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    for (const h of fit.hints) {
        if (h.kind !== 'rescale') continue;
        assert.ok(h.estBottom <= 1080, `${h.blockId} est ${h.estBottom} does not fit`);
    }
});

t('a deck may declare its own type scale', () => {
    const deck = { typeScale: [1, 0.9, 0.8], slides: [] };
    const fit = F.computeFit(twoColSlide(), overflowMeasurement(), { deck });
    const h = fit.hints.find(x => x.blockId === 'left');
    assert.ok([1, 0.9, 0.8].includes(h.applied), `off-scale value ${h.applied}`);
});

t('a size the deck already uses is preferred and said so', () => {
    // The anti-drift signal: reuse beats inventing a tenth font size.
    const deck = { slides: [{ id: 'x', children: [
        { id: 'a', type: 'text', style: { fontSize: '0.9em' } },
        { id: 'b', type: 'text', style: { fontSize: '0.9em' } },
    ] }] };
    const fit = F.computeFit(twoColSlide(), overflowMeasurement(), { deck });
    const h = fit.hints.find(x => x.blockId === 'left');
    assert.strictEqual(h.applied, 0.9);
    assert.ok(/already used on 2 other blocks/.test(h.text), h.text);
});

t('emSizesInUse counts every em size in the deck, most-used first', () => {
    const deck = { slides: [{ id: 'x', children: [
        { id: 'a', type: 'text', style: { fontSize: '0.9em' } },
        { id: 'b', type: 'container', children: [
            { id: 'c', type: 'text', style: { fontSize: '0.9em' } },
            { id: 'd', type: 'text', style: { fontSize: '0.75em' } },
        ] },
    ] }] };
    assert.deepStrictEqual(F.emSizesInUse(deck), [[0.9, 2], [0.75, 1]]);
});

t('when siblings both overflow, the hint targets their common parent', () => {
    // One value on the container is one call and no drift; per-sibling nudges
    // are how a deck ends up with nine font sizes nobody chose.
    const slide = { id: 's', children: [{
        id: 'row', type: 'container', layout: 'row',
        children: [
            { id: 'L', type: 'container', children: [] },
            { id: 'R', type: 'container', children: [] },
        ],
    }] };
    const m = { canvas: { w: 1920, h: 1080 }, contentBottom: 1300,
        blocks: {
            row: { x: 0, y: 80, w: 1920, h: 1220, visible: true },
            L:   { x: 0, y: 80, w: 900,  h: 1220, visible: true },
            R:   { x: 960, y: 80, w: 900, h: 1150, visible: true },
        } };
    const hints = F.computeFit(slide, m).hints;
    assert.strictEqual(hints.length, 1, 'one hint, not one per sibling');
    assert.strictEqual(hints[0].blockId, 'row');
    assert.deepStrictEqual(hints[0].coversSiblings.sort(), ['L', 'R']);
    assert.ok(/instead of 2 separate sibling edits/.test(hints[0].note), hints[0].note);
});

t('a single overflowing column is still targeted directly', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    assert.strictEqual(fit.hints.length, 1);
    assert.strictEqual(fit.hints[0].blockId, 'left');
});

t('fixed-size content is held OUT of the ratio', () => {
    // A column that is mostly a 400px image: scaling the font must not be
    // credited with shrinking the picture.
    const slide = {
        id: 's', children: [{
            id: 'col', type: 'container', layout: 'column',
            children: [
                { id: 'pic', type: 'image', src: 'a.png' },
                { id: 'cap', type: 'text', content: 'caption' },
            ],
        }],
    };
    const m = {
        canvas: { w: 1920, h: 1080 }, contentBottom: 1200,
        blocks: {
            col: { x: 0, y: 100, w: 900, h: 1100, visible: true },
            pic: { x: 0, y: 100, w: 900, h: 400,  visible: true },
            cap: { x: 0, y: 500, w: 900, h: 700,  visible: true },
        },
    };
    const h = F.computeFit(slide, m).hints[0];
    assert.strictEqual(h.fixedPx, 400);
    // flexible 700 must fit in (1080-100-400)=580 → 0.828, NOT 980/1100=0.89.
    // Snapped down to the 0.8 step.
    assert.strictEqual(h.applied, 0.8);
    assert.ok(h.estBottom <= 1080, `est ${h.estBottom}`);
    // The naive ratio would have been 0.89, which does NOT fit here.
    assert.ok(h.applied < 0.89, 'the fixed 400px must not be credited to font scaling');
});

t('a column dominated by fixed content says font scaling will not help', () => {
    const slide = {
        id: 's', children: [{
            id: 'col', type: 'container', layout: 'column',
            children: [{ id: 'pic', type: 'image', src: 'a.png' }],
        }],
    };
    const m = {
        canvas: { w: 1920, h: 1080 }, contentBottom: 1300,
        blocks: {
            col: { x: 0, y: 100, w: 900, h: 1200, visible: true },
            pic: { x: 0, y: 100, w: 900, h: 1200, visible: true },
        },
    };
    const h = F.computeFit(slide, m).hints[0];
    assert.strictEqual(h.kind, 'fixed_dominated');
    assert.ok(/will not help/.test(h.text), h.text);
    assert.ok(!h.call, 'must not emit a patchBlock call that cannot work');
});

t('a rescale below the readability floor says split the slide instead', () => {
    const slide = { id: 's', children: [{ id: 'col', type: 'container', children: [] }] };
    const m = {
        canvas: { w: 1920, h: 1080 }, contentBottom: 3000,
        blocks: { col: { x: 0, y: 80, w: 900, h: 2920, visible: true } },
    };
    const h = F.computeFit(slide, m).hints[0];
    assert.strictEqual(h.kind, 'below_floor');
    assert.ok(/Split the slide/.test(h.text), h.text);
});

// ── measured notes ────────────────────────────────────────────────────────

console.log('computeFit — measured notes');

t('detects a shrink-wrapped column and names alignItems as the cause', () => {
    // right declares width:100% but measures 612 of the 1040 its sibling gets,
    // because the parent row has align:center. Cost three slides in the field
    // report before the pattern was recognised.
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    const n = fit.notes.find(x => x.blockId === 'right' && x.kind === 'shrink_wrapped');
    assert.ok(n, `expected a shrink_wrapped note, got ${JSON.stringify(fit.notes)}`);
    assert.ok(/alignItems:"center"/.test(n.cause), n.cause);
    assert.ok(/align:"stretch"/.test(n.fix), n.fix);
});

t('the measured note fires for the browser-verified shape', () => {
    // Same tree as the browser harness, with the numbers it actually produced.
    const slide = { id: 's', children: [{
        id: 'col', type: 'container', layout: 'column', align: 'center',
        children: [{ id: 'wide', type: 'raw', content: '<div style="width:100%">f</div>' }],
    }] };
    const m = { canvas: { w: 1920, h: 1080 }, contentBottom: 400,
        blocks: {
            col:  { x: 0, y: 0, w: 573, h: 400, visible: true },
            wide: { x: 0, y: 0, w: 300, h: 400, visible: true },
        } };
    const n = F.computeFit(slide, m).notes.find(x => x.kind === 'shrink_wrapped');
    assert.ok(n, 'measured 300 of 573 must be reported');
    assert.ok(/w=300 of 573/.test(n.detail), n.detail);
});

t('does not cry shrink-wrap when the parent stretches', () => {
    const slide = twoColSlide();
    slide.children[1].align = 'stretch';
    const fit = F.computeFit(slide, overflowMeasurement());
    assert.strictEqual(fit.notes.filter(n => n.kind === 'shrink_wrapped').length, 0);
});

t('flags a drawn aspect ratio the source cannot support', () => {
    const slide = twoColSlide();
    const m = overflowMeasurement();
    m.blocks.fig = { x: 1080, y: 88, w: 50, h: 481, visible: true,
                     natural: { w: 1024, h: 1024 } };
    const n = F.computeFit(slide, m).notes.find(x => x.kind === 'aspect_distorted');
    assert.ok(n, 'a 50x481 draw from a 1024x1024 source is a vertical smear');
    assert.ok(/0\.10/.test(n.detail) && /1\.00/.test(n.detail), n.detail);
});

// ── static lints (no render needed) ───────────────────────────────────────

console.log('lintSlide — static checks');

t('alignItems:center + child width:100% is caught without measuring', () => {
    const l = F.lintSlide(twoColSlide());
    const hit = l.find(x => x.rule === 'shrinkwrap_risk' && x.blockId === 'right');
    assert.ok(hit, `got ${JSON.stringify(l)}`);
    assert.ok(/align:"stretch"/.test(hit.fix), hit.fix);
});

t('alignItems:stretch is not flagged', () => {
    const s = twoColSlide();
    s.children[1].align = 'stretch';
    assert.strictEqual(F.lintSlide(s).filter(x => x.rule === 'shrinkwrap_risk').length, 0);
});

t('the width:100% may be a DESCENDANT, not a direct child', () => {
    // Measured in a real browser (Experiments/wslide-fit/check-measure.mjs):
    // a 100%-wide element inside an align:center column came out 300px of 573.
    // The declaration was two levels down, inside a raw block's markup.
    const s = { id: 's', children: [{
        id: 'col', type: 'container', layout: 'column', align: 'center',
        children: [{ id: 'wrap', type: 'container', children: [
            { id: 'wide', type: 'raw', content: '<div style="width:100%">fig</div>' },
        ] }],
    }] };
    const hit = F.lintSlide(s).find(x => x.rule === 'shrinkwrap_risk');
    assert.ok(hit, 'a nested width:100% under align:center must still be caught');
    assert.ok(/align:"stretch"/.test(hit.fix), hit.fix);
});

t('width:100% written into raw markup is caught', () => {
    assert.ok(F.wantsFullWidth({ type: 'raw', content: '<svg style="width: 100%"></svg>' }));
    assert.strictEqual(F.wantsFullWidth({ type: 'text', content: 'no width here' }), null);
});

t('style.alignItems is honoured as well as the align shorthand', () => {
    const s = twoColSlide();
    delete s.children[1].align;
    s.children[1].style = { alignItems: 'flex-start' };
    assert.ok(F.lintSlide(s).some(x => x.rule === 'shrinkwrap_risk'));
});

console.log('aspectWarning');

t('warns past the 10% tolerance and stays quiet inside it', () => {
    assert.ok(F.aspectWarning({ id: 'a', w: 50, h: 481 }, { w: 1024, h: 1024 }));
    assert.strictEqual(F.aspectWarning({ id: 'a', w: 500, h: 505 }, { w: 1024, h: 1024 }), null);
});

t('suggests the height that restores the source ratio', () => {
    const w = F.aspectWarning({ id: 'a', w: 400, h: 900 }, { w: 800, h: 400 });
    assert.ok(/\{w:400, h:200\}/.test(w), w);
});

t('says nothing without both dimensions — a free height is not a distortion', () => {
    assert.strictEqual(F.aspectWarning({ id: 'a', w: 400 }, { w: 800, h: 400 }), null);
});

// ── citation extraction ───────────────────────────────────────────────────

// ── math lint ─────────────────────────────────────────────────────────────
//
// The class: markup that is syntactically valid, renders without error, and
// means something other than it appears to. Every other check in this file
// passes on it — the JSON looks right, fit is ✓, KaTeX raises nothing, and the
// block tree shows no sign. Only a human reading the slide catches it.

console.log('lintMathContent — \\color is a switch, not a scope');

t('reports the bleed, naming what ELSE got coloured', () => {
    // Verbatim from the field report's slide 17: the intent was to mark the
    // maximal-transcendentality term; the switch also took the QCD-only n_f/N_c
    // term and χ(γ), which changed the physics the slide asserts.
    const c = '$\\color{#008800}{-\\frac{\\pi^2}{3}}-\\frac{10}{9}\\frac{n_f}{N_c}\\chi(\\gamma)$';
    const [l] = F.lintMathContent(c, 'b1');
    assert.strictEqual(l.rule, 'color_switch');
    assert.strictEqual(l.severity, 'error');
    assert.ok(/n_f/.test(l.detail), `the bleed must be named: ${l.detail}`);
    assert.ok(/textcolor/.test(l.fix), l.fix);
});

t('\\textcolor is correctly scoped and must NOT be flagged', () => {
    const c = '$\\textcolor{#008800}{-\\frac{\\pi^2}{3}}-\\frac{10}{9}$';
    assert.deepStrictEqual(F.lintMathContent(c, 'b'), []);
});

t('a switch that reaches a group boundary is warned, not passed', () => {
    // Slides 6 and 16 of that deck render acceptably only because the enclosing
    // group ends immediately — correct BY LUCK, which is the profile of a latent
    // bug: appending to the group silently recolours the addition.
    const c = '$x + {\\color{red}{y}}$';
    const [l] = F.lintMathContent(c, 'b');
    assert.strictEqual(l.severity, 'warn');
    assert.ok(/only because/.test(l.detail), l.detail);
});

t('the bleed stops at the enclosing group, not the end of the string', () => {
    const c = '$a{\\color{red}{b}c}d$';
    const [l] = F.lintMathContent(c, 'b');
    assert.ok(/ALSO coloured: "c"/.test(l.detail), l.detail);
    assert.ok(!/d/.test(l.detail.split('ALSO coloured')[1]), 'd is outside the group');
});

t('\\colorbox and \\pagecolor are not \\color', () => {
    assert.deepStrictEqual(F.lintMathContent('$\\colorbox{red}{x} + y$', 'b'), []);
});

t('several switches in one expression are each reported', () => {
    const c = '$\\color{red}{a}b$ and $\\color{blue}{c}d$';
    assert.strictEqual(F.lintMathContent(c, 'b').length, 2);
});

t('an unescaped % inside math is flagged — it comments out the rest', () => {
    const [l] = F.lintMathContent('$x = 50% of y$', 'b');
    assert.strictEqual(l.rule, 'math_comment');
    assert.strictEqual(l.severity, 'error');
});

t('an escaped \\% is fine, and % OUTSIDE math is untouched', () => {
    assert.deepStrictEqual(F.lintMathContent('$x = 50\\% of y$', 'b'), []);
    assert.deepStrictEqual(F.lintMathContent('<div style="width:100%">$x$</div>', 'b'), []);
});

t('matchBrace skips escaped braces', () => {
    const s = '{a\\}b}';
    assert.strictEqual(F.matchBrace(s, 0), 5);
});

t('lintSlide surfaces math problems from block content and list items', () => {
    const slide = { id: 's', children: [
        { id: 'txt',  type: 'text', content: 'see $\\color{red}{a}b$' },
        { id: 'lst',  type: 'list', items: [{ id: 'i1', type: 'text', content: '$\\color{red}{c}d$' }] },
    ] };
    const hits = F.lintSlide(slide).filter(l => l.rule === 'color_switch');
    assert.strictEqual(hits.length, 2, JSON.stringify(hits));
    assert.deepStrictEqual(hits.map(h => h.blockId).sort(), ['i1', 'txt']);
});

t('error lints are all shown in a footer; advisory ones are capped', () => {
    const lints = [
        { blockId: 'a', rule: 'color_switch', severity: 'error', detail: 'x', fix: 'f' },
        { blockId: 'b', rule: 'color_switch', severity: 'error', detail: 'y' },
        { blockId: 'c', rule: 'shrinkwrap_risk', detail: '1' },
        { blockId: 'd', rule: 'shrinkwrap_risk', detail: '2' },
        { blockId: 'e', rule: 'shrinkwrap_risk', detail: '3' },
    ];
    const lines = F.lintFooterLines(lints).join('\n');
    assert.ok(/🔴.*#a/.test(lines) && /🔴.*#b/.test(lines), 'every error lint must appear');
    assert.ok(/and 1 more advisory/.test(lines), 'advisory lints are capped and counted');
});

console.log('extractCitations');

const citeDeck = {
    slides: [
        { id: 's1', label: 'Cusp', children: [
            { id: 'payoff', type: 'text',
              content: 'The cusp anomalous dimension [Gromov, Levkovich-Maslyuk, arXiv:1510.01085]' },
        ] },
        { id: 's2', label: 'Fishnet', children: [
            { id: 'f1', type: 'text',
              content: 'Fishnet integrability [Gromov, Kazakov, Korchemsky; 1706.04167; 1808.02688]' },
            { id: 'f2', type: 'text', content: 'Older work hep-th/9711200 by Maldacena.' },
        ] },
    ],
};

t('finds new-style and old-style arXiv ids across the deck', () => {
    const c = F.extractCitations(citeDeck);
    const ids = c.map(x => x.arxivId).sort();
    assert.deepStrictEqual(ids, ['1510.01085', '1706.04167', '1808.02688', 'hep-th/9711200']);
});

t('records the slide and block each citation sits in', () => {
    const c = F.extractCitations(citeDeck).find(x => x.arxivId === '1706.04167');
    assert.strictEqual(c.slide, 2);
    assert.strictEqual(c.blockId, 'f1');
});

t('strips version suffixes so 1510.01085v2 resolves like the base id', () => {
    const d = { slides: [{ id: 's', children: [{ id: 'b', type: 'text', content: 'arXiv:1510.01085v2' }] }] };
    assert.strictEqual(F.extractCitations(d)[0].arxivId, '1510.01085');
});

t('picks up the surnames next to the id', () => {
    const c = F.extractCitations(citeDeck).find(x => x.arxivId === '1510.01085');
    assert.ok(c.names.includes('Gromov'), c.names.join(','));
});

t('ignores journal abbreviations and sentence openers as names', () => {
    const n = F.surnamesIn('See Phys. Rev. Lett. 115 and the New results by Gromov');
    assert.ok(!n.includes('Phys') && !n.includes('Rev') && !n.includes('Lett'), n.join(','));
    assert.ok(!n.includes('See') && !n.includes('New'), n.join(','));
    assert.ok(n.includes('Gromov'), n.join(','));
});

t('reads content out of list items too', () => {
    const d = { slides: [{ id: 's', children: [
        { id: 'l', type: 'list', items: [{ type: 'text', content: 'see 2312.11604' }] },
    ] }] };
    assert.strictEqual(F.extractCitations(d)[0].arxivId, '2312.11604');
});

console.log('authorVerdict — the check that catches a transposed id');

t('no cited name on the record is a mismatch', () => {
    // The real case: arXiv:1510.01085 cited for a cusp paper resolves to a
    // neutron reflectometry article. Nothing else in the toolchain sees this.
    const v = F.authorVerdict(['Gromov', 'Levkovich-Maslyuk'], ['Smith, John', 'Doe, Jane']);
    assert.strictEqual(v.status, 'mismatch');
});

t('one surname in common is enough to pass', () => {
    const v = F.authorVerdict(['Gromov', 'Preti'], ['Gromov, Nikolay', 'Kazakov, Vladimir']);
    assert.strictEqual(v.status, 'ok');
    assert.deepStrictEqual(v.matched, ['Gromov']);
});

t('a cited name absent from the record is reported even when others match', () => {
    // "Cavaglià, Gromov, Julius, Preti" where Julius is not an author.
    const v = F.authorVerdict(['Cavaglia', 'Gromov', 'Julius'], ['Gromov, Nikolay', 'Cavaglia, Andrea']);
    assert.strictEqual(v.status, 'ok');
    assert.deepStrictEqual(v.missing, ['Julius']);
});

t('an empty author list is unknown, not a mismatch', () => {
    assert.strictEqual(F.authorVerdict(['Gromov'], []).status, 'unknown');
});

t('lastName handles both "Surname, Given" and "Given Surname"', () => {
    assert.strictEqual(F.lastName('Gromov, Nikolay'), 'Gromov');
    assert.strictEqual(F.lastName('Nikolay Gromov'), 'Gromov');
});

// ── report rendering ──────────────────────────────────────────────────────

console.log('formatFitReport / fitLine');

t('the report names the block, the overflow and the fix', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    const txt = F.formatFitReport(twoColSlide(), 31, fit, F.lintSlide(twoColSlide()));
    assert.ok(/OVERFLOW \+107px/.test(txt), txt);
    assert.ok(/#hfun/.test(txt) && /FULLY OUT OF FRAME/.test(txt), txt);
    assert.ok(/fit hint/.test(txt), txt);
});

t('the whole report stays far under one screenshot', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    const txt = F.formatFitReport(twoColSlide(), 31, fit, F.lintSlide(twoColSlide()));
    // A JPEG read is ~1100-1600 tokens; ~4 chars/token puts the budget at
    // ~4400 chars. The report must be an order of magnitude smaller or its
    // whole reason for existing is gone.
    assert.ok(txt.length < 1200, `report is ${txt.length} chars`);
});

t('fitLine is a single line and marks overflow', () => {
    const fit = F.computeFit(twoColSlide(), overflowMeasurement());
    const line = F.fitLine(fit);
    assert.ok(!line.includes('\n'), line);
    assert.ok(/⚠ \+107px/.test(line), line);
});

t('fitLine on a fitting slide flags large unused space', () => {
    const m = overflowMeasurement();
    m.contentBottom = 500;
    const line = F.fitLine(F.computeFit(twoColSlide(), m));
    assert.ok(/✓/.test(line) && /unused/.test(line), line);
});

// ── webview wires ─────────────────────────────────────────────────────────
//
// Both failure classes below are SILENT: a postMessage nobody handles, or a
// measurement that quietly reports pre-KaTeX boxes. Guard them here.

console.log('webview wiring');

const WEBVIEW = path.join(__dirname, '..', '..', '..', '..', 'media', 'wslide-editor.html');
const PROVIDER = path.join(__dirname, '..', '..', 'slideEditorProvider.js');

t('every message the webview posts has a handler in the provider', () => {
    // A postMessage name that one side sends and the other does not handle
    // fails SILENTLY — the feature simply does nothing, with no error anywhere.
    // Check parity across the whole surface rather than one name, so a typo in
    // any single occurrence (e.g. only the error path) is still caught.
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const prov = fs.readFileSync(PROVIDER, 'utf8');
    const sent = new Set();
    for (const m of html.matchAll(/vscodeApi\.postMessage\(\s*\{\s*cmd:\s*'([a-zA-Z]+)'/g)) sent.add(m[1]);
    assert.ok(sent.has('measureResult'), 'measureResult must be among the posted messages');
    const unhandled = [...sent].filter(c => !new RegExp(`case '${c}'`).test(prov));
    assert.deepStrictEqual(unhandled, [], `webview posts these with no provider handler: ${unhandled}`);
});

t('every message the provider posts has a handler in the webview', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const prov = fs.readFileSync(PROVIDER, 'utf8');
    const sent = new Set();
    for (const m of prov.matchAll(/webview\.postMessage\(\s*\{\s*cmd:\s*'([a-zA-Z]+)'/g)) sent.add(m[1]);
    assert.ok(sent.has('measure'), 'the provider must post cmd:measure');
    // *Ack replies to a _vscRequest are resolved by request id through the
    // generic _vscPending branch, so they legitimately have no named handler.
    assert.ok(/_vscPending\[msg\.id\]/.test(html), 'the generic request-id reply branch must exist');
    const unhandled = [...sent]
        .filter(c => !/Ack$/.test(c))
        .filter(c => !new RegExp(`msg\\.cmd === '${c}'|case '${c}'`).test(html));
    assert.deepStrictEqual(unhandled, [], `provider posts these with no webview handler: ${unhandled}`);
});

t('measurement is off-screen — it must not move the visible slide', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const fn = html.slice(html.indexOf('async function measureSlideOffscreen'));
    const body = fn.slice(0, fn.indexOf('\nfunction applyContainerLayout'));
    assert.ok(body.length > 200, 'measureSlideOffscreen not found');
    assert.ok(!/\bslideIdx\s*=/.test(body),
        'measureSlideOffscreen must never assign slideIdx — that flashes the editor');
    assert.ok(!/renderSlide\(\)/.test(body),
        'measureSlideOffscreen must not call renderSlide — it builds its own stage');
    assert.ok(/position:fixed;left:-100000px/.test(body),
        'the stage must be laid out off-screen, not display:none (which yields zero boxes)');
});

t('measurement waits for KaTeX and image decode before reading boxes', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const fn = html.slice(html.indexOf('async function measureSlideOffscreen'));
    const body = fn.slice(0, fn.indexOf('\nfunction applyContainerLayout'));
    assert.ok(/renderMathInElement/.test(body), 'math changes heights; typeset before measuring');
    assert.ok(/decode\(\)/.test(body), 'an undecoded image contributes no height');
    assert.ok(/requestAnimationFrame/.test(body), 'measure after layout has settled');
});

t('the stage is always removed, even when measurement throws', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const fn = html.slice(html.indexOf('async function measureSlideOffscreen'));
    const body = fn.slice(0, fn.indexOf('\nfunction applyContainerLayout'));
    assert.ok(/finally\s*\{\s*stage\.remove\(\);/.test(body),
        'a leaked stage accumulates a hidden 1920x1080 render per call');
});

t('a provider deck push cancels the pending autosave', () => {
    // Field report §2b: insertSlide reported success for a slide that the next
    // listSlides did not have. An autosave carrying the pre-insert deck can
    // land after the write and silently undo it.
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const i = html.indexOf("msg.cmd === 'deckUpdate'");
    assert.ok(i > 0, 'deckUpdate handler not found');
    const body = html.slice(i, i + 2500);
    assert.ok(/clearTimeout\(_autoSaveTimer\)/.test(body),
        'deckUpdate must cancel the pending autosave — otherwise it races the write');
});

// ── renderer parity ───────────────────────────────────────────────────────
//
// The editor has THREE code paths that turn a slide into DOM: the canvas, the
// thumbnail panel, and the off-screen measurement stage. Each drift between
// them is a bug where one view disagrees with another — thumbnails showed raw
// LaTeX for months because only the canvas ran KaTeX.

console.log('renderer parity');

function rendererBody(name) {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const i = html.indexOf(name);
    assert.ok(i > 0, `${name} not found`);
    return html.slice(i, i + 3200);
}

for (const r of ['function renderSlide()', 'function renderThumbContent(', 'async function measureSlideOffscreen']) {
    t(`${r.replace(/function |\(\)|\(/g, '').trim()} typesets math`, () => {
        assert.ok(/renderMathInElement/.test(rendererBody(r)),
            'a renderer that skips KaTeX shows raw $…$ where the others show a formula');
    });
    t(`${r.replace(/function |\(\)|\(/g, '').trim()} applies the slide font scale`, () => {
        assert.ok(/resolveSlideScale/.test(rendererBody(r)),
            'skipping the scale renders the slide at a different size than the canvas');
    });
    t(`${r.replace(/function |\(\)|\(/g, '').trim()} uses the shared renderBlock`, () => {
        assert.ok(/renderBlock\(/.test(rendererBody(r)),
            'a second block renderer would drift from what actually ships');
    });
}

// ── inline rich editor ────────────────────────────────────────────────────

console.log('inline rich editor');

t('the editor shows the block’s real colour, not a substituted one', () => {
    const b = rendererBody('function startInlineEdit(');
    assert.ok(/getComputedStyle\(dom\)\.color/.test(b),
        'the colour must come from the rendered element — most blocks inherit it and carry no block.color');
    assert.ok(/_editorTextColor = _textColor/.test(b),
        'the editor must render text in the colour the slide uses (WYSIWYG)');
});

t('the dark editor panel is actually reachable', () => {
    // It was not: _editorBgForBlock returned '#ffffff' for light text, so the
    // '#1a2035' comparison below it never matched and white slide text was
    // always drawn near-black — which any edit then baked into the deck.
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const i = html.indexOf('function _editorBgForBlock');
    const body = html.slice(i, html.indexOf('function startInlineEdit'));
    assert.ok(/return\s+txtLum\s*>\s*[\d.]+\s*\?\s*'#1a2035'/.test(body),
        'light text must select the DARK panel');
});

t('commit strips the chrome the editor imposed', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    assert.ok(/_editorChrome = \{ color: _textColor, basePx: _renderedBase \}/.test(html),
        'the editor must record what it imposes so commit can strip exactly that');
    const commit = html.slice(html.indexOf('function commitInlineEdit()'));
    const body = commit.slice(0, commit.indexOf('\nfunction '));
    assert.ok(/_stripEditorChrome\(ce\.innerHTML\)/.test(body),
        'rich-mode commit must strip before sanitizing, or the editor colour reaches the deck');
});

t('inline font sizing is relative, so a later container rescale still reaches it', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const i = html.indexOf('function _applyFontSize(');
    const body = html.slice(i, i + 1600);
    assert.ok(/_emForPx\(px\)/.test(body), 'must convert to em');
    assert.ok(!/fontSize\s*=\s*px \+ 'px'/.test(body),
        'absolute px pins the run against the container-level scaling the fit hints recommend');
});

// ── screenshot capture ────────────────────────────────────────────────────

console.log('screenshot capture');

t('capture restores the canvas zoom by recomputing it', () => {
    // Replaying a saved inline transform breaks when two captures overlap: the
    // second saves the already-cleared value and restores THAT, leaving the
    // slide blown up until something else happened to call fitCanvas().
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const i = html.indexOf("if (msg.cmd === 'screenshot')");
    const body = html.slice(i, html.indexOf("if (msg.cmd === 'serializeDeck')"));
    assert.ok(!/savedTransform/.test(body), 'must not replay a saved inline transform');
    assert.ok(/fitCanvas\(\)/.test(body), 'must recompute the zoom via the single authority');
    assert.ok(/\} finally \{[\s\S]{0,200}restore\(\);/.test(body),
        'restore must run even when html2canvas throws on an unexpected line');
});

t('overlapping captures are refused rather than corrupting the zoom', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const i = html.indexOf("if (msg.cmd === 'screenshot')");
    const body = html.slice(i, html.indexOf("if (msg.cmd === 'serializeDeck')"));
    assert.ok(/if \(_capturing\)/.test(body), 'a second concurrent capture must be refused');
    assert.ok(/_capturing = false/.test(body), 'and the flag must always be cleared');
});

// ── KaTeX delimiters in EMITTED JavaScript ────────────────────────────────
//
// The exporter writes its delimiter list into the exported file as JavaScript
// SOURCE. Hand-writing it lost one level of escaping: the file contained
// {left:'\('}, and a JS engine reads '\(' as '(' because \( is not a valid
// escape. Bare parentheses AND bare square brackets then became inline-math
// delimiters in every exported HTML and every PDF — "(divergent!)" was typeset
// as italic maths with the parens eaten, and every "[Author, Journal (Year)]"
// citation went the same way. Nothing threw, and the editor looked correct
// because it uses the values directly instead of emitting them.

console.log('exported KaTeX delimiters');

const EXPORTER = path.join(__dirname, '..', '..', 'slideExporter.js');

t('the emitted delimiter list evaluates to \\\\( and \\\\[, never bare ( or [', () => {
    const src = fs.readFileSync(EXPORTER, 'utf8');
    const m = src.match(/const KATEX_DELIMITERS = (\[[\s\S]*?\]);/);
    assert.ok(m, 'KATEX_DELIMITERS must be defined as data');
    const delims = eval(m[1]);
    // What a browser reading the EMITTED file would see.
    const emitted = JSON.stringify(delims);
    const roundTripped = JSON.parse(emitted);
    const lefts = roundTripped.map(d => d.left);
    assert.ok(!lefts.includes('('), 'a bare "(" delimiter turns every parenthesis into maths');
    assert.ok(!lefts.includes('['), 'a bare "[" delimiter turns every citation into maths');
    assert.ok(lefts.includes('\\('), `expected an escaped \\( delimiter, got ${JSON.stringify(lefts)}`);
    assert.ok(lefts.includes('\\['), `expected an escaped \\[ delimiter, got ${JSON.stringify(lefts)}`);
    assert.ok(lefts.includes('$') && lefts.includes('$$'), 'real maths must still be delimited');
});

t('the delimiter list is defined ONCE per file, never repeated inline', () => {
    // Counting backslashes by hand is what produced the bug. Exactly one
    // definition per file is allowed — the shared constant; every other use
    // must reference it.
    for (const [f, name] of [[EXPORTER, 'KATEX_DELIMITERS'], [WEBVIEW, 'KATEX_DELIMS']]) {
        const src = fs.readFileSync(f, 'utf8');
        const literals = (src.match(/left:\s*'\\+\[/g) || []).length;
        assert.strictEqual(literals, 1,
            `${path.basename(f)} has ${literals} delimiter literals; expected exactly 1 (the ${name} definition)`);
        assert.ok(new RegExp(`const ${name} = \\[`).test(src), `${name} must be that one definition`);
    }
});

t('every exporter emission goes through the helper', () => {
    const src = fs.readFileSync(EXPORTER, 'utf8');
    // Emission sites are the ones inside a template literal; the comment that
    // explains the bug is not one, so match only code lines.
    const lines = src.split('\n').filter(l => /delimiters:/.test(l) && !/^\s*\/\//.test(l));
    assert.ok(lines.length >= 3, `expected at least 3 emission sites, found ${lines.length}`);
    for (const l of lines) {
        assert.ok(/katexDelimitersJS\(\)/.test(l) || /delimiters:`,?$/.test(l.trim()),
            `hand-written delimiter emission: ${l.trim().slice(0, 90)}`);
    }
});

// ── requestAnimationFrame discipline ──────────────────────────────────────

console.log('rAF discipline');

t('no load-bearing path awaits a bare requestAnimationFrame', () => {
    // VS Code throttles rAF in a webview that is not the visible tab. Anything
    // that must COMPLETE — a capture, a measurement, typesetting — silently
    // never runs there. This was the mechanism behind "8 straight screenshot
    // timeouts, then spontaneous recovery": doCapture never started at all.
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const offenders = [];
    // Slice each region by its real END marker — a fixed-length window silently
    // stopped short of the screenshot handler's rAF and the guard passed while
    // the defect was present.
    for (const [fn, from, to] of [
        ['screenshot handler', "if (msg.cmd === 'screenshot')", "if (msg.cmd === 'serializeDeck')"],
        ['renderSlide', 'function renderSlide()', 'function resolveSlideScale'],
        ['renderThumbContent', 'function renderThumbContent(', 'Structural hash to detect'],
        ['measureSlideOffscreen', 'async function measureSlideOffscreen', '\nfunction applyContainerLayout'],
    ]) {
        const i = html.indexOf(from), j = html.indexOf(to, i);
        assert.ok(i > 0, `${fn}: start marker not found`);
        assert.ok(j > i, `${fn}: end marker not found — the guard would scan the wrong region`);
        const body = html.slice(i, j);
        // A bare rAF used as the ONLY continuation. Positioning/painting work
        // that no one waits on is fine; scheduling real work is not.
        if (/requestAnimationFrame\((?:\(\)\s*=>|doCapture|async)/.test(body)) offenders.push(fn);
    }
    assert.deepStrictEqual(offenders, [],
        `these schedule work on a bare rAF: ${offenders.join(', ')} — use _settleFrame()`);
});

t('_settleFrame falls back to a timer', () => {
    const html = fs.readFileSync(WEBVIEW, 'utf8');
    const i = html.indexOf('function _settleFrame()');
    assert.ok(i > 0, '_settleFrame must exist');
    const body = html.slice(i, i + 500);
    assert.ok(/requestAnimationFrame\(fin\)/.test(body) && /setTimeout\(fin/.test(body),
        'it must race the frame against a timer, or it is just a rAF with extra steps');
});

// ── helpers ───────────────────────────────────────────────────────────────

console.log('helpers');

t('parseEm reads em and bare numbers, rejects px', () => {
    assert.strictEqual(F.parseEm('0.88em'), 0.88);
    assert.strictEqual(F.parseEm('0.9'), 0.9);
    assert.strictEqual(F.parseEm(0.75), 0.75);
    assert.strictEqual(F.parseEm('32px'), null);
    assert.strictEqual(F.parseEm(undefined), null);
});

t('isFixedHeight covers images, eval output and pinned pixel heights', () => {
    assert.ok(F.isFixedHeight({ type: 'image' }));
    assert.ok(F.isFixedHeight({ type: 'eval' }));
    assert.ok(F.isFixedHeight({ type: 'text', h: 300 }));
    assert.ok(!F.isFixedHeight({ type: 'text' }));
});

t('kidsOf accepts children, items and elements', () => {
    assert.strictEqual(F.kidsOf({ children: [1] }).length, 1);
    assert.strictEqual(F.kidsOf({ items: [1, 2] }).length, 2);
    assert.strictEqual(F.kidsOf({ elements: [1, 2, 3] }).length, 3);
    assert.strictEqual(F.kidsOf(null).length, 0);
});

t('computeFit tolerates a measurement for a block that has been deleted', () => {
    const m = overflowMeasurement();
    m.blocks.ghost = { x: 0, y: 0, w: 10, h: 10, visible: true };
    assert.doesNotThrow(() => F.computeFit(twoColSlide(), m));
});

t('computeFit tolerates an empty measurement', () => {
    const fit = F.computeFit(twoColSlide(), {});
    assert.strictEqual(fit.contentBottom, 0);
    assert.strictEqual(fit.fits, true);
});

console.log(`\n${pass} assertions passed`);
