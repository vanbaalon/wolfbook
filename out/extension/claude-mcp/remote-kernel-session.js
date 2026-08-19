'use strict';

const http = require('http');
const crypto = require('crypto');

class RemoteKernelSession {
    constructor(port, kernelId, generation) {
        this.port = Number(port);
        this.kernelId = kernelId;
        this.generation = generation || null;
        this.transactionId = null;
        this.state = 'idle';
        this.isRemote = true;
    }

    _call(action, args = {}) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                action, kernelId: this.kernelId, generation: this.generation,
                transactionId: this.transactionId, ...args,
            });
            const req = http.request({
                hostname: '127.0.0.1', port: this.port, path: '/kernel-session', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
        finally { await this.endTransaction(); }
    }
    async _implicit(action, args) {
        if (this.transactionId) return this._call(action, args);
        await this.beginTransaction(`Remote kernel ${action}`);
        try { return await this._call(action, args); }
        finally { await this.endTransaction(); }
    }
    subAuto(expression) { return this._implicit('subAuto', { expression }); }
    dialogEval(expression) { return this._implicit('dialogEval', { expression }); }
    exitDialog(value) { return this._implicit('exitDialog', { value }); }
    abort() { return this._call('abort'); }
    status() { return this._call('status'); }
    restart() { return this._call('restart'); }
    stop() { return this._call('stop'); }
    get isDialogOpen() { return false; }
}

module.exports = { RemoteKernelSession };
