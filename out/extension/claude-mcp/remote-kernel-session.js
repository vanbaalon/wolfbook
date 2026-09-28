'use strict';

const http = require('http');
const crypto = require('crypto');

const CONTROL_TIMEOUTS_MS = { begin: 15000, end: 15000, status: 10000, abort: 15000, stop: 30000, restart: 120000 };

class RemoteKernelSession {
    constructor(port, kernelId, generation) {
        this.port = Number(port);
        this.kernelId = kernelId;
        this.generation = generation || null;
        this.transactionId = null;
        this.state = 'idle';
        this.isRemote = true;
    }

    // Control calls get a deadline; evaluations do not (a computation may
    // legitimately run for hours). Without one, a hung owner window — paused in a
    // debugger, a frozen extension host — hung this window's cell forever.
    _call(action, args = {}) {
        const timeoutMs = CONTROL_TIMEOUTS_MS[action] || 0;
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                action, kernelId: this.kernelId, generation: this.generation,
                transactionId: this.transactionId, ...args,
            });
            const req = http.request({
                hostname: '127.0.0.1', port: this.port, path: '/kernel-session', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                    ...require('./auth').authHeaders() },
            }, res => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { raw += chunk; });
                res.on('end', () => {
                    let payload;
                    try { payload = JSON.parse(raw); } catch { return reject(new Error(`Remote kernel returned invalid data (${res.statusCode}).`)); }
                    if (res.statusCode >= 400 || payload.error) {
                        const error = new Error(payload.error || `Remote kernel request failed (${res.statusCode}).`);
                        error.code = payload.code; error.details = payload.details;
                        return reject(error);
                    }
                    resolve(payload.result);
                });
            });
            req.on('error', error => reject(new Error(`Remote kernel owner is unavailable: ${error.message}`)));
            if (timeoutMs && typeof req.setTimeout === "function") req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer to "${action}" within ${timeoutMs / 1000} s`)));
            req.write(body); req.end();
        });
    }

    async beginTransaction(caption = 'Notebook cell evaluation') {
        if (this.transactionId) return this.transactionId;
        this.transactionId = crypto.randomUUID();
        try {
            await this._call('begin', { caption });
            this.state = 'busy';
            return this.transactionId;
        } catch (error) {
            this.transactionId = null;
            throw error;
        }
    }

    async endTransaction(outcome = 'completed') {
        if (!this.transactionId) return;
        try { await this._call('end', { outcome }); }
        finally { this.transactionId = null; this.state = 'idle'; }
    }

    async evaluate(expression, options = {}) {
        if (this.transactionId) return this._call('evaluate', { expression, options });
        await this.beginTransaction('Remote kernel evaluation');
        try { return await this._call('evaluate', { expression, options }); }
        finally { await this._endQuietly(); }
    }
    async _implicit(action, args) {
        if (this.transactionId) return this._call(action, args);
        await this.beginTransaction(`Remote kernel ${action}`);
        try { return await this._call(action, args); }
        finally { await this._endQuietly(); }
    }
    // An implicit transaction's "end" failing (owner went away just after
    // answering) used to REPLACE the result: a successful evaluation was
    // reported as "Remote kernel owner is unavailable". The owner sweeps an
    // abandoned transaction after 2 min idle (worker.js _sweepKernelTransactions);
    // the state here is reset regardless.
    async _endQuietly() { try { await this.endTransaction(); } catch (_) {} }
    subAuto(expression) { return this._implicit('subAuto', { expression }); }
    dialogEval(expression) { return this._implicit('dialogEval', { expression }); }
    exitDialog(value) { return this._implicit('exitDialog', { value }); }
    abort() { return this._call('abort'); }
    status() { return this._call('status'); }
    restart() { return this._call('restart'); }
    stop() { return this._call('stop'); }
    get isDialogOpen() { return false; }
}

module.exports = { RemoteKernelSession, CONTROL_TIMEOUTS_MS };
