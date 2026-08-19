'use strict';
const assert = require('assert');
const { makeVscodeStub, withVscodeStub } = require('./_stub-vscode');

(async () => {
    const first = { notebookType: 'extended-wolfram-notebook', uri: {
        fsPath: '/tmp/one/test.wb', toString: () => 'file:///tmp/one/test.wb'
    } };
    const second = { notebookType: 'extended-wolfram-notebook', uri: {
        fsPath: '/tmp/overleaf/test.wb', toString: () => 'file:///tmp/overleaf/test.wb'
    } };
    const firstEditor = { notebook: first };
    const secondEditor = { notebook: second };
    let shown = null;
    const stub = makeVscodeStub({
        window: {
            activeNotebookEditor: firstEditor,
            visibleNotebookEditors: [firstEditor, secondEditor],
            showNotebookDocument: async doc => { shown = doc; return doc === second ? secondEditor : firstEditor; },
        },
        workspace: { notebookDocuments: [first, second] },
    });
    const { resolveNotebookEditor } = withVscodeStub(() => require('../../tools/shared'), stub);
    const resolved = await resolveNotebookEditor('/tmp/overleaf/test.wb', { skipConfirm: true });
    assert.strictEqual(resolved, secondEditor, 'absolute path must beat a duplicate basename');
    assert.strictEqual(shown, second);
    console.log('notebook editor absolute-path resolution tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
