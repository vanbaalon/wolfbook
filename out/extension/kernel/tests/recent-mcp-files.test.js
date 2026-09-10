'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeVscodeStub, withVscodeStub } = require('./_stub-vscode');

(async () => {
    const handlers = new Map();
    const commands = new Map();
    const statusItems = [];
    const storage = new Map();
    const revealed = [];
    const slideReveals = [];
    const openWithCalls = [];
    let pickPath = null;

    const notebookPath = '/workspace/calculation.wb';
    const slidePath = '/workspace/talk.wslide';
    const notebook = {
        uri: { fsPath: notebookPath, toString: () => `file://${notebookPath}` },
        cellCount: 9,
        cellAt: index => ({
            metadata: { toolId: `cell-${index + 1}` },
            document: { uri: { toString: () => `file://${notebookPath}#cell-${index + 1}` } },
        }),
    };
    const editor = {
        notebook,
        selection: null,
        revealRange: (range, type) => revealed.push({ range, type }),
    };
    const slideProvider = {
        revealSlide: async (index, uri, blockId) => { slideReveals.push({ index, uri, blockId }); return true; },
    };
    const eventBus = {
        on: (channel, handler) => { handlers.set(channel, handler); return () => handlers.delete(channel); },
    };
    const stub = makeVscodeStub({
        StatusBarAlignment: { Right: 2 },
        NotebookEditorRevealType: { InCenter: 1 },
        window: {
            activeNotebookEditor: { notebook },
            createStatusBarItem: id => {
                const item = { id, shown: false, hidden: false, disposed: false,
                    show() { this.shown = true; this.hidden = false; },
                    hide() { this.hidden = true; }, dispose() { this.disposed = true; } };
                statusItems.push(item); return item;
            },
            showQuickPick: async picks => picks.find(pick => pick.entry.path === pickPath),
            showInformationMessage: async () => undefined,
            showErrorMessage: message => { throw new Error(message); },
            showNotebookDocument: async () => editor,
        },
        workspace: {
            notebookDocuments: [notebook], textDocuments: [],
            workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
            openNotebookDocument: async () => notebook,
        },
        commands: {
            registerCommand: (name, handler) => { commands.set(name, handler); return { dispose: () => commands.delete(name) }; },
            executeCommand: async (...args) => { openWithCalls.push(args); },
        },
    });
    const { RecentMcpFiles } = withVscodeStub(() => require('../../monitor/recent-mcp-files'), stub);
    const context = {
        subscriptions: [],
        workspaceState: {
            get: (key, fallback) => storage.get(key) || fallback,
            update: async (key, value) => storage.set(key, value),
        },
    };
    const history = new RecentMcpFiles(context, { eventBus, getSlideProvider: () => slideProvider });
    assert.strictEqual(statusItems.length, 1);
    assert.strictEqual(statusItems[0].hidden, true, 'empty history stays hidden');

    const mcp = { source: 'mcp' };
    handlers.get('toolUsage')({
        tool: 'wolfbook_editCell', args: { _activityContext: mcp, cellNumber: 4 },
        result: 'Edited Cell 4 (CellId: cell-4) of 9 in calculation.wb.', ok: true, ts: 1,
    });
    handlers.get('toolUsage')({
        tool: 'wolfbook_runCell', args: { _activityContext: mcp, cellNumber: 7 },
        target: { kind: 'notebook', path: notebookPath },
        result: 'Cell 7: ✓ — 42', ok: true, ts: 2,
    });
    assert.strictEqual(history._history.length, 1, 'repeat activity updates one file row');
    assert.strictEqual(history._history[0].location, 'Cell 7');
    assert.strictEqual(history._history[0].action, 'ran cell');
    assert.strictEqual(statusItems[0].text, '$(history) calculation.wb');

    handlers.get('toolUsage')({
        tool: 'wolfslide_block', args: { _activityContext: mcp, action: 'edit', blockId: 'formula-1' },
        target: { kind: 'slide', path: slidePath },
        result: 'Block formula-1 on slide 3 "Result" — updated: text.', ok: true, ts: 3,
    });
    assert.strictEqual(history._history.length, 2);
    assert.strictEqual(history._history[0].location, 'Slide 3 · Block formula-1');
    assert.strictEqual(statusItems[0].text, '$(history) talk.wslide');

    handlers.get('toolUsage')({
        tool: 'wolfbook_editCell', args: { _activityContext: { source: 'copilot' }, cellNumber: 2 },
        target: { kind: 'notebook', path: '/workspace/ignored.wb' },
        result: 'Edited Cell 2.', ok: true, ts: 4,
    });
    assert.strictEqual(history._history.length, 2, 'non-MCP tool calls are ignored');

    pickPath = notebookPath;
    await commands.get('wolfbook.showRecentMcpFiles')();
    assert.strictEqual(editor.selection.start, 6);
    assert.strictEqual(revealed[0].range.start, 6);

    pickPath = slidePath;
    await commands.get('wolfbook.showRecentMcpFiles')();
    assert.strictEqual(openWithCalls[0][0], 'vscode.openWith');
    assert.strictEqual(openWithCalls[0][1].fsPath, slidePath);
    assert.strictEqual(openWithCalls[0][2], 'wolfbook.slideEditor');
    assert.deepStrictEqual(slideReveals[0], {
        index: 2, uri: `file://${slidePath}`, blockId: 'formula-1',
    });

    for (let i = 0; i < 12; i++) {
        handlers.get('toolUsage')({
            tool: 'wolfbook_insertCells', args: { _activityContext: mcp },
            target: { kind: 'notebook', path: path.join('/workspace', `n${i}.wb`) },
            result: `Inserted 1 cell(s) as Cell ${i + 1}.`, ok: true, ts: 10 + i,
        });
    }
    assert.strictEqual(history._history.length, 10, 'history is capped at ten unique files');
    assert.strictEqual(history._history[0].path, '/workspace/n11.wb');

    history.dispose();
    assert(statusItems[0].disposed);
    assert(!handlers.has('toolUsage'));

    const extensionRoot = path.resolve(__dirname, '../..');
    const providerSource = fs.readFileSync(path.join(extensionRoot, 'slideEditorProvider.js'), 'utf8');
    const slideHtml = fs.readFileSync(path.resolve(extensionRoot, '../../media/wslide-editor.html'), 'utf8');
    assert(providerSource.includes("cmd: 'navigateToSlide'"));
    assert(slideHtml.includes("msg.cmd === 'navigateToSlide'"));
    console.log('recent MCP files: OK');
})().catch(error => { console.error(error); process.exit(1); });
