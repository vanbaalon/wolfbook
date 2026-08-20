// Word-level source<->render mapping, and the typeset-row model for prose.
//
//   node out/extension/kernel/tests/tex-words.test.js
//
// SyncTeX carries a LINE and no column, so prose was only ever locatable to
// the line — and a real paper's "line" can be 250 characters that wrap into
// three typeset rows. These are the two pieces that close that gap.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
};

const {
    visibleProjection, visibleWords, findWordInLine, wordAtColumn,
    collectMacros, mathRegions, isInMath, OPAQUE,
} = require('../../tex/texWords');

// The real line from draft.tex that exposed the problem.
const LINE = 'Here we state it without proof; the full derivation is presented in the ' +
    'next appendix. Imposing the gluing conditions on $\\mathcal{Q}_1$ and $\\mathcal{Q}_2$ ' +
    'alone is sufficient to close the system, much like in the case of a generic cusp angle.';

test('the visible projection keeps prose and hides markup', () => {
    const { text } = visibleProjection(LINE);
    assert.ok(text.startsWith('Here we state it without proof;'));
    assert.ok(!text.includes('mathcal'), 'the command name is not visible text');
    assert.ok(!text.includes('$'), 'math delimiters are gone');
    // The Q of $\mathcal{Q}_1$ IS printed, so it IS in the projection —
    // tagged as maths, so prose matching skips it.
    const { math } = visibleProjection(LINE);
    const qi = text.indexOf('Q');
    assert.ok(qi >= 0 && math[qi], 'the maths glyph is present and tagged');
    assert.strictEqual(visibleWords(LINE).some(w => w.inMath), false,
        'but prose words never include maths');
});

// ---------------------------------------------------------------- maths ----
// \frac{a}{b} prints `a` and `b`. Treating an equation as one opaque unit
// meant a click on the numerator could only ever select the whole equation.

const EQ = '  E = \\frac{a}{b} + \\mathcal{Q}_1 \\qquad \\alpha \\label{eq:x}';
const MOPT = { scope: 'math', inMath: true };

test('a display equation is addressable glyph by glyph', () => {
    const gs = visibleWords(EQ, MOPT);
    // Operators are glyphs too: = and + are typeset marks a reader can click,
    // and excluding them sent every operator click to the nearest letter.
    assert.deepStrictEqual(gs.map(g => g.word), ['E', '=', 'a', 'b', '+', 'Q', '1', 'α']);
    for (const g of gs) {
        const src = EQ.slice(g.sourceStart, g.sourceEnd);
        // A literal glyph is its own source; a named symbol's source is the
        // COMMAND that prints it, which is the thing a writer would edit.
        assert.ok(src === g.word || /^\\[A-Za-z@]+$/.test(src),
            `${JSON.stringify(g.word)} came from ${JSON.stringify(src)}`);
    }
    const alpha = gs.find(g => g.word === 'α');
    assert.strictEqual(EQ.slice(alpha.sourceStart, alpha.sourceEnd), '\\alpha',
        'no trailing space in the span');
});

test('clicking the numerator of \\frac{a}{b} lands inside the first brace', () => {
    const a = findWordInLine(EQ, 'a', 0.2, MOPT);
    assert.strictEqual(EQ.slice(a.start, a.end), 'a');
    assert.strictEqual(EQ[a.start - 1], '{', 'it is the brace-enclosed numerator');
    const b = findWordInLine(EQ, 'b', 0.3, MOPT);
    assert.ok(b.start > a.start, 'the denominator is further along');
    assert.strictEqual(EQ[b.start - 1], '{');
});

test('the environment name never leaks in as glyphs', () => {
    const src = '\\begin{equation} x = 1 \\end{equation}';
    const words = visibleWords(src, { scope: 'math', inMath: true }).map(w => w.word);
    assert.deepStrictEqual(words, ['x', '=', '1'], `got ${JSON.stringify(words)}`);
});

test('a Greek letter is left opaque rather than guessed at', () => {
    // We cannot predict what glyph \alpha prints, so it must never be offered
    // as a match — a wrong guess sends the cursor to the wrong place silently.
    assert.ok(!visibleWords(EQ, MOPT).some(g => /alpha/i.test(g.word)));
    assert.strictEqual(findWordInLine(EQ, 'alpha', 0.9, MOPT), null);
});

test('the maths round trip is stable too', () => {
    for (const g of visibleWords(EQ, MOPT)) {
        const fwd = wordAtColumn(EQ, g.sourceStart, MOPT);
        assert.strictEqual(fwd.word, g.word);
        const back = findWordInLine(EQ, fwd.word, fwd.hint, MOPT);
        assert.strictEqual(back.start, g.sourceStart, `round trip for ${g.word}`);
    }
});

test('prose and maths scopes do not bleed into each other', () => {
    const mixed = 'The value $a$ differs from a plain a in text.';
    const prose = findWordInLine(mixed, 'a', 0.9);
    const math = findWordInLine(mixed, 'a', 0.2, { scope: 'math' });
    assert.notStrictEqual(prose.start, math.start);
    assert.strictEqual(mixed[math.start - 1], '$', 'the maths hit is the one in $…$');
});

test('every visible character maps back to a real source offset', () => {
    const { text, map } = visibleProjection(LINE);
    assert.strictEqual(text.length, map.length);
    for (let i = 0; i < text.length; i++) {
        if (text[i] === OPAQUE) continue;
        assert.strictEqual(LINE[map[i]], text[i], `char ${i} maps to the wrong offset`);
    }
});

test('a word seen in the PDF resolves to its exact source columns', () => {
    const w = findWordInLine(LINE, 'gluing', 0.45);
    assert.ok(w, 'found');
    assert.strictEqual(LINE.slice(w.start, w.end), 'gluing');
    assert.strictEqual(w.exact, true);
});

test('a repeated word is disambiguated by WHERE on the line it was clicked', () => {
    // "the" occurs five times here; a click near the start and one near the
    // end must not resolve to the same column.
    const all = visibleWords(LINE).filter(w => w.word.toLowerCase() === 'the');
    assert.ok(all.length >= 4, `expected several "the", got ${all.length}`);
    const first = findWordInLine(LINE, 'the', 0.02);
    const last = findWordInLine(LINE, 'the', 0.98);
    assert.notStrictEqual(first.start, last.start);
    assert.ok(first.start < last.start);
    assert.strictEqual(LINE.slice(first.start, first.end).toLowerCase(), 'the');
    assert.strictEqual(LINE.slice(last.start, last.end).toLowerCase(), 'the');
});

test('the cursor column resolves to the word the reader will see', () => {
    const col = LINE.indexOf('gluing');
    const w = wordAtColumn(LINE, col);
    assert.strictEqual(w.word, 'gluing');
    assert.strictEqual(w.sourceStart, col);
    assert.ok(w.hint > 0 && w.hint < 1, 'carries a position hint for the viewer');
});

test('a cursor inside math does not claim a maths word', () => {
    // Math renders as glyphs we cannot predict, so the nearest PROSE word is
    // the honest answer; inventing "mathcal" would send the viewer nowhere.
    const w = wordAtColumn(LINE, LINE.indexOf('mathcal'));
    assert.ok(w, 'still answers');
    assert.ok(!/mathcal|Q/.test(w.word), `must not claim markup: ${w.word}`);
});

test('the round trip is stable: column -> word -> column', () => {
    for (const probe of ['derivation', 'appendix', 'sufficient', 'angle', 'Imposing']) {
        const col = LINE.indexOf(probe);
        const fwd = wordAtColumn(LINE, col);
        assert.strictEqual(fwd.word, probe, `forward for ${probe}`);
        const back = findWordInLine(LINE, fwd.word, fwd.hint);
        assert.strictEqual(back.start, col, `round trip for ${probe}`);
    }
});

test('an unmatched word is refused rather than guessed at', () => {
    assert.strictEqual(findWordInLine(LINE, 'zzzznotpresent', 0.5), null);
    assert.strictEqual(findWordInLine(LINE, '', 0.5), null);
});

test('\\text{...} arguments ARE visible; \\label{...} is not', () => {
    const src = 'Before \\text{inside here} after \\label{sec:x} end.';
    const { text } = visibleProjection(src);
    assert.ok(text.includes('inside here'), 'text argument is typeset');
    assert.ok(!text.includes('sec:x'), 'a label prints nothing');
    const w = findWordInLine(src, 'inside', 0.3);
    assert.strictEqual(src.slice(w.start, w.end), 'inside');
});

test('a comment is not part of the visible line', () => {
    const src = 'Real words here. % this is a note about zebras';
    assert.ok(!visibleProjection(src).text.includes('zebras'));
    assert.strictEqual(findWordInLine(src, 'zebras', 0.9), null);
});

test('an escaped percent stays visible', () => {
    const { text } = visibleProjection('Fully 50\\% of cases.');
    assert.ok(text.includes('%'), `got ${JSON.stringify(text)}`);
    assert.ok(text.includes('cases'), 'and the text after it is not swallowed');
});

test('the projection never throws, on anything', () => {
    for (const bad of ['', '\\', '$', '${', '\\text{', '{'.repeat(200), '%', '$$$$',
        '\\text{\\text{\\text{deep}}}']) {
        const r = visibleProjection(bad);
        assert.strictEqual(typeof r.text, 'string');
        assert.strictEqual(r.text.length, r.map.length);
        assert.ok(Array.isArray(visibleWords(bad)));
        assert.doesNotThrow(() => wordAtColumn(bad, 3));
        assert.doesNotThrow(() => findWordInLine(bad, 'x', 0.5));
    }
});

test('wordAtColumn declines when the cursor is nowhere near prose', () => {
    assert.strictEqual(wordAtColumn('$x=1$', 2), null, 'a pure-math line has no word');
    assert.strictEqual(wordAtColumn('', 0), null);
});


// ------------------------------------------------------- user macros -------
// A real paper's maths is almost entirely user macros. Without expanding them
// the projection of an equation is nearly empty, every click misses, and the
// selection falls back to the whole equation — which is what actually happened
// on J2SoVWavefunctionsAndCharges.tex.

const PREAMBLE = [
    '\\newcommand{\\SoV}{\\mathrm{SoV}}',
    '\\newcommand{\\bx}{\\boldsymbol{x}}',
    '\\newcommand{\\bdx}{\\dot{\\boldsymbol{x}}}',
    '\\newcommand{\\ket}[1]{\\left| #1 \\right\\rangle}',
    '\\def\\zz{Z}',
    '\\DeclareMathOperator{\\Tr}{Tr}',
].join('\n');
const MACROS = collectMacros(PREAMBLE);
const MM = { scope: 'math', inMath: true, macros: MACROS };
const PSI_LINE = '  \\Psi_{\\SoV}(\\bx,\\bdx)';

test('macro definitions are read out of the source', () => {
    assert.strictEqual(MACROS.size, 6, [...MACROS.keys()].join(','));
    assert.deepStrictEqual(MACROS.get('bx'), { params: 0, body: '\\boldsymbol{x}' });
    assert.strictEqual(MACROS.get('ket').params, 1);
    assert.strictEqual(MACROS.get('Tr').body, 'Tr');
    assert.strictEqual(MACROS.get('zz').body, 'Z');
});

test('a macro projects to what it PRINTS, and selects the CALL', () => {
    const got = visibleWords(PSI_LINE, MM);
    // \bdx is \dot{\boldsymbol{x}}, which prints TWO marks: the x and the dot
    // above it, in that order — which is the order pdf.js reports them in.
    assert.deepStrictEqual(got.map(g => g.word), ['Ψ', 'S', 'o', 'V', '(', 'x', 'x', '˙', ')']);
    // Each expanded glyph selects the whole macro call, not one character of
    // it — `\bx` is the thing a writer would edit.
    const xs = got.filter(g => g.word === 'x');
    assert.strictEqual(PSI_LINE.slice(xs[0].sourceStart, xs[0].sourceEnd), '\\bx');
    assert.strictEqual(PSI_LINE.slice(xs[1].sourceStart, xs[1].sourceEnd), '\\bdx');
    assert.strictEqual(PSI_LINE.slice(got[0].sourceStart, got[0].sourceEnd), '\\Psi');
});

test('without the macro table the same line projects to almost nothing', () => {
    // The regression this whole mechanism exists to prevent.
    const blind = visibleWords(PSI_LINE, { scope: 'math', inMath: true });
    // Ψ and the parens are directly printable; every macro-hidden letter is not.
    assert.deepStrictEqual(blind.map(g => g.word), ['Ψ', '(', ')'],
        `expected only the directly-printable marks, got ${JSON.stringify(blind.map(g => g.word))}`);
    assert.ok(visibleWords(PSI_LINE, MM).length >= 5, 'and a full one with macros');
});

test('the two x-like macros are told apart by where they sit', () => {
    const first = findWordInLine(PSI_LINE, 'x', 0.05, MM);
    const last = findWordInLine(PSI_LINE, 'x', 0.99, MM);
    assert.strictEqual(PSI_LINE.slice(first.start, first.end), '\\bx');
    assert.strictEqual(PSI_LINE.slice(last.start, last.end), '\\bdx');
});

test('a macro with an argument substitutes it', () => {
    const got = visibleWords('\\ket{\\psi}', MM).map(g => g.word);
    assert.ok(got.includes('ψ'), `the argument is printed: ${JSON.stringify(got)}`);
});

test('a self-referential macro cannot spin', () => {
    const m = collectMacros('\\newcommand{\\loop}{\\loop x}');
    assert.strictEqual(m.has('loop'), false, 'it is dropped rather than expanded');
    // And if one slips past that, the depth cap still holds.
    const forced = new Map([['a', { params: 0, body: '\\b' }], ['b', { params: 0, body: '\\a z' }]]);
    assert.doesNotThrow(() => visibleProjection('\\a', { inMath: true, macros: forced }));
});

test('upper and lower case Greek are NOT the same symbol', () => {
    // Folding case is right for prose and wrong for symbols: a physicist means
    // different things by Psi and psi, and folding let a click on one select
    // the other.
    const line = '  \\Psi_{\\SoV}(\\bx)';
    assert.ok(findWordInLine(line, 'Ψ', 0.2, MM), 'the capital matches');
    assert.strictEqual(findWordInLine(line, 'ψ', 0.2, MM), null,
        'and the lower case does not, because it is not on this line');
    // Prose is still case-insensitive.
    assert.ok(findWordInLine('The thing and the other', 'THE', 0.1));
});

test('inline maths on a line is located', () => {
    const line = 'test is being done can we do it faster where are you $E=mc^2$ ok';
    assert.strictEqual(isInMath(line, line.indexOf('mc')), true, 'inside $…$');
    assert.strictEqual(isInMath(line, line.indexOf('faster')), false, 'in prose');
    const rs = mathRegions(line);
    assert.strictEqual(rs.length, 1);
    assert.strictEqual(line.slice(rs[0].from, rs[0].to), '$E=mc^2$');
});

test('mathRegions handles \\( \\) and declines on junk', () => {
    assert.strictEqual(mathRegions('a \\(x+y\\) b').length, 1);
    assert.deepStrictEqual(mathRegions('no maths here'), []);
    assert.doesNotThrow(() => mathRegions('$unclosed'));
    assert.doesNotThrow(() => isInMath(null, 3));
});

// ------------------------------------------------- operators & symbols ----
// The old letters-and-digits glyph class excluded EVERY operator (≤ ↑ ∫ = + −
// are all category Sm), so clicking one resolved to the nearest letter. The
// reference paper uses \uparrow/\downarrow 108 times as spin labels.
test('operators and arrows are addressable glyphs that select their command', () => {
    const src = '\\alpha_{\\uparrow} \\leq \\beta_{\\downarrow}';
    const up = findWordInLine(src, '↑', 0.2, { scope: 'math', inMath: true });
    assert.ok(up && up.exact, 'the arrow matched exactly');
    assert.strictEqual(src.slice(up.start, up.end), '\\uparrow');
    const le = findWordInLine(src, '≤', 0.5, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(le.start, le.end), '\\leq');
    const down = findWordInLine(src, '↓', 0.9, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(down.start, down.end), '\\downarrow');
});

test('an operator NAME (\\cos) typesets its letters, each selecting the call', () => {
    const src = '\\cos\\theta + \\log x';
    const c = findWordInLine(src, 'c', 0.05, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(c.start, c.end), '\\cos');
    const g = findWordInLine(src, 'g', 0.8, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(g.start, g.end), '\\log');
});

test('the PDF\'s unicode variants fold onto the source spelling', () => {
    // minus sign U+2212 vs '-', prime U+2032 vs "'", 𝒬/ℚ vs Q
    const m = findWordInLine('a - b', '−', 0.5, { scope: 'math', inMath: true });
    assert.ok(m && m.exact, 'U+2212 matches the source hyphen-minus');
    assert.strictEqual('a - b'.slice(m.start, m.end), '-');
    const q = findWordInLine('\\mathcal{Q}_1', '\u{1D4AC}', 0.3, { scope: 'math', inMath: true });
    assert.ok(q && q.exact, 'script Q matches the plain Q the projection produced');
    // And folding must NOT erase the Greek case distinction.
    const psi = findWordInLine('\\Psi + \\psi', 'Ψ', 0.9, { scope: 'math', inMath: true });
    assert.strictEqual('\\Psi + \\psi'.slice(psi.start, psi.end), '\\Psi');
});

test('\\sqrt prints the radical AND keeps its argument addressable', () => {
    const src = '\\sqrt{x+1}';
    const r = findWordInLine(src, '√', 0.1, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(r.start, r.end), '\\sqrt');
    const x = findWordInLine(src, 'x', 0.5, { scope: 'math', inMath: true });
    assert.strictEqual(x.start, src.indexOf('x'), 'the argument is still reachable');
});

test('an occurrence index picks among repeats exactly, beating the fraction hint', () => {
    const src = 'a + \\frac{a}{2} + a';
    // The fraction hint alone would struggle here; the count cannot.
    const third = findWordInLine(src, 'a', 0.0, { scope: 'math', inMath: true, occurrence: 3 });
    assert.strictEqual(third.start, src.lastIndexOf('a'));
    const first = findWordInLine(src, 'a', 0.99, { scope: 'math', inMath: true, occurrence: 1 });
    assert.strictEqual(first.start, 0, 'occurrence 1 wins even against a far hint');
    // Out-of-range occurrence falls back to the hint rather than failing.
    const fb = findWordInLine(src, 'a', 0.0, { scope: 'math', inMath: true, occurrence: 9 });
    assert.ok(fb, 'still answers');
});

test('a cursor at a token boundary belongs to the token that STARTS there', () => {
    const src = '(\\bx)';
    const macros = collectMacros('\\newcommand{\\bx}{\\boldsymbol{x}}');
    const w = wordAtColumn(src, 1, { scope: 'math', inMath: true, macros });
    assert.strictEqual(w.word, 'x', `the macro's glyph, not the paren — got ${JSON.stringify(w.word)}`);
});

test('an accent prints its own mark, AFTER its argument, and selects the command', () => {
    // Measured from the PDF text layer: for \dot x the base sits at x=267.6 and
    // the dot at x=269.5, so in reading order the letter comes first. Emitting
    // them the other way round left both unmatched. \dot alone appears 133
    // times in the reference paper.
    const src = '\\dot x_1 + \\widehat{Q}';
    const gs = visibleWords(src, { scope: 'math', inMath: true });
    assert.deepStrictEqual(gs.map(g => g.word), ['x', '˙', '1', '+', 'Q', 'ˆ']);
    const dot = findWordInLine(src, '˙', 0.1, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(dot.start, dot.end), '\\dot', 'the mark selects the command');
    const x = findWordInLine(src, 'x', 0.1, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(x.start, x.end), 'x', 'and the base still selects the base');
    const hat = findWordInLine(src, 'ˆ', 0.9, { scope: 'math', inMath: true });
    assert.strictEqual(src.slice(hat.start, hat.end), '\\widehat');
});

console.log('word-level source <-> render mapping\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
