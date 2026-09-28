'use strict';

// Stability: MCP protocol revision + transports (2026-09-27).
//
//   * initialize always answered 2024-11-05, so no client could use a newer
//     feature — now the client's version is echoed when supported;
//   * tools carried no annotations, so hosts asked before every read —
//     now every tool has them (gated on protocol ≥ 2025-03-26, title ≥ 2025-06-18);
//   * the only HTTP transport was the deprecated HTTP+SSE pair — Streamable
//     HTTP now lives at /mcp, and /sse keeps working unchanged;
//   * sandboxed hosts (Claude Science) cannot reach TCP — the primary also
//     serves a private Unix socket, and the real stdio bridge uses it.
//
// Uses private servers only: never _startListening (it would notify the live
// Wolfbook windows in the shared registry) and never the default socket path.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) { if (request === 'vscode') return {}; return originalLoad.apply(this, arguments); };
const { WolframMCPServer, loadMCPSchemas, MCP_PROTOCOL_VERSIONS } = require('../../claude-mcp/server');
const { TOOL_CLASS } = require('../../claude-mcp/tool-annotations');
Module._load = originalLoad;

const pkgPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const schemas = loadMCPSchemas(pkgPath);
const bridgePath = path.join(__dirname, '..', '..', 'claude-mcp', 'stdio-bridge.js');
const text = t => ({ content: [{ value: t }] });
const toolMap = () => new Map([['wolfbook_lookupSymbol', { invoke: async () => text('Plot — generates a plot. K1 idle') }]]);

function newServer(opts = {}) {
    const s = new WolframMCPServer(toolMap(), schemas, opts);
    s._docContext = () => ({ slides: false, paper: false });
    return s;
}

/** HTTP request → { status, headers, body (parsed JSON when possible) }. */
function request(target, { method = 'POST', pathName = '/mcp', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({
            ...(target.socketPath ? { socketPath: target.socketPath } : { host: '127.0.0.1', port: target.port }),
            method, path: pathName,
            headers: { Accept: 'application/json, text/event-stream',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers },
        }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', d => { data += d; });
            res.on('end', () => {
                let parsed = data; try { parsed = JSON.parse(data); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function runBridge(args, env = {}) {
    const child = spawn(process.execPath, [bridgePath, ...args], {
        env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = []; let buf = ''; let stderr = '';
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)); } catch (_) {} } });
    child.stderr.on('data', d => { stderr += d; });
    const waitFor = (pred, ms = 8000) => new Promise((ok, bad) => {
        const t0 = Date.now();
        const tick = () => { const hit = lines.find(pred); if (hit) return ok(hit); if (Date.now() - t0 > ms) return bad(new Error(`bridge timeout; stderr: ${stderr}`)); setTimeout(tick, 20); };
        tick();
    });
    return { child, waitFor, send: m => child.stdin.write(JSON.stringify(m) + '\n'), stderr: () => stderr };
}

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
    const cleanup = [];
    try {
        // ── 1. Version negotiation ─────────────────────────────────────────
        {
            const s = newServer();
            for (const v of MCP_PROTOCOL_VERSIONS) {
                const r = await s._dispatch('initialize', { protocolVersion: v, clientInfo: { name: 'neg' } }, `neg-${v}`);
                assert.strictEqual(r.protocolVersion, v, `echoes supported ${v}`);
                assert.strictEqual(r.serverInfo.version, pkg.version, 'serverInfo.version is the extension version');
                assert.strictEqual(r.serverInfo.title, v >= '2025-06-18' ? 'Wolfbook' : undefined);
            }
            const future = await s._dispatch('initialize', { protocolVersion: '2099-01-01' }, 'neg-future');
            assert.strictEqual(future.protocolVersion, MCP_PROTOCOL_VERSIONS[0], 'unknown → newest supported');
            assert.strictEqual(MCP_PROTOCOL_VERSIONS[0], '2025-11-25');

            // ── 2. Annotations + titles, gated on the negotiated version ──────
            s._sessionProfiles.set('neg-2024-11-05', 'full');
            s._sessionProfiles.set('neg-2025-11-25', 'full');
            const old = (await s._dispatch('tools/list', {}, 'neg-2024-11-05')).tools;
            assert(old.every(t => !('annotations' in t) && !('title' in t)), '2024-11-05 client gets the old shape');
            const cur = (await s._dispatch('tools/list', {}, 'neg-2025-11-25')).tools;
            assert(cur.length > 40);
            for (const t of cur) {
                assert(t.annotations, `${t.name} has annotations`);
                assert.strictEqual(typeof t.annotations.readOnlyHint, 'boolean');
                assert.strictEqual(typeof t.annotations.openWorldHint, 'boolean');
            }
            const by = Object.fromEntries(cur.map(t => [t.name, t]));
            assert.strictEqual(by.wolfbook_getNotebookContext.annotations.readOnlyHint, true);
            assert.strictEqual(by.wolfbook_getNotebookContext.title, 'Wolfbook: Get Notebook Context');
            assert.strictEqual(by.wolfbook_deleteCell.annotations.destructiveHint, true);
            assert.strictEqual(by.wolfbook_evaluateExpression.annotations.openWorldHint, true);
            assert.strictEqual(by.wolfbook_insertCells.annotations.destructiveHint, false);
            assert.strictEqual(by.wolfbook_list_clients.annotations.readOnlyHint, true, 'synthetic tools too');
            // Lint: every tool the extension declares, and every synthetic one, is classified.
            const declared = pkg.contributes.languageModelTools.map(t => t.name);
            for (const n of [...declared, 'wolfbook_list_clients', 'wolfbook_setTarget', 'wolfbook_waitEvaluation']) {
                assert(TOOL_CLASS[n], `tool-annotations.js has no class for ${n}`);
            }
        }

        // ── 3. Streamable HTTP over TCP ────────────────────────────────────
        const server = newServer();
        const srv = http.createServer((req, res) => server._handle(req, res));
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        cleanup.push(() => new Promise(r => srv.close(r)));
        const tcp = { port: srv.address().port };
        {
            const init = await request(tcp, { body: { jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: '2025-11-25', clientInfo: { name: 'streamable' }, capabilities: {} } } });
            assert.strictEqual(init.status, 200);
            const sid = init.headers['mcp-session-id'];
            assert(/^[0-9a-f-]{36}$/.test(sid), 'initialize mints a session id');
            assert.strictEqual(init.body.result.protocolVersion, '2025-11-25');
            const H = { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-11-25' };

            const note = await request(tcp, { headers: H, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
            assert.strictEqual(note.status, 202, 'notifications are accepted with 202');

            const list = await request(tcp, { headers: H, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
            assert.strictEqual(list.status, 200);
            assert(list.body.result.tools.every(t => t.annotations), 'annotations over /mcp');

            const call = await request(tcp, { headers: H, body: { jsonrpc: '2.0', id: 3, method: 'tools/call',
                params: { name: 'wolfbook_lookupSymbol', arguments: { symbol: 'Plot' } } } });
            assert.strictEqual(call.body.id, 3);
            assert.match(call.body.result.content[0].text, /K1 idle/);

            assert(server._buildSessionList().some(x => x.sessionId === sid), 'a stream-less session is still listed');

            // Server → client stream.
            const events = [];
            const stream = await new Promise((resolve, reject) => {
                const req = http.get({ host: '127.0.0.1', port: tcp.port, path: '/mcp',
                    headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sid } }, res => {
                    assert.strictEqual(res.statusCode, 200);
                    res.setEncoding('utf8');
                    res.on('data', d => { for (const m of d.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1])); });
                    resolve(req);
                });
                req.on('error', reject);
            });
            await new Promise(r => setTimeout(r, 50));
            server._notifyToolsChanged(sid);
            await new Promise(r => setTimeout(r, 100));
            assert(events.some(e => e.method === 'notifications/tools/list_changed'), 'list_changed arrives on the GET stream');
            stream.destroy();

            // Errors a client must be able to rely on.
            assert.strictEqual((await request(tcp, { body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } })).status, 400, 'no session header');
            assert.strictEqual((await request(tcp, { headers: { 'Mcp-Session-Id': 'nope' }, body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } })).status, 404, 'unknown session');
            assert.strictEqual((await request(tcp, { headers: H, body: [{ jsonrpc: '2.0', id: 9, method: 'ping' }] })).status, 400, 'batches refused');
            assert.strictEqual((await request(tcp, { headers: { ...H, 'MCP-Protocol-Version': '1999-01-01' }, body: { jsonrpc: '2.0', id: 9, method: 'ping' } })).status, 400);
            assert.strictEqual((await request(tcp, { headers: { ...H, Host: 'evil.example:80' }, body: { jsonrpc: '2.0', id: 9, method: 'ping' } })).status, 403, 'DNS-rebinding Host refused');
            assert.strictEqual((await request(tcp, { headers: { ...H, Origin: 'http://evil.example' }, body: { jsonrpc: '2.0', id: 9, method: 'ping' } })).status, 403, 'browser Origin refused');
            assert.strictEqual((await request(tcp, { method: 'PUT', headers: H })).status, 405);

            const del = await request(tcp, { method: 'DELETE', headers: H });
            assert.strictEqual(del.status, 200);
            assert.strictEqual((await request(tcp, { headers: H, body: { jsonrpc: '2.0', id: 10, method: 'ping' } })).status, 404, 'ended session is gone');
            assert(!server._buildSessionList().some(x => x.sessionId === sid));

            const eco = await request(tcp, { pathName: '/mcp/economy', body: { jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: '2025-06-18', clientInfo: { name: 'eco' } } } });
            assert.strictEqual(eco.body.result.serverInfo.name, 'wolfbook-economy');

            const health = await request(tcp, { method: 'GET', pathName: '/health' });
            assert.strictEqual(health.body.endpoints.streamable, '/mcp');
            assert.deepStrictEqual(health.body.protocolVersions, MCP_PROTOCOL_VERSIONS);
        }

        // ── 4. Legacy HTTP+SSE still answers, at the client's version ─────
        {
            const b = runBridge([], { WOLFBOOK_MCP_PORT: String(tcp.port) });
            cleanup.push(() => b.child.kill());
            b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'legacy' }, capabilities: {} } });
            const r = await b.waitFor(m => m.id === 1);
            assert.strictEqual(r.result.protocolVersion, '2024-11-05');
            b.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
            const l = await b.waitFor(m => m.id === 2);
            assert(l.result.tools.every(t => !t.annotations), 'legacy client: unchanged list shape');
        }

        // ── 5. Private Unix socket ─────────────────────────────────────────
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbsock-'));   // 0700
        cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const sockPath = path.join(dir, 'mcp.sock');
        {
            // A stale file from a crashed primary is taken over.
            fs.writeFileSync(sockPath, '');
            const s1 = newServer({ socketPath: sockPath });
            await s1._listenSocket();
            assert.strictEqual(s1.socketPath, sockPath, 'listening on the socket');
            assert.strictEqual(fs.statSync(sockPath).mode & 0o777, 0o600);
            const h = await request({ socketPath: sockPath }, { method: 'GET', pathName: '/health' });
            assert.strictEqual(h.body.status, 'ok');
            assert.strictEqual(h.body.socket, sockPath);

            // A LIVE socket is never stolen by a second server.
            const s2 = newServer({ socketPath: sockPath });
            await s2._listenSocket();
            assert.strictEqual(s2.socketPath, null, 'a live socket is left to its owner');

            // Streamable HTTP works over the socket too (no Host check there).
            const init = await request({ socketPath: sockPath }, { body: { jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: '2025-11-25', clientInfo: { name: 'sock' } } } });
            assert.strictEqual(init.body.result.protocolVersion, '2025-11-25');

            // The REAL bridge over the socket, with TCP unreachable (a sandbox).
            const deadPort = await freePort();
            const b = runBridge([`--socket=${sockPath}`], { WOLFBOOK_MCP_PORT: String(deadPort) });
            cleanup.push(() => b.child.kill());
            b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-science' }, capabilities: {} } });
            const r = await b.waitFor(m => m.id === 1);
            assert.strictEqual(r.result.protocolVersion, '2025-11-25');
            assert.match(b.stderr(), /unix:/, 'the bridge reports the socket it used');
            b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wolfbook_lookupSymbol', arguments: { symbol: 'Plot' } } });
            const c = await b.waitFor(m => m.id === 2);
            assert.match(c.result.content[0].text, /K1 idle/);

            await s1.stop();
            assert(!fs.existsSync(sockPath), 'stop() removes the socket file');
        }
        {
            // A directory other users can write to is refused — by the server AND the bridge.
            const open = path.join(dir, 'shared');
            fs.mkdirSync(open); fs.chmodSync(open, 0o777);
            const openSock = path.join(open, 'mcp.sock');
            const s3 = newServer({ socketPath: openSock });
            await s3._listenSocket();
            assert.strictEqual(s3.socketPath, null, 'server refuses a shared directory');
            const rogue = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); });
            await new Promise(r => rogue.listen(openSock, r));
            cleanup.push(() => new Promise(r => rogue.close(r)));
            const b = runBridge([`--socket=${openSock}`], { WOLFBOOK_MCP_PORT: String(tcp.port) });
            cleanup.push(() => b.child.kill());
            b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'wary' }, capabilities: {} } });
            await b.waitFor(m => m.id === 1);
            assert.match(b.stderr(), /Ignoring .*not private/, 'bridge ignores the impostor socket');
            assert.match(b.stderr(), new RegExp(`port ${tcp.port}`), '…and falls back to TCP');
        }
        // ── 6. Access: token on TCP, none on the socket; new-agent notice; block list ──
        {
            const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtok-'));
            cleanup.push(() => fs.rmSync(tokenDir, { recursive: true, force: true }));
            process.env.WOLFBOOK_MCP_TOKEN_FILE = path.join(tokenDir, 'mcp-token');
            const auth = require('../../claude-mcp/auth');
            const token = auth.getToken({ create: true });
            assert(token && token.length >= 40, 'a strong token is created');
            assert.strictEqual(fs.statSync(process.env.WOLFBOOK_MCP_TOKEN_FILE).mode & 0o777, 0o600);
            assert.strictEqual(auth.getToken({ create: true }), token, 'created once, then reused');

            const announced = []; const blocked = new Set(['evil-agent']);
            const guarded = newServer({ requireAuth: true, socketPath: path.join(dir, 'auth.sock'),
                onNewClient: n => announced.push(n), isClientBlocked: n => blocked.has(n) });
            const gsrv = http.createServer((req, res) => guarded._handle(req, res));
            await new Promise(r => gsrv.listen(0, '127.0.0.1', r));
            cleanup.push(() => new Promise(r => gsrv.close(r)));
            const g = { port: gsrv.address().port };
            const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code' } } };

            assert.strictEqual((await request(g, { body: init })).status, 401, 'no token → 401');
            assert.strictEqual((await request(g, { headers: { Authorization: 'Bearer wrong' }, body: init })).status, 401, 'wrong token → 401');
            assert.strictEqual((await request(g, { method: 'GET', pathName: '/sse' })).status, 401, 'legacy SSE also needs it');
            assert.strictEqual((await request(g, { method: 'GET', pathName: '/health' })).status, 200, '/health stays open (discovery)');
            assert.strictEqual((await request(g, { method: 'GET', pathName: '/workers' })).status, 200, 'read-only window list stays open');
            assert.strictEqual((await request(g, { method: 'POST', pathName: '/register', body: { clientId: 'x', port: 1 } })).status, 401,
                'a stranger cannot register as a worker and receive tool calls');
            assert.strictEqual((await request(g, { method: 'GET', pathName: '/workers', headers: { Host: 'evil.example:1' } })).status, 403,
                'Host check covers every route, not just /mcp');
            const ok = await request(g, { headers: auth.authHeaders(), body: init });
            assert.strictEqual(ok.status, 200, 'the right token gets in');
            assert.deepStrictEqual(announced, ['claude-code'], 'first connection of a new agent is announced');
            await request(g, { headers: auth.authHeaders(), body: init });
            assert.deepStrictEqual(announced, ['claude-code'], '…once, not per session');

            // The socket needs no token: its 0700 directory is the lock.
            await guarded._listenSocket();
            const viaSock = await request({ socketPath: guarded.socketPath }, { body: init });
            assert.strictEqual(viaSock.status, 200);

            // A blocked agent can connect and list, but not run tools. Never blocks anyone else.
            const evil = await request(g, { headers: auth.authHeaders(), body: { ...init, params: { ...init.params, clientInfo: { name: 'evil-agent' } } } });
            const esid = evil.headers['mcp-session-id'];
            const call = await request(g, { headers: { ...auth.authHeaders(), 'Mcp-Session-Id': esid },
                body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wolfbook_lookupSymbol', arguments: { symbol: 'Plot' } } } });
            assert.strictEqual(call.body.result.isError, true);
            assert.match(call.body.result.content[0].text, /blocked "evil-agent".*Manage Agent Access/);

            // The real bridge reads the token file by itself — zero configuration.
            const b = runBridge([], { WOLFBOOK_MCP_PORT: String(g.port) });
            cleanup.push(() => b.child.kill());
            b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'codex' }, capabilities: {} } });
            assert.strictEqual((await b.waitFor(m => m.id === 1)).result.protocolVersion, '2025-11-25');
            b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wolfbook_lookupSymbol', arguments: { symbol: 'Plot' } } });
            assert.match((await b.waitFor(m => m.id === 2)).result.content[0].text, /K1 idle/);
            await guarded.stop();

            // Worker windows: /invoke runs tools, so it needs the token; /health does not.
            const { WorkerServer } = require('../../claude-mcp/worker');
            const ws = new WorkerServer(toolMap(), 'VSCode[test]');
            clearInterval(ws._transactionSweepTimer);
            ws.requireAuth = true;
            const wsrv = http.createServer((req, res) => ws._handle(req, res));
            await new Promise(r => wsrv.listen(0, '127.0.0.1', r));
            cleanup.push(() => new Promise(r => wsrv.close(r)));
            const w = { port: wsrv.address().port };
            const invoke = { name: 'wolfbook_lookupSymbol', arguments: { symbol: 'Plot' } };
            assert.strictEqual((await request(w, { pathName: '/invoke', body: invoke })).status, 401, 'worker /invoke without token → 401');
            assert.strictEqual((await request(w, { method: 'GET', pathName: '/health' })).status, 200);
            assert.notStrictEqual((await request(w, { pathName: '/invoke', headers: auth.authHeaders(), body: invoke })).status, 401,
                'the primary (holding the token) still reaches its workers');
        }
        console.log('stability-mcp-transport: OK');
    } finally {
        for (const f of cleanup.reverse()) { try { await f(); } catch (_) {} }
    }
})().then(() => process.exit(0), err => { console.error(err); process.exit(1); });
