'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { listFolderThreads, inFolder, register } = require('../../codex-history');
const root = path.join(os.tmpdir(), 'wolfbook-history');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
(async () => {
    assert(inFolder(root, root));
    assert(inFolder(path.join(root, 'nested'), root));
    assert(!inFolder(root + '-other', root));
    assert(!inFolder(path.dirname(root), root));
    assert(!inFolder('relative', root));
    function fixture(replies) {
        const requests = [];
        let killed = false;
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { killed = true; queueMicrotask(() => child.emit('exit', 0)); };
        child.stdin = new Writable({ write(bytes, encoding, callback) {
            const message = JSON.parse(bytes.toString()); requests.push(message);
            if (message.id) queueMicrotask(() => {
                const response = message.method === 'initialize' ? { result: {} } : replies.shift();
                if (response) child.stdout.write(JSON.stringify({ id: message.id, ...response }) + '\n');
            });
            callback();
        } });
        return { spawn: () => child, requests, killed: () => killed };
    }
    const f = fixture([
        { result: { data: [{ id: id(1), cwd: root + '-other', updatedAt: 99 }], nextCursor: 'next' } },
        { result: { data: [{ id: id(2), cwd: root, updatedAt: 1 }, { id: id(3), cwd: path.join(root, 'nested'), updatedAt: 4 },
            { id: '../invalid', cwd: root }], nextCursor: 'last' } },
        { result: { data: [{ id: id(2), cwd: root, updatedAt: 2 }], nextCursor: null } },
    ]);
    const threads = await listFolderThreads('codex', root, { spawn: f.spawn });
    assert.deepStrictEqual(threads.map(t => t.id), [id(3), id(2)], 'all pages filtered, deduplicated, newest first');
    assert.strictEqual(f.requests.filter(r => r.method === 'thread/list').length, 3);
    assert.strictEqual(f.requests[2].params.archived, false);
    assert(!f.requests[2].params.sourceKinds.includes('subAgent'));
    assert(f.killed(), 'app server closed after listing');
    const broken = fixture([{ error: { message: 'Cannot read history' } }]);
    await assert.rejects(listFolderThreads('codex', root, { spawn: broken.spawn }), /Cannot read history/);
    assert(broken.killed());
    const stuck = fixture([]);
    await assert.rejects(listFolderThreads('codex', root, { spawn: stuck.spawn, timeoutMs: 20 }), /too long/);
    assert(stuck.killed());
    const repeated = fixture([1, 2].map(() => ({ result: { data: [], nextCursor: 'same' } })));
    await assert.rejects(listFolderThreads('codex', root, { spawn: repeated.spawn }), /repeated page/);

    let command, item, info, error;
    const context = { subscriptions: [] };
    const vscode = {
        commands: { registerCommand(name, fn) { assert.strictEqual(name, 'wolfbook.codexHistory'); command = fn; return { dispose() {} }; } },
        workspace: { workspaceFolders: [], isTrusted: true },
        extensions: { getExtension: () => ({}) }, StatusBarAlignment: { Right: 2 },
        window: { createStatusBarItem() { item = { show() {}, dispose() {} }; return item; },
            showInformationMessage: text => { info = text; }, showErrorMessage: text => { error = text; } },
    };
    register(context, vscode, () => { throw Error('must not spawn'); });
    assert.strictEqual(item.command, 'wolfbook.codexHistory');
    await command(); assert.match(info, /Open a workspace folder/);
    vscode.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: root } }];
    vscode.workspace.isTrusted = false;
    await command(); assert.match(error, /Trust this workspace/);
    let opened, queriedRoot;
    vscode.workspace.isTrusted = true;
    vscode.workspace.workspaceFolders.push({ uri: { scheme: 'file', fsPath: '/another-root' } });
    vscode.Uri = { parse: value => value };
    vscode.env = { uriScheme: 'vscode', openExternal: async uri => { opened = uri; return true; } };
    vscode.window.showQuickPick = async (promise, options) => {
        assert.match(options.title, /wolfbook-history/);
        const items = await promise;
        assert.strictEqual(items[0].detail, 'nested');
        return items[0];
    };
    register(context, vscode, () => 'codex', async (executable, folder) => {
        queriedRoot = folder;
        return [{ id: id(3), cwd: path.join(root, 'nested'), name: 'Session title', updatedAt: 4 }];
    });
    await command();
    assert.strictEqual(queriedRoot, root, 'scope is the main folder, not secondary workspace roots');
    assert.strictEqual(opened, `vscode://openai.chatgpt/local/${id(3)}`);
    opened = null;
    vscode.window.showQuickPick = async promise => { await promise; return undefined; };
    await command(); assert.strictEqual(opened, null, 'cancelling never opens a session');
    console.log('Codex history: folder boundaries, nested folders, pagination, sorting, deduplication, errors, timeout, process cleanup, command and trust checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
