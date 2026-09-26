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
