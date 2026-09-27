const { test } = require('node:test');
const assert = require('node:assert/strict');
const { caretAt, keyEdit, proseAt } = require('../../tex/inkEdit');

/** Apply keyEdit to text with the caret at `|`; returns the new text with `|`. */
function type(marked, key) {
    const offset = marked.indexOf('|');
    const text = marked.replace('|', '');
    const edit = keyEdit(text, offset, key);
    if (!edit) return null;
    const next = edit.insert !== undefined ? text.slice(0, edit.start) + edit.insert + text.slice(edit.end) : text;
    return next.slice(0, edit.caret) + '|' + next.slice(edit.caret);
}

test('typed characters are what the reader sees', () => {
    assert.equal(type('ab|c', 'x'), 'abx|c');
    assert.equal(type('50|', '%'), '50\\%|');
    assert.equal(type('A|B', '&'), 'A\\&|B');
    assert.equal(type('a|', '~'), 'a\\textasciitilde{}|');
    assert.equal(type('end.|', 'Enter'), 'end.\n\n|');
    assert.equal(type('a|', 'é'), 'aé|');
});

test('Backspace deletes what is seen, never half a command', () => {
    assert.equal(type('word|', 'Backspace'), 'wor|');
    assert.equal(type('two  |words', 'Backspace'), 'two|words');
    assert.equal(type('end.\n\n|Next', 'Backspace'), 'end. |Next');
    assert.equal(type('line\n|next', 'Backspace'), 'line|next');
    assert.equal(type('50\\%|', 'Backspace'), '50|');
    assert.equal(type('the \\LaTeX| book', 'Backspace'), 'the | book');
    assert.equal(type('the \\LaTeX{}| book', 'Backspace'), 'the | book');
    // Inside formatting: the letter goes, the caret stays after the group.
    assert.equal(type('an \\emph{word}| here', 'Backspace'), 'an \\emph{wor}| here');
    // The last letter of a group takes the command with it.
    assert.equal(type('an \\emph{w}| here', 'Backspace'), 'an | here');
    // At the start of a group: the character before the command.
    assert.equal(type('an\\emph{|word}', 'Backspace'), 'a\\emph{|word}');
    // Maths and a line break are not deleted from the page.
    assert.equal(type('$x$|', 'Backspace'), null);
    assert.equal(type('a😀|', 'Backspace'), 'a|');
});

test('Delete mirrors Backspace', () => {
    assert.equal(type('|word', 'Delete'), '|ord');
    assert.equal(type('two|  words', 'Delete'), 'two|words');
    assert.equal(type('end.|\n\nNext', 'Delete'), 'end.| Next');
    assert.equal(type('|\\%50', 'Delete'), '|50');
    assert.equal(type('|\\LaTeX{} book', 'Delete'), '| book');
    assert.equal(type('an |\\emph{word}', 'Delete'), 'an |\\emph{ord}');
    assert.equal(type('an |\\emph{w} x', 'Delete'), 'an | x');
    assert.equal(type('|$x$', 'Delete'), null);
    assert.equal(type('|😀b', 'Delete'), '|b');
});

test('the page is typed in only where it shows prose', () => {
    const doc = '\\documentclass{article}\n\\newcommand{\\x}{y}\n\\begin{document}\nSome \\emph{prose} and $x+y$ here.\n' +
        '\\begin{equation}\na=b\n\\end{equation}\n% a comment\n\\begin{verbatim}\ncode\n\\end{verbatim}\nAfter \\[ z \\] end.\n\\end{document}\n';
    const at = s => doc.indexOf(s);
    assert.equal(proseAt(doc, at('newcommand')), false, 'the preamble');
    assert.equal(proseAt(doc, at('Some') + 2), true, 'prose');
    assert.equal(proseAt(doc, at('prose}') + 2), true, 'a formatted word');
    assert.equal(proseAt(doc, at('emph') + 2), false, 'inside a command name');
    assert.equal(proseAt(doc, at('x+y') + 1), false, 'inline maths');
    assert.equal(proseAt(doc, at('a=b') + 1), false, 'display maths');
    assert.equal(proseAt(doc, at('a comment') + 2), false, 'a comment');
    assert.equal(proseAt(doc, at('code') + 1), false, 'verbatim');
    assert.equal(proseAt(doc, at(' z ') + 1), false, 'display maths with \\[');
    assert.equal(proseAt(doc, at('end.') + 1), true, 'prose after display maths');
});

test('the caret sits between the glyphs typed around its column', () => {
    // "ab cd" on line 5: glyphs a b | c d, one row, 5 pt wide each.
    const glyph = (col, x) => ({ page: 2, row: 7, x, y: 100, w: 5, boxHeight: 10,
        hit: { preferred_source: { location: { accuracy: 'Exact', start: { line: 5, column_utf16: col }, end: { line: 5, column_utf16: col + 1 } } } } });
    const entries = [glyph(0, 10), glyph(1, 15), glyph(3, 25), glyph(4, 30)];
    const line = 'ab cd';
    assert.deepEqual(caretAt(entries, 5, 0, line), { page: 2, x: 10, y: 100, h: 10, row: 7 });
    assert.equal(caretAt(entries, 5, 1, line).x, 15);
    assert.equal(caretAt(entries, 5, 2, line).x, 20, 'after the last letter of a word');
    assert.equal(caretAt(entries, 5, 3, line).x, 25, 'after the space: the next word');
    assert.equal(caretAt(entries, 5, 5, line).x, 35, 'the end of the line');
    // A ligature: one glyph for two characters.
    const fi = [{ ...glyph(0, 10), w: 8, hit: { preferred_source: { location: { accuracy: 'Exact', start: { line: 5, column_utf16: 0 }, end: { line: 5, column_utf16: 2 } } } } }];
    assert.equal(caretAt(fi, 5, 1, 'fi').x, 14);
    assert.equal(caretAt([], 5, 0, line), null);
});

test('a click in maths opens the card, not the ink caret', () => {
    const { mathAt } = require('../../tex/inkEdit');
    const d = '\\documentclass{a}\\begin{document}\nText $x+y$ here \\[ z \\] and\n\\begin{equation}\na=b\n\\end{equation}\nend\\\\[2mm] x\n\\end{document}';
    const at = w => mathAt(d, d.indexOf(w) + 1);
    assert.equal(at('Text'), false);
    assert.equal(at('x+y'), true, 'inline');
    assert.equal(at(' z '), true, 'display \\[');
    assert.equal(at('a=b'), true, 'an equation environment');
    assert.equal(at(' x'), false, 'a \\\\[2mm] line break is not maths');
});
