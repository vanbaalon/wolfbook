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

module.exports = { WolframMCPServer, loadMCPSchemas, configureClaudeDesktop, writeClaudeConfig, needsConfigUpdate, resolveNodeBinary, probeExistingServer };
