'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const legacyNotebookColors = {
    'editor.wordHighlightBackground': '#3399ff18',
    'notebook.editorBackground': '#f4f4f4',
    'notebook.cellEditorBackground': '#f7f7f7',
    'notebook.cellBorderColor': '#dfdfdf',
    'notebook.inactiveFocusedCellBorder': '#dfdfdf',
    'notebook.collapsedCellBackground': '#f7f7f7',
    'notebook.focusedCellBackground': '#f4f4f4',
    'notebook.selectedCellBackground': '#f4f4f4',
    'notebook.inactiveSelectedCellBackground': '#f4f4f4',
    'notebook.cellHoverBackground': '#f4f4f4',
};

const updates = [];
const workspaceConfig = {
    inspect: key => key === 'colorCustomizations'
        ? { workspaceValue: legacyNotebookColors }
        : undefined,
    update: async (key, value, target) => updates.push({ scope: 'workspace', key, value, target }),
};
const folderConfig = {
    inspect: key => key === 'colorCustomizations'
        ? { workspaceFolderValue: legacyNotebookColors }
        : undefined,
    update: async (key, value, target) => updates.push({ scope: 'folder', key, value, target }),
};
const vscodeStub = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        workspaceFolders: [{ name: 'root', uri: { toString: () => 'file:///root' } }],
        getConfiguration: (_section, resource) => resource ? folderConfig : workspaceConfig,
    },
    window: {},
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, ...rest);
};
const settings = require(path.resolve(__dirname, '../..', 'notebook-settings.js'));
Module._load = originalLoad;

const cleaned = settings._withoutLegacyWolfbookNotebookColors(legacyNotebookColors);
assert.deepStrictEqual(cleaned, {
    'editor.wordHighlightBackground': '#3399ff18',
}, 'cleanup must preserve unrelated workbench colours');

const partialUserColors = {
    'notebook.editorBackground': '#ffffff',
    'notebook.cellEditorBackground': '#fafafa',
};
assert.strictEqual(settings._withoutLegacyWolfbookNotebookColors(partialUserColors), null,
    'partial user-authored notebook colours must not be claimed as Wolfbook legacy state');

const differentContainerColors = {
    ...legacyNotebookColors,
    'notebook.selectedCellBackground': '#abcdef',
};
assert.strictEqual(settings._withoutLegacyWolfbookNotebookColors(differentContainerColors), null,
    'a full but non-Wolfbook colour shape must be preserved');

(async () => {
    const scopes = await settings._cleanLegacyWorkspaceNotebookColors();
    assert.deepStrictEqual(scopes, ['workspace', 'workspace folder root']);
    assert.strictEqual(updates.length, 2);
    assert.strictEqual(updates[0].target, vscodeStub.ConfigurationTarget.Workspace);
    assert.strictEqual(updates[1].target, vscodeStub.ConfigurationTarget.WorkspaceFolder);
    for (const update of updates) {
        assert.deepStrictEqual(update.value, {
            'editor.wordHighlightBackground': '#3399ff18',
        });
    }
    console.log('notebook theme migration tests: OK');
})().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
