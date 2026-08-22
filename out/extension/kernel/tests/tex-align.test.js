// The source-token <-> rendered-glyph alignment.
//
//   node out/extension/kernel/tests/tex-align.test.js
//
// WHY THIS EXISTS, AND WHAT IT IS DEFENDING. Resolution used to work by NAME
// inside one source line: take the line SyncTeX names for a click and look
// there for a token printing the clicked glyph. Measured on the user's own
// paper (Experiments/wolfbook-tex/f-align):
//
//     display-equation lines with NO SyncTeX rows          71.1%
//     rendered glyphs resolving to a source token           8.8%
//     most-missed  ")" x304  "(" x295  "2" x220  "=" x195
//
// Ordinary characters, plainly present in the source, unreachable in principle
// because TeX does not attribute an equation's glyphs to the lines that wrote
// them. Aligning the whole object's two sequences instead took the same paper
// to 72.5%. These assertions pin the specific mechanisms that got it there.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String((e && e.message) || e).replace(/\n/g, '\n         ')); }
};

const {
    sourceTokens, renderedGlyphs, align, buildObjectMap, glyphAtPoint, tokenAt,
    groupAround, keyOf, symbolicFonts,
} = require('../../tex/glyphAlign');
const { roleIndex, mathSpans } = require('../../tex/mathStructure');
const { collectMacros } = require('../../tex/texWords');

// A real equation from the reference paper, macros and all.
const MACROS = collectMacros([
    '\\newcommand{\\ii}{\\mathrm{i}}',
    '\\newcommand{\\cD}{\\mathcal{D}}',
    '\\newcommand{\\SoV}{\\mathrm{SoV}}',
    '\\newcommand{\\bx}{\\boldsymbol{x}}',
].join('\n'));

const LINES = [
    '\\begin{equation}',
    '  R_\\alpha',
    '  :=\\bigl(\\cD_\\alpha-2\\cos\\phi_\\psi\\,x_\\alpha^2\\bigr)',
    '       \\Psi_{\\SoV}.',
    '  \\label{eq:Ralpha}',
    '\\end{equation}',
];

const tokensOf = () => sourceTokens({
    lines: LINES, startLine: 1, endLine: 6, macros: MACROS, inMath: true,
});

test('source tokens span the whole OBJECT, not one line', () => {
    const t = tokensOf();
    const s = t.map(x => x.ch).join('');
    assert.ok(/R/.test(s) && /D/.test(s) && /Ψ/.test(s),
        `tokens from every line of the equation, got ${JSON.stringify(s)}`);
    // The lines really are different lines — that is the whole point.
    assert.ok(new Set(t.map(x => x.line)).size >= 3, 'spanning several source lines');
    // And the environment's own machinery never becomes a glyph.
    assert.ok(!/equation|label|Ralpha/.test(s), `no markup leaked: ${JSON.stringify(s)}`);
});

test('every token maps back to source text that could have printed it', () => {
    for (const t of tokensOf()) {
        const line = LINES[t.line - 1];
        const src = t.endLine === t.line ? line.slice(t.startCol, t.endCol) : line.slice(t.startCol);
        assert.ok(src.length > 0, `${JSON.stringify(t.ch)} has an empty span`);
        // Either the character itself, or the command that prints it.
        assert.ok(src === t.ch || /^\\[A-Za-z@]+/.test(src) || src.startsWith(t.ch),
            `${JSON.stringify(t.ch)} came from ${JSON.stringify(src)}`);
    }
});

test('an UNNAMEABLE rendered glyph becomes a wildcard, not a dropped glyph', () => {
    // MEASURED: \bigl( and \bigr) reach pdf.js as U+0000 and U+0001 — TeX's
    // extensible delimiters live in font slots that map to no Unicode. That one
    // fact made "(" and ")" the two most-missed glyphs in the census, 599
    // misses between them, while being plainly present in the source.
    assert.strictEqual(keyOf('\u0000'), keyOf('\u0001'), 'both are the same wildcard');
    assert.notStrictEqual(keyOf('\u0000'), keyOf('('), 'but not equal to a real paren');
    const gs = renderedGlyphs([
        { page: 1, str: '\u0000x\u0001', x: 10, y: 100, w: 30, h: 10, baseline: 110 },
    ]);
    assert.strictEqual(gs.length, 3, `kept, not filtered out: got ${gs.length}`);
});

test('a wildcard pairs with whatever the context puts there', () => {
    const src = ['(', 'a', ')'];
    const ren = [keyOf('\u0000'), 'a', keyOf('\u0001')];
    const { srcToRen } = align(src, ren);
    assert.strictEqual(srcToRen[0], 0, 'the source ( took the unnameable glyph');
    assert.strictEqual(srcToRen[1], 1);
    assert.strictEqual(srcToRen[2], 2, 'and the source ) took the closing one');
});

test('THE SAME INK COLLECTED TWICE IS DEDUPED', () => {
    // An object's rows come from all of its lines and those rectangles OVERLAP,
    // so the same text item is collected several times. Measured, one equation
    // produced "222R=DDα−−22ccoossϕϕψxxαΨΨSoV(72)" — every glyph doubled, which
    // no alignment can recover from.
    const one = { page: 1, str: 'abc', x: 10, y: 100, w: 30, h: 10, baseline: 110 };
    const gs = renderedGlyphs([one, { ...one }, { ...one }]);
    assert.strictEqual(gs.map(g => g.ch).join(''), 'abc', 'seen again is seen again');
});

test('READING ORDER: a superscript belongs to its line, a fraction does not', () => {
    // A superscript sits ~9bp above the body baseline. Grouping by BASELINE
    // made x^2 two bands and — the superscript being higher — put the 2 first:
    // "2R=D..." where the source says "R...x2". Boxes overlap, so overlap is
    // the test.
    const base = { page: 1, y: 100, h: 10, baseline: 110 };
    const sup = { page: 1, y: 94, h: 7, baseline: 104 };     // overlaps the base
    const sup2 = renderedGlyphs([
        { ...base, str: 'x', x: 10, w: 6 },
        { ...sup, str: '2', x: 16, w: 4 },
        { ...base, str: '+', x: 24, w: 6 },
    ]);
    assert.strictEqual(sup2.map(g => g.ch).join(''), 'x2+', 'the superscript stays in its line');

    // A fraction's numerator and denominator do NOT overlap, so they are two
    // lines, numerator first — which is also the order they are written in.
    const frac = renderedGlyphs([
        { page: 1, str: 'b', x: 10, y: 116, w: 6, h: 10, baseline: 126 },   // lower
        { page: 1, str: 'a', x: 10, y: 100, w: 6, h: 10, baseline: 110 },   // upper
    ]);
    assert.strictEqual(frac.map(g => g.ch).join(''), 'ab', 'numerator, then denominator');
});

test('A SUBSCRIPT IS KNOWN BY ITS SIZE, not only by how far it drops', () => {
    // MEASURED on the paper: the α of `\\theta_\\alpha` sits 1.7 bp below the
    // body baseline while the α of `x_{\\alpha,n}` sits 3.3 bp below — the same
    // kind of thing, and any tolerance that catches one calls the other body
    // text. What they have in common is that both are SET SMALLER.
    const gs = renderedGlyphs([
        { page: 1, str: 'θ', x: 100, y: 90, w: 8, h: 11, baseline: 101 },
        { page: 1, str: 'α', x: 108, y: 94, w: 5, h: 8, baseline: 102.7 },   // barely dropped
        { page: 1, str: '+', x: 116, y: 90, w: 7, h: 11, baseline: 101 },
        { page: 1, str: 'x', x: 126, y: 90, w: 7, h: 11, baseline: 101 },
        { page: 1, str: 'n', x: 133, y: 95, w: 5, h: 8, baseline: 104.3 },   // plainly dropped
    ]);
    assert.strictEqual(gs.map(g => g.ch).join(''), 'θα+xn', 'reading order, scripts beside their bases');
    const level = Object.fromEntries(gs.map(g => [g.ch, g.level]));
    assert.strictEqual(level['α'], 'below', 'the barely-dropped subscript is still a subscript');
    assert.strictEqual(level['n'], 'below');
    assert.strictEqual(level['θ'], 'base');
});

test('A SCRIPT NEVER JOINS THE CLUSTER AT THE FAR END OF THE LINE', () => {
    // Glyphs are clustered by baseline first, so each new baseline starts over
    // at a small x. A one-sided "close enough on the right" gap test then said
    // every one of them continued the LAST cluster on the line — measured, the
    // four subscript α of one equation came out as a block after everything
    // else, and not one of them paired with a source token.
    const items = [];
    for (let i = 0; i < 6; i++) {
        items.push({ page: 1, str: 'x', x: 100 + i * 30, y: 90, w: 8, h: 11, baseline: 101 });
    }
    items.push({ page: 1, str: 'a', x: 108, y: 94, w: 5, h: 8, baseline: 102.7 });   // a script early on
    const gs = renderedGlyphs(items);
    assert.strictEqual(gs.map(g => g.ch).join(''), 'xaxxxxx',
        `the script belongs beside the FIRST x, got ${gs.map(g => g.ch).join('')}`);
});

test('AN ACCENT IS WRITTEN BEFORE ITS BASE AND PRINTED AFTER IT', () => {
    // `\\dot x` puts the mark first in the source and second on the page. The
    // projection already knows that; sorting the tokens by source offset undid
    // it, and the transposition cost the alignment both glyphs — measured, six
    // of one fixture's failures.
    const seq = sourceTokens({
        lines: ['\\dot x_{\\alpha,\\dot n}^{\\uparrow}'], startLine: 1, endLine: 1, inMath: true,
    }).map(t => t.ch).join(' ');
    assert.strictEqual(seq, 'x ˙ α , n ˙ ↑',
        `base, its accent, then the scripts — got ${JSON.stringify(seq)}`);
});

test('the whole equation aligns, and a click resolves to the right macro', () => {
    // The rendered side as pdf.js really reports it: unnameable delimiters,
    // \cos as three letters, the macros expanded.
    const items = [
        { page: 1, str: 'R', x: 100, y: 90, w: 7, h: 10, baseline: 100 },
        { page: 1, str: 'α', x: 107, y: 94, w: 5, h: 7, baseline: 103 },
        { page: 1, str: ':=', x: 114, y: 90, w: 12, h: 10, baseline: 100 },
        { page: 1, str: '\u0000', x: 128, y: 88, w: 5, h: 14, baseline: 100 },
        { page: 1, str: 'D', x: 134, y: 90, w: 8, h: 10, baseline: 100 },
        { page: 1, str: 'α', x: 142, y: 94, w: 5, h: 7, baseline: 103 },
        { page: 1, str: '−', x: 149, y: 90, w: 7, h: 10, baseline: 100 },
        { page: 1, str: '2', x: 157, y: 90, w: 6, h: 10, baseline: 100 },
        { page: 1, str: 'cos', x: 164, y: 90, w: 16, h: 10, baseline: 100 },
        { page: 1, str: 'ϕ', x: 181, y: 90, w: 6, h: 10, baseline: 100 },
        { page: 1, str: 'ψ', x: 187, y: 94, w: 5, h: 7, baseline: 103 },
        { page: 1, str: 'x', x: 194, y: 90, w: 6, h: 10, baseline: 100 },
        { page: 1, str: 'α', x: 200, y: 94, w: 5, h: 7, baseline: 103 },
        { page: 1, str: '2', x: 200, y: 85, w: 4, h: 6, baseline: 91 },
        { page: 1, str: '\u0001', x: 206, y: 88, w: 5, h: 14, baseline: 100 },
        { page: 1, str: 'Ψ', x: 213, y: 90, w: 8, h: 10, baseline: 100 },
        { page: 1, str: 'SoV', x: 221, y: 94, w: 14, h: 7, baseline: 103 },
    ];
    const m = buildObjectMap({ lines: LINES, startLine: 1, endLine: 6, macros: MACROS, inMath: true, items });
    assert.ok(m.confidence > 0.7, `confidence ${m.confidence.toFixed(2)}`);

    const resolve = (x, y) => {
        const g = glyphAtPoint(m, 1, x, y);
        assert.ok(g.index >= 0 && g.distance < 12, `nothing near ${x},${y}`);
        const ti = m.renToSrc[g.index];
        assert.ok(ti >= 0, `glyph ${JSON.stringify(m.glyphs[g.index].ch)} has no source token`);
        return m.tokens[ti];
    };

    // The D of \cD — a MACRO, which must resolve to the call.
    const d = resolve(137, 95);
    assert.strictEqual(LINES[d.line - 1].slice(d.startCol, d.endCol), '\\cD',
        `expected the macro call, got ${JSON.stringify(LINES[d.line - 1].slice(d.startCol, d.endCol))}`);

    // The opening delimiter, which the PDF could not even name.
    const open = resolve(130, 95);
    assert.strictEqual(LINES[open.line - 1][open.startCol], '(',
        'the unnameable glyph resolved to the source paren');

    // The Ψ, on a DIFFERENT source line from everything above.
    const psi = resolve(216, 95);
    assert.strictEqual(psi.line, 4, `Ψ is on line 4, got ${psi.line}`);
    assert.strictEqual(LINES[psi.line - 1].slice(psi.startCol, psi.endCol), '\\Psi');

    // And one of \cos's own letters selects the command.
    const c = resolve(166, 95);
    assert.strictEqual(LINES[c.line - 1].slice(c.startCol, c.endCol), '\\cos');
});

test('FORWARD is the same table read the other way', () => {
    const items = [
        { page: 1, str: 'R', x: 100, y: 90, w: 7, h: 10, baseline: 100 },
        { page: 1, str: 'α', x: 107, y: 94, w: 5, h: 7, baseline: 103 },
        { page: 1, str: 'Ψ', x: 213, y: 90, w: 8, h: 10, baseline: 100 },
    ];
    const m = buildObjectMap({ lines: LINES, startLine: 1, endLine: 6, macros: MACROS, inMath: true, items });
    // A cursor on \Psi (line 4) must light up the Ψ at x=213.
    const col = LINES[3].indexOf('\\Psi');
    const t = tokenAt(m, 4, col + 1);
    assert.ok(t.index >= 0, 'the cursor is on a token');
    const gi = m.srcToRen[t.index];
    assert.ok(gi >= 0, 'which has a rendered glyph');
    assert.strictEqual(m.glyphs[gi].ch, 'Ψ');
    assert.strictEqual(m.glyphs[gi].x, 213);
});

test('THE BIG OPERATORS: a font that lies about its characters is distrusted', () => {
    // MEASURED, and this is the reported \\sum bug: pdf.js reports the big
    // summation as "X", the integral as "Z" and the product as "Y" — TeX's
    // math-extension font has no Unicode mapping, so a glyph comes back as the
    // ASCII letter of the slot it occupies. The font cannot be NAMED (pdf.js
    // gives a generated id, and its fontFamily is the CSS-generic
    // "sans-serif"), but it can be recognised: it is the one emitting
    // unnameable control codes.
    const items = [
        { page: 1, str: 'X', x: 100, y: 88, w: 10, h: 16, baseline: 100, font: 'f11' },
        { page: 1, str: '\u0012', x: 118, y: 88, w: 5, h: 16, baseline: 100, font: 'f11' },
        { page: 1, str: 'a', x: 126, y: 90, w: 6, h: 10, baseline: 100, font: 'f4' },
        { page: 1, str: '\u0013', x: 134, y: 88, w: 5, h: 16, baseline: 100, font: 'f11' },
    ];
    const fonts = symbolicFonts(items);
    assert.ok(fonts.has('f11'), 'the extension font is recognised by its control codes');
    assert.ok(!fonts.has('f4'), 'and the ordinary text font is not');

    const lines = ['\\begin{equation}', '  \\sum \\bigl( a \\bigr)', '\\end{equation}'];
    const m = buildObjectMap({ lines, startLine: 1, endLine: 3, inMath: true, items, symbolFonts: fonts });
    const at = (x) => {
        const g = glyphAtPoint(m, 1, x, 95);
        const ti = m.renToSrc[g.index];
        assert.ok(ti >= 0, `the glyph at ${x} resolved to nothing`);
        const t = m.tokens[ti];
        return lines[t.line - 1].slice(t.startCol, t.endCol);
    };
    // The "X" is really a summation, and must select \\sum — not some letter x.
    assert.strictEqual(at(103), '\\sum', 'the false X resolves to the summation');
    assert.strictEqual(at(120), '(', 'and the stretched delimiters to their parens');
    assert.strictEqual(at(136), ')');
    assert.strictEqual(at(128), 'a', 'while the ordinary letter is untouched');
});

test('a wildcard prefers a glyph the extension font can actually draw', () => {
    // Without this the summation scored the same against the Z of \\mathbb Z as
    // against the ∑ beside it, and the big operator resolved ONE TOKEN OFF. A
    // math-extension font draws operators, radicals and delimiters — never
    // letters — so the score has to say so.
    const src = ['∑', 'm', '∈', 'Z', '∫'];
    const ren = [keyOf('X', true), 'Z', keyOf('Z', true)];
    const { renToSrc } = align(src, ren);
    assert.strictEqual(src[renToSrc[0]], '∑', 'the first wildcard took the summation');
    assert.strictEqual(src[renToSrc[1]], 'Z', 'the real Z took the real Z');
    assert.strictEqual(src[renToSrc[2]], '∫', 'and the second wildcard the integral');
});

test('a click far from any glyph reports its distance so the caller can decline', () => {
    const m = buildObjectMap({
        lines: LINES, startLine: 1, endLine: 6, macros: MACROS, inMath: true,
        items: [{ page: 1, str: 'R', x: 100, y: 90, w: 7, h: 10, baseline: 100 }],
    });
    const near = glyphAtPoint(m, 1, 102, 95);
    assert.ok(near.distance < 2, `on the glyph: ${near.distance}`);
    const far = glyphAtPoint(m, 1, 400, 95);
    assert.ok(far.distance > 100, `far away: ${far.distance}`);
    assert.strictEqual(glyphAtPoint(m, 2, 102, 95).index, -1, 'and another page is not a candidate');
});

test('nothing here throws on empty, malformed or one-sided input', () => {
    assert.doesNotThrow(() => buildObjectMap({}));
    assert.doesNotThrow(() => buildObjectMap({ lines: [], startLine: 5, endLine: 1 }));
    assert.doesNotThrow(() => renderedGlyphs(null));
    assert.doesNotThrow(() => renderedGlyphs([{ str: null }]));
    assert.doesNotThrow(() => align([], []));
    assert.doesNotThrow(() => align(['a'], []));
    const m = buildObjectMap({ lines: LINES, startLine: 1, endLine: 6, macros: MACROS, items: [] });
    assert.strictEqual(m.confidence, 0, 'and says it knows nothing');
    assert.strictEqual(glyphAtPoint(m, 1, 0, 0).index, -1);
    assert.strictEqual(tokenAt(m, 999, 0).index, -1);
});

test('a big equation aligns in reasonable time', () => {
    // The DP is O(n*m); a runaway here would show up as a frozen click.
    const lines = ['\\begin{equation}'];
    for (let i = 0; i < 40; i++) lines.push(`  a_{${i}} + \\cos\\phi_{${i}} \\cdot x^{${i}} +`);
    lines.push('\\end{equation}');
    const items = [];
    for (let i = 0; i < 600; i++) {
        items.push({ page: 1, str: 'a', x: i * 3, y: 100, w: 3, h: 10, baseline: 110 });
    }
    const t0 = Date.now();
    const m = buildObjectMap({ lines, startLine: 1, endLine: lines.length, items });
    const ms = Date.now() - t0;
    assert.ok(m.tokens.length > 400, `a real workload: ${m.tokens.length} tokens`);
    assert.ok(ms < 1500, `took ${ms} ms`);
});

test('the tex sources contain no RAW control bytes', () => {
    // Documenting the unnameable glyphs meant pasting U+0000 and U+0001 into a
    // comment, and a NUL byte makes the whole file BINARY to grep, git and
    // diff: `grep -c symbolicFonts glyphAlign.js` printed nothing at all, which
    // is a miserable way to lose an afternoon. Write the escape, not the byte.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'tex');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const b = fs.readFileSync(path.join(dir, f));
        for (const byte of b) {
            if (byte < 0x09 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte < 0x20)) {
                offenders.push(`${f} (0x${byte.toString(16).padStart(2, '0')})`);
                break;
            }
        }
    }
    assert.deepStrictEqual(offenders, [], `raw control bytes in: ${offenders.join(', ')}`);
});

// --- STRUCTURE: the two sides must agree on where a glyph SITS ---------------

test('the source knows a subscript from a superscript, and both from a fraction', () => {
    const idx = roleIndex('U_{m,k}^{\\pm}=\\frac{|m|}{2}');
    const role = (needle, from = 0) => idx.at(('U_{m,k}^{\\pm}=\\frac{|m|}{2}').indexOf(needle, from));
    assert.strictEqual(role('m').role, 'sub', 'the m of the subscript');
    assert.strictEqual(role('m').level, 'below');
    assert.strictEqual(role('pm').role, 'sup', 'the superscript');
    assert.strictEqual(role('pm').level, 'above');
    assert.strictEqual(role('|').role, 'num', 'the numerator');
    assert.strictEqual(role('|').level, 'above');
    assert.strictEqual(role('2').role, 'den', 'the denominator');
    assert.strictEqual(role('2').level, 'below');
    assert.strictEqual(role('U').role, 'base');
});

test('BOTH SCRIPTS OF ONE BASE SHARE ITS ANCHOR, whichever order they are written', () => {
    // `x^{a}_{b}` and `x_{b}^{a}` are one picture written two ways. If the
    // second script anchored to the FIRST script's group instead of to `x`,
    // the two spellings would canonicalise into two different orders and only
    // one of them could match the page.
    for (const src of ['x^{a}_{b}', 'x_{b}^{a}']) {
        const spans = mathSpans(src);
        assert.strictEqual(spans.length, 2, src);
        assert.strictEqual(spans[0].anchor, 0, `${src}: first script hangs off x`);
        assert.strictEqual(spans[1].anchor, 0, `${src}: and so does the second`);
    }
    // …and the canonical order is the same for both.
    const order = (src) => sourceTokens({ lines: [src], startLine: 1, endLine: 1, inMath: true })
        .map(t => t.ch).join('');
    assert.strictEqual(order('x^{a}_{b}'), 'xba', 'subscript first, then superscript');
    assert.strictEqual(order('x_{b}^{a}'), 'xba', 'the other spelling, the same sequence');
});

test('a nested fraction keeps its own numerator and denominator', () => {
    const src = '\\frac{x+\\frac{y}{z}}{w}';
    const idx = roleIndex(src);
    assert.strictEqual(idx.at(src.indexOf('y')).role, 'num', 'the inner numerator');
    assert.strictEqual(idx.at(src.indexOf('z')).role, 'den', 'the inner denominator');
    assert.strictEqual(idx.at(src.indexOf('w')).role, 'den', 'the outer denominator');
    assert.strictEqual(idx.at(src.indexOf('y')).depth, 2, 'and it knows it is nested');
});

test('THE PAGE IS PUT INTO THE SAME ORDER — scripts after their base', () => {
    // MEASURED as `U m ± k` against a source of `U m k ±`: the superscript's x
    // falls between the subscript's glyphs, so left-to-right is not reading
    // order and the alignment dropped whichever side lost the transposition.
    const base = (x, ch) => ({ page: 1, str: ch, x, w: 8, y: 100, h: 10, baseline: 110 });
    const sub = (x, ch) => ({ page: 1, str: ch, x, w: 5, y: 106, h: 7, baseline: 114 });
    const sup = (x, ch) => ({ page: 1, str: ch, x, w: 5, y: 96, h: 7, baseline: 105 });
    const got = renderedGlyphs([
        base(10, 'U'), sub(19, 'm'), sup(20, 'p'), sub(26, 'k'), base(36, '='),
    ]).map(g => g.ch).join('');
    assert.strictEqual(got, 'Umkp=', `subscript, then superscript: got ${got}`);
});

test('…and a fraction numerator-first, which is the other order', () => {
    // The discriminator is alignment, not size: two scripts START together
    // beside their base, a fraction is CENTRED, its halves over each other.
    // The boxes OVERLAP vertically, as a real display's do — that is what makes
    // the numerator, the axis and the denominator one printed line rather than
    // three, and it is the geometry the ordering has to cope with.
    const row = (x, ch) => ({ page: 1, str: ch, x, w: 8, y: 100, h: 10, baseline: 110 });
    const num = (x, ch) => ({ page: 1, str: ch, x, w: 8, y: 92, h: 10, baseline: 102 });
    const den = (x, ch) => ({ page: 1, str: ch, x, w: 8, y: 108, h: 10, baseline: 118 });
    const got = renderedGlyphs([
        row(10, 's'), row(20, '+'),
        num(30, 'a'), num(39, 'b'), den(34, '2'),
        row(52, '+'), row(62, 'k'),
    ]).map(g => g.ch).join('');
    assert.strictEqual(got, 's+ab2+k', `numerator, then denominator: got ${got}`);
});

test('the LEVEL keeps a numerator from pairing with a denominator', () => {
    // \frac{x}{x} prints two identical x's, and character identity cannot tell
    // them apart — measured, both resolved to the SAME source token.
    const src = '\\frac{x+x}{x+x}';
    const row = (x, ch, baseline, y) => ({ page: 1, str: ch, x, w: 8, y, h: 10, baseline });
    const map = buildObjectMap({
        lines: [src], startLine: 1, endLine: 1, inMath: true,
        items: [
            row(10, 'x', 98, 88), row(19, '+', 98, 88), row(28, 'x', 98, 88),
            row(10, 'x', 122, 112), row(19, '+', 122, 112), row(28, 'x', 122, 112),
        ],
    });
    assert.strictEqual(map.tokens.length, 6);
    assert.strictEqual(map.glyphs.length, 6);
    for (let i = 0; i < 6; i++) {
        assert.ok(map.srcToRen[i] >= 0, `token ${i} (${map.tokens[i].ch}) found a glyph`);
    }
    // The numerator's tokens must own the UPPER glyphs, one each.
    const cols = map.tokens.map((t, i) => ({ ch: t.ch, level: t.level, y: map.glyphs[map.srcToRen[i]].y }));
    for (const c of cols) {
        if (c.level === 'above') assert.strictEqual(c.y, 88, `${c.ch}: a numerator token takes an upper glyph`);
        if (c.level === 'below') assert.strictEqual(c.y, 112, `${c.ch}: a denominator token takes a lower glyph`);
    }
    const used = new Set([...map.srcToRen]);
    assert.strictEqual(used.size, 6, 'and no two tokens share one glyph');
});

test('a glyph nothing printed answers with the construct around it', () => {
    // A pmatrix's own parentheses, a stretched delimiter, the dots of \ldots:
    // there is no source token, and the nearest one is a confident wrong jump.
    const src = 'a+\\frac{b}{c}+d';
    const row = (x, ch, baseline, y) => ({ page: 1, str: ch, x, w: 8, y, h: 10, baseline });
    const map = buildObjectMap({
        lines: [src], startLine: 1, endLine: 1, inMath: true,
        items: [
            row(10, 'a', 110, 100), row(19, '+', 110, 100),
            row(30, 'b', 98, 88), row(30, 'c', 122, 112),
            row(42, '+', 110, 100), row(51, 'd', 110, 100),
        ],
    });
    const bi = map.glyphs.findIndex(g => g.ch === 'b');
    const g = groupAround(map, bi);
    assert.ok(g, 'it answers');
    assert.ok(g.startCol >= 0 && g.endCol > g.startCol, 'with a real range');
    assert.ok(src.slice(g.startCol, g.endCol).length <= src.length, 'inside the object');
});

// --- EQUATION (10): FOUR FRACTIONS ON ONE LINE -----------------------------
//
// Reported from the paper: "I click on the first m and it selects the last
// one." The equation is
//
//     u=U+\frac{\ii m}{2}, \qquad \dot u=U-\frac{\ii m}{2},
//     \qquad U=\frac{u+\dot u}{2}, \qquad m=\frac{u-\dot u}{\ii}\in\mathbb Z .
//
// In DISPLAY style `\frac` sets its halves in textstyle — the same size as the
// body — so a line of fractions puts full-size, wide ink on three baselines.
// Each was promoted to a row of its own and ordered separately, and the
// rendered sequence came out as ALL the numerators, then all the bodies, then
// all the denominators, while the source is interleaved per fraction. A
// monotone alignment cannot absorb that: it matched 19 of 35 at confidence
// 0.54, and every repeated letter resolved to the wrong one of its kind.
//
// THE GEOMETRY BELOW IS MEASURED, from the real compile of that equation:
//
//     baseline 118.0  h=10.9  w=254 : i m i m u + ˙ u u − u ˙
//     baseline 125.5  h=10.9  w=323 : u = U + , u ˙ = U − , U = , m = ∈ Z .
//     baseline 132.5  h=10.9  w=239 : 2 2 2 i
//
// The gaps are 7.5 and 7.0 bp while the glyphs are 10.9 tall: the bands
// OVERLAP, and overlapping bands are one printed line. Successive real lines
// TILE. A browser is not needed to check that, so this runs in the gate.
test('FOUR FRACTIONS ON ONE LINE ARE ONE LINE, NOT THREE', () => {
    const glyph = (ch, x, baseline) => ({
        str: ch, page: 1, x, y: baseline - 10.9, w: 5.5, h: 10.9, baseline,
    });
    // The three measured bands, handed over in the order pdf.js reports them.
    const items = [
        // numerators
        ...['i', 'm'].map((c, k) => glyph(c, 180 + k * 6, 118.0)),
        ...['i', 'm'].map((c, k) => glyph(c, 265 + k * 6, 118.0)),
        ...['u', '+', 'u'].map((c, k) => glyph(c, 329 + k * 10, 118.0)),
        ...['u', '-', 'u'].map((c, k) => glyph(c, 408 + k * 10, 118.0)),
        // the body
        ...['u', '=', 'U', '+'].map((c, k) => glyph(c, 136 + k * 11, 125.5)),
        ...[',', 'u', '=', 'U', '-'].map((c, k) => glyph(c, 194 + k * 11, 125.5)),
        ...[',', 'U', '='].map((c, k) => glyph(c, 278 + k * 13, 125.5)),
        ...[',', 'm', '=', '∈', 'Z', '.'].map((c, k) => glyph(c, 356 + k * 18, 125.5)),
        // denominators
        ...['2', '2', '2', 'i'].map((c, k) => glyph(c, 184 + k * 80, 132.5)),
    ];
    const gs = renderedGlyphs(items);
    const order = gs.map(g => g.ch).join('');
    // The numerators must NOT all come first: the first fraction's `2` has to
    // appear before the third fraction's numerator `u`.
    const firstDen = order.indexOf('2');
    const lastNum = order.lastIndexOf('u');
    assert.ok(firstDen >= 0, `the denominators are present: ${order}`);
    assert.ok(firstDen < lastNum,
        `a denominator must come before the last numerator — the bands are one ` +
        `line, not three. Got ${JSON.stringify(order)}`);
    // And every glyph survives the reordering; a dropped glyph cannot be clicked.
    assert.strictEqual(gs.length, items.length,
        `every glyph is kept: ${gs.length} of ${items.length}`);
});

test('two lines a LEADING apart stay two lines', () => {
    // The other side of the same rule: successive printed lines tile, they do
    // not overlap, and merging them would scramble a two-line align.
    const glyph = (ch, x, baseline) => ({
        str: ch, page: 1, x, y: baseline - 10.9, w: 5.5, h: 10.9, baseline,
    });
    const items = [
        ...['a', '=', 'b'].map((c, k) => glyph(c, 140 + k * 12, 118.0)),
        ...['c', '=', 'd'].map((c, k) => glyph(c, 140 + k * 12, 131.6)),   // +13.6
    ];
    const order = renderedGlyphs(items).map(g => g.ch).join('');
    assert.strictEqual(order, 'a=bc=d', `reading order, line by line: ${order}`);
});

console.log('source token <-> rendered glyph alignment\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
