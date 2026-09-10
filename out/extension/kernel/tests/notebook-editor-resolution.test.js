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
    let revealCount = 0;
    const firstEditor = { notebook: first, revealRange: () => {}, setDecorations: () => {} };
    const secondEditor = { notebook: second, revealRange: () => { revealCount++; }, setDecorations: () => {} };
    let shown = null;
    let shownOptions = null;
    const infoCalls = [];
    const registeredCommands = new Map();
    const status = { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
    const stub = makeVscodeStub({
        StatusBarAlignment: { Right: 2 },
        NotebookEditorRevealType: { InCenterIfOutsideViewport: 1 },
        window: {
            activeNotebookEditor: firstEditor,
            visibleNotebookEditors: [firstEditor, secondEditor],
            showNotebookDocument: async (doc, options) => {
                shown = doc; shownOptions = options;
                return doc === second ? secondEditor : firstEditor;
            },
            showInformationMessage: async (...args) => { infoCalls.push(args); return 'Follow Agent'; },
            createStatusBarItem: () => status,
        },
        workspace: { notebookDocuments: [first, second] },
        commands: {
            registerCommand: (name, fn) => {
                registeredCommands.set(name, fn);
                return { dispose: () => registeredCommands.delete(name) };
            },
        },
        notebooks: {
            createNotebookEditorDecorationType: () => ({ dispose() {} }),
        },
    });
    const { resolveNotebookEditor, registerAgentFollow, notifyAgentNotebookEvent, flashCell } =
        withVscodeStub(() => require('../../tools/shared'), stub);
    const resolved = await resolveNotebookEditor('/tmp/overleaf/test.wb', { skipConfirm: true });
    assert.strictEqual(resolved, secondEditor, 'absolute path must beat a duplicate basename');
    assert.strictEqual(shown, second);
    assert.strictEqual(shownOptions.preserveFocus, true,
        'agent work on a named background notebook must not steal focus');

    shown = null; shownOptions = null;
    registerAgentFollow({ subscriptions: [] });
    await flashCell(secondEditor, 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(infoCalls[0][0], /working in "test\.wb" in the background/);
    assert.deepStrictEqual(infoCalls[0].slice(1), ['Follow Agent', 'Open Once']);
    assert.strictEqual(shown, second, 'accepting Follow Agent opens the background notebook');
    assert.strictEqual(shownOptions.preserveFocus, false, 'Follow Agent intentionally focuses the notebook');
    assert.strictEqual(revealCount, 1, 'Follow Agent reveals the affected cell');
    assert.strictEqual(status.text, '$(eye) Following AI');
    assert(registeredCommands.has('wolfbook.stopFollowingAgent'));

    infoCalls.length = 0; shown = null; shownOptions = null;
    stub.window.showInformationMessage = async (...args) => { infoCalls.push(args); return 'Open Notebook'; };
    await notifyAgentNotebookEvent({ notebook: second, kind: 'created' });
    assert.match(infoCalls[0][0], /created "test\.wb" in the background/);
    assert.deepStrictEqual(infoCalls[0].slice(1), ['Open Notebook', 'Follow Agent']);
    assert.strictEqual(shown, second);
    assert.strictEqual(shownOptions.preserveFocus, false);
    console.log('notebook editor absolute-path resolution tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
