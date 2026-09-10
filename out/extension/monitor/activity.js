'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { renderDashboard } = require('./dashboard');
const { projectActivity } = require('./activity-projection');

const activityScope = new AsyncLocalStorage();
const MAX_EVENTS_IN_MEMORY = 10000;
const MAX_EVENT_BYTES = 64 * 1024;
const RETENTION_DAYS = 7;

function runWithActivityContext(context, fn) {
    return activityScope.run(context || {}, fn);
}

function getActivityContext() {
    return activityScope.getStore() || null;
}

function _secret(storageDir) {
    fs.mkdirSync(storageDir, { recursive: true });
    const file = path.join(storageDir, 'monitor-secret');
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) {}
    const value = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (_) { try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) {} }
    return value;
}

function _safeString(value, limit = 12000) {
    const text = String(value == null ? '' : value);
    if (/^data:[^;,]+;base64,/i.test(text)) {
        const comma = text.indexOf(',');
        return `[binary data omitted: ${Math.max(0, text.length - comma - 1)} base64 characters]`;
    }
    if (text.length > 512 && text.length % 4 === 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(text)) {
        return `[base64-looking content omitted: ${text.length} characters]`;
    }
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n… [${text.length - limit} characters omitted]`;
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return _safeString(value);
    if (typeof value !== 'object') return _safeString(value);
    if (depth > 7) return '[nested value omitted]';
    if (seen.has(value)) return '[circular value omitted]';
    seen.add(value);
    if (Buffer.isBuffer(value)) return `[binary buffer omitted: ${value.length} bytes]`;
    if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1, seen));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 150)) {
        if (/password|passwd|secret|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie/i.test(key)) {
            out[key] = '[redacted]';
        } else if (key === 'content' && value.content_encoding === 'base64' && typeof item === 'string') {
            out[key] = `[base64 content omitted: ${item.length} characters]`;
        } else if (key === 'data' && typeof item === 'string' && item.length > 256) {
            out[key] = `[binary data omitted: ${item.length} characters]`;
        } else {
            out[key] = sanitize(item, depth + 1, seen);
        }
    }
    return out;
}

function _isoDay(ts) { return new Date(ts).toISOString().slice(0, 10); }

class ActivityMonitor {
    constructor(options = {}) {
        this.storageDir = path.join(options.storageDir || process.cwd(), 'monitor');
        this.eventsDir = path.join(this.storageDir, 'events');
        this.logoPath = options.logoPath || null;
        this.clientId = options.clientId || null;
        this.workspace = options.workspace || null;
        this.port = 27182;
        this.primary = false;
        this.secret = _secret(this.storageDir);
        this.events = [];
        this.listeners = new Set();
        this.launchNonces = new Map();
        this.sessions = new Map();
        this.pending = [];
        this.writeChain = Promise.resolve();
        this.topologyProvider = () => [];
        this.actionHandler = null;
        fs.mkdirSync(this.eventsDir, { recursive: true });
        this._loadRecent();
        this._cleanup();
        this.retryTimer = setInterval(() => {
            if (!this.primary && this.pending.length) this._forward(this.pending.shift());
        }, 5000);
        this.retryTimer.unref?.();
    }

    setClientInfo(clientId, workspace) {
        this.clientId = clientId || this.clientId;
        this.workspace = workspace || this.workspace;
    }
    setTopologyProvider(provider) { this.topologyProvider = typeof provider === 'function' ? provider : () => []; }
    setActionHandler(handler) { this.actionHandler = typeof handler === 'function' ? handler : null; }
    dispose() { if (this.retryTimer) clearInterval(this.retryTimer); this.retryTimer = null; this.listeners.clear(); }
    setPort(port) { if (port) this.port = Number(port); }
    setPrimary(primary) {
        this.primary = !!primary;
        if (this.primary && this.pending.length) {
            this._loadRecent();
            const queued = this.pending.splice(0);
            for (const event of queued) this._append(event);
        } else if (this.primary) {
            this._loadRecent();
        } else if (!this.primary && this.pending.length) {
            const queued = this.pending.splice(0);
            for (const event of queued) this._forward(event);
        }
    }

    record(input = {}) {
        const context = getActivityContext() || {};
        let event = {
            version: 1,
            eventId: input.eventId || crypto.randomUUID(),
            timestamp: Number(input.timestamp || input.ts || Date.now()),
            type: input.type || 'system.event',
            traceId: input.traceId || context.traceId || context.operationId || null,
            operationId: input.operationId || context.operationId || null,
            agentSessionId: input.agentSessionId || context.agentSessionId || null,
            agentName: input.agentName || context.agentName || null,
            source: input.source || context.source || 'vscode',
            clientId: input.clientId || context.clientId || this.clientId || null,
            workspace: input.workspace || this.workspace || null,
            notebook: input.notebook || context.notebook || null,
            kernelId: input.kernelId || context.kernelId || null,
            kernelLabel: input.kernelLabel || null,
            state: input.state || null,
            background: !!input.background,
            payload: sanitize(input.payload || {}),
        };
        let encoded = JSON.stringify(event);
        if (Buffer.byteLength(encoded) > MAX_EVENT_BYTES) {
            event.payload = { summary: _safeString(event.payload?.summary || 'Event payload exceeded the activity-log limit.', 2000), omitted: true };
            encoded = JSON.stringify(event);
        }
        if (!this.primary && !this.port) { this.pending.push(event); return event; }
        if (this.primary) this._append(event, encoded);
        else this._forward(event);
        return event;
    }

    _append(event, encoded = null) {
        if (this.events.some(item => item.eventId === event.eventId)) return;
        this.events.push(event);
        if (this.events.length > MAX_EVENTS_IN_MEMORY) this.events.splice(0, this.events.length - MAX_EVENTS_IN_MEMORY);
        const line = `${encoded || JSON.stringify(event)}\n`;
        const file = path.join(this.eventsDir, `${_isoDay(event.timestamp)}.jsonl`);
        this.writeChain = this.writeChain.then(() => fs.promises.appendFile(file, line, { encoding: 'utf8', mode: 0o600 }))
            .catch(err => console.warn('[Wolfbook Monitor] Activity write failed:', err.message));
        for (const listener of this.listeners) {
            try { listener(event); } catch (_) {}
        }
    }

    _forward(event) {
        const body = JSON.stringify(event);
        const req = http.request({ hostname: '127.0.0.1', port: this.port || 27182,
            path: '/monitor/internal/events', method: 'POST', timeout: 2000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Wolfbook-Monitor': this.secret } },
        res => res.resume());
        req.on('error', () => {
            if (this.pending.length < 500) this.pending.push(event);
        });
        req.on('timeout', () => req.destroy());
        req.end(body);
    }

    _loadRecent() {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        let files = [];
        try { files = fs.readdirSync(this.eventsDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2); } catch (_) {}
        for (const file of files) {
            let text = '';
            try { text = fs.readFileSync(path.join(this.eventsDir, file), 'utf8'); } catch (_) { continue; }
            for (const line of text.split('\n')) {
                if (!line) continue;
                try { const event = JSON.parse(line); if (event.timestamp >= cutoff) this.events.push(event); } catch (_) {}
            }
        }
        const unique = new Map();
        for (const event of this.events) unique.set(event.eventId, event);
        this.events = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_EVENTS_IN_MEMORY);
    }

    async _history() {
        // History queries must include the start of an operation even when it
        // predates the selected period. Reparse only journals that changed.
        this._historyDays ||= new Map();
        const cutoff = Date.now() - RETENTION_DAYS * 86400000;
        const unique = new Map();
        const files = await fs.promises.readdir(this.eventsDir);
        for (const file of files.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
            if (Date.parse(file.slice(0, 10)) < cutoff - 86400000) continue;
            const filename = path.join(this.eventsDir, file);
            const stat = await fs.promises.stat(filename).catch(() => null);
            if (!stat) continue;
            let cached = this._historyDays.get(file);
            if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
                const text = await fs.promises.readFile(filename, 'utf8');
                const records = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
                cached = { records, size: stat.size, mtimeMs: stat.mtimeMs };
                this._historyDays.set(file, cached);
            }
            for (const record of cached.records) if (record.timestamp >= cutoff) unique.set(record.eventId, record);
        }
        for (const file of this._historyDays.keys()) if (!files.includes(file) || Date.parse(file.slice(0, 10)) < cutoff - 86400000) this._historyDays.delete(file);
        for (const record of this.events) unique.set(record.eventId, record);
        return [...unique.values()];
    }

    _cleanup() {
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        try {
            for (const file of fs.readdirSync(this.eventsDir)) {
                const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
                if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) fs.unlinkSync(path.join(this.eventsDir, file));
            }
        } catch (_) {}
    }

    createLaunchUrl() {
        if (this.primary) return Promise.resolve(this._issueLaunchUrl());
        return new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: this.port || 27182,
                path: '/monitor/internal/launch', method: 'POST', timeout: 2000,
                headers: { 'Content-Length': 0, 'X-Wolfbook-Monitor': this.secret } }, res => {
                let data = ''; res.on('data', d => { data += d; });
                res.on('end', () => { try { resolve(JSON.parse(data).url); } catch (_) { reject(new Error('Monitor launch response was invalid.')); } });
            });
            req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Wolfbook monitor is unavailable.')); }); req.end();
        });
    }

    _issueLaunchUrl() {
        const nonce = crypto.randomBytes(24).toString('base64url');
        this.launchNonces.set(nonce, Date.now() + 60000);
        return `http://127.0.0.1:${this.port}/monitor/launch/${nonce}`;
    }

    _authorized(req) {
        let cookies;
        try { cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x.length === 2)); }
        catch (_) { return false; }
        const expiry = this.sessions.get(cookies.wolfbook_monitor);
        return !!expiry && expiry > Date.now();
    }

    handles(pathname) { return pathname === '/monitor' || pathname.startsWith('/monitor/'); }

    handle(req, res, url) {
        const pathname = url.pathname;
        if (req.method === 'POST' && pathname === '/monitor/internal/action') {
            if (req.headers['x-wolfbook-monitor'] !== this.secret) return this._reply(res, 403, { error: 'forbidden' });
            return this._readJson(req, res, 16 * 1024, async action => {
                try {
                    if (action.clientId !== this.clientId) throw new Error('Target window changed. Refresh activity.');
                    this._reply(res, 200, sanitize(await this.actionHandler(action)));
                } catch (error) { this._reply(res, 409, { error: error.message }); }
            });
        }
        if (req.method === 'POST' && pathname === '/monitor/internal/events') {
            if (req.headers['x-wolfbook-monitor'] !== this.secret) return this._reply(res, 403, { error: 'forbidden' });
            return this._readJson(req, res, MAX_EVENT_BYTES, event => { this._append(sanitize(event)); this._reply(res, 202, { ok: true }); });
        }
        if (req.method === 'POST' && pathname === '/monitor/internal/launch') {
            if (req.headers['x-wolfbook-monitor'] !== this.secret) return this._reply(res, 403, { error: 'forbidden' });
            return this._reply(res, 200, { url: this._issueLaunchUrl() });
        }
        const launch = /^\/monitor\/launch\/([A-Za-z0-9_-]+)$/.exec(pathname);
        if (req.method === 'GET' && launch) {
            const expiry = this.launchNonces.get(launch[1]); this.launchNonces.delete(launch[1]);
            if (!expiry || expiry < Date.now()) return this._text(res, 403, 'This Wolfbook monitor link has expired. Open it again from VS Code.');
            const session = crypto.randomBytes(24).toString('base64url');
            this.sessions.set(session, Date.now() + 12 * 60 * 60 * 1000);
            res.writeHead(302, { Location: '/monitor/', 'Set-Cookie': `wolfbook_monitor=${session}; HttpOnly; SameSite=Strict; Path=/monitor; Max-Age=43200`, 'Cache-Control': 'no-store' }); res.end(); return;
        }
        if (!this._authorized(req)) return this._text(res, 403, 'Wolfbook MCP Control Room is locked. Open it from the Wolfbook command palette.');
        this._securityHeaders(res);
        if (req.method === 'POST' && pathname === '/monitor/api/action') {
            if (req.headers['x-wolfbook-action'] !== '1') return this._reply(res, 403, { error: 'action header required' });
            if (!this.actionHandler) return this._reply(res, 503, { error: 'Control actions are unavailable.' });
            return this._readJson(req, res, 16 * 1024, async action => {
                try {
                    const op = projectActivity(await this._history()).operations.find(op => op.id === action.id);
                    if (!op) throw new Error('Activity has expired. Refresh the page.');
                    const resolved = { action: action.action, operationId: op.operationId,
                        notebook: op.notebook, cellId: op.cellId, cellNumber: op.cellNumber,
                        kernelId: op.kernelId, clientId: op.clientId, selector: op.selector };
                    if (action.changeIndex != null) {
                        const change = Number.isInteger(action.changeIndex) && op.changes[action.changeIndex];
                        if (action.action !== 'open' || !change) throw new Error('Notebook change is no longer available.');
                        resolved.notebook = change.notebook || resolved.notebook;
                        resolved.cellId = change.cellId || null;
                        resolved.cellNumber = change.cellNumber ?? null;
                    }
                    let result;
                    if (resolved.clientId && resolved.clientId !== this.clientId) {
                        const topology = this.topologyProvider() || {};
                        const client = (Array.isArray(topology) ? topology : topology.clients || [])
                            .find(c => (c.clientId || c.client_id) === resolved.clientId);
                        const port = Number(client?.workerPort || client?.port);
                        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The owning VS Code window is unavailable.');
                        result = await this._forwardAction(port, resolved);
                    } else result = await this.actionHandler(resolved);
                    this._reply(res, 200, sanitize(result));
                }
                catch (error) { this._reply(res, 400, { error: String(error?.message || error) }); }
            });
        }
        if (req.method === 'GET' && (pathname === '/monitor' || pathname === '/monitor/')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(renderDashboard()); return;
        }
        if (req.method === 'GET' && pathname === '/monitor/logo.png') {
            try { const data = fs.readFileSync(this.logoPath); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' }); res.end(data); }
            catch (_) { this._text(res, 404, 'Logo not found'); } return;
        }
        if (req.method === 'GET' && pathname === '/monitor/api/events') {
            const since = Number(url.searchParams.get('since') || Date.now() - 24 * 60 * 60 * 1000);
            const limit = Math.max(1, Math.min(10000, Number(url.searchParams.get('limit') || 5000)));
            return this._reply(res, 200, { now: Date.now(), events: this.events.filter(e => e.timestamp >= since).slice(-limit) });
        }
        if (req.method === 'GET' && pathname === '/monitor/api/overview') {
            return this._history().then(events => this._overview(res, url, events))
                .catch(error => this._reply(res, 500, { error: `Cannot load activity history: ${error.message}` }));
        }
        if (req.method === 'GET' && pathname === '/monitor/api/topology') {
            let topology = []; try { topology = this.topologyProvider() || []; } catch (_) {}
            const clients = Array.isArray(topology) ? topology : (topology.clients || []);
            const sessions = Array.isArray(topology) ? [] : (topology.sessions || []);
            return this._reply(res, 200, { now: Date.now(), port: this.port,
                clients: sanitize(clients), sessions: sanitize(sessions) });
        }
        if (req.method === 'GET' && pathname === '/monitor/api/live') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            res.write(': connected\n\n');
            const listener = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
            this.listeners.add(listener);
            const ping = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 15000);
            req.on('close', () => { clearInterval(ping); this.listeners.delete(listener); }); return;
        }
        this._text(res, 404, 'Not found');
    }

    _overview(res, url, events) {
            const since = Number(url.searchParams.get('since') || Date.now() - 24 * 60 * 60 * 1000);
            const limit = Math.max(1, Math.min(10000, Number(url.searchParams.get('limit') || 2000)));
            let topology = []; try { topology = this.topologyProvider() || []; } catch (_) {}
            const normalizedTopology = Array.isArray(topology)
                ? { clients: topology, sessions: [] }
                : { clients: topology.clients || [], sessions: topology.sessions || [] };
            const projection = projectActivity(events, normalizedTopology);
            const matching = projection.operations.filter(operation =>
                (operation.completedAt || operation.startedAt) >= since);
            const page = matching.slice(0, limit);
            const visible = new Map(page.map(operation => [operation.id, operation]));
            for (const operation of projection.activeOperations) visible.set(operation.id, operation);
            // The operation projection is the normal human-facing API. Raw
            // transport/system events remain available from /api/events for the
            // deliberately separate diagnostics view.
            const operations = [...visible.values()].map(operation => {
                const copy = { ...operation }; delete copy.events; return sanitize(copy);
            });
            const sessions = projection.sessions.map(session => {
                const copy = { ...session, lastOperationId: session.lastOperation?.id || null };
                delete copy.lastOperation; return copy;
            });
            return this._reply(res, 200, {
                version: projection.version, now: projection.now, summary: projection.summary,
                operations, activeOperationIds: projection.activeOperations.map(operation => operation.id),
                sessions: sessions.map(session => sanitize(session)),
                kernels: normalizedTopology.clients.flatMap(client => (client.kernels || [])
                    .filter(kernel => !kernel.remote)
                    .map(kernel => sanitize({ ...kernel, clientId: client.clientId || client.client_id,
                        workspace: client.workspace }))),
                hasMore: matching.length > limit, total: matching.length,
            });
    }

    _securityHeaders(res) {
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
    _forwardAction(port, action) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(action);
            const request = http.request({ hostname: '127.0.0.1', port, path: '/monitor/internal/action',
                method: 'POST', timeout: 30000, headers: { 'X-Wolfbook-Monitor': this.secret,
                    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
                let text = ''; response.on('data', chunk => { text += chunk; });
                response.on('end', () => { try { const result = JSON.parse(text);
                    if (response.statusCode !== 200) reject(new Error(result.error || 'Action failed'));
                    else resolve(result);
                } catch (error) { reject(error); } });
            });
            request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Target window did not respond')));
            request.end(body);
        });
    }
    _readJson(req, res, max, cb) {
        let body = ''; req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > max) req.destroy(); });
        req.on('end', () => {
            let value;
            try { value = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object'); }
            catch (_) { this._reply(res, 400, { error: 'Expected a JSON object.' }); return; }
            Promise.resolve().then(() => cb(value)).catch(error => {
                if (!res.writableEnded) this._reply(res, 500, { error: String(error.message || error) });
            });
        });
    }
    _reply(res, status, body) { this._securityHeaders(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
    _text(res, status, body) { this._securityHeaders(res); res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
}

module.exports = { ActivityMonitor, sanitize, runWithActivityContext, getActivityContext };
