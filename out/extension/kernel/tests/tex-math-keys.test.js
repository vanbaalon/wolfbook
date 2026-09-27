const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = () => import(path.resolve(__dirname, '../../../client/math-keys.js'));

/** Apply a key to `marked` (`|` a caret, `[…]` a selection). */
async function press(marked, key) {
    const { mathKey } = await load();
    const caret = marked.indexOf('|');
    const start = caret >= 0 ? caret : marked.indexOf('[');
    const text = marked.replace('|', '').replace('[', '').replace(']', '');
    const end = caret >= 0 ? caret : marked.indexOf(']') - 1;
    const r = mathKey(text, start, end, key);
    if (!r) return null;
    const next = r.insert !== undefined ? text.slice(0, r.start) + r.insert + text.slice(r.end) : text;
    return next.slice(0, r.caret) + '|' + next.slice(r.caret);
}

test('Mathematica structure keys in maths', async () => {
    assert.equal(await press('$x|$', 'sup'), '$x^{|}$');
    assert.equal(await press('$x|$', 'sub'), '$x_{|}$');
    assert.equal(await press('$[a+b]$', 'sup'), '$a+b^{|}$');
    assert.equal(await press('$a+x|$', 'frac'), '$a+\\frac{x}{|}$', 'the term before the caret is the numerator');
    assert.equal(await press('$a+\\alpha|$', 'frac'), '$a+\\frac{\\alpha}{|}$');
    assert.equal(await press('$(a+b)|$', 'frac'), '$\\frac{(a+b)}{|}$');
    assert.equal(await press('$x^{2}|$', 'frac'), '$\\frac{x^{2}}{|}$');
    assert.equal(await press('$[a+b]$', 'frac'), '$\\frac{a+b}{|}$');
    assert.equal(await press('$1+|$', 'frac'), '$1+\\frac{|}{}$');
    assert.equal(await press('$|$', 'sqrt'), '$\\sqrt{|}$');
    assert.equal(await press('$[x+1]$', 'sqrt'), '$\\sqrt{x+1}|$');
    assert.equal(await press('\\begin{equation}\nE=m|\n\\end{equation}', 'sup'), '\\begin{equation}\nE=m^{|}\n\\end{equation}');
});

test('stepping out and between slots', async () => {
    assert.equal(await press('$\\frac{a|}{}$', 'exit'), '$\\frac{a}|{}$');
    assert.equal(await press('$\\frac{a}|{}$', 'tab'), '$\\frac{a}{|}$');
    assert.equal(await press('$x^{2|}+1$', 'exit'), '$x^{2}|+1$');
    assert.equal(await press('$x|$ and', 'exit'), '$x$| and');
});

test('outside maths, the structure goes in $…$', async () => {
    assert.equal(await press('the mass m|', 'sup'), 'the mass m$^{|}$');
    assert.equal(await press('ratio |', 'frac'), 'ratio $\\frac{|}{}$');
});

test('keys, as Mathematica has them', async () => {
    const { mathKeyFor } = await load();
    const k = (key, o = {}) => mathKeyFor({ key, ctrlKey: true, metaKey: false, altKey: false, ...o });
    assert.equal(k('^'), 'sup'); assert.equal(k('6'), 'sup');
    assert.equal(k('_'), 'sub'); assert.equal(k('-'), 'sub');
    assert.equal(k('/'), 'frac'); assert.equal(k('2'), 'sqrt'); assert.equal(k(' '), 'exit');
    assert.equal(k('/', { ctrlKey: false, metaKey: true }), null, '⌘/ is not ⌃/');
});

test('matrices: ⌃, adds a column, ⌃Enter a row, as in Mathematica', async () => {
    const m = '$\\begin{pmatrix} a| & b \\\\\n c & d \\end{pmatrix}$';
    assert.equal(await press(m, 'col'), '$\\begin{pmatrix} a & | & b \\\\\n c &  & d \\end{pmatrix}$', 'a cell in every row');
    assert.equal(await press(m, 'row'), '$\\begin{pmatrix} a & b \\\\\n | &  \\\\\n c & d \\end{pmatrix}$', 'as many cells as the row');
    assert.equal(await press('\\begin{align}\nx &= 1| \\\\\ny &= 2\n\\end{align}', 'row'), '\\begin{align}\nx &= 1 \\\\\n | &  \\\\\ny &= 2\n\\end{align}');
    assert.equal(await press('$x|$', 'col'), '$\\begin{pmatrix} x & | \\end{pmatrix}$', 'outside one: a row vector');
    assert.equal(await press('$x|$', 'row'), '$\\begin{pmatrix} x \\\\ | \\end{pmatrix}$', 'a column vector');
});

test('Greek letters by escape alias, as in Mathematica', async () => {
    const { aliasEdit, aliasCommand } = await load();
    assert.equal(aliasCommand('a'), '\\alpha');
    assert.equal(aliasCommand('D'), '\\Delta');
    assert.equal(aliasCommand('ce'), '\\varepsilon');
    assert.equal(aliasCommand('inf'), '\\infty');
    assert.equal(aliasCommand('zz'), null);
    assert.equal(aliasCommand('constructor'), null, 'no prototype names');
    assert.deepEqual(aliasEdit('$x+a$', 3, 4), { start: 3, end: 4, insert: '\\alpha', caret: 9 });
    assert.deepEqual(aliasEdit('$ab$', 1, 2), { start: 1, end: 2, insert: '\\alpha ', caret: 8 }, 'spaced from a letter after it');
});
