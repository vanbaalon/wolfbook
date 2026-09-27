const { test } = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('../../tex/texFormat');

/** Apply a format to `[`…`]` (a selection) or `|` (a caret) in `marked`. */
function apply(marked, kind) {
    const caret = marked.indexOf('|');
    const start = caret >= 0 ? caret : marked.indexOf('[');
    const text = marked.replace('|', '').replace('[', '').replace(']', '');
    const end = caret >= 0 ? caret : marked.indexOf(']') - 1;
    const r = format(text, start, end, kind);
    if (r.error) return { error: r.error };
    const next = r.insert !== undefined ? text.slice(0, r.start) + r.insert + text.slice(r.end) : text;
    if (r.select) return next.slice(0, r.select[0]) + '[' + next.slice(r.select[0], r.select[1]) + ']' + next.slice(r.select[1]);
    return next.slice(0, r.caret) + '|' + next.slice(r.caret);
}

test('wrapping toggles instead of nesting', () => {
    assert.equal(apply('a [word] b', 'bold'), 'a \\textbf{[word]} b');
    assert.equal(apply('a \\textbf{[word]} b', 'bold'), 'a [word] b', 'the argument selected: off');
    assert.equal(apply('a [\\textbf{word}] b', 'bold'), 'a [word] b', 'the whole command selected: off');
    assert.equal(apply('a [word] b', 'italic'), 'a \\emph{[word]} b');
    assert.equal(apply('a [word] b', 'mono'), 'a \\texttt{[word]} b');
    assert.equal(apply('a [word] b', 'footnote'), 'a \\footnote{[word]} b');
    assert.equal(apply('a \\emph{[w]} b', 'bold'), 'a \\emph{\\textbf{[w]}} b', 'different formats combine');
});

test('a wrapper never splits a group or a paragraph', () => {
    assert.match(apply('a \\emph{wo[rd} b] c', 'bold').error, /splits a group/);
    assert.match(apply('[one.\n\ntwo]', 'bold').error, /paragraph break/);
    assert.equal(apply('[one.\n\ntwo]', 'footnote'), '\\footnote{[one.\n\ntwo]}', 'a footnote may hold paragraphs');
});

test('at the caret: open a group to type into, or step out of it', () => {
    assert.equal(apply('a | b', 'bold'), 'a \\textbf{|} b');
    assert.equal(apply('a \\textbf{wo|rd} b', 'bold'), 'a \\textbf{word}| b');
    assert.equal(apply('a \\emph{x \\textbf{y|}} b', 'bold'), 'a \\emph{x \\textbf{y}|} b');
    assert.equal(apply('a | b', 'math'), 'a $|$ b');
});

test('inline maths toggles', () => {
    assert.equal(apply('let [x] be', 'math'), 'let $[x]$ be');
    assert.equal(apply('let $[x]$ be', 'math'), 'let [x] be');
    assert.equal(apply('let [$x$] be', 'math'), 'let [x] be');
    assert.match(apply('[a $x$ b]', 'math').error, /without maths/);
});

test('heading level cycles', () => {
    assert.equal(apply('\\section{Intro|}\ntext', 'heading'), '\\subsection{Intro|}\ntext');
    assert.equal(apply('\\subsection*{Intro|}', 'heading'), '\\subsubsection*{Intro|}');
    assert.equal(apply('\\subsubsection{Intro|}', 'heading'), 'Intro|');
    assert.equal(apply('before\nIntro|\nafter', 'heading'), 'before\n\\section{Intro|}\nafter');
    assert.match(apply('\\begin{x}|', 'heading').error, /short line/);
});
