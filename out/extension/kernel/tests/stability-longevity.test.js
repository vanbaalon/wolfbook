'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { withVscodeStub, makeVscodeStub } = require('./_stub-vscode');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-longevity-'));
process.env.WOLFBOOK_PID_FILE = path.join(dir, 'pids.json');
const logPaths = require('../../utils/log-paths');
logPaths.init({ globalStorageUri: { fsPath: dir } });
const journal = require('../../utils/kernel-lifecycle-log');
let answer;
const vscode = makeVscodeStub({ window: { showWarningMessage: () => new Promise(r => { answer = r; }) } });
const lc = withVscodeStub(() => require('../lifecycle'), vscode);
const { WolframMCPServer } = withVscodeStub(() => require('../../claude-mcp/server'), vscode);
const { WorkerServer } = withVscodeStub(() => require('../../claude-mcp/worker'), vscode);

(async () => {
    try {
        // Normal EvalResult and legacy bare WExpr both track the PID without
        // keeping idle kernels awake. Evaluation activity owns sleep guards.
        const spawned = [];
        const cp = { spawn: (bin, args) => { spawned.push({ bin, args }); const p = new EventEmitter(); p.kill = () => {}; return p; } };
        const self = { kernelMetadata: {}, _sessionEpoch: 3, kernelId: 'test-kernel', session: null };
        for (const result of [{ result: { type: 'integer', value: 1234567 } }, { type: 'integer', value: 1234568 }]) {
            self.session = { evaluate: async () => result };
            await lc._trackKernelProcess(self, cp, 'darwin');
        }
        assert.strictEqual(self.kernelMetadata.pid, 1234568);
        assert.strictEqual(spawned.length,0,'idle PID tracking must never create a sleep assertion');
        assert.strictEqual(lc._loadPidFile().length, 2);
        self.session = { evaluate: async () => ({ result: { type: 'integer', value: -1 } }) };
        await lc._trackKernelProcess(self, cp, 'darwin');
        assert.strictEqual(spawned.length, 0, 'invalid PIDs must not spawn companions');
        self.session = { evaluate: async () => ({ result: { type: 'integer', value: 1234569 } }) };
        await lc._trackKernelProcess(self, cp, 'linux');
        assert.strictEqual(spawned.length, 0, 'non-macOS never spawns caffeinate');

        const { KernelArbiter } = require('../arbiter');
        const arbiter = new KernelArbiter();
        assert.strictEqual(arbiter.status({ kernelStatusString: 'resolved', _connectionLost: 'wstp-link-dead' }).lifecycle, 'faulted');
        assert.strictEqual(arbiter.status({ kernelStatusString: 'resolved', _connectionLost: null }).lifecycle, 'idle');

        // Advance a passive watcher across seven days of BUSY evaluation.
        // No evaluation, abort, close or recovery dialog may be triggered.
        const originalInterval = global.setInterval;
        let tick, timer;
        global.setInterval = fn => { tick = fn; return timer = originalInterval(() => {}, 3600000); };
        let calls = 0;
        self._evalDispatched = true;
        self._directEvaluationCount = 1;
        self.kernelStatusString = 'resolved';
        self.session = { isOpen: true, isLinkDead: false, isReady: false, evaluate() { calls++; }, close() { calls++; } };
        self.kernelMetadata.pid = process.pid;
        try { lc._startKeepalive(self, null); }
        finally { global.setInterval = originalInterval; }
        for (let i = 0; i < 7 * 24 * 20; i++) tick();
        assert.strictEqual(calls, 0);
        assert.strictEqual(answer, undefined);
        self.session.isLinkDead = true; tick();
        assert.strictEqual(self._connectionLost, 'wstp-link-dead');
        assert.strictEqual(arbiter.status(self).linkHealth, 'disconnected');
        assert.strictEqual(calls, 0, 'lost-link detection cannot close or abort');
        answer('Cancel'); await new Promise(resolve => setImmediate(resolve));
        self.session.isLinkDead = false;
        self._connectionLost = null;
        clearInterval(timer);
        assert.strictEqual(lc._connectionFailure({ isOpen: true, isLinkDead: true }, process.pid), 'wstp-link-dead');
        assert.strictEqual(lc._connectionFailure({ isOpen: true }, 10, () => false), 'kernel-process-exited');
        assert.strictEqual(lc._connectionFailure({ isOpen: false }), 'session-closed');

        // A cancelled or stale restart prompt MUST leave sessions untouched.
        const old = self.session;
        let recovery = lc._lifecycle_relaunch(self, null, old, 'wstp-link-dead');
        assert.strictEqual(calls, 0, 'asking about recovery cannot close the kernel');
        answer('Cancel'); await recovery;
        assert.strictEqual(self.session, old);
        recovery = lc._lifecycle_relaunch(self, null, old, 'session-closed');
        const replacement = { close() { calls++; } };
        self.session = replacement;
        answer('Restart Now'); await recovery;
        assert.strictEqual(self.session, replacement);
        assert.strictEqual(calls, 0, 'old prompts cannot kill a replacement');

        // A live host remains routable after days without a heartbeat. Unknown
        // and definitively dead owners still expire.
        const server = new WolframMCPServer(new Map());
        server._workers.set('busy', { pid: process.pid, registeredAt: Date.now() - 7 * 86400000 });
        server._workers.set('legacy', { registeredAt: Date.now() - 120000 });
        server._workers.set('dead', { pid: 2147483647, registeredAt: Date.now() });
        server._pruneWorkers();
        assert.deepStrictEqual([...server._workers.keys()], ['busy']);

        // One failed HTTP health request often emits BOTH timeout and error.
        // Count one failure per request, maintaining the actual 3-poll threshold.
        const worker = new WorkerServer(new Map(), 'test');
        clearInterval(worker._transactionSweepTimer);
        const http = require('http'), get = http.get;
        let poll, request;
        global.setInterval = fn => { poll = fn; return timer = originalInterval(() => {}, 3600000); };
        http.get = () => { request = new EventEmitter(); request.destroy = () => request.emit('error', new Error('destroyed')); return request; };
        try {
            worker._startHealthPolling(); poll(); request.emit('timeout');
            assert.strictEqual(worker._healthFailCount, 1);
            assert.strictEqual(worker._electionInProgress, false);
        } finally { http.get = get; global.setInterval = originalInterval; clearInterval(timer); }

        // Evidence survives disabled verbose diagnostics and filters out source.
        assert.strictEqual(logPaths.diagnosticsEnabled(), false);
        journal.record('test.safe', { kernelId: 'test-kernel', expression: 'PRIVATE_EXPRESSION', token: 'SECRET_TOKEN' });
        await journal.flush();
        let tail = journal.readTail(100);
        assert.match(tail, /process.tracked/);
        assert.match(tail, /recovery.cancelled/);
        assert.ok(!tail.includes('PRIVATE_EXPRESSION') && !tail.includes('SECRET_TOKEN'));
        const lifecycleDir = path.join(dir, 'logs', 'lifecycle');
        const file = path.join(lifecycleDir, fs.readdirSync(lifecycleDir).find(f => f.endsWith('.jsonl')));
        fs.writeFileSync(file, 'x'.repeat(256 * 1024));
        journal.record('test.rotated', { pid: process.pid }); await journal.flush();
        assert.ok(fs.existsSync(file + '.1'));
        assert.match(journal.readTail(10, 'rotated'), /test.rotated/);
        console.log('stability-longevity: OK (PID/sleep guard, 7-day busy watcher, recovery races, live routing, health failures, bounded evidence)');
    } finally {
        await journal.flush();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
