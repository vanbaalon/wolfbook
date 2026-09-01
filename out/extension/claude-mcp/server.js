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

// Resolve the per-user application-data directory for the current platform.
//
// Callers previously inlined `isWin ? %APPDATA% : ~/Library/Application Support`,
// which silently sent Linux down the macOS branch: it created a stray
// ~/Library tree in $HOME and wrote MCP registrations to a path no Linux
// client reads. Linux follows the XDG Base Directory Specification, where
// config lives in $XDG_CONFIG_HOME (default ~/.config). Claude Desktop, an
// Electron app, honours that variable, so ignoring it here would desync the
// two. Windows keeps its own branch at each call site.
function appSupportDir(base) {
    if (process.platform === 'darwin') return path.join(base, 'Library', 'Application Support');
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    return (xdgConfigHome && path.isAbsolute(xdgConfigHome))
        ? xdgConfigHome
        : path.join(base, '.config');
}

const { McpResultStore } = require('./result-store');
const { runWithActivityContext } = require('../monitor/activity');

const DEFAULT_PORT  = 27182;
const PORT_RANGE    = 20;  // try DEFAULT_PORT … DEFAULT_PORT+PORT_RANGE if busy
const OPERATION_WAIT_MS  = 300000;  // return control to the model every 5 minutes
const OPERATION_LEASE_MS = 600000;  // forget transport waiter if the model is silent

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
    constructor(toolMap, mcpSchemas, operationOptions = {}) {
        this._tools   = toolMap;
        this._schemas = mcpSchemas;
        this._sessions = new Map();   // sessionId → http.ServerResponse (SSE)
        this._sessionConnectedAt = new Map();
        this._server  = null;
        this._port    = 0;
        this._secondary = false;  // true = another window owns the server; we just reuse its port
        // Multi-window routing
        this._workers      = new Map();  // clientId → { port, pid, notebooks }
        this._ownClientId  = null;       // set by extension.js after election/start
        this._ownWorkspace = null;
        this._ownNotebooks = [];         // updated by extension.js on notebook open/close
        this._ownRegistrationGeneration = `${Date.now()}-${crypto.randomUUID()}`;
        this._getOwnKernels = null;
        // Session targets: one target per MCP session (SSE connection)
        // Map: sessionId → { clientId, notebook } | null
        // 'copilot' is a synthetic sessionId used when Copilot auto-sets a target
        this._sessionTargets = new Map();  // sessionId → { clientId, notebook, ts }
        // Session-target durability: targets die with their SSE connection, so a
        // reconnecting client (same clientInfo.name) adopts its last target
        // instead of erroring on every call (marked 'adopted-target' in the footer).
        this._sessionClientNames = new Map();  // sessionId → clientInfo.name
        this._lastTargetByClient = new Map();  // clientInfo.name → { target, ts }
        this._operations = new Map(); // operationId → managed long-running call
        this._operationWaitMs = operationOptions.waitMs || OPERATION_WAIT_MS;
        this._operationLeaseMs = operationOptions.leaseMs || OPERATION_LEASE_MS;
        this._canonicalProjection = !!operationOptions.canonicalProjection;
        this._renderCache = !!operationOptions.renderCache;
        this._boundedResults = !!operationOptions.boundedResults;
        this._resultThreshold = Math.max(4096, Number(operationOptions.resultThreshold) || 24000);
        this._resultStore = new McpResultStore(operationOptions.resultStoreOptions);
        this._activity = operationOptions.activityMonitor || null;
        // Tool surface exposure (Phase 0.2): tags on package.json languageModelTools
        // entries drive tools/list visibility. `mcp:hidden` → never listed;
        // `mcp:deprecated` → listed only when exposeDeprecatedTools, with a
        // DEPRECATED prefix (mcp:replacedBy:<name> names the successor);
        // profile 'notebook' drops wolfslide_*, non-'full' drops fairy/gold/wolfteam
        // unless tagged mcp:core. Hidden ≠ removed: tools/call resolves from
        // this._tools, so every name keeps working — the zero-breakage guarantee.
        this._exposeDeprecatedTools = !!operationOptions.exposeDeprecatedTools;
        this._profile = ['notebook', 'slides', 'full'].includes(operationOptions.profile)
            ? operationOptions.profile : 'full';
    }

    /** Phase 0.2: should this schema entry appear in tools/list? */
    _isToolVisible(t) {
        const tags = Array.isArray(t.tags) ? t.tags : [];
        if (tags.includes('mcp:hidden')) return false;
        if (tags.includes('mcp:deprecated') && !this._exposeDeprecatedTools) return false;
        if (this._profile !== 'full' && !tags.includes('mcp:core')) {
            // Wolfbook TeX. `paper_*` matches none of the prefixes below, so
            // without this clause it would pass every filter and show up even
            // in the slides profile — the opposite of hidden. The `paper`
            // profile is the mirror case: a paper session does not want the
            // notebook and slide families advertised at it.
            if (t.name.startsWith('paper_')) {
                return this._profile === 'paper' || this._profile === 'notebook';
            }
            if (this._profile === 'paper') return false;
            if (this._profile === 'notebook' && t.name.startsWith('wolfslide_')) return false;
            if (this._profile === 'slides' && t.name.startsWith('wolfbook_') &&
                !/^wolfbook_(evaluateExpression|kernel|list_clients|setTarget|operationStatus|waitEvaluation|getResult)/.test(t.name)) return false;
            if (/^(wolfbook_fairy_|wolfbook_gold_|wolfteam_)/.test(t.name)) return false;
        }
        return true;
    }

    /** Phase 0.2: description with deprecation prefix when tagged. */
    _describeTool(t) {
        const tags = Array.isArray(t.tags) ? t.tags : [];
        if (!tags.includes('mcp:deprecated')) return t.description;
        const replacedBy = tags.find(x => x.startsWith('mcp:replacedBy:'))?.slice('mcp:replacedBy:'.length);
        return `DEPRECATED${replacedBy ? ` — use \`${replacedBy}\` instead` : ''}. ${t.description}`;
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
                this._activity?.setPort(existingPort);
                this._activity?.setPrimary(false);
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
                this._activity?.setPort(this._port);
                this._activity?.setPrimary(true);
                this._activity?.record({ type: 'system.monitor.started', state: 'completed', payload: { port: this._port } });
                console.log(`[Wolfbook MCP] Listening on http://127.0.0.1:${this._port}/sse`);
                // A primary can restart quickly enough that workers never hit
                // their health-failure threshold. Re-discover the durable
                // registry on every primary start, not only after an election.
                setTimeout(() => this.notifyWorkers().catch(() => {}), 250);
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
    setOwnClientInfo(clientId, notebooks, workspace) {
        this._ownClientId  = clientId;
        this._ownNotebooks = notebooks || [];
        this._ownWorkspace = workspace || this._workspaceFromClientId(clientId);
        this._activity?.setClientInfo(clientId, this._ownWorkspace);
        this._activity?.setTopologyProvider(() => ({
            clients: this._buildClientList(),
            sessions: this._buildSessionList(),
        }));
    }

    /** Called from extension.js when open notebooks change. */
    updateOwnNotebooks(notebooks) {
        this._ownNotebooks = notebooks || [];
    }

    setKernelProvider(provider) { this._getOwnKernels = provider; }

    _workspaceFromClientId(clientId) {
        return (String(clientId || '').match(/\[([^\]]+)\]/) || [])[1] || null;
    }

    _workspaceForClient(clientId) {
        if (!clientId) return null;
        if (clientId === this._ownClientId) return this._ownWorkspace || this._workspaceFromClientId(clientId);
        return this._workers.get(clientId)?.workspace || this._workspaceFromClientId(clientId);
    }

    _hostActivityPayload(extra = {}) {
        return {
            hostClientId: this._ownClientId,
            hostWorkspace: this._workspaceForClient(this._ownClientId),
            ...extra,
        };
    }

    _recordSessionTarget(sessionId, target, reason) {
        const clientId = target?.clientId || null;
        const workspace = this._workspaceForClient(clientId);
        this._activity?.record({
            type: target ? 'agent.target.changed' : 'agent.target.cleared',
            source: 'mcp', agentSessionId: sessionId,
            agentName: this._sessionClientNames.get(sessionId) || null,
            clientId: clientId || this._ownClientId,
            workspace: workspace || this._workspaceForClient(this._ownClientId),
            notebook: target?.notebook || null,
            kernelId: target?.kernelId || null,
            state: 'observed',
            payload: this._hostActivityPayload({
                targetClientId: clientId,
                targetWorkspace: workspace,
                reason: reason || null,
            }),
        });
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
        for (const operationId of this._operations.keys()) this._forgetOperation(operationId);
        if (this._secondary) return Promise.resolve(); // not our server to close
        return new Promise(resolve => {
            if (this._server) this._server.close(() => resolve());
            else resolve();
        });
    }

    // ── HTTP handler ────────────────────────────────────────────────────────
    _handle(req, res) {
        const url = new URL(req.url, `http://127.0.0.1:${this._port}`);
        if (this._activity?.handles(url.pathname)) {
            this._activity.handle(req, res, url);
            return;
        }
        // CORS — Claude Desktop may send preflight requests
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
                if (info.clientId && info.clientId !== this._ownClientId) {
                    this._workers.set(info.clientId, {
                        port:      info.port,
                        pid:       info.pid,
                        notebooks: info.notebooks || [],
                        kernels:   info.kernels || [],
                        generation: info.generation || null,
                        registeredAt: Number(info.registeredAt || Date.now()),
                        workspace: info.workspace || this._workspaceFromClientId(info.clientId),
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
        this._sessionConnectedAt.set(sessionId, Date.now());
        this._activity?.record({ type: 'agent.connected', source: 'mcp', agentSessionId: sessionId,
            state: 'running', payload: this._hostActivityPayload({ transport: 'sse' }) });
        // MCP SSE transport: first event tells the client where to POST messages
        res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
        req.on('close', () => {
            this._activity?.record({ type: 'agent.disconnected', source: 'mcp', agentSessionId: sessionId,
                agentName: this._sessionClientNames.get(sessionId) || null, state: 'completed', payload: { transport: 'sse' } });
            this._sessions.delete(sessionId);
            this._sessionConnectedAt.delete(sessionId);
            this._sessionTargets.delete(sessionId);  // release any target claim
            this._sessionClientNames.delete(sessionId);
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
                const isManagedToolCall = msg.method === 'tools/call' &&
                    msg.params?.name !== 'wolfbook_waitEvaluation';
                result = isManagedToolCall
                    ? await this._runManagedToolCall(msg.params || {}, sessionId)
                    : await this._dispatch(msg.method, msg.params || {}, sessionId);
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
            case 'initialize': {
                const clientName = params?.clientInfo?.name;
                if (clientName) this._sessionClientNames.set(sessionId, String(clientName));
                this._activity?.record({ type: 'agent.initialized', source: 'mcp', agentSessionId: sessionId,
                    agentName: clientName || null, state: 'running', payload: this._hostActivityPayload({ clientInfo: params?.clientInfo || null, protocolVersion: params?.protocolVersion || null }) });
                return {
                    protocolVersion: '2024-11-05',
                    capabilities:    { tools: {} },
                    serverInfo:      { name: 'wolfbook', version: '1.0.0' },
                };
            }

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
                const KERNEL_ID_PARAM = {
                    type: 'string',
                    description: 'Opaque kernel ID from wolfbook_list_clients. For notebook tools this is an assertion; a changed binding is rejected.',
                };
                const injectClientId = (schema) => {
                    if (!schema || schema.type !== 'object') return schema;
                    return { ...schema, properties: { ...schema.properties, client_id: CLIENT_ID_PARAM, kernel_id: KERNEL_ID_PARAM } };
                };
                const tools = this._schemas
                    .filter(t => this._isToolVisible(t))
                    .map(({ tags, ...t }) => ({
                        ...t,
                        description: this._describeTool({ ...t, tags }),
                        inputSchema: injectClientId(t.inputSchema),
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
                        'Omit both client_id and notebook to clear the target. ' +
                        'Use force:true to evict a stale lock held by a dead session.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            client_id: { type: 'string', description: 'Client to target (from wolfbook_list_clients). Omit to target own window.' },
                            notebook:  { type: 'string', description: 'Notebook filename to switch to and target (e.g. "proto2.wb"). Omit to leave notebook selection unchanged.' },
                            kernel_id: { type: 'string', description: 'Optional kernel binding assertion from wolfbook_list_clients.' },
                            force:     { type: 'boolean', description: 'If true, evict any existing session lock on this notebook and claim it for this session. Use when wolfbook_list_clients shows a stale lock from a dead session.' },
                        },
                        required: [],
                    },
                });
                tools.push({
                    name: 'wolfbook_waitEvaluation',
                    description:
                        'Continue waiting for a Wolfbook operation that was still running after ' +
                        'the five-minute MCP response window. Pass the operation_id returned by ' +
                        'the earlier call. Waits for up to another five minutes and returns the ' +
                        'original result. To stop it, call wolfbook_kernelControl with action="abort".',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            operation_id: {
                                type: 'string',
                                description: 'Operation ID returned by a long-running Wolfbook call.',
                            },
                            client_id: CLIENT_ID_PARAM,
                            kernel_id: KERNEL_ID_PARAM,
                        },
                        required: ['operation_id'],
                    },
                });
                return { tools };
            }

            case 'tools/call': {
                const { name, arguments: rawArgs } = params;

                // ── Synthetic: wolfbook_list_clients ────────────────────────
                if (name === 'wolfbook_list_clients') {
                    return { content: [
                        { type: 'text', text: this._buildClientListText() },
                        { type: 'text', text: JSON.stringify({ clients: this._buildClientList() }, null, 2) }
                    ], isError: false };
                }

                // ── Synthetic: wolfbook_setTarget ────────────────────────────
                if (name === 'wolfbook_setTarget') {
                    return this._handleSetTarget(rawArgs || {}, sessionId);
                }
                if (name === 'wolfbook_waitEvaluation') {
                    return this._waitEvaluation(rawArgs || {}, sessionId);
                }
                if (name === 'wolfbook_operationStatus') {
                    return this._operationStatus(rawArgs || {}, sessionId);
                }
                // ── wolfbook_status: the primary owns the cross-window clients
                // table; kernel/operations/notebook scopes come from the routed
                // window's StatusTool.  _clientsHandled guards the recursion.
                if (name === 'wolfbook_status' && !rawArgs?._clientsHandled) {
                    const scope = rawArgs?.scope || 'all';
                    const clientsText = (scope === 'clients' || scope === 'all')
                        ? this._buildClientListText() : null;
                    if (scope === 'clients') {
                        return { content: [{ type: 'text', text: clientsText }], isError: false };
                    }
                    const inner = await this._dispatch('tools/call',
                        { name, arguments: { ...(rawArgs || {}), _clientsHandled: true } }, sessionId);
                    if (clientsText && Array.isArray(inner?.content)) {
                        return { ...inner, content: [{ type: 'text', text: `Clients:\n${clientsText}\n` }, ...inner.content] };
                    }
                    return inner;
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
                    if (args._activityContext) {
                        args._activityContext.clientId = targetClientId;
                        args._activityContext.workspace = this._workspaceForClient(targetClientId);
                        args._activityContext.notebook = args.notebook || args._activityContext.notebook || null;
                        args._activityContext.kernelId = args.kernel_id || args._activityContext.kernelId || null;
                    }
                    const result = await this._invokeWorker(worker.port, name, args);
                    const newTarget = this._maybeTargetNewNotebook(name, args, sessionId, targetClientId, result);
                    return this._appendTargetFooter(result,
                        newTarget || { clientId: targetClientId, notebook: args.notebook || null },
                        'explicit client_id');
                }

                // ── One routing law: explicit client_id > session target >
                // notebook auto-route > error.  The session target OUTRANKS the
                // notebook auto-route: a read of another notebook must never
                // silently move execution off the declared target.
                let sessionTarget = this._sessionTargets.get(sessionId) || null;
                if (!sessionTarget && !targetClientId) {
                    // Reconnected client (same clientInfo.name): adopt its last
                    // declared target (≤60 min old) instead of erroring.
                    const clientName = this._sessionClientNames.get(sessionId);
                    const last = clientName ? this._lastTargetByClient.get(clientName) : null;
                    if (last && Date.now() - last.ts < 3600000) {
                        sessionTarget = { ...last.target, _adopted: true };
                        this._sessionTargets.set(sessionId, sessionTarget);
                    }
                }
                if (!targetClientId && sessionTarget) {
                    const { clientId: stClientId, notebook: stNotebook, kernelId: stKernelId } = sessionTarget;
                    const currentKernel = this._resolveNotebookKernel(stClientId, stNotebook);
                    if (stKernelId && currentKernel?.kernel_id !== stKernelId) {
                        return { content: [{ type: 'text', text: JSON.stringify({
                            error: 'target-changed', client_id: stClientId, notebook: stNotebook,
                            previous_kernel_id: stKernelId, current_binding: currentKernel || { lifecycle: 'unbound' },
                            action: 'Call wolfbook_setTarget again to explicitly accept the new kernel.'
                        }, null, 2) }], isError: false };
                    }
                    // Inject the session notebook into args when the tool hasn't specified one.
                    // _notebookInjected lets tools distinguish routing convenience from an
                    // EXPLICIT notebook argument (the evaluation journal must not treat the
                    // injected value as a filter — it silently hid other notebooks' ops).
                    if (stNotebook && !args.notebook) { args.notebook = stNotebook; args._notebookInjected = true; }
                    if (stKernelId && !args.kernel_id) args.kernel_id = stKernelId;
                    if (stClientId && stClientId !== this._ownClientId) {
                        const worker = this._workers.get(stClientId);
                        if (worker) {
                            if (args._activityContext) {
                                args._activityContext.clientId = stClientId;
                                args._activityContext.workspace = this._workspaceForClient(stClientId);
                                args._activityContext.notebook = args.notebook || stNotebook || null;
                                args._activityContext.kernelId = args.kernel_id || stKernelId || null;
                            }
                            const result = await this._invokeWorker(worker.port, name, args);
                            const newTarget = this._maybeTargetNewNotebook(name, args, sessionId, stClientId, result);
                            return this._appendTargetFooter(result, newTarget || sessionTarget,
                                sessionTarget._adopted ? 'adopted-target' : 'session-target');
                        }
                    }
                }

                // ── Auto-route by notebook name in args (no target fixed) ─────
                if (!targetClientId && !sessionTarget) {
                    const workerEntry = this._findWorkerByNotebook(args);
                    if (workerEntry) {
                        if (args._activityContext) {
                            args._activityContext.clientId = workerEntry.clientId || null;
                            args._activityContext.workspace = this._workspaceForClient(workerEntry.clientId);
                            args._activityContext.notebook = args.notebook || args._activityContext.notebook || null;
                            args._activityContext.kernelId = args.kernel_id || args._activityContext.kernelId || null;
                        }
                        const result = await this._invokeWorker(workerEntry.port, name, args);
                        return this._appendTargetFooter(result, {
                            clientId: workerEntry.clientId || null,
                            notebook: args.notebook || null,
                        }, 'notebook auto-route');
                    }
                }

                // ── No target set in a multi-window session ────────────────────
                // When other windows are connected, require an explicit target so we
                // never silently run in the wrong window.
                this._pruneWorkers();
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
                    if (args._activityContext) {
                        args._activityContext.clientId = this._ownClientId;
                        args._activityContext.workspace = this._workspaceForClient(this._ownClientId);
                        args._activityContext.notebook = args.notebook || args._activityContext.notebook || null;
                        args._activityContext.kernelId = args.kernel_id || args._activityContext.kernelId || null;
                    }
                    toolResult = await runWithActivityContext(args._activityContext,
                        () => tool.invoke(options, token));
                } catch (e) {
                    // Tool threw — return as MCP error content (isError:true)
                    return {
                        content:  [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
                        isError:  true,
                    };
                } finally {
                    setMcpCallActive(false);
                }

                // Convert LanguageModelToolResult parts to MCP content blocks.
                // Text parts with a data:image/... value become MCP image content blocks
                // so Claude can actually see the image (e.g. from wolfbook_showImage).
                const mcpContent = [];
                for (const part of (toolResult?.content || [])) {
                    const val = part.value ?? part.text ?? '';
                    if (typeof val === 'string' && val.startsWith('data:image/') && val.includes(';base64,')) {
                        const comma = val.indexOf(',');
                        const mimeType = val.slice('data:'.length, val.indexOf(';base64,'));
                        const data = val.slice(comma + 1);
                        mcpContent.push({ type: 'image', data, mimeType });
                    } else if (val) {
                        mcpContent.push({ type: 'text', text: String(val) });
                    }
                }
                if (mcpContent.length === 0) mcpContent.push({ type: 'text', text: '' });

                const result = {
                    content: mcpContent,
                    isError: false,
                };
                const newTarget = this._maybeTargetNewNotebook(name, args, sessionId, targetClientId || this._ownClientId, result);
                const localTarget = newTarget || this._sessionTargets.get(sessionId) || null;
                return this._appendTargetFooter(result,
                    localTarget || { clientId: this._ownClientId, notebook: args.notebook || null },
                    localTarget ? undefined : 'local window');
            }

            default: {
                const err = new Error(`Method not supported: ${method}`);
                err.code  = -32601;
                throw err;
            }
        }
    }

    // ── Long-running operation management ──────────────────────────────

    async _runManagedToolCall(params, sessionId) {
        const directHandle = String(params?.arguments?.handle || params?.arguments?.operation_id || '');
        if (params?.name === 'wolfbook_getResult' && directHandle.startsWith('result_')) {
            const slice = this._resultStore.get(directHandle, params.arguments?.offset, params.arguments?.limit,
                params.arguments?.format, params.arguments?.path);
            return { content: [{ type: 'text', text: slice ? JSON.stringify(slice, null, 2) : 'Unknown or expired result handle.' }], isError: !slice || !!slice.error };
        }
        const operationId = crypto.randomUUID();
        const agentName = this._sessionClientNames.get(sessionId) || null;
        const declaredTarget = params?.arguments?.client_id
            ? { clientId: params.arguments.client_id }
            : (this._sessionTargets.get(sessionId) || null);
        const initialClientId = declaredTarget?.clientId || null;
        const activityContext = {
            traceId: operationId, operationId, agentSessionId: sessionId,
            agentName, source: 'mcp', notebook: params?.arguments?.notebook || declaredTarget?.notebook || null,
            kernelId: params?.arguments?.kernel_id || declaredTarget?.kernelId || null,
            clientId: initialClientId,
            workspace: this._workspaceForClient(initialClientId),
        };
        // Use one UUID at both transport and execution layers. This means the
        // handle returned at the five-minute boundary remains discoverable in
        // the per-window registry even after this transport waiter is gone.
        const dispatchedParams = {
            ...params,
            arguments: {
                ...(params?.arguments || {}), _operationId: operationId,
                _activityContext: activityContext,
                ...(this._canonicalProjection && params?.name === 'wolfbook_getNotebookContext'
                    ? { _mcpProjection: true, _mcpCache: this._renderCache } : {}),
            },
        };
        const operation = {
            id: operationId,
            name: params?.name || 'unknown tool',
            sessionId,
            params: dispatchedParams,
            status: 'pending',
            result: null,
            error: null,
            leaseTimer: null,
            startedAt: Date.now(),
            kernelId: dispatchedParams.arguments?.kernel_id || this._sessionTargets.get(sessionId)?.kernelId || null,
        };

        const isBackground = dispatchedParams.arguments?.wait_mode === 'async';
        this._activity?.record({ type: 'tool.started', source: 'mcp', traceId: operationId,
            operationId, agentSessionId: sessionId, agentName, notebook: activityContext.notebook,
            kernelId: activityContext.kernelId, clientId: activityContext.clientId || this._ownClientId,
            workspace: activityContext.workspace || this._workspaceForClient(this._ownClientId),
            state: isBackground ? 'running-background' : 'running', background: isBackground,
            payload: this._hostActivityPayload({ tool: operation.name, input: params?.arguments || {}, targetResolved: !!activityContext.clientId }) });

        operation.promise = this._dispatch('tools/call', dispatchedParams, sessionId).then(
            result => {
                operation.status = 'fulfilled'; operation.result = result;
                const isError = !!result?.isError;
                const terminalType = isError ? 'tool.failed' : (isBackground ? 'tool.accepted' : 'tool.completed');
                const terminalState = isError ? 'failed' : (isBackground ? 'running-background' : 'completed');
                this._activity?.record({ type: terminalType, source: 'mcp',
                    traceId: operationId, operationId, agentSessionId: sessionId, agentName,
                    notebook: activityContext.notebook, kernelId: operation.kernelId || activityContext.kernelId,
                    clientId: activityContext.clientId || this._ownClientId,
                    workspace: activityContext.workspace || this._workspaceForClient(this._ownClientId),
                    state: terminalState, background: isBackground,
                    payload: this._hostActivityPayload({ tool: operation.name, durationMs: Date.now() - operation.startedAt, output: result, targetResolved: !!activityContext.clientId }) });
                return result;
            },
            error => {
                operation.status = 'rejected'; operation.error = error;
                this._activity?.record({ type: 'tool.failed', source: 'mcp', traceId: operationId,
                    operationId, agentSessionId: sessionId, agentName, notebook: activityContext.notebook,
                    kernelId: operation.kernelId || activityContext.kernelId, state: 'failed', background: isBackground,
                    clientId: activityContext.clientId || this._ownClientId,
                    workspace: activityContext.workspace || this._workspaceForClient(this._ownClientId),
                    payload: this._hostActivityPayload({ tool: operation.name, durationMs: Date.now() - operation.startedAt, error: error?.message || String(error), targetResolved: !!activityContext.clientId }) });
                throw error;
            }
        );
        // This promise may outlive the JSON-RPC request that created it.
        operation.promise.catch(() => {});
        this._operations.set(operationId, operation);

        const settled = await this._waitForOperation(operation, this._operationWaitMs);
        if (settled) {
            this._forgetOperation(operationId);
            if (operation.status === 'rejected') throw operation.error;
            return this._boundResult(operation.result, params?.name, operation.kernelId);
        }

        this._renewOperationLease(operation);
        return this._operationStillRunningResult(operation);
    }

    _boundResult(result, toolName, kernelId = null) {
        if (!this._boundedResults || toolName === 'wolfbook_getResult' || !result?.content) return result;
        let changed = false;
        const content = result.content.map(part => {
            if (part?.type !== 'text' || String(part.text || '').length <= this._resultThreshold) return part;
            changed = true;
            const envelope = this._resultStore.envelope(
                String(part.text), Math.min(4000, this._resultThreshold), 'text', { kernel_id: kernelId }
            );
            return { type: 'text', text: JSON.stringify(envelope, null, 2) };
        });
        return changed ? { ...result, content } : result;
    }

    async _waitEvaluation(args, sessionId) {
        const operationId = String(args.operation_id || '').trim();
        const targetClientId = String(args.client_id || '').trim();
        // Never drop an explicitly supplied kernel_id — an error demanding a
        // parameter must not come from a path that strips that parameter.
        const kernelId = String(args.kernel_id || '').trim() || undefined;
        const operation = this._operations.get(operationId);
        if (!operation) {
            this._pruneWorkers();
            // Execution-layer IDs outlive the original tools/call and SSE
            // session. Their UUID is the capability; collect them from the
            // per-window registry rather than treating them as transport IDs.
            const target = targetClientId || this._sessionTargets.get(sessionId)?.clientId;
            if (target && target !== this._ownClientId) {
                const worker = this._workers.get(target);
                if (worker) return this._invokeWorker(worker.port, 'wolfbook_operationStatus', {
                    operation_id: operationId, include_progress: true, wait_seconds: 300, kernel_id: kernelId
                });
            }
            if (operationId) {
                // A reconnected session may have lost its target. Probe the
                // primary and every registered worker by UUID, then wait only
                // on the window that actually owns the execution operation.
                const localProbe = await this._invokeLocalOperationStatus(operationId, 0, true, kernelId);
                if (!this._isUnknownOperationResult(localProbe)) {
                    return this._invokeLocalOperationStatus(operationId, 300, true, kernelId);
                }
                for (const worker of this._workers.values()) {
                    let probe;
                    try {
                        probe = await this._invokeWorker(worker.port, 'wolfbook_operationStatus', {
                            operation_id: operationId, include_progress: false, wait_seconds: 0, kernel_id: kernelId
                        });
                    } catch (_) { continue; }
                    if (!this._isUnknownOperationResult(probe)) {
                        return this._invokeWorker(worker.port, 'wolfbook_operationStatus', {
                            operation_id: operationId, include_progress: true, wait_seconds: 300, kernel_id: kernelId
                        });
                    }
                }
            }
            return {
                content: [{ type: 'text', text:
                    `Unknown or expired operation_id: ${operationId || '(missing)'}. ` +
                    'It may already have been collected or expired.' }],
                isError: true,
            };
        }

        this._renewOperationLease(operation);
        const settled = await this._waitForOperation(operation, this._operationWaitMs);
        if (!settled) {
            this._renewOperationLease(operation);
            return this._operationStillRunningResult(operation);
        }

        this._forgetOperation(operationId);
        if (operation.status === 'rejected') throw operation.error;
        return this._boundResult(operation.result, operation.name, operation.kernelId);
    }

    /** Resolve a durable execution UUID without requiring the new SSE session
     *  to reconstruct its old notebook target first. */
    async _operationStatus(args, sessionId) {
        const operationId = String(args.operation_id || '').trim();
        const targetClientId = String(args.client_id || '').trim();
        const includeProgress = args.include_progress !== false;
        const waitSeconds = Math.max(0, Math.min(300, Number(args.wait_seconds) || 0));
        // Forward kernel_id — the schema advertises it, so dropping it here made
        // the demanded fix impossible by construction.
        const kernelId = String(args.kernel_id || '').trim() || undefined;
        if (!operationId) {
            return { content: [{ type: 'text', text: 'Missing operation_id.' }], isError: true };
        }
        this._pruneWorkers();

        const target = targetClientId || this._sessionTargets.get(sessionId)?.clientId;
        if (target && target !== this._ownClientId) {
            const worker = this._workers.get(target);
            if (!worker) return { content: [{ type: 'text', text: `Unknown client: "${target}".` }], isError: true };
            return this._invokeWorker(worker.port, 'wolfbook_operationStatus', {
                operation_id: operationId, include_progress: includeProgress, wait_seconds: waitSeconds, kernel_id: kernelId
            });
        }

        const probeErrors = [];
        const localProbe = await this._invokeLocalOperationStatus(operationId, 0, false, kernelId);
        if (localProbe._probeError) probeErrors.push(`local: ${localProbe._probeError}`);
        if (!this._isUnknownOperationResult(localProbe)) {
            return this._invokeLocalOperationStatus(operationId, waitSeconds, includeProgress, kernelId);
        }
        for (const [workerClientId, worker] of this._workers.entries()) {
            let probe;
            try {
                probe = await this._invokeWorker(worker.port, 'wolfbook_operationStatus', {
                    operation_id: operationId, include_progress: false, wait_seconds: 0, kernel_id: kernelId
                });
            } catch (err) { probeErrors.push(`${workerClientId}: ${err.message}`); continue; }
            if (!this._isUnknownOperationResult(probe)) {
                return this._invokeWorker(worker.port, 'wolfbook_operationStatus', {
                    operation_id: operationId, include_progress: includeProgress, wait_seconds: waitSeconds, kernel_id: kernelId
                });
            }
        }
        return { content: [{ type: 'text', text:
            `Unknown operation_id: ${operationId}. Probed this window and ${this._workers.size} other window(s). ` +
            'Operations are kept per kernel (last 50) and are invalidated when that kernel restarts.' +
            (probeErrors.length ? `\nProbe failures: ${probeErrors.join('; ')}` : '')
        }], isError: true };
    }

    async _invokeLocalOperationStatus(operationId, waitSeconds, includeProgress = true, kernelId = undefined) {
        const statusTool = this._tools.get('wolfbook_operationStatus');
        if (!statusTool) return { content: [{ type: 'text', text: `Unknown operation_id: ${operationId}` }], isError: true };
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
        // A tool throw (e.g. kernel resolution) must surface as a probe miss,
        // not escape to _handleMessage as a bare JSON-RPC -32603.
        let result;
        try {
            result = await statusTool.invoke({ input: {
                operation_id: operationId, include_progress: includeProgress, wait_seconds: waitSeconds,
                ...(kernelId ? { kernel_id: kernelId } : {}),
            }, skipConfirm: true }, token);
        } catch (err) {
            return { content: [{ type: 'text', text: `Unknown operation_id: ${operationId}` }],
                isError: true, _probeError: err.message };
        }
        return {
            content: (result?.content || []).map(part => ({ type: 'text', text: String(part.value ?? part.text ?? '') })),
            isError: false,
        };
    }

    _isUnknownOperationResult(result) {
        const text = (result?.content || []).filter(part => part?.type === 'text')
            .map(part => String(part.text || '')).join('\n');
        return result?.isError === true || /Unknown operation_id:/i.test(text);
    }

    _waitForOperation(operation, waitMs) {
        if (operation.status !== 'pending') return Promise.resolve(true);
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(false), waitMs);
            operation.promise.then(
                () => { clearTimeout(timer); resolve(true); },
                () => { clearTimeout(timer); resolve(true); }
            );
        });
    }

    _operationStillRunningResult(operation) {
        return {
            content: [{ type: 'text', text:
                'Operation still running after 5 minutes. It has not been aborted.\n\n' +
                `Operation ID: ${operation.id}\n\n` +
                'Choose one:\n' +
                `- Continue: call wolfbook_waitEvaluation with operation_id="${operation.id}".\n` +
                '- Stop: call wolfbook_kernelControl with action="abort".\n\n' +
                'If neither action is taken within 10 minutes, Wolfbook forgets only the transport waiter; kernel work is not aborted and the same ID remains discoverable in the execution journal.'
            }],
            isError: false,
        };
    }

    _renewOperationLease(operation) {
        if (operation.leaseTimer) clearTimeout(operation.leaseTimer);
        operation.leaseTimer = setTimeout(
            () => this._expireOperation(operation.id), this._operationLeaseMs);
    }

    async _expireOperation(operationId) {
        const operation = this._operations.get(operationId);
        if (!operation) return;
        // Transport operations do not own the kernel lease. Never abort from
        // this registry: the per-window execution registry/arbiter is the only
        // authority that can prove which operation is currently running.
        this._forgetOperation(operationId);
    }

    _forgetOperation(operationId) {
        const operation = this._operations.get(operationId);
        if (operation?.leaseTimer) clearTimeout(operation.leaseTimer);
        this._operations.delete(operationId);
    }

    // ── Session target helpers ─────────────────────────────────────────

    _maybeTargetNewNotebook(name, args, sessionId, clientId, result) {
        if (name !== 'wolfbook_newNotebook' || args?.target === false || result?.isError) return null;
        const firstText = String(result?.content?.find?.(p => p?.type === 'text')?.text || '');
        // Target on open-existing too — newNotebook's contract is "make this the
        // MCP target", whether or not the file already existed.
        if (!/^(Created and opened|Opened existing)\b/.test(firstText)) return null;
        const raw = String(args?.path || args?.filename || '').trim();
        if (!raw) return null;
        const withExt = raw.match(/\.(wb|evsnb|vsnb)$/i) ? raw : `${raw}.wb`;
        const notebook = withExt.replace(/\\/g, '/').split('/').pop();
        if (!notebook) return null;
        const target = { clientId: clientId || null, notebook, ts: Date.now() };
        this._sessionTargets.set(sessionId, target);
        const clientName = this._sessionClientNames.get(sessionId);
        if (clientName) this._lastTargetByClient.set(clientName, { target, ts: Date.now() });
        this._recordSessionTarget(sessionId, target, 'new-notebook');
        return target;
    }

    /** Handle wolfbook_setTarget: validate, check conflicts, then persist per-session target. */
    _handleSetTarget(args, sessionId = 'mcp') {
        this._pruneWorkers();
        const targetCid = (args.client_id || '').trim() || null;
        const targetNb  = (args.notebook  || '').trim() || null;
        const force     = !!args.force;
        const assertedKernel = (args.kernel_id || '').trim() || null;

        // Omit both → clear this session's target
        if (!targetCid && !targetNb) {
            this._sessionTargets.delete(sessionId);
            this._recordSessionTarget(sessionId, null, 'cleared');
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
            const evicted = [];
            for (const [sid, t] of this._sessionTargets) {
                if (sid === sessionId) continue;  // same session updating its own target
                const sameClient = !targetCid || !t.clientId || t.clientId === targetCid;
                if (sameClient && t.notebook && t.notebook.toLowerCase() === targetNb.toLowerCase()) {
                    // A stale Copilot pseudo-lock (>10 min, or ts-less from an older
                    // build) yields without force — a read-only tool having set it
                    // must not lock out a real MCP session indefinitely.
                    const copilotStale = sid === 'copilot' && (!t.ts || Date.now() - t.ts > 600000);
                    if (force || copilotStale) {
                        // Evict the stale lock
                        evicted.push(sid);
                    } else {
                        const who = sid === 'copilot' ? 'Copilot (in-editor agent)' : `another MCP session (${sid.slice(0, 8)}…)`;
                        const age = t.ts ? ` [locked ${Math.round((Date.now() - t.ts) / 60000)} min ago]` : '';
                        return {
                            content: [{ type: 'text', text:
                                `Cannot claim "${targetNb}" — it is already targeted by ${who}${age}.\n` +
                                `Use wolfbook_list_clients to see current targets. ` +
                                `If that session is dead, use wolfbook_setTarget with force:true to evict the lock.\n\n` +
                                `Current binding: ${JSON.stringify(this._resolveNotebookKernel(targetCid, targetNb) || { lifecycle: 'unbound' })}`
                            }],
                            isError: false,
                        };
                    }
                }
            }
            for (const sid of evicted) this._sessionTargets.delete(sid);
        }

        const resolvedClientId = targetCid || this._ownClientId;
        const binding = this._resolveNotebookKernel(resolvedClientId, targetNb);
        if (assertedKernel && binding?.kernel_id !== assertedKernel) {
            return { content: [{ type: 'text', text: JSON.stringify({
                error: 'kernel-target-mismatch', client_id: targetCid, notebook: targetNb,
                asserted_kernel_id: assertedKernel, current_binding: binding || { lifecycle: 'unbound' }
            }, null, 2) }], isError: false };
        }
        const kernelId = binding?.kernel_id || null;
        const targetRecord = { clientId: resolvedClientId, notebook: targetNb, kernelId, ts: Date.now() };
        this._sessionTargets.set(sessionId, targetRecord);
        const clientName = this._sessionClientNames.get(sessionId);
        if (clientName) this._lastTargetByClient.set(clientName, { target: targetRecord, ts: Date.now() });
        this._recordSessionTarget(sessionId, targetRecord, 'explicit');

        const parts = [];
        if (targetNb)  parts.push(`notebook: **${targetNb}**`);
        if (resolvedClientId) parts.push(`client: **${resolvedClientId}**`);
        if (kernelId) parts.push(`kernel: **${binding.kernel_label} · ${kernelId}**`);
        return {
            content: [{ type: 'text', text:
                `Session target set — ${parts.join(', ')}. All subsequent tool calls will auto-route there.\n\n` +
                JSON.stringify({ client_id: resolvedClientId, notebook: targetNb, kernel_id: kernelId }, null, 2)
            }],
            isError: false,
        };
    }

    _resolveNotebookKernel(clientId, notebook) {
        if (!notebook) return null;
        const client = this._buildClientList().find(c => !clientId || c.clientId === clientId);
        if (!client) return null;
        const base = value => String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
        const wanted = base(notebook);
        return (client.kernels || []).find(kernel =>
            (kernel.notebooks || []).some(value => base(value) === wanted)) || null;
    }

    /** Append a compact [Target: ...] footer when a session target is active. */
    _appendTargetFooter(result, target, via) {
        if (!target) return result;
        const { clientId, notebook, kernelId } = target;
        const label = [notebook, clientId, kernelId].filter(Boolean).join(' @ ');
        if (!label) return result;
        const footer = `\n\n└ *Target: ${label}${via ? ` · via: ${via}` : ''}*`;
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
    /** Drop dead windows from the worker table: their PID is gone or their
     *  registration is stale.  Without this, every window this primary has
     *  ever seen stays a routing candidate forever (list_clients ghosts,
     *  misrouted notebook auto-routes, wasted operation probes). */
    _pruneWorkers() {
        let isPidAlive = null;
        try { ({ isPidAlive } = require('./registry')); } catch (_) {}
        const WORKER_TTL_MS = 60000;   // workers re-register every ~5 s
        for (const [clientId, info] of [...this._workers.entries()]) {
            const dead = (isPidAlive && info.pid && !isPidAlive(info.pid)) ||
                (info.registeredAt && Date.now() - info.registeredAt > WORKER_TTL_MS);
            if (dead) this._workers.delete(clientId);
        }
    }

    _dropWorkerByPort(workerPort) {
        for (const [clientId, info] of [...this._workers.entries()]) {
            if (info.port === workerPort) this._workers.delete(clientId);
        }
    }

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
                timeout: 0,        // primary operation manager owns long-call deadlines
            }, res => {
                let data = '';
                res.on('data', d => { data += d; });
                res.on('end', () => {
                    try {
                        const r = JSON.parse(data);
                        if (r.isError) {
                            resolve({ content: [{ type: 'text', text: `Error: ${r.error || ''}` }], isError: true });
                            return;
                        }
                        // Reconstruct MCP content blocks from worker parts (supports text + image).
                        const content = (r.parts || (r.text != null ? [{ kind: 'text', value: r.text }] : []))
                            .map(p => p.kind === 'image'
                                ? (() => {
                                    const comma = p.value.indexOf(',');
                                    const mimeType = p.value.slice('data:'.length, p.value.indexOf(';base64,'));
                                    return { type: 'image', data: p.value.slice(comma + 1), mimeType };
                                })()
                                : { type: 'text', text: p.value ?? '' });
                        resolve({ content: content.length ? content : [{ type: 'text', text: '' }], isError: false });
                    } catch (e) {
                        reject(new Error(`Worker response parse error: ${e.message}`));
                    }
                });
            });
            req.on('error',   e => {
                // A refused/reset connection means the window is gone — evict it
                // so it stops being a routing candidate.
                if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(e?.code)) {
                    this._dropWorkerByPort(workerPort);
                    reject(new Error(`Worker window is no longer reachable (${e.code}); it has been removed from the client list.`));
                    return;
                }
                reject(e);
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('Worker tool call timed out')); });
            req.write(body);
            req.end();
        });
    }

    /** Scan tool args for any value that looks like a notebook path and find the
     *  worker that has it open.  Returns the worker info object or null. */
    _findWorkerByNotebook(args) {
        if (!args || typeof args !== 'object') return null;
        this._pruneWorkers();
        const NB_EXTS = ['.wb', '.evsnb', '.vsnb'];
        // Notebooks are stored as full paths in the registry.  The agent may
        // pass just a basename (e.g. "proto2.wb") or a full path — match both.
        const _base = p => (p || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
        for (const val of Object.values(args)) {
            if (typeof val !== 'string') continue;
            if (!NB_EXTS.some(ext => val.toLowerCase().endsWith(ext))) continue;
            const targetBase = _base(val);
            for (const [clientId, info] of this._workers.entries()) {
                if ((info.notebooks || []).some(nb => nb === val || _base(nb) === targetBase)) {
                    return { clientId, ...info };
                }
            }
        }
        return null;
    }

    /** Build structured client list (used by /workers endpoint and wolfbook_list_clients). */
    _buildClientList() {
        this._pruneWorkers();
        const dedupe = notebooks => {
            const seen = new Set();
            return (notebooks || []).filter(value => {
                const key = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                if (!key || seen.has(key)) return false;
                seen.add(key); return true;
            });
        };
        const list = [];
        if (this._ownClientId) {
            list.push({
                clientId:  this._ownClientId,
                workspace: this._ownWorkspace || this._workspaceFromClientId(this._ownClientId),
                role:      'primary',
                notebooks: dedupe(this._ownNotebooks),
                kernels: this._getOwnKernels?.() || [],
                pid:       process.pid,
                generation: this._ownRegistrationGeneration,
                registeredAt: null,
            });
        }
        for (const [clientId, info] of this._workers) {
            list.push({
                clientId,
                workspace: info.workspace || this._workspaceFromClientId(clientId),
                role:      'worker',
                notebooks: dedupe(info.notebooks),
                kernels: info.kernels || [],
                pid:       info.pid,
                generation: info.generation || null,
                registeredAt: info.registeredAt || null,
            });
        }
        return list;
    }

    /** Current MCP transports, kept separate from the durable event ledger so
     * interrupted extension hosts cannot leave ghost agents marked active. */
    _buildSessionList() {
        return [...this._sessions.keys()].map(sessionId => {
            const target = this._sessionTargets.get(sessionId) || null;
            return {
                sessionId,
                agentName: this._sessionClientNames.get(sessionId) || null,
                connectedAt: this._sessionConnectedAt.get(sessionId) || null,
                hostClientId: this._ownClientId,
                hostWorkspace: this._workspaceForClient(this._ownClientId),
                targetClientId: target?.clientId || null,
                targetWorkspace: this._workspaceForClient(target?.clientId),
                notebook: target?.notebook || null,
                kernelId: target?.kernelId || null,
            };
        });
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
                    const binding = (c.kernels || []).find(k => (k.notebooks || []).some(nb => _base(nb).toLowerCase() === base.toLowerCase()));
                    const identity = binding
                        ? `  [${binding.kernel_label} · ${binding.kernel_id} · ${binding.lifecycle}]`
                        : '  [unbound]';
                    return tag ? `  • ${base}${identity}  ⟵ *in use by ${tag}*` : `  • ${base}${identity}`;
                }).join('\n');
            const generation = c.generation ? ` · generation ${c.generation}` : '';
            return `${c.clientId}  [${c.role}${generation}]\n${nbList}`;
        });

        // Show all active session targets
        if (this._sessionTargets.size > 0) {
            const targetLines = [];
            for (const [sid, t] of this._sessionTargets) {
                const who   = sid === 'copilot' ? 'Copilot' : `session ${sid.slice(0, 6)}…`;
                const label = [t.notebook, t.clientId].filter(Boolean).join(' @ ');
                const age   = t.ts ? ` [locked ${Math.round((Date.now() - t.ts) / 60000)} min ago]` : '';
                targetLines.push(`  ${who} → ${label}${age}`);
            }
            lines.push(`\n**Active targets:**\n${targetLines.join('\n')}`);
            lines.push('*Use wolfbook_setTarget with force:true to evict a stale lock.*');
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
            tags:        Array.isArray(t.tags) ? t.tags : [],
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
        // Source shell profile so we pick up nvm/conda/homebrew paths
        const shellCmd = process.platform === 'win32'
            ? 'where node'
            : 'source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true; which node';
        const resolved = execSync(shellCmd, { encoding: 'utf8', shell: process.platform === 'win32' ? undefined : '/bin/zsh', timeout: 5000 }).trim().split('\n')[0].trim();
        if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {}
    // Hard-coded fallbacks for common macOS/Linux installations
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const fallbacks = [
        '/opt/anaconda3/bin/node',
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
    ];
    // nvm: scan ~/.nvm/versions/node/ for the highest version
    try {
        const nvmDir = path.join(home, '.nvm', 'versions', 'node');
        if (fs.existsSync(nvmDir)) {
            const versions = fs.readdirSync(nvmDir)
                .filter(d => /^v\d+/.test(d))
                .sort((a, b) => {
                    const pa = a.slice(1).split('.').map(Number);
                    const pb = b.slice(1).split('.').map(Number);
                    for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0); }
                    return 0;
                });
            for (const v of versions) {
                const p = path.join(nvmDir, v, 'bin', 'node');
                if (fs.existsSync(p)) return p;
            }
        }
    } catch {}
    // fnm: ~/.local/share/fnm/node-versions/
    try {
        const fnmDir = path.join(home, '.local', 'share', 'fnm', 'node-versions');
        if (fs.existsSync(fnmDir)) {
            const versions = fs.readdirSync(fnmDir).sort().reverse();
            for (const v of versions) {
                const p = path.join(fnmDir, v, 'installation', 'bin', 'node');
                if (fs.existsSync(p)) return p;
            }
        }
    } catch {}
    for (const fb of fallbacks) {
        try { if (fs.existsSync(fb)) return fb; } catch {}
    }
    return 'node';  // rely on PATH as last resort
}

/**
 * Validate that a node binary actually works by running `node --version`.
 * Returns { ok: true, version: 'v20.x.x' } or { ok: false, error: '...' }.
 */
function validateNodeBinary(nodeBin) {
    try {
        const { execSync } = require('child_process');
        const ver = execSync(`"${nodeBin}" --version`, { encoding: 'utf8', timeout: 5000 }).trim();
        if (/^v\d+/.test(ver)) return { ok: true, version: ver };
        return { ok: false, error: `Unexpected output: ${ver}` };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
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
    const desktopConfigPath = path.join(appSupportDir(home), 'Claude', 'claude_desktop_config.json');
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

/**
 * Repair wolfbook MCP entries that point at a bridge which no longer exists.
 *
 * WHY: the registered path contains the extension VERSION
 * (~/.vscode/extensions/wolfbook.wolfbook-<version>/...), and VS Code deletes
 * the old directory on every update. writeClaudeConfig only refreshes the
 * workspaces that are OPEN at activation, so every other project keeps a dead
 * path and its MCP server shows up as "Failed" with no usable explanation
 * (node exits with MODULE_NOT_FOUND before our bridge can say anything).
 *
 * This sweeps ALL projects in ~/.claude.json and repoints any wolfbook entry
 * whose bridge file is missing. Entries that already resolve are left alone, and
 * nothing is written unless something actually changed.
 *
 * @returns {{repaired: string[], checked: number}}
 */
function repairStaleClaudeConfigs(bridgePath, nodeBin, home) {
    home = home || process.env.HOME || process.env.USERPROFILE || '~';
    const claudeJsonPath = path.join(home, '.claude.json');
    const out = { repaired: [], checked: 0 };
    let root;
    try {
        if (!fs.existsSync(claudeJsonPath)) return out;
        root = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not read ~/.claude.json for repair:', e.message);
        return out;
    }
    if (!root || !root.projects || typeof root.projects !== 'object') return out;

    let changed = false;
    for (const [wsPath, proj] of Object.entries(root.projects)) {
        const entry = proj && proj.mcpServers && proj.mcpServers.wolfbook;
        if (!entry) continue;
        out.checked++;
        const current = Array.isArray(entry.args) ? entry.args[0] : null;
        // Only touch entries that are actually broken: a missing bridge file, or
        // a node binary that no longer exists. A user who deliberately points at
        // a custom bridge that DOES exist keeps their setting.
        const bridgeOk = current && fs.existsSync(current);
        const nodeOk   = !entry.command || entry.command === 'node' || fs.existsSync(entry.command);
        if (bridgeOk && nodeOk) continue;
        proj.mcpServers.wolfbook = { type: 'stdio', command: nodeBin, args: [bridgePath], env: entry.env || {} };
        out.repaired.push(wsPath);
        changed = true;
    }
    if (!changed) return out;

    try {
        // Atomic write: ~/.claude.json holds the user's entire CLI state, so a
        // truncated file from a mid-write crash would be very costly.
        const tmp = claudeJsonPath + '.wolfbook.tmp';
        fs.writeFileSync(tmp, JSON.stringify(root, null, 2), 'utf8');
        fs.renameSync(tmp, claudeJsonPath);
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not repair ~/.claude.json:', e.message);
        return { repaired: [], checked: out.checked };
    }
    return out;
}

/** Check if all configs already have the correct wolfbook entry.
 *  Returns true when a write is needed.
 */
function needsConfigUpdate(bridgePath, nodeBin, workspacePaths) {
    const home = process.env.HOME || process.env.USERPROFILE || '~';

    // Check Claude Desktop config
    try {
        const cfg = JSON.parse(fs.readFileSync(
            path.join(appSupportDir(home), 'Claude', 'claude_desktop_config.json'), 'utf8'));
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
// Path: <app-support>/Code/User/globalStorage/
//         saoudrizwan.claude-dev/settings/cline_mcp_settings.json  (macOS: ~/Library/Application Support, Linux: $XDG_CONFIG_HOME)
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
        : path.join(appSupportDir(base), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
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
// Roo Code (rooveterinaryinc.roo-cline) MCP config
// Path: <app-support>/Code/User/globalStorage/
//         rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json  (macOS: ~/Library/Application Support, Linux: $XDG_CONFIG_HOME)
//       %APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json  (Windows)
// Format identical to Cline's — same key, different extension folder.
// ---------------------------------------------------------------------------

/** Resolve the Roo Code MCP settings file path for the current platform. */
function _rooCodeConfigPath() {
    const isWin = process.platform === 'win32';
    const base  = isWin
        ? (process.env.APPDATA || path.join(process.env.USERPROFILE || '~', 'AppData', 'Roaming'))
        : (process.env.HOME || '~');
    return isWin
        ? path.join(base, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json')
        : path.join(appSupportDir(base), 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json');
}

/** Write the wolfbook MCP entry into Roo Code's settings file.
 *  Only writes if Roo Code is installed (settings directory exists or file exists).
 *  Returns { updated: bool, configPath: string, skipped: bool }.
 */
function writeRooCodeConfig(bridgePath, nodeBin) {
    const configPath = _rooCodeConfigPath();
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
        console.warn('[Wolfbook MCP] Could not write Roo Code config:', e.message);
        return { updated: false, configPath, skipped: false };
    }
}

/** Returns true if the Roo Code config needs writing (entry missing or stale). */
function needsRooCodeConfigUpdate(bridgePath, nodeBin) {
    const configPath = _rooCodeConfigPath();
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
            : path.join(appSupportDir(home), 'Claude', 'claude_desktop_config.json'),
        claudeCode:  path.join(home, '.claude.json'),
        cline: isWin
            ? path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
            : path.join(appSupportDir(home), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
        rooCode: isWin
            ? path.join(appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json')
            : path.join(appSupportDir(home), 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json'),
        antigravity: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
        codex:       path.join(home, '.codex', 'config.toml'),
    };

    const configured = {};
    try { configured.claudeDesktop = !!(JSON.parse(fs.readFileSync(configPaths.claudeDesktop, 'utf8'))?.mcpServers?.wolfbook); } catch { configured.claudeDesktop = false; }
    try { configured.claudeCode    = !!(JSON.parse(fs.readFileSync(configPaths.claudeCode, 'utf8'))?.mcpServers?.wolfbook); }    catch { configured.claudeCode  = false; }
    try { configured.cline         = !!(JSON.parse(fs.readFileSync(configPaths.cline, 'utf8'))?.mcpServers?.wolfbook); }         catch { configured.cline        = false; }
    try { configured.rooCode       = !!(JSON.parse(fs.readFileSync(configPaths.rooCode, 'utf8'))?.mcpServers?.wolfbook); }       catch { configured.rooCode      = false; }
    try { configured.antigravity   = !!(JSON.parse(fs.readFileSync(configPaths.antigravity, 'utf8'))?.wolfbook); }               catch { configured.antigravity  = false; }
    try { configured.codex         = fs.readFileSync(configPaths.codex, 'utf8').includes('[mcp_servers.wolfbook]'); }            catch { configured.codex        = false; }

    return { port: port || 0, bridgePath, nodeBin, isSecondary: !!isSecondary, isDisabled: !!isDisabled, configPaths, configured };
}

module.exports = { WolframMCPServer, loadMCPSchemas, configureClaudeDesktop, writeClaudeConfig,
    repairStaleClaudeConfigs, needsConfigUpdate, resolveNodeBinary, validateNodeBinary, probeExistingServer, writeAntigravityConfig, needsAntigravityConfigUpdate, installAntigravitySkill, needsSkillInstall, writeClineConfig, needsClineConfigUpdate, writeRooCodeConfig, needsRooCodeConfigUpdate, getMcpInfoPayload };
