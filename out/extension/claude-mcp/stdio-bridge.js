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
const PING_TIMEOUT  = 3000;   // ms per health-check attempt
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
        const req = http.get(targetOptions(target, { path: '/health', timeout: PING_TIMEOUT }), res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(body);
                    if (j.status === 'ok') resolve(target);
                    else resolve(null);
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function findServer() {
    const deadline = Date.now() + MAX_WAIT_MS;
    let warned = false;
    while (Date.now() < deadline) {
        if (SOCKET_PATH) {
            if (socketDirSafe(SOCKET_PATH)) {
                const found = await checkTarget({ socketPath: SOCKET_PATH });
                if (found) return found;
            } else if (!warned && fs.existsSync(path.dirname(SOCKET_PATH))) {
                warned = true;
                process.stderr.write(`[wolfbook-mcp-bridge] Ignoring ${SOCKET_PATH}: its directory is not private to this user.\n`);
            }
        }
        for (let p = DEFAULT_PORT; p <= DEFAULT_PORT + PORT_RANGE; p++) {
            const found = await checkTarget({ port: p });
            if (found) return found;
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return null;
}

// ── SSE client (persistent connection to HTTP server) ─────────────────────
function openSSE(target) {
    return new Promise((resolve, reject) => {
        const req = http.get(targetOptions(target, {
            path: SSE_PATH, headers: { Accept: 'text/event-stream' }
        }), res => {
            let sessionPath = null;
            let buf = '';

            // Collect SSE events
            res.on('data', chunk => {
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop();
                let eventType = 'message', dataLine = null;
                for (const ln of lines) {
                    if (ln.startsWith('event:')) eventType = ln.slice(6).trim();
                    else if (ln.startsWith('data:')) dataLine = ln.slice(5).trim();
                    else if (ln === '') {
                        if (eventType === 'endpoint' && dataLine) {
                            sessionPath = dataLine;
                            resolve({ res, sessionPath, target });
                        } else if (eventType === 'message' && dataLine) {
                            onSSEMessage(dataLine);
                        }
                        eventType = 'message'; dataLine = null;
                    }
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

// ── Pending requests waiting for SSE reply ────────────────────────────────
const pending = new Map();  // id → { resolve, timeout? }

function onSSEMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
        const { resolve, timeout } = pending.get(msg.id);
        if (timeout) clearTimeout(timeout);
        pending.delete(msg.id);
        resolve(msg);
    } else if (msg.id == null && typeof msg.method === 'string') {
        // Server-initiated notifications (notifications/tools/list_changed …) were
        // dropped here, so a stdio client never learned its tool list changed.
        writeStdout(msg);
    }
}

// ── Forward JSON-RPC to HTTP server, get reply via SSE ────────────────────
function forwardRequest(sessionPath, target, rpcMsg) {
    return new Promise((resolve, reject) => {
        // Notifications (no id) — fire and forget
        if (rpcMsg.id == null) {
            const body = JSON.stringify(rpcMsg);
            const req = http.request(targetOptions(target, {
                method: 'POST', path: sessionPath,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }), res => { res.resume(); });
            req.on('error', () => {});
            req.write(body);
            req.end();
            resolve(null);
            return;
        }

        // Requests — wait for SSE reply
        pending.set(rpcMsg.id, { resolve });
        const body = JSON.stringify(rpcMsg);
        const req = http.request(targetOptions(target, {
            method: 'POST', path: sessionPath,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }), res => { res.resume(); });
        req.on('error', err => {
            const entry = pending.get(rpcMsg.id);
            if (entry?.timeout) clearTimeout(entry.timeout);
            pending.delete(rpcMsg.id);
            reject(err);
        });
        req.write(body);
        req.end();

        // The server returns a resumable operation response at five minutes.
        // Keep a transport margin so that response wins this backstop.
        const timeout = setTimeout(() => {
            if (pending.has(rpcMsg.id)) {
                pending.delete(rpcMsg.id);
                resolve({ jsonrpc: '2.0', id: rpcMsg.id, error: { code: -32603, message: 'Timeout' } });
            }
        }, 330000);
        const entry = pending.get(rpcMsg.id);
        if (entry) entry.timeout = timeout;
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

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
    process.stderr.write('[wolfbook-mcp-bridge] Waiting for VS Code extension server...\n');

    const target = await findServer();
    if (!target) {
        process.stderr.write('[wolfbook-mcp-bridge] Timed out — VS Code extension not started.\n');
        process.exit(1);
    }

    process.stderr.write(`[wolfbook-mcp-bridge] Found server on ${describeTarget(target)}, connecting ${PROFILE || "default"} profile...\n`);

    const { sessionPath } = await openSSE(target);
    process.stderr.write(`[wolfbook-mcp-bridge] Ready. Session: ${sessionPath}\n`);

    readStdin(async rpcMsg => {
        try {
            const reply = await forwardRequest(sessionPath, target, rpcMsg);
            if (reply) writeStdout(reply);
        } catch (e) {
            if (rpcMsg.id != null) {
                writeStdout({ jsonrpc: '2.0', id: rpcMsg.id, error: { code: -32603, message: e.message } });
            }
        }
    });
})();
