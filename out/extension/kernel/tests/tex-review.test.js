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
/** A session with a clock the test moves, so grouping can be exercised. */
const clocked = (text) => {
    const t = { at: 1_000_000 };
    const s = new ReviewSession({ file: '/p.tex', baseText: text, now: () => t.at });
    return { s, t, tick: (ms) => { t.at += ms; } };
};

test('a hunk is described by the AGENT\'S verb, not the diff\'s', () => {
    // ours = the document now, theirs = the baseline: a hunk with nothing on
    // our side is text the agent REMOVED.
    assert.strictEqual(verbOf({ ourRange: { startLine: 4, endLine: 4 }, theirRange: { startLine: 4, endLine: 6 } }), 'del');
    assert.strictEqual(verbOf({ ourRange: { startLine: 4, endLine: 6 }, theirRange: { startLine: 4, endLine: 4 } }), 'add');
    assert.strictEqual(verbOf({ ourRange: { startLine: 4, endLine: 6 }, theirRange: { startLine: 4, endLine: 5 } }), 'change');
});

test('TWO BATCHES ACCUMULATE INTO ONE LIST — nothing is approved by arriving', () => {
    // Two arrivals, not two writes in one episode: the clock moves past the
    // grouping window between them (see the grouping tests below).
    const { s, tick } = clocked(BASE);
    s.noteBatch({ source: 'disk' });
    const first = s.update({ currentText: AFTER_ONE });
    assert.strictEqual(first.hunks.length, 1, 'the first write is one change');

    tick(10 * 60 * 1000);
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
    const { s, tick } = clocked(BASE);
    const b1 = s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    tick(10 * 60 * 1000);
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

test('AN AGENT REWRITING ITS OWN CHANGE IS NOT "YOU EDITED THIS"', () => {
    // Reported: a change the agent had just made carried the reader's flag, so
    // Undo was withheld for it. From the diff's point of view a second agent
    // write over the same region looks exactly like the reader typing there —
    // the content-derived id changes and a new hunk covers the same lines — so
    // the flag can only come from the keystrokes themselves.
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    assert.strictEqual(s.hunks.length, 1);
    assert.strictEqual(s.edited.has(s.hunks[0].id), false);

    // The agent writes again, over the very same sentence.
    const again = BASE.replace('sum.  They are the two physical half-towers.',
        'sum.  They are the two physical half-towers, not continuations of one lattice.');
    const b2 = s.noteBatch({ source: 'disk' });
    s.update({ currentText: again });

    const h = s.hunks[0];
    assert.strictEqual(s.hunks.length, 1);
    assert.strictEqual(s.edited.has(h.id), false,
        'the agent rewriting its own change is still the agent');
    assert.ok(s.undo(h.id).ok, 'so it can still be undone');
    assert.strictEqual(s.firstSeen.get(h.id), b2,
        'and it belongs to the arrival that rewrote it');
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

test('WRITES CLOSE TOGETHER ARE ONE ARRIVAL, NOT ONE EACH', () => {
    // Reported: the model changes the same part several times, and each write
    // became its own group — a list about the writes instead of about the
    // paper. Consecutive writes from the same source inside the window join
    // the arrival already open.
    const { s, tick } = clocked(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    tick(8000);                                   // eight seconds later
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });

    assert.strictEqual(s.hunks.length, 2, 'both changes are pending');
    const p = s.payload();
    assert.strictEqual(p.groups.length, 1, 'in ONE arrival');
    assert.strictEqual(p.groups[0].writes, 2, 'which knows it was two writes');
    assert.strictEqual(p.groups[0].count, 2);
    assert.ok(p.groups[0].lastAt > p.groups[0].at, 'and when the last one landed');
});

test('A REWRITE OF THE SAME PART MOMENTS LATER DOES NOT SPLIT THE LIST', () => {
    // The literal case from the report: the same sentence written twice.
    const { s, tick } = clocked(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    tick(5000);
    const again = BASE.replace('sum.  They are the two physical half-towers.',
        'sum.  They are the two physical half-towers, not continuations of one lattice.');
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: again });

    assert.strictEqual(s.hunks.length, 1, 'one place changed, so one change');
    const p = s.payload();
    assert.strictEqual(p.groups.length, 1, 'and one arrival, not two with one empty');
    assert.strictEqual(p.groups[0].writes, 2);
});

test('WRITES FAR APART STAY SEPARATE ARRIVALS', () => {
    const { s, tick } = clocked(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    tick(10 * 60 * 1000);                         // ten minutes later: a new session of work
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });

    const p = s.payload();
    assert.strictEqual(p.groups.length, 2, 'an hour of work is not one arrival');
    assert.strictEqual(p.groups[0].writes, 1);
    assert.strictEqual(p.groups[0].lastAt >= p.groups[1].lastAt, true, 'newest first');
});

test('a slow trickle cannot roll one arrival forward for ever', () => {
    // Each write is inside the window, but the episode as a whole is capped —
    // otherwise a background agent writing every 30 s would produce a single
    // group that is hours old and never announced again.
    const { s, tick } = clocked(BASE);
    let text = BASE;
    let ids = new Set();
    for (let i = 0; i < 40; i++) {
        text = text.replace('A closing paragraph', `A closing paragraph ${i}`);
        ids.add(s.noteBatch({ source: 'disk' }));
        s.update({ currentText: text });
        tick(30000);                              // half a minute between writes
    }
    assert.ok(ids.size > 1, 'the episode was closed and reopened');
    assert.ok(ids.size < 40, `but not once per write (got ${ids.size})`);
});

test('a DIFFERENT source is always its own arrival', () => {
    // The agent's own tool and a write from somewhere else are different
    // events even a second apart, and the list should say so.
    const { s, tick } = clocked(BASE);
    s.noteBatch({ source: 'paper_applyEdit' });
    s.update({ currentText: AFTER_ONE });
    tick(1000);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });
    assert.strictEqual(s.payload().groups.length, 2);
});

test('grouping can be turned off', () => {
    const t = { at: 5000 };
    const s = new ReviewSession({ file: '/p.tex', baseText: BASE, now: () => t.at, groupWindowMs: 0 });
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    t.at += 500;
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_TWO });
    assert.strictEqual(s.payload().groups.length, 2, 'every write is its own arrival again');
});

// --- WHICH PART OF THE PAPER A CHANGE IS IN ---------------------------------
//
// Proposed: collate the list by section, with a way to agree to a whole
// section at once. The session's job is to say which section each change is in
// (asked of the injected view, so it works with no render map at all) and to
// keep a named set bottom-up; the grouping itself is the panel's.

const SECTIONED = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{The pairing}',
    'First section prose that the agent will rewrite.',
    '',
    '\\subsection{The upper tower}',
    'A subsection sentence, also rewritten.',
    '',
    '\\section{The measure}',
    'Second section prose, untouched at first.',
    'A last line of it.',
    '\\end{document}',
].join('\n');

/** The view the extension injects: the innermost heading a line is under. */
const SECTION_VIEW = {
    sectionAt: (line) => {
        if (line >= 9) return { key: 'sec:measure', title: 'The measure', level: 1, startLine: 9 };
        if (line >= 6) return { key: 'sec:tower', title: 'The upper tower', level: 2, startLine: 6 };
        if (line >= 3) return { key: 'sec:pairing', title: 'The pairing', level: 1, startLine: 3 };
        return null;
    },
};

test('EVERY CHANGE KNOWS WHICH SECTION IT IS IN', () => {
    const s = new ReviewSession({ file: '/p.tex', baseText: SECTIONED, now: () => 1000 });
    const after = SECTIONED
        .replace('First section prose that the agent will rewrite.', 'First section prose, rewritten.')
        .replace('A subsection sentence, also rewritten.', 'A subsection sentence, now different.')
        .replace('Second section prose, untouched at first.', 'Second section prose, touched after all.');
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: after, map: SECTION_VIEW });
    assert.strictEqual(s.hunks.length, 3);

    const p = s.payload();
    const secs = p.groups.flatMap(g => g.hunks).map(h => h.section && h.section.title).sort();
    assert.deepStrictEqual(secs, ['The measure', 'The pairing', 'The upper tower']);
    const sub = p.groups.flatMap(g => g.hunks).find(h => h.section.key === 'sec:tower');
    assert.strictEqual(sub.section.level, 2, 'the INNERMOST unit, so a subsection is its own group');
    assert.strictEqual(sub.section.startLine, 6, 'and carries where it starts, for document order');
});

test('a paper with no sections, or a change above the first one, simply has none', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });                 // no map at all
    assert.strictEqual(s.payload().groups[0].hunks[0].section, null);

    // Changed IN PLACE, so the headings below keep their line numbers — the
    // view is asked about the document as it is now, not as it was.
    const s2 = new ReviewSession({ file: '/p.tex', baseText: SECTIONED, now: () => 1000 });
    s2.noteBatch({ source: 'disk' });
    s2.update({
        currentText: SECTIONED.replace('\\documentclass{article}', '\\documentclass[11pt]{article}'),
        map: SECTION_VIEW,
    });
    assert.strictEqual(s2.hunks.length, 1);
    assert.strictEqual(s2.hunks[0].section, null, 'above the first heading is not in a section');
});

test('a view that throws does not cost the reader their list', () => {
    const s = new ReviewSession({ file: '/p.tex', baseText: SECTIONED, now: () => 1000 });
    s.noteBatch({ source: 'disk' });
    assert.doesNotThrow(() => s.update({
        currentText: SECTIONED.replace('A last line of it.', 'A last line, changed.'),
        map: { sectionAt: () => { throw new Error('no model'); } },
    }));
    assert.strictEqual(s.hunks.length, 1);
    assert.strictEqual(s.hunks[0].section, null);
});

test('KEEPING A SECTION AGREES TO EXACTLY ITS CHANGES, AND TO NOTHING ELSE', () => {
    const s = new ReviewSession({ file: '/p.tex', baseText: SECTIONED, now: () => 1000 });
    const after = SECTIONED
        .replace('First section prose that the agent will rewrite.', 'First section prose, rewritten.')
        .replace('A subsection sentence, also rewritten.', 'A subsection sentence, now different.')
        .replace('Second section prose, untouched at first.', 'Second section prose, touched after all.');
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: after, map: SECTION_VIEW });

    const inFirst = s.hunks.filter(h => h.section.key === 'sec:pairing').map(h => h.id);
    assert.strictEqual(inFirst.length, 1);
    const r = s.keepMany(inFirst);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.kept, inFirst);
    assert.ok(s.baseText.includes('First section prose, rewritten.'), 'that section is agreed to');
    assert.ok(!s.baseText.includes('now different'), 'and the subsection under it is NOT');
    assert.ok(!s.baseText.includes('touched after all'), 'nor the section below it');

    const left = s.update({ currentText: after, map: SECTION_VIEW });
    assert.strictEqual(left.hunks.length, 2, 'the other two are still waiting');
});

test('KEEPING SEVERAL AT ONCE IS BOTTOM-UP, or the splices land on stale lines', () => {
    // The property that makes keepMany more than a loop: keeping a change
    // rewrites the baseline and moves every line below it, so the lowest one
    // must be dealt with while the ones above still describe where they are.
    // Agreeing to ALL of them must therefore give back the document exactly.
    const s = new ReviewSession({ file: '/p.tex', baseText: SECTIONED, now: () => 1000 });
    const after = SECTIONED
        .replace('First section prose that the agent will rewrite.',
            'First section prose, rewritten\nacross two lines now.')
        .replace('A subsection sentence, also rewritten.', 'A subsection sentence, now different.')
        .replace('Second section prose, untouched at first.\nA last line of it.',
            'Second section prose, and only one line of it.');
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: after, map: SECTION_VIEW });
    assert.ok(s.hunks.length >= 3, `expected several hunks, got ${s.hunks.length}`);

    const r = s.keepMany(s.hunks.map(h => h.id));
    assert.ok(r.ok);
    assert.strictEqual(s.baseText, after,
        'keeping every change gives back the document, byte for byte');
    assert.strictEqual(s.update({ currentText: after, map: SECTION_VIEW }).hunks.length, 0);
});

test('keepMany ignores ids that are not in the list, and an empty set', () => {
    const s = fresh(BASE);
    s.noteBatch({ source: 'disk' });
    s.update({ currentText: AFTER_ONE });
    assert.deepStrictEqual(s.keepMany(['nope']).kept, []);
    assert.deepStrictEqual(s.keepMany([]).kept, []);
    assert.doesNotThrow(() => s.keepMany(null));
    assert.strictEqual(s.hunks.length, 1, 'and nothing was decided');
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
