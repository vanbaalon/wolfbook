// texDiff.js — what changed between two versions of a .tex, as hunks.
//
// Pure: no vscode, no fs, never throws.
//
// WHY THE MATCH SCORE IS WEIGHTED BY LINE RARITY.
//
// A real paper is full of lines that are byte-identical and carry no
// information: `\end{equation}`, `\]`, `}`, `&`, `\\`, blank. An alignment
// that treats every equal line as equally good evidence has no reason to prefer
// the correspondence a reader would recognise, and fragments one edit into
// several. Weighting a match by how RARE the line is — a line appearing once or
// twice is a strong anchor, one appearing eighty times is nearly none — is the
// patience-diff insight expressed as a score, which lets it reuse the
// bounded aligner in glyphAlign.js. Small gaps retain the weighted
// Needleman-Wunsch score; full-paper comparisons use exact snakes and anchors.
//
// MEASURED, on a real pair of Overleaf revisions of a colleague's 793-line
// paper (`Clean Notes/Clean.tex`, 7821deb..a9db8bb):
//
//     rarity-weighted   19 hunks   61 of our lines, 133 of theirs   4 ms
//     flat (all matches equal)   39 unmatched runs, 59 of our lines
//     git --unified=0            44 hunks, -60 +132
//
// Same lines identified either way — the line counts agree with git to within
// one — but flat scoring breaks them into twice as many pieces. For a list the
// reader works through, and regions painted on a page, coherent hunks are the
// product. Note the honest limit: this difference only appears on real,
// irregular text. Every synthetic fixture tried (repeated equation blocks,
// inserted boilerplate, interleaved edits) scored identically under both, so
// the tests below assert the PROPERTIES that must always hold, and the
// measurement above is reproduced by Experiments/wolfbook-tex/g-diff/measure.mjs
// rather than by a committed fixture.

const { align } = require('./glyphAlign');
const { contentTokens, contentKey } = require('./reviewContent');

/** Line-ending normalisation for COMPARISON only — never for offsets. */
function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
}

/**
 * The comparison key for a line.
 *
 * Trailing whitespace is not a change anybody means, and an editor that strips
 * it would otherwise light up the whole file. Leading indentation IS kept: in
 * LaTeX it is often the only thing distinguishing nested structure.
 */
const lineKey = (s) => String(s == null ? '' : s).replace(/[ \t]+$/, '');

/**
 * How much a pairing of two identical lines is worth.
 *
 * Rarity, capped: unique lines are strong anchors, common ones barely count.
 * The numbers matter less than the ORDER — what has to hold is that a rare
 * match outweighs several common ones, so the alignment prefers the path
 * through the real correspondence.
 */
function rarityScore(count) {
    if (count <= 2) return 8;
    if (count <= 4) return 5;
    if (count <= 8) return 3;
    if (count <= 20) return 2;
    return 1;
}

/**
 * Hunks between two texts, as LINE ranges.
 *
 * Ranges are 1-based and END-EXCLUSIVE, so an insertion is an empty range on
 * the side it is missing from — `aStart === aEnd` — which is exactly the
 * "this has no position in the current document" case the caller has to draw
 * differently.
 *
 * @param {string[]} aLines  "ours" — the current document
 * @param {string[]} bLines  "theirs"
 * @returns {{aStart:number,aEnd:number,bStart:number,bEnd:number,
 *            kind:'add'|'del'|'change'}[]}
 */
function diffLines(aLines, bLines, opts = {}) {
    let A = Array.isArray(aLines) ? aLines : splitLines(aLines);
    let B = Array.isArray(bLines) ? bLines : splitLines(bLines);
    // A MISSING FINAL NEWLINE IS NOT A CHANGE ANYBODY MEANS. Splitting
    // "a\nb\n" yields a trailing "" that "a\nb" does not, so the two would
    // differ by a phantom deleted line — and `git show` hands back either form
    // depending on the blob. git itself reports this as an annotation rather
    // than a hunk; so does this. The cost, stated plainly: a file that really
    // did gain or lose a trailing blank line will not report it.
    if (A.length && A[A.length - 1] === '') A = A.slice(0, -1);
    if (B.length && B[B.length - 1] === '') B = B.slice(0, -1);
    const compareKey = typeof opts.lineKey === 'function' ? opts.lineKey : lineKey;
    const aKeys = A.map(compareKey);
    const bKeys = B.map(compareKey);

    // How common is each line across BOTH sides? Counting both is what makes a
    // line that is unique in one file but boilerplate in the other score low.
    const counts = new Map();
    for (const k of aKeys) counts.set(k, (counts.get(k) || 0) + 1);
    for (const k of bKeys) counts.set(k, (counts.get(k) || 0) + 1);

    const MISMATCH = -4;      // never pair two different lines
    // ONLY THE MIDDLE IS ALIGNED. Lines the two sides share at the start and
    // at the end pair one to one (as git's diff takes them); the alignment is
    // weighted alignment usually sees only a few lines. Distant edits can
    // leave almost the whole paper in this middle; align's work limit and
    // linear snakes handle that case without a paper-sized traceback.
    let head = 0;
    while (head < aKeys.length && head < bKeys.length && aKeys[head] === bKeys[head]) head++;
    let tail = 0;
    while (tail < aKeys.length - head && tail < bKeys.length - head &&
        aKeys[aKeys.length - 1 - tail] === bKeys[bKeys.length - 1 - tail]) tail++;
    const middle = align(aKeys.slice(head, aKeys.length - tail), bKeys.slice(head, bKeys.length - tail), {
        gap: opts.gap ?? -1,
        // A gap is cheap relative to a rare match, so the alignment will happily
        // skip a run of common lines to reach a unique anchor.
        score: (a, b) => (a === b ? rarityScore(counts.get(a) || 1) : MISMATCH),
        // Only identical lines correspond. Unlike the glyph case there is no
        // "near enough" — a changed line is a hunk, not a fuzzy pairing.
        pair: (a, b) => a === b,
    });
    const srcToRen = new Array(aKeys.length);
    for (let i = 0; i < head; i++) srcToRen[i] = i;
    for (let i = 0; i < middle.srcToRen.length; i++) {
        const to = middle.srcToRen[i];
        srcToRen[head + i] = to >= 0 ? head + to : -1;
    }
    for (let i = 0; i < tail; i++) srcToRen[aKeys.length - tail + i] = bKeys.length - tail + i;

    // Walk the pairing into runs of unmatched lines on either side.
    const hunks = [];
    let ai = 0; let bi = 0;
    const flush = (aStart, aEnd, bStart, bEnd) => {
        if (aEnd === aStart && bEnd === bStart) return;
        hunks.push({
            aStart: aStart + 1, aEnd: aEnd + 1,
            bStart: bStart + 1, bEnd: bEnd + 1,
            kind: aEnd === aStart ? 'add' : (bEnd === bStart ? 'del' : 'change'),
        });
    };
    while (ai < A.length) {
        const to = srcToRen[ai];
        if (to >= 0) {
            // Everything of theirs skipped before this anchor is an insertion.
            if (to > bi) flush(ai, ai, bi, to);
            ai++; bi = to + 1;
            continue;
        }
        // A run of ours with no counterpart; take theirs up to the next anchor.
        const aFrom = ai;
        while (ai < A.length && srcToRen[ai] < 0) ai++;
        const bTo = ai < A.length ? srcToRen[ai] : B.length;
        flush(aFrom, ai, bi, Math.max(bi, bTo));
        bi = Math.max(bi, bTo);
    }
    if (bi < B.length) flush(A.length, A.length, bi, B.length);
    return hunks;
}

/**
 * Which WORDS differ inside a changed hunk.
 *
 * This is not a nicety. Change one word in a rewrapped six-line paragraph and a
 * line-level hunk covers all six lines; painting six rows on the page says "this
 * paragraph was rewritten", which is a lie. The word ranges are what decide
 * which lines are worth marking at all.
 *
 * @returns {{aRanges:{line:number,col:number,len:number}[], bRanges:[...],
 *            sameWords:number, totalWords:number}}
 *   `line` is relative to the hunk (0-based), `col` a column in that line.
 */
function refineHunk(aText, bText, opts = {}) {
    const a = contentTokens(aText,{math:opts.aMath,literal:opts.aLiteral,literalSpaces:opts.aLiteralSpaces}),
        b = contentTokens(bText,{math:opts.bMath,literal:opts.bLiteral,literalSpaces:opts.bLiteralSpaces});
    if (contentKey(a) === contentKey(b)) return { aRanges:[],bRanges:[],sameWords:0,totalWords:0 };
    const at = a.filter(t=>!t.space), bt = b.filter(t=>!t.space);
    if (!at.length && !bt.length) return { aRanges: [], bRanges: [], sameWords: 0, totalWords: 0 };

    const counts = new Map();
    for (const t of at) counts.set(t.key, (counts.get(t.key) || 0) + 1);
    for (const t of bt) counts.set(t.key, (counts.get(t.key) || 0) + 1);

    const { srcToRen, renToSrc } = align(at.map(t => t.key), bt.map(t => t.key), {
        gap: -1,
        score: (a, b) => (a === b ? rarityScore(counts.get(a) || 1) : -4),
        pair: (a, b) => a === b,
    });
    const aRanges = [];
    const bRanges = [];
    const aRangeByToken = new Map(), bRangeByToken = new Map();
    const rangesOf = t => {
        return (t.parts || [t]).flatMap(part => part.word.split('\n')
            .map((s,i)=>({line:part.line+i,col:i?0:part.col,len:s.length}))).filter(r=>r.len>0);
    };
    let same = 0;
    for (let i = 0; i < at.length; i++) {
        if (srcToRen[i] >= 0) { same++; continue; }
        const ranges=rangesOf(at[i]);
        aRanges.push(...ranges); if (ranges.length===1) aRangeByToken.set(at[i],ranges[0]);
    }
    for (let j = 0; j < bt.length; j++) {
        if (renToSrc[j] >= 0) continue;
        const ranges=rangesOf(bt[j]);
        bRanges.push(...ranges); if (ranges.length===1) bRangeByToken.set(bt[j],ranges[0]);
    }
    // Inside a replacement, keep common characters neutral too. TeX often
    // puts a whole equation in one whitespace token; changing one subscript
    // or number should underline that part rather than the entire command.
    let ai = 0, bi = 0;
    for (let i = 0; i <= at.length; i++) {
        if (i < at.length && srcToRen[i] < 0) continue;
        const j = i < at.length ? srcToRen[i] : bt.length;
        const left = at.slice(ai, i), right = bt.slice(bi, j);
        if (left.length === right.length) for (let k = 0; k < left.length; k++) {
            const a = left[k], b = right[k];
            if (a.parts || b.parts || a.word.includes('\n') || b.word.includes('\n')) continue;
            let prefix = 0, suffix = 0;
            while (prefix < Math.min(a.len, b.len) && a.word[prefix] === b.word[prefix]) prefix++;
            while (suffix < Math.min(a.len, b.len) - prefix && a.word[a.len - 1 - suffix] === b.word[b.len - 1 - suffix]) suffix++;
            if (prefix > 0 && /[\uD800-\uDBFF]/.test(a.word[prefix - 1])) prefix--;
            if (suffix > 0 && /[\uDC00-\uDFFF]/.test(a.word[a.len - suffix])) suffix--;
            if (prefix + suffix >= Math.min(a.len, b.len)) continue;
            for (const [ranges, token] of [[aRangeByToken,a], [bRangeByToken,b]]) {
                const r = ranges.get(token);
                if (r) { r.col += prefix; r.len -= prefix + suffix; }
            }
        }
        ai = i + 1; bi = j + 1;
    }
    return { aRanges, bRanges, sameWords: same, totalWords: Math.max(at.length, bt.length) };
}

/** The lines of a hunk that actually contain a changed word. */
function changedLines(hunk, aText, bText) {
    const { aRanges } = refineHunk(aText, bText);
    if (!aRanges.length) return [];
    const lines = new Set();
    for (const r of aRanges) lines.add(hunk.aStart + r.line);
    return [...lines].sort((a, b) => a - b);
}

module.exports = { diffLines, refineHunk, changedLines, splitLines, lineKey, rarityScore };
