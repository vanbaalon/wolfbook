'use strict';

// Stability: the remote-kernel transport when the OWNER window misbehaves.
//
// A RemoteKernelSession drives a kernel that lives in another VS Code window
// over HTTP. Real server here, not a mocked http.request, because the failures
// are transport-level:
//
//   * a hung owner (debugger pause, frozen extension host) hung this window's
//     control calls forever — there was no deadline at all;
//   * an implicit transaction's "end" failing AFTER a successful evaluation
//     replaced the result with "Remote kernel owner is unavailable";
//   * evaluations must NOT get a deadline — a computation may run for hours.

const assert = require('assert');
const http = require('http');
const { RemoteKernelSession, CONTROL_TIMEOUTS_MS } = require('../../claude-mcp/remote-kernel-session');

// Shrink the control deadlines so the test runs in a second.
Object.assign(CONTROL_TIMEOUTS_MS, { begin: 300, end: 300, status: 300, abort: 300 });

function server(behaviour) {
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            const msg = JSON.parse(body);
            const act = behaviour[msg.action] || 'ok';
            const answer = payload => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
            if (act === 'hang') return;                               // never answers
            if (act === 'drop') return req.socket.destroy();          // owner vanished
            if (typeof act === 'number') return setTimeout(() => answer({ result: { type: 'string', value: 'slow' } }), act);
            answer({ result: msg.action === 'evaluate' ? { type: 'string', value: 'ok' } : true });
        });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const within = async (p, ms) => {
    let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms); });
    try { return await Promise.race([p, timer]); } finally { clearTimeout(t); }
};

(async () => {
    // 1. Hung owner: control calls fail within their deadline, not never.
    let srv = await server({ status: 'hang', abort: 'hang' });
    let s = new RemoteKernelSession(srv.address().port, 'k1', 'g1');
    await assert.rejects(within(s.status(), 3000), /no answer to "status"/, 'status must time out');
    await assert.rejects(within(s.abort(), 3000), /no answer to "abort"/, 'abort must time out');
    srv.close();

    // 2. Evaluation succeeds, then the owner drops the "end": the RESULT wins.
    srv = await server({ end: 'drop' });
    s = new RemoteKernelSession(srv.address().port, 'k1', 'g1');
    const r = await within(s.evaluate('1+1'), 3000);
    assert.deepStrictEqual(r, { type: 'string', value: 'ok' }, 'a failed end must not mask a good result');
    assert.strictEqual(s.transactionId, null, 'transaction state is reset');
    assert.strictEqual(s.state, 'idle');
    const r2 = await within(s.subAuto('x'), 3000);
    assert.ok(r2, 'subAuto survives a dropped end too');
    srv.close();

    // 3. Evaluations have NO deadline: slower than every control timeout, still fine.
    srv = await server({ evaluate: 900 });
    s = new RemoteKernelSession(srv.address().port, 'k1', 'g1');
    const slow = await within(s.evaluate('Pause[1]'), 5000);
    assert.strictEqual(slow.value, 'slow', 'a long evaluation must not be cut off');
    const port = srv.address().port;
    await new Promise(r => srv.close(r));

    // 4. Owner gone entirely: a clear, fast error.
    s = new RemoteKernelSession(port, 'k1', 'g1');
    await assert.rejects(within(s.status(), 3000), /Remote kernel owner is unavailable/);
    await assert.rejects(within(s.evaluate('1'), 3000), /Remote kernel owner is unavailable/,
        'a failed begin surfaces the owner error, not a hang');
    assert.strictEqual(s.transactionId, null, 'a failed begin leaves no transaction behind');

    console.log('stability-remote-session: all assertions passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
