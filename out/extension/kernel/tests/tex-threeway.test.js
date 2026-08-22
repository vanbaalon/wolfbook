// tex-threeway.test.js — merging an agent's write into a buffer being typed in.
//
// Reported: editing at the same time as the agent produces VS Code's own
// "the content of the file is newer" dialog and the review never engages.
// The three texts are BASE (last saved), OURS (the reader's unsaved buffer)
// and THEIRS (what the agent put on disk).
//
// What has to be true, in order of how much damage it does when it is not:
//
//   1. NOTHING IS LOST. Every reader line survives; every agent hunk is either
//      applied or reported as a conflict — never dropped in silence.
//   2. NOTHING IS GUESSED. Two edits to the same place is a conflict, and the
//      reader's text is what stands.
//   3. The trivial cases are exact: if one side did not move, the other side
//      IS the answer, byte for byte.

const assert = require('assert');
const { mergeThreeWay } = require('../../tex/threeWay');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const BASE = [
    '\\documentclass{article}',
    '\\begin{document}',
    '',
    '\\section{The pairing}',
    'The SoV pairing contains both allowed sectors.',
    'Closing the upper contour produces the upper--upper sum.',
    '',
    '\\section{The measure}',
    'The measure is a product over the two half-towers.',
    'Its normalisation is fixed by the leading term.',
    '',
    '\\end{document}',
].join('\n');

const edit = (text, from, to) => {
    assert.ok(text.includes(from), `fixture no longer contains ${JSON.stringify(from)}`);
    return text.replace(from, to);
};

test('IF THE READER DID NOT MOVE, THE ANSWER IS THE AGENT\'S TEXT EXACTLY', () => {
    const theirs = edit(BASE, 'The measure is a product', 'The measure is a finite product');
    const m = mergeThreeWay({ base: BASE, ours: BASE, theirs });
    assert.strictEqual(m.text, theirs);
    assert.ok(m.clean);
});

test('IF THE AGENT DID NOT MOVE, THE ANSWER IS THE READER\'S TEXT EXACTLY', () => {
    const ours = edit(BASE, 'both allowed sectors', 'both of the allowed sectors');
    const m = mergeThreeWay({ base: BASE, ours, theirs: BASE });
    assert.strictEqual(m.text, ours);
    assert.ok(m.clean);
});

test('TWO EDITS IN DIFFERENT SECTIONS BOTH SURVIVE — the whole point', () => {
    // The reader is fixing section 1 while the agent rewrites section 2.
    const ours = edit(BASE, 'The SoV pairing contains both allowed sectors.',
        'The SoV pairing contains both of the allowed sectors, as stated.');
    const theirs = edit(BASE, 'Its normalisation is fixed by the leading term.',
        'Its normalisation is fixed by the leading term of the asymptotics.');

    const m = mergeThreeWay({ base: BASE, ours, theirs });
    assert.ok(m.clean, 'different places are not a conflict');
    assert.strictEqual(m.conflicts.length, 0);
    assert.strictEqual(m.applied.length, 1);
    assert.ok(m.text.includes('both of the allowed sectors, as stated.'), 'the reader keeps their edit');
    assert.ok(m.text.includes('of the asymptotics.'), 'and gets the agent\'s');
    // And nothing else moved.
    assert.strictEqual(m.text.split('\n').length, BASE.split('\n').length);
});

test('THE SAME LINES EDITED BY BOTH IS A CONFLICT, AND THE READER\'S TEXT STANDS', () => {
    const line = 'The measure is a product over the two half-towers.';
    const ours = edit(BASE, line, 'The measure is a product over both half-towers.');
    const theirs = edit(BASE, line, 'The measure is a finite product over the two half-towers.');

    const m = mergeThreeWay({ base: BASE, ours, theirs });
    assert.strictEqual(m.clean, false);
    assert.strictEqual(m.conflicts.length, 1, 'reported, not guessed at');
    assert.strictEqual(m.applied.length, 0);
    assert.ok(m.text.includes('over both half-towers.'), 'the reader\'s words are what is in the buffer');
    assert.ok(!m.text.includes('finite product'), 'and the agent\'s version is NOT interleaved');
    // The agent's version is not thrown away either — the caller can show it.
    assert.ok(m.conflicts[0].theirLines.join('\n').includes('finite product'));
});

test('AN INSERTION INSIDE WHAT THE READER REWROTE IS A CONFLICT, NOT A GUESS', () => {
    // The reader replaced a two-line passage; the agent added a sentence
    // BETWEEN those two lines. There is no longer a seam to put it in, so
    // guessing would interleave the agent's sentence into a paragraph that no
    // longer exists.
    const both = 'The measure is a product over the two half-towers.\n' +
                 'Its normalisation is fixed by the leading term.';
    const ours = edit(BASE, both, 'The measure is a product over both towers, normalised at leading order.');
    const theirs = edit(BASE, both,
        'The measure is a product over the two half-towers.\n' +
        'See \\eqref{eq:norm} for the constant.\n' +
        'Its normalisation is fixed by the leading term.');

    const m = mergeThreeWay({ base: BASE, ours, theirs });
    assert.strictEqual(m.clean, false, 'the seam is inside what the reader replaced');
    assert.ok(m.text.includes('normalised at leading order'), 'the reader\'s passage stands');
    assert.ok(!m.text.includes('See \\eqref{eq:norm}'), 'and nothing was slipped into it');
    assert.ok(m.conflicts[0].theirLines.join('\n').includes('See \\eqref{eq:norm}'),
        'the agent\'s version is kept for the reader to look at');
});

test('AN INSERTION THAT MERELY ABUTS A CHANGED LINE IS APPLIED — git\'s own rule', () => {
    // New text next to changed text is not a disagreement about anything, and
    // declining it would make the common "agent appends a remark to the
    // paragraph I am polishing" case need a manual merge every time.
    const ours = edit(BASE, 'Its normalisation is fixed by the leading term.',
        'Its normalisation is fixed by the subleading term.');
    const theirs = edit(BASE, 'Its normalisation is fixed by the leading term.',
        'Its normalisation is fixed by the leading term.\nSee \\eqref{eq:norm} for the constant.');

    const m = mergeThreeWay({ base: BASE, ours, theirs });
    assert.ok(m.clean, 'adjacent is not overlapping');
    assert.ok(m.text.includes('subleading term'), 'the reader keeps their line');
    assert.ok(m.text.includes('See \\eqref{eq:norm}'), 'and the agent\'s new line is there');
});

test('an insertion FAR from the reader IS brought in, at the right place', () => {
    const ours = edit(BASE, 'The SoV pairing contains both allowed sectors.',
        'The SoV pairing contains both allowed sectors, plainly.');
    const theirs = edit(BASE, 'Its normalisation is fixed by the leading term.',
        'Its normalisation is fixed by the leading term.\nSee \\eqref{eq:norm} for the constant.');

    const m = mergeThreeWay({ base: BASE, ours, theirs });
    assert.ok(m.clean);
    const out = m.text.split('\n');
    const at = out.indexOf('See \\eqref{eq:norm} for the constant.');
    assert.ok(at > 0, 'the inserted line is there');
    assert.strictEqual(out[at - 1], 'Its normalisation is fixed by the leading term.',
        'directly after the line it was written after');
    assert.strictEqual(out[at + 1], '', 'and before what followed it');
});

test('A READER EDIT THAT CHANGES THE LINE COUNT DOES NOT MISPLACE THE AGENT\'S', () => {
    // The reader adds three lines ABOVE the agent's change: without the shift
    // the splice would land three lines early, in the middle of other prose.
    const ours = BASE.replace('\\section{The pairing}',
        '\\section{The pairing}\nA new opening line.\nAnd another.\nAnd a third.');
    const theirs = edit(BASE, 'Its normalisation is fixed by the leading term.',
        'Its normalisation is FIXED BY THE LEADING TERM.');

    const m = mergeThreeWay({ base: BASE, ours, theirs });
    assert.ok(m.clean);
    const out = m.text.split('\n');
    const at = out.indexOf('Its normalisation is FIXED BY THE LEADING TERM.');
    assert.ok(at > 0, 'the agent\'s line is in the merge');
    assert.strictEqual(out[at - 1], 'The measure is a product over the two half-towers.',
        'in its own place, not three lines up');
    assert.ok(m.text.includes('And a third.'), 'and the reader\'s new lines are all there');
});

test('SEVERAL AGENT CHANGES AT ONCE ALL LAND', () => {
    const ours = edit(BASE, 'both allowed sectors', 'both allowed sectors (sic)');
    let theirs = edit(BASE, '\\section{The measure}', '\\section{The measure and its zeros}');
    theirs = edit(theirs, 'Its normalisation is fixed by the leading term.',
        'Its normalisation is fixed by the leading term of the asymptotics.');
    theirs = edit(theirs, 'Closing the upper contour produces the upper--upper sum.',
        'Closing the upper contour produces the upper--upper sum, term by term.');

    const m = mergeThreeWay({ base: BASE, ours, theirs });
    assert.ok(m.clean, JSON.stringify(m.conflicts));
    assert.strictEqual(m.applied.length, 3);
    for (const s of ['The measure and its zeros', 'of the asymptotics.', 'term by term.', '(sic)']) {
        assert.ok(m.text.includes(s), `${s} survived`);
    }
});

test('NOT ONE READER LINE IS LOST, over a hundred random pairings', () => {
    // The property that matters more than any single case: whatever the merge
    // decides, every line the reader has in front of them is still there
    // afterwards unless the agent's own change replaced that exact region.
    const baseL = BASE.split('\n');
    let checked = 0;
    for (let i = 0; i < baseL.length; i++) {
        for (let j = 0; j < baseL.length; j++) {
            if (!baseL[i].trim() || !baseL[j].trim()) continue;
            const ours = baseL.map((l, k) => (k === i ? l + ' READER' : l)).join('\n');
            const theirs = baseL.map((l, k) => (k === j ? l + ' AGENT' : l)).join('\n');
            const m = mergeThreeWay({ base: BASE, ours, theirs });
            checked++;
            assert.ok(m.text.includes(baseL[i] + ' READER') || i === j,
                `the reader's line ${i} vanished (agent at ${j})`);
            if (i === j) {
                assert.strictEqual(m.clean, false, `same line ${i} must conflict`);
                assert.ok(m.text.includes(baseL[i] + ' READER'), 'and the reader wins it');
            } else {
                assert.ok(m.clean, `lines ${i} and ${j} should merge cleanly`);
                assert.ok(m.text.includes(baseL[j] + ' AGENT'), `the agent's line ${j} was applied`);
                assert.strictEqual(m.text.split('\n').length, baseL.length, 'and nothing was duplicated');
            }
        }
    }
    assert.ok(checked > 80, `only ${checked} pairings exercised`);
});

test('a final newline is not invented or lost', () => {
    const b = 'a\nb\nc\n';
    const o = 'a\nB\nc\n';
    const t = 'a\nb\nC\n';
    assert.strictEqual(mergeThreeWay({ base: b, ours: o, theirs: t }).text, 'a\nB\nC\n');
    const m2 = mergeThreeWay({ base: 'a\nb\nc', ours: 'a\nB\nc', theirs: 'a\nb\nC' });
    assert.strictEqual(m2.text, 'a\nB\nC');
});

test('nothing here throws on empty, missing or identical input', () => {
    assert.doesNotThrow(() => mergeThreeWay({}));
    assert.strictEqual(mergeThreeWay({ base: '', ours: '', theirs: '' }).text, '');
    assert.strictEqual(mergeThreeWay({ base: 'x', ours: 'x', theirs: 'x' }).text, 'x');
    assert.doesNotThrow(() => mergeThreeWay({ base: null, ours: undefined, theirs: 5 }));
});

(async () => {
    console.log('three texts, one paper, executed\n');
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
