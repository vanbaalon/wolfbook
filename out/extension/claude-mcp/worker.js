'use strict';
// ---------------------------------------------------------------------------
// Wolfbook Worker Server — per-window HTTP server for multi-window MCP routing
//
// Every VS Code / Antigravity window starts one WorkerServer on a dynamic
// port (27183–27282).  The window that wins port 27182 runs the primary
// WolframMCPServer; all others are workers.
//
// Workers:
//  • Register themselves with the primary via POST /register on port 27182
//  • Expose  POST /invoke   — primary proxies tool calls here
//  • Expose  GET  /notebooks — current open notebook paths

const { setMcpCallActive } = require('../tools/shared');
//  • Poll the primary's /health; on 3 consecutive failures → run election
//
// Election:
//  • All workers race to bind TCP port 27182
//  • Winner calls onPromoted() which extension.js uses to spin up a new primary
//  • Losers wait 1.5–2.5 s then re-register with the new primary
//  • New primary reads the registry file + notifies known workers via POST /new-primary
// ---------------------------------------------------------------------------

const http     = require('http');
const net      = require('net');
const registry = require('./registry');

const PRIMARY_PORT       = 27182;
const WORKER_BASE_PORT   = 27183;
const WORKER_PORT_RANGE  = 100;
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_FAIL_MAX    = 3;

class WorkerServer {
    /**
     * @param {Map<string,object>} toolMap    name → tool instance (same map as primary)
     * @param {string}             clientId   e.g. "VSCode[ClasterVersion]"
     */
    constructor(toolMap, clientId) {
        this._toolMap  = toolMap;
        this._clientId = clientId;
        this._port     = 0;
        this._server   = null;
        this._notebooks = [];            // fsPath[] — updated by extension.js
        this._healthTimer     = null;
        this._healthFailCount = 0;
        this._electionInProgress = false;
        this._onPromotedCb = null;       // async () => void — set by extension.js
    }

    get clientId() { return this._clientId; }
    get port()     { return this._port; }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Update the list of currently open notebook paths (called from extension.js).
     *  Re-registers with the primary so its in-memory routing table stays current. */
    updateNotebooks(paths) {
        this._notebooks = paths || [];
        this._syncRegistry();
        // Push the updated notebook list to the primary's in-memory _workers map.
        // Without this the primary only learns about notebooks at initial registration
        // and the list goes stale as the user opens/closes files.
        if (this._port) this._registerWithPrimary().catch(() => {});
    }

    /** Register a callback invoked when this worker wins the election and should
     *  become the new primary.  The callback receives no arguments; extension.js
     *  uses the captured scope to build the new WolframMCPServer. */
    onPromoted(cb) { this._onPromotedCb = cb; }

    /** Start the worker HTTP server, write registry entry, register with primary. */
    async start() {
        await this._startListening(WORKER_BASE_PORT);
        this._syncRegistry();
        await this._registerWithPrimary();
        this._startHealthPolling();
        return this._port;
    }

    /** Clean up: stop health polling, remove registry entry, close HTTP server. */
    stop() {
        if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
        registry.removeEntry(this._clientId);
        return new Promise(resolve => {
            if (this._server) this._server.close(() => resolve());
            else resolve();
        });
    }

    // ── Internal: HTTP server ────────────────────────────────────────────────

    _startListening(port) {
        return new Promise((resolve, reject) => {
            const srv = http.createServer((req, res) => {
                try { this._handle(req, res); }
                catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(); } }
            });
            this._server = srv;
            srv.listen(port, '127.0.0.1', () => {
                this._port = srv.address().port;
                resolve(this._port);
            });
            srv.on('error', err => {
                if (err.code === 'EADDRINUSE' && port < WORKER_BASE_PORT + WORKER_PORT_RANGE) {
                    srv.close();
                    this._server = null;
                    this._startListening(port + 1).then(resolve, reject);
                } else { reject(err); }
            });
        });
    }

    _handle(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const url = new URL(req.url, `http://127.0.0.1:${this._port}`);

        if (req.method === 'POST' && url.pathname === '/invoke') {
            this._handleInvoke(req, res);
        } else if (req.method === 'GET' && url.pathname === '/notebooks') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ clientId: this._clientId, notebooks: this._notebooks }));
        } else if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', clientId: this._clientId, port: this._port }));
        } else if (req.method === 'POST' && url.pathname === '/new-primary') {
            // New primary elected — re-register
            let body = '';
            req.on('data', d => { body += d; });
            req.on('end', () => {
                res.writeHead(200); res.end();
                // Reset failure count and re-register; polling continues unchanged
                this._healthFailCount = 0;
                this._registerWithPrimary().catch(() => {});
            });
        } else {
            res.writeHead(404); res.end();
        }
    }

    _handleInvoke(req, res) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', d => { body += d; });
        req.on('end', async () => {
            let msg;
            try { msg = JSON.parse(body); } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad JSON', isError: true }));
                return;
            }

            const { name, arguments: args } = msg;
            const tool = this._toolMap.get(name);
            if (!tool) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Unknown tool: ${name}`, isError: true }));
                return;
            }

            const token = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} }),
            };

            let toolResult;
            setMcpCallActive(true);
            try {
                toolResult = await tool.invoke({ input: args || {} }, token);
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message || String(e), isError: true }));
                return;
            } finally {
                setMcpCallActive(false);
            }

            // Serialise content parts preserving type (text vs image data URIs).
            const parts = (toolResult?.content || []).map(p => {
                const val = p.value ?? p.text ?? '';
                return typeof val === 'string' && val.startsWith('data:image/') && val.includes(';base64,')
                    ? { kind: 'image', value: val }
                    : { kind: 'text',  value: String(val) };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ parts, isError: false }));
        });
    }

    // ── Internal: registry and primary registration ──────────────────────────

    _syncRegistry() {
        registry.writeEntry({
            clientId:   this._clientId,
            workerPort: this._port,
            pid:        process.pid,
            notebooks:  this._notebooks,
            appName:    this._clientId.split('[')[0],
            workspace:  (this._clientId.match(/\[([^\]#]+)\]/) || [])[1] || '',
        });
    }

    _registerWithPrimary() {
        return new Promise(resolve => {
            const body = JSON.stringify({
                clientId:  this._clientId,
                port:      this._port,
                pid:       process.pid,
                notebooks: this._notebooks,
            });
            const req = http.request({
                hostname: '127.0.0.1',
                port:     PRIMARY_PORT,
                path:     '/register',
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 2000,
            }, res => { res.resume(); resolve(); });
            req.on('error',   () => resolve());   // primary may not be up yet — OK
            req.on('timeout', () => { req.destroy(); resolve(); });
            req.write(body);
            req.end();
        });
    }

    // ── Internal: health polling and election ────────────────────────────────

    _startHealthPolling() {
        if (this._healthTimer) clearInterval(this._healthTimer);
        this._healthTimer = setInterval(() => {
            const req = http.get(
                `http://127.0.0.1:${PRIMARY_PORT}/health`,
                { timeout: 2000 },
                res => {
                    let buf = '';
                    res.on('data', d => { buf += d; });
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(buf);
                            if (json.status === 'ok') { this._healthFailCount = 0; return; }
                        } catch {}
                        this._onHealthFail();
                    });
                }
            );
            req.on('error',   () => this._onHealthFail());
            req.on('timeout', () => { req.destroy(); this._onHealthFail(); });
        }, HEALTH_INTERVAL_MS);
    }

    _onHealthFail() {
        this._healthFailCount++;
        if (this._healthFailCount >= HEALTH_FAIL_MAX && !this._electionInProgress) {
            this._electionInProgress = true;
            if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
            this._tryElection();
        }
    }

    _tryElection() {
        console.log(`[Wolfbook Worker ${this._clientId}] Primary appears dead — starting election`);

        // Race: first worker to bind port 27182 wins
        const probe = net.createServer();
        probe.listen(PRIMARY_PORT, '127.0.0.1');

        probe.on('listening', () => {
            // We won the election
            probe.close(async () => {
                console.log(`[Wolfbook Worker ${this._clientId}] Election won — promoting to primary`);
                this._electionInProgress = false;
                this._healthFailCount    = 0;
                try {
                    if (this._onPromotedCb) await this._onPromotedCb();
                } catch (e) {
                    console.warn('[Wolfbook Worker] Promotion callback failed:', e.message);
                    // Fall back: restart health polling and try to re-register
                    this._startHealthPolling();
                }
            });
        });

        probe.on('error', () => {
            // Lost the race — another worker is becoming primary
            console.log(`[Wolfbook Worker ${this._clientId}] Election lost — waiting for new primary`);
            this._electionInProgress = false;
            this._healthFailCount    = 0;
            // Randomised backoff so we don't all hammer the new primary at once
            const delay = 1500 + Math.random() * 1000;
            setTimeout(() => {
                this._registerWithPrimary().catch(() => {});
                this._startHealthPolling();
            }, delay);
        });
    }
}

module.exports = { WorkerServer, PRIMARY_PORT };
