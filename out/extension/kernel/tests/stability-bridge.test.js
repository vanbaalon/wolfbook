'use strict';

// Stability: the stdio bridge that Codex and Claude Code connect through.
//
// Two bugs, both invisible from the server side:
//   * --profile=notebook|slides|paper was dropped — the bridge only mapped
//     economy, so these clients could never select a smaller tool list;
//   * server-initiated notifications were discarded — a stdio client never
//     learned that its tool list changed (notifications/tools/list_changed).
//
// Spawns the REAL bridge process against a real test server on a private port
// (WOLFBOOK_MCP_PORT), never the live Wolfbook server.

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) { if (request === 'vscode') return {}; return originalLoad.apply(this, arguments); };
const { WolframMCPServer, loadMCPSchemas } = require('../../claude-mcp/server');
Module._load = originalLoad;

const bridgePath = path.join(__dirname, '..', '..', 'claude-mcp', 'stdio-bridge.js');
const schemas = loadMCPSchemas(path.join(__dirname, '..', '..', '..', '..', 'package.json'));

function runBridge(port, profileArg) {
    const child = spawn(process.execPath, [bridgePath, ...(profileArg ? [profileArg] : [])], {
        env: { ...process.env, WOLFBOOK_MCP_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = []; let buf = '';
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)); } catch (_) {} } });
    const waitFor = (pred, ms = 5000) => new Promise((ok, bad) => {
        const t0 = Date.now();
        const tick = () => { const hit = lines.find(pred); if (hit) return ok(hit); if (Date.now() - t0 > ms) return bad(new Error('bridge: timeout')); setTimeout(tick, 20); };
        tick();
    });
    const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
    return { child, lines, waitFor, send };
}

(async () => {
    const server = new WolframMCPServer(new Map(), schemas, {});
    server._docContext = () => ({ slides: false, paper: false });
    // /health must answer like a Wolfbook server for the bridge to connect.
    const srv = http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok' })); }
        server._handle(req, res);
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const bridges = [];
    try {
        // 1. Every profile passes through.
        for (const profile of ['notebook', 'paper', 'economy']) {
            const b = runBridge(port, `--profile=${profile}`); bridges.push(b);
            b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: `bridge-${profile}` }, capabilities: {} } });
            await b.waitFor(m => m.id === 1);
            const sessionId = [...server._sessionClientNames].find(([, n]) => n === `bridge-${profile}`)?.[0];
            assert.ok(sessionId, `bridge session registered (${profile})`);
            assert.strictEqual(server._sessionProfiles.get(sessionId), profile, `--profile=${profile} reaches the server`);
        }
        // No flag = the server default (auto).
        const d = runBridge(port, null); bridges.push(d);
        d.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'bridge-default' }, capabilities: {} } });
        const init = await d.waitFor(m => m.id === 1);
        assert.strictEqual(init.result.capabilities.tools.listChanged, true);
        const sid = [...server._sessionClientNames].find(([, n]) => n === 'bridge-default')[0];
        assert.strictEqual(server._sessionProfiles.get(sid), 'auto', 'no flag means the server default, auto');

        // 2. A server notification reaches the stdio client.
        server._notifyToolsChanged(sid);
        await d.waitFor(m => m.method === 'notifications/tools/list_changed');

        // 3. And enabling a family through the bridge produces one.
        const before = d.lines.length;
        d.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wolfbook_tools', arguments: { action: 'enable', families: ['research'] } } });
        await d.waitFor(m => m.id === 2);
        await d.waitFor(m => m.method === 'notifications/tools/list_changed' && d.lines.indexOf(m) >= before);
        d.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        const list = await d.waitFor(m => m.id === 3);
        assert.ok(list.result.tools.some(t => t.name === 'wolfbook_literatureSearch'), 'enabled family visible through the bridge');
        console.log('stability-bridge: all assertions passed');
    } finally {
        for (const b of bridges) b.child.kill();
        srv.close();
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
