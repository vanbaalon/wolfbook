const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const S = require('../../tex/texStructure');

/** Apply a move's edit to the original text, as a WorkspaceEdit would. */
function apply(text, r) {
    const parts = [[r.deleteFrom, r.deleteTo, ''], [r.insertAt, r.insertAt, r.insertText]].sort((a, b) => b[0] - a[0]);
    for (const [a, b, t] of parts) text = text.slice(0, a) + t + text.slice(b);
    return text;
}

const PAPER = [
    '\\begin{document}',       // 1
    '\\section{A}',            // 2
    'a text',                  // 3
    '',                        // 4
    '\\section{B}',            // 5
    'b text',                  // 6
    'more b',                  // 7
    '',                        // 8
    '\\section{C}',            // 9
    'c text',                  // 10
    '\\end{document}',         // 11
    ''].join('\n');

test('a section moves before another, as one edit', () => {
    const r = S.moveLines(PAPER, 9, 10, 2);        // C before A
    assert.equal(apply(PAPER, r), r.text);
    assert.equal(r.text, '\\begin{document}\n\\section{C}\nc text\n\\section{A}\na text\n\n\\section{B}\nb text\nmore b\n\n\\end{document}\n');
    assert.equal(r.text.slice(r.start, r.end), '\\section{C}\nc text\n');
    const down = S.moveLines(PAPER, 2, 4, 9);      // A before C
    assert.equal(apply(PAPER, down), down.text);
    assert.equal(down.text, '\\begin{document}\n\\section{B}\nb text\nmore b\n\n\\section{A}\na text\n\n\\section{C}\nc text\n\\end{document}\n');
    assert.equal(S.moveLines(PAPER, 5, 8, 6), null, 'not into itself');
    assert.equal(S.moveLines(PAPER, 5, 8, 9), null, 'not where it already is');
});

const FIG = ['\\begin{document}', 'First paragraph', 'goes on.', '', 'Second.', '',
    '\\begin{figure}[htbp]', '  \\centering', '  \\includegraphics[scale=0.5,angle=90]{img/a.png}', '  \\caption{A \\emph{nice} {picture}.}', '\\end{figure}', '',
    'Third paragraph', 'line two.', '', '\\section{Next}', '\\end{document}', ''].join('\n');

test('a figure moves by paragraphs, never past a heading', () => {
    const f = S.figureAt(FIG, FIG.indexOf('includegraphics'));
    assert.equal(FIG.slice(f.start, f.end).split('\n').length, 5);
    const up = S.moveBlock(FIG, f.start, f.end, -1);
    assert.equal(apply(FIG, up), up.text);
    assert.ok(up.text.includes('goes on.\n\n\\begin{figure}'), 'above "Second."');
    assert.ok(up.text.slice(up.start, up.end).startsWith('\\begin{figure}'));
    const up2 = S.moveBlock(up.text, up.start, up.end, -1);
    assert.ok(up2.text.startsWith('\\begin{document}\n\\begin{figure}'), 'above the first paragraph');
    assert.equal(S.moveBlock(up2.text, up2.start, up2.end, -1), null, 'not above \\begin{document}');
    const down = S.moveBlock(FIG, f.start, f.end, 1);
    assert.equal(apply(FIG, down), down.text);
    assert.ok(down.text.includes('line two.\n\n\\begin{figure}'), 'below the third paragraph, apart from it');
    assert.equal(S.moveBlock(down.text, down.start, down.end, 1), null, 'not past a heading');
});

test('figure width and caption', async () => {
    const F = await import(path.resolve(__dirname, '../../../client/tex-figure.js'));
    const f = S.figureAt(FIG, FIG.indexOf('caption'));
    const fig = FIG.slice(f.start, f.end);
    const p = F.figureParts(fig);
    assert.equal(p.placement, '[htbp]');
    assert.equal(p.graphics.file, 'img/a.png');
    assert.equal(p.graphics.width, null);
    assert.equal(p.caption.text, 'A \\emph{nice} {picture}.');
    const w = F.setFigureWidth(fig, 0.6);
    assert.ok(w.includes('\\includegraphics[width=0.6\\linewidth,angle=90]{img/a.png}'), w);
    assert.equal(F.figureParts(w).graphics.width, 0.6);
    assert.ok(F.setFigureWidth(w, 1).includes('[width=\\linewidth,angle=90]'));
    assert.equal(F.figureParts(F.setFigureWidth('\\includegraphics[width=.5\\textwidth]{x}', 0.7)).graphics.unit, 'textwidth');
    const c = F.setCaption(fig, 'New $x$ caption');
    assert.equal(F.figureParts(c).caption.text, 'New $x$ caption');
    assert.ok(F.setCaption('\\begin{figure}\n  \\includegraphics{x}\n\\end{figure}', 'Cap').includes('\\includegraphics{x}\n  \\caption{Cap}\n'));
    assert.equal(S.figureAt(FIG, FIG.indexOf('Third')), null);
});

test('an image dropped on the page becomes a figure', () => {
    assert.equal(S.figureFor('img/main/paste_ab12.png'),
        '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{img/main/paste_ab12.png}\n  \\caption{}\n  \\label{fig:ab12}\n\\end{figure}\n');
});

test('a dropped figure never lands inside another block', () => {
    const doc = '\\begin{document}\nProse here.\n\\begin{figure}\n  $\\begin{array}{c}\\includegraphics{a}\\end{array}$\n  \\caption{A long\n  caption.}\n\\end{figure}\nMore prose.\n% \\begin{figure} in a comment\nEnd.\n\\end{document}\n';
    assert.equal(S.outsideEnvironments(doc, doc.indexOf('Prose')), doc.indexOf('Prose'), 'running text: where it was dropped');
    assert.equal(S.outsideEnvironments(doc, doc.indexOf('caption.}')), doc.indexOf('More prose.'), 'a caption: after its figure');
    assert.equal(S.outsideEnvironments(doc, doc.indexOf('array}{c}')), doc.indexOf('More prose.'), 'inside nested maths: after the outer figure');
    assert.equal(S.outsideEnvironments(doc, doc.indexOf('End.')), doc.indexOf('End.'), 'a commented \\begin is not a block');
});
