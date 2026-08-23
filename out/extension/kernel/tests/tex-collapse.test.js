// tex-collapse.test.js — folding a section away, without touching the paper.
//
// The state is written into the .tex as two comment lines; the commenting-out
// happens only in the temporary copy WPaper compiles. So the properties are,
// in order of how much damage it does when they fail:
//
//   1. THE SHARED FILE KEEPS ITS CONTENT. Folding adds two comments and moves
//      not one character of the body — a colleague on Overleaf sees the whole
//      paper, which is the entire reason this is not done in the file.
//   2. THE TEMPORARY COPY IS LINE-FOR-LINE with the original. The render map
//      records source line numbers; a copy whose lines had shifted would put
//      every click on the page a few lines out.
//   3. ROUND TRIP IS EXACT, and \end{document} is never inside a fold.

const assert = require('assert');
const {
    MARK, MARK_END, PREFIX, collapseSection, expandSection, applyEdit, collapseStateAt,
    collapsedSections, bodyEndLine, foldForCompile,
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
    '',                                      // 7
    '\\begin{equation}',                     // 8
    '  E = mc^2',                            // 9
    '\\end{equation}',                       // 10
    '',                                      // 11
    '\\subsection{The upper tower}',         // 12
    'Subsection prose.',                     // 13
    '',                                      // 14
    '\\section{The measure}',                // 15
    'The last section, which runs to the end.', // 16
    '',                                      // 17
    '\\end{document}',                       // 18
];
const lines = () => SRC.slice();

// The three headings, as the model reports them.
const H1 = { headStart: 4, headEnd: 4, spanEnd: 14, title: 'The pairing' };
const H2 = { headStart: 12, headEnd: 12, spanEnd: 14, title: 'The upper tower' };
const H3 = { headStart: 15, headEnd: 15, spanEnd: 18, title: 'The measure' };

test('the end of the document is found, whatever follows it', () => {
    assert.strictEqual(bodyEndLine(SRC), 17, 'the last line that is ours to fold');
    assert.strictEqual(bodyEndLine(['a', 'b']), 2, 'a fragment with no \\end{document} is all body');
});

test('FOLDING ADDS TWO COMMENTS AND MOVES NOT ONE CHARACTER OF THE BODY', () => {
    // The whole point: the .tex is shared. A colleague opening it, or Overleaf
    // compiling it, must see every section — a fold is one reader's view.
    for (const h of [H1, H2, H3]) {
        const c = collapseSection({ lines: lines(), ...h });
        assert.ok(c.ok, `${h.title}: ${c.reason}`);
        const folded = applyEdit(lines(), c.edit);
        assert.strictEqual(folded.length, SRC.length + 2, `${h.title}: exactly two lines added`);
        assert.ok(!folded.some(l => l.startsWith(PREFIX)),
            `${h.title}: NOTHING in the file is commented out`);
        const kept = folded.filter(l => !l.startsWith(MARK) && !l.startsWith(MARK_END));
        assert.deepStrictEqual(kept, SRC, `${h.title}: the body is untouched`);
    }
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

test('THE TEMPORARY COPY IS LINE-FOR-LINE WITH THE ORIGINAL', () => {
    // The render map records source line numbers. A copy that DELETED the
    // folded lines would be shorter, and every click below the fold would
    // resolve a few lines out — the failure this whole workstream exists to
    // remove.
    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    const compiled = foldForCompile(folded.join('\n')).split('\n');
    assert.strictEqual(compiled.length, folded.length, 'same number of lines');
    for (let i = 0; i < folded.length; i++) {
        const a = folded[i]; const b = compiled[i];
        assert.ok(b === a || b === PREFIX + a,
            `line ${i + 1} is either itself or itself commented: ${JSON.stringify([a, b])}`);
    }
});

test('THE TEMPORARY COPY IS WHERE THE CONTENT ACTUALLY GOES AWAY', () => {
    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    const compiled = foldForCompile(folded.join('\n'));
    assert.ok(/^%WP%First prose line\.$/m.test(compiled), 'prose is commented');
    assert.ok(/^%WP%\\begin\{equation\}$/m.test(compiled), 'and so is an equation');
    assert.ok(/^%WP%\\subsection\{The upper tower\}$/m.test(compiled),
        'a subsection inside it goes with it');
    assert.ok(/^%WP%% an ordinary comment of the author's$/m.test(compiled),
        'the author\'s own comment is folded like any other line');
    // And nothing outside it is.
    assert.ok(/^\\section\{The pairing\}$/m.test(compiled), 'the heading still typesets');
    assert.ok(/^\\section\{The measure\}$/m.test(compiled), 'the next section is untouched');
    assert.ok(/^The last section, which runs to the end\.$/m.test(compiled));
});

test('a file with no folds is handed back unchanged', () => {
    const plain = SRC.join('\n');
    assert.strictEqual(foldForCompile(plain), plain, 'the common case costs nothing');
});

test('TWO SEPARATE FOLDS BOTH APPLY, AND NEITHER LEAKS INTO THE OTHER', () => {
    // Bottom-up, so the first edit does not move the second's line numbers.
    let l = applyEdit(lines(), collapseSection({ lines: lines(), ...H3 }).edit);
    l = applyEdit(l, collapseSection({ lines: l, ...H1 }).edit);
    const compiled = foldForCompile(l.join('\n'));
    assert.ok(/^%WP%First prose line\.$/m.test(compiled), 'the first fold applies');
    assert.ok(/^%WP%The last section, which runs to the end\.$/m.test(compiled), 'and so does the second');
    assert.ok(/^\\section\{The measure\}$/m.test(compiled), 'both headings still typeset');
    assert.ok(/^\\end\{document\}$/m.test(compiled), 'and the document still ends');
});

test('AN UNCLOSED FOLD HIDES NOTHING — a half-deleted marker must not eat the paper', () => {
    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    const broken = folded.filter(l => !l.startsWith(MARK_END));
    assert.strictEqual(collapseStateAt(broken, H1.headEnd).collapsed, false,
        'without its closing marker the section is simply not folded');
    const compiled = foldForCompile(broken.join('\n'));
    assert.ok(/^First prose line\.$/m.test(compiled), 'and nothing is commented out');
    assert.ok(/^\\end\{document\}$/m.test(compiled));
});

test('THE LAST SECTION NEVER FOLDS \\end{document} AWAY', () => {
    // Its span runs to the end of the file. A closing marker below
    // \end{document} would comment it out of the compiled copy — a paper that
    // does not compile at all, from a gesture meant to shorten it.
    const c = collapseSection({ lines: lines(), ...H3 });
    assert.ok(c.ok, c.reason);
    const folded = applyEdit(lines(), c.edit);
    const at = folded.indexOf('\\end{document}');
    const endMark = folded.findIndex(l => l.startsWith(MARK_END));
    assert.ok(endMark > 0 && endMark < at, 'the closing marker sits ABOVE it');
    const compiled = foldForCompile(folded.join('\n'));
    assert.ok(/^\\end\{document\}$/m.test(compiled), 'so the document still ends');
});

test('the heading itself is never folded — it is what the control hangs on', () => {
    const c = collapseSection({ lines: lines(), ...H1 });
    const folded = applyEdit(lines(), c.edit);
    assert.strictEqual(folded[3], '\\section{The pairing}');
    assert.ok(folded[4].startsWith(MARK), 'the marker sits directly under it');
    assert.ok(/The pairing/.test(folded[4]), 'and says which section it is');
    assert.strictEqual(c.hidden, 10, 'the count is reported, not written into the file');
    const compiled = foldForCompile(folded.join('\n'));
    assert.ok(/^\\section\{The pairing\}$/m.test(compiled), 'and it still typesets');
});

test('A SECTION THAT ALREADY CONTAINS A FOLD IS REFUSED, NOT NESTED', () => {
    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H2 }).edit);
    // H1 encloses H2, which is now folded: nesting the two would make one
    // expand leave the other's markers stranded in the middle of the body.
    const again = collapseSection({ lines: folded, headEnd: 4, spanEnd: 16, title: 'The pairing' });
    assert.strictEqual(again.ok, false);
    assert.ok(/already contains a fold/.test(again.reason), again.reason);
});

test('folding twice is refused, and expanding what is not folded is too', () => {
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
    const heads = [{ key: 'a', headEnd: 4 }, { key: 'b', headEnd: 12 }, { key: 'c', headEnd: 15 }];
    assert.deepStrictEqual(collapsedSections(SRC, heads), [], 'nothing folded to begin with');

    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    const found = collapsedSections(folded, [{ key: 'a', headEnd: 4 }]);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].hidden, 10, 'and how many lines are hidden');
    assert.ok(/The pairing/.test(found[0].note));

    const st = collapseStateAt(folded, 4);
    assert.strictEqual(st.collapsed, true);
    assert.strictEqual(st.markerLine, 5);
    assert.ok(st.endLine > st.markerLine);
});

test('THE HIDDEN COUNT FOLLOWS THE TEXT, because nothing about it is written down', () => {
    // The marker says only THAT the section is folded. The count on the badge
    // is derived from the region every time, so editing inside a folded
    // section — which the reader can still do in the editor — never leaves a
    // number in the file disagreeing with what is there.
    const folded = applyEdit(lines(), collapseSection({ lines: lines(), ...H1 }).edit);
    assert.strictEqual(collapseStateAt(folded, 4).hidden, 10);
    folded.splice(6, 0, 'A line the reader added inside the fold.');
    assert.strictEqual(collapseStateAt(folded, 4).hidden, 11);
    assert.ok(foldForCompile(folded.join('\n')).includes(PREFIX + 'A line the reader added inside the fold.'),
        'and it is folded away like the rest');
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

test('nothing here throws on nonsense', () => {
    assert.doesNotThrow(() => collapseSection({}));
    assert.doesNotThrow(() => expandSection({}));
    assert.doesNotThrow(() => collapsedSections(null, null));
    assert.strictEqual(foldForCompile(null), '');
    assert.strictEqual(foldForCompile(undefined), '');
    assert.doesNotThrow(() => foldForCompile(MARK));           // an unclosed marker
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
