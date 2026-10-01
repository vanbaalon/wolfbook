'use strict';
// ---------------------------------------------------------------------------
// Wolfbook MCP Server
// Exposes Wolfram notebook tools to MCP clients. Runs inside the VS Code
// extension process so it has full access to the vscode.* APIs the tools use.
//
// Transports (all served by one handler):
//   POST/GET/DELETE /mcp     Streamable HTTP (protocol 2025-03-26 and later)
//   GET /sse + POST /message legacy HTTP+SSE (2024-11-05) — kept: the stdio
//                            bridge and older clients use it
// Both on 127.0.0.1:27182+ and, on macOS/Linux, a private Unix socket
// (local-socket.js) for sandboxed hosts such as Claude Science.
// Clients normally connect through stdio-bridge.js; the configure commands
// write those entries.
// ---------------------------------------------------------------------------

const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { setMcpCallActive } = require('../tools/shared');
const { McpResultStore, structuralSummary } = require('./result-store');
const { runWithActivityContext } = require('../monitor/activity');
const { ensurePrivateSocketDir, socketAlive } = require('./local-socket');
const { toolAnnotations } = require('./tool-annotations');
const auth = require('./auth');
const { checkToolArguments, unknownParameterMessage } = require('./param-check');

const DEFAULT_PORT  = 27182;
const PORT_RANGE    = 20;  // try DEFAULT_PORT … DEFAULT_PORT+PORT_RANGE if busy
const OPERATION_WAIT_MS  = 300000;  // return control to the model every 5 minutes
const OPERATION_FAST_WAIT_MS = 2000; // complete quick calls inline; return a handle for slow work
const OPERATION_LEASE_MS = 600000;  // forget transport waiter if the model is silent
// A call that states how long it is willing to wait (evaluateExpression
// timeoutSeconds, operationStatus wait_seconds) is held inline that long instead
// of the 2 s fast window — but never past the client's own request timeout.
// Codex and Claude Desktop give up on a tool call after 60 s; Claude Code waits.
const OPERATION_EXPLICIT_WAIT_MAX_MS = 55000;
const OPERATION_EXPLICIT_WAIT_LONG_MS = OPERATION_WAIT_MS;
const LONG_WAIT_CLIENTS = /^claude[-_ ]?code/i;

const MCP_PROFILES = new Set(['auto', 'economy', 'notebook', 'slides', 'paper', 'full']);

// Protocol revisions this server speaks, newest first. initialize echoes the
// client's version when it is here, else offers the newest (spec "Version
// negotiation"). 2026-07-28 (stateless, no initialize) is not implemented yet.
const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];
function negotiateProtocolVersion(requested) {
    return MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_LATEST_PROTOCOL;
}
const HTTP_SESSION_IDLE_MS = 60 * 60 * 1000;   // Streamable HTTP session with no traffic and no stream
const SOCKET_CHECK_MS = 60 * 1000;             // re-create the socket if /tmp cleaning removed it
let _serverVersion = '0.0.0';
try { _serverVersion = require('../../../package.json').version || _serverVersion; } catch (_) {}
// Codex defers MCP tools and never re-fetches tools/list — see writeClaudeConfig.
const CODEX_BRIDGE_PROFILE_ARG = '--profile=full';
const exposure = require('./tool-exposure');

// A deliberately small, still-complete notebook/kernel surface for models that
// struggle with Wolfbook's full catalogue. Calls to unadvertised tools remain
// valid by name; this only reduces tools/list size and tool-selection ambiguity.
const ECONOMY_TOOL_SPECS = Object.freeze({
    wolfbook_newNotebook: ['Open/create a notebook and optionally make it the session target.',
        ['path', 'filename', 'directory', 'target']],
    wolfbook_getNotebookContext: ['Read, list, switch, save, or briefly summarize notebook cells and outputs.',
        ['action', 'notebook', 'startCell', 'endCell', 'brief', 'kind', 'since_revision', 'if_revision', 'cell_ids', 'cell_numbers']],
    wolfbook_evaluateExpression: ['Evaluate Wolfram Language in the live notebook kernel.',
        ['expression', 'timeoutSeconds', 'wait_mode', 'caption', 'outputForm', 'multiLine']],
    wolfbook_insertCells: ['Insert one code or Markdown cell; optionally evaluate it.',
        ['kind', 'content', 'position', 'afterCellId', 'afterCell', 'evaluate', 'timeoutSeconds', 'wait_mode', 'notebook', 'expected_notebook_revision']],
    wolfbook_editCell: ['Replace one cell by ID or 1-based number; optionally evaluate it.',
        ['cellNumber', 'cellId', 'content', 'evaluate', 'timeoutSeconds', 'wait_mode', 'notebook', 'expected_notebook_revision']],
    wolfbook_runCell: ['Run one cell or an inclusive cell range in the live kernel.',
        ['cellId', 'cellNumber', 'startCell', 'endCell', 'stopOnError', 'timeoutSeconds', 'wait_mode', 'notebook']],
    wolfbook_deleteCell: ['Delete one or more cells, saving recovery content by default.',
        ['cellNumber', 'cellId', 'cellNumbers', 'cellIds', 'saveToRecovery', 'notebook', 'expected_notebook_revision']],
    wolfbook_searchCells: ['Search code or Markdown cells, optionally including outputs.',
        ['query', 'queries', 'regex', 'kind', 'includeOutput', 'notebook', 'limit']],
    wolfbook_inspectSymbols: ['Inspect user-defined symbols in the live kernel.',
        ['pattern', 'limit', 'namesOnly']],
    wolfbook_status: ['Read side-effect-free client, kernel, operation, or notebook status.',
        ['scope', 'notebook']],
    wolfbook_operationStatus: ['Poll a queued or asynchronous evaluation and its progress.',
        ['operation_id', 'include_progress', 'after_sequence', 'wait_seconds']],
    wolfbook_saveNotebook: ['Save the current or named notebook.', ['notebook']],
    wolfbook_getResult: ['Read a bounded result by handle, slice, or structured path.',
        ['handle', 'offset', 'limit', 'format', 'path']],
    wolfbook_kernelControl: ['Restart, abort, checkpoint, or restore the live kernel.',
        ['action', 'tag', 'path', 'checkpoint_before_restart', 'operation_id', 'reason']],
    wolfbook_kernelManager: ['List, create, bind, rename, or stop private kernels.',
        ['action', 'kernel_id', 'notebook', 'label', 'acknowledge_resource_cost']],
    wolfbook_getCellOutput: ['Read one cell output without re-running it.', ['cellId', 'cellNumber', 'notebook']],
    wolfbook_validateSyntax: ['Validate one cell or an inclusive cell range.',
        ['cellId', 'cellNumber', 'startCell', 'endCell', 'notebook']],
});
const ECONOMY_TOOL_NAMES = new Set(Object.keys(ECONOMY_TOOL_SPECS));

function _compactEconomySchema(schema) {
    if (!schema || typeof schema !== 'object') return {};
    if (Array.isArray(schema)) return schema.map(_compactEconomySchema);
    const out = {};
    for (const key of ['type', 'enum', 'minimum', 'maximum']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.items !== undefined) out.items = _compactEconomySchema(schema.items);
    return out;
}

function _economyToolSchema(tool) {
    const [description, propertyNames] = ECONOMY_TOOL_SPECS[tool.name];
    const sourceProperties = tool.inputSchema?.properties || {};
    const properties = {};
    for (const name of propertyNames) {
        if (sourceProperties[name]) properties[name] = _compactEconomySchema(sourceProperties[name]);
    }
    const required = (tool.inputSchema?.required || []).filter(name => propertyNames.includes(name));
    return {
        ...tool,
        description,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    };
}

// MCP clients with deferred tool discovery (notably Claude Code) see server
// instructions before they see full tool descriptions. Keep the routing rule
// concise and put the Mathematica/Wolfram trigger words first.
const MCP_SERVER_INSTRUCTIONS =
    'Use Wolfbook for Mathematica and Wolfram Language work inside VS Code. ' +
    'Search for and use Wolfbook tools for .wb, .evsnb, .vsnb, and .nb notebooks; ' +
    '.wl and .wls code; notebook cells; live evaluation; kernel state; debugging; ' +
    'plots; slides; papers; and Wolfram documentation. Read notebook context before ' +
    'changing notebook cells. Prefer Wolfbook evaluation and kernel tools over ' +
    'launching wolframscript or WolframKernel in a terminal, and never edit Wolfbook ' +
    'notebook JSON with generic file tools. Use a direct/headless Wolfram process only ' +
    'when the user explicitly requests it or Wolfbook is unavailable. ' +
    'Frequently used tools are always listed; slide and paper tools appear while a deck or .tex is open. ' +
    'Rarer tools (debugger, literature search, slide/paper extras, ask-the-user, Oberon) are revealed with ' +
    'wolfbook_tools (action "list", then "enable" or "call"). ' +
    // Claude Desktop has no local skill directory, so this string is the ONLY
    // guidance it ever sees — the SKILL.md section on this cannot reach it.
    'Show any result the user is meant to read as a Grid (e.g. ' +
    'Grid[{{"name", value}, ...}, Frame -> All]), never as a bare Association: ' +
    'a Grid renders as a real table, an Association as one run-on line. ' +
    'Associations are still the right structure for data you parse yourself.';

const MCP_ECONOMY_INSTRUCTIONS =
    'Use Wolfbook for Mathematica and Wolfram Language notebook work in VS Code. ' +
    'Read notebook context before editing cells. Use the advertised Wolfbook tools ' +
    'for notebook edits, evaluation, results, status, and kernel control; do not edit ' +
    'Wolfbook notebook JSON or launch a separate Wolfram kernel. This is the compact ' +
    'economy tool surface; wolfbook_tools reveals more when needed. Show user-facing tabular results as Grid, not Association.';

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
        this._sessionProfiles = new Map(); // sessionId → per-connection tools/list profile
        this._sessionProtocol = new Map(); // sessionId → negotiated protocol version
        this._sessionTransport = new Map(); // sessionId → 'sse' | 'streamable-http'
        this._httpSessions = new Map();    // Streamable HTTP sessionId → { lastSeen }
        this._httpSessionSweep = null;
        // Unix socket (set by extension.js; null in tests unless they opt in).
        this._socketPath = operationOptions.socketPath || null;
        this._socketServer = null;
        this._socketCheck = null;
        // Access (auth.js). Off unless extension.js turns it on, so tests stay simple.
        this._requireAuth = !!operationOptions.requireAuth;
        this._onNewClient = operationOptions.onNewClient || null;          // (name) → void, never blocks
        this._isClientBlocked = operationOptions.isClientBlocked || null;  // (name) → bool
        this._announcedClients = new Set();
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
        this._sessionLastActive = new Map(); // sessionId → ts of its last tools/call
        this._operations = new Map(); // operationId → managed long-running call
        this._requestOperations = new Map(); // SSE session/request id → operationId
        this._operationWaitMs = operationOptions.waitMs || OPERATION_WAIT_MS;
        this._operationFastWaitMs = operationOptions.initialWaitMs ??
            (operationOptions.waitMs != null ? operationOptions.waitMs : OPERATION_FAST_WAIT_MS);
        this._operationLeaseMs = operationOptions.leaseMs || OPERATION_LEASE_MS;
        this._canonicalProjection = !!operationOptions.canonicalProjection;
        this._renderCache = !!operationOptions.renderCache;
        this._boundedResults = operationOptions.boundedResults !== false;
        this._resultThreshold = Math.max(4096, Number(operationOptions.resultThreshold) || 12000);
        this._resultStore = new McpResultStore(operationOptions.resultStoreOptions);
        this._activity = operationOptions.activityMonitor || null;
        this._notebookNotifier = operationOptions.notebookNotifier || null;
        // Tool surface exposure (Phase 0.2): tags on package.json languageModelTools
        // entries drive tools/list visibility. `mcp:hidden` → never listed;
        // `mcp:deprecated` → listed only when exposeDeprecatedTools, with a
        // DEPRECATED prefix (mcp:replacedBy:<name> names the successor);
        // profile 'notebook' drops wolfslide_*, non-'full' drops fairy/gold/wolfteam
        // unless tagged mcp:core. Hidden ≠ removed: tools/call resolves from
        // this._tools, so every name keeps working — the zero-breakage guarantee.
        this._exposeDeprecatedTools = !!operationOptions.exposeDeprecatedTools;
        this._profile = MCP_PROFILES.has(operationOptions.profile)
            ? operationOptions.profile : 'auto';
        // Reveal-on-demand state (see tool-exposure.js). Per session: families and
        // single tools the agent enabled with wolfbook_tools. Remembered per client
        // name for 60 min so a reconnect keeps them, like _lastTargetByClient.
        this._sessionExposure = new Map();     // sessionId → { families:Set, tools:Set }
        this._exposureByClient = new Map();    // clientInfo.name → { families, tools, ts }
        // Baseline = nothing open. Starting from "unknown" swallowed the FIRST change,
        // so a deck opened before any other context event was never announced.
        this._lastDocContextKey = '00';       // slides|paper flags last announced
    }

    _exposureFor(sessionId) {
        if (!this._sessionExposure.has(sessionId)) {
            this._sessionExposure.set(sessionId, { families: new Set(), tools: new Set() });
        }
        return this._sessionExposure.get(sessionId);
    }

    /** Open-document context across ALL windows: is a deck / a paper open anywhere? */
    _docContext() {
        let own = {};
        try { own = require('./paper-routing').paperWindowInfo(); } catch (_) {}
        const slides = (own.slideFiles || []).length > 0 ||
            [...this._workers.values()].some(w => (w.slideFiles || []).length > 0);
        const paper = (own.paperFiles || []).length > 0 ||
            [...this._workers.values()].some(w => (w.paperFiles || []).length > 0);
        return { slides, paper };
    }

    /** Tell sessions whose list depends on context that it changed. */
    _checkDocContext() {
        const ctx = this._docContext();
        const key = `${ctx.slides ? 1 : 0}${ctx.paper ? 1 : 0}`;
        if (key === this._lastDocContextKey) return;
        this._lastDocContextKey = key;
        for (const [sessionId, profile] of this._sessionProfiles) {
            if (profile === 'auto') this._notifyToolsChanged(sessionId);
        }
    }

    _notifyToolsChanged(sessionId) {
        const sse = this._sessions.get(sessionId);
        this._sendSSE(sse, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }

    /** Listed for this session? Legacy profiles keep their old rules, plus anything enabled. */
    _listedFor(t, sessionId, profile) {
        const ex = this._sessionExposure.get(sessionId);
        return exposure.isListed(t, {
            profile, context: this._docContext(),
            families: ex?.families, tools: ex?.tools,
            exposeDeprecated: this._exposeDeprecatedTools,
        }, (tool, p) => this._isToolVisible(tool, p));
    }

    /** Phase 0.2: should this schema entry appear in tools/list? */
    _isToolVisible(t, profile = this._profile) {
        const tags = Array.isArray(t.tags) ? t.tags : [];
        if (tags.includes('mcp:hidden')) return false;
        if (tags.includes('mcp:deprecated') && !this._exposeDeprecatedTools) return false;
        if (profile === 'economy') return ECONOMY_TOOL_NAMES.has(t.name);
        if (profile !== 'full' && !tags.includes('mcp:core')) {
            // Wolfbook TeX. `paper_*` matches none of the prefixes below, so
            // without this clause it would pass every filter and show up even
            // in the slides profile — the opposite of hidden. The `paper`
            // profile is the mirror case: a paper session does not want the
            // notebook and slide families advertised at it.
            if (t.name.startsWith('paper_')) {
                return profile === 'paper' || profile === 'notebook';
            }
            if (profile === 'paper') return false;
            if (profile === 'notebook' && t.name.startsWith('wolfslide_')) return false;
            if (profile === 'slides' && t.name.startsWith('wolfbook_') &&
                !/^wolfbook_(evaluateExpression|kernel|list_clients|setTarget|operationStatus|waitEvaluation|getResult)/.test(t.name)) return false;
            if (/^(wolfbook_fairy_|wolfbook_gold_|wolfteam_)/.test(t.name)) return false;
        }
        return true;
    }

    /** Phase 0.2: description with deprecation prefix when tagged. */
    _describeTool(t) {
        const tags = Array.isArray(t.tags) ? t.tags : [];
        const raw = String(t.description || t.name || '').replace(/\s+/g, ' ').trim();
        // Shared workflow rules live in server instructions. Tool discovery
        // should carry only the unique contract, not multi-paragraph coaching.
        const concise = raw.length <= 700 ? raw : (() => {
            const prefix = raw.slice(0, 700);
            const boundary = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('; '));
            return `${prefix.slice(0, boundary > 300 ? boundary + 1 : 697).trim()}…`;
        })();
        if (!tags.includes('mcp:deprecated')) return concise;
        const replacedBy = tags.find(x => x.startsWith('mcp:replacedBy:'))?.slice('mcp:replacedBy:'.length);
        return `DEPRECATED${replacedBy ? ` — use \`${replacedBy}\` instead` : ''}. ${concise}`;
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
                console.log(`[Wolfbook MCP] Listening on http://127.0.0.1:${this._port}/mcp (legacy /sse)`);
                this._listenSocket().catch(() => {});
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

    /** Also serve on the private Unix socket (primary only; failures are non-fatal). */
    async _listenSocket() {
        const sockPath = this._socketPath;
        if (!sockPath || this._socketServer) return;
        try {
            ensurePrivateSocketDir(path.dirname(sockPath));
            if (fs.existsSync(sockPath)) {
                // Another live server owns it: leave it. A crashed primary's file: take over.
                if (await socketAlive(sockPath)) {
                    console.warn(`[Wolfbook MCP] ${sockPath} is served by another process — not taking it over`);
                    return;
                }
                fs.unlinkSync(sockPath);
            }
            const srv = http.createServer((req, res) => {
                try { this._handle(req, res); }
                catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(); } }
            });
            await new Promise((resolve, reject) => {
                srv.once('error', reject);
                srv.listen(sockPath, () => { srv.off('error', reject); resolve(); });
            });
            try { fs.chmodSync(sockPath, 0o600); } catch (_) {}
            this._socketServer = srv;
            console.log(`[Wolfbook MCP] Also listening on unix:${sockPath}`);
            if (!this._socketCheck) {
                // macOS/Linux periodically clean /tmp; a removed socket file means
                // no new connection can find us, so re-create it.
                this._socketCheck = setInterval(() => {
                    if (this._socketServer && !fs.existsSync(sockPath)) {
                        const old = this._socketServer;
                        this._socketServer = null;
                        old.close();
                        this._listenSocket().catch(() => {});
                    }
                }, SOCKET_CHECK_MS);
                this._socketCheck.unref?.();
            }
        } catch (e) {
            console.warn(`[Wolfbook MCP] Unix socket unavailable (${sockPath}): ${e.message}`);
        }
    }

    get socketPath() { return this._socketServer ? this._socketPath : null; }

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
        this._checkDocContext();
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

    _notifyNotebookTarget(clientId, notebook, kind = 'switched') {
        if (!notebook) return;
        const event = { notebook, kind };
        if (!clientId || clientId === this._ownClientId) {
            try { Promise.resolve(this._notebookNotifier?.(event)).catch(() => {}); } catch (_) {}
            return;
        }
        const worker = this._workers.get(clientId);
        if (!worker?.port) return;
        const body = JSON.stringify(event);
        const req = http.request({
            hostname: '127.0.0.1', port: worker.port, path: '/notebook-notice', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...auth.authHeaders() },
            timeout: 2000,
        }, res => res.resume());
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
        req.write(body);
        req.end();
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
                    headers: { 'Content-Length': 0, ...auth.authHeaders() }, timeout: 1500,
                }, res => { res.resume(); resolve(); });
                req.on('error', () => resolve());
                req.on('timeout', () => { req.destroy(); resolve(); });
                req.end();
            });
        }
    }

    stop() {
        for (const operationId of this._operations.keys()) this._forgetOperation(operationId);
        if (this._httpSessionSweep) { clearInterval(this._httpSessionSweep); this._httpSessionSweep = null; }
        if (this._secondary) return Promise.resolve(); // not our server to close
        if (this._socketCheck) { clearInterval(this._socketCheck); this._socketCheck = null; }
        if (this._socketServer) {
            const sock = this._socketServer;
            this._socketServer = null;
            sock.close();
            // Only unlink the file we created; a successor may already own a new one.
            try { if (fs.existsSync(this._socketPath)) fs.unlinkSync(this._socketPath); } catch (_) {}
        }
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
        // Browser pages must not acquire a local MCP session. Native clients
        // and the stdio bridge do not send Origin; no CORS grant is necessary.
        if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${this._port}`) {
            res.writeHead(403); res.end('Browser origin is not allowed'); return;
        }
        // DNS rebinding: a page on evil.example resolved to 127.0.0.1 is "same-origin"
        // for GETs (no Origin header) — its Host header still names evil.example.
        if (!auth.isLocalHost(req)) { res.writeHead(403); res.end('Host is not allowed'); return; }
        // Any other local process (another account, a sandboxed app) must hold the token.
        // Open without it: /health (how bridges and new windows find the server) and
        // GET /workers (read-only window list; the Overleaf extension's kernel picker
        // cannot hold the token). Neither runs anything.
        const openRoute = url.pathname === '/health' || (req.method === 'GET' && url.pathname === '/workers');
        if (this._requireAuth && req.method !== 'OPTIONS' && !openRoute && !auth.isAuthorized(req)) {
            auth.rejectUnauthorized(res); return;
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        if (url.pathname === '/mcp' || url.pathname === '/mcp/economy') {
            this._handleStreamable(req, res, url);
        } else if (req.method === 'GET' && (url.pathname === '/sse' || url.pathname === '/sse/economy')) {
            this._handleSSE(req, res, url);
        } else if (req.method === 'POST' && url.pathname === '/message') {
            this._handleMessage(req, res, url);
        } else if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', tools: this._schemas.length, port: this._port,
                version: _serverVersion, protocolVersions: MCP_PROTOCOL_VERSIONS,
                socket: this.socketPath,
                endpoints: { full: '/sse', economy: '/sse/economy',
                    streamable: '/mcp', streamableEconomy: '/mcp/economy' } }));
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
                        paperFiles: info.paperFiles || [],
                        slideFiles: info.slideFiles || [],
                        workspaceRoots: info.workspaceRoots || [],
                        kernels:   info.kernels || [],
                        generation: info.generation || null,
                        registeredAt: Number(info.registeredAt || Date.now()),
                        workspace: info.workspace || this._workspaceFromClientId(info.clientId),
                    });
                }
                this._checkDocContext();
            } catch {}
            res.writeHead(200); res.end();
        });
    }

    // ── SSE connection — one per Claude session ────────────────────────────
    _handleSSE(req, res, url) {
        const sessionId = crypto.randomUUID();
        const requestedProfile = url?.pathname === '/sse/economy'
            ? 'economy' : url?.searchParams?.get('profile');
        const profile = MCP_PROFILES.has(requestedProfile) ? requestedProfile : this._profile;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
        });
        res.flushHeaders?.();
        this._openSession(sessionId, profile, 'sse');
        this._sessions.set(sessionId, res);
        // MCP SSE transport: first event tells the client where to POST messages
        res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
        // A synchronous request belongs to its transport. If the bridge or
        // client disappears, do not leave its already-dispatched kernel
        // evaluation orphaned. Explicit wait_mode:"async" work is the one
        // exception: it was intentionally detached by the caller.
        req.on('close', () => this._endSession(sessionId, 'MCP transport disconnected'));
    }

    /** Register a session on either transport. */
    _openSession(sessionId, profile, transport) {
        this._sessionConnectedAt.set(sessionId, Date.now());
        this._sessionProfiles.set(sessionId, profile);
        this._sessionTransport.set(sessionId, transport);
        this._activity?.record({ type: 'agent.connected', source: 'mcp', agentSessionId: sessionId,
            state: 'running', payload: this._hostActivityPayload({ transport, profile }) });
    }

    /** Forget a session: SSE close, Streamable HTTP DELETE, or idle expiry. */
    _endSession(sessionId, reason) {
        if (!this._sessionConnectedAt.has(sessionId)) return;
        const transport = this._sessionTransport.get(sessionId) || 'sse';
        this._cancelSessionOperations(sessionId, reason).catch(() => {});
        this._activity?.record({ type: 'agent.disconnected', source: 'mcp', agentSessionId: sessionId,
            agentName: this._sessionClientNames.get(sessionId) || null, state: 'completed', payload: { transport } });
        const stream = this._sessions.get(sessionId);
        this._sessions.delete(sessionId);
        if (transport !== 'sse' && stream && !stream.destroyed) stream.end();
        this._httpSessions.delete(sessionId);
        this._sessionConnectedAt.delete(sessionId);
        this._sessionProfiles.delete(sessionId);
        this._sessionProtocol.delete(sessionId);
        this._sessionTransport.delete(sessionId);
        this._sessionExposure.delete(sessionId);
        this._sessionTargets.delete(sessionId);  // release any target claim
        this._sessionLastActive.delete(sessionId);
        this._sessionClientNames.delete(sessionId);
    }

    // ── Message POST — JSON-RPC dispatch ──────────────────────────────────
    _handleMessage(req, res, url) {
        const sessionId = url.searchParams.get('sessionId');
        const sse       = this._sessions.get(sessionId);
        if (!sse || sse.destroyed) {
            res.writeHead(404); res.end('Unknown or expired MCP session'); return;
        }

        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > 16 * 1024 * 1024) req.destroy();
        });
        req.on('end',   async () => {
            // MCP spec: respond 202 immediately, reply arrives via SSE
            res.writeHead(202);
            res.end();

            let msg;
            try { msg = JSON.parse(body); } catch { return; }
            const response = await this._processMessage(msg, sessionId);
            if (response) this._sendSSE(sse, response);
        });
    }

    /** One JSON-RPC message from any transport → its response, or null for notifications. */
    async _processMessage(msg, sessionId) {
        // MCP cancellation is a notification, but the corresponding tool
        // may already own a kernel lease. Propagate it to the execution
        // registry/arbiter using the UUID injected for this request.
        if (msg.id == null || typeof msg.method !== 'string') {
            if (msg.method === 'notifications/cancelled') {
                await this._cancelManagedRequest(sessionId, msg.params?.requestId,
                    msg.params?.reason || 'MCP client cancelled request');
            }
            return null;
        }

        // wolfbook_tools {action:"call"} is the same request as calling the tool
        // directly — rewrite it first so routing, operation tracking, bounding
        // and the envelope are all exactly those of a direct call.
        if (msg.method === 'tools/call') {
            msg.params = this._unwrapToolsCall(msg.params || {});
            this._sessionLastActive.set(sessionId, Date.now());
        }

        // Unknown parameters are refused, never silently ignored: a tool that
        // drops one answers a different question and still says ok:true.
        if (msg.method === 'tools/call' && msg.params?.name) {
            const schema = this._schemas.find(t => t.name === msg.params.name)?.inputSchema || null;
            if (!this._knownParamNames) {
                this._knownParamNames = new Set(this._schemas.flatMap(t => Object.keys(t.inputSchema?.properties || {})));
            }
            const checked = checkToolArguments(msg.params.name, msg.params.arguments, schema, this._knownParamNames);
            if (checked.unknown.length) {
                return { jsonrpc: '2.0', id: msg.id, result: this._toolErrorResult(
                    new Error(unknownParameterMessage(msg.params.name, checked.unknown, checked.valid)), msg.params.name) };
            }
            // Always the checked copy: it carries renames AND schema-typed values.
            if (checked.args !== msg.params.arguments) msg.params = { ...msg.params, arguments: checked.args };
        }

        const clientName = this._sessionClientNames.get(sessionId);
        if (msg.method === 'tools/call' && clientName && this._isClientBlocked?.(clientName)) {
            return { jsonrpc: '2.0', id: msg.id, result: this._toolErrorResult(new Error(
                `The user has blocked "${clientName}" from using Wolfbook. They can allow it again with ` +
                'the "Wolfbook: Manage Agent Access" command in VS Code.'), msg.params?.name) };
        }

        let result, error;
        try {
            const isManagedToolCall = msg.method === 'tools/call' &&
                msg.params?.name !== 'wolfbook_waitEvaluation';
            result = isManagedToolCall
                ? await this._runManagedToolCall(msg.params || {}, sessionId, msg.id)
                : await this._dispatch(msg.method, msg.params || {}, sessionId);
        } catch (e) {
            if (msg.method === 'tools/call') {
                result = this._toolErrorResult(e, msg.params?.name);
            } else {
                const code = (typeof e.code === 'number') ? e.code : -32603;
                error = { code, message: String(e.message || e) };
            }
        }

        if (!error && msg.method === 'tools/call') {
            result = this._finalizeToolResult(result, msg.params?.name, sessionId);
        }

        return error
            ? { jsonrpc: '2.0', id: msg.id, error }
            : { jsonrpc: '2.0', id: msg.id, result };
    }

    // ── Streamable HTTP (/mcp) ─────────────────────────────────────────────
    /** Host header must name this machine — a DNS-rebinding page names its own host. */
    _isLocalRequest(req) { return auth.isLocalHost(req); }

    _jsonRpcHttpError(res, status, code, message, id = null) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    }

    _handleStreamable(req, res, url) {
        if (!this._isLocalRequest(req)) {
            res.writeHead(403); res.end('Host is not allowed'); return;
        }
        const headerSession = req.headers['mcp-session-id'];
        const known = headerSession && this._httpSessions.get(headerSession);

        if (req.method === 'GET') {
            // Server→client stream: tools/list_changed and other notifications.
            if (!headerSession) return this._jsonRpcHttpError(res, 400, -32000, 'Mcp-Session-Id header required');
            if (!known) return this._jsonRpcHttpError(res, 404, -32001, 'Unknown or expired MCP session');
            if (!/text\/event-stream/.test(String(req.headers.accept || ''))) {
                res.writeHead(406); res.end('Accept: text/event-stream required'); return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                'Connection': 'keep-alive', 'Mcp-Session-Id': headerSession });
            res.flushHeaders?.();
            const previous = this._sessions.get(headerSession);
            if (previous && previous !== res && !previous.destroyed) previous.end();
            this._sessions.set(headerSession, res);
            known.lastSeen = Date.now();
            req.on('close', () => {
                if (this._sessions.get(headerSession) === res) this._sessions.delete(headerSession);
                const s = this._httpSessions.get(headerSession);
                if (s) s.lastSeen = Date.now();
            });
            return;
        }
        if (req.method === 'DELETE') {
            if (!known) return this._jsonRpcHttpError(res, 404, -32001, 'Unknown or expired MCP session');
            this._endSession(headerSession, 'MCP client ended the session');
            res.writeHead(200); res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'GET, POST, DELETE' }); res.end(); return;
        }
        const pv = req.headers['mcp-protocol-version'];
        if (pv && !MCP_PROTOCOL_VERSIONS.includes(pv)) {
            return this._jsonRpcHttpError(res, 400, -32600, `Unsupported MCP-Protocol-Version: ${pv}`);
        }

        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > 16 * 1024 * 1024) req.destroy();
        });
        req.on('end', async () => {
            let msg;
            try { msg = JSON.parse(body); } catch {
                return this._jsonRpcHttpError(res, 400, -32700, 'Parse error');
            }
            if (Array.isArray(msg)) {
                return this._jsonRpcHttpError(res, 400, -32600, 'JSON-RPC batches are not supported');
            }
            if (!msg || typeof msg !== 'object') {
                return this._jsonRpcHttpError(res, 400, -32600, 'Invalid Request');
            }

            let sessionId = headerSession;
            if (msg.method === 'initialize') {
                sessionId = crypto.randomUUID();
                const requestedProfile = url.pathname === '/mcp/economy'
                    ? 'economy' : url.searchParams.get('profile');
                const profile = MCP_PROFILES.has(requestedProfile) ? requestedProfile : this._profile;
                this._openSession(sessionId, profile, 'streamable-http');
                this._httpSessions.set(sessionId, { lastSeen: Date.now() });
                this._startHttpSessionSweep();
            } else if (!headerSession) {
                return this._jsonRpcHttpError(res, 400, -32000, 'Mcp-Session-Id header required', msg.id ?? null);
            } else if (!known) {
                return this._jsonRpcHttpError(res, 404, -32001, 'Unknown or expired MCP session', msg.id ?? null);
            } else {
                known.lastSeen = Date.now();
            }

            // Notifications and client responses: accepted, no body.
            if (msg.id == null || typeof msg.method !== 'string') {
                res.writeHead(202); res.end();
                await this._processMessage(msg, sessionId);
                return;
            }
            // A dropped connection is NOT a cancellation on this transport (spec);
            // the client sends notifications/cancelled when it means one.
            const response = await this._processMessage(msg, sessionId);
            const s = this._httpSessions.get(sessionId);
            if (s) s.lastSeen = Date.now();
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
            res.end(JSON.stringify(response));
        });
    }

    /** Streamable HTTP sessions have no connection to close; expire idle ones. */
    _startHttpSessionSweep() {
        if (this._httpSessionSweep) return;
        this._httpSessionSweep = setInterval(() => {
            const now = Date.now();
            for (const [sessionId, s] of this._httpSessions) {
                const streaming = this._sessions.get(sessionId) && !this._sessions.get(sessionId).destroyed;
                const busy = [...this._operations.values()].some(op => op?.sessionId === sessionId);
                if (!streaming && !busy && now - s.lastSeen > HTTP_SESSION_IDLE_MS) {
                    this._endSession(sessionId, 'MCP session expired');
                }
            }
        }, 5 * 60 * 1000);
        this._httpSessionSweep.unref?.();
    }

    _sendSSE(sse, data) {
        if (!sse || sse.destroyed) return;
        sse.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
    }

    _toolErrorResult(error, toolName) {
        const message = String(error?.message || error || 'Unknown error');
        return {
            content: [{ type: 'text', text: `Error: ${message}` }], isError: true,
            structuredContent: {
                ok: false, state: 'failed', code: error?.code || 'tool-error', message,
                retryable: !/invalid|unknown tool|missing|required/i.test(message),
                tool: toolName || null, warnings: [], nextAction: 'none',
            },
        };
    }

    /** wolfbook_tools {action:"call", name, arguments} → the plain tools/call it stands for. */
    _unwrapToolsCall(params) {
        const args = params?.arguments;
        if (params?.name !== 'wolfbook_tools' || !args || args.action !== 'call') return params;
        const target = String(args.name || '').trim();
        if (!target || target === 'wolfbook_tools') return params;   // handled as an error below
        const inner = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
        return { ...params, name: target, arguments: inner };
    }

    _handleToolsTool(args, sessionId) {
        const action = args.action || 'list';
        const ex = this._exposureFor(sessionId);
        const state = { families: ex.families, context: this._docContext() };
        const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
        if (action === 'list') {
            return text('Tool families (core tools are always listed; call wolfbook_tools with action="enable" to add a family):\n' +
                exposure.catalogue(this._schemas, state));
        }
        if (action === 'call') {
            return text('action="call" needs name (a tool other than wolfbook_tools) and optional arguments.', true);
        }
        if (action !== 'enable' && action !== 'disable') return text(`Unknown action "${action}". Use list, enable, disable or call.`, true);
        const req = exposure.resolveRequest(this._schemas, args.families, args.tools);
        if (!req.families.length && !req.tools.length) {
            return text(`Nothing to ${action}.` + (req.unknown.length ? ` Unknown: ${req.unknown.join(', ')}.` : '') +
                ' Call wolfbook_tools with action="list" for the family ids.', true);
        }
        for (const fam of req.families) ex.families[action === 'enable' ? 'add' : 'delete'](fam);
        for (const tool of req.tools) ex.tools[action === 'enable' ? 'add' : 'delete'](tool);
        const clientName = this._sessionClientNames.get(sessionId);
        if (clientName) this._exposureByClient.set(clientName, { families: [...ex.families], tools: [...ex.tools], ts: Date.now() });
        this._notifyToolsChanged(sessionId);
        const lines = [`${action === 'enable' ? 'Enabled' : 'Disabled'}: ${[...req.families, ...req.tools].join(', ')}.`];
        if (req.unknown.length) lines.push(`Unknown (ignored): ${req.unknown.join(', ')}.`);
        if (action === 'enable') {
            const names = new Set(req.tools);
            for (const t of this._schemas) if (req.families.includes(exposure.familyOf(t))) names.add(t.name);
            const briefs = this._schemas.filter(t => names.has(t.name) && !exposure.REMOVED_TOOLS[t.name]).map(exposure.brief);
            if (briefs.length) lines.push('', ...briefs);
            lines.push('', 'Your tool list was refreshed. If these tools do not appear, call them through wolfbook_tools {action:"call", name, arguments}.');
        }
        return text(lines.join('\n'));
    }

    /** list_clients without the 10 KB of repetition: kernels carry counts, not the paths again. */
    _compactClientList() {
        const drop = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) =>
            v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
        return this._buildClientList().map(c => drop({
            clientId: c.clientId, role: c.role, workspace: c.workspace,
            notebooks: [...new Set(c.notebooks || [])],
            paperFiles: [...new Set(c.paperFiles || [])],
            slideFiles: [...new Set(c.slideFiles || [])],
            kernels: (c.kernels || []).map(k => drop({
                kernel_id: k.kernel_id, label: k.kernel_label, default: k.is_default || undefined,
                lifecycle: k.lifecycle, busy: k.busy || undefined,
                notebooks: (k.notebooks || []).length,
                active_operation: k.active_operation ? { id: k.active_operation.operationId, caption: k.active_operation.caption, elapsedMs: k.active_operation.elapsedMs } : undefined,
                agents: (k.attached_agents || []).map(a => a.agent_name),
            })),
        }));
    }

    _finalizeToolResult(input, toolName, sessionId) {
        let result = this._boundResult(input || { content: [] }, toolName, null, sessionId);
        const texts = (result.content || []).filter(part => part?.type === 'text').map(part => String(part.text || ''));
        const joined = texts.join('\n').trim();
        let parsed = null;
        if (texts.length >= 1 && /^\s*[\[{]/.test(texts[0])) {
            try { parsed = JSON.parse(texts[0]); } catch (_) {}
        }
        const existing = result.structuredContent && typeof result.structuredContent === 'object'
            ? result.structuredContent : {};
        const target = existing.target || result._wolfbookTarget || null;
        const EVAL_TOOLS = /^wolfbook_(evaluateExpression|insertCells|editCell|runCell|runCells|newNotebook)$/;
        const textFailure = !parsed && !EVAL_TOOLS.test(toolName || '') &&
            /^(?:error\b|❌|unknown (?:operation_id|client|tool|kernel)|missing (?:operation_id|required)|no (?:notebook|kernel) (?:is |could|found))/i.test(joined);
        const failed = !!result.isError || parsed?.ok === false || parsed?.error != null || textFailure;
        const state = parsed?.state || existing.state || (failed ? 'failed' : 'completed');
        const code = parsed?.code || existing.code || (failed ? 'tool-error' : 'ok');
        const firstLine = joined.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').trim() || '';
        const message = parsed?.message || existing.message ||
            (parsed?.result_handle ? `Result was bounded; retrieve ${parsed.result_handle} for additional content.` : '') ||
            (typeof parsed?.error === 'string' ? parsed.error : '') ||
            firstLine.slice(0, 300) || `${toolName || 'Tool'} ${failed ? 'failed' : 'completed'}.`;
        const textOperationId = /Operation ID:\s*([0-9a-f-]{36})/i.exec(joined)?.[1] || null;
        const operationId = parsed?.operation_id || parsed?.operationId || parsed?.evaluation?.operation_id ||
            existing.operation?.id || textOperationId || null;
        const resultHandle = parsed?.result_handle || existing.result?.handle ||
            (/\b(?:output|result) truncated\b/i.test(joined) ? operationId : null);
        const nextAction = parsed?.next_action || parsed?.nextAction || existing.nextAction ||
            (['pending', 'running', 'running-background'].includes(state) ? 'wait' : resultHandle ? 'getResult' : 'none');
        const envelope = {
            ok: !failed, state, code, message, tool: toolName || null,
            // A plain-text body used to exist ONLY in content[]. Claude Code shows
            // the model structuredContent when present, so it saw just the first
            // line (status, notebook lists, getNotebookContext read …).
            ...(!parsed && joined && joined !== message ? { text: joined } : {}),
            target,
            notebookRevision: parsed?.notebook_revision ?? parsed?.current_notebook_revision ?? existing.notebookRevision ?? null,
            cells: parsed?.cells || parsed?.edit?.deleted || existing.cells || [],
            operation: operationId ? { id: operationId, state } : (existing.operation || null),
            result: resultHandle ? { handle: resultHandle, summary: parsed?.summary || null } : (existing.result || null),
            warnings: existing.warnings || parsed?.warnings || [], nextAction,
            retryable: parsed?.retryable ?? existing.retryable ?? null,
            remedy: parsed?.remedy || existing.remedy || null,
            ...(parsed ? { data: parsed } : existing.data !== undefined ? { data: existing.data } : {}),
        };
        // Drop empty fields: every call paid ~200 bytes of nulls and [].
        for (const [k, v] of Object.entries(envelope)) {
            if (v === null || v === undefined || (Array.isArray(v) && v.length === 0) ||
                (k === 'nextAction' && v === 'none')) delete envelope[k];
        }
        // JSON results: the text channel carries the same envelope, compact (MCP:
        // "SHOULD also return the serialized JSON in a TextContent block"). It used to
        // carry only the message line, so text-reading clients lost the data.
        if (parsed) result = { ...result, content: [
            { type: 'text', text: JSON.stringify(envelope) }, ...(result.content || []).filter(part => part?.type !== 'text')
        ] };
        delete result._wolfbookTarget;
        return { ...result, isError: failed, structuredContent: envelope };
    }

    // ── MCP method dispatch ────────────────────────────────────────────────
    async _dispatch(method, params, sessionId = 'mcp') {
        switch (method) {
            case 'initialize': {
                const clientName = params?.clientInfo?.name;
                const profile = this._sessionProfiles.get(sessionId) || this._profile;
                if (clientName) {
                    this._sessionClientNames.set(sessionId, String(clientName));
                    const kept = this._exposureByClient.get(String(clientName));
                    if (kept && Date.now() - kept.ts < 60 * 60 * 1000) {
                        this._sessionExposure.set(sessionId, { families: new Set(kept.families), tools: new Set(kept.tools) });
                    }
                }
                this._activity?.record({ type: 'agent.initialized', source: 'mcp', agentSessionId: sessionId,
                    agentName: clientName || null, state: 'running', payload: this._hostActivityPayload({ clientInfo: params?.clientInfo || null, protocolVersion: params?.protocolVersion || null, profile }) });
                if (clientName && this._onNewClient && !this._announcedClients.has(String(clientName))) {
                    this._announcedClients.add(String(clientName));
                    try { this._onNewClient(String(clientName)); } catch (_) {}
                }
                const protocolVersion = negotiateProtocolVersion(params?.protocolVersion);
                this._sessionProtocol.set(sessionId, protocolVersion);
                const serverInfo = { name: profile === 'economy' ? 'wolfbook-economy' : 'wolfbook', version: _serverVersion };
                if (protocolVersion >= '2025-06-18') serverInfo.title = 'Wolfbook';
                return {
                    protocolVersion,
                    capabilities:    { tools: { listChanged: true } },
                    serverInfo,
                    instructions:    profile === 'economy' ? MCP_ECONOMY_INSTRUCTIONS : MCP_SERVER_INSTRUCTIONS,
                };
            }

            case 'ping':
                return {};

            case 'tools/list': {
                const profile = this._sessionProfiles.get(sessionId) || this._profile;
                const protocol = this._sessionProtocol.get(sessionId) || '2024-11-05';
                // Routing parameters. client_id routes any tool to a window; kernel_id
                // only means something to kernel-scoped tools. They used to be injected
                // into all 80 tools with ~180-char descriptions: 30.8 KB, 22 % of the
                // whole tools/list payload (audit 2026-09-25).
                const CLIENT_ID_PARAM = {
                    type: 'string',
                    description: profile === 'economy' ? 'Optional target window ID.' :
                        'Target window (see wolfbook_list_clients). Omit to route by notebook or session target.',
                };
                const KERNEL_ID_PARAM = {
                    type: 'string',
                    description: profile === 'economy' ? 'Optional kernel binding assertion.' :
                        'Kernel ID assertion; a changed binding is rejected.',
                };
                const wantsKernelId = name => /^wolfbook_/.test(name) || /^wolfslide_(insert|run)EvalBlock$/.test(name);
                const injectRouting = (name, schema) => {
                    if (!schema || schema.type !== 'object') return schema;
                    return { ...schema, properties: { ...schema.properties, client_id: CLIENT_ID_PARAM,
                        ...(wantsKernelId(name) ? { kernel_id: KERNEL_ID_PARAM } : {}) } };
                };
                const listed = t => this._listedFor(t, sessionId, profile);
                const tools = this._schemas
                    .filter(t => !Object.prototype.hasOwnProperty.call(exposure.SYNTHETIC_FAMILY, t.name))
                    .filter(listed)
                    .map(t => profile === 'economy' && ECONOMY_TOOL_NAMES.has(t.name) ? _economyToolSchema(t) : t)
                    .map(({ tags, title, ...t }) => ({
                        ...t,
                        ...(title && protocol >= '2025-06-18' ? { title } : {}),
                        description: this._describeTool({ ...t, tags }),
                        inputSchema: injectRouting(t.name, t.inputSchema),
                    }));
                // Synthetic tools — not in _tools map, handled in tools/call
                tools.push({
                    name: 'wolfbook_list_clients',
                    description: profile === 'economy' ?
                        'List connected Wolfbook windows, notebooks, kernels, and current targets.' :
                        'List all connected Wolfbook clients (VS Code / Antigravity windows). ' +
                        'Returns each client ID, its role (primary/worker), open notebooks, ' +
                        'and workspace name. Use this to pick the right client_id before ' +
                        'targeting a specific window.',
                    inputSchema: { type: 'object', properties: {}, required: [] },
                });
                tools.push({
                    name: 'wolfbook_setTarget',
                    description: profile === 'economy' ?
                        'Set or clear the default window, notebook, and kernel for this session.' :
                        'Set (or clear) the session target: the default client and notebook that ' +
                        'all subsequent tool calls are routed to automatically. Once set, you do ' +
                        'not need to pass client_id or notebook on every call — they are injected ' +
                        'automatically. The active [Target] is shown at the bottom of each response. ' +
                        'Omit both client_id and notebook to clear the target. ' +
                        'Use force:true to evict a stale lock held by a dead session.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            client_id: { type: 'string', description: profile === 'economy' ? 'Window ID from list_clients.' : 'Client to target (from wolfbook_list_clients). Omit to target own window.' },
                            notebook:  { type: 'string', description: profile === 'economy' ? 'Notebook path or filename.' : 'Notebook filename to switch to and target (e.g. "proto2.wb"). Omit to leave notebook selection unchanged.' },
                            kernel_id: { type: 'string', description: profile === 'economy' ? 'Optional kernel ID.' : 'Optional kernel binding assertion from wolfbook_list_clients.' },
                            force:     { type: 'boolean', description: profile === 'economy' ? 'Evict a stale target lock.' : 'If true, evict any existing session lock on this notebook and claim it for this session. Use when wolfbook_list_clients shows a stale lock from a dead session.' },
                        },
                        required: [],
                    },
                });
                tools.push({
                    name: 'wolfbook_waitEvaluation',
                    description: profile === 'economy' ?
                        'Wait again for a long-running operation and return its result.' :
                        'Continue waiting for a Wolfbook operation that was still running after ' +
                        'the five-minute MCP response window. Pass the operation_id returned by ' +
                        'the earlier call. Waits for up to another five minutes and returns the ' +
                        'original result. To stop it, call wolfbook_kernelControl with action="abort".',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            operation_id: {
                                type: 'string',
                                description: profile === 'economy' ? 'Long-running operation ID.' : 'Operation ID returned by a long-running Wolfbook call.',
                            },
                            client_id: CLIENT_ID_PARAM,
                            kernel_id: KERNEL_ID_PARAM,
                        },
                        required: ['operation_id'],
                    },
                });
                tools.push({
                    name: 'wolfbook_tools',
                    description: 'Reveal rarely used Wolfbook tools on demand. action="list" shows the tool families ' +
                        '(slides/paper extras, debugging, literature search, ask-the-user, Oberon) and which are on; ' +
                        '"enable"/"disable" add or remove families or single tools from your tool list; ' +
                        '"call" runs any listed-or-hidden tool by name — use it if your client does not refresh its tool list.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['list', 'enable', 'disable', 'call'], description: 'Default list.' },
                            families: { type: 'array', items: { type: 'string' }, description: 'Family ids for enable/disable, from action="list".' },
                            tools: { type: 'array', items: { type: 'string' }, description: 'Single tool names for enable/disable.' },
                            name: { type: 'string', description: 'Tool to run (action="call").' },
                            arguments: { type: 'object', description: 'Arguments for the tool (action="call").' },
                        },
                        required: [],
                    },
                });
                // Families apply to synthetic tools only under auto; the legacy profiles
                // always listed all of them, and still do.
                const visibleTools = tools.filter(t => !Object.prototype.hasOwnProperty.call(exposure.SYNTHETIC_FAMILY, t.name) ||
                    profile !== 'auto' || listed({ name: t.name, tags: [] }));
                // Tool annotations exist from 2025-03-26; an older client gets exactly the old list.
                if (protocol >= '2025-03-26') {
                    for (const t of visibleTools) {
                        const annotations = toolAnnotations(t.name);
                        if (annotations) t.annotations = annotations;
                    }
                }
                return { tools: visibleTools };
            }

            case 'tools/call': {
                params = this._unwrapToolsCall(params);
                const { name, arguments: rawArgs } = params;

                if (exposure.REMOVED_TOOLS[name]) {
                    return { content: [{ type: 'text', text: `${name}: ${exposure.REMOVED_TOOLS[name]}` }], isError: true };
                }
                if (name === 'wolfbook_tools') return this._handleToolsTool(rawArgs || {}, sessionId);

                // ── Synthetic: wolfbook_list_clients ────────────────────────
                if (name === 'wolfbook_list_clients') {
                    const clients = rawArgs?.detail === true ? this._buildClientList() : this._compactClientList();
                    return { content: [{ type: 'text', text: `${clients.length} Wolfbook window${clients.length === 1 ? '' : 's'} connected.` }],
                        structuredContent: { ok: true, state: 'completed', code: 'ok', message: 'Connected Wolfbook windows.', data: { clients } },
                        isError: false };
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
                        const clients = this._buildClientList();
                        return { content: [{ type: 'text', text: `${clients.length} Wolfbook window${clients.length === 1 ? '' : 's'} connected.` }],
                            structuredContent: { ok: true, state: 'completed', code: 'ok',
                                message: 'Connected Wolfbook windows.', data: { clients } }, isError: false };
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
                if (name.startsWith('paper_')) return this._dispatchPaper(name, args, sessionId);
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
                let explicitNotebookResolvedLocal = false;
                if (!sessionTarget && !targetClientId) {
                    sessionTarget = this._adoptLastTarget(sessionId);
                }
                // An explicitly named notebook outranks sticky session state.
                // This lets one agent safely work across notebooks without a
                // setTarget round trip or a hidden target mutation.
                if (!targetClientId && rawArgs && Object.prototype.hasOwnProperty.call(rawArgs, 'notebook') && args.notebook) {
                    const matches = this._findClientsByNotebook(args.notebook);
                    if (matches.length > 1) {
                        return { content: [{ type: 'text', text: JSON.stringify({
                            ok: false, state: 'conflict', code: 'ambiguous-notebook', notebook: args.notebook,
                            candidates: matches.map(match => ({ client_id: match.clientId, notebook: match.notebook })),
                            remedy: 'Pass an absolute notebook path or an explicit client_id.'
                        }) }], isError: true };
                    }
                    if (matches.length === 1) {
                        const match = matches[0];
                        args.notebook = match.notebook;
                        if (match.clientId !== this._ownClientId) {
                            const worker = this._workers.get(match.clientId);
                            if (worker) {
                                const routed = await this._invokeWorker(worker.port, name, args);
                                return this._appendTargetFooter(routed, {
                                    clientId: match.clientId, notebook: match.notebook,
                                    kernelId: args.kernel_id || null,
                                }, 'explicit notebook');
                            }
                        } else {
                            sessionTarget = null;
                            explicitNotebookResolvedLocal = true;
                        }
                    } else if (matches.length === 0) {
                        return { content: [{ type: 'text', text: JSON.stringify({
                            ok: false, state: 'failed', code: 'notebook-not-open', notebook: args.notebook,
                            retryable: true, remedy: 'Open the notebook with wolfbook_newNotebook, or pass a notebook reported by wolfbook_status.'
                        }) }], isError: true };
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
                if (!targetClientId && !sessionTarget && !explicitNotebookResolvedLocal && this._workers.size > 0) {
                    // Name the actual candidates and emit a call that resolves
                    // this. Field report #2 §4c: the generic message cost 2-3
                    // calls to diagnose each time it appeared, because it
                    // restated the problem and gave an example with a client id
                    // that does not exist in this session.
                    const rows = [];
                    for (const [cid, w] of this._workers.entries()) {
                        const docs = (w.notebooks || []).map(p => p.split(/[\\/]/).pop());
                        rows.push(`  client_id: "${cid}"${docs.length ? `  open: ${docs.join(', ')}` : '  (no notebooks open)'}`);
                    }
                    const first = [...this._workers.entries()][0];
                    const firstDoc = (first?.[1]?.notebooks || [])[0];
                    const suggestion = first
                        ? `wolfbook_setTarget(client_id: "${first[0]}"` +
                          (firstDoc ? `, notebook: "${firstDoc.split(/[\\/]/).pop()}"` : '') + ')'
                        : 'wolfbook_setTarget(client_id: "…")';
                    return {
                        content: [{ type: 'text', text:
                            `No session target set, and ${this._workers.size} other window(s) are connected — ` +
                            'refusing to guess which one you mean.\n\n' +
                            'Connected clients:\n' + rows.join('\n') + '\n\n' +
                            'This call sets the target:\n  ' + suggestion + '\n\n' +
                            'A target set this way survives SSE reconnects for 60 minutes. ' +
                            'Note that .wslide decks are not listed above — they are not registered ' +
                            'cross-window — so for a slide deck pick the client by its notebooks or workspace.'
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

    async _runManagedToolCall(params, sessionId, requestId = null) {
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
        const inline = this._inlineWaitFor(params, sessionId);
        // operationStatus must answer about the QUERIED id inside the inline
        // window — otherwise the status call itself outlives it and comes back
        // as a fresh handle of its own (it used to, every time).
        const clampedWait = params?.name === 'wolfbook_operationStatus' && Number(params?.arguments?.wait_seconds) > 0
            ? { wait_seconds: Math.max(0, Math.min(Number(params.arguments.wait_seconds), Math.floor((inline.waitMs - 2000) / 1000))) }
            : {};
        const dispatchedParams = {
            ...params,
            arguments: {
                ...(params?.arguments || {}), _operationId: operationId, ...clampedWait,
                _activityContext: activityContext,
                ...(this._canonicalProjection && params?.name === 'wolfbook_getNotebookContext' &&
                    params?.arguments?.brief !== true && !['brief', 'summary'].includes(params?.arguments?.action)
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
        operation.background = isBackground;
        operation.requestId = requestId;
        if (requestId != null) this._requestOperations.set(this._requestKey(sessionId, requestId), operationId);
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
                // The tools/call is terminal once background work is accepted;
                // the execution operation emits its own continuing lifecycle.
                const terminalType = isError ? 'tool.failed' : 'tool.completed';
                const terminalState = isError ? 'failed' : (isBackground ? 'accepted' : 'completed');
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

        const settled = await this._waitForOperation(operation, inline.waitMs);
        if (settled) {
            this._forgetOperation(operationId);
            if (operation.status === 'rejected') throw operation.error;
            return this._boundResult(operation.result, params?.name, operation.kernelId, sessionId);
        }

        this._renewOperationLease(operation);
        return this._operationStillRunningResult(operation, inline.note);
    }

    /** Reconnected client (same clientInfo.name): adopt its last declared
     *  target (≤60 min old) instead of erroring. Only a RECONNECT adopts — the
     *  session that set the target must have ended. clientInfo.name is per
     *  product, not per agent (every Claude Code session is "claude-code"), so a
     *  second live session in another workspace used to inherit the first one's
     *  notebook and kernel without being told. */
    _adoptLastTarget(sessionId) {
        const clientName = this._sessionClientNames.get(sessionId);
        const last = clientName ? this._lastTargetByClient.get(clientName) : null;
        if (!last || Date.now() - last.ts >= 3600000) return null;
        if (last.sessionId && last.sessionId !== sessionId && this._sessionConnectedAt.has(last.sessionId)) return null;
        const target = { ...last.target, _adopted: true };
        this._sessionTargets.set(sessionId, target);
        last.sessionId = sessionId;   // one reconnect adopts it, not every newcomer
        return target;
    }

    /** How long to hold a tools/call inline before answering with a handle.
     *  Returns { waitMs, cap, note } — note is set when the request asked for
     *  longer than this client can be kept waiting. */
    _inlineWaitFor(params, sessionId) {
        const args = params?.arguments || {};
        const clientName = this._sessionClientNames.get(sessionId) || '';
        const cap = LONG_WAIT_CLIENTS.test(clientName)
            ? OPERATION_EXPLICIT_WAIT_LONG_MS : OPERATION_EXPLICIT_WAIT_MAX_MS;
        let requestedMs = 0;
        if (params?.name === 'wolfbook_evaluateExpression' && args.wait_mode !== 'async') {
            // +2 s: the tool's own TimeConstrained answer must beat the handle.
            requestedMs = (Number(args.timeoutSeconds) || 30) * 1000 + 2000;
        } else if (params?.name === 'wolfbook_operationStatus' && Number(args.wait_seconds) > 0) {
            requestedMs = Math.min(300, Number(args.wait_seconds)) * 1000 + 2000;
        }
        if (requestedMs <= this._operationFastWaitMs) return { waitMs: this._operationFastWaitMs, cap, note: null };
        const waitMs = Math.min(requestedMs, cap);
        const note = requestedMs > cap
            ? `The inline wait is capped at ${Math.round(cap / 1000)} s for this MCP client ` +
              `(${clientName || 'unknown client'}) so the call returns before the client's own request timeout; ` +
              'the evaluation itself keeps its full timeoutSeconds.'
            : null;
        return { waitMs, cap, note };
    }

    _boundResult(result, toolName, kernelId = null, sessionId = null) {
        if (!this._boundedResults || toolName === 'wolfbook_getResult' || !result?.content) return result;
        const threshold = (this._sessionProfiles.get(sessionId) || this._profile) === 'economy'
            ? Math.min(4096, this._resultThreshold) : this._resultThreshold;
        let changed = false;
        const content = result.content.map(part => {
            if (part?.type !== 'text' || String(part.text || '').length <= threshold) return part;
            changed = true;
            const raw = String(part.text);
            let format = 'text';
            try { JSON.parse(raw); format = 'json'; } catch (_) {}
            const envelope = this._resultStore.envelope(
                raw, Math.min(4000, threshold), format,
                { kernel_id: kernelId, tool: toolName, structural_summary: structuralSummary(raw, format) }
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
        return this._boundResult(operation.result, operation.name, operation.kernelId, sessionId);
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
        // IDs this server issued for a call still running past the response window
        // live HERE, not in any kernel registry. operationStatus used to probe only
        // the kernels and answered "Unknown operation_id" for them.
        const transportOp = this._operations.get(operationId);
        if (transportOp) {
            this._renewOperationLease(transportOp);
            const settled = await this._waitForOperation(transportOp, waitSeconds * 1000);
            if (!settled) return this._operationStillRunningResult(transportOp);
            this._forgetOperation(operationId);
            if (transportOp.status === 'rejected') throw transportOp.error;
            return this._boundResult(transportOp.result, transportOp.name, transportOp.kernelId, sessionId);
        }
        this._pruneWorkers();

        const target = targetClientId || this._sessionTargets.get(sessionId)?.clientId;
        if (target && target !== this._ownClientId) {
            const worker = this._workers.get(target);
            if (worker) {
                const direct = await this._invokeWorker(worker.port, 'wolfbook_operationStatus', {
                    operation_id: operationId, include_progress: includeProgress, wait_seconds: waitSeconds, kernel_id: kernelId
                }).catch(err => ({ content: [{ type: 'text', text: `Unknown operation_id (${err.message})` }], isError: true }));
                // A miss in the named window falls through to probing every window:
                // the UUID is the capability, not the window it was guessed to be in.
                if (!this._isUnknownOperationResult(direct)) return direct;
            }
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

    _operationStillRunningResult(operation, note = null) {
        const elapsed = Math.max(1, Math.round((Date.now() - (operation.startedAt || Date.now())) / 1000));
        return {
            content: [{ type: 'text', text:
                `Operation is still running after ${elapsed} seconds. It has not been aborted.\n\n` +
                (note ? `${note}\n\n` : '') +
                `Operation ID: ${operation.id}\n\n` +
                'Choose one:\n' +
                `- Continue: call wolfbook_operationStatus with operation_id="${operation.id}" and wait_seconds=300.\n` +
                '- Stop: call wolfbook_kernelControl with action="abort".\n\n' +
                'The operation remains discoverable in the execution journal even if the transport waiter expires.'
            }],
            structuredContent: { ok: true, state: 'running', code: 'operation-running',
                message: 'Operation is still running.', operation: { id: operation.id, state: 'running' },
                nextAction: 'wait' },
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
        if (operation?.requestId != null) {
            this._requestOperations.delete(this._requestKey(operation.sessionId, operation.requestId));
        }
    }

    _requestKey(sessionId, requestId) {
        return `${sessionId}:${typeof requestId}:${String(requestId)}`;
    }

    async _cancelManagedRequest(sessionId, requestId, reason = 'MCP client cancelled request') {
        if (requestId == null) return false;
        const operationId = this._requestOperations.get(this._requestKey(sessionId, requestId));
        const operation = operationId ? this._operations.get(operationId) : null;
        if (!operation || operation.background || operation.cancelRequested || operation.status !== 'pending') return false;
        operation.cancelRequested = true;
        const target = operation.params?.arguments?._activityContext?.clientId ||
            this._sessionTargets.get(sessionId)?.clientId || null;
        const args = {
            operation_id: operation.id, mode: 'abort', reason,
            ...(target ? { client_id: target } : {}),
            ...(operation.kernelId ? { kernel_id: operation.kernelId } : {}),
        };
        try {
            const result = await this._dispatch('tools/call', {
                name: 'wolfbook_cancelOperation', arguments: args,
            }, sessionId);
            this._activity?.record({ type: 'tool.cancelled', source: 'mcp', traceId: operation.id,
                operationId: operation.id, agentSessionId: sessionId, state: 'cancelled',
                payload: this._hostActivityPayload({ tool: operation.name, reason }) });
            return result;
        } catch (error) {
            operation.cancelRequested = false;
            this._activity?.record({ type: 'tool.cancel.failed', source: 'mcp', traceId: operation.id,
                operationId: operation.id, agentSessionId: sessionId, state: 'failed',
                payload: this._hostActivityPayload({ tool: operation.name, reason, error: error?.message || String(error) }) });
            return false;
        }
    }

    async _cancelSessionOperations(sessionId, reason) {
        const pending = [...this._operations.values()].filter(operation =>
            operation.sessionId === sessionId && operation.status === 'pending' && !operation.background);
        await Promise.allSettled(pending.map(operation =>
            this._cancelManagedRequest(sessionId, operation.requestId, reason)));
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
        const resolvedClientId = clientId || this._ownClientId || null;
        const binding = this._resolveNotebookKernel(resolvedClientId, notebook);
        const target = { clientId: resolvedClientId, notebook, kernelId: binding?.kernel_id || null, ts: Date.now() };
        this._sessionTargets.set(sessionId, target);
        const clientName = this._sessionClientNames.get(sessionId);
        if (clientName) this._lastTargetByClient.set(clientName, { target, ts: Date.now(), sessionId });
        this._recordSessionTarget(sessionId, target, 'new-notebook');
        return target;
    }

    /** Handle wolfbook_setTarget: validate, check conflicts, then persist per-session target. */
    _handleSetTarget(args, sessionId = 'mcp') {
        this._pruneWorkers();
        const previousTarget = this._sessionTargets.get(sessionId) || null;
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
                        const age = this._lockAgeLabel(sid, t);
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
        if (clientName) this._lastTargetByClient.set(clientName, { target: targetRecord, ts: Date.now(), sessionId });
        this._recordSessionTarget(sessionId, targetRecord, 'explicit');
        const switchedNotebook = targetNb && (
            !previousTarget ||
            String(previousTarget.notebook || '').toLowerCase() !== targetNb.toLowerCase() ||
            (previousTarget.clientId || this._ownClientId) !== resolvedClientId
        );
        if (switchedNotebook) this._notifyNotebookTarget(resolvedClientId, targetNb, 'switched');

        const parts = [];
        if (targetNb)  parts.push(`notebook: **${targetNb}**`);
        if (resolvedClientId) parts.push(`client: **${resolvedClientId}**`);
        if (kernelId) parts.push(`kernel: **${binding.kernel_label} · ${kernelId}**`);
        const sharing = this._kernelSessionInfo(resolvedClientId, kernelId, sessionId);
        const warning = sharing.count
            ? `\n\n⚠ This kernel is also attached to ${sharing.count} other active agent session${sharing.count === 1 ? '' : 's'} (${sharing.labels.join(', ')}). Work will share definitions and a serial evaluation queue. Create and bind a private kernel to isolate this session.`
            : '';
        return {
            content: [{ type: 'text', text:
                `Session target set — ${parts.join(', ')}. All subsequent tool calls will auto-route there.\n\n` +
                JSON.stringify({ client_id: resolvedClientId, notebook: targetNb, kernel_id: kernelId,
                    attached_sessions: sharing.count + 1 }, null, 2) + warning
            }],
            structuredContent: { ok: true, state: 'completed', code: 'target-set',
                message: 'Session target set.', target: { clientId: resolvedClientId,
                    notebook: targetNb, kernelId, via: 'explicit' },
                data: { attached_sessions: sharing.count + 1, other_agents: sharing.agents },
                warnings: sharing.count ? ['This kernel is shared with other active agent sessions.'] : [],
                nextAction: 'none' },
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
        const sharing = this._kernelSessionInfo(clientId, kernelId, null);
        const warning = sharing.count > 1
            ? `\n⚠ *Shared kernel: ${sharing.count} active agent sessions are attached.*`
            : '';
        const footer = `\n\n└ *Target: ${label}${via ? ` · via: ${via}` : ''}*${warning}`;
        if (result?.content?.[0]?.type === 'text') {
            return {
                ...result,
                _wolfbookTarget: { clientId: clientId || null, notebook: notebook || null,
                    kernelId: kernelId || null, via: via || null, sharedSessions: sharing.count },
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
                    ...auth.authHeaders(),
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

    _findClientsByNotebook(notebook) {
        const normalize = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const base = value => normalize(value).split('/').pop();
        const wanted = normalize(notebook);
        const clients = this._buildClientList();
        let matches = [];
        for (const client of clients) {
            for (const candidate of client.notebooks || []) {
                if (normalize(candidate) === wanted) matches.push({ clientId: client.clientId, notebook: candidate });
            }
        }
        if (matches.length) return matches;
        for (const client of clients) {
            for (const candidate of client.notebooks || []) {
                if (base(candidate) === base(wanted)) matches.push({ clientId: client.clientId, notebook: candidate });
            }
        }
        return matches;
    }

    async _dispatchPaper(name, args) {
        const started = Date.now();
        const { paperWindowInfo, selectPaperClient } = require('./paper-routing');
        this._pruneWorkers();
        const clients = [
            { clientId: this._ownClientId, ...paperWindowInfo() },
            ...[...this._workers].map(([clientId, w]) => ({ clientId, ...w })),
        ].filter(c => c.clientId);
        const fail = (code, extra = {}) => {
            const data = { ok: false, code, ...extra };
            return { isError: true, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
        };
        // Ownership is routing metadata only. Actual hashes/buffer versions
        // remain guarded by the transaction store in the owning extension host.
        this._paperOwners ||= new Map();
        for (const [id, entry] of this._paperOwners) if (Date.now() - entry.at > 3600000) this._paperOwners.delete(id);
        const token = args.transaction_id || args.undo_token;
        const owner = token && this._paperOwners.get(token);
        if (owner && args.client_id && args.client_id !== owner.clientId) {
            return fail('transaction-client-mismatch', { client_id: owner.clientId, remedy: 'Apply through the owning client, or omit client_id.' });
        }
        const selected = selectPaperClient(clients, args.file, owner?.clientId || args.client_id);
        if (selected.length !== 1) return fail(owner ? 'transaction-client-unavailable' : args.client_id ? 'unknown-client' : 'ambiguous-paper-client', {
            candidates: (selected.length ? selected : clients).map(c => ({ client_id: c.clientId, workspaceRoots: c.workspaceRoots || [], paperFiles: c.paperFiles || [] })),
            remedy: 'Pass an explicit client_id and file. No notebook target was used.',
        });
        const client = selected[0];
        delete args.client_id;
        delete args.notebook;
        delete args.kernel_id;
        if (args._activityContext) Object.assign(args._activityContext, {
            clientId: client.clientId, workspace: this._workspaceForClient(client.clientId), notebook: null, kernelId: null,
        });
        const routingMs = Date.now() - started, dispatchStart = Date.now();
        let result;
        if (client.clientId !== this._ownClientId) result = await this._invokeWorker(client.port, name, args);
        else {
            const tool = this._tools.get(name);
            if (!tool) return fail('unknown-paper-tool');
            setMcpCallActive(true);
            try {
                const value = await runWithActivityContext(args._activityContext, () => tool.invoke({ input: args, skipConfirm: true }, {
                    isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
                }));
                result = { isError: false, content: (value?.content || []).map(p => ({ type: 'text', text: String(p.value ?? p.text ?? '') })) };
            } catch (e) { return fail('paper-call-failed', { message: e.message }); }
            finally { setMcpCallActive(false); }
        }
        let data = result.structuredContent;
        if (!data) {
            for (const part of result.content || []) {
                try { data = JSON.parse(part.text); break; } catch (_) { /* plain text */ }
            }
        }
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            for (const id of [data.transaction_id, data.undo_token, data.undoToken].filter(Boolean)) {
                this._paperOwners.set(id, { clientId: client.clientId, at: Date.now() });
            }
            while (this._paperOwners.size > 2000) this._paperOwners.delete(this._paperOwners.keys().next().value);
        }
        const routing = { client_id: client.clientId, file: args.file || null,
            reason: owner ? 'transaction owner' : 'paper file/client',
            timing: { routingMs, dispatchRoundTripMs: Date.now() - dispatchStart } };
        return { ...result, structuredContent: { ...(data && typeof data === 'object' ? data : {}), routing },
            content: [...(result.content || []), { type: 'text', text: JSON.stringify({ routing }) }] };
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
                ...require('./paper-routing').paperWindowInfo(),
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
                workerPort: info.port,
                notebooks: dedupe(info.notebooks),
                paperFiles: info.paperFiles || [],
                workspaceRoots: info.workspaceRoots || [],
                kernels: info.kernels || [],
                pid:       info.pid,
                generation: info.generation || null,
                registeredAt: info.registeredAt || null,
            });
        }
        return list.map(client => ({
            ...client,
            kernels: (client.kernels || []).map(kernel => {
                const sessions = this._kernelSessionInfo(client.clientId, kernel.kernel_id, null);
                return { ...kernel, attached_sessions: sessions.count,
                    attached_session_ids: sessions.sessionIds,
                    attached_agents: sessions.agents,
                    shared_by_multiple_sessions: sessions.count > 1 };
            }),
        }));
    }

    _kernelSessionInfo(clientId, kernelId, excludeSessionId = null) {
        if (!kernelId) return { count: 0, sessionIds: [], labels: [], agents: [] };
        const sessionIds = [];
        const labels = [];
        const agents = [];
        for (const [sessionId, target] of this._sessionTargets) {
            if (sessionId === excludeSessionId || target?.kernelId !== kernelId) continue;
            if (clientId && target.clientId && target.clientId !== clientId) continue;
            sessionIds.push(sessionId);
            labels.push(sessionId === 'copilot' ? 'Copilot' :
                (this._sessionClientNames.get(sessionId) || `session ${sessionId.slice(0, 6)}…`));
            agents.push({ session_id: sessionId,
                agent_name: sessionId === 'copilot' ? 'Copilot' : (this._sessionClientNames.get(sessionId) || null) });
        }
        return { count: sessionIds.length, sessionIds, labels, agents };
    }

    /** Current MCP transports, kept separate from the durable event ledger so
     * interrupted extension hosts cannot leave ghost agents marked active. */
    _buildSessionList() {
        return [...this._sessionConnectedAt.keys()].map(sessionId => {
            const target = this._sessionTargets.get(sessionId) || null;
            return {
                sessionId,
                agentName: this._sessionClientNames.get(sessionId) || null,
                connectedAt: this._sessionConnectedAt.get(sessionId) || null,
                profile: this._sessionProfiles.get(sessionId) || this._profile,
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
    /** " [locked N min ago]" alone read as "stale" for a session that is
     *  working right now — say when its owner last called a tool too. */
    _lockAgeLabel(sid, t) {
        if (!t?.ts) return '';
        const mins = ts => Math.round((Date.now() - ts) / 60000);
        const last = this._sessionLastActive.get(sid);
        return ` [target set ${mins(t.ts)} min ago` +
            (last ? ` · last active ${mins(last) < 1 ? 'just now' : `${mins(last)} min ago`}` : '') + ']';
    }

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
                        ? `  [${binding.kernel_label} · ${binding.kernel_id} · ${binding.lifecycle}` +
                          `${binding.attached_sessions ? ` · ${binding.attached_sessions} agent session${binding.attached_sessions === 1 ? '' : 's'}` : ''}]`
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
                const age   = this._lockAgeLabel(sid, t);
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
    if (typeof rest.description === 'string' && rest.description.length > 300) {
        const prefix = rest.description.replace(/\s+/g, ' ').slice(0, 300);
        const boundary = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('; '));
        rest.description = `${prefix.slice(0, boundary > 120 ? boundary + 1 : 297).trim()}…`;
    }
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
            ...(t.displayName ? { title: t.displayName } : {}),
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

/** True for a Claude Code local-scope entry created by Wolfbook. */
function _isManagedWolfbookEntry(entry) {
    const bridge = Array.isArray(entry?.args) ? entry.args[0] : '';
    return typeof bridge === 'string' &&
        path.basename(bridge).toLowerCase() === 'stdio-bridge.js' &&
        bridge.toLowerCase().includes('wolfbook');
}

/** Write wolfbook MCP entry to Claude Desktop config, ~/.claude.json (Claude Code),
 *  and ~/.codex/config.toml (Codex CLI).
 *  Exported separately so it can be called before the HTTP server has started.
 *  Claude Code is configured at user scope because Wolfbook itself routes among
 *  all connected VS Code windows/notebooks. Exact-project entries fail when an
 *  integrated terminal starts Claude in a nested repository.
 *  @param {string[]} [_workspacePaths] Retained for call-site compatibility.
 */
function writeClaudeConfig(bridgePath, nodeBin, home, port, _workspacePaths) {
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

    // 2. Claude Code CLI — user scope at ~/.claude.json:mcpServers.wolfbook.
    // Remove only local-scope entries previously created by Wolfbook. A custom
    // same-name project entry is left intact because local scope intentionally
    // overrides user scope in Claude Code.
    const claudeJsonPath = path.join(home, '.claude.json');
    try {
        let root = {};
        try { if (fs.existsSync(claudeJsonPath)) root = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch {}
        if (!root.mcpServers) root.mcpServers = {};
        root.mcpServers.wolfbook = { type: 'stdio', command: nodeBin, args: [bridgePath], env: {} };
        for (const project of Object.values(root.projects || {})) {
            if (!_isManagedWolfbookEntry(project?.mcpServers?.wolfbook)) continue;
            delete project.mcpServers.wolfbook;
            if (Object.keys(project.mcpServers).length === 0) delete project.mcpServers;
        }
        const tmp = claudeJsonPath + '.wolfbook.tmp';
        fs.writeFileSync(tmp, JSON.stringify(root, null, 2), 'utf8');
        fs.renameSync(tmp, claudeJsonPath);
        results.push(claudeJsonPath);
    } catch (e) {
        console.warn(`[Wolfbook MCP] Could not write to ${claudeJsonPath}:`, e.message);
    }

    // 3. Codex CLI — ~/.codex/config.toml, [mcp_servers.wolfbook]
    // Uses a minimal TOML patch: only touches the [mcp_servers.wolfbook] section.
    const codexConfigPath = path.join(home, '.codex', 'config.toml');
    try {
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        let toml = '';
        try { if (fs.existsSync(codexConfigPath)) toml = fs.readFileSync(codexConfigPath, 'utf8'); } catch {}

        // Build the new mcp_servers.wolfbook block
        // Codex gets the full tool list. It defers MCP tools behind its own tool
        // search, built from the FIRST tools/list, and ignores tools/list_changed
        // (openai/codex #33266) — so under the "auto" profile it could never find a
        // rarely used tool by searching, and listing everything costs it nothing up
        // front. Eager clients keep the server default. Verified 2026-09-26, Codex 0.155.
        const argsToml = '[' + [bridgePath, CODEX_BRIDGE_PROFILE_ARG].map(a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ') + ']';
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
 * the old directory on every update. Legacy installs may retain local-scope
 * project entries, while current installs use one user-scope entry.
 *
 * This repairs the user-scope entry and any legacy local-scope entries whose
 * bridge file is missing. Entries that already resolve are left alone, and
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
    if (!root || typeof root !== 'object') return out;

    let changed = false;
    const userEntry = root?.mcpServers?.wolfbook;
    if (_isManagedWolfbookEntry(userEntry)) {
        out.checked++;
        const current = userEntry.args[0];
        const bridgeOk = fs.existsSync(current);
        const nodeOk = !userEntry.command || userEntry.command === 'node' || fs.existsSync(userEntry.command);
        if (!bridgeOk || !nodeOk) {
            root.mcpServers.wolfbook = { type: 'stdio', command: nodeBin, args: [bridgePath], env: userEntry.env || {} };
            out.repaired.push('[user scope]');
            changed = true;
        }
    }
    for (const [wsPath, proj] of Object.entries(root.projects || {})) {
        const entry = proj && proj.mcpServers && proj.mcpServers.wolfbook;
        if (!_isManagedWolfbookEntry(entry)) continue;
        out.checked++;
        if (_isManagedWolfbookEntry(root?.mcpServers?.wolfbook)) {
            delete proj.mcpServers.wolfbook;
            if (Object.keys(proj.mcpServers).length === 0) delete proj.mcpServers;
            out.repaired.push(`${wsPath} (migrated to user scope)`);
            changed = true;
            continue;
        }
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
function needsConfigUpdate(bridgePath, nodeBin, _workspacePaths, home) {
    home = home || process.env.HOME || process.env.USERPROFILE || '~';

    // Check Claude Desktop config
    try {
        const cfg = JSON.parse(fs.readFileSync(
            path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'utf8'));
        const entry = cfg?.mcpServers?.wolfbook;
        if (!entry || entry.command !== nodeBin || entry.args?.[0] !== bridgePath) return true;
    } catch { return true; }

    // Check Claude Code's user-scope entry.
    try {
        const root = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
        const entry = root?.mcpServers?.wolfbook;
        if (!entry || entry.command !== nodeBin || entry.args?.[0] !== bridgePath) return true;
    } catch { return true; }

    // Check Codex config.toml
    try {
        const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
        // Simple check: these strings must appear in the wolfbook section
        if (!toml.includes(`command = "${nodeBin}"`)) return true;
        if (!toml.includes(`"${bridgePath}"`)) return true;
        if (!toml.includes(`"${CODEX_BRIDGE_PROFILE_ARG}"`)) return true;
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
// Claude Science (Anthropic's local science app, bundle id com.anthropic.operon)
//
// Connector file: ~/.claude-science/mcp/local-mcp.json → { servers: [ { name,
// command, args, env, description } ] }. It is what the app's own Customize →
// Connectors → "Local command" form writes, and the daemon re-reads it on
// every listing. (Remote connectors must be public https — not an option.)
//
// Every local connector runs in a seatbelt sandbox (measured 2026-09-27):
//   * reads of anything under $HOME are denied, except the app's own dirs and
//     `[sandbox] user_read_paths` → node and the bridge must be granted;
//   * outbound TCP (127.0.0.1:27182 included) is denied; the only way to a
//     local process is `[sandbox.network] allow_unix_sockets` → the bridge
//     talks to the primary's private socket (local-socket.js).
// Both grants live in ~/.claude-science/config.toml, belong to the user, and
// take effect after the app restarts. Wolfbook only writes them from the
// configure command, after the user confirms — never at activation.
// ---------------------------------------------------------------------------

const CLAUDE_SCIENCE_DESCRIPTION = 'Wolfbook: live Wolfram kernel, notebooks, slides and papers in VS Code';

function _claudeScienceDataDir(homeOverride) {
    return path.join(homeOverride || process.env.HOME || process.env.USERPROFILE || '~', '.claude-science');
}

function _claudeScienceConfigPath(homeOverride) {
    return path.join(_claudeScienceDataDir(homeOverride), 'mcp', 'local-mcp.json');
}

function _claudeScienceTomlPath(homeOverride) {
    return path.join(_claudeScienceDataDir(homeOverride), 'config.toml');
}

function claudeScienceInstalled(homeOverride) {
    return fs.existsSync(_claudeScienceDataDir(homeOverride));
}

function _realpath(p) { try { return fs.realpathSync(p); } catch (_) { return p; } }

function _isUnder(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Everything the Claude Science connector needs, computed once:
 *  node        — a node the sandbox can read: the resolved one, or a system node
 *                (/opt/homebrew, /usr/local) when the resolved one lives in $HOME;
 *  bridge      — a stable copy of stdio-bridge.js (~/.wolfbook/mcp/), so the entry
 *                survives extension upgrades (the extension path carries its version);
 *  socketPath  — the primary's private Unix socket;
 *  readPaths / unixSockets — the sandbox grants those require.
 */
function claudeSciencePlan(nodeBin, homeOverride, opts = {}) {
    const home = _realpath(homeOverride || process.env.HOME || process.env.USERPROFILE || '~');
    const socketPath = opts.socketPath !== undefined ? opts.socketPath : require('./local-socket').localSocketPath();
    let node = _realpath(nodeBin);
    if (_isUnder(node, home)) {
        const systemNode = (opts.systemNodes || ['/opt/homebrew/bin/node', '/usr/local/bin/node'])
            .map(_realpath).find(n => fs.existsSync(n) && !_isUnder(n, home) && validateNodeBinary(n).ok);
        if (systemNode) node = systemNode;
    }
    const bridgeDir = path.join(home, '.wolfbook', 'mcp');
    const readPaths = [bridgeDir];
    // node lives in <root>/bin/node; the whole install root is harmless to read.
    if (_isUnder(node, home)) readPaths.push(path.dirname(path.dirname(node)));
    return {
        node,
        bridge: path.join(bridgeDir, 'stdio-bridge.js'),
        socketPath,
        readPaths,
        unixSockets: socketPath ? [path.dirname(socketPath)] : [],
        configPath: _claudeScienceConfigPath(homeOverride),
        tomlPath: _claudeScienceTomlPath(homeOverride),
    };
}

/** Copy the (self-contained) bridge to the plan's stable path when it differs. */
function installClaudeScienceBridge(bridgePath, plan) {
    const src = fs.readFileSync(bridgePath);
    let current = null;
    try { current = fs.readFileSync(plan.bridge); } catch (_) {}
    if (current && current.equals(src)) return false;
    fs.mkdirSync(path.dirname(plan.bridge), { recursive: true });
    const tmp = plan.bridge + '.wolfbook.tmp';
    fs.writeFileSync(tmp, src, { mode: 0o644 });
    fs.renameSync(tmp, plan.bridge);
    return true;
}

function _claudeScienceEntryArgs(plan, existingArgs) {
    // Keep any flag the user added (e.g. --profile=economy); the socket is ours.
    const extra = (Array.isArray(existingArgs) ? existingArgs.slice(1) : [])
        .filter(a => typeof a === 'string' && !a.startsWith('--socket='));
    return [plan.bridge, ...(plan.socketPath ? [`--socket=${plan.socketPath}`] : []), ...extra];
}

function _readClaudeScienceServers(configPath) {
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) return { servers: [] };
    const config = JSON.parse(raw);
    if (!Array.isArray(config.servers)) config.servers = [];
    return config;
}

/** A wolfbook entry Wolfbook wrote (its first arg is a stdio-bridge.js). */
function _isManagedClaudeScienceEntry(entry) {
    const first = Array.isArray(entry?.args) ? entry.args[0] : '';
    return typeof first === 'string' && path.basename(first) === 'stdio-bridge.js';
}

/** Write the wolfbook entry into Claude Science's local-mcp.json.
 *  Returns { updated: bool, configPath: string, skipped: bool, error? }.
 */
function writeClaudeScienceConfig(plan, homeOverride) {
    const configPath = plan.configPath;
    if (!claudeScienceInstalled(homeOverride)) return { updated: false, configPath, skipped: true };
    try {
        // An unreadable file makes the app drop EVERY local connector, so never
        // paper over it with a rewrite that loses the user's entries.
        const config = fs.existsSync(configPath) ? _readClaudeScienceServers(configPath) : { servers: [] };
        const i = config.servers.findIndex(s => s && s.name === 'wolfbook');
        const existing = i >= 0 ? config.servers[i] : {};
        const entry = {
            ...existing,
            name: 'wolfbook',
            command: plan.node,
            args: _claudeScienceEntryArgs(plan, existing.args),
            env: existing.env && typeof existing.env === 'object' ? existing.env : {},
            description: existing.description || CLAUDE_SCIENCE_DESCRIPTION,
        };
        if (i >= 0) config.servers[i] = entry; else config.servers.push(entry);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const tmp = configPath + '.wolfbook.tmp';
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, configPath);
        return { updated: true, configPath, skipped: false };
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not write Claude Science config:', e.message);
        return { updated: false, configPath, skipped: false, error: e.message };
    }
}

/** Is there a wolfbook entry, and does it match the plan? */
function claudeScienceEntryState(plan) {
    let config;
    try { config = _readClaudeScienceServers(plan.configPath); }
    catch (e) { return e.code === 'ENOENT' ? { present: false, current: false } : { present: false, current: false, unreadable: true }; }
    const entry = config.servers.find(s => s && s.name === 'wolfbook');
    if (!entry) return { present: false, current: false };
    const current = entry.command === plan.node &&
        JSON.stringify(entry.args) === JSON.stringify(_claudeScienceEntryArgs(plan, entry.args));
    return { present: true, managed: _isManagedClaudeScienceEntry(entry), current };
}

/** Which of the plan's sandbox grants config.toml is missing. */
function claudeScienceSandboxState(plan) {
    const { readStringArray } = require('./toml-patch');
    let text = '';
    try { text = fs.readFileSync(plan.tomlPath, 'utf8'); } catch (_) {}
    try {
        const reads = readStringArray(text, 'sandbox', 'user_read_paths');
        const socks = readStringArray(text, 'sandbox.network', 'allow_unix_sockets');
        const missingReads = plan.readPaths.filter(p => !reads.includes(p));
        const missingSockets = plan.unixSockets.filter(p => !socks.includes(p));
        return { ok: !missingReads.length && !missingSockets.length, missingReads, missingSockets };
    } catch (e) {
        return { ok: false, missingReads: plan.readPaths, missingSockets: plan.unixSockets, unreadable: e.message };
    }
}

/** The config.toml lines a user would paste by hand. */
function claudeScienceTomlSnippet(plan) {
    const { tomlString } = require('./toml-patch');
    return `[sandbox]\nuser_read_paths = [${plan.readPaths.map(tomlString).join(', ')}]\n\n` +
        `[sandbox.network]\nallow_unix_sockets = [${plan.unixSockets.map(tomlString).join(', ')}]\n`;
}

/** Add the plan's grants to config.toml. Only call after the user agreed.
 *  Returns { ok, changed, tomlPath, error? } — error when the file's layout is not safely editable. */
function grantClaudeScienceSandbox(plan) {
    const { ensureStringArray } = require('./toml-patch');
    const tomlPath = plan.tomlPath;
    try {
        let text = '';
        let mode = 0o600;
        try { text = fs.readFileSync(tomlPath, 'utf8'); mode = fs.statSync(tomlPath).mode & 0o777; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const a = ensureStringArray(text, 'sandbox', 'user_read_paths', plan.readPaths);
        const b = ensureStringArray(a.text, 'sandbox.network', 'allow_unix_sockets', plan.unixSockets);
        if (!a.changed && !b.changed) return { ok: true, changed: false, tomlPath };
        const tmp = tomlPath + '.wolfbook.tmp';
        fs.writeFileSync(tmp, b.text.endsWith('\n') ? b.text : b.text + '\n', { encoding: 'utf8', mode });
        fs.renameSync(tmp, tomlPath);
        return { ok: true, changed: true, tomlPath };
    } catch (e) {
        return { ok: false, changed: false, tomlPath, error: e.message };
    }
}

/** Activation-time repair only: refresh an EXISTING Wolfbook-written entry that went stale. */
function needsClaudeScienceConfigUpdate(plan, homeOverride) {
    if (!claudeScienceInstalled(homeOverride)) return false;
    const st = claudeScienceEntryState(plan);
    return st.present && st.managed && !st.current;
}

// ---------------------------------------------------------------------------
// Agent skills
//
// Every explicitly supported coding agent uses the Agent Skills SKILL.md
// format, but their personal discovery directories differ. ~/.agents is the
// shared Codex/Roo location; product-specific copies cover Claude Code, Cline,
// and Antigravity IDE. Claude Desktop has no local skill directory and receives
// the same routing rule through MCP_SERVER_INSTRUCTIONS instead.
// ---------------------------------------------------------------------------

const _SKILL_DIR = path.join(__dirname, 'wolfbook-skill');
const _SKILL_FILES = [
    'SKILL.md',
    path.join('agents', 'openai.yaml'),
];

function getAgentSkillPaths(home) {
    home = home || process.env.HOME || process.env.USERPROFILE || '~';
    const shared = path.join(home, '.agents', 'skills', 'wolfbook', 'SKILL.md');
    return {
        claudeCode: path.join(home, '.claude', 'skills', 'wolfbook', 'SKILL.md'),
        codex: shared,
        rooCode: shared,
        cline: path.join(home, '.cline', 'skills', 'wolfbook', 'SKILL.md'),
        antigravity: path.join(home, '.gemini', 'antigravity', 'skills', 'wolfbook', 'SKILL.md'),
    };
}

function _skillTargetCurrent(skillPath) {
    const targetDir = path.dirname(skillPath);
    try {
        return _SKILL_FILES.every(rel =>
            fs.readFileSync(path.join(_SKILL_DIR, rel), 'utf8') ===
            fs.readFileSync(path.join(targetDir, rel), 'utf8'));
    } catch { return false; }
}

function _installSkillAt(skillPath) {
    if (_skillTargetCurrent(skillPath)) return false;
    const targetDir = path.dirname(skillPath);
    for (const rel of _SKILL_FILES) {
        const dest = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(_SKILL_DIR, rel), dest);
    }
    return true;
}

/** Install/update Wolfbook routing for every explicitly supported skill host. */
function installAgentSkills(home) {
    const skillPaths = getAgentSkillPaths(home);
    const updated = {};
    // codex and rooCode intentionally share the same cross-agent target.
    for (const key of ['claudeCode', 'codex', 'cline', 'antigravity']) {
        try {
            updated[key] = _installSkillAt(skillPaths[key]);
        } catch (e) {
            updated[key] = false;
            console.warn(`[Wolfbook MCP] Could not install ${key} skill:`, e.message);
        }
    }
    updated.rooCode = updated.codex;
    return { updated, skillPaths };
}

/** Returns true when any supported agent's skill copy is missing or stale. */
function needsAgentSkillsInstall(home) {
    const skillPaths = getAgentSkillPaths(home);
    return ['claudeCode', 'codex', 'cline', 'antigravity']
        .some(key => !_skillTargetCurrent(skillPaths[key]));
}

// Backward-compatible wrappers retained for existing command/tests.
function installAntigravitySkill(home) {
    const skillPath = getAgentSkillPaths(home).antigravity;
    try { return { updated: _installSkillAt(skillPath), skillPath }; }
    catch (e) {
        console.warn('[Wolfbook MCP] Could not install Antigravity skill:', e.message);
        return { updated: false, skillPath };
    }
}
function needsSkillInstall(home) {
    return needsAgentSkillsInstall(home);
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
// Roo Code (rooveterinaryinc.roo-cline) MCP config
// Path: ~/Library/Application Support/Code/User/globalStorage/
//         rooveterinaryinc.roo-cline/settings/mcp_settings.json  (macOS/Linux)
//       %APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json  (Windows)
// Format identical to Cline's — same key, different extension folder.
// ---------------------------------------------------------------------------

/** Resolve the Roo Code MCP settings file path for the current platform. */
function _rooCodeConfigPath(homeOverride) {
    const isWin = process.platform === 'win32';
    const base  = isWin
        ? (process.env.APPDATA || path.join(process.env.USERPROFILE || '~', 'AppData', 'Roaming'))
        : (homeOverride || process.env.HOME || '~');
    return isWin
        ? path.join(base, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
        : path.join(base, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
}

function _rooEconomyEntry(config) {
    const named = config?.mcpServers?.['wolfbook-economy'];
    if (named) return named;
    const legacyName = config?.mcpServers?.wolfbook;
    return Array.isArray(legacyName?.args) && legacyName.args.includes('--profile=economy')
        ? legacyName : null;
}

function _rooEntryTransportCurrent(entry, bridgePath, nodeBin) {
    if (!entry || entry.disabled) return false;
    const command = String(entry.command || '');
    const wrapper = path.basename(command) === 'wolfbook-mcp-bridge' && fs.existsSync(command);
    const direct = command === nodeBin && entry.args?.[0] === bridgePath;
    return wrapper || direct;
}

/** Write the wolfbook MCP entry into Roo Code's settings file.
 *  Only writes if Roo Code is installed (settings directory exists or file exists).
 *  Returns { updated: bool, configPath: string, skipped: bool }.
 */
function writeRooCodeConfig(bridgePath, nodeBin, homeOverride) {
    const configPath = _rooCodeConfigPath(homeOverride);
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
        const economyEntry = _rooEconomyEntry(config);
        if (economyEntry) {
            const useWrapper = path.basename(String(economyEntry.command || '')) === 'wolfbook-mcp-bridge' &&
                fs.existsSync(economyEntry.command);
            config.mcpServers['wolfbook-economy'] = {
                ...economyEntry,
                type: economyEntry.type || 'stdio',
                command: useWrapper ? economyEntry.command : nodeBin,
                args: useWrapper ? ['--profile=economy'] : [bridgePath, '--profile=economy'],
                disabled: false,
            };
            delete config.mcpServers.wolfbook;
        } else {
            const existing = config.mcpServers.wolfbook || {};
            config.mcpServers.wolfbook = {
                ...existing,
                type: existing.type || 'stdio',
                command: nodeBin,
                args: [bridgePath],
                disabled: false,
                autoApprove: existing.autoApprove || [],
            };
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        return { updated: true, configPath, skipped: false };
    } catch (e) {
        console.warn('[Wolfbook MCP] Could not write Roo Code config:', e.message);
        return { updated: false, configPath, skipped: false };
    }
}

/** Returns true if the Roo Code config needs writing (entry missing or stale). */
function needsRooCodeConfigUpdate(bridgePath, nodeBin, homeOverride) {
    const configPath = _rooCodeConfigPath(homeOverride);
    if (!fs.existsSync(path.dirname(configPath))) return false;
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        if (!raw.trim()) return true;
        const cfg   = JSON.parse(raw);
        const economyEntry = _rooEconomyEntry(cfg);
        if (economyEntry) {
            return !_rooEntryTransportCurrent(economyEntry, bridgePath, nodeBin) ||
                !economyEntry.args?.includes('--profile=economy') ||
                !!cfg?.mcpServers?.wolfbook;
        }
        const entry = cfg?.mcpServers?.wolfbook;
        return !_rooEntryTransportCurrent(entry, bridgePath, nodeBin);
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
function getMcpInfoPayload(bridgePath, nodeBin, port, isSecondary, isDisabled, homeOverride) {
    const home    = homeOverride || process.env.HOME || process.env.USERPROFILE || '~';
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
        rooCode: isWin
            ? path.join(appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
            : path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
        antigravity: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
        codex:       path.join(home, '.codex', 'config.toml'),
        claudeScience: _claudeScienceConfigPath(home),
    };

    const configured = {};
    try { configured.claudeDesktop = !!(JSON.parse(fs.readFileSync(configPaths.claudeDesktop, 'utf8'))?.mcpServers?.wolfbook); } catch { configured.claudeDesktop = false; }
    try { configured.claudeCode    = !!(JSON.parse(fs.readFileSync(configPaths.claudeCode, 'utf8'))?.mcpServers?.wolfbook); }    catch { configured.claudeCode  = false; }
    try { configured.cline         = !!(JSON.parse(fs.readFileSync(configPaths.cline, 'utf8'))?.mcpServers?.wolfbook); }         catch { configured.cline        = false; }
    try {
        const rooServers = JSON.parse(fs.readFileSync(configPaths.rooCode, 'utf8'))?.mcpServers || {};
        configured.rooCode = !!(rooServers.wolfbook || rooServers['wolfbook-economy']);
    } catch { configured.rooCode = false; }
    try { configured.antigravity   = !!(JSON.parse(fs.readFileSync(configPaths.antigravity, 'utf8'))?.mcpServers?.wolfbook); }    catch { configured.antigravity  = false; }
    try { configured.codex         = fs.readFileSync(configPaths.codex, 'utf8').includes('[mcp_servers.wolfbook]'); }            catch { configured.codex        = false; }
    try {
        // "Configured" = the entry exists AND the sandbox lets it run.
        if (!claudeScienceInstalled(home)) configured.claudeScience = false;
        else {
            const plan = claudeSciencePlan(nodeBin, home);
            configured.claudeScience = claudeScienceEntryState(plan).present && claudeScienceSandboxState(plan).ok;
        }
    } catch { configured.claudeScience = false; }

    const skillPaths = getAgentSkillPaths(home);
    const skillsInstalled = {
        claudeDesktop: null, // Claude Desktop receives MCP instructions; it has no local skill directory.
        claudeCode: _skillTargetCurrent(skillPaths.claudeCode),
        codex: _skillTargetCurrent(skillPaths.codex),
        cline: _skillTargetCurrent(skillPaths.cline),
        rooCode: _skillTargetCurrent(skillPaths.rooCode),
        antigravity: _skillTargetCurrent(skillPaths.antigravity),
        claudeScience: null, // Guidance arrives via the MCP server instructions; no skill file is written.
    };

    return { port: port || 0, bridgePath, nodeBin, isSecondary: !!isSecondary, isDisabled: !!isDisabled,
        configPaths, configured, skillPaths, skillsInstalled };
}

module.exports = { WolframMCPServer, loadMCPSchemas, MCP_PROTOCOL_VERSIONS, negotiateProtocolVersion, configureClaudeDesktop, writeClaudeConfig,
    repairStaleClaudeConfigs, needsConfigUpdate, resolveNodeBinary, validateNodeBinary, probeExistingServer,
    writeAntigravityConfig, needsAntigravityConfigUpdate,
    writeClaudeScienceConfig, needsClaudeScienceConfigUpdate, claudeScienceInstalled, claudeSciencePlan,
    installClaudeScienceBridge, claudeScienceEntryState, claudeScienceSandboxState, claudeScienceTomlSnippet,
    grantClaudeScienceSandbox,
    installAgentSkills, needsAgentSkillsInstall, getAgentSkillPaths,
    installAntigravitySkill, needsSkillInstall,
    writeClineConfig, needsClineConfigUpdate, writeRooCodeConfig, needsRooCodeConfigUpdate,
    getMcpInfoPayload, MCP_SERVER_INSTRUCTIONS, MCP_ECONOMY_INSTRUCTIONS,
    ECONOMY_TOOL_NAMES };
