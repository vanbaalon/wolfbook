// The ladder of containers a repeated click walks up.
//
//   node out/extension/kernel/tests/tex-select.test.js
//
// The single property everything else depends on: each step must be STRICTLY
// larger than the one before it. A step that selects the same text twice looks
// exactly like a broken feature from the reader's side.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); }
};

const { scanTex } = require('../../tex/texScanner');
const { buildModel, sectionSpans } = require('../../tex/texModel');
const { selectionLadder, paragraphSpan, sentenceSpans } = require('../../tex/texSelect');
const { wordAtColumn } = require('../../tex/texWords');

const SRC = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Analytic structure}',
    '\\subsection{Gluing}',
    'Here we state it without proof. Imposing the gluing conditions on $\\mathcal{Q}_1$',
    'alone is sufficient to close the system. Much like a generic cusp angle.',
    '',
    '\\begin{equation}\\label{eq:x}',
    '  E = \\frac{a}{b}',
    '\\end{equation}',
    '',
    'A closing remark.',
    '\\end{document}',
].join('\n');

const LINES = SRC.split('\n');
const FILE = '/t/main.tex';
const MODEL = buildModel(scanTex(SRC), { file: FILE });
const SECTIONS = sectionSpans(MODEL.objects, LINES.length, LINES.length);

const ladderAt = (line, col, opts) => {
    const w = wordAtColumn(LINES[line - 1], col, opts);
    return selectionLadder({
        lines: LINES, model: MODEL, sections: SECTIONS, file: FILE,
        line, column: col,
        word: w ? { start: w.sourceStart, end: w.sourceEnd } : null,
    });
};

const size = (s) => {
    let n = 0;
    for (let i = s.start.line; i <= s.end.line; i++) {
        const len = (LINES[i - 1] || '').length;
        const a = i === s.start.line ? s.start.col : 0;
        const b = i === s.end.line ? s.end.col : len;
        n += Math.max(0, b - a) + 1;
    }
    return n;
};

test('a click on prose starts at the word and widens outward', () => {
    const col = LINES[4].indexOf('gluing');
    const kinds = ladderAt(5, col).map(s => s.kind);
    assert.deepStrictEqual(kinds,
        ['word', 'sentence', 'paragraph', 'section', 'section', 'document']);
});

test('every step is strictly larger than the last, and encloses it', () => {
    for (const [line, col, opts] of [
        [5, LINES[4].indexOf('gluing'), undefined],
        [6, 3, undefined],
        [9, LINES[8].indexOf('a}'), { scope: 'math', inMath: true }],
        [12, 3, undefined],
    ]) {
        const L = ladderAt(line, col, opts);
        assert.ok(L.length >= 2, `line ${line} has a ladder`);
        for (let i = 1; i < L.length; i++) {
            const prev = L[i - 1]; const cur = L[i];
            assert.ok(size(cur) > size(prev),
                `line ${line} step ${i} (${cur.kind}) must be bigger than ${prev.kind}`);
            const startsBefore = cur.start.line < prev.start.line ||
                (cur.start.line === prev.start.line && cur.start.col <= prev.start.col);
            const endsAfter = cur.end.line > prev.end.line ||
                (cur.end.line === prev.end.line && cur.end.col >= prev.end.col);
            assert.ok(startsBefore && endsAfter,
                `line ${line} step ${i} (${cur.kind}) must ENCLOSE ${prev.kind}`);
        }
    }
});

test('the first step is exactly the word that was clicked', () => {
    const col = LINES[4].indexOf('gluing');
    const w = ladderAt(5, col)[0];
    assert.strictEqual(w.kind, 'word');
    assert.strictEqual(LINES[4].slice(w.start.col, w.end.col), 'gluing');
    assert.strictEqual(w.start.line, 5);
    assert.strictEqual(w.end.line, 5);
});

test('the sentence is the sentence, not the source line', () => {
    // The clicked sentence starts mid-line 5 and ends mid-line 6, which is
    // exactly the case a line-based selection gets wrong in both directions.
    const s = ladderAt(5, LINES[4].indexOf('gluing'))[1];
    assert.strictEqual(s.kind, 'sentence');
    assert.strictEqual(s.start.line, 5);
    assert.strictEqual(s.end.line, 6);
    const text = LINES[4].slice(s.start.col) + '\n' + LINES[5].slice(0, s.end.col);
    assert.ok(text.startsWith('Imposing'), `starts at the sentence: ${JSON.stringify(text.slice(0, 20))}`);
    assert.ok(text.trimEnd().endsWith('system.'), `ends at the full stop: ${JSON.stringify(text.slice(-12))}`);
});

test('inside an equation a click widens one BRACKET level at a time', () => {
    const col = LINES[8].indexOf('a}');
    const L = ladderAt(9, col, { scope: 'math', inMath: true });
    const txt = (s) => (s.start.line === s.end.line
        ? LINES[s.start.line - 1].slice(s.start.col, s.end.col)
        : `${s.start.line}..${s.end.line}`);
    assert.strictEqual(L[0].kind, 'word');
    assert.strictEqual(txt(L[0]), 'a', 'the glyph itself');
    assert.strictEqual(txt(L[1]), '{a}', 'then its brace group');
    assert.strictEqual(txt(L[2]), '\\frac{a}{b}', 'then the whole \\frac, not just {b}');
    // Only after the brackets run out does the equation as a whole arrive.
    const eq = L.find(s => s.kind === 'display-equation');
    assert.ok(eq, 'the equation is still a step');
    assert.strictEqual(eq.start.line, 8);
    assert.strictEqual(eq.end.line, 10);
    assert.ok(L.indexOf(eq) > 2, 'and it comes after the bracket levels');
    // No "sentence" or "paragraph" inside maths — they would be meaningless.
    assert.ok(!L.some(s => s.kind === 'sentence' || s.kind === 'paragraph'));
});

test('bracket levels nest outward, and stop at the equation', () => {
    const { mathLadder } = require('../../tex/texSelect');
    const t = '  E = \\frac{a}{b} + \\sqrt{1 + \\frac{c}{d}}';
    const steps = mathLadder(t, t.indexOf('{c}') + 1);
    assert.deepStrictEqual(steps.map(g => t.slice(g.from, g.to)), [
        '{c}', '\\frac{c}{d}', '{1 + \\frac{c}{d}}', '\\sqrt{1 + \\frac{c}{d}}',
    ]);
    for (let i = 1; i < steps.length; i++) {
        assert.ok(steps[i].to - steps[i].from > steps[i - 1].to - steps[i - 1].from,
            'each level is strictly wider');
        assert.ok(steps[i].from <= steps[i - 1].from && steps[i].to >= steps[i - 1].to,
            'and encloses the last');
    }
});

test('a command span never trails into whitespace', () => {
    const { mathLadder } = require('../../tex/texSelect');
    const t = '\\frac{a}{b}   + x';
    for (const g of mathLadder(t, t.indexOf('a'))) {
        const text = t.slice(g.from, g.to);
        assert.strictEqual(text, text.trimEnd(), `no trailing space in ${JSON.stringify(text)}`);
    }
});

test('printed delimiters are levels too, not just source braces', () => {
    const { mathLadder } = require('../../tex/texSelect');
    const t = 'f(x + (y - z))';
    const got = mathLadder(t, t.indexOf('y')).map(g => t.slice(g.from, g.to));
    assert.ok(got.includes('(y - z)'), `inner paren: ${JSON.stringify(got)}`);
    assert.ok(got.includes('(x + (y - z))'), `outer paren: ${JSON.stringify(got)}`);
});

test('mathLadder survives unbalanced and pathological input', () => {
    const { mathLadder } = require('../../tex/texSelect');
    for (const t of ['{', '}', '{{{{{', '\\frac{', '', '\\{a\\}', '(((', 'x'.repeat(500)]) {
        for (const off of [0, 1, 3, t.length]) {
            const r = mathLadder(t, off);
            assert.ok(Array.isArray(r));
            for (const g of r) assert.ok(g.to > g.from && g.to <= t.length);
        }
    }
});

test('sections widen innermost first', () => {
    const L = ladderAt(5, 0).filter(s => s.kind === 'section');
    assert.strictEqual(L.length, 2);
    assert.ok(/Gluing/.test(L[0].label), `subsection first: ${L[0].label}`);
    assert.ok(/Analytic/.test(L[1].label), `then section: ${L[1].label}`);
    assert.ok(L[1].lines > L[0].lines);
});

test('the last step is always the whole file', () => {
    for (const line of [5, 6, 9, 12]) {
        const L = ladderAt(line, 2);
        assert.strictEqual(L[L.length - 1].kind, 'document');
        assert.strictEqual(L[L.length - 1].end.line, LINES.length);
    }
});

test('a paragraph stops at a display, not just at \\begin{...}', () => {
    // `\[` is `\begin{equation}` with different spelling. Missing it let a
    // paragraph run through an equation into the prose beyond, so the
    // "sentence" step selected several unrelated lines.
    const src = [
        '\\begin{document}',
        'Prose before the display.',
        '\\[',
        '  x = 1',
        '\\]',
        'Prose after it.',
        '\\end{document}',
    ];
    assert.deepStrictEqual(paragraphSpan(src, 2), { startLine: 2, endLine: 2 });
    assert.deepStrictEqual(paragraphSpan(src, 6), { startLine: 6, endLine: 6 });
    assert.deepStrictEqual(paragraphSpan(src, 4), { startLine: 4, endLine: 4 },
        'and the display body is its own span');
    // $$ too, for papers that still use it.
    const dd = ['Prose.', '$$', 'x=1', '$$', 'More prose.'];
    assert.deepStrictEqual(paragraphSpan(dd, 1), { startLine: 1, endLine: 1 });
    assert.deepStrictEqual(paragraphSpan(dd, 5), { startLine: 5, endLine: 5 });
});

test('a paragraph stops at blank lines and headings', () => {
    assert.deepStrictEqual(paragraphSpan(LINES, 5), { startLine: 5, endLine: 6 });
    assert.deepStrictEqual(paragraphSpan(LINES, 12), { startLine: 12, endLine: 12 });
    assert.strictEqual(paragraphSpan(LINES, 7), null, 'a blank line is not in a paragraph');
});

test('a full stop inside markup does not end a sentence', () => {
    const t = 'See \\cite{smith.2019} and Fig. 3 for the value 3.14 in Sec. 2. Then we continue.';
    const spans = sentenceSpans(t);
    assert.strictEqual(spans.length, 2, `expected 2 sentences, got ${spans.length}`);
    assert.ok(t.slice(spans[0].from, spans[0].to).endsWith('Sec. 2.'),
        `first: ${JSON.stringify(t.slice(spans[0].from, spans[0].to))}`);
});

test('the ladder never throws and always terminates', () => {
    for (const src of ['', '\\', '$', 'x', '\n\n\n', '\\begin{equation}', '%'.repeat(50)]) {
        const lines = src.split('\n');
        for (const line of [0, 1, 2, 99]) {
            const L = selectionLadder({ lines, line, column: 3 });
            assert.ok(Array.isArray(L));
            for (let i = 1; i < L.length; i++) assert.ok(size(L[i]) >= size(L[i - 1]));
        }
    }
    assert.deepStrictEqual(selectionLadder({}), []);
    assert.deepStrictEqual(selectionLadder({ lines: [] }), []);
});

test('a word span that is already the whole line does not duplicate it', () => {
    const lines = ['word'];
    const L = selectionLadder({ lines, line: 1, column: 0, word: { start: 0, end: 4 } });
    const seen = new Set(L.map(s => `${s.start.line}:${s.start.col}-${s.end.line}:${s.end.col}`));
    assert.strictEqual(seen.size, L.length, 'no two steps select the same text');
});

console.log('the selection ladder (click again to widen)\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
