// Placing a hunk on the rendered pages.
//
//   node out/extension/kernel/tests/tex-compare.test.js
//
// The diff itself is tex-diff.test.js. What this defends is the harder half:
// SAYING WHERE A CHANGE IS, honestly, when most of the time there is no exact
// answer. Measured on the reference paper, 71% of display-equation source lines
// carry no SyncTeX record at all, and an insertion has no position in the
// current render by construction. A feature that silently dropped those would
// show three marks, be believed, and hide the fourth change.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => {
    try { fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + String((e && e.message) || e).replace(/\n/g, '\n         ')); }
};

const { buildComparison, placeHunk, describeSummary, WHERE } = require('../../tex/texCompare');
const { diffLines, splitLines } = require('../../tex/texDiff');

/** A render map where lines 1-6 printed and 7-9 (an equation) did not. */
const makeMap = (over = {}) => ({
    rowsFor: (n) => ((n >= 1 && n <= 6) ? [{ page: 1, x: 100, y: 100 * n, w: 300, h: 12 }] : []),
    objectAtLine: (n) => ((n >= 7 && n <= 9)
        ? { kind: 'display-equation', label: 'eq:x', stableKey: 's/eq/1', startLine: 7, endLine: 9 }
        : null),
    objectRects: () => [{ page: 1, x: 90, y: 700, w: 320, h: 40 }],
    locate: () => ({ page: 1, exact: true, matchedLine: 1 }),
    ...over,
});

const OURS = ['a', 'b', 'c', 'd', 'e', 'f', '\\begin{equation}', '  E=1', '\\end{equation}'].join('\n');

test('a change on lines that printed is placed EXACTLY', () => {
    const theirs = OURS.replace('\nb\n', '\nB\n');
    const { hunks } = buildComparison({ ourText: OURS, theirText: theirs, map: makeMap() });
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].where, WHERE.ROWS);
    assert.strictEqual(hunks[0].confidence, 'exact');
    assert.strictEqual(hunks[0].rects.length, 1);
    assert.strictEqual(hunks[0].rects[0].y, 200, 'the row of line 2');
});

test('AN INSERTION IS A CARET AT THE SEAM, never a wash', () => {
    // It has no position in this render by construction — there is nothing on
    // the page yet. Painting a block would claim a location that does not exist.
    const theirs = OURS.replace('\nd\n', '\nNEW\nd\n');
    const { hunks } = buildComparison({ ourText: OURS, theirText: theirs, map: makeMap() });
    const add = hunks.find(h => h.kind === 'add');
    assert.ok(add, 'the insertion was found');
    assert.strictEqual(add.where, WHERE.GAP);
    assert.strictEqual(add.rects.length, 1);
    assert.strictEqual(add.rects[0].caret, true, 'drawn as a caret');
    assert.strictEqual(add.rects[0].h, 0, 'with no height — it covers nothing');
    assert.ok(/no position in this render/.test(add.why), add.why);
});

test('THE 71% CASE: lines with no record fall back to their OBJECT, and say so', () => {
    const theirs = OURS.replace('  E=1', '  E=2');
    const { hunks } = buildComparison({ ourText: OURS, theirText: theirs, map: makeMap() });
    assert.strictEqual(hunks.length, 1);
    const h = hunks[0];
    assert.strictEqual(h.where, WHERE.OBJECT);
    assert.strictEqual(h.confidence, 'object');
    assert.ok(h.rects.length, 'the object IS drawn — dotted, per the client');
    assert.strictEqual(h.object.name, 'display-equation eq:x', 'and it is named');
    assert.ok(/carry no record/.test(h.why), h.why);
});

test('a partly-placed hunk is marked NEAR, not exact', () => {
    // Lines 5-7: two printed, one did not. Claiming "exact" would be a lie.
    const A = OURS.split('\n');
    const B = A.slice();
    B[4] = 'E!'; B[5] = 'F!'; B[6] = '\\begin{equation}%';
    const { hunks } = buildComparison({ ourText: A.join('\n'), theirText: B.join('\n'), map: makeMap() });
    const h = hunks[0];
    assert.strictEqual(h.where, WHERE.ROWS);
    assert.strictEqual(h.confidence, 'near');
    assert.ok(/2 of 3 lines/.test(h.why), h.why);
});

test('A BORROWED BOX IS REFUSED — the rule that stops confident lies', () => {
    // `locate` searches outward, so it can land in a NEIGHBOUR's object. Drawing
    // that would wash the paragraph above an equation, which is worse than
    // drawing nothing.
    const map = makeMap({
        objectRects: () => [],                       // the object itself has no box
        objectAtLine: (n) => (n === 8
            ? { kind: 'display-equation', stableKey: 'EQ', startLine: 7, endLine: 9 }
            : { kind: 'paragraph', stableKey: 'PARA', startLine: 1, endLine: 6 }),
        locate: () => ({ page: 1, exact: false, matchedLine: 3 }),   // lands in PARA
    });
    const theirs = OURS.replace('  E=1', '  E=2');
    const { hunks } = buildComparison({ ourText: OURS, theirText: theirs, map });
    assert.strictEqual(hunks[0].where, WHERE.NONE, 'refused rather than borrowed');
    assert.ok(/different object/.test(hunks[0].why), hunks[0].why);

    // And when the outward search stays INSIDE the same object, a page is fine.
    const ok = makeMap({
        objectRects: () => [],
        objectAtLine: () => ({ kind: 'display-equation', stableKey: 'EQ', startLine: 7, endLine: 9 }),
        locate: () => ({ page: 4, exact: false, matchedLine: 9 }),
    });
    const h2 = buildComparison({ ourText: OURS, theirText: theirs, map: ok }).hunks[0];
    assert.strictEqual(h2.where, WHERE.PAGE);
    assert.strictEqual(h2.page, 4);
});

test('every hunk gets a placement — none is silently dropped', () => {
    const blind = { rowsFor: () => [], objectAtLine: () => null, objectRects: () => [], locate: () => null };
    const theirs = OURS.replace('\nb\n', '\nB\n').replace('  E=1', '  E=2');
    const { hunks, summary } = buildComparison({ ourText: OURS, theirText: theirs, map: blind });
    assert.strictEqual(hunks.length, 2);
    for (const h of hunks) {
        assert.ok(h.where, 'has a placement');
        assert.ok(h.why, `and a reason: ${JSON.stringify(h)}`);
    }
    assert.strictEqual(summary.unplaced, 2);
    assert.strictEqual(summary.onPage, 0);
});

test('the census never implies it showed you everything', () => {
    assert.strictEqual(describeSummary({ total: 0 }), 'no differences');
    const s = { total: 12, onPage: 9, approximate: 2, unplaced: 1, truncated: 0 };
    assert.strictEqual(describeSummary(s), '12 changes · 9 on the page · 2 approximate · 1 not locatable');
    assert.ok(/3 not shown/.test(describeSummary({ total: 300, onPage: 297, truncated: 3 })));
});

test('a huge comparison is capped, and says how much it withheld', () => {
    const A = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const B = A.map((l, i) => (i % 2 ? l : `CHANGED ${i}`));
    const { hunks, summary } = buildComparison({
        ourText: A.join('\n'), theirText: B.join('\n'), map: makeMap(), limit: 50,
    });
    assert.strictEqual(hunks.length, 50);
    assert.ok(summary.total > 50);
    assert.strictEqual(summary.truncated, summary.total - 50);
});

test('the anchor addresses the real text, and identity is content-derived', () => {
    const theirs = OURS.replace('\nb\n', '\nB\n');
    const { hunks } = buildComparison({ ourText: OURS, theirText: theirs, map: makeMap() });
    const h = hunks[0];
    assert.strictEqual(OURS.slice(h.anchor.startOffset, h.anchor.endOffset), 'b',
        'the offsets slice exactly the changed text out of the ORIGINAL string');
    assert.ok(/^[0-9a-f]{12}$/.test(h.id), 'the id is a hash, not a line number');

    // The same change further down the file keeps the same id: that is what
    // lets a hunk survive an accept moving everything below it.
    const padded = 'x\ny\nz\n' + OURS;
    const paddedTheirs = 'x\ny\nz\n' + theirs;
    const h2 = buildComparison({ ourText: padded, theirText: paddedTheirs, map: makeMap() }).hunks[0];
    assert.strictEqual(h2.id, h.id, 'same content, same identity, different lines');
    assert.notStrictEqual(h2.anchor.startOffset, h.anchor.startOffset, 'but a different anchor');
});

test('IDENTITY IS THE CONTENT ALONE — not what surrounds it', () => {
    // The enclosing object was part of this hash at first, which quietly broke
    // the property the hash exists for: insert lines above a change and the
    // object at that line differs, so the "stable" id changed and the reader's
    // place in the list was lost mid-review.
    const theirs = OURS.replace('\nb\n', '\nB\n');
    const a = buildComparison({ ourText: OURS, theirText: theirs, map: makeMap() }).hunks[0];

    // Same change, three lines lower, and now inside a different object.
    const padded = 'p\nq\nr\n' + OURS;
    const paddedTheirs = 'p\nq\nr\n' + theirs;
    const shifted = buildComparison({ ourText: padded, theirText: paddedTheirs, map: makeMap() })
        .hunks.find(h => h.ourText === 'b');
    assert.ok(shifted, 'the change is still found');
    assert.strictEqual(shifted.id, a.id, 'and carries the SAME id');
    assert.strictEqual(shifted.ourRange.startLine, a.ourRange.startLine + 3, 'at a new line');
});

test('two identical changes are still told apart', () => {
    // Content-only ids collide when the same edit is made twice; an occurrence
    // suffix separates them by ORDER, which does not depend on surroundings.
    const A = ['x', 'same', 'y', 'z', 'same', 'w'];
    const B = ['x', 'SAME', 'y', 'z', 'SAME', 'w'];
    const { hunks } = buildComparison({ ourText: A.join('\n'), theirText: B.join('\n'), map: makeMap() });
    assert.strictEqual(hunks.length, 2);
    assert.notStrictEqual(hunks[0].id, hunks[1].id, 'distinct ids');
    assert.ok(hunks[1].id.startsWith(hunks[0].id), 'the second is the first plus an occurrence marker');
});

test('nothing throws on a broken or absent map', () => {
    const theirs = OURS.replace('\nb\n', '\nB\n');
    for (const map of [undefined, {}, null,
        { rowsFor: () => { throw new Error('boom'); } },
        { rowsFor: () => 'not an array', objectAtLine: () => { throw new Error('boom'); } }]) {
        assert.doesNotThrow(() => buildComparison({ ourText: OURS, theirText: theirs, map }));
    }
    assert.doesNotThrow(() => buildComparison({}));
    assert.deepStrictEqual(buildComparison({}).hunks, []);
    assert.doesNotThrow(() => placeHunk(null, { aStart: 1, aEnd: 2 }));
});

test('ONE THING CHANGED IS ONE ITEM TO APPROVE', () => {
    // diffLines splits at every identical line, which is right for a diff and
    // wrong for a worklist: an equation edited on two of its lines arrived as
    // TWO items, both called "display-equation eq:x", both on the same page,
    // each needing its own verdict. Reported as "many small items which are in
    // the same place".
    // The line BETWEEN the two edits has to be distinctive enough that the
    // aligner pairs it — a short common line like "+2" is cheaper to skip, and
    // the diff merges the two runs on its own. That is why the first version
    // of this test passed without any coalescing at all.
    const mid = '  \\sum_k \\alpha_k \\beta_k \\gamma_k';
    const ours = ['a', 'b', 'c', 'd', 'e', 'f',
        '\\begin{equation}', '  E=1', mid, '  Z=3', '\\end{equation}'].join('\n');
    const theirs = ['a', 'b', 'c', 'd', 'e', 'f',
        '\\begin{equation}', '  E=9', mid, '  Z=7', '\\end{equation}'].join('\n');
    assert.strictEqual(diffLines(splitLines(ours), splitLines(theirs)).length, 2,
        'the raw diff really does split this into two');
    const map = makeMap({
        objectAtLine: (n) => ((n >= 7 && n <= 11)
            ? { kind: 'display-equation', label: 'eq:x', stableKey: 's/eq/1', startLine: 7, endLine: 11 }
            : null),
    });
    const { hunks } = buildComparison({ ourText: ours, theirText: theirs, map });
    assert.strictEqual(hunks.length, 1,
        `two edits inside one equation are one item (got ${hunks.length})`);
    // And the merged item still carries what it takes to keep or undo it: the
    // lines between were identical, so both slices carry them unchanged.
    assert.ok(hunks[0].ourText.includes('E=1') && hunks[0].ourText.includes('Z=3'));
    assert.ok(hunks[0].theirText.includes('E=9') && hunks[0].theirText.includes('Z=7'));
    assert.ok(hunks[0].ourText.includes('\\sum_k'), 'including the unchanged line between them');
    assert.strictEqual(hunks[0].kind, 'change');
});

test('but two edits in DIFFERENT places stay two', () => {
    // The point is to merge what is in one place, not to merge everything.
    const ours = ['a', 'b', 'c', 'd', 'e', 'f', '\\begin{equation}', '  E=1', '\\end{equation}'].join('\n');
    const theirs = ['A', 'b', 'c', 'd', 'e', 'F', '\\begin{equation}', '  E=1', '\\end{equation}'].join('\n');
    const { hunks } = buildComparison({ ourText: ours, theirText: theirs, map: makeMap() });
    assert.strictEqual(hunks.length, 2, `first line and sixth are separate (got ${hunks.length})`);
});

test('A PAPER REWRITTEN EVERY OTHER LINE DOES NOT BECOME ONE ITEM', () => {
    // The gap is ZERO on purpose. At one, a hunk with a single paired line
    // between it and the next merges — and a document edited on alternating
    // lines collapses into a single item covering the whole paper, which is a
    // worse answer than the many-small-items this was meant to fix.
    const a = []; const b = [];
    for (let i = 1; i <= 20; i++) { a.push(`line ${i}`); b.push(i % 2 ? `LINE ${i}` : `line ${i}`); }
    const { hunks } = buildComparison({
        ourText: a.join('\n'), theirText: b.join('\n'),
        map: makeMap({ objectAtLine: () => null }),
    });
    assert.ok(hunks.length >= 8, `they stay separate (got ${hunks.length})`);
});

console.log('placing hunks on the rendered pages\n');
results.forEach(r => console.log(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
