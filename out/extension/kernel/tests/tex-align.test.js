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
    keyOf, symbolicFonts,
} = require('../../tex/glyphAlign');
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

console.log('source token <-> rendered glyph alignment\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
