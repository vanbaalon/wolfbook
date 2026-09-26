const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../../tex/tikzEdit');

test('a command runs to its top-level semicolon, past comments and groups', () => {
    const text = 'x \\draw[a={b;c}] (0,0) % not; this\n -- (1,1) node {;} ; y';
    const start = text.indexOf('\\draw');
    const range = t.commandRange(text, start);
    assert.equal(text.slice(range.start, range.end), '\\draw[a={b;c}] (0,0) % not; this\n -- (1,1) node {;} ;');
    assert.equal(t.commandRange('\\draw (0,0) -- (1,1)', 0), null);
});

test('transforms go first in the options; shifts merge', () => {
    const shift = { kind: 'shift', dx: 1, dy: -0.5 };
    assert.equal(t.withTransform('\\draw (0,0) -- (1,1);', shift), '\\draw[shift={(1,-0.5)}] (0,0) -- (1,1);');
    assert.equal(t.withTransform('\\draw[red, thick] (0,0) -- (1,1);', shift),
        '\\draw[shift={(1,-0.5)}, red, thick] (0,0) -- (1,1);');
    assert.equal(t.withTransform('\\draw[shift={(1,-0.5)}, red] (0,0);', shift), '\\draw[shift={(2,-1)}, red] (0,0);');
    // A move back to where it was removes the shift again.
    assert.equal(t.withTransform('\\draw[shift={(1,-0.5)}] (0,0);', { kind: 'shift', dx: -1, dy: 0.5 }), '\\draw (0,0);');
    assert.equal(t.withTransform('\\node[draw] at (1,2) {x};', { kind: 'rotate', degrees: 30, cx: 1, cy: 2 }),
        '\\node[rotate around={30:(1,2)}, draw] at (1,2) {x};');
    assert.equal(t.withTransform('\\fill (0,0) circle (1);', { kind: 'scale', factor: 1.5, cx: 0, cy: 0 }),
        '\\fill[scale around={1.5:(0,0)}] (0,0) circle (1);');
    assert.equal(t.withTransform('\\draw[a (0,0);', shift), null, 'an unclosed option list is not rewritten');
});

test('a picture is found from its opening, with its scale and its end', () => {
    const text = 'A\n\\begin{tikzpicture}[scale=0.5, thick]\n\\draw (0,0);\n% \\end{tikzpicture}\n\\begin{tikzpicture}\\end{tikzpicture}\n\\end{tikzpicture}\nB';
    const p = t.picture(text, text.indexOf('\\begin'));
    assert.equal(p.scale, 0.5);
    assert.equal(text.slice(p.bodyEnd, p.bodyEnd + 17), '\\end{tikzpicture}');
    assert.equal(text.slice(p.bodyEnd + 17), '\nB', 'the nested and the commented-out ends are skipped');
});

test('new shapes in centimetres, snapped, in the picture scale', () => {
    const cm = t.BP_PER_CM;
    assert.equal(t.newCommand('line', [[0, 0], [2.04 * cm, 1 * cm]]), '\\draw (0,0) -- (2,1);');
    assert.equal(t.newCommand('rect', [[cm, cm], [2 * cm, 3 * cm]], { scale: 0.5 }), '\\draw (2,2) rectangle (4,6);');
    assert.equal(t.newCommand('circle', [[0, 0], [0, 1.52 * cm]]), '\\draw (0,0) circle (1.5);');
    assert.equal(t.newCommand('line', [[0, 0], [1.234 * cm, 0]], { snap: false }), '\\draw (0,0) -- (1.23,0);');
    assert.equal(t.newCommand('node', [[cm, 0]], { text: '50% & {x}' }), '\\node at (1,0) {50\\% \\& \\{x\\}};');
    assert.equal(t.newCommand('node', [[0, 0]], { text: '  ' }), null);
    assert.equal(t.newCommand('line', [[0, 0]]), null);
});
