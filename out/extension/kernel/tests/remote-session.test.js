'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const http = require('http');
const actions = [];
const originalRequest = http.request;

http.request = (_options, onResponse) => {
    const req = new EventEmitter();
    let body = '';
    req.write = chunk => { body += chunk; };
    req.end = () => process.nextTick(() => {
        const msg = JSON.parse(body);
        actions.push(msg);
        const res = new EventEmitter();
        res.statusCode = msg.generation === 'stale' ? 409 : 200;
        res.setEncoding = () => {};
        onResponse(res);
        const payload = msg.generation === 'stale'
            ? { error: 'owner changed', code: 'STALE_KERNEL_OWNER' }
            : { result: msg.action === 'evaluate' ? { type: 'string', value: `remote:${msg.expression}` } : true };
        res.emit('data', JSON.stringify(payload)); res.emit('end');
    });
    return req;
};

const { RemoteKernelSession } = require('../../claude-mcp/remote-kernel-session');

(async () => {
    const session = new RemoteKernelSession(27183, 'k-remote', 'generation-1');
    await session.beginTransaction('test cell');
    const transactionId = session.transactionId;
    const result = await session.evaluate('2+2');
    assert.deepStrictEqual(result, { type: 'string', value: 'remote:2+2' });
    await session.endTransaction();
    assert.deepStrictEqual(actions.map(item => item.action), ['begin', 'evaluate', 'end']);
    assert(actions.every(item => item.transactionId === transactionId));
    session.generation = 'stale';
    await assert.rejects(session.status(), error => error.code === 'STALE_KERNEL_OWNER');
    const workerSource = require('fs').readFileSync(require.resolve('../../claude-mcp/worker'), 'utf8');
    assert(workerSource.includes("url.pathname === '/kernel-session'"));
    assert(workerSource.includes("kind: 'remote-cell'"));
    const checkoutSource = require('fs').readFileSync(require.resolve('../../execution/checkout'), 'utf8');
    assert(checkoutSource.includes("_brokerLease?.owner === 'remote-notebook-ui'"));
    console.log('remote kernel session tests: OK');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { http.request = originalRequest; });
