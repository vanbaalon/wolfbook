'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildComparison } = require('../../tex/texCompare');
const { refineHunk } = require('../../tex/texDiff');
const { ReviewSession } = require('../../tex/reviewSession');
const { contentTokens, contentKey } = require('../../tex/reviewContent');
const compare = (a,b,options={}) => buildComparison({ourText:a,theirText:b,...options});

test('indentation, repeated spaces, blank lines and paragraph reflow create no review items', () => {
    const a='The transfer matrix has a fixed spectrum.\nIt closes the system.\n';
    const b='  The  transfer\n matrix has a fixed spectrum.\n\n\tIt closes   the system.  \n\n';
    const result=compare(a,b);
    assert.equal(result.summary.total,0);
    assert.deepEqual(result.hunks,[]);
    assert.deepEqual(refineHunk(a,b).aRanges,[]);
});

test('ordinary spacing inside inline and multiline math creates no review items', () => {
    for (const [a,b] of [
        ['$a+b=\\alpha x$','$ a + b = \\alpha   x $'],
        ['\\begin{align}\na_i&=b_j+c\\\\\nx&=y\n\\end{align}',
         '\\begin{align}\n  a_i & = b_j + c \\\\\n\n x & = y\n\\end{align}'],
        ['\\[a b = cd\\]','\\[ab= c d\\]'],
    ]) assert.equal(compare(a,b).summary.total,0,`${a} versus ${b}`);
});

test('formatting noise does not use the comparison limit or create bookmarks alongside real edits', () => {
    const a='  First paragraph.\n\nUnchanged anchor.\n\nActual new result.\n\nLast paragraph.';
    const b='First paragraph.\nUnchanged anchor.\n\nActual old result.\n\n  Last paragraph.';
    const result=compare(a,b,{limit:1});
    assert.equal(result.summary.total,1);
    assert.equal(result.summary.shown,1);
    assert.match(result.hunks[0].ourText,/Actual new result/);
});

test('text, formula, command, explicit-spacing and text-in-math changes stay visible', () => {
    for (const [a,b] of [
        ['The value is positive.','The value is negative.'],
        ['two words','twowords'],
        ['$a_i+b$','$a_j+b$'],
        ['$\\alpha x$','$\\alphax$'],
        ['$a\\,b$','$ab$'],
        ['$a\\ b$','$ab$'],
        ['$\\text{two words}$','$\\text{twowords}$'],
        ['a~b','a b'],
        ['a\\% b','a b'],
    ]) assert.ok(compare(a,b).summary.total>0,`${a} versus ${b}`);
});

test('literal text preserves spaces and newlines', () => {
    for (const [a,b] of [
        ['\\verb|a b|','\\verb|a  b|'],
        ['\\begin{verbatim}\na b\n\\end{verbatim}','\\begin{verbatim}\na  b\n\\end{verbatim}'],
        ['\\begin{verbatim}\na b\n\\end{verbatim}','\\begin{verbatim}\na b  \n\\end{verbatim}'],
        ['{\\obeyspaces a b}','{\\obeyspaces a  b}'],
    ]) assert.ok(compare(a,b).summary.total>0);
});

test('mixed formatting does not mark unchanged words split across a comment', () => {
    const a='The word% a source note\nrest is old.',b='The wordrest is new.';
    const r=refineHunk(a,b);
    const changed=(text,ranges)=>ranges.map(r=>text.split('\n')[r.line].slice(r.col,r.col+r.len));
    assert.deepEqual(changed(a,r.aRanges),['old']);
    assert.deepEqual(changed(b,r.bRanges),['new']);
});

test('mixed paragraph highlights exclude equivalent formula spacing', () => {
    const a='The old result is $a+b$.', b='The new result is $ a + b $.';
    const r=refineHunk(a,b);
    const changed = (text,ranges) => ranges.map(r=>text.split('\n')[r.line].slice(r.col,r.col+r.len));
    assert.deepEqual(changed(a,r.aRanges),['old']);
    assert.deepEqual(changed(b,r.bRanges),['new']);
});

test('a fragment inside a multiline math environment uses the enclosing math context', () => {
    const a='\\begin{equation}\na+b=1\n\\end{equation}',
        b='\\begin{equation}\na + b = 2\n\\end{equation}';
    const [h]=compare(a,b).hunks;
    const r=refineHunk(h.ourText,h.theirText,h.wordContext);
    assert.deepEqual(r.aRanges.map(r=>h.ourText.slice(r.col,r.col+r.len)),['1']);
    assert.deepEqual(r.bRanges.map(r=>h.theirText.slice(r.col,r.col+r.len)),['2']);
});

test('formatting-only changes disappear after restoring a persisted review', () => {
    const s=new ReviewSession({file:'/paper.tex',baseText:'The result is $a+b$.\n'});
    s.noteBatch({source:'paper_applyEdit'});
    s.update({currentText:'  The  result is $ a + b $.\n\n'});
    const restored=ReviewSession.restore(s.serialize());
    const result=restored.update({currentText:'  The  result is $ a + b $.\n\n'});
    assert.equal(result.summary.total,0);
    assert.equal(restored.pendingCount,0);
    assert.equal(restored.payload().pending,0);
});

test('comment newlines are consumed while escaped percent signs stay text', () => {
    const key=text=>contentKey(contentTokens(text));
    assert.equal(key('word% comment\nrest'),key('wordrest'));
    assert.equal(key('word% another comment\nrest'),key('wordrest'));
    assert.notEqual(key('word\\%rest'),key('wordrest'));
});

test('ignored formatting keeps reader typing and undo offsets correct', () => {
    const base='First line.\n\nStable anchor.\n\nThe old result.\n\nLast line.';
    const current='  First  line.\n\n\nStable anchor.\n\nThe new result.\n\nLast line.';
    const s=new ReviewSession({file:'/paper.tex',baseText:base});
    s.noteBatch({source:'paper_applyEdit'});
    s.update({currentText:current});
    assert.equal(s.pendingCount,1);
    assert.ok(s.baseText.startsWith('  First  line.\n\n\n'));
    const at=current.indexOf('Last line.');
    assert.ok(s.noteReaderEdit({offset:at,length:0,text:'My '}));
    const typed=current.slice(0,at)+'My '+current.slice(at);
    s.update({currentText:typed});
    assert.equal(s.pendingCount,1);
    const undo=s.undoAll(), lines=typed.split('\n');
    for (const edit of undo.edits) lines.splice(edit.startLine-1,edit.endLine-edit.startLine,...edit.lines);
    assert.equal(lines.join('\n'),current.replace('The new result.','The old result.').replace('Last line.','My Last line.'));
});
