const { test } = require('node:test');
const assert = require('node:assert/strict');
const ed = require('../../tex/tikzEditor');
const model = require('../../tex/tikzModel');
const palette = require('../../tex/tikzPalette');

const FILE = '/p/paper.tex';
const PAPER = [
    '\\documentclass{article}',
    '\\usepackage{tikz}',
    '\\begin{document}',
    '\\begin{tikzpicture}',
    '  \\node[draw] (a) at (0,0) {A};',
    '  \\node[draw] at (2,0) {B};',
    '  \\draw (a) -- (2,0);',
    '\\end{tikzpicture}',
    '\\end{document}',
    '',
].join('\n');
const CM = ed.BP_PER_CM;

function run(op, text = PAPER) {
    const r = ed.plan({ root: FILE, picture: { file: FILE, begin: text.indexOf('\\begin{tikzpicture}') }, ...op }, { [FILE]: text });
    assert.equal(r.error, null, r.error);
    const out = ed.apply(text, r.edits[FILE] || []);
    // Undo restores the text exactly.
    assert.equal(ed.apply(out, ed.inverse(text, r.edits[FILE] || [])), text);
    return { out, r };
}
const ref = (text, k) => {
    const p = model.parsePicture(text, text.indexOf('\\begin{tikzpicture}'));
    return { start: p.statements[k].start, text: p.statements[k].text };
};

test('palette items add named statements, load what they need, and are selected', () => {
    const { out, r } = run({ op: 'add', item: 'dynkin-iso', points: [[1 * CM, 1.04 * CM]] });
    assert.match(out, /  \\node\[dynkin iso\] \(r1\) at \(1,1\) \{\};\n\\end\{tikzpicture\}/);
    assert.match(out, /% WPaper TikZ styles[\s\S]*dynkin iso\/\.style=[\s\S]*\\begin\{document\}/, 'styles in the preamble');
    assert.ok(out.slice(r.select.start).startsWith('\\node[dynkin iso] (r1)'), 'the new statement is selected');
    const feyn = run({ op: 'add', item: 'feyn-dot', points: [[0, 0]] }).out;
    assert.match(feyn, /\\usepackage\[compat=1\.1\.0\]\{tikz-feynman\}/);
    assert.match(feyn, /  \\begin\{feynman\}\n    \\vertex \[dot\] \(v1\) at \(0,0\) \{\};\n  \\end\{feynman\}\n\\end\{tikzpicture\}/);
    const line = run({ op: 'add', item: 'line', points: [[0, 0], [2 * CM, 0]] }).out;
    assert.match(line, /\\draw \(0,0\) -- \(2,0\);/);
    assert.equal(ed.plan({ root: FILE, picture: { file: FILE, begin: 0 }, op: 'add', item: 'nope' }, { [FILE]: PAPER }).error, 'unknown tool');
});

test('an edge names its nodes when they have no name', () => {
    const { out, r } = run({ op: 'edge', item: 'edge-arrow', refs: [ref(PAPER, 0), ref(PAPER, 1)] });
    assert.match(out, /\\node\[draw\] \(n1\) at \(2,0\) \{B\};/);
    assert.match(out, /\\draw\[->\] \(a\) -- \(n1\);\n\\end\{tikzpicture\}/);
    assert.ok(out.slice(r.select.start).startsWith('\\draw[->] (a) -- (n1);'));
    const feyn = run({ op: 'edge', item: 'feyn-photon', momentum: 'q', refs: [ref(PAPER, 0), ref(PAPER, 1)] }).out;
    assert.match(feyn, /\\diagram\* \{ \(a\) -- \[photon, momentum=\\\(q\\\)\] \(n1\) \};/);
    const bad = ed.plan({ root: FILE, picture: { file: FILE, begin: PAPER.indexOf('\\begin{tikzpicture}') }, op: 'edge', item: 'edge',
        refs: [ref(PAPER, 0), ref(PAPER, 2)] }, { [FILE]: PAPER });
    assert.equal(bad.error, 'edges join nodes');
});

test('moves of several statements are one edit; nodes move by their coordinates', () => {
    const { out } = run({ op: 'move', refs: [ref(PAPER, 0), ref(PAPER, 2)], deltas: [[CM, 0], [0, -CM]] });
    assert.match(out, /\\node\[draw\] \(a\) at \(1,0\) \{A\};/);
    assert.match(out, /\\draw\[shift=\{\(0,-1\)\}\] \(a\) -- \(2,0\);/);
});

test('delete takes the edges of a node with it; duplicate renames; style and reorder', () => {
    const del = run({ op: 'delete', refs: [ref(PAPER, 0)] }).out;
    assert.ok(!del.includes('(a)'), 'the node and its edge are gone');
    assert.match(del, /\\begin\{tikzpicture\}\n  \\node\[draw\] at \(2,0\) \{B\};\n\\end\{tikzpicture\}/);
    const dup = run({ op: 'duplicate', refs: [ref(PAPER, 0)], dx: CM, dy: 0 }).out;
    assert.match(dup, /  \\node\[draw\] \(a1\) at \(1,0\) \{A\};\n\\end\{tikzpicture\}/);
    const styled = run({ op: 'style', refs: [ref(PAPER, 2)], group: 'dash', value: 'dashed' }).out;
    assert.match(styled, /\\draw\[dashed\] \(a\) -- \(2,0\);/);
    const solid = run({ op: 'style', refs: [ref(styled, 2)], group: 'dash', value: 'solid' }, styled).out;
    assert.match(solid, /  \\draw \(a\) -- \(2,0\);/);
    const tip = run({ op: 'style', refs: [ref(PAPER, 2)], group: 'arrows', value: '-{Stealth}' }).out;
    assert.match(tip, /\\usetikzlibrary\{arrows\.meta\}/);
    const { out: up, r } = run({ op: 'reorder', refs: [ref(PAPER, 2)], dir: -1 });
    assert.match(up, /  \\node\[draw\] \(a\) at \(0,0\) \{A\};\n  \\draw \(a\) -- \(2,0\);\n  \\node\[draw\] at \(2,0\) \{B\};/);
    assert.ok(up.slice(r.select.start).startsWith('\\draw (a) -- (2,0);'));
});

test('inspector edits and catalogue inserts', () => {
    assert.match(run({ op: 'place', ref: ref(PAPER, 0), x: 1.5, y: -1 }).out, /\(a\) at \(1\.5,-1\)/);
    assert.match(run({ op: 'label', ref: ref(PAPER, 0), text: '$\\alpha$' }).out, /\(a\) at \(0,0\) \{\$\\alpha\$\}/);
    assert.match(run({ op: 'option', refs: [ref(PAPER, 0)], key: 'fill', value: 'yellow' }).out, /\\node\[draw, fill=yellow\] \(a\)/);
    const snake = palette.CATALOGUE.find(([s]) => s === 'Decorations')[1][0][1];
    const { out, r } = run({ op: 'insert', text: snake });
    assert.match(out, /\\usetikzlibrary\{decorations\.pathmorphing\}/);
    assert.equal(out[r.reveal.start], '•', 'the first placeholder is revealed');
});

test('a stale reference is refused, not applied elsewhere', () => {
    const stale = { start: 3, text: '\\node[draw] (zz) at (9,9) {Z};' };
    const r = ed.plan({ root: FILE, picture: { file: FILE, begin: PAPER.indexOf('\\begin{tikzpicture}') }, op: 'move', refs: [stale], dx: 1, dy: 0 }, { [FILE]: PAPER });
    assert.match(r.error, /changed/);
});

test('a new picture from a template goes where it was placed, with its packages', () => {
    const offset = PAPER.indexOf('\\end{document}');
    const r = ed.plan({ op: 'newPicture', template: 'tikzcd', file: FILE, offset, root: FILE }, { [FILE]: PAPER });
    const out = ed.apply(PAPER, r.edits[FILE]);
    assert.match(out, /\\usepackage\{tikz-cd\}/);
    assert.ok(out.slice(r.select.start).startsWith('\\begin{tikzcd}'));
    assert.equal(ed.apply(out, ed.inverse(PAPER, r.edits[FILE])), PAPER);
});

test('the chain tool adds a root and its bond in one step; moves keep every selection', () => {
    const first = run({ op: 'chain', item: 'dynkin-even', points: [[3 * CM, 0]] });
    assert.equal(first.r.created, 'r1');
    const second = run({ op: 'chain', item: 'dynkin-iso', bond: 'dynkin-double', fromName: 'r1', points: [[4 * CM, 0]] }, first.out);
    assert.match(second.out, /  \\node\[dynkin even\] \(r1\) at \(3,0\) \{\};\n  \\node\[dynkin iso\] \(r2\) at \(4,0\) \{\};\n  \\draw\[dynkin double\] \(r1\) -- \(r2\);\n\\end\{tikzpicture\}/);
    const { out, r } = run({ op: 'move', refs: [ref(PAPER, 0), ref(PAPER, 1)], dx: CM, dy: 0 });
    assert.deepEqual(r.selects.map(k => out.slice(k, k + 12)), ['\\node[draw] ', '\\node[draw] ']);
    assert.ok(out.slice(r.selects[1]).startsWith('\\node[draw] at (3,0) {B};'));
});

test('palette colours are written by name and defined once in the preamble', () => {
    const { out } = run({ op: 'style', refs: [ref(PAPER, 2)], group: 'color', value: 'wpTeal' });
    assert.match(out, /\\definecolor\{wpTeal\}\{HTML\}\{14B8A6\}\n% end of WPaper TikZ styles/);
    assert.match(out, /\\draw\[color=wpTeal\] \(a\) -- \(2,0\);/);
    const fill = run({ op: 'style', refs: [ref(out, 0)], group: 'fill', value: 'wpTeal!25' }, out).out;
    assert.equal(fill.match(/\\definecolor\{wpTeal\}/g).length, 1, 'defined once');
    assert.match(fill, /\\node\[draw, fill=wpTeal!25\] \(a\)/);
    const custom = run({ op: 'style', refs: [ref(PAPER, 2)], group: 'color', value: '#12ab34' }).out;
    assert.match(custom, /\\definecolor\{wpC12AB34\}\{HTML\}\{12AB34\}/);
    assert.match(custom, /\\draw\[color=wpC12AB34\]/);
    const plain = run({ op: 'style', refs: [ref(PAPER, 2)], group: 'color', value: 'red' }).out;
    assert.ok(!plain.includes('definecolor'), 'xcolor names need no definition');
});

test('copy and paste statements: renamed, placed, edges kept only with their nodes', () => {
    const copied = ed.plan({ root: FILE, picture: { file: FILE, begin: PAPER.indexOf('\\begin{tikzpicture}') }, op: 'copy',
        refs: [ref(PAPER, 0), ref(PAPER, 2)] }, { [FILE]: PAPER });
    assert.equal(copied.clipboard, '\\node[draw] (a) at (0,0) {A};\n\\draw (a) -- (2,0);');
    const { out, r } = run({ op: 'paste', text: copied.clipboard, dx: CM, dy: 0 });
    assert.match(out, /  \\node\[draw\] \(a1\) at \(1,0\) \{A\};\n  \\draw \(a1\) -- \(2,0\);\n\\end\{tikzpicture\}/);
    assert.equal(r.selects.length, 2);
    // Into a picture without `a`: an edge to a node that is not pasted is left out.
    const other = '\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n';
    const res = ed.plan({ picture: { file: FILE, begin: 0 }, op: 'paste', text: '\\draw (zz) -- (0,0);\n\\draw (0,0) circle (1);' }, { [FILE]: other });
    const pasted = ed.apply(other, res.edits[FILE]);
    assert.ok(!pasted.includes('(zz)') && pasted.includes('\\draw (0,0) circle (1);'));
    assert.match(ed.plan({ picture: { file: FILE, begin: 0 }, op: 'paste', text: 'hello' }, { [FILE]: other }).error, /no TikZ statements/);
});
