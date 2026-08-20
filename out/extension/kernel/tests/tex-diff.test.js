// Hunks between two versions of a .tex.
//
//   node out/extension/kernel/tests/tex-diff.test.js
//
// The rarity weighting in texDiff.js was justified by a measurement on a REAL
// pair of Overleaf revisions (19 coherent hunks where flat scoring gave 39
// fragments, for the same 61 changed lines). That difference could not be
// reproduced by any synthetic fixture — real text is irregular in ways invented
// text is not — and the corpus is the user's private research, which this
// project does not commit. So these tests assert the PROPERTIES that must hold
// whatever the scorer does, and Experiments/wolfbook-tex/g-diff/measure.mjs
// reproduces the measurement against a real repo on demand.
//
// BE CLEAR ABOUT WHAT THIS SUITE DOES NOT DEFEND: replacing the rarity score
// with a flat one leaves all of these passing, while the measurement jumps from
// 19 hunks to 50 on the real pair. That is deliberate — correctness is testable
// here, quality is only measurable there — but it means "the suite is green" is
// not evidence the scorer is still good. Run measure.mjs after touching it.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String((e && e.message) || e).replace(/\n/g, '\n         ')); }
};

const { diffLines, refineHunk, changedLines, lineKey, rarityScore } = require('../../tex/texDiff');

const show = (h) => h.map(x => `${x.kind}[${x.aStart},${x.aEnd})->[${x.bStart},${x.bEnd})`).join(' ');

test('the four shapes: change, insert, delete, identical', () => {
    assert.strictEqual(show(diffLines(['a', 'b', 'c'], ['a', 'B', 'c'])), 'change[2,3)->[2,3)');
    assert.strictEqual(show(diffLines(['a', 'c'], ['a', 'b', 'c'])), 'add[2,2)->[2,3)');
    assert.strictEqual(show(diffLines(['a', 'b', 'c'], ['a', 'c'])), 'del[2,3)->[2,2)');
    assert.deepStrictEqual(diffLines(['a', 'b'], ['a', 'b']), []);
});

test('AN INSERTION IS AN EMPTY RANGE ON OUR SIDE', () => {
    // This is the shape the caller keys "has no position in the current
    // render" off, so it is load-bearing, not a formatting detail.
    const [h] = diffLines(['a', 'c'], ['a', 'b', 'c']);
    assert.strictEqual(h.aStart, h.aEnd, 'empty on ours');
    assert.ok(h.bEnd > h.bStart, 'non-empty on theirs');
    assert.strictEqual(h.kind, 'add');
});

test('ranges are 1-based and end-exclusive, and address the right lines', () => {
    const A = ['one', 'two', 'three', 'four'];
    const B = ['one', 'TWO', 'THREE', 'four'];
    const [h] = diffLines(A, B);
    assert.deepStrictEqual(A.slice(h.aStart - 1, h.aEnd - 1), ['two', 'three']);
    assert.deepStrictEqual(B.slice(h.bStart - 1, h.bEnd - 1), ['TWO', 'THREE']);
});

test('every changed line is covered exactly once, and no unchanged line is', () => {
    const A = ['a', 'b', 'c', 'd', 'e', 'f'];
    const B = ['a', 'B', 'c', 'd', 'E', 'f'];
    const hunks = diffLines(A, B);
    const covered = [];
    for (const h of hunks) for (let n = h.aStart; n < h.aEnd; n++) covered.push(n);
    assert.deepStrictEqual(covered.sort((x, y) => x - y), [2, 5], `got ${show(hunks)}`);
    assert.strictEqual(new Set(covered).size, covered.length, 'no line covered twice');
});

test('hunks are ordered and never overlap — Accept-all depends on it', () => {
    const A = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const B = A.slice();
    for (const i of [3, 11, 19, 28, 36]) B[i] = `CHANGED ${i}`;
    const hunks = diffLines(A, B);
    let last = 0;
    for (const h of hunks) {
        assert.ok(h.aStart >= last, `hunk at ${h.aStart} overlaps the previous ending ${last}`);
        assert.ok(h.aEnd >= h.aStart);
        last = h.aEnd;
    }
});

test('trailing whitespace is not a change; leading indentation is', () => {
    assert.deepStrictEqual(diffLines(['  x = 1'], ['  x = 1   ']), [],
        'a stripped line ending must not light up the file');
    assert.strictEqual(diffLines(['  x = 1'], ['x = 1']).length, 1,
        'but indentation carries LaTeX structure and IS a change');
    assert.strictEqual(lineKey('a \t '), 'a');
});

test('CRLF and a missing final newline do not turn the file into one hunk', () => {
    // `git show` hands back either, depending on autocrlf and the blob.
    const a = 'one\ntwo\nthree\n';
    assert.deepStrictEqual(diffLines(a, 'one\r\ntwo\r\nthree\r\n'), [],
        'CRLF alone is not a change');
    assert.deepStrictEqual(diffLines(a, 'one\ntwo\nthree'), [],
        'nor is a missing final newline');
});

test('repeated LaTeX boilerplate does not drag a hunk across the document', () => {
    const A = [];
    for (let i = 0; i < 8; i++) A.push('\\begin{equation}', `  E_${i} = ${i}`, '\\end{equation}', '');
    const B = A.slice();
    B[9] = '  E_2 = 99';                       // one line, in the third block
    const hunks = diffLines(A, B);
    assert.strictEqual(hunks.length, 1, `one edit is one hunk, got ${show(hunks)}`);
    assert.strictEqual(hunks[0].aStart, 10);
    assert.strictEqual(hunks[0].aEnd, 11, 'and it does not swallow the \\end{equation}');
});

test('rarity ranks anchors above boilerplate, monotonically', () => {
    assert.ok(rarityScore(1) > rarityScore(3));
    assert.ok(rarityScore(3) > rarityScore(10));
    assert.ok(rarityScore(10) >= rarityScore(500));
    assert.ok(rarityScore(500) > 0, 'a common line is still weak evidence, not none');
});

test('refineHunk finds the WORDS, so one word is not painted as six lines', () => {
    const ours = 'the transfer matrix is sufficient to close\nthe system in every regime';
    const theirs = 'the transfer matrix is adequate to close\nthe system in every regime';
    const r = refineHunk(ours, theirs);
    assert.deepStrictEqual(r.aRanges.map(x => ours.split('\n')[x.line].substr(x.col, x.len)),
        ['sufficient']);
    assert.deepStrictEqual(r.bRanges.map(x => theirs.split('\n')[x.line].substr(x.col, x.len)),
        ['adequate']);
    assert.ok(r.sameWords > 10, 'and it knows most of the words are untouched');
});

test('changedLines names only the lines a word actually changed on', () => {
    const hunk = { aStart: 12, aEnd: 15 };
    const ours = 'alpha beta\ngamma delta\nepsilon zeta';
    const theirs = 'alpha beta\ngamma DELTA\nepsilon zeta';
    assert.deepStrictEqual(changedLines(hunk, ours, theirs), [13],
        'the middle line only — not all three of the hunk');
});

test('a big pair diffs fast enough to run on a keystroke', () => {
    const A = Array.from({ length: 1400 }, (_, i) => `\\text{line ${i}} \\end{equation}`);
    const B = A.slice();
    for (let i = 0; i < 1400; i += 97) B[i] = `CHANGED ${i}`;
    const t0 = Date.now();
    const hunks = diffLines(A, B);
    const ms = Date.now() - t0;
    assert.ok(hunks.length >= 10, `it found the changes: ${hunks.length}`);
    assert.ok(ms < 2000, `1400x1400 took ${ms} ms`);
});

test('nothing here throws on empty, null or lopsided input', () => {
    assert.doesNotThrow(() => diffLines([], []));
    assert.doesNotThrow(() => diffLines(null, null));
    assert.doesNotThrow(() => diffLines(['a'], []));
    assert.doesNotThrow(() => diffLines([], ['a']));
    assert.doesNotThrow(() => refineHunk('', ''));
    assert.doesNotThrow(() => refineHunk(null, undefined));
    assert.deepStrictEqual(diffLines([], []), []);
    assert.strictEqual(diffLines([], ['a']).length, 1, 'an empty file gaining a line is an add');
    assert.strictEqual(diffLines(['a'], []).length, 1, 'and losing one is a del');
});

console.log('source diff: hunks between two versions\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
