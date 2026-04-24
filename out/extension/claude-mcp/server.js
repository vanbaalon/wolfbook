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
const { setMcpCallActive } = require('../tools/shared');

const DEFAULT_PORT  = 27182;
const PORT_RANGE    = 20;  // try DEFAULT_PORT … DEFAULT_PORT+PORT_RANGE if busy

/**
 * Probe whether a Wolfbook MCP server is already running on the given port.
 * Returns the port number if alive, or 0 if not.
 */
function probeExistingServer(port = DEFAULT_PORT) {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 500 }, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.status === 'ok') { resolve(port); return; }
                } catch (_) {}
                resolve(0);
            });
        });
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
    });
}

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
        this._secondary = false;  // true = another window owns the server; we just reuse its port
        // Multi-window routing
        this._workers      = new Map();  // clientId → { port, pid, notebooks }
        this._ownClientId  = null;       // set by extension.js after election/start
        this._ownNotebooks = [];         // updated by extension.js on notebook open/close
        // Session targets: one target per MCP session (SSE connection)
        // Map: sessionId → { clientId, notebook } | null
        // 'copilot' is a synthetic sessionId used when Copilot auto-sets a target
        this._sessionTargets = new Map();  // sessionId → { clientId, notebook }
    }

    /** Start listening. Returns the actual port used.
     *  If a Wolfbook MCP server is already running on DEFAULT_PORT, this window
     *  becomes a secondary — it reuses the existing port and skips starting a new server.
     */
    start(port = DEFAULT_PORT) {
        // First window probe: is the default port already alive?
        return probeExistingServer(DEFAULT_PORT).then(existingPort => {
            if (existingPort) {
                this._port = existingPort;
                this._secondary = true;
                console.log(`[Wolfbook MCP] Secondary window — reusing existing server on port ${existingPort}`);
                return existingPort;
            }
            return this._startListening(port);
        });
    }

    /** Internal: actually bind to a port. */
    _startListening(port = DEFAULT_PORT) {
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
                    this._startListening(port + 1).then(resolve, reject);
                } else {
                    reject(err);
                }
            });
        });
    }

    get port() { return this._port; }
    get isSecondary() { return this._secondary; }

    // ── Multi-window identity & routing ─────────────────────────────────────

    /** Called from extension.js once the client ID and initial notebook list are known. */
    setOwnClientInfo(clientId, notebooks) {
        this._ownClientId  = clientId;
        this._ownNotebooks = notebooks || [];
    }

    /** Called from extension.js when open notebooks change. */
    updateOwnNotebooks(notebooks) {
        this._ownNotebooks = notebooks || [];
    }

    /**
     * Start directly on PRIMARY_PORT without probing first.
     * Used when a worker wins an election and needs to claim port 27182 immediately.
     */
    startAsPrimary(primaryPort) {
        this._secondary = false;
        return this._startListening(primaryPort || 27182);
    }

    /**
     * After an election win: read the shared registry file, notify every live worker
     * of the new primary so they re-register.  Call this after startAsPrimary() resolves.
     */
    async notifyWorkers() {
        const http = require('http');
        const { listAlive } = require('./registry');
        const workers = listAlive();
        for (const w of workers) {
            if (!w.workerPort || w.clientId === this._ownClientId) continue;
            await new Promise(resolve => {
                const req = http.request({
                    hostname: '127.0.0.1', port: w.workerPort,
                    path: '/new-primary', method: 'POST',
                    headers: { 'Content-Length': 0 }, timeout: 1500,
                }, res => { res.resume(); resolve(); });
                req.on('error', () => resolve());
                req.on('timeout', () => { req.destroy(); resolve(); });
                req.end();
            });
        }
    }

    stop() {
        if (this._secondary) return Promise.resolve(); // not our server to close
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
        } else if (req.method === 'POST' && url.pathname === '/register') {
            this._handleRegister(req, res);
        } else if (req.method === 'GET' && url.pathname === '/workers') {
            const list = this._buildClientList();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(list));
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    }

    // ── Worker registration ────────────────────────────────────────────────
    _handleRegister(req, res) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', d => { body += d; });
        req.on('end', () => {
            try {
                const info = JSON.parse(body);
                if (info.clientId) {
                    this._workers.set(info.clientId, {
                        port:      info.port,
                        pid:       info.pid,
                        notebooks: info.notebooks || [],
                    });
                }
            } catch {}
            res.writeHead(200); res.end();
        });
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
        req.on('close', () => {
            this._sessions.delete(sessionId);
            this._sessionTargets.delete(sessionId);  // release any target claim
        });
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
                result = await this._dispatch(msg.method, msg.params || {}, sessionId);
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
    async _dispatch(method, params, sessionId = 'mcp') {
        switch (method) {
            case 'initialize':
                return {
                    protocolVersion: '2024-11-05',
                    capabilities:    { tools: {} },
                    serverInfo:      { name: 'wolfbook', version: '1.0.0' },
                };

            case 'ping':
                return {};

            case 'tools/list': {
                // Inject optional client_id param into every tool so the agent can
                // target a specific window without calling wolfbook_list_clients first.
                const CLIENT_ID_PARAM = {
                    type: 'string',
                    description:
                        'Target client ID, e.g. "VSCode[ClasterVersion]" or ' +
                        '"Antigravity[ClasterVersion]". Omit to auto-route by notebook ' +
                        'path. Use wolfbook_list_clients to see available clients.',
                };
                const injectClientId = (schema) => {
                    if (!schema || schema.type !== 'object') return schema;
                    return { ...schema, properties: { ...schema.properties, client_id: CLIENT_ID_PARAM } };
                };
                const tools = this._schemas.map(t => ({
                    ...t, inputSchema: injectClientId(t.inputSchema),
                }));
                // Synthetic tools — not in _tools map, handled in tools/call
                tools.push({
                    name: 'wolfbook_list_clients',
                    description:
                        'List all connected Wolfbook clients (VS Code / Antigravity windows). ' +
                        'Returns each client ID, its role (primary/worker), open notebooks, ' +
                        'and workspace name. Use this to pick the right client_id before ' +
                        'targeting a specific window.',
                    inputSchema: { type: 'object', properties: {}, required: [] },
                });
                tools.push({
                    name: 'wolfbook_setTarget',
                    description:
                        'Set (or clear) the session target: the default client and notebook that ' +
                        'all subsequent tool calls are routed to automatically. Once set, you do ' +
                        'not need to pass client_id or notebook on every call — they are injected ' +
                        'automatically. The active [Target] is shown at the bottom of each response. ' +
                        'Omit both client_id and notebook to clear the target.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            client_id: { type: 'string', description: 'Client to target (from wolfbook_list_clients). Omit to target own window.' },
                            notebook:  { type: 'string', description: 'Notebook filename to switch to and target (e.g. "proto2.wb"). Omit to leave notebook selection unchanged.' },
                        },
                        required: [],
                    },
                });
                return { tools };
            }

            case 'tools/call': {
                const { name, arguments: rawArgs } = params;

                // ── Synthetic: wolfbook_list_clients ────────────────────────
                if (name === 'wolfbook_list_clients') {
                    return { content: [{ type: 'text', text: this._buildClientListText() }], isError: false };
                }

                // ── Synthetic: wolfbook_setTarget ────────────────────────────
                if (name === 'wolfbook_setTarget') {
                    return this._handleSetTarget(rawArgs || {}, sessionId);
                }

                // ── Extract & strip client_id routing hint ───────────────────
                const args = rawArgs ? { ...rawArgs } : {};
                const targetClientId = args.client_id || null;
                delete args.client_id;

                // ── Route to a specific worker (explicit client_id) ──────────
                if (targetClientId && targetClientId !== this._ownClientId) {
                    const worker = this._workers.get(targetClientId);
                    if (!worker) {
                        const err = new Error(
                            `Unknown client: "${targetClientId}". ` +
                            `Use wolfbook_list_clients to see available clients.`);
                        err.code = -32602;
                        throw err;
                    }
                    return this._invokeWorker(worker.port, name, args);
                }

                // ── Auto-route by notebook name in args ──────────────────────
                if (!targetClientId) {
                    const workerEntry = this._findWorkerByNotebook(args);
                    if (workerEntry) return this._invokeWorker(workerEntry.port, name, args);
                }

                // ── Route via session target ─────────────────────────────────
                const sessionTarget = this._sessionTargets.get(sessionId) || null;
                if (!targetClientId && sessionTarget) {
                    const { clientId: stClientId, notebook: stNotebook } = sessionTarget;
                    // Inject the session notebook into args when the tool hasn't specified one
                    if (stNotebook && !args.notebook) args.notebook = stNotebook;
                    if (stClientId && stClientId !== this._ownClientId) {
                        const worker = this._workers.get(stClientId);
                        if (worker) {
                            const result = await this._invokeWorker(worker.port, name, args);
                            return this._appendTargetFooter(result, sessionTarget);
                        }
                    }
                }

                // ── No target set in a multi-window session ────────────────────
                // When other windows are connected, require an explicit target so we
                // never silently run in the wrong window.
                if (!targetClientId && !sessionTarget && this._workers.size > 0) {
                    return {
                        content: [{ type: 'text', text:
                            'No session target set.\n\n' +
                            'Use `wolfbook_setTarget` to pick a client and notebook before running tools, ' +
                            'or use `wolfbook_list_clients` to see available clients.\n\n' +
                            'Example: wolfbook_setTarget(client_id: "VSCode[BaxterSolver]", notebook: "proto2.wb")'
                        }],
                        isError: false,
                    };
                }

                // ── Run locally (primary window, single-window mode) ──────────
                const tool = this._tools.get(name);
                if (!tool) {
                    const err = new Error(`Unknown tool: ${name}`);
                    err.code = -32602;
                    throw err;
                }

                const options = { input: args, skipConfirm: true };  // MCP calls can't respond to dialogs
                // Mock VS Code CancellationToken — MCP calls are not cancellable mid-flight
                const token = {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose: () => {} }),
                };

                let toolResult;
                setMcpCallActive(true);
                try {
                    toolResult = await tool.invoke(options, token);
                } catch (e) {
                    // Tool threw — return as MCP error content (isError:true)
                    return {
                        content:  [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
                        isError:  true,
                    };
                } finally {
                    setMcpCallActive(false);
                }

                // Extract text from LanguageModelToolResult (content items have .value)
                const text = (toolResult?.content || [])
                    .map(p => p.value ?? p.text ?? '')
                    .join('');

                return this._appendTargetFooter({
                    content: [{ type: 'text', text }],
                    isError: false,
                }, this._sessionTargets.get(sessionId) || null);
            }

            default: {
                const err = new Error(`Method not supported: ${method}`);
                err.code  = -32601;
                throw err;
            }
        }
    }

    // ── Session target helpers ─────────────────────────────────────────

    /** Handle wolfbook_setTarget: validate, check conflicts, then persist per-session target. */
    _handleSetTarget(args, sessionId = 'mcp') {
        const targetCid = (args.client_id || '').trim() || null;
        const targetNb  = (args.notebook  || '').trim() || null;

        // Omit both → clear this session's target
        if (!targetCid && !targetNb) {
            this._sessionTargets.delete(sessionId);
            return { content: [{ type: 'text', text: 'Session target cleared.' }], isError: false };
        }

        // Validate client if specified
        if (targetCid && targetCid !== this._ownClientId && !this._workers.has(targetCid)) {
            const known = [this._ownClientId, ...this._workers.keys()].filter(Boolean).join(', ');
            return {
                content: [{ type: 'text', text: `Unknown client: "${targetCid}". Known: ${known || '(none)'}. Use wolfbook_list_clients.` }],
                isError: false,
            };
        }

        // Conflict check: is this notebook already claimed by another session?
        if (targetNb) {
            for (const [sid, t] of this._sessionTargets) {
                if (sid === sessionId) continue;  // same session updating its own target
                const sameClient = !targetCid || !t.clientId || t.clientId === targetCid;
                if (sameClient && t.notebook && t.notebook.toLowerCase() === targetNb.toLowerCase()) {
                    const who = sid === 'copilot' ? 'Copilot (in-editor agent)' : `another MCP session (${sid.slice(0, 8)}…)`;
                    return {
                        content: [{ type: 'text', text:
                            `Cannot claim "${targetNb}" — it is already targeted by ${who}.\n` +
                            `Use wolfbook_list_clients to see current targets. ` +
                            `If that session is dead, it will be released automatically when it disconnects.`
                        }],
                        isError: false,
                    };
                }
            }
        }

        this._sessionTargets.set(sessionId, { clientId: targetCid, notebook: targetNb });

        const parts = [];
        if (targetNb)  parts.push(`notebook: **${targetNb}**`);
        if (targetCid) parts.push(`client: **${targetCid}**`);
        return {
            content: [{ type: 'text', text: `Session target set — ${parts.join(', ')}. All subsequent tool calls will auto-route there.` }],
            isError: false,
        };
    }

    /** Append a compact [Target: ...] footer when a session target is active. */
    _appendTargetFooter(result, target) {
        if (!target) return result;
        const { clientId, notebook } = target;
        const label = [notebook, clientId].filter(Boolean).join(' @ ');
        const footer = `\n\n└ *Target: ${label}*`;
        if (result?.content?.[0]?.type === 'text') {
            return {
                ...result,
                content: [{ type: 'text', text: (result.content[0].text || '') + footer }, ...result.content.slice(1)],
            };
        }
        return result;
    }

    // ── Worker routing helpers ────────────────────────────────────────────────

    /** Proxy a tool call to another window's WorkerServer. */
    _invokeWorker(workerPort, name, args) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ name, arguments: args });
            const req  = http.request({
                hostname: '127.0.0.1',
                port:     workerPort,
                path:     '/invoke',
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 120000,   // tools can take a while (kernel execution)
            }, res => {
                let data = '';
                res.on('data', d => { data += d; });
                res.on('end', () => {
                    try {
                        const r = JSON.parse(data);
                        resolve({
                            content: [{ type: 'text', text: r.isError ? `Error: ${r.error}` : (r.text || '') }],
                            isError: !!r.isError,
                        });
                    } catch (e) {
                        reject(new Error(`Worker response parse error: ${e.message}`));
                    }
                });
            });
            req.on('error',   e => reject(e));
            req.on('timeout', () => { req.destroy(); reject(new Error('Worker tool call timed out')); });
            req.write(body);
            req.end();
        });
    }

    /** Scan tool args for any value that looks like a notebook path and find the
     *  worker that has it open.  Returns the worker info object or null. */
    _findWorkerByNotebook(args) {
        if (!args || typeof args !== 'object') return null;
        const NB_EXTS = ['.wb', '.evsnb', '.vsnb'];
        // Notebooks are stored as full paths in the registry.  The agent may
        // pass just a basename (e.g. "proto2.wb") or a full path — match both.
        const _base = p => (p || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
        for (const val of Object.values(args)) {
            if (typeof val !== 'string') continue;
            if (!NB_EXTS.some(ext => val.toLowerCase().endsWith(ext))) continue;
            const targetBase = _base(val);
            for (const info of this._workers.values()) {
                if ((info.notebooks || []).some(nb => nb === val || _base(nb) === targetBase)) {
                    return info;
                }
            }
        }
        return null;
    }

    /** Build structured client list (used by /workers endpoint and wolfbook_list_clients). */
    _buildClientList() {
        const list = [];
        if (this._ownClientId) {
            list.push({
                clientId:  this._ownClientId,
                role:      'primary',
                notebooks: this._ownNotebooks,
                pid:       process.pid,
            });
        }
        for (const [clientId, info] of this._workers) {
            list.push({
                clientId,
                role:      'worker',
                notebooks: info.notebooks || [],
                pid:       info.pid,
            });
        }
        return list;
    }

    /** Format the client list as human-readable text for wolfbook_list_clients. */
    _buildClientListText() {
        const list = this._buildClientList();
        if (list.length === 0) return 'No clients registered yet.';
        const _base = p => (p || '').replace(/\\/g, '/').split('/').pop();

        // Build a map of notebook basename → session label for targeted notebooks
        const claimed = new Map();  // notebook basename (lower) → display label
        for (const [sid, t] of this._sessionTargets) {
            if (!t?.notebook) continue;
            const nb  = t.notebook.toLowerCase();
            const who = sid === 'copilot' ? 'Copilot' : `session ${sid.slice(0, 6)}…`;
            claimed.set(nb, who);
        }

        const lines = list.map(c => {
            const nbList = c.notebooks.length === 0
                ? '  (no open notebooks)'
                : c.notebooks.map(n => {
                    const base = _base(n);
                    const tag  = claimed.get(base.toLowerCase());
                    return tag ? `  • ${base}  ⟵ *in use by ${tag}*` : `  • ${base}`;
                }).join('\n');
            return `${c.clientId}  [${c.role}]\n${nbList}`;
        });

        // Show all active session targets
        if (this._sessionTargets.size > 0) {
            const targetLines = [];
            for (const [sid, t] of this._sessionTargets) {
                const who   = sid === 'copilot' ? 'Copilot' : `session ${sid.slice(0, 6)}…`;
                const label = [t.notebook, t.clientId].filter(Boolean).join(' @ ');
                targetLines.push(`  ${who} → ${label}`);
            }
            lines.push(`\n**Active targets:**\n${targetLines.join('\n')}`);
        } else {
            lines.push('\n*No session targets set. Use wolfbook_setTarget to pick a default client/notebook.*');
        }
        return lines.join('\n\n');
    }
}

// ---------------------------------------------------------------------------
// Helpers used by extension.js to build the schema list from package.json
// ---------------------------------------------------------------------------

/** Recursively strip oneOf/allOf/anyOf from a JSON Schema object.
 *  Claude's API rejects these (at the top level of input_schema, and Anthropic
 *  also rejects them inside property definitions).
 *  We preserve all property descriptions so the model understands the parameters.
 */
function sanitizeInputSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
    // eslint-disable-next-line no-unused-vars
    const { oneOf, allOf, anyOf, ...rest } = schema;
    if (rest.properties) {
        const sanitizedProps = {};
        for (const [k, v] of Object.entries(rest.properties)) {
            sanitizedProps[k] = sanitizeInputSchema(v);
        }
        rest.properties = sanitizedProps;
    }
    if (rest.items) rest.items = sanitizeInputSchema(rest.items);
    return rest;
}

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
            inputSchema: sanitizeInputSchema(t.inputSchema || { type: 'object', properties: {} }),
        }));
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not load package.json schemas:', e.message);
        return [];
    }
}

/** Resolve the Node.js binary to use when spawning the stdio bridge.
 *  Cannot use process.execPath inside Electron (it's the VS Code binary).
 */
function resolveNodeBinary() {
    // process.versions.electron is set by Electron regardless of platform/binary name
    if (!process.versions.electron) {
        return process.execPath;  // already a plain node process
    }
    // Inside Electron: look for a 'node' sibling next to the Electron binary
    const dir = path.dirname(process.execPath);
    const candidates = [
        path.join(dir, 'node'),
        path.join(dir, 'node.exe'),
    ];
    for (const c of candidates) {
        try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
    }
    // Try to resolve 'node' via PATH using a synchronous shell call
    try {
        const { execSync } = require('child_process');
        const resolved = execSync('which node || where node', { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0].trim();
        if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
    return 'node';  // rely on PATH as last resort
}

/** Update Claude Desktop and Claude Code config with the wolfbook MCP server.
 *  Uses stdio transport (spawned process) to avoid startup timing race.
 *  The bridge already tolerates the HTTP server not yet being up (polls 60s),
 *  so this can be called synchronously at extension activate time — before the
 *  MCP server even starts.
 *  Returns { updated: bool, configPaths: string[], nodeBin: string, bridgePath: string }.
 */
function configureClaudeDesktop(port, extensionPath) {
    const home = process.env.HOME || process.env.USERPROFILE || '~';
    const bridgePath = extensionPath
        ? path.join(extensionPath, 'out', 'extension', 'claude-mcp', 'stdio-bridge.js')
        : path.join(__dirname, 'stdio-bridge.js');
    const nodeBin = resolveNodeBinary();
    return writeClaudeConfig(bridgePath, nodeBin, home, port);
}

/** Write wolfbook MCP entry to Claude Desktop config, ~/.claude.json (Claude Code),
 *  and ~/.codex/config.toml (Codex CLI).
 *  Exported separately so it can be called before the HTTP server has started.
 *  @param {string[]} [workspacePaths] - Workspace folder paths to register in ~/.claude.json.
 *    Pass all vscode.workspace.workspaceFolders paths. If empty, skips ~/.claude.json project entries.
 */
function writeClaudeConfig(bridgePath, nodeBin, home, port, workspacePaths) {
    home = home || process.env.HOME || process.env.USERPROFILE || '~';
    const mcpEntry = { command: nodeBin, args: [bridgePath] };
    const results = [];

    // 1. Claude Desktop — flat mcpServers at root
    const desktopConfigPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    try {
        let config = {};
        try { if (fs.existsSync(desktopConfigPath)) config = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf8')); } catch {}
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers.wolfbook = mcpEntry;
        fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true });
        fs.writeFileSync(desktopConfigPath, JSON.stringify(config, null, 2), 'utf8');
        results.push(desktopConfigPath);
    } catch (e) {
        console.warn(`[Wolfbook MCP] Could not write to ${desktopConfigPath}:`, e.message);
    }

    // 2. Claude Code CLI — ~/.claude.json, projects[workspacePath].mcpServers
    if (workspacePaths && workspacePaths.length > 0) {
        const claudeJsonPath = path.join(home, '.claude.json');
        try {
            let root = {};
            try { if (fs.existsSync(claudeJsonPath)) root = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch {}
            if (!root.projects) root.projects = {};
            for (const wsPath of workspacePaths) {
                if (!root.projects[wsPath]) root.projects[wsPath] = {};
                if (!root.projects[wsPath].mcpServers) root.projects[wsPath].mcpServers = {};
                root.projects[wsPath].mcpServers.wolfbook = { type: 'stdio', command: nodeBin, args: [bridgePath], env: {} };
            }
            fs.writeFileSync(claudeJsonPath, JSON.stringify(root, null, 2), 'utf8');
            results.push(claudeJsonPath);
        } catch (e) {
            console.warn(`[Wolfbook MCP] Could not write to ${claudeJsonPath}:`, e.message);
        }
    }

    // 3. Codex CLI — ~/.codex/config.toml, [mcp_servers.wolfbook]
    // Uses a minimal TOML patch: only touches the [mcp_servers.wolfbook] section.
    const codexConfigPath = path.join(home, '.codex', 'config.toml');
    try {
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        let toml = '';
        try { if (fs.existsSync(codexConfigPath)) toml = fs.readFileSync(codexConfigPath, 'utf8'); } catch {}

        // Build the new mcp_servers.wolfbook block
        const argsToml = '[' + [bridgePath].map(a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ') + ']';
        const newBlock = `\n[mcp_servers.wolfbook]\ncommand = "${nodeBin.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nargs = ${argsToml}\n`;

        // Remove any existing [mcp_servers.wolfbook] section (up to next section header or EOF)
        toml = toml.replace(/(\n|^)\[mcp_servers\.wolfbook\][\s\S]*?(?=\n\[|\s*$)/g, '');
        toml = toml.trimEnd() + newBlock;

        fs.writeFileSync(codexConfigPath, toml, 'utf8');
        results.push(codexConfigPath);
    } catch (e) {
        console.warn(`[Wolfbook MCP] Could not write to ${codexConfigPath}:`, e.message);
    }

    return { updated: true, configPaths: results, port, bridgePath, nodeBin };
}

/** Check if all configs already have the correct wolfbook entry.
 *  Returns true when a write is needed.
 */
function needsConfigUpdate(bridgePath, nodeBin, workspacePaths) {
    const home = process.env.HOME || process.env.USERPROFILE || '~';

    // Check Claude Desktop config
    try {
        const cfg = JSON.parse(fs.readFileSync(
            path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'utf8'));
        const entry = cfg?.mcpServers?.wolfbook;
        if (!entry || entry.command !== nodeBin || entry.args?.[0] !== bridgePath) return true;
    } catch { return true; }

    // Check ~/.claude.json for each workspace path
    if (workspacePaths && workspacePaths.length > 0) {
        try {
            const root = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
            for (const wsPath of workspacePaths) {
                const entry = root?.projects?.[wsPath]?.mcpServers?.wolfbook;
                if (!entry || entry.command !== nodeBin || entry.args?.[0] !== bridgePath) return true;
            }
        } catch { return true; }
    }

    // Check Codex config.toml
    try {
        const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
        // Simple check: both strings must appear in the wolfbook section
        if (!toml.includes(`command = "${nodeBin}"`)) return true;
        if (!toml.includes(`"${bridgePath}"`)) return true;
    } catch { return true; }

    return false;
}

// ---------------------------------------------------------------------------
// Antigravity MCP config — ~/.gemini/antigravity/mcp_config.json
// Same { mcpServers: { wolfbook: { command, args } } } format as Claude Desktop.
// ---------------------------------------------------------------------------

/** Write the wolfbook entry into Antigravity's MCP config file.
 *  Returns { updated: bool, configPath: string }.
 */
function writeAntigravityConfig(bridgePath, nodeBin) {
    const home = process.env.HOME || process.env.USERPROFILE || '~';
    const configPath = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
    try {
        let config = {};
        try { if (fs.existsSync(configPath)) { const raw = fs.readFileSync(configPath, 'utf8'); if (raw.trim()) config = JSON.parse(raw); } } catch {}
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers.wolfbook = { command: nodeBin, args: [bridgePath] };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        return { updated: true, configPath };
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not write Antigravity config:', e.message);
        return { updated: false, configPath };
    }
}

/** Returns true if the Antigravity config needs updating. */
function needsAntigravityConfigUpdate(bridgePath, nodeBin) {
    const home = process.env.HOME || process.env.USERPROFILE || '~';
    const configPath = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        if (!raw.trim()) return true;
        const cfg = JSON.parse(raw);
        const entry = cfg?.mcpServers?.wolfbook;
        return !entry || entry.command !== nodeBin || entry.args?.[0] !== bridgePath;
    } catch { return true; }
}

// ---------------------------------------------------------------------------
// Antigravity Skill — ~/.gemini/antigravity/skills/wolfbook/SKILL.md
// Installs the wolfbook skill so Gemini's agent router loads Wolfbook context
// automatically when the user works with Wolfram Language notebooks.
// ---------------------------------------------------------------------------

const _SKILL_SRC = path.join(__dirname, 'wolfbook-skill', 'SKILL.md');

/** Install (or update) the Wolfbook skill into Antigravity's global skills folder.
 *  Returns { updated: bool, skillPath: string }.
 */
function installAntigravitySkill() {
    const home = process.env.HOME || process.env.USERPROFILE || '~';
    const skillDir  = path.join(home, '.gemini', 'antigravity', 'skills', 'wolfbook');
    const skillDest = path.join(skillDir, 'SKILL.md');
    try {
        const src = fs.readFileSync(_SKILL_SRC, 'utf8');
        // Skip write if content is identical (avoid touching mtime unnecessarily)
        try { if (fs.readFileSync(skillDest, 'utf8') === src) return { updated: false, skillPath: skillDest }; } catch {}
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillDest, src, 'utf8');
        return { updated: true, skillPath: skillDest };
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not install Antigravity skill:', e.message);
        return { updated: false, skillPath: skillDest };
    }
}

/** Returns true if the skill needs installing or updating. */
function needsSkillInstall() {
    const home = process.env.HOME || process.env.USERPROFILE || '~';
    const skillDest = path.join(home, '.gemini', 'antigravity', 'skills', 'wolfbook', 'SKILL.md');
    try {
        const src  = fs.readFileSync(_SKILL_SRC, 'utf8');
        const dest = fs.readFileSync(skillDest, 'utf8');
        return src !== dest;
    } catch { return true; }
}

// ---------------------------------------------------------------------------
// Cline (saoudrizwan.claude-dev) MCP config
// Path: ~/Library/Application Support/Code/User/globalStorage/
//         saoudrizwan.claude-dev/settings/cline_mcp_settings.json  (macOS/Linux)
//       %APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json  (Windows)
// Format: { mcpServers: { wolfbook: { command, args, disabled, autoApprove } } }
// ---------------------------------------------------------------------------

/** Resolve the Cline MCP settings file path for the current platform. */
function _clineConfigPath() {
    const isWin = process.platform === 'win32';
    const base  = isWin
        ? (process.env.APPDATA || path.join(process.env.USERPROFILE || '~', 'AppData', 'Roaming'))
        : (process.env.HOME || '~');
    return isWin
        ? path.join(base, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
        : path.join(base, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
}

/** Write the wolfbook MCP entry into Cline's settings file.
 *  Only writes if Cline is installed (settings directory exists or the file already exists).
 *  Returns { updated: bool, configPath: string, skipped: bool }.
 */
function writeClineConfig(bridgePath, nodeBin) {
    const configPath = _clineConfigPath();
    // Only write if the Cline extension storage directory exists — don't create it for non-users
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
        return { updated: false, configPath, skipped: true };
    }
    try {
        let config = { mcpServers: {} };
        try {
            if (fs.existsSync(configPath)) {
                const raw = fs.readFileSync(configPath, 'utf8');
                if (raw.trim()) config = JSON.parse(raw);
            }
        } catch {}
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers.wolfbook = {
            command:     nodeBin,
            args:        [bridgePath],
            disabled:    false,
            autoApprove: [],
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        return { updated: true, configPath, skipped: false };
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not write Cline config:', e.message);
        return { updated: false, configPath, skipped: false };
    }
}

/** Returns true if the Cline config needs writing (entry missing or stale). */
function needsClineConfigUpdate(bridgePath, nodeBin) {
    const configPath = _clineConfigPath();
    // If the directory doesn't exist Cline isn't installed — nothing to update
    if (!fs.existsSync(path.dirname(configPath))) return false;
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        if (!raw.trim()) return true;
        const cfg   = JSON.parse(raw);
        const entry = cfg?.mcpServers?.wolfbook;
        return !entry || entry.command !== nodeBin || entry.args?.[0] !== bridgePath;
    } catch { return true; }
}

// ---------------------------------------------------------------------------
// MCP info payload — used by the watchPanel sidebar info popup
// ---------------------------------------------------------------------------

/**
 * Build a serialisable info object describing the current MCP configuration.
 * Checks which config files exist and contain the wolfbook entry so the
 * sidebar can show live per-agent status without extra round-trips.
 *
 * @param {string}  bridgePath   Absolute path to stdio-bridge.js
 * @param {string}  nodeBin      Node.js executable path
 * @param {number}  port         Resolved HTTP port (0 = disabled/unknown)
 * @param {boolean} isSecondary  True when this VS Code window is a secondary MCP client
 * @param {boolean} isDisabled   True when the user has turned MCP off
 * @returns {{port, bridgePath, nodeBin, isSecondary, isDisabled, configPaths, configured}}
 */
function getMcpInfoPayload(bridgePath, nodeBin, port, isSecondary, isDisabled) {
    const home    = process.env.HOME || process.env.USERPROFILE || '~';
    const isWin   = process.platform === 'win32';
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

    const configPaths = {
        claudeDesktop: isWin
            ? path.join(appData, 'Claude', 'claude_desktop_config.json')
            : path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        claudeCode:  path.join(home, '.claude.json'),
        cline: isWin
            ? path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
            : path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
        antigravity: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
        codex:       path.join(home, '.codex', 'config.toml'),
    };

    const configured = {};
    try { configured.claudeDesktop = !!(JSON.parse(fs.readFileSync(configPaths.claudeDesktop, 'utf8'))?.mcpServers?.wolfbook); } catch { configured.claudeDesktop = false; }
    try { configured.claudeCode    = !!(JSON.parse(fs.readFileSync(configPaths.claudeCode, 'utf8'))?.mcpServers?.wolfbook); }    catch { configured.claudeCode  = false; }
    try { configured.cline         = !!(JSON.parse(fs.readFileSync(configPaths.cline, 'utf8'))?.mcpServers?.wolfbook); }         catch { configured.cline        = false; }
    try { configured.antigravity   = !!(JSON.parse(fs.readFileSync(configPaths.antigravity, 'utf8'))?.wolfbook); }               catch { configured.antigravity  = false; }
    try { configured.codex         = fs.readFileSync(configPaths.codex, 'utf8').includes('[mcp_servers.wolfbook]'); }            catch { configured.codex        = false; }

    return { port: port || 0, bridgePath, nodeBin, isSecondary: !!isSecondary, isDisabled: !!isDisabled, configPaths, configured };
}

module.exports = { WolframMCPServer, loadMCPSchemas, configureClaudeDesktop, writeClaudeConfig, needsConfigUpdate, resolveNodeBinary, probeExistingServer, writeAntigravityConfig, needsAntigravityConfigUpdate, installAntigravitySkill, needsSkillInstall, writeClineConfig, needsClineConfigUpdate, getMcpInfoPayload };
