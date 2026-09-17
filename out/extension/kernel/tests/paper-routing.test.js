'use strict';
const assert = require('assert');
const Module = require('module');
const { selectPaperClient } = require('../../claude-mcp/paper-routing');
const clients = [
    { clientId: 'A', workspaceRoots: ['/work'], paperFiles: [] },
    { clientId: 'B', workspaceRoots: ['/work/paper'], paperFiles: ['/elsewhere/open.tex'] },
];
assert.equal(selectPaperClient(clients, '/work/paper/main.tex')[0].clientId, 'B');
assert.equal(selectPaperClient(clients, '/elsewhere/open.tex')[0].clientId, 'B');
assert.equal(selectPaperClient(clients, '/work/paper/main.tex', 'A')[0].clientId, 'A');
assert.equal(selectPaperClient(clients, '/workspace/main.tex').length, 0);
assert.equal(selectPaperClient(clients, null).length, 0);
assert.equal(selectPaperClient([...clients, { ...clients[1], clientId: 'C' }], '/elsewhere/open.tex').length, 2);
assert.equal(selectPaperClient([{ clientId: 'W', workspaceRoots: ['C:\\Paper'] }], 'c:\\paper\\main.tex')[0].clientId, 'W');
const stub = require('./_stub-vscode').makeVscodeStub();
const original = Module._load;
let WolframMCPServer;
try {
    Module._load = function(name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
    ({ WolframMCPServer } = require('../../claude-mcp/server'));
} finally { Module._load = original; }
(async () => {
    const server = Object.create(WolframMCPServer.prototype);
    server._ownClientId = 'A'; server._workers = new Map([['B', { ...clients[1], port: 123 }]]);
    server._pruneWorkers = () => {}; server._workspaceForClient = id => id;
    server._sessionTargets = new Map([['agent', { clientId: 'A', notebook: '/wrong.wb' }]]);
    const invoked = [];
    server._invokeWorker = async (port, name, args) => {
        invoked.push({ port, name, args });
        return { content: [{ type: 'text', text: JSON.stringify({ transaction_id: 'tx1', applied: false }) }] };
    };
    const preview = await server._dispatchPaper('paper_previewEdit', { file: '/work/paper/main.tex', notebook: '/wrong.wb', kernel_id: 'wrong' }, 'agent');
    assert.equal(preview.structuredContent.routing.client_id, 'B');
    assert.equal(invoked[0].args.notebook, undefined);
    assert.equal(invoked[0].args.kernel_id, undefined);
    await server._dispatchPaper('paper_applyEdit', { transaction_id: 'tx1' }, 'agent');
    assert.equal(invoked.length, 2, 'transaction-only apply returns to owner');
    const mismatch = await server._dispatchPaper('paper_applyEdit', { transaction_id: 'tx1', client_id: 'A' });
    assert.equal(mismatch.structuredContent.code, 'transaction-client-mismatch');
    assert.equal(invoked.length, 2);
    server._workers.clear();
    const gone = await server._dispatchPaper('paper_applyEdit', { transaction_id: 'tx1' });
    assert.equal(gone.structuredContent.code, 'transaction-client-unavailable');
    console.log('Paper file routing and transaction ownership: OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
