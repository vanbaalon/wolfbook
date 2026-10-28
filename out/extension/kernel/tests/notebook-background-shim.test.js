'use strict';
const assert = require('assert');
const Module = require('module');
const { makeVscodeStub } = require('./_stub-vscode');

(async () => {
    const notebook = { notebookType: 'extended-wolfram-notebook', cellCount: 1,
        uri: { fsPath: '/tmp/fairy.wb', toString: () => 'file:///tmp/fairy.wb' } };
    let shown = 0, inserted = 0, executed = 0, affinity = 0;
    const notices = [];
    const ctrl = {
        session: {}, kernelStatusString: 'resolved', selectedNotebooks: new Set(),
        _controller: { updateNotebookAffinity: () => { affinity++; } },
        execute: () => { executed++; },
    };
    const stub = makeVscodeStub({
        window: {
            showNotebookDocument: async () => { shown++; throw new Error('must not reveal a hidden notebook'); },
            showInformationMessage: (...args) => new Promise(resolve => notices.push({ args, resolve })),
        },
        workspace: {
            notebookDocuments: [notebook], openNotebookDocument: async () => notebook,
            applyEdit: async () => { inserted++; return true; },
        },
    });
    const originalLoad = Module._load;
    Module._load = function (request) { return request === 'vscode' ? stub : originalLoad.apply(this, arguments); };
    try {
        const shim = require('../../oberon/core/wolframShim');
        shim.setControllerProvider(() => ctrl);
        const replay = await shim.runNotebook(notebook.uri.fsPath, {});
        assert.strictEqual(replay.allClean, false, 'unassociated replay cannot be delivered as a clean run');
        assert.strictEqual(replay.reason, 'not-associated');
        assert.match(replay.failures[0].error, /Open Notebook/);
        const probe = await shim.evalInNotebook(notebook, '2+2');
        assert.strictEqual(probe.ok, false, 'unassociated probe cannot report a successful empty result');
        assert.strictEqual(probe.kind, 'not_associated');
        assert.match(probe.messages, /Open Notebook/);
        assert.strictEqual(shown, 0);
        assert.strictEqual(inserted, 0, 'association failure happens before adding probe cells');
        assert.strictEqual(executed, 0);
        assert.strictEqual(affinity, 2, 'retain intended controller affinity for an explicit open');
        assert.strictEqual(notices.length, 1, 'replay and probe share one background notification');
        notices[0].resolve(undefined);
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(shown, 0, 'dismissal does not open the working notebook');
        console.log('notebook background agent shim tests: OK');
    } finally { Module._load = originalLoad; }
})().catch(err => { console.error(err); process.exit(1); });
