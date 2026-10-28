'use strict';
const assert = require('assert');
const { makeVscodeStub, withVscodeStub } = require('./_stub-vscode');

(async () => {
    const doc = p => ({ notebookType: 'extended-wolfram-notebook', cellCount: 10,
        uri: { fsPath: p, toString: () => `file://${p}` } });
    const first = doc('/tmp/one/test.wb');
    const second = doc('/tmp/overleaf/test.wb');
    const third = doc('/tmp/background.wb');
    const unloaded = doc('/tmp/unloaded.wb');
    const reveals = [];
    const editor = notebook => ({ notebook, revealRange: range => reveals.push([notebook, range.start]), setDecorations() {} });
    const firstEditor = editor(first), secondEditor = editor(second);
    const shown = [], notices = [], registeredCommands = new Map();
    const status = { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
    const routed = [];
    const stub = makeVscodeStub({
        StatusBarAlignment: { Right: 2 },
        NotebookEditorRevealType: { InCenterIfOutsideViewport: 1 },
        window: {
            activeNotebookEditor: firstEditor, visibleNotebookEditors: [firstEditor, secondEditor],
            showNotebookDocument: async (notebook, options) => {
                shown.push([notebook, options]);
                const ed = notebook === second ? secondEditor : notebook === first ? firstEditor : editor(notebook);
                stub.window.activeNotebookEditor = ed;
                return ed;
            },
            // Leave each toast pending: tools must never wait for a user response.
            showInformationMessage: (...args) => new Promise(resolve => notices.push({ args, resolve })),
            createStatusBarItem: () => status,
            tabGroups: { all: [{ tabs: [{ input: { uri: unloaded.uri } }] }] },
        },
        workspace: {
            notebookDocuments: [first, second, third],
            openNotebookDocument: async uri => {
                assert.strictEqual(uri, unloaded.uri);
                stub.workspace.notebookDocuments.push(unloaded);
                return unloaded;
            },
        },
        commands: { registerCommand: (name, fn) => {
            registeredCommands.set(name, fn);
            return { dispose: () => registeredCommands.delete(name) };
        } },
    });
    const shared = withVscodeStub(() => require('../../tools/shared'), stub);
    const { resolveNotebookEditor, resolveNotebookDocument, registerAgentFollow, notifyAgentNotebookEvent, flashCell } = shared;
    shared.setNotebookResolvedCallback(name => routed.push(name));
    registerAgentFollow({ subscriptions: [] });

    const resolved = await resolveNotebookEditor('/tmp/overleaf/test.wb');
    assert.strictEqual(resolved, secondEditor, 'absolute path beats a duplicate basename');
    assert.strictEqual(stub.window.activeNotebookEditor, firstEditor, 'resolving never changes the active tab');
    assert.strictEqual(shown.length, 0, 'preserveFocus is insufficient: agent resolution must not show any tab');
    assert.strictEqual(notices.length, 1);
    assert.deepStrictEqual(notices[0].args.slice(1), ['Open Notebook']);
    assert.match(notices[0].args[0], /working in "test\.wb" in the background/);
    await flashCell(secondEditor, 2);
    await flashCell(secondEditor, 7);
    assert.strictEqual(notices.length, 1, 'an unattended toast and repeated edits are coalesced');
    assert.strictEqual(shown.length, 0);
    notices[0].resolve('Open Notebook');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(shown[0][0], second);
    assert.deepStrictEqual(shown[0][1], { preserveFocus: false, preview: false });
    assert.deepStrictEqual(reveals[0], [second, 7], 'click navigates to the latest affected cell in that notebook');

    // Read WPaper with no visible notebook editor. Loaded and unloaded notebook
    // tabs still support agent tools, and a document read remains routing-neutral.
    stub.window.activeNotebookEditor = undefined;
    stub.window.visibleNotebookEditors = [];
    const before = shown.length;
    const background = await resolveNotebookEditor(third.uri.fsPath);
    assert.strictEqual(background.notebook, third);
    background.selection = new stub.NotebookRange(3, 4);
    assert.strictEqual((await resolveNotebookEditor(third.uri.fsPath)).selection.start, 3);
    background.revealRange(new stub.NotebookRange(0, 1));
    assert.strictEqual((await resolveNotebookEditor(unloaded.uri.fsPath)).notebook, unloaded);
    assert.strictEqual(await resolveNotebookEditor('/tmp/missing.wb'), null);
    assert.strictEqual(shown.length, before, 'background loading/selection never replaces WPaper');
    const routeCount = routed.length;
    assert.strictEqual(await resolveNotebookDocument(third.uri.fsPath), third);
    assert.strictEqual(routed.length, routeCount, 'read-only resolution does not change agent routing');

    await flashCell(background, 4);
    const thirdNotice = notices.find(n => n.args[0].includes('"background.wb"'));
    thirdNotice.resolve(undefined);
    await new Promise(resolve => setImmediate(resolve));
    await flashCell(background, 5);
    assert.strictEqual(shown.length, before, 'dismissal leaves WPaper alone');
    assert.strictEqual(notices.filter(n => n.args[0].includes('"background.wb"')).length, 1,
        'dismissed notifications have a cooldown instead of reappearing on each edit');

    // Even collaboration mode may only update a pane that is already visible.
    stub.workspace.getConfiguration = () => ({ get: (_key, fallback) => _key === 'collabMode' ? true : fallback });
    await flashCell(background, 6);
    assert.strictEqual(shown.length, before, 'collaboration mode must not silently create a pane over WPaper');

    // Following remains an explicit command, never an incidental toast click.
    await registeredCommands.get('wolfbook.followAgent')();
    assert.strictEqual(shown.at(-1)[0], third);
    assert.strictEqual(status.text, '$(eye) Following AI');
    await flashCell(secondEditor, 8);
    assert.strictEqual(shown.at(-1)[0], second);
    registeredCommands.get('wolfbook.stopFollowingAgent')();
    stub.window.activeNotebookEditor = undefined;
    const afterStop = shown.length;
    await flashCell(background, 8);
    assert.strictEqual(shown.length, afterStop, 'stopping Follow Agent restores background activity');

    const created = doc('/tmp/created.wb');
    const selected = new Set(), selectionListeners = new Set();
    const ctrl = { selectedNotebooks: selected, _controller: {
        id: 'isolated-K2', label: 'K2', updateNotebookAffinity() {},
        onDidChangeSelectedNotebooks: fn => {
            selectionListeners.add(fn);
            return { dispose: () => selectionListeners.delete(fn) };
        },
    } };
    shared.setAgentControllerProvider(input => {
        assert.strictEqual(input.notebook, created.uri.fsPath, 'click associates the notified notebook, not another agent target');
        return ctrl;
    });
    stub.commands.getCommands = async () => ['_notebook.selectKernel'];
    stub.commands.executeCommand = async (name, args) => {
        assert.strictEqual(name, '_notebook.selectKernel');
        assert.strictEqual(args.id, 'isolated-K2');
        selected.add(created);
        for (const fn of selectionListeners) fn({ notebook: created, selected: true });
    };
    const Module = require('module'), originalLoad = Module._load;
    Module._load = function (request) { return request === 'vscode' ? stub : originalLoad.apply(this, arguments); };
    try {
        const pending = notifyAgentNotebookEvent({ notebook: created, kind: 'created' });
        const createdNotice = notices.at(-1);
        assert.match(createdNotice.args[0], /created "created\.wb" in the background/);
        assert.strictEqual(selected.size, 0, 'unattended toast does not attempt active-editor kernel selection');
        createdNotice.resolve('Open Notebook');
        await pending;
        assert.strictEqual(shown.at(-1)[0], created);
        assert.strictEqual(shown.at(-1)[1].preview, false, 'clicked notebook is retained as a normal tab');
        assert(selected.has(created), 'explicit navigation completes first-time selection for subsequent background evaluation');
        assert.strictEqual(selectionListeners.size, 0);
    } finally { Module._load = originalLoad; }
    console.log('notebook background resolution and toast navigation tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
