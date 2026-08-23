'use strict';
const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');
const { decodeToolContent, prepareCellContent, findControlChar } = withVscodeStub(() => require('../../tools/shared'));

// This is the fidelity contract for every notebook-writing MCP tool. Tool
// arguments cross JSON once, then newNotebook/insertCells/editCell all call
// prepareCellContent. Ordinary content must not need base64 or an encoding flag.
const wolframSource = String.raw`banner = "════════════════";
labels = {"ρ", "Φ", "Ω", "ψ", "φ"};
description = "std\nall entries";
named = \[Rho] + \[CapitalPhi];`;
const markdownSource = String.raw`The symbols $\varrho$, $\bar\Phi$, $\bigl(x\bigr)$,
$\begin{vmatrix}a&b\\c&d\end{vmatrix}$, and $\frac{1}{2}$ stay intact.`;

for (const [kind, source] of [['code', wolframSource], ['markdown', markdownSource]]) {
    const throughMcpJson = JSON.parse(JSON.stringify({ content: source })).content;
    assert.strictEqual(throughMcpJson, source, `${kind}: JSON transport changed source`);
    assert.strictEqual(decodeToolContent(throughMcpJson), source, `${kind}: default decode changed source`);
    assert.strictEqual(prepareCellContent({ content: throughMcpJson, kind }).text, source,
        `${kind}: notebook preparation changed source`);

    // .wb persistence is JSON too; prove the prepared source survives the disk
    // representation used by serializer.js.
    const notebookJson = JSON.stringify({ cells: [{ kind, value: source }] }, null, 1);
    assert.strictEqual(JSON.parse(notebookJson).cells[0].value, source,
        `${kind}: notebook JSON round trip changed source`);
}

// Literal escape-looking text is valid WL/LaTeX and is verbatim by default.
const escapeLooking = String.raw`\v \b \f \n \t \r \" \\ \u2014`;
assert.strictEqual(decodeToolContent(escapeLooking), escapeLooking);

// Legacy repair is still available, but must be requested explicitly.
assert.strictEqual(decodeToolContent(String.raw`first\nsecond`, 'auto'), 'first\nsecond');
assert.strictEqual(decodeToolContent(String.raw`\u2014`, 'auto'), '—');

const exact = String.raw`x \vee y`;
assert.strictEqual(decodeToolContent(Buffer.from(exact).toString('base64'), 'base64'), exact);
assert.strictEqual(decodeToolContent(String.raw`\u2014`, 'raw'), String.raw`\u2014`);
assert.throws(() => decodeToolContent('not base64!', 'base64'), /Invalid base64/);

const found = findControlChar('one\ntwo\x0Bthree');
assert.deepStrictEqual({ code: found.code, line: found.line, col: found.col }, { code: 11, line: 2, col: 4 });
assert.throws(() => prepareCellContent({ content: 'a\x0Bb', kind: 'code', encoding: 'raw' }), /U\+000B at 1:2.*No cells were modified/);
assert.strictEqual(prepareCellContent({ content: String.raw`\(x\)`, kind: 'markdown', encoding: 'raw' }).text, '$x$');
console.log('content-encoding tests: OK');
