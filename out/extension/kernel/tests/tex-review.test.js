// tex-review.test.js — the review session: what the agent changed, undecided.
//
// Pure and executed. The properties asserted here are the four defects the
// feature exists to remove, stated as behaviour:
//
//   · two agent batches accumulate into ONE list (the reported "the previous
//     changes disappear as if approved");
//   · keeping a change makes it part of the agreed text and only that change
//     leaves the list;
//   · undoing a change produces a whole-line edit that restores the baseline
//     text byte for byte;
//   · the reader's own typing does not become a change to review, and typing
//     INSIDE a pending change makes undoing it refuse rather than throw the
//     reader's words away.

const assert = require('assert');
const { ReviewSession, verbOf } = require('../../tex/reviewSession');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const BASE = [
    '\\documentclass{article}',
    '\\begin{document}',
    'The SoV pairing contains both allowed sectors in',
    '\\eqref{eq:physical-sov-values}.  Closing the upper contour produces the',
    'upper--upper sum, while closing the lower contour produces the lower--lower',
    'sum.  They are the two physical half-towers.',
    '',
    '\\begin{equation}',
    '  \\rho_\\alpha := \\operatorname{Im}(u-\\theta_\\alpha),',
    '\\end{equation}',
    '',
    'A closing paragraph that nobody touches.',
    '\\end{document}',
].join('\n');

/** The agent rewrites line 6 and adds two lines after the equation. */
const AFTER_ONE = BASE
    .replace('sum.  They are the two physical half-towers.',
        'sum.  They are the two physical half-towers, not analytic continuations.');
const AFTER_TWO = AFTER_ONE
    .replace('A closing paragraph that nobody touches.',
        'A closing paragraph that nobody touches.\n\nAn entirely new paragraph the agent added later.');

const fresh = (text) => new ReviewSession({ file: '/p.tex', baseText: text, now: () => 1000 });

test('a hunk is described by the AGENT\'S verb, not the diff\'s', () => {
    // ours = the document now, theirs = the baseline: a hunk with nothing on
    // our side is text the agent REMOVED.
    assert.strictEqual(verbOf({ ourRange: { startLine: 4, endLine: 4 }, theirRange: { startLine: 4, endLine: 6 } }), 'del');
    assert.strictEqual(verbOf({ ourRange: { startLine: 4, endLine: 6 }, theirRange: { startLine: 4, endLine: 4 } }), 'add');
    assert.strictEqual(verbOf({ ourRange: { startLine: 4, endLine: 6 }, theirRange: { startLine: 4, endLine: 5 } }), 'change');
});

test('TWO BATCHES ACCUMULATE INTO ONE LIST — nothing is approved by arriving', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    const first = s.update({ currentText: AFTER_ONE });
    assert.strictEqual(first.hunks.length, 1, 'the first write is one change');

    s.noteBatch({ source: 'disk' });
    const second = s.update({ currentText: AFTER_TWO });
    assert.strictEqual(second.hunks.length, 2,
        'the second write ADDS to the list; the first change is still pending');

    const p = s.payload();
    assert.strictEqual(p.pending, 2);
    assert.strictEqual(p.groups.length, 2, 'grouped by the arrival that first showed them');
    const sizes = p.groups.map(g => g.count).sort();
    assert.deepStrictEqual(sizes, [1, 1]);
    // The batch of the FIRST change did not change when the second arrived.
    const ids = s.hunks.map(h => s.firstSeen.get(h.id));
    assert.strictEqual(new Set(ids).size, 2, 'each change keeps the batch it arrived in');
});

test('KEEP makes one change part of the agreed text and removes only it', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });
    assert.strictEqual(s.hunks.length, 2);

    const target = s.hunks.find(h => h.verb === 'add');
    const r = s.keep(target.id);
    assert.ok(r.ok, r.reason);
    assert.ok(r.baseText.includes('An entirely new paragraph the agent added later.'),
        'the kept text is now part of the baseline');
    assert.ok(!r.baseText.includes('not analytic continuations'),
        'and nothing else was agreed to by accident');

    const after = s.update({ currentText: AFTER_TWO });
    assert.strictEqual(after.hunks.length, 1, 'exactly one change left');
    assert.strictEqual(after.hunks[0].verb, 'change');
    assert.strictEqual(s.decided[0].action, 'kept');
});

test('UNDO returns a whole-line edit that restores the baseline byte for byte', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });

    // Apply every undo the way the extension does: bottom-up, whole lines.
    const all = s.undoAll();
    assert.ok(all.ok);
    assert.strictEqual(all.edits.length, 2);
    let lines = AFTER_TWO.split('\n');
    for (const e of all.edits) {
        lines.splice(e.startLine - 1, Math.max(0, e.endLine - e.startLine), ...e.lines);
    }
    assert.strictEqual(lines.join('\n'), BASE,
        'undoing everything gives back exactly the text the reader agreed to');
});

test('KEEP ALL agrees to the document as it stands', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });
    const r = s.keepAll();
    assert.ok(r.ok);
    assert.strictEqual(r.baseText, AFTER_TWO);
    assert.strictEqual(s.update({ currentText: AFTER_TWO }).hunks.length, 0, 'nothing left to review');
});

test('KEEP BATCH keeps its own changes and leaves the other batch pending', () => {
    const s = fresh(BASE);
    const b1 = s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });

    s.keepBatch(b1);
    const left = s.update({ currentText: AFTER_TWO });
    assert.strictEqual(left.hunks.length, 1);
    assert.strictEqual(left.hunks[0].verb, 'add', 'the later batch is still waiting');
    assert.ok(s.baseText.includes('not analytic continuations'));
});

test('THE READER\'S OWN TYPING IS NOT A CHANGE TO REVIEW', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    assert.strictEqual(s.hunks.length, 1);

    // The reader types in a paragraph nobody is arguing about.
    const at = AFTER_ONE.indexOf('A closing paragraph');
    const typed = AFTER_ONE.slice(0, at) + 'Rewritten by hand. ' + AFTER_ONE.slice(at);
    const moved = s.noteReaderEdit({ offset: at, length: 0, text: 'Rewritten by hand. ' });
    assert.ok(moved, 'the baseline followed the reader into common ground');

    const after = s.update({ currentText: typed });
    assert.strictEqual(after.hunks.length, 1,
        'still just the agent\'s one change — the reader\'s own words are not in the list');
    assert.ok(s.baseText.includes('Rewritten by hand.'));
});

test('TYPING INSIDE A PENDING CHANGE FLAGS IT, AND UNDO REFUSES', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    const h = s.hunks[0];

    const at = AFTER_ONE.indexOf('not analytic continuations');
    const moved = s.noteReaderEdit({ offset: at, length: 0, text: 'certainly ' });
    assert.strictEqual(moved, false, 'the baseline does NOT follow into contested text');
    assert.ok(s.edited.has(h.id));

    const typed = AFTER_ONE.slice(0, at) + 'certainly ' + AFTER_ONE.slice(at);
    const after = s.update({ currentText: typed });
    assert.strictEqual(after.hunks.length, 1);
    const now = after.hunks[0];
    assert.ok(s.edited.has(now.id), 'the flag follows the content onto its new id');
    assert.strictEqual(s.firstSeen.get(now.id), s.firstSeen.get(h.id), 'and so does the batch');

    const r = s.undo(now.id);
    assert.strictEqual(r.ok, false);
    assert.ok(/edited inside this change/.test(r.reason), r.reason);
    // Keeping it is still meaningful — it agrees to what is there now.
    assert.ok(s.keep(now.id).ok);
});

test('a change the reader makes identical to the baseline simply leaves', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    assert.strictEqual(s.hunks.length, 1);
    assert.strictEqual(s.update({ currentText: BASE }).hunks.length, 0);
});

test('the payload carries the census, the groups and the verdict history', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'paper_applyEdit', note: 'eq:rho' });
    s.update({ currentText: AFTER_TWO });
    s.keep(s.hunks[0].id);
    s.update({ currentText: AFTER_TWO });
    const p = s.payload({ label: 'x' });
    assert.strictEqual(p.file, '/p.tex');
    assert.ok(p.census.includes('change'));
    assert.strictEqual(p.groups[0].source, 'paper_applyEdit');
    assert.ok(p.groups[0].hunks[0].id && p.groups[0].hunks[0].verb);
    assert.strictEqual(p.decided.length, 1);
    assert.strictEqual(p.label, 'x');
});

test('nothing here throws on empty, missing or nonsense input', () => {
    const s = new ReviewSession({});
    assert.doesNotThrow(() => s.update({ currentText: '' }));
    assert.doesNotThrow(() => s.update({}));
    assert.strictEqual(s.keep('nope').ok, false);
    assert.strictEqual(s.undo('nope').ok, false);
    assert.strictEqual(s.noteReaderEdit(null), false);
    assert.doesNotThrow(() => s.payload());
});

(async () => {
    console.log('the review session, executed\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log('  ok   ' + name); }
        catch (e) {
            fail++;
            console.log('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
