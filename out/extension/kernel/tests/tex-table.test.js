const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = () => import(path.resolve(__dirname, '../../../client/tex-table.js'));

const SIMPLE = `Before.
\\begin{tabular}{|l|c|r|}
\\hline
Name & Value & Unit \\\\
\\hline
$\\alpha$ & 0.5 & -- \\\\[2pt]
\\multicolumn{2}{c}{both} & x \\\\ % a comment & not a cell
\\hline
\\end{tabular}
After.`;

test('a tabular reads as rows of cells, with rules and spans', async () => {
    const { parseTabular } = await load();
    const t = parseTabular(SIMPLE);
    assert.equal(t.env, 'tabular');
    assert.equal(t.spec, '|l|c|r|');
    assert.deepEqual(t.cols.map(c => c.align), ['l', 'c', 'r']);
    assert.equal(t.specEditable, true);
    assert.deepEqual(t.rows.map(r => r.cells), [['Name', 'Value', 'Unit'], ['$\\alpha$', '0.5', '--'], ['\\multicolumn{2}{c}{both}', 'x']]);
    assert.deepEqual(t.rows.map(r => r.rules), [['\\hline'], ['\\hline'], []]);
    // A comment after the last \\\\ is kept, on its own line.
    assert.deepEqual(t.closing, ['% a comment & not a cell', '\\hline']);
    assert.equal(t.rows[1].tail, '[2pt]');
    // Every span is exactly its cell's text in the source.
    for (const row of t.rows) row.cells.forEach((cell, j) => assert.equal(SIMPLE.slice(...row.spans[j]), cell));
    assert.equal(SIMPLE.slice(t.start, t.end).endsWith('\\end{tabular}'), true);
});

test('the cell under an offset', async () => {
    const { parseTabular, cellAt } = await load();
    const t = parseTabular(SIMPLE);
    assert.deepEqual(cellAt(t, SIMPLE.indexOf('Value') + 2), { row: 0, col: 1 });
    assert.deepEqual(cellAt(t, SIMPLE.indexOf('0.5')), { row: 1, col: 1 });
    assert.deepEqual(cellAt(t, SIMPLE.indexOf('x \\\\')), { row: 2, col: 1 });
    assert.equal(cellAt(t, 2), null);
});

test('tabularx, a position, and a spec the grid leaves alone', async () => {
    const { parseTabular, serializeTabular } = await load();
    const x = parseTabular('\\begin{tabularx}{\\linewidth}[t]{lX}\na & b \\\\\n\\end{tabularx}');
    assert.equal(x.width, '\\linewidth');
    assert.equal(x.position, '[t]');
    assert.deepEqual(x.cols.map(c => c.align), ['l', 'X']);
    const p = parseTabular('\\begin{tabular}{>{\\bfseries}l p{3cm}}\na & b\\\\\\end{tabular}');
    assert.equal(p.specEditable, false);
    assert.equal(serializeTabular(p).split('\n')[0], '\\begin{tabular}{>{\\bfseries}l p{3cm}}');
    const q = parseTabular('\\begin{tabular}{@{}lp{2cm}@{}}\na & b\\\\\\end{tabular}');
    assert.deepEqual(q.cols.map(c => c.align), ['l', 'p{2cm}']);
});

test('the grid operations write tidy LaTeX', async () => {
    const { parseTabular, serializeTabular, setCell, addRow, removeRow, addColumn, removeColumn, setAlign } = await load();
    const t = parseTabular('\\begin{tabular}{lc}\na & b \\\\\ncc & d \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(t), '\\begin{tabular}{lc}\n  a  & b \\\\\n  cc & d \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(setCell(t, 0, 1, 'B')), '\\begin{tabular}{lc}\n  a  & B \\\\\n  cc & d \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(addRow(t, 0)), '\\begin{tabular}{lc}\n  a  & b \\\\\n     & \\\\\n  cc & d \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(removeRow(t, 0)), '\\begin{tabular}{lc}\n  cc & d \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(addColumn(t, 0, 'r')), '\\begin{tabular}{lrc}\n  a  &  & b \\\\\n  cc &  & d \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(removeColumn(t, 0)), '\\begin{tabular}{c}\n  b \\\\\n  d \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(setAlign(t, 1, 'r')).split('\n')[0], '\\begin{tabular}{lr}');
    // Bars between every column stay.
    const bars = parseTabular('\\begin{tabular}{|l|c|}\na & b \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(addColumn(bars, 1)).split('\n')[0], '\\begin{tabular}{|l|c|c|}');
    // A removed row's lines take the next row's place: one line where two rows met.
    const ruled = parseTabular('\\begin{tabular}{l}\n\\toprule\na \\\\\n\\midrule\nb \\\\\nc \\\\\n\\bottomrule\n\\end{tabular}');
    assert.deepEqual(removeRow(ruled, 0).rows[0].rules, ['\\toprule']);
    assert.deepEqual(removeRow(ruled, 1).rows[1].rules, ['\\midrule']);
    assert.deepEqual(removeRow(ruled, 2).closing, ['\\bottomrule']);
    const grid = parseTabular('\\begin{tabular}{l}\n\\hline\na \\\\\n\\hline\nb \\\\\n\\hline\n\\end{tabular}');
    assert.deepEqual(removeRow(grid, 1).closing, ['\\hline']);
});

test('booktabs', async () => {
    const { parseTabular, serializeTabular, setBooktabs } = await load();
    const hl = parseTabular('\\begin{tabular}{|l|c|}\n\\hline\nH & I \\\\\n\\hline\na & b \\\\\nc & d \\\\\n\\hline\n\\end{tabular}');
    assert.equal(serializeTabular(setBooktabs(hl, true)),
        '\\begin{tabular}{lc}\n  \\toprule\n  H & I \\\\\n  \\midrule\n  a & b \\\\\n  c & d \\\\\n  \\bottomrule\n\\end{tabular}');
    const bt = setBooktabs(hl, true);
    assert.deepEqual(setBooktabs(bt, false).rows[0].rules, ['\\hline']);
    const bare = parseTabular('\\begin{tabular}{ll}\nH & I \\\\\na & b \\\\\n\\end{tabular}');
    assert.equal(serializeTabular(setBooktabs(bare, true)),
        '\\begin{tabular}{ll}\n  \\toprule\n  H & I \\\\\n  \\midrule\n  a & b \\\\\n  \\bottomrule\n\\end{tabular}');
    // A comment is not a rule.
    const noted = parseTabular('\\begin{tabular}{l}\n% head\nH \\\\\n\\end{tabular}');
    assert.deepEqual(setBooktabs(noted, true).rows[0].rules, ['% head', '\\toprule']);
    // Nor does a comment in a cell swallow the next cell.
    const inCell = parseTabular('\\begin{tabular}{ll}\na % note\n & b \\\\\n\\end{tabular}');
    assert.deepEqual(parseTabular(serializeTabular(inCell)).rows[0].cells, ['a % note', 'b']);
});

test('the round trip keeps what it does not understand', async () => {
    const { parseTabular, serializeTabular } = await load();
    const src = '\\begin{tabular}{lcr}\n  \\toprule\n  \\multicolumn{2}{c}{A \\& B} & {x & y} \\\\\n  \\cmidrule(lr){1-2}\n  $a&b$ & \\textbf{2} & 3 \\\\\n  \\bottomrule\n\\end{tabular}';
    const t = parseTabular(src);
    assert.deepEqual(t.rows[0].cells, ['\\multicolumn{2}{c}{A \\& B}', '{x & y}']);
    assert.deepEqual(t.rows[1].rules, ['\\cmidrule(lr){1-2}']);
    const again = parseTabular(serializeTabular(t));
    assert.deepEqual(again.rows.map(r => r.cells), t.rows.map(r => r.cells));
    assert.deepEqual(again.rows.map(r => r.rules), t.rows.map(r => r.rules));
});

test('border styles', async () => {
    const { parseTabular, serializeTabular, setBorders, bordersOf, BORDERS } = await load();
    const t = parseTabular('\\begin{tabular}{lc}\nH & I \\\\\na & b \\\\\nc & d \\\\\n\\end{tabular}');
    const shape = style => {
        const out = serializeTabular(setBorders(t, style));
        return out.split('\n').map(l => l.trim()).filter(l => !/&/.test(l) || true).join(' ').replace(/\s+/g, ' ');
    };
    assert.equal(shape('none'), '\\begin{tabular}{lc} H & I \\\\ a & b \\\\ c & d \\\\ \\end{tabular}');
    assert.equal(shape('header'), '\\begin{tabular}{lc} H & I \\\\ \\hline a & b \\\\ c & d \\\\ \\end{tabular}');
    assert.equal(shape('rows'), '\\begin{tabular}{lc} \\hline H & I \\\\ \\hline a & b \\\\ \\hline c & d \\\\ \\hline \\end{tabular}');
    assert.equal(shape('box'), '\\begin{tabular}{|lc|} \\hline H & I \\\\ a & b \\\\ c & d \\\\ \\hline \\end{tabular}');
    assert.equal(shape('grid'), '\\begin{tabular}{|l|c|} \\hline H & I \\\\ \\hline a & b \\\\ \\hline c & d \\\\ \\hline \\end{tabular}');
    assert.equal(shape('double'), '\\begin{tabular}{||l|c||} \\hline \\hline H & I \\\\ \\hline a & b \\\\ \\hline c & d \\\\ \\hline \\hline \\end{tabular}');
    assert.equal(shape('booktabs'), '\\begin{tabular}{lc} \\toprule H & I \\\\ \\midrule a & b \\\\ c & d \\\\ \\bottomrule \\end{tabular}');
    // Each style is recognised in what it writes, and switching is lossless for cells.
    for (const style of Object.keys(BORDERS)) {
        const again = parseTabular(serializeTabular(setBorders(t, style)));
        assert.equal(bordersOf(again), style, style);
        assert.deepEqual(again.rows.map(r => r.cells), t.rows.map(r => r.cells));
    }
    // Partial rules follow the package; comments and @{} stay.
    const p = parseTabular('\\begin{tabular}{@{}ll@{}}\n% note\nA & B \\\\\n\\cline{1-2}\na & b \\\\\n\\end{tabular}');
    const bt = setBorders(p, 'booktabs');
    assert.deepEqual(bt.rows[0].rules, ['% note', '\\toprule']);
    assert.deepEqual(bt.rows[1].rules, ['\\cmidrule(lr){1-2}', '\\midrule']);
    assert.equal(serializeTabular(setBorders(p, 'grid')).split('\n')[0], '\\begin{tabular}{@{}|l|l|@{}}');
    assert.deepEqual(setBorders(bt, 'grid').rows[1].rules, ['\\cline{1-2}', '\\hline']);
});

test('a style that needs a package loads it in the preamble once', () => {
    const { packageInsertion } = require('../../tex/texPaste');
    const doc = '\\documentclass[11pt]{article}\n\\usepackage{amsmath}\n\\begin{document}\nx\n\\end{document}\n';
    assert.deepEqual(packageInsertion(doc, 'booktabs'), { offset: doc.indexOf('\\usepackage'), text: '\\usepackage{booktabs}\n' });
    assert.equal(packageInsertion('\\documentclass{a}\n\\usepackage{array,booktabs}\n', 'booktabs'), null);
    assert.equal(packageInsertion('\\documentclass{a}\n\\usepackage[x]{booktabs}\n', 'booktabs'), null);
    assert.notEqual(packageInsertion('\\documentclass{a}\n\\usepackage{booktabsx}\n', 'booktabs'), null);
});
