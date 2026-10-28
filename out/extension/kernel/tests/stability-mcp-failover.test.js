'use strict';

// Real stdio bridge + real MCP handlers + worker standby on private ports.
// Simulate a frozen primary (TCP still open; HTTP no longer answers). Never
// touches the user's registry, extension hosts, notebooks or Wolfram kernels.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');
const root = process.env.WPAPER_EXT_ROOT || path.resolve(__dirname, '../../../..');
const { WolframMCPServer } = withVscodeStub(() => require(root + '/out/extension/claude-mcp/server'), makeVscodeStub());
const { WorkerServer } = withVscodeStub(() => require(root + '/out/extension/claude-mcp/worker'), makeVscodeStub());
const registry = require(root + '/out/extension/claude-mcp/registry');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-failover-'));
const registryFile = path.join(dir, 'private-registry.json');
const stalledHealth = path.join(dir, 'stalled-health.cjs');
fs.writeFileSync(stalledHealth, `
const http = require('node:http'), { EventEmitter } = require('node:events');
const get = http.get;
http.get = function(options, ...args) {
    if (options?.port === Number(process.env.WOLFBOOK_MCP_PORT) && options.path === '/health') {
        const req = new EventEmitter();
        req.destroy = () => req.emit('error', new Error('mock SYN backlog never connected'));
        return req; // No connection event and NO socket timeout event.
    }
    return get.call(this, options, ...args);
};
`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, ms = 10000) {
    const start = Date.now();
    while (!predicate()) { if (Date.now() - start > ms) throw new Error(message); await sleep(20); }
}

function bridge(port, stallHealth = false) {
    const child = spawn(process.execPath, [...(stallHealth ? ['--require', stalledHealth] : []), root + '/out/extension/claude-mcp/stdio-bridge.js', '--profile=paper'], {
        env: { ...process.env, WOLFBOOK_MCP_PORT: String(port), WOLFBOOK_MCP_REGISTRY_FILE: registryFile },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '', stderr = ''; const replies = [];
    child.stdout.on('data', data => {
        buf += data;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { replies.push(JSON.parse(line)); } catch {}
        }
    });
    child.stderr.on('data', data => { stderr += data; });
    return { child, replies, log: () => stderr,
        send: rpc => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...rpc }) + '\n'),
        reply: async id => { await until(() => replies.some(r => r.id === id), `reply ${id}: ${stderr}`); return replies.find(r => r.id === id); },
    };
}

async function scenario(changedKernel) {
    const implicit = changedKernel === 'implicit';
    let frozen = false, edits = 0, cancelled = 0, finishEdit, releaseHold;
    let kid = 'k-existing';
    const calls = [];
    const tools = new Map([['wolfbook_lookupSymbol', { invoke: async ({ input }) => {
        calls.push(input);
        if (input.symbol === 'Hold') await new Promise(resolve => { releaseHold = resolve; });
        return { content: [{ value: 'healthy worker reply' }] };
    } }]]);
    const primary = new WolframMCPServer(tools, [], { waitMs: 60000 });
    const standby = new WolframMCPServer(tools, [], { waitMs: 60000 });
    primary.setOwnClientInfo('primary', [], 'primary');
    standby.setOwnClientInfo('healthy', ['/isolated/notes.wb'], 'healthy');
    standby.setKernelProvider(() => [{ kernel_id: kid, kernel_label: 'K1', notebooks: ['/isolated/notes.wb'], lifecycle: 'busy' }]);
    const originalDispatch = primary._dispatch.bind(primary);
    primary._dispatch = async (method, params, sid) => {
        if (method === 'tools/call' && params.name === 'wolfbook_editCell') {
            edits++;
            return new Promise(resolve => { finishEdit = resolve; });
        }
        return originalDispatch(method, params, sid);
    };
    primary._cancelSessionOperations = async () => { cancelled++; };
    const worker = new WorkerServer(tools, 'healthy');
    worker.getMcpServer = () => standby;
    const srv = http.createServer((req, res) => { if (!frozen) primary._handle(req, res); });
    const secondary = http.createServer((req, res) => worker._handle(req, res));
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => secondary.listen(0, '127.0.0.1', resolve));
    worker._port = secondary.address().port;
    const entries = () => [{ clientId: 'primary', workerPort: srv.address().port, pid: process.pid,
        generation: 'primary-host', registeredAt: Date.now(), notebooks: [], kernels: [] },
    { clientId: 'healthy', workerPort: worker.port, pid: process.pid,
        generation: 'same-worker', registeredAt: Date.now(), workspace: 'healthy',
        notebooks: ['/isolated/notes.wb'], kernels: standby._getOwnKernels() }];
    const listAlive = registry.listAlive;
    registry.listAlive = entries;
    primary.refreshWorkersFromRegistry();
    fs.writeFileSync(registryFile, JSON.stringify(entries()));
    const clients = [];
    try {
        const b = bridge(srv.address().port); clients.push(b);
        b.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fault-test' } } });
        assert((await b.reply(1)).result);
        if (implicit) {
            b.send({ id: 2, method: 'tools/list', params: {} });
            await b.reply(2);
        } else {
            b.send({ id: 2, method: 'tools/call', params: { name: 'wolfbook_setTarget', arguments: { client_id: 'healthy', notebook: '/isolated/notes.wb' } } });
            assert.equal((await b.reply(2)).result.structuredContent.target.kernelId, 'k-existing');
        }
        b.send({ id: 3, method: 'tools/call', params: { name: 'wolfbook_tools', arguments: { action: 'enable', families: ['research'] } } });
        await b.reply(3);
        b.send({ id: 4, method: 'tools/call', params: { name: 'wolfbook_editCell', arguments: { value: 'do not apply twice' } } });
        await until(() => edits === 1, 'edit must reach primary once');
        frozen = true;
        if (changedKernel === true) kid = 'k-rebound';
        const interrupted = await b.reply(4);
        assert.match(interrupted.error.message, /not replayed/i);
        await until(() => b.log().includes('Reconnected through'), b.log());
        assert.equal(edits, 1);
        assert.equal(cancelled, 0, 'failover must leave the original SSE connection/evaluation alive');
        const sid = [...standby._sessionClientNames].find(([, name]) => name === 'fault-test')[0];
        assert.equal(standby._sessionProfiles.get(sid), 'paper');
        assert(standby._sessionExposure.get(sid).families.has('research'));
        if (implicit) assert.equal(standby._sessionTargets.get(sid).clientId, 'primary', 'default owner must not silently change to the standby window');
        const explicit = implicit ? { client_id: 'healthy' } : {};
        b.send({ id: 5, method: 'tools/call', params: { name: 'wolfbook_lookupSymbol', arguments: { symbol: 'Plot', ...explicit } } });
        const reply = await b.reply(5);
        if (changedKernel === true) {
            assert.match(reply.error.message, /target could not be restored/);
            assert.equal(calls.length, 0, 'must not silently adopt a replacement kernel');
            b.send({ id: 6, method: 'tools/call', params: { name: 'wolfbook_tools', arguments: {
                action: 'call', name: 'wolfbook_editCell', arguments: { value: 'wrapped edit' },
            } } });
            assert.match((await b.reply(6)).error.message, /target could not be restored/);
        } else {
            assert.match(reply.result.content[0].text, /healthy worker reply/);
            if (!implicit) {
                assert.equal(calls[0].notebook, '/isolated/notes.wb');
                assert.equal(calls[0].kernel_id, 'k-existing');
            }
            // Reuse a request ID while a late old-hub reply is still possible.
            b.send({ id: 4, method: 'tools/call', params: { name: 'wolfbook_lookupSymbol', arguments: { symbol: 'Hold', ...explicit } } });
            await until(() => releaseHold, 'standby lookup must be pending');
            finishEdit({ content: [{ type: 'text', text: 'late old reply' }] });
            await sleep(100);
            assert.equal(b.replies.filter(r => r.id === 4).length, 1, 'late response cannot settle a new request with the same ID');
            releaseHold();
            await until(() => b.replies.filter(r => r.id === 4).length === 2, 'healthy reply expected');
            assert.match(b.replies.filter(r => r.id === 4)[1].result.content[0].text, /healthy worker reply/);
        }
        // A newly launched bridge must discover a healthy worker while the
        // primary listener is still present and hung.
        const fresh = bridge(srv.address().port, true); clients.push(fresh);
        fresh.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'fresh-fault-test' }, capabilities: {} } });
        assert((await fresh.reply(1)).result);
        assert(fresh.log().includes(`port ${worker.port}`));
        assert.equal(edits, 1);
        // A closed stream can reconnect to the SAME healthy endpoint, rather
        // than permanently excluding it as if its event loop had frozen.
        const freshSid = [...standby._sessionClientNames].find(([, name]) => name === 'fresh-fault-test')[0];
        standby._sessions.get(freshSid).end();
        await sleep(100);
        fresh.send({ id: 9, method: 'ping', params: {} });
        assert.deepEqual((await fresh.reply(9)).result, {});
    } finally {
        for (const b of clients) b.child.kill();
        finishEdit?.({ content: [{ type: 'text', text: 'cleanup' }] }); releaseHold?.();
        clearInterval(worker._transactionSweepTimer);
        registry.listAlive = listAlive;
        for (const s of [srv, secondary]) { s.closeAllConnections(); s.close(); }
        await primary.stop(); await standby.stop();
    }
}

async function heartbeatDeadline() {
    const { EventEmitter } = require('node:events');
    const worker = new WorkerServer(new Map(), 'isolated-heartbeat');
    worker._port = 31000;
    const get = http.get, write = registry.writeEntry, interval = global.setInterval;
    let poll, timer, heartbeat, failures = 0;
    http.get = () => { const req = new EventEmitter(); req.destroy = () => req.emit('error', new Error('no connect')); return req; };
    registry.writeEntry = entry => { heartbeat = entry; };
    global.setInterval = callback => { poll = callback; return timer = interval(() => {}, 3600000); };
    worker._onHealthFail = () => { failures++; };
    try {
        worker._startHealthPolling();
        poll();
        assert.equal(heartbeat.workerPort, 31000, 'worker heartbeat must not depend on primary health');
        await sleep(2100);
        assert.equal(failures, 1, 'absolute health deadline must fire without a socket timeout event');
    } finally {
        http.get = get; registry.writeEntry = write; global.setInterval = interval;
        clearInterval(timer); clearInterval(worker._transactionSweepTimer);
    }
}

(async () => {
    try { await scenario(false); await scenario(true); await scenario('implicit'); await heartbeatDeadline(); console.log('stability-mcp-failover: all assertions passed'); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
