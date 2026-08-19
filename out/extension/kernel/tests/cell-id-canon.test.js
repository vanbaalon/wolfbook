'use strict';
const assert = require('assert');
const { withVscodeStub } = require('./_stub-vscode');
const { _canonCellId, getCellToolId, resolveCellIndex } = withVscodeStub(() => require('../../tools/shared'));
const { OperationRegistry } = require('../operations');

for (const input of ['X%3D%3D', 'X==', 'vscode-notebook-cell:/tmp/a.wb#X%3D%3D']) {
    assert.strictEqual(_canonCellId(input), 'X');
    assert.strictEqual(_canonCellId(_canonCellId(input)), 'X');
}
const cell = { metadata: { toolId: 'X==' }, document: { uri: { toString: () => 'vscode-notebook-cell:/tmp/a.wb#X%3D%3D' } } };
const notebook = { cellCount: 1, cellAt: () => cell };
assert.strictEqual(getCellToolId(cell), 'X');
assert.deepStrictEqual(resolveCellIndex(notebook, 'X%3D%3D', 'cellId'), { idx: 0 });
assert.deepStrictEqual(resolveCellIndex(notebook, 'X==', 'cellId'), { idx: 0 });

const ops = new OperationRegistry();
assert.strictEqual(ops._cellKey('/tmp/a.wb', 'X%3D%3D'), ops._cellKey('/tmp/a.wb', 'X=='));
assert.strictEqual(ops._cellKey('/tmp/a.wb', 'X=='), ops._cellKey('/tmp/a.wb', 'X'));
console.log('cell-id canonicalization tests: OK');
