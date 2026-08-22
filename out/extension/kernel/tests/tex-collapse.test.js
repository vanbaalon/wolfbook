// tex-collapse.test.js — folding a section away, in the file itself.
//
// This edits the reader's paper, so the properties are stated in that order of
// severity:
//
//   1. ROUND TRIP IS EXACT. Collapse then expand gives back the file byte for
//      byte — including lines that were already comments, which is what the
//      `%WP%` prefix exists for and what a bare `%` could never do.
//   2. \end{document} IS NEVER COMMENTED. The last section's span runs to the
//      end of the file; commenting the end of the document produces a paper
//      that will not compile at all, from a gesture meant to shorten it.
//   3. NOTHING IS FOLDED TWICE, and a section inside a folded one is refused
//      rather than nested.

const assert = require('assert');
const {
    MARK, PREFIX, collapseSection, expandSection, applyEdit, collapseStateAt,
    collapsedSections, bodyEndLine,
} = require('../../tex/collapse');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SRC = [
    '\\documentclass{article}',              // 1
    '\\begin{document}',                     // 2
    '',                                      // 3
    '\\section{The pairing}',                // 4
    'First prose line.',                     // 5
    '% an ordinary comment of the author\'s', // 6
    'A line with a trailing comment % like this', // 7
    '',                                      // 8
    '\\begin{equation}',                     // 9
    '  E = mc^2',                            // 10
    '\\end{equation}',                       // 11
    '',                                      // 12
    '\\subsection{The upper tower}',         // 13
    'Subsection prose.',                     // 14
    '',                                      // 15
    '\\section{The measure}',                // 16
    'The last section, which runs to the end.', // 17
    '',                                      // 18
    '\\end{document}',                       // 19
];
const lines = () => SRC.slice();

// The three headings, as the model reports them.
const H1 = { headStart: 4, headEnd: 4, spanEnd: 15, title: 'The pairing' };
const H2 = { headStart: 13, headEnd: 13, spanEnd: 15, title: 'The upper tower' };
const H3 = { headStart: 16, headEnd: 16, spanEnd: 19, title: 'The measure' };

test('the end of the document is found, whatever follows it', () => {
    assert.strictEqual(bodyEndLine(SRC), 18, 'the last line that is ours to fold');
    assert.strictEqual(bodyEndLine(['a', 'b']), 2, 'a fragment with no \\end{document} is all body');
});

test('COLLAPSE THEN EXPAND GIVES BACK THE FILE, BYTE FOR BYTE', () => {
    for (const h of [H1, H2, H3]) {
        const c = collapseSection({ lines: lines(), ...h });
        assert.ok(c.ok, `${h.title}: ${c.reason}`);
        const folded = applyEdit(lines(), c.edit);
        const e = expandSection({ lines: folded, headEnd: h.headEnd });
        assert.ok(e.ok, `${h.title}: ${e.reason}`);
        assert.deepStrictEqual(applyEdit(folded, e.edit), SRC,
            `${h.title} did not come back exactly`);
    }
});

test('A LINE THAT WAS ALREADY A COMMENT COMES BACK AS THE COMMENT IT WAS', () => {
    // The reason for a prefix rather than a bare `%`: with `%` there is no way
    // to tell the author's own comment from one we added, so expanding either
    // loses their `%` or leaves ours behind.
    const c = collapseSection({ lines: lines(), ...H1 });
    const folded = applyEdit(lines(), c.edit);
    assert.ok(folded.some(l => l === PREFIX + '% an ordinary comment of the author\'s'),
        'the author\'s comment is folded like any other line');
    const back = applyEdit(folded, expandSection({ lines: folded, headEnd: H1.headEnd }).edit);
    assert.strictEqual(back[5], '% an ordinary comment of the author\'s');
});

test('THE LAST SECTION NEVER COMMENTS OUT \\end{document}', () => {
    // Its span runs to the end of the file. Folding that would produce a paper
    // that does not compile at all — from a gesture meant to shorten it.
    const c = collapseSection({ lines: lines(), ...H3 });
    assert.ok(c.ok, c.reason);
    const folded = applyEdit(lines(), c.edit);
    assert.ok(folded.includes('\\end{document}'), '\\end{document} is still there, uncommented');
    assert.ok(!folded.some(l => l.startsWith(PREFIX) && /end\{document\}/.test(l)));
    assert.strictEqual(c.edit.endLine, 19, 'the edit stops above it');
});

test('the heading itself is never folded — it is what the control hangs on', () => {
    const c = collapseSection({ lines: lines(), ...H1 });
    const folded = applyEdit(lines(), c.edit);
    assert.strictEqual(folded[3], '\\section{The pairing}');
    assert.ok(folded[4].startsWith(MARK), 'the marker sits directly under it');
    assert.ok(/11 lines/.test(folded[4]), 'and says how much is hidden: ' + folded[4]);
    assert.ok(/The pairing/.test(folded[4]), 'and which section it is');
});

test('A SECTION INSIDE A COLLAPSED ONE IS REFUSED, NOT NESTED', () => {
    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    // The subsection's own lines are now prefixed; folding it again would
    // double the prefixes and need two expands to undo one collapse.
    const again = collapseSection({ lines: folded, ...H2 });
    assert.strictEqual(again.ok, false);
    assert.ok(/already collapsed/.test(again.reason), again.reason);
});

test('collapsing twice is refused, and expanding what is not folded is too', () => {
    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    assert.strictEqual(collapseSection({ lines: folded, ...H1 }).ok, false);
    assert.strictEqual(expandSection({ lines: lines(), headEnd: H1.headEnd }).ok, false);
});

test('a section with nothing in it says so instead of folding air', () => {
    const empty = ['\\begin{document}', '\\section{Empty}', '', '\\section{Next}', 'x', '\\end{document}'];
    const r = collapseSection({ lines: empty, headEnd: 2, spanEnd: 3, title: 'Empty' });
    assert.strictEqual(r.ok, false);
    assert.ok(/empty/.test(r.reason), r.reason);
});

test('the state is readable from the file alone', () => {
    const heads = [
        { key: 'a', headEnd: 4 }, { key: 'b', headEnd: 13 }, { key: 'c', headEnd: 16 },
    ];
    assert.deepStrictEqual(collapsedSections(SRC, heads), [], 'nothing folded to begin with');

    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    const found = collapsedSections(folded, [{ key: 'a', headEnd: 4 }]);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].hidden, 11, 'and how many lines are hidden');
    assert.ok(/The pairing/.test(found[0].note));

    const st = collapseStateAt(folded, 4);
    assert.strictEqual(st.collapsed, true);
    assert.strictEqual(st.markerLine, 5);
});

test('a multi-line heading is folded from BELOW its last line', () => {
    const src = [
        '\\begin{document}',
        '\\section{A title that runs',
        '  across two lines}',
        'The body.',
        'More body.',
        '\\end{document}',
    ];
    const c = collapseSection({ lines: src, headEnd: 3, spanEnd: 5, title: 'A title' });
    assert.ok(c.ok, c.reason);
    const folded = applyEdit(src, c.edit);
    assert.strictEqual(folded[1], '\\section{A title that runs', 'the heading is intact');
    assert.strictEqual(folded[2], '  across two lines}', 'both lines of it');
    assert.ok(folded[3].startsWith(MARK));
    assert.deepStrictEqual(applyEdit(folded, expandSection({ lines: folded, headEnd: 3 }).edit), src);
});

test('a reader who deletes some folded lines by hand still gets the rest back', () => {
    // The run of prefixed lines IS the region — there is no end marker to be
    // out of step with, so a hand-edited fold degrades instead of breaking.
    let folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    folded = folded.filter((l, i) => i !== 7);            // they deleted one
    const e = expandSection({ lines: folded, headEnd: 4 });
    assert.ok(e.ok);
    const back = applyEdit(folded, e.edit);
    assert.ok(!back.some(l => l.startsWith(PREFIX)), 'nothing prefixed is left behind');
    assert.ok(!back.some(l => l.startsWith(MARK)), 'and the marker is gone');
});

test('nothing here throws on nonsense', () => {
    assert.doesNotThrow(() => collapseSection({}));
    assert.doesNotThrow(() => expandSection({}));
    assert.doesNotThrow(() => collapsedSections(null, null));
    assert.strictEqual(collapseSection({ lines: [], headEnd: 5 }).ok, false);
    assert.strictEqual(collapseSection({ lines: lines(), headEnd: 0 }).ok, false);
});

(async () => {
    console.log('folding a section away, executed\n');
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
