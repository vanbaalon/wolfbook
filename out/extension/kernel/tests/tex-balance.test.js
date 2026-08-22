// A fragment you can move without breaking the file.
//
//   node out/extension/kernel/tests/tex-balance.test.js
//
// Moving a piece of LaTeX is a cut and a paste, and a cut inside a construct
// leaves two broken halves. Reported: dragging a run-in paragraph moved "only
// the text after the title", because the selection began after `\paragraph{…}`
// and the command stayed behind, orphaned.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const { balanceRange } = require('../../tex/texBalance');

/** Balance the range covering the first occurrence of `want`. */
const grow = (text, want) => {
    const from = text.indexOf(want);
    assert.ok(from >= 0, `the fixture contains ${JSON.stringify(want)}`);
    const r = balanceRange(text, from, from + want.length);
    return { ...r, text: text.slice(r.from, r.to) };
};

test('THE REPORTED BUG: a run-in paragraph keeps its title', () => {
    const src = 'Before. \\paragraph{sdfsdf} sdfsdf after.';
    const r = grow(src, 'sdfsdf} sdfsdf');
    assert.strictEqual(r.text, '\\paragraph{sdfsdf} sdfsdf',
        'the command travels with its argument');
    assert.strictEqual(r.widened, true);
});

test('a range that begins inside a command argument pulls the command in', () => {
    const src = 'x \\textbf{bold words} y';
    const r = grow(src, 'bold words');
    assert.strictEqual(r.text, '\\textbf{bold words}');
});

test('an option list travels with its command', () => {
    const src = 'x \\includegraphics[width=3cm]{plot.pdf} y';
    const r = grow(src, 'plot.pdf');
    assert.strictEqual(r.text, '\\includegraphics[width=3cm]{plot.pdf}');
});

test('A DANGLING \\end PULLS IN ITS \\begin', () => {
    // The property is "no half a construct", not "never inside one": a body
    // selected on its own is balanced and may be moved as it is. What must
    // never travel alone is a DELIMITER.
    const src = 'a\n\\begin{equation}\n E=mc^2\n\\end{equation}\nb';
    const r = grow(src, 'E=mc^2\n\\end{equation}');
    assert.ok(r.text.startsWith('\\begin{equation}'), r.text);
    assert.ok(r.text.endsWith('\\end{equation}'), r.text);
});

test('a body with no delimiter in it is left alone', () => {
    const src = 'a\n\\begin{equation}\n E=mc^2\n\\end{equation}\nb';
    const r = grow(src, 'E=mc^2');
    assert.strictEqual(r.widened, false,
        'moving a body out of its environment is a thing a reader may mean');
});

test('a dangling delimiter takes the INNERMOST partner', () => {
    const src = '\\begin{figure}\n\\begin{center}\n pic\n\\end{center}\n\\end{figure}';
    const r = grow(src, 'pic\n\\end{center}');
    assert.ok(r.text.includes('\\begin{center}'), r.text);
    assert.ok(!r.text.includes('\\begin{figure}'),
        'and does NOT swallow the float it sits in — a fragment only grows as far as it must');
});

test('a WHOLE construct is left exactly as it is', () => {
    for (const [src, want] of [
        ['x \\paragraph{title} text y', '\\paragraph{title} text'],
        ['a\n\\begin{equation}\nE=mc^2\n\\end{equation}\nb', '\\begin{equation}\nE=mc^2\n\\end{equation}'],
        ['plain prose with nothing special in it', 'prose with nothing'],
    ]) {
        const r = grow(src, want);
        assert.strictEqual(r.text, want, `unchanged: ${JSON.stringify(want)}`);
        assert.strictEqual(r.widened, false);
    }
});

test('braces are balanced in BOTH directions at once', () => {
    const src = 'x \\frac{aaa}{bbb} y';
    const r = grow(src, 'aa}{bb');
    assert.strictEqual(r.text, '\\frac{aaa}{bbb}',
        `both halves of the fraction, got ${JSON.stringify(r.text)}`);
});

test('an ESCAPED brace is not a brace', () => {
    // `\{` prints a brace; counting it would widen a range for no reason.
    const src = 'the set \\{a, b\\} of two things';
    const r = grow(src, 'a, b\\} of two');
    assert.strictEqual(r.widened, false, `left alone, got ${JSON.stringify(r.text)}`);
});

test('a brace inside a COMMENT is not a brace', () => {
    const src = 'text\n% a stray { in a comment\nmore text here';
    const r = grow(src, 'more text');
    assert.strictEqual(r.widened, false);
});

test('it terminates on a pathological file rather than running away', () => {
    // Unbalanced on purpose: there is no matching partner to find, and the
    // answer must be "as much as I could" rather than a hang or the whole file.
    const src = 'a } b } c } d';
    const r = grow(src, 'b } c');
    assert.ok(r.to <= src.length && r.from >= 0, 'inside the document');
    assert.ok(r.text.length >= 'b } c'.length, 'never smaller than what was asked for');
});

test('a fragment only ever GROWS', () => {
    const src = 'x \\paragraph{title} some text here y';
    const from = src.indexOf('title');
    const to = src.indexOf('here') + 4;
    const r = balanceRange(src, from, to);
    assert.ok(r.from <= from && r.to >= to,
        'a reader who selected too little meant the thing they pointed at');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); pass++; results.push('  ok   ' + name); }
        catch (e) {
            fail++;
            results.push('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    console.log('a fragment you can move without breaking the file\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
