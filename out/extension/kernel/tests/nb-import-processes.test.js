'use strict';

const assert = require('assert');
const supervisor = require('../../nb-import/subprocessSupervisor');
const kernelAssist = require('../../nb-import/kernelAssist');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    const direct = supervisor.spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
        { stage: 'test', key: 'direct-test', notebook: '/tmp/test.nb' }
    );
    await delay(25);
    assert.ok(direct.pid > 0);
    assert.strictEqual(supervisor.snapshot().filter(x => x.key === 'direct-test').length, 1);
    await supervisor.terminateKey('direct-test');
    assert.strictEqual(supervisor.snapshot().filter(x => x.key === 'direct-test').length, 0);

    // Two requests for one notebook must share one helper process.
    const runner = {
        cmd: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)', '--'],
    };
    const payload = [{ index: 0, boxSource: 'RowBox[{"x"}]' }];
    const opts = { key: 'same-notebook', notebook: '/tmp/same.nb', runner, timeoutMs: 80 };
    const first = kernelAssist.refineCells(payload, opts);
    const second = kernelAssist.refineCells(payload, opts);
    await delay(25);
    assert.strictEqual(supervisor.snapshot().filter(x => x.key === 'same-notebook').length, 1);
    const [a, b] = await Promise.all([first, second]);
    assert.match(a.error, /timed out/);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(supervisor.snapshot().filter(x => x.key === 'same-notebook').length, 0);

    // Cancellation is bounded and removes the child from the registry.
    const controller = new AbortController();
    const cancelled = kernelAssist.refineCells(payload, {
        key: 'cancelled-notebook', notebook: '/tmp/cancelled.nb', runner,
        timeoutMs: 10000, signal: controller.signal,
    });
    await delay(25);
    controller.abort();
    const result = await cancelled;
    assert.match(result.error, /cancelled/);
    assert.strictEqual(supervisor.snapshot().filter(x => x.key === 'cancelled-notebook').length, 0);

    supervisor.dispose();
    console.log('nb-import-processes.test.js: ok');
})().catch(error => {
    supervisor.dispose();
    console.error(error);
    process.exit(1);
});
