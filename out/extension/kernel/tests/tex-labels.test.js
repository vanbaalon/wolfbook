// The label overlay: the .aux reader and the chip placement rules.
//
//   node out/extension/kernel/tests/tex-labels.test.js
//
// WHAT IS ACTUALLY BEING ASSERTED. Placing a chip is a geometric argument about
// SyncTeX rows, and the load-bearing claim is that an equation's chip belongs on
// the row `dropStrayRows` THROWS AWAY — the narrow one, flush right, which is
// the printed number. That claim is measurable without a compiler, a webview or
// a kernel, so it is measured here rather than looked at on a screenshot.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const { parseAux, readAuxLabels, cleanPrinted } = require('../../tex/auxLabels');
const {
    buildLabelChips, splitStrayRows, formatLabelCopy, altFormat, blockOf,
} = require('../../tex/labelChips');
const {
    parseToc, readTocNumbers, normalizeTocTitle, sectionTitleSource,
} = require('../../tex/auxLabels');
const { scanTex } = require('../../tex/texScanner');
const { buildModel } = require('../../tex/texModel');

// --- the .aux ---------------------------------------------------------------

test('\\newlabel gives the printed number and the page', () => {
    const { labels } = parseAux(
        '\\newlabel{eq:foo}{{(4)}{7}{}{equation.0.4}{}}\n' +
        '\\newlabel{sec:intro}{{2.1}{3}{Introduction}{section.2.1}{}}\n');
    assert.strictEqual(labels.get('eq:foo').printed, '(4)');
    assert.strictEqual(labels.get('eq:foo').page, 7);
    assert.strictEqual(labels.get('sec:intro').printed, '2.1');
    assert.strictEqual(labels.get('sec:intro').page, 3);
});

test('\\bibcite gives a citation its printed number', () => {
    const { cites } = parseAux('\\bibcite{smith2020}{21}\n');
    assert.strictEqual(cites.get('smith2020').printed, '21');
});

test('A TRUNCATED .aux KEEPS WHAT IT ALREADY READ', () => {
    // We read the file while latexmk may still be writing it. Throwing, or
    // returning nothing, would lose every number on the page for one unlucky
    // moment; stopping at the damage keeps the rest.
    const { labels } = parseAux(
        '\\newlabel{eq:a}{{(1)}{1}{}{equation.0.1}{}}\n' +
        '\\newlabel{eq:b}{{(2)}{2}{}{equa');
    assert.strictEqual(labels.get('eq:a').printed, '(1)');
    assert.ok(!labels.has('eq:b'), 'the half-written one is simply absent');
});

test('hyperref\'s @cref twin does not shadow the real label', () => {
    const { labels } = parseAux(
        '\\newlabel{eq:foo}{{(4)}{7}{}{equation.0.4}{}}\n' +
        '\\newlabel{eq:foo@cref}{{[equation][4][]4}{7}}\n');
    assert.strictEqual(labels.size, 1);
    assert.strictEqual(labels.get('eq:foo').printed, '(4)');
});

test('a number wrapped in TeX still reads as a number', () => {
    assert.strictEqual(cleanPrinted('{\\bf 4}'), '4');
    assert.strictEqual(cleanPrinted('\\relax 2.1'), '2.1');
});

test('readAuxLabels follows \\@input one level down', () => {
    const files = {
        '/out/main.aux': '\\@input{sec/intro.aux}\n\\newlabel{eq:top}{{(1)}{1}{}{}{}}\n',
        '/out/sec/intro.aux': '\\newlabel{fig:inner}{{3}{9}{}{}{}}\n',
    };
    const { labels } = readAuxLabels('/out', '/proj/main.tex', {
        readFile: (p) => {
            const k = p.replace(/\\/g, '/');
            if (!(k in files)) throw new Error('ENOENT');
            return files[k];
        },
        exists: (p) => p.replace(/\\/g, '/') in files,
    });
    assert.strictEqual(labels.get('eq:top').printed, '(1)');
    assert.strictEqual(labels.get('fig:inner').printed, '3',
        'a label from an \\include\'d file is a label of this paper');
});

test('a missing .aux is empty, never a throw', () => {
    const { labels } = readAuxLabels('/out', '/proj/main.tex', {
        readFile: () => { throw new Error('ENOENT'); },
        exists: () => false,
    });
    assert.strictEqual(labels.size, 0);
});

// --- the rows ---------------------------------------------------------------

// The shape measured on the reference paper, quoted in texViewer.js:
//     L126 \begin{equation}   x=515.9..599.1   (the NUMBER, in the margin)
//     L135 …the equation…      x=160.2..435.0
//     L137 \end{equation}      x=512.9..517.2  (a sliver under \end)
const EQ_ROWS = [
    { page: 1, x: 515.9, y: 211.3, w: 83.2, h: 13.5, line: 126 },
    { page: 1, x: 160.2, y: 228.5, w: 274.8, h: 30.4, line: 135 },
    { page: 1, x: 512.9, y: 237.3, w: 4.3, h: 13.5, line: 137 },
];

test('THE TAG ROW IS THE ONE THE HIGHLIGHT THROWS AWAY', () => {
    const { keep, stray } = splitStrayRows(EQ_ROWS);
    assert.strictEqual(keep.length, 1, 'one content row');
    assert.strictEqual(Math.round(keep[0].x), 160, 'the equation itself');
    assert.strictEqual(stray.length, 2, 'the number and the \\end sliver');
    assert.ok(stray.some(r => Math.round(r.x) === 516), 'the number is among them');
});

test('a wrapped line\'s short TAIL row is content, not a stray', () => {
    // Measured: line 74 of the reference paper prints "Q-operator is" as an
    // 11 bp row of its own. Narrow — but at the LEFT margin, which is what
    // tells a continuation from a number set flush right.
    const rows = [
        { page: 1, x: 100, y: 100, w: 300, h: 12 },
        { page: 1, x: 100, y: 114, w: 11, h: 12 },
    ];
    const { keep, stray } = splitStrayRows(rows);
    assert.strictEqual(stray.length, 0, 'nothing is a stray here');
    assert.strictEqual(keep.length, 2);
});

// --- placement --------------------------------------------------------------

const FILE = '/paper/main.tex';
const modelOf = (src) => buildModel(scanTex(src, { file: FILE }), { file: FILE });

/** rowsFor built from an explicit line -> rows table. */
const rowsFrom = (table) => (f, line) => (table[line] || []);

test('AN EQUATION\'S LABEL SITS ABOVE ITS TOP-RIGHT CORNER', () => {
    const src = [
        'text before',
        '\\begin{equation}',
        '  E = mc^2',
        '  \\label{eq:emc}',
        '\\end{equation}',
    ].join('\n');
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({
            2: [{ page: 1, x: 515.9, y: 211.3, w: 83.2, h: 13.5 }],
            3: [{ page: 1, x: 160.2, y: 228.5, w: 274.8, h: 13.5 }],
        }),
        boxFor: () => null,
        printedFor: (n) => (n === 'eq:emc' ? { printed: '(4)', page: 1 } : null),
    });
    const c = chips.find(x => x.name === 'eq:emc');
    assert.ok(c, 'the equation has a chip');
    assert.strictEqual(c.kind, 'equation');
    assert.strictEqual(c.role, 'decl');
    assert.strictEqual(c.printed, '(4)', 'and it shows the printed number');
    assert.strictEqual(c.approx, false);
    // A BADGE BELONGS IN THE MARGIN, LEVEL WITH WHAT IT NAMES.
    //
    // MEASURED before this rule (h-glyphmap/check-chips.mjs): placing each
    // badge against its own ink — above it, beside it, at a corner — put 87 of
    // the reference paper's 119 ON printed words, in 63 different x positions.
    // Declarations now share one column in the right margin.
    const tag = { x: 515.9, y: 211.3, w: 83.2, h: 13.5 };
    assert.strictEqual(c.at.anchor, 'right', 'declarations own the right column');
    assert.ok(c.at.x >= tag.x, `outside the text block, got x=${c.at.x}`);
    assert.ok(c.at.x <= 595.276 - 2, `and on the paper, got x=${c.at.x}`);
    assert.ok(Math.abs(c.at.y - tag.y) <= tag.h,
        `level with its own number: ${c.at.y} vs ${tag.y}`);
    assert.ok(c.at.maxW > 0, 'and capped to the margin it sits in');
    assert.strictEqual(c.cmd, 'eqref', 'an equation is cited with \\eqref');
});

test('A WIDE EQUATION STILL YIELDS ITS NUMBER', () => {
    // MEASURED on the reference paper: eq:physical-dotted-sov-towers prints its
    // number at x=515.9 while a content row reaches x=517.2, so the "entirely
    // to the right of the body" rule missed it by 1.3 bp. Half the paper's
    // equations are like this. A number is known by starting in the MARGIN.
    const src = '\\begin{equation}\n  x = 1 \\label{eq:wide}\n\\end{equation}';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({
            1: [{ page: 2, x: 515.9, y: 162.6, w: 66.4, h: 13.5 }],
            2: [{ page: 2, x: 140.1, y: 181.6, w: 377.1, h: 13.5 }],
        }),
        boxFor: () => null,
        pageWidth: 595.276,
    });
    const c = chips.find(x => x.name === 'eq:wide');
    assert.ok(c, 'placed');
    assert.strictEqual(c.approx, false, 'and known exactly, despite the wide body');
    assert.ok(c.at.x <= 595.276 - 2, `on the paper, got x=${c.at.x}`);
    assert.strictEqual(c.at.anchor, 'right');
    assert.ok(Math.abs(c.at.y - 162.6) <= 13.5, `level with its number, got y=${c.at.y}`);
});

test('NO CHIP MAY LAND OFF THE PAPER', () => {
    const src = '\\begin{equation} a=1 \\label{eq:edge} \\end{equation}';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        // A number already flush to the right margin: there is nothing to its
        // right to put a chip in.
        rowsFor: rowsFrom({ 1: [{ page: 1, x: 515.9, y: 211, w: 83.2, h: 13.5 }] }),
        boxFor: () => null,
        pageWidth: 595.276,
    });
    const c = chips.find(x => x.name === 'eq:edge');
    assert.ok(c, 'placed');
    assert.ok(c.at.x < 595.276, `on the page, got x=${c.at.x}`);
});

test('EVERY LABEL OF AN align GETS ITS OWN NUMBER', () => {
    // MEASURED: 8 of the reference paper's 82 labels had no chip at all, every
    // one a \label on its own line inside an align. The scanner writes
    // `target.label = arg` per label, so only the LAST survives on the object;
    // the rest are standalone label objects whose own line prints nothing.
    const src = [
        '\\begin{align}',
        '  a &= 1 \\label{eq:one}\\\\',
        '  b &= 2 \\label{eq:two}\\\\',
        '  c &= 3 \\label{eq:three}',
        '\\end{align}',
    ].join('\n');
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({
            // Three numbers in the margin, one per numbered line, plus bodies.
            1: [{ page: 1, x: 520, y: 100, w: 30, h: 13 },
                { page: 1, x: 520, y: 120, w: 30, h: 13 },
                { page: 1, x: 520, y: 140, w: 30, h: 13 }],
            2: [{ page: 1, x: 200, y: 100, w: 200, h: 13 }],
        }),
        boxFor: () => null,
        pageWidth: 595.276,
    });
    const names = chips.filter(c => c.role === 'decl').map(c => c.name).sort();
    assert.deepStrictEqual(names, ['eq:one', 'eq:three', 'eq:two'],
        'all three, not just the last one the scanner kept');
    // Each label against the number it should have taken. (Not sorted by
    // `line`: the object's own label reports the block's start line, not its
    // own, so a line sort scrambles the very thing being checked.)
    const at = (n) => chips.find(c => c.role === 'decl' && c.name === n).at;
    const near = (n, y) => Math.abs(at(n).y - y) <= 13;
    assert.ok(near('eq:one', 100), `the first label takes the first number, got ${at('eq:one').y}`);
    assert.ok(near('eq:two', 120), `got ${at('eq:two').y}`);
    assert.ok(near('eq:three', 140), `and the last takes the last, got ${at('eq:three').y}`);
    // One column: three names, one x.
    assert.strictEqual(new Set(['eq:one', 'eq:two', 'eq:three'].map(n => at(n).x)).size, 1);
});

test('an equation with NO tag row falls back, and says it is approximate', () => {
    const src = '\\begin{equation}\n  E = mc^2 \\label{eq:emc}\n\\end{equation}';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({ 2: [{ page: 1, x: 160, y: 228, w: 275, h: 13 }] }),
        boxFor: () => null,
    });
    const c = chips.find(x => x.name === 'eq:emc');
    assert.ok(c, 'still placed');
    assert.strictEqual(c.approx, true, 'and honest about it');
});

test('a \\section{}\\label{} pair gets ONE chip, in the margin', () => {
    // The label attaches to no numberable environment, so the scanner hands it
    // to the preceding object — the heading. This is the commonest label in a
    // paper and it must not come out twice.
    const src = '\\section{Introduction}\\label{sec:intro}\n\nBody.';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({ 1: [{ page: 1, x: 100, y: 90, w: 300, h: 14 }] }),
        boxFor: () => null,
    });
    const mine = chips.filter(x => x.name === 'sec:intro');
    assert.strictEqual(mine.length, 1, `one chip, got ${mine.length}`);
    assert.strictEqual(mine[0].kind, 'section');
    // A heading's label is a DECLARATION, so it joins the declarations' column
    // in the right margin — one place for "what this thing is called", whether
    // the thing is a section, an equation or a float.
    assert.strictEqual(mine[0].at.anchor, 'right', 'declarations wear their label on the right');
    assert.ok(mine[0].at.x >= 400, `outside the text block, got x=${mine[0].at.x}`);
    assert.ok(Math.abs(mine[0].at.y - 90) <= 14, 'level with the heading it names');
    assert.strictEqual(mine[0].cmd, 'ref');
});

test('a figure with no rows at all is placed from its BOX', () => {
    const src = [
        '\\begin{figure}',
        '\\includegraphics{plot.pdf}',
        '\\caption{A plot.}\\label{fig:plot}',
        '\\end{figure}',
    ].join('\n');
    let asked = 0;
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: () => [],
        boxFor: () => { asked++; return { rects: [{ page: 2, x: 120, y: 300, w: 350, h: 220 }] }; },
    });
    const c = chips.find(x => x.name === 'fig:plot');
    assert.ok(c, 'a float still gets a chip');
    assert.ok(asked > 0, 'because the box was consulted');
    assert.strictEqual(c.at.page, 2);
    assert.strictEqual(c.approx, true);
});

test('\\cite{a,b,c} is three chips, and they do not stack on one spot', () => {
    const src = 'As shown in \\cite{alpha,beta,gamma} the result holds.';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({ 1: [{ page: 1, x: 100, y: 100, w: 300, h: 12 }] }),
        boxFor: () => null,
        citeFor: (n) => (n === 'alpha' ? { printed: '12' } : null),
    });
    const cites = chips.filter(x => x.role === 'cite');
    assert.strictEqual(cites.length, 3, `three keys, three chips, got ${cites.length}`);
    assert.deepStrictEqual(cites.map(c => c.name), ['alpha', 'beta', 'gamma']);
    assert.strictEqual(cites[0].printed, '12');
    assert.strictEqual(new Set(cites.map(c => c.at.y)).size, 3, 'each on its own line');
    assert.ok(cites.every(c => c.cmd === 'cite'));
});

test('a label declared through a user MACRO still gets a chip', () => {
    // A third of the reference paper's cross-references go through \la{...}.
    const src = [
        '\\newcommand{\\la}[1]{\\label{#1}}',
        '\\begin{equation}',
        '  x = 1 \\la{eq:one}',
        '\\end{equation}',
    ].join('\n');
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({
            2: [{ page: 1, x: 515, y: 200, w: 80, h: 13 }],
            3: [{ page: 1, x: 160, y: 220, w: 275, h: 13 }],
        }),
        boxFor: () => null,
    });
    assert.ok(chips.some(x => x.name === 'eq:one'), 'the macro-declared label is there');
});

test('a \\ref to a name nothing declares is marked BROKEN', () => {
    const src = 'See \\eqref{eq:ghost} for details.';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({ 1: [{ page: 1, x: 100, y: 100, w: 300, h: 12 }] }),
        boxFor: () => null,
        declared: new Set(['eq:real']),
    });
    const c = chips.find(x => x.name === 'eq:ghost');
    assert.ok(c, 'the site still gets a chip');
    assert.strictEqual(c.broken, true, 'shown as broken rather than quietly placed');
});

test('a \\eqref site is placed over its printed number when the ink is known', () => {
    const src = 'As \\eqref{eq:emc} shows, the mass is energy.';
    const rows = { 1: [{ page: 1, x: 100, y: 100, w: 300, h: 12 }] };
    const ink = [
        { str: 'As', x: 100, y: 100, baseline: 105, w: 14 },
        { str: '(4)', x: 120, y: 100, baseline: 105, w: 18 },
        { str: 'shows,', x: 145, y: 100, baseline: 105, w: 32 },
    ];
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom(rows),
        boxFor: () => null,
        printedFor: () => ({ printed: '(4)' }),
        inkFor: () => ink,
    });
    const c = chips.find(x => x.name === 'eq:emc');
    assert.ok(c, 'placed');
    assert.strictEqual(c.approx, false, 'exactly, because the ink was found');
    // THE BADGE NAMES IT FROM THE MARGIN; THE NUMBER ITSELF IS UNDERLINED.
    //
    // It used to be moved on top of the printed number, which in prose means on
    // top of the line above — the reported obstruction. What the panel needs to
    // draw the underline still travels with the chip (`find`), and the badge
    // sits in the left column, level with the row that number printed on.
    assert.strictEqual(c.at.anchor, 'left', 'references own the left column');
    assert.ok(c.at.x <= 100, `left of the text block, got x=${c.at.x}`);
    assert.ok(Math.abs(c.at.y - 100) <= 12, `level with its own row, got y=${c.at.y}`);
    assert.ok(c.find && c.find.text === '(4)', 'and the panel is told what to underline');
});

test('the same \\eqref with NO text layer still lands, marked approximate', () => {
    // The text layer is swept asynchronously and the first Shift after a
    // compile beats it. A chip that refused to appear would read as "this paper
    // has no labels".
    const src = 'As \\eqref{eq:emc} shows, the mass is energy.';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({ 1: [{ page: 1, x: 100, y: 100, w: 300, h: 12 }] }),
        boxFor: () => null,
        printedFor: () => ({ printed: '(4)' }),
        inkFor: null,
    });
    const c = chips.find(x => x.name === 'eq:emc');
    assert.ok(c, 'still placed');
    assert.strictEqual(c.approx, true);
});

test('a duplicate \\label yields exactly one declaration chip', () => {
    const src = [
        '\\begin{equation} a=1 \\label{eq:dup} \\end{equation}',
        '\\begin{equation} b=2 \\label{eq:dup} \\end{equation}',
    ].join('\n');
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: rowsFrom({
            1: [{ page: 1, x: 160, y: 100, w: 275, h: 13 }],
            2: [{ page: 1, x: 160, y: 140, w: 275, h: 13 }],
        }),
        boxFor: () => null,
    });
    assert.strictEqual(chips.filter(c => c.role === 'decl' && c.name === 'eq:dup').length, 1);
});

test('an unmapped object is left out rather than placed at 0,0', () => {
    const src = '\\begin{equation} a=1 \\label{eq:nowhere} \\end{equation}';
    const chips = buildLabelChips({
        objects: modelOf(src).objects,
        file: FILE,
        rowsFor: () => [],
        boxFor: () => null,
    });
    assert.strictEqual(chips.length, 0, 'no honest place means no chip');
});

// --- what a click copies -----------------------------------------------------

test('the default copy is the reference, ready to paste', () => {
    assert.strictEqual(
        formatLabelCopy('eq:foo', { kind: 'equation', role: 'decl', cmd: 'eqref' }),
        '\\eqref{eq:foo}');
    assert.strictEqual(
        formatLabelCopy('fig:bar', { kind: 'figure', role: 'decl', cmd: 'ref' }),
        '\\ref{fig:bar}');
    assert.strictEqual(
        formatLabelCopy('smith2020', { kind: 'cite', role: 'cite', cmd: 'cite' }),
        '\\cite{smith2020}');
});

test('every format, including the bare one Alt-click gives', () => {
    const eq = { kind: 'equation', role: 'decl', cmd: 'eqref' };
    assert.strictEqual(formatLabelCopy('eq:a', { ...eq, format: 'bare' }), 'eq:a');
    assert.strictEqual(formatLabelCopy('eq:a', { ...eq, format: 'ref' }), '\\ref{eq:a}');
    assert.strictEqual(formatLabelCopy('sec:a', { kind: 'section', format: 'eqref' }), '\\eqref{sec:a}');
    // A citation is a citation whatever the format says: \eqref{smith2020}
    // would not compile.
    assert.strictEqual(
        formatLabelCopy('smith2020', { role: 'cite', format: 'eqref' }), '\\cite{smith2020}');
    assert.strictEqual(altFormat('command'), 'bare');
    assert.strictEqual(altFormat('bare'), 'command');
    assert.strictEqual(formatLabelCopy('', {}), '', 'nothing in, nothing out');
});

test('a partial view of the ink cannot put a badge column on the text', () => {
    // The badge columns are derived from whatever `inkFor` reports. The census
    // (h-glyphmap/check-chips.mjs) feeds that the GLYPH MAP — every printed
    // glyph — and measures 0/119 badges over ink. The live panel feeds it
    // PDF.JS'S TEXT LAYER instead, which is lossier and can miss maths, so a
    // maths-heavy page may report a text block far narrower than the one TeX
    // set. A column computed from that lands INSIDE the type block, which is
    // the one thing this module exists to prevent.
    const W = 595.276;
    const full = blockOf(() => [{ x: 79, w: 437 }], 1, W);
    assert.ok(Math.abs(full.x0 - 79) < 1 && Math.abs(full.x1 - 516) < 1,
        'a complete view is used as measured');

    // Half a page wide is not a narrow paper — it is half a measurement.
    const partial = blockOf(() => [{ x: 200, w: 120 }], 1, W);
    assert.ok(partial.x1 > W * 0.8,
        `a partial view falls back to the printed measure (got ${partial.x1.toFixed(0)})`);
    assert.ok(partial.x0 < W * 0.2, 'on both sides');

    // No text layer at all behaves exactly as it always did.
    const none = blockOf(() => null, 1, W);
    assert.ok(Math.abs(none.x1 - W * 0.867) < 1);
});

test('the printed section numbers come out of the .aux TOC lines', () => {
    // Shapes taken verbatim from the reference paper's .aux.
    const aux = [
        '\\relax',
        '\\@writefile{toc}{\\contentsline {section}{\\numberline {1}From the coordinate wavefunction}{1}{section.1}\\protected@file@percent }',
        '\\@writefile{toc}{\\contentsline {subsection}{\\numberline {1.1}Where may $x$ and $\\dot  x$ lie?}{2}{subsection.1.1}\\protected@file@percent }',
        '\\@writefile{lof}{\\contentsline {figure}{\\numberline {1}{\\ignorespaces A caption}}{2}{figure.1}\\protected@file@percent }',
        '\\@writefile{toc}{\\contentsline {paragraph}{The full grid.}{2}{section*.1}\\protected@file@percent }',
    ].join('\n');
    const toc = parseToc(aux);

    assert.strictEqual(toc.length, 3, 'the figure list is not a table of contents');
    assert.ok(!toc.some(e => /caption/.test(e.title)),
        'a figure caption read as a section title would be worse than no number');

    assert.strictEqual(toc[0].number, '1');
    assert.strictEqual(toc[0].level, 'section');
    assert.strictEqual(toc[1].number, '1.1');
    assert.strictEqual(toc[2].number, null, 'a paragraph is unnumbered, and says so');
    assert.strictEqual(toc[2].title, 'the full grid.', 'but it is still read');
});

test('a heading is matched by its SOURCE, through texorpdfstring', () => {
    // MEASURED on the reference paper: 7 of 21 headings matched before
    // \texorpdfstring was expanded and 13 after, and every one of the misses
    // was a heading with maths in it. The .aux keeps the FIRST argument.
    const auxTitle = 'Where may $x$ and $\\dot  x$ lie?';
    const source = 'Where may \\texorpdfstring{$x$ and $\\dot x$}{x and x-dot} lie?';
    assert.strictEqual(normalizeTocTitle(source), normalizeTocTitle(auxTitle),
        'the two spellings of one heading compare equal');

    // The model's own title is a flattened rendering and does NOT compare —
    // which is why the source is used instead.
    assert.notStrictEqual(normalizeTocTitle('Where may x and xx and x-dot lie?'),
        normalizeTocTitle(auxTitle));

    assert.strictEqual(sectionTitleSource('\\subsection{A first example}'), 'A first example');
    assert.strictEqual(sectionTitleSource('\\section*{Unnumbered}'), 'Unnumbered');
    assert.strictEqual(sectionTitleSource('\\subsection{Nested {braces} kept}'), 'Nested {braces} kept');
    assert.strictEqual(sectionTitleSource('no command here'), '');
});

test('two sections with the same title are left unnumbered, not guessed at', () => {
    const aux = [
        '\\@writefile{toc}{\\contentsline {subsection}{\\numberline {2.1}Setup}{3}{subsection.2.1}}',
        '\\@writefile{toc}{\\contentsline {subsection}{\\numberline {5.1}Setup}{9}{subsection.5.1}}',
        '\\@writefile{toc}{\\contentsline {section}{\\numberline {3}Unique}{4}{section.3}}',
    ].join('\n');
    let read = null;
    const deps = { readFile: () => aux, exists: () => true };
    read = readTocNumbers('/out', '/p/paper.tex', deps);
    assert.strictEqual(read.byTitle.get('unique'), '3');
    assert.strictEqual(read.byTitle.has('setup'), false,
        'a wrong number beside a change is worse than none');
});

test('no .aux, or an unreadable one, is simply no numbers', () => {
    assert.strictEqual(readTocNumbers('/out', '/p/paper.tex', { readFile: () => { throw new Error('nope'); }, exists: () => true }).byTitle.size, 0);
    assert.strictEqual(readTocNumbers('/out', '/p/paper.tex', { readFile: () => '', exists: () => false }).byTitle.size, 0);
    assert.strictEqual(readTocNumbers(null, null, null).byTitle.size, 0);
    assert.deepStrictEqual(parseToc(''), []);
    assert.deepStrictEqual(parseToc(null), []);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); pass++; results.push('  ok   ' + name); }
        catch (e) {
            fail++;
            results.push('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    console.log('the label overlay: .aux, rows, placement, copy\n');
    results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
