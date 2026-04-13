'use strict';
// ---------------------------------------------------------------------------
// Wolfbook MCP Server — HTTP/SSE transport
// Exposes Wolfram notebook tools to Claude Desktop via MCP protocol.
//
// The server runs inside the VS Code extension process so it has full access
// to all vscode.* APIs used by the tool implementations.
//
// Configuration in Claude Desktop (~/.../Claude/claude_desktop_config.json):
//   { "mcpServers": { "wolfbook": { "url": "http://127.0.0.1:27182/sse" } } }
//
// Run wolfbook.configureClaude command to write this automatically.
// ---------------------------------------------------------------------------

const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const DEFAULT_PORT  = 27182;
const PORT_RANGE    = 20;  // try DEFAULT_PORT … DEFAULT_PORT+PORT_RANGE if busy

class WolframMCPServer {
    /**
     * @param {Map<string, object>} toolMap   name → tool class instance
     * @param {object[]}            mcpSchemas  MCP-formatted {name,description,inputSchema}
     */
    constructor(toolMap, mcpSchemas) {
        this._tools   = toolMap;
        this._schemas = mcpSchemas;
        this._sessions = new Map();   // sessionId → http.ServerResponse (SSE)
        this._server  = null;
        this._port    = 0;
    }

    /** Start listening. Returns the actual port used. */
    start(port = DEFAULT_PORT) {
        return new Promise((resolve, reject) => {
            const srv = http.createServer((req, res) => {
                try { this._handle(req, res); }
                catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(); } }
            });
            this._server = srv;
            srv.listen(port, '127.0.0.1', () => {
                this._port = srv.address().port;
                console.log(`[Wolfbook MCP] Listening on http://127.0.0.1:${this._port}/sse`);
                resolve(this._port);
            });
            srv.on('error', err => {
                if (err.code === 'EADDRINUSE' && port < DEFAULT_PORT + PORT_RANGE) {
                    srv.close();
                    this._server = null;
                    this.start(port + 1).then(resolve, reject);
                } else {
                    reject(err);
                }
            });
        });
    }

    get port() { return this._port; }

    stop() {
        return new Promise(resolve => {
            if (this._server) this._server.close(() => resolve());
            else resolve();
        });
    }

    // ── HTTP handler ────────────────────────────────────────────────────────
    _handle(req, res) {
        // CORS — Claude Desktop may send preflight requests
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const url = new URL(req.url, `http://127.0.0.1:${this._port}`);

        if (req.method === 'GET' && url.pathname === '/sse') {
            this._handleSSE(req, res);
        } else if (req.method === 'POST' && url.pathname === '/message') {
            this._handleMessage(req, res, url);
        } else if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', tools: this._schemas.length, port: this._port }));
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    }

    // ── SSE connection — one per Claude session ────────────────────────────
    _handleSSE(req, res) {
        const sessionId = crypto.randomUUID();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
        });
        res.flushHeaders?.();
        this._sessions.set(sessionId, res);
        // MCP SSE transport: first event tells the client where to POST messages
        res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
        req.on('close', () => this._sessions.delete(sessionId));
    }

    // ── Message POST — JSON-RPC dispatch ──────────────────────────────────
    _handleMessage(req, res, url) {
        const sessionId = url.searchParams.get('sessionId');
        const sse       = this._sessions.get(sessionId);

        let body = '';
        req.setEncoding('utf8');
        req.on('data',  chunk => { body += chunk; });
        req.on('end',   async () => {
            // MCP spec: respond 202 immediately, reply arrives via SSE
            res.writeHead(202);
            res.end();

            let msg;
            try { msg = JSON.parse(body); } catch { return; }

            // Notifications (no id) — no response expected
            if (msg.id == null) return;

            let result, error;
            try {
                result = await this._dispatch(msg.method, msg.params || {});
            } catch (e) {
                const code = (typeof e.code === 'number') ? e.code : -32603;
                error = { code, message: String(e.message || e) };
            }

            const response = error
                ? { jsonrpc: '2.0', id: msg.id, error }
                : { jsonrpc: '2.0', id: msg.id, result };
            this._sendSSE(sse, response);
        });
    }

    _sendSSE(sse, data) {
        if (!sse || sse.destroyed) return;
        sse.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // ── MCP method dispatch ────────────────────────────────────────────────
    async _dispatch(method, params) {
        switch (method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities:    { tools: {} },
                    serverInfo:      { name: 'wolfbook', version: '1.0.0' },
                };

            case 'ping':
                return {};

            case 'tools/list':
                return { tools: this._schemas };

            case 'tools/call': {
                const { name, arguments: args } = params;
                const tool = this._tools.get(name);
                if (!tool) {
                    const err = new Error(`Unknown tool: ${name}`);
                    err.code = -32602;
                    throw err;
                }

                const options = { input: args || {} };
                // Mock VS Code CancellationToken — MCP calls are not cancellable mid-flight
                const token = {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose: () => {} }),
                };

                let toolResult;
                try {
                    toolResult = await tool.invoke(options, token);
                } catch (e) {
                    // Tool threw — return as MCP error content (isError:true)
                    return {
                        content:  [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
                        isError:  true,
                    };
                }

                // Extract text from LanguageModelToolResult (content items have .value)
                const text = (toolResult?.content || [])
                    .map(p => p.value ?? p.text ?? '')
                    .join('');

                return {
                    content: [{ type: 'text', text }],
                    isError: false,
                };
            }

            default: {
                const err = new Error(`Method not supported: ${method}`);
                err.code  = -32601;
                throw err;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers used by extension.js to build the schema list from package.json
// ---------------------------------------------------------------------------

/** Load MCP-formatted tool schemas from the extension's package.json.
 *  Converts { name, modelDescription, inputSchema } → MCP { name, description, inputSchema }
 */
function loadMCPSchemas(packageJsonPath) {
    try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const lmTools = pkg?.contributes?.languageModelTools ?? [];
        return lmTools.map(t => ({
            name:        t.name,
            description: t.modelDescription || t.displayName || t.name,
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
        }));
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not load package.json schemas:', e.message);
        return [];
    }
}

/** Update Claude Desktop claude_desktop_config.json with the wolfbook MCP server URL.
 *  Returns { updated: bool, configPath: string }.
 */
function configureClaudeDesktop(port) {
    const configPath = path.join(
        process.env.HOME || process.env.USERPROFILE || '~',
        'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'
    );
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* first time */ }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.wolfbook = { url: `http://127.0.0.1:${port}/sse` };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { updated: true, configPath, port };
}

module.exports = { WolframMCPServer, loadMCPSchemas, configureClaudeDesktop };
