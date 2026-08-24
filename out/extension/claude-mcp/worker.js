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
const { runWithActivityContext } = require('../monitor/activity');
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
const crypto   = require('crypto');
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
    constructor(toolMap, clientId, getKernels = null, resolveKernel = null, stopKernel = null, getKernelBindings = null) {
        this._toolMap  = toolMap;
        this._clientId = clientId;
        // Distinguishes this extension-host lifetime from a stale registration
        // left by an earlier process which happened to use the same client ID.
        this._registrationGeneration = `${Date.now()}-${crypto.randomUUID()}`;
        this._getKernels = getKernels;
        this._resolveKernel = resolveKernel;
        this._stopKernel = stopKernel;
        this._getKernelBindings = getKernelBindings;
        this._kernelTransactions = new Map();
        this._transactionSweepTimer = setInterval(() => this._sweepKernelTransactions(), 10000);
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
        if (this._transactionSweepTimer) { clearInterval(this._transactionSweepTimer); this._transactionSweepTimer = null; }
        for (const transaction of this._kernelTransactions.values()) {
            transaction.entry.controller?.arbiter?.release(transaction.lease, 'broker-stopped');
        }
        this._kernelTransactions.clear();
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
        } else if (req.method === 'POST' && url.pathname === '/kernel-session') {
            this._handleKernelSession(req, res);
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

    _handleKernelSession(req, res) {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            const reply = (status, payload) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            let msg;
            try { msg = JSON.parse(body); } catch { return reply(400, { error: 'Bad JSON' }); }
            if (msg.generation && msg.generation !== this._registrationGeneration) {
                return reply(409, { error: 'Kernel owner generation changed; refresh the kernel list.', code: 'STALE_KERNEL_OWNER' });
            }
            const entry = this._resolveKernel?.(msg.kernelId);
            if (!entry || entry.remote) return reply(404, { error: `Kernel is not owned by this window: ${msg.kernelId}`, code: 'UNKNOWN_KERNEL' });
            const ctrl = entry.controller;
            const transaction = msg.transactionId ? this._kernelTransactions.get(msg.transactionId) : null;
            try {
                if (msg.action === 'begin') {
                    if (!msg.transactionId) throw new Error('transactionId is required.');
                    if (this._kernelTransactions.has(msg.transactionId)) {
                        return reply(409, { error: 'Transaction already exists.', code: 'DUPLICATE_TRANSACTION' });
                    }
                    const claim = await ctrl.arbiter.acquire(ctrl, {
                        owner: 'remote-notebook-ui', kind: 'remote-cell', caption: msg.caption,
                        operationId: msg.transactionId, policy: 'reject',
                    });
                    if (claim.busy) return reply(409, { error: 'Kernel is busy.', code: 'KERNEL_BUSY', details: claim.busy });
                    this._kernelTransactions.set(msg.transactionId, { entry, lease: claim.lease, touchedAt: Date.now() });
                    return reply(200, { result: { transactionId: msg.transactionId } });
                }
                if (msg.action === 'end') {
                    if (!transaction) return reply(404, { error: 'Remote kernel transaction is no longer active.', code: 'STALE_TRANSACTION' });
                    ctrl.arbiter.release(transaction.lease, msg.outcome || 'completed');
                    this._kernelTransactions.delete(msg.transactionId);
                    return reply(200, { result: true });
                }
                if (msg.action === 'status') return reply(200, { result: ctrl.arbiter.status(ctrl) });
                if (msg.action === 'abort') return reply(200, { result: await ctrl.arbiter.abort(ctrl, { requestedBy: 'remote-notebook-ui', operationId: msg.transactionId || undefined }) });
                if (msg.action === 'restart') {
                    if (ctrl.arbiter.status(ctrl).busy) return reply(409, { error: 'Cannot restart a busy kernel.', code: 'KERNEL_BUSY' });
                    await ctrl.restartKernel(); return reply(200, { result: true });
                }
                if (msg.action === 'stop') {
                    if (ctrl.arbiter.status(ctrl).busy) return reply(409, { error: 'Cannot stop a busy kernel.', code: 'KERNEL_BUSY' });
                    if (!this._stopKernel) return reply(501, { error: 'Remote kernel stop is unavailable.', code: 'NOT_IMPLEMENTED' });
                    await this._stopKernel(entry);
                    return reply(200, { result: true });
                }
                if (!transaction || transaction.entry.id !== entry.id) {
                    return reply(409, { error: 'A live transaction lease is required for remote evaluation.', code: 'TRANSACTION_REQUIRED' });
                }
                transaction.touchedAt = Date.now();
                let result;
                ctrl._directEvaluationCount = Number(ctrl._directEvaluationCount || 0) + 1;
                try {
                    if (msg.action === 'evaluate') result = await ctrl.session.evaluate(String(msg.expression || ''), msg.options || {});
                    else if (msg.action === 'subAuto') result = await ctrl.session.subAuto(String(msg.expression || ''));
                    else if (msg.action === 'dialogEval') result = await ctrl.session.dialogEval(String(msg.expression || ''));
                    else if (msg.action === 'exitDialog') result = await ctrl.session.exitDialog(msg.value);
                    else return reply(400, { error: `Unsupported kernel session action: ${msg.action}` });
                } finally { ctrl._directEvaluationCount = Math.max(0, Number(ctrl._directEvaluationCount || 1) - 1); }
                return reply(200, { result });
            } catch (error) {
                return reply(500, { error: error.message || String(error), code: error.code || 'REMOTE_KERNEL_ERROR' });
            }
        });
    }

    _sweepKernelTransactions() {
        const cutoff = Date.now() - 2 * 60 * 1000;
        for (const [id, transaction] of this._kernelTransactions) {
            if (transaction.touchedAt >= cutoff || Number(transaction.entry.controller?._directEvaluationCount || 0) > 0) continue;
            transaction.entry.controller?.arbiter?.release(transaction.lease, 'remote-client-expired');
            this._kernelTransactions.delete(id);
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
                toolResult = await runWithActivityContext(args?._activityContext,
                    () => tool.invoke({ input: args || {} }, token));
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
            kernels:    this._getKernels?.() || [],
            kernelBindings: this._getKernelBindings?.() || [],
            generation: this._registrationGeneration,
            registeredAt: Date.now(),
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
                kernels: this._getKernels?.() || [],
                kernelBindings: this._getKernelBindings?.() || [],
                generation: this._registrationGeneration,
                registeredAt: Date.now(),
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
                            if (json.status === 'ok') {
                                this._healthFailCount = 0;
                                this._syncRegistry();
                                this._registerWithPrimary().catch(() => {});
                                return;
                            }
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
