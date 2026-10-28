'use strict';

// Outage regression: distant agent edits used to allocate a whole-paper NW
// traceback and stop every MCP window sharing the primary extension host.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const root = process.env.WPAPER_EXT_ROOT || require('node:path').resolve(__dirname, '../../../..');
const { align } = require(root + '/out/extension/tex/glyphAlign');
const { diffLines, refineHunk } = require(root + '/out/extension/tex/texDiff');
const { buildComparison } = require(root + '/out/extension/tex/texCompare');

let seed = 83107;
const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
for (let trial = 0; trial < 100; trial++) {
    const A = Array.from({ length: 50 }, () => String(random(15)));
    const B = A.slice();
    for (let edit = 0; edit < 5; edit++) {
        const at = random(B.length);
        if (edit % 3 === 0) B.splice(at, 0, 'insert');
        else if (edit % 3 === 1) B.splice(at, 1);
        else B[at] = 'replacement';
    }
    const opts = { gap: -1, score: (a, b) => a === b ? 3 : -4, pair: (a, b) => a === b };
    const reference = align(A, B, opts), bounded = align(A, B, { ...opts, maxCells: 2000 });
    assert.equal(bounded.matched, reference.matched, 'bounded snakes preserve exact common subsequences for sparse edits');
    let prev = -1;
    for (let i = 0; i < A.length; i++) {
        const j = bounded.srcToRen[i];
        if (j < 0) continue;
        assert(j > prev); assert.equal(A[i], B[j]); assert.equal(bounded.renToSrc[j], i); prev = j;
    }
}

// Fail on the old implementation before trying outage-sized inputs.
const guard = align(Array(1100).fill('old'), Array(1100).fill('new'));
assert.equal(guard.limited, true, 'oversized alignment must use the bounded path');
assert(guard.work <= 1000001);
assert.equal(guard.matched, 0, 'unrelated text must not acquire false correspondences');

const start = performance.now();
const original = Array.from({ length: 20000 }, (_, i) => `Equation ${i}: its own unchanged source line.`);
const edited = original.slice();
edited[10] = 'Early sentence replacement.';
edited[19980] = 'Late sentence replacement.';
assert.deepEqual(diffLines(original, edited), [
    { aStart: 11, aEnd: 12, bStart: 11, bEnd: 12, kind: 'change' },
    { aStart: 19981, aEnd: 19982, bStart: 19981, bEnd: 19982, kind: 'change' },
]);
const comparison = buildComparison({ ourText: edited.join('\n'), theirText: original.join('\n') });
assert.equal(comparison.summary.total, 2);
assert.equal(comparison.hunks[1].ourRange.startLine, 19981);

// Repeated words have no unique anchors. A bounded Myers snake still preserves
// an unchanged 60,000-token paragraph between the two replacements.
const a = Array(60000).fill('same');
a[5] = 'originalfirst'; a[59994] = 'originallast';
const b = a.slice(); b[5] = 'first'; b[59994] = 'last';
const pairing = align(a, b);
assert.equal(pairing.matched, 59998);
assert.equal(pairing.srcToRen[40000], 40000);
assert.equal(pairing.srcToRen[5], -1);
assert(pairing.work <= 1000001);
const words = refineHunk(a.join(' '), b.join(' '));
assert.equal(words.aRanges.length, 2); assert.equal(words.bRanges.length, 2);
assert.equal(words.sameWords, 59998);

// Insertions/deletions must keep offsets and maps inverse and monotonic.
const inserted = a.slice(); inserted.splice(15, 0, 'inserted'); inserted.splice(59990, 1);
const r = align(a, inserted);
let prev = -1;
for (let i = 0; i < r.srcToRen.length; i++) {
    const j = r.srcToRen[i];
    if (j < 0) continue;
    assert(j > prev); assert.equal(a[i], inserted[j]); assert.equal(r.renToSrc[j], i); prev = j;
}
assert.equal(r.renToSrc[15], -1);

// Broad semi-global PDF regions cannot fall back to misleading glyph precision.
const preview = align(a, b, { freeRenderedEnds: true });
assert.equal(preview.matched, 0);
assert.equal(preview.srcToRen[0], -1);

// Anchor fallback keeps a unique unchanged island in an unrelated rewrite,
// with one TOTAL work cap across local gaps.
const left = Array.from({ length: 5000 }, (_, i) => `old-${i}`);
const right = Array.from({ length: 5000 }, (_, i) => `new-${i}`);
left[2000] = right[2100] = 'unique unchanged anchor';
const rewrite = align(left, right, { maxCells: 5000 });
assert.equal(rewrite.srcToRen[2000], 2100);
assert(rewrite.work <= 5001);

// Replacing every token formerly ran ranges.find once per replacement.
const entire = refineHunk(left.join(' '), right.join(' '));
assert(entire.aRanges.length >= 4999);
const elapsed = performance.now() - start;
assert(elapsed < 5000, `outage-sized comparisons must finish promptly (${elapsed} ms)`);
console.log(`tex-alignment-budget: all assertions passed (${elapsed.toFixed(1)} ms)`);
