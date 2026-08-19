'use strict';
const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');
const { decodeToolContent, prepareCellContent, findControlChar } = withVscodeStub(() => require('../../tools/shared'));

const exact = String.raw`x \vee y`;
assert.strictEqual(decodeToolContent(Buffer.from(exact).toString('base64'), 'base64'), exact);
assert.strictEqual(decodeToolContent(String.raw`\u2014`, 'raw'), String.raw`\u2014`);
assert.strictEqual(decodeToolContent(String.raw`\u2014`, 'auto'), '—');
assert.throws(() => decodeToolContent('not base64!', 'base64'), /Invalid base64/);

const found = findControlChar('one\ntwo\x0Bthree');
assert.deepStrictEqual({ code: found.code, line: found.line, col: found.col }, { code: 11, line: 2, col: 4 });
assert.throws(() => prepareCellContent({ content: 'a\x0Bb', kind: 'code', encoding: 'raw' }), /U\+000B at 1:2.*No cells were modified/);
assert.strictEqual(prepareCellContent({ content: String.raw`\(x\)`, kind: 'markdown', encoding: 'raw' }).text, '$x$');
console.log('content-encoding tests: OK');
