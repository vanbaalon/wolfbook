const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../../tex/tikzModel');

const apply = (text, edits) => [...edits].sort((a, b) => b.start - a.start)
    .reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), text);

const DOC = [
    '\\documentclass{article}',
    '\\usepackage{tikz}',
    '\\begin{document}',
    '\\begin{tikzpicture}[scale=0.5, thick]',
    '  \\node[dynkin even] (n1) at (0,0) {};',
    '  \\node (n2) [draw] at (1.5, -2cm) {$\\alpha$}; % a comment; with (x) in it',
    '  \\coordinate (c) at (3,0);',
    '  \\draw[dynkin double] (n1) -- (n2);',
    '  \\draw (0,0) -- (1,1) node[above] {x};',
    '  \\foreach \\x in {1,2} { \\draw (\\x,0) circle (0.1); }',
    '  \\tikzset{foo/.style={red}}',
    '  \\begin{feynman}',
    '    \\vertex [dot] (a) at (0,1);',
    '    \\diagram* { (a) -- [photon, momentum=\\(q\\)] (n1) };',
    '  \\end{feynman}',
    '\\end{tikzpicture}',
    '\\end{document}',
    '',
].join('\n');

test('a picture parses into statements with names, coordinates and references', () => {
    const p = t.parsePicture(DOC, DOC.indexOf('\\begin{tikzpicture}'));
    assert.equal(p.scale, 0.5);
    const kinds = p.statements.map(s => `${s.kind}:${s.name?.value || ''}`);
    assert.deepEqual(kinds, ['node:n1', 'node:n2', 'coordinate:c', 'draw:', 'draw:', 'foreach:', 'setting:', 'vertex:a', 'diagram:']);
    const [n1, n2, c, edge, path, loop, , a, diagram] = p.statements;
    assert.deepEqual([n1.at.x, n1.at.y, n2.at.x, n2.at.y, c.at.x], [0, 0, 1.5, -2, 3]);
    assert.deepEqual(n1.options.items, ['dynkin even']);
    assert.equal(DOC.slice(n2.label.start, n2.label.end), '$\\alpha$');
    assert.ok(n2.text.endsWith(';'), 'the comment after the statement is not part of it');
    assert.deepEqual(edge.refs, ['n1', 'n2']);
    assert.deepEqual(path.coords.map(k => [k.x, k.y]), [[0, 0], [1, 1]]);
    assert.ok(loop.text.startsWith('\\foreach') && loop.text.endsWith('}'));
    assert.equal(a.kind, 'vertex');
    assert.deepEqual(diagram.refs, ['a', 'n1']);
    assert.ok(p.feynman && DOC.slice(p.feynman.bodyEnd).startsWith('\\end{feynman}'));
    assert.equal(t.statementAtOffset(p, n2.start + 5), n2);
    assert.deepEqual(t.dependents(p, 'n1'), [edge, diagram]);
});

test('moving a node rewrites its coordinates; other statements get a shift', () => {
    const p = t.parsePicture(DOC, DOC.indexOf('\\begin{tikzpicture}'));
    const [n1, n2, , edge, path] = p.statements;
    assert.match(apply(DOC, [t.moveEdit(n1, 1, -0.25)]), /\\node\[dynkin even\] \(n1\) at \(1,-0\.25\) \{\};/);
    assert.match(apply(DOC, [t.moveEdit(n2, 0.5, 2)]), /at \(2,0\) \{\$\\alpha\$\}/);
    assert.match(apply(DOC, [t.moveEdit(path, 1, 0)]), /\\draw\[shift=\{\(1,0\)\}\] \(0,0\) -- \(1,1\)/);
    const once = apply(DOC, [t.moveEdit(edge, 1, 0)]);
    const again = t.parsePicture(once, once.indexOf('\\begin{tikzpicture}')).statements[3];
    assert.match(apply(once, [t.moveEdit(again, -1, 0)]), /\\draw\[dynkin double\] \(n1\) -- \(n2\);/, 'shifts merge and cancel');
    assert.equal(apply(DOC, [t.placeEdit(n1, 2, 3)]).includes('(n1) at (2,3)'), true);
});

test('options are set, replaced and removed; unnamed nodes get names', () => {
    const p = t.parsePicture(DOC, DOC.indexOf('\\begin{tikzpicture}'));
    const [n1, , , , path] = p.statements;
    assert.match(apply(DOC, [t.setOptionEdit(n1, 'fill', 'red')]), /\\node\[dynkin even, fill=red\] \(n1\)/);
    assert.match(apply(DOC, [t.setOptionEdit(path, 'dashed', true, ['dotted'])]), /\\draw\[dashed\] \(0,0\)/);
    assert.match(apply(DOC, [t.setOptionEdit(n1, 'dynkin even', null)]), /\\node \(n1\) at/);
    const text = 'x\\begin{tikzpicture}\\node[draw] at (1,1) {A};\\node (n1) at (0,0) {};\\end{tikzpicture}';
    const q = t.parsePicture(text, 1);
    assert.equal(t.freshName(q), 'n2');
    assert.match(apply(text, [t.nameEdit(q.statements[0], 'n2')]), /\\node\[draw\] \(n2\) at \(1,1\)/);
});

test('new statements go before the end of the picture or of its feynman environment', () => {
    const p = t.parsePicture(DOC, DOC.indexOf('\\begin{tikzpicture}'));
    const plain = apply(DOC, t.insertEdits(DOC, p, ['\\draw (0,0) -- (1,0);']));
    assert.match(plain, /  \\end\{feynman\}\n  \\draw \(0,0\) -- \(1,0\);\n\\end\{tikzpicture\}/);
    const feyn = apply(DOC, t.insertEdits(DOC, p, ['\\vertex (b) at (2,1);'], { feynman: true }));
    assert.match(feyn, /\\diagram\* \{[^\n]*\};\n    \\vertex \(b\) at \(2,1\);\n  \\end\{feynman\}/);
    // A picture without a feynman environment gets one around feynman items.
    const bare = '\\begin{tikzpicture}\n  \\draw (0,0);\n\\end{tikzpicture}';
    const b = t.parsePicture(bare, 0);
    assert.equal(apply(bare, t.insertEdits(bare, b, ['\\vertex (a) at (0,0);'], { feynman: true })),
        '\\begin{tikzpicture}\n  \\draw (0,0);\n  \\begin{feynman}\n    \\vertex (a) at (0,0);\n  \\end{feynman}\n\\end{tikzpicture}');
    // CRLF documents stay CRLF.
    const crlf = bare.replace(/\n/g, '\r\n');
    const c = t.parsePicture(crlf, 0);
    assert.equal(apply(crlf, t.insertEdits(crlf, c, ['\\draw (1,1);'])), '\\begin{tikzpicture}\r\n  \\draw (0,0);\r\n  \\draw (1,1);\r\n\\end{tikzpicture}');
});

test('deleting takes the line; duplicates are renamed and keep their internal edges', () => {
    const p = t.parsePicture(DOC, DOC.indexOf('\\begin{tikzpicture}'));
    const [n1, n2, , edge] = p.statements;
    assert.ok(!apply(DOC, [t.deleteEdit(DOC, n1)]).includes('(n1) at'));
    assert.match(apply(DOC, [t.deleteEdit(DOC, n1)]), /\\begin\{tikzpicture\}\[scale=0\.5, thick\]\n  \\node \(n2\)/);
    const copies = t.duplicateLines(p, [n1, n2, edge], 1, 0);
    assert.deepEqual(copies, [
        '\\node[dynkin even] (n3) at (1,0) {};',
        '\\node (n4) [draw] at (2.5,-2) {$\\alpha$};',
        '\\draw[dynkin double] (n3) -- (n4);',
    ]);
});

test('the preamble gets what the picture needs, once, in a marked block', () => {
    const doc = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nx\n\\end{document}\n';
    const once = apply(doc, t.preambleEdits(doc, { dynkin: true }));
    assert.match(once, /% WPaper TikZ styles[^\n]*\n\\usepackage\{tikz\}\n\\usetikzlibrary\{arrows\.meta,decorations\.markings\}\n\\tikzset\{\n  dynkin even\/\.style=/);
    assert.deepEqual(t.preambleEdits(once, { dynkin: true }), [], 'idempotent');
    const feyn = apply(once, t.preambleEdits(once, { feynman: true }));
    assert.match(feyn, /\\usepackage\[compat=1\.1\.0\]\{tikz-feynman\}\n\\tikzfeynmanset\{warn luatex=false\}\n% end of WPaper TikZ styles/,
        'additions go into the existing block');
    assert.deepEqual(t.preambleEdits(feyn, { feynman: true, tikz: true }), []);
    // A paper that already loads tikz and some libraries only gets the rest.
    const own = '\\documentclass{article}\n\\usepackage{tikz}\n\\usetikzlibrary{arrows.meta}\n\\begin{document}\n\\end{document}';
    assert.match(apply(own, t.preambleEdits(own, { libraries: ['arrows.meta', 'decorations.pathmorphing'] })),
        /\\usetikzlibrary\{decorations\.pathmorphing\}/);
});
