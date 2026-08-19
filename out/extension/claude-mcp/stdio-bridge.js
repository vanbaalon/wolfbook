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

const DEFAULT_PORT  = 27182;
const PORT_RANGE    = 20;
const POLL_INTERVAL = 1000;   // ms between health-check retries
const MAX_WAIT_MS   = 60000;  // give VS Code up to 60s to start
const PING_TIMEOUT  = 3000;   // ms per health-check attempt

// ── Find the HTTP server ───────────────────────────────────────────────────
function checkPort(port) {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: PING_TIMEOUT }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(body);
                    if (j.status === 'ok') resolve(port);
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
    while (Date.now() < deadline) {
        for (let p = DEFAULT_PORT; p <= DEFAULT_PORT + PORT_RANGE; p++) {
            const found = await checkPort(p);
            if (found) return found;
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return null;
}

// ── SSE client (persistent connection to HTTP server) ─────────────────────
function openSSE(port) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/sse`, {
            headers: { Accept: 'text/event-stream' }
        }, res => {
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
                            resolve({ res, sessionPath, port });
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
    }
}

// ── Forward JSON-RPC to HTTP server, get reply via SSE ────────────────────
function forwardRequest(sessionPath, port, rpcMsg) {
    return new Promise((resolve, reject) => {
        // Notifications (no id) — fire and forget
        if (rpcMsg.id == null) {
            const body = JSON.stringify(rpcMsg);
            const req = http.request({
                hostname: '127.0.0.1', port, method: 'POST',
                path: sessionPath,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, res => { res.resume(); });
            req.on('error', () => {});
            req.write(body);
            req.end();
            resolve(null);
            return;
        }

        // Requests — wait for SSE reply
        pending.set(rpcMsg.id, { resolve });
        const body = JSON.stringify(rpcMsg);
        const req = http.request({
            hostname: '127.0.0.1', port, method: 'POST',
            path: sessionPath,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, res => { res.resume(); });
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

    const port = await findServer();
    if (!port) {
        process.stderr.write('[wolfbook-mcp-bridge] Timed out — VS Code extension not started.\n');
        process.exit(1);
    }

    process.stderr.write(`[wolfbook-mcp-bridge] Found server on port ${port}, connecting SSE...\n`);

    const { sessionPath } = await openSSE(port);
    process.stderr.write(`[wolfbook-mcp-bridge] Ready. Session: ${sessionPath}\n`);

    readStdin(async rpcMsg => {
        try {
            const reply = await forwardRequest(sessionPath, port, rpcMsg);
            if (reply) writeStdout(reply);
        } catch (e) {
            if (rpcMsg.id != null) {
                writeStdout({ jsonrpc: '2.0', id: rpcMsg.id, error: { code: -32603, message: e.message } });
            }
        }
    });
})();
