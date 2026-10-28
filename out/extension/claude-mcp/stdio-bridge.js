#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Wolfbook MCP stdio bridge — spawned by Claude Code as a child process.
// Speaks MCP over stdin/stdout, forwarding all requests to the HTTP/SSE
// server running inside the VS Code extension on localhost:27182+.
//
// Why stdio instead of SSE?
//   Claude Code reads its config at startup and tries to connect immediately.
//   The VS Code extension MCP server starts ~1-2s later.  By switching to
//   stdio, Claude Code spawns US — we wait for the HTTP server to be ready,
//   then transparently relay.  No timing race.
//
// Sandboxed hosts (Claude Science) cannot reach TCP 127.0.0.1; pass
// --socket=<path> (or WOLFBOOK_MCP_SOCKET) to use the primary's private Unix
// socket instead. The bridge tries the socket first, then the TCP ports, so
// it still works with an older Wolfbook that has no socket. This file must
// stay self-contained (only node built-ins): it is copied out of the
// extension to a stable path the sandbox is allowed to read.
//
// Claude Code config (~/.claude/settings.json):
//   {
//     "mcpServers": {
//       "wolfbook": {
//         "command": "node",
//         "args": ["/path/to/stdio-bridge.js"]
//       }
//     }
//   }
// (The wolfbook.configureClaude command writes this automatically.)
// ---------------------------------------------------------------------------

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// WOLFBOOK_MCP_PORT pins one port (tests use it so they never reach a live server).
const PINNED_PORT   = Number(process.env.WOLFBOOK_MCP_PORT) || 0;
const DEFAULT_PORT  = PINNED_PORT || 27182;
const PORT_RANGE    = PINNED_PORT ? 0 : 20;
const POLL_INTERVAL = 1000;   // ms between health-check retries
const MAX_WAIT_MS   = 60000;  // give VS Code up to 60s to start
const PING_TIMEOUT  = 1000;   // ms per health-check attempt
const PROFILE_ARG   = process.argv.slice(2).find(arg => arg.startsWith('--profile='));
// No flag = the server default (auto). Every profile is passed through; this used
// to map only economy and silently drop notebook/slides/paper.
const PROFILE       = PROFILE_ARG ? PROFILE_ARG.slice('--profile='.length) : '';
const SSE_PATH      = PROFILE === 'economy' ? '/sse/economy'
                    : PROFILE ? `/sse?profile=${encodeURIComponent(PROFILE)}` : '/sse';
const SOCKET_ARG    = process.argv.slice(2).find(arg => arg.startsWith('--socket='));
const SOCKET_PATH   = SOCKET_ARG ? SOCKET_ARG.slice('--socket='.length) : (process.env.WOLFBOOK_MCP_SOCKET || '');

// Over TCP the server wants the per-user token Wolfbook keeps in ~/.wolfbook/mcp-token
// (claude-mcp/auth.js). Inside a sandbox that cannot read it, the socket needs none.
function readToken() {
    try {
        const file = process.env.WOLFBOOK_MCP_TOKEN_FILE || path.join(require('os').homedir(), '.wolfbook', 'mcp-token');
        return fs.readFileSync(file, 'utf8').trim() || null;
    } catch { return null; }
}

// A server "target" is { socketPath } or { port }; every request goes through here.
function targetOptions(target, extra) {
    if (target.socketPath) return { socketPath: target.socketPath, ...extra };
    const token = readToken();
    const headers = { ...(extra.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    return { hostname: '127.0.0.1', port: target.port, ...extra, headers };
}
function describeTarget(target) {
    return target.socketPath ? `unix:${target.socketPath}` : `port ${target.port}`;
}

// /tmp is shared: only talk to a socket in a directory WE own that nobody else
// can write to, or another user could impersonate Wolfbook to this client.
function socketDirSafe(socketPath) {
    try {
        const st = fs.lstatSync(path.dirname(socketPath));
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        return st.isDirectory() && !st.isSymbolicLink() &&
            (uid == null || st.uid === uid) && (st.mode & 0o022) === 0;
    } catch { return false; }
}

// ── Find the HTTP server ───────────────────────────────────────────────────
function checkTarget(target) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true; clearTimeout(deadline);
            if (!value) req.destroy();
            resolve(value);
        };
        // Socket idle timeouts do not reliably cover a SYN waiting in a full
        // listen backlog. Discovery needs an absolute deadline as well.
        const deadline = setTimeout(() => finish(null), PING_TIMEOUT);
        const req = http.get(targetOptions(target, { path: '/health', timeout: PING_TIMEOUT }), res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(body);
                    // Old worker endpoints answer /health too, but have no MCP
                    // transport. Never mistake one for a usable hub.
                    if (j.status === 'ok' && (j.mcp || j.endpoints || j.tools != null || !j.clientId)) finish({ ...target, clientId: j.clientId || null });
                    else finish(null);
                } catch { finish(null); }
            });
            res.on('error', () => finish(null));
            res.on('aborted', () => finish(null));
        });
        req.on('error', () => finish(null));
        req.on('timeout', () => finish(null));
    });
}

function discoveryTargets() {
    const ports = new Set(Array.from({ length: PORT_RANGE + 1 }, (_, i) => DEFAULT_PORT + i));
    // A pinned test/server stays isolated unless its caller supplies a private
    // registry explicitly. In production this also discovers workers >27202.
    if (!PINNED_PORT || process.env.WOLFBOOK_MCP_REGISTRY_FILE) {
        try {
            const file = process.env.WOLFBOOK_MCP_REGISTRY_FILE || path.join(require('os').homedir(), '.wolfbook-mcp-registry.json');
            for (const w of JSON.parse(fs.readFileSync(file, 'utf8'))) {
                if (Number.isInteger(w.workerPort) && w.workerPort > 0 && w.workerPort < 65536) ports.add(w.workerPort);
            }
        } catch {}
    }
    return [...ports].map(port => ({ port }));
}

async function findServer(exclude = null, waitMs = MAX_WAIT_MS) {
    const deadline = Date.now() + waitMs;
    let warned = false;
    while (Date.now() < deadline) {
        if (SOCKET_PATH) {
            if (socketDirSafe(SOCKET_PATH)) {
                const found = exclude?.socketPath === SOCKET_PATH ? null : await checkTarget({ socketPath: SOCKET_PATH });
                if (found) return found;
            } else if (!warned && fs.existsSync(path.dirname(SOCKET_PATH))) {
                warned = true;
                process.stderr.write(`[wolfbook-mcp-bridge] Ignoring ${SOCKET_PATH}: its directory is not private to this user.\n`);
            }
        }
        // A wedged listener can keep TCP open forever. Probe independently so
        // it cannot delay discovery of each healthy standby in turn.
        const found = await Promise.all(discoveryTargets()
            .filter(t => !exclude || describeTarget(t) !== describeTarget(exclude))
            .map(checkTarget));
        const target = found.find(Boolean);
        if (target) return target;
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return null;
}

// ── SSE client (persistent connection to HTTP server) ─────────────────────
function openSSE(target) {
    return new Promise((resolve, reject) => {
        const connection = { target, sessionPath: null, res: null, closed: false };
        const deadline = setTimeout(() => { req.destroy(); reject(new Error('MCP session handshake timed out')); }, 3000);
        const req = http.get(targetOptions(target, {
            path: SSE_PATH, headers: { Accept: 'text/event-stream' }
        }), res => {
            connection.res = res;
            let buf = '';
            let eventType = 'message', dataLine = null;

            // Collect SSE events
            res.on('data', chunk => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const ln of lines) {
                    if (ln.startsWith('event:')) eventType = ln.slice(6).trim();
                    else if (ln.startsWith('data:')) dataLine = ln.slice(5).trim();
                    else if (ln === '') {
                        if (eventType === 'endpoint' && dataLine) {
                            connection.sessionPath = dataLine;
                            clearTimeout(deadline);
                            resolve(connection);
                        } else if (eventType === 'message' && dataLine) {
                            onSSEMessage(dataLine, connection);
                        }
                        eventType = 'message'; dataLine = null;
                    }
                }
            });
            const closed = () => { connection.closed = true; clearTimeout(deadline); reject(new Error('MCP event stream closed')); };
            res.on('error', closed);
            res.on('end', closed);
            res.on('aborted', closed);
        });
        req.on('error', e => { connection.closed = true; clearTimeout(deadline); reject(e); });
    });
}

// ── Pending requests waiting for SSE reply ────────────────────────────────
const pending = new Map();  // id → { resolve, timeout? }

function onSSEMessage(data, connection) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id != null && pending.get(msg.id)?.connection === connection) {
        const { resolve, timeout, ackTimer } = pending.get(msg.id);
        if (timeout) clearTimeout(timeout);
        if (ackTimer) clearTimeout(ackTimer);
        pending.delete(msg.id);
        resolve(msg);
    } else if (connection === currentConnection && msg.id == null && typeof msg.method === 'string') {
        // Server-initiated notifications (notifications/tools/list_changed …) were
        // dropped here, so a stdio client never learned its tool list changed.
        writeStdout(msg);
    }
}

// ── Forward JSON-RPC to HTTP server, get reply via SSE ────────────────────
function forwardRequest(connection, rpcMsg, waitMs = 330000) {
    const { sessionPath, target } = connection;
    return new Promise((resolve, reject) => {
        // Notifications (no id) — fire and forget
        if (rpcMsg.id == null) {
            const body = JSON.stringify(rpcMsg);
            const deadline = setTimeout(() => req.destroy(), 3000);
            const req = http.request(targetOptions(target, {
                method: 'POST', path: sessionPath,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }), res => { clearTimeout(deadline); res.resume(); });
            req.setTimeout(3000, () => req.destroy());
            req.on('error', () => clearTimeout(deadline));
            req.write(body);
            req.end();
            resolve(null);
            return;
        }

        // Requests — wait for SSE reply
        const entry = { resolve, connection, req: null, timeout: null, ackTimer: null };
        pending.set(rpcMsg.id, entry);
        const body = JSON.stringify(rpcMsg);
        const req = http.request(targetOptions(target, {
            method: 'POST', path: sessionPath,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }), res => {
            clearTimeout(entry.ackTimer);
            res.resume();
            if (res.statusCode !== 202) {
                if (res.statusCode === 404) connection.closed = true;
                req.destroy(new Error(`MCP message was rejected (HTTP ${res.statusCode})`));
            }
        });
        entry.req = req;
        // Absolute deadline also covers a SYN stuck in a full listen backlog.
        entry.ackTimer = setTimeout(() => req.destroy(new Error('MCP hub did not acknowledge the request; it may still be running. Not replayed.')), 3000);
        req.on('error', err => {
            clearTimeout(entry.ackTimer);
            if (pending.get(rpcMsg.id) === entry) {
                if (entry.timeout) clearTimeout(entry.timeout);
                pending.delete(rpcMsg.id);
                reject(err);
            }
        });
        req.write(body);
        req.end();

        // The server returns a resumable operation response at five minutes.
        // Keep a transport margin so that response wins this backstop.
        const timeout = setTimeout(() => {
            if (pending.get(rpcMsg.id) === entry) {
                clearTimeout(entry.ackTimer);
                pending.delete(rpcMsg.id);
                resolve({ jsonrpc: '2.0', id: rpcMsg.id, error: { code: -32603, message: 'Timeout' } });
            }
        }, waitMs);
        entry.timeout = timeout;
    });
}

// ── stdio JSON-RPC reading ────────────────────────────────────────────────
function readStdin(onMessage) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        buf += chunk;
        // Each message is delimited by newlines in stdio MCP
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try { onMessage(JSON.parse(trimmed)); } catch { /* ignore malformed */ }
        }
    });
    process.stdin.on('end', () => process.exit(0));
}

function writeStdout(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

let currentConnection = null;
let recovering = null;
let initializeParams = null;
let initialHostClientId = null;
let savedTarget = null;
let targetRestoreError = null;
const exposureChanges = [];
let internalId = 0;
const internalRpc = (method, params) => ({ jsonrpc: '2.0', id: `bridge-${process.pid}-${++internalId}`, method, params });

function concreteCall(params) {
    let call = params;
    while (call?.name === 'wolfbook_tools' && call.arguments?.action === 'call') call = call.arguments;
    return call;
}

function rememberSession(rpc, reply) {
    if (reply?.error || reply?.result?.isError) return;
    if (rpc.method === 'initialize') {
        initializeParams = rpc.params;
        initialHostClientId ||= reply?.result?._meta?.['wolfbook/hostClientId'] || currentConnection.target.clientId || null;
    }
    if (rpc.method !== 'tools/call') return;
    const call = concreteCall(rpc.params);
    if (call?.name === 'wolfbook_setTarget') {
        const target = reply?.result?.structuredContent?.target;
        if (target) {
            savedTarget = { client_id: target.clientId, notebook: target.notebook, kernel_id: target.kernelId };
            targetRestoreError = null;
        } else if (!call.arguments?.client_id && !call.arguments?.notebook) {
            savedTarget = null; targetRestoreError = null;
        }
    }
    if (call?.name === 'wolfbook_tools' && ['enable', 'disable', 'reset'].includes(call.arguments?.action)) {
        // Only session configuration is replayable. Never tools that edit or
        // evaluate. Keep all changes until reset so exposure restores exactly.
        if (call.arguments.action === 'reset') exposureChanges.length = 0;
        exposureChanges.push(call);
    }
}

function failPending(connection) {
    for (const [id, p] of pending) {
        if (p.connection !== connection) continue;
        clearTimeout(p.timeout); clearTimeout(p.ackTimer);
        pending.delete(id);
        p.resolve({ jsonrpc: '2.0', id, error: { code: -32603,
            message: 'MCP hub became unresponsive. This request was not replayed and may still be running; check wolfbook_operationStatus or wolfbook_status before resubmitting.' } });
        p.req?.destroy();
    }
    // Keep the old SSE stream open. Destroying it would ask the old hub to
    // cancel synchronous evaluations on otherwise healthy worker kernels.
    // Its late replies are ignored using connection identity, even if IDs repeat.
}

function recover(connection) {
    if (recovering) return recovering;
    failPending(connection);
    const work = (async () => {
        const target = await findServer(connection?.closed ? null : connection?.target, 10000);
        if (!target) throw new Error('No responsive Wolfbook MCP hub or standby window is available.');
        const next = await openSSE(target);
        if (initializeParams) {
            const init = await forwardRequest(next, internalRpc('initialize', initializeParams), 5000);
            if (init?.error) throw new Error('Could not initialize the standby MCP session.');
            await forwardRequest(next, { jsonrpc: '2.0', method: 'notifications/initialized' });
        }
        // An untargeted session also has a default owner. Changing transports
        // must not redirect its next evaluation into an unrelated window.
        const restoreTarget = savedTarget || (initialHostClientId ? { client_id: initialHostClientId, notebook: null, kernel_id: null } : null);
        if (restoreTarget) {
            const reply = await forwardRequest(next, internalRpc('tools/call', { name: 'wolfbook_setTarget', arguments: restoreTarget }), 5000);
            const restored = reply?.result?.structuredContent?.target;
            if (!restored || restored.clientId !== restoreTarget.client_id ||
                (restored.notebook || null) !== (restoreTarget.notebook || null) ||
                (restored.kernelId || null) !== (restoreTarget.kernel_id || null)) {
                targetRestoreError = 'MCP reconnected, but the previous notebook/kernel target could not be restored. Call wolfbook_setTarget explicitly before continuing.';
            } else targetRestoreError = null;
        } else if (initializeParams) {
            targetRestoreError = 'MCP reconnected, but the original window is unknown. Call wolfbook_setTarget explicitly before continuing.';
        }
        for (const params of exposureChanges) {
            const reply = await forwardRequest(next, internalRpc('tools/call', params), 5000);
            if (reply?.error) throw new Error('Could not restore MCP tool exposure on the standby session.');
        }
        currentConnection = next;
        process.stderr.write(`[wolfbook-mcp-bridge] Reconnected through ${describeTarget(target)}. Interrupted tool calls were not replayed.\n`);
        writeStdout({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    })();
    recovering = work;
    work.finally(() => { if (recovering === work) recovering = null; }).catch(() => {});
    return work;
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
    process.stderr.write('[wolfbook-mcp-bridge] Waiting for VS Code extension server...\n');

    const target = await findServer();
    if (!target) {
        process.stderr.write('[wolfbook-mcp-bridge] Timed out — VS Code extension not started.\n');
        process.exit(1);
    }

    process.stderr.write(`[wolfbook-mcp-bridge] Found server on ${describeTarget(target)}, connecting ${PROFILE || "default"} profile...\n`);

    currentConnection = await openSSE(target);
    process.stderr.write(`[wolfbook-mcp-bridge] Ready. Session: ${currentConnection.sessionPath}\n`);

    let checking = false, failures = 0;
    setInterval(async () => {
        if (checking || recovering) return;
        checking = true;
        const connection = currentConnection;
        try {
            const ok = !connection.closed && await checkTarget(connection.target);
            if (ok) { failures = 0; return; }
            if (++failures < 2) return;
            await recover(connection);
            failures = 0;
        } catch (e) {
            process.stderr.write(`[wolfbook-mcp-bridge] ${e.message}\n`);
        } finally { checking = false; }
    }, 2000).unref();

    readStdin(async rpcMsg => {
        try {
            if (recovering) await recovering;
            if (currentConnection.closed) await recover(currentConnection);
            if (targetRestoreError && rpcMsg.method === 'tools/call' &&
                !['wolfbook_setTarget', 'wolfbook_list_clients', 'wolfbook_status', 'wolfbook_operationStatus', 'wolfbook_waitEvaluation', 'wolfbook_tools'].includes(concreteCall(rpcMsg.params)?.name)) {
                throw new Error(targetRestoreError);
            }
            const reply = await forwardRequest(currentConnection, rpcMsg);
            rememberSession(rpcMsg, reply);
            if (reply) writeStdout(reply);
        } catch (e) {
            if (rpcMsg.id != null) {
                writeStdout({ jsonrpc: '2.0', id: rpcMsg.id, error: { code: -32603, message: e.message } });
            }
        }
    });
})();
