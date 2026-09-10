'use strict';

const assert = require('assert');
const { makeVscodeStub, withVscodeStub } = require('./_stub-vscode');

(async () => {
    const saved = {};
    const rendererMessages = [];
    const workbenchColors = {};
    const rendererMessaging = {
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async (message, editor) => {
            rendererMessages.push({ message, editor });
            return true;
        },
    };
    const stub = makeVscodeStub({
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        notebooks: { createRendererMessaging: () => rendererMessaging },
        workspace: {
            workspaceFolders: [],
            getConfiguration: section => {
                if (section === 'workbench') return {
                    get: key => key === 'colorCustomizations' ? workbenchColors : undefined,
                    inspect: () => ({}),
                    update: async (_key, value) => Object.assign(workbenchColors, value || {}),
                };
                if (section === 'wolfbook') return { get: (_key, fallback) => fallback, update: async () => {} };
                return { get: (_key, fallback) => fallback, update: async () => {} };
            },
        },
        window: {
            activeColorTheme: { kind: 1 },
            visibleNotebookEditors: [],
            showErrorMessage: message => { throw new Error(message); },
        },
    });
    const settings = withVscodeStub(() => require('../../notebook-settings'), stub);
    const context = { workspaceState: {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : fallback,
        update: async (key, value) => { saved[key] = value; },
    } };
    settings._initializeAppearanceState(context);

    const notebook = fsPath => ({
        uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` },
        notebookType: 'extended-wolfram-notebook', metadata: {},
    });
    const first = notebook('/tmp/first.wb');
    const second = notebook('/tmp/second.wb');
    const firstEditor = { notebook: first };
    const secondEditor = { notebook: second };
    stub.window.visibleNotebookEditors = [firstEditor, secondEditor];

    await settings.updateNotebookSettings(first, { backgroundColor: '#FFF8F0' });
    await settings.updateNotebookSettings(second, { backgroundColor: '#F0F8FF' });
    const persisted = saved['wolfbook.notebookAppearanceByUri.v2'];
    assert.strictEqual(persisted[settings._appearanceStorageKey(first)].backgroundColor, '#FFF8F0');
    assert.strictEqual(persisted[settings._appearanceStorageKey(second)].backgroundColor, '#F0F8FF');
    assert.strictEqual(settings.getNotebookSettings(first).backgroundColor, '#FFF8F0');
    assert.strictEqual(settings.getNotebookSettings(second).backgroundColor, '#F0F8FF');

    const firstMessage = rendererMessages.find(item => item.editor === firstEditor);
    const secondMessage = rendererMessages.find(item => item.editor === secondEditor);
    assert(firstMessage && secondMessage, 'each visible notebook receives its own targeted renderer message');
    assert.strictEqual(firstMessage.message.type, 'bg-appearance');
    assert.strictEqual(firstMessage.message.backgroundColor, '#FFF8F0');
    assert.strictEqual(secondMessage.message.backgroundColor, '#F0F8FF');
    assert(rendererMessages.every(item => item.editor), 'appearance messages must never broadcast across notebooks');

    // A fresh module instance models an extension-host/VS Code reboot: the
    // settings are reconstructed from workspaceState, not module memory.
    delete require.cache[require.resolve('../../notebook-settings')];
    const reloaded = withVscodeStub(() => require('../../notebook-settings'), stub);
    reloaded._initializeAppearanceState(context);
    assert.strictEqual(reloaded.getNotebookSettings(first).backgroundColor, '#FFF8F0');
    assert.strictEqual(reloaded.getNotebookSettings(second).backgroundColor, '#F0F8FF');

    console.log('notebook appearance tests: OK');
})().catch(error => { console.error(error); process.exit(1); });
