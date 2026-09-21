const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeBuildLane } = require('../../tex/nativeCompileService');

test('superseded native builds stop at source synchronization and publication boundaries', async () => {
    for (const boundary of ['queued edits', 'open', 'capture', 'publish']) {
        for (const cause of ['abort', 'edit']) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cancel-'));
            const root = path.join(dir, 'paper.tex'); fs.writeFileSync(root, 'Alpha');
            const lane = Object.create(NativeBuildLane.prototype);
            const ac = new AbortController(); const calls = [];
            const interrupt = () => { if (cause === 'abort') ac.abort(); else lane.invalidate(); };
            const step = async name => { calls.push(name); if (boundary === name) interrupt(); };
            Object.assign(lane, { root, projectDir:dir, buildNumber:0, version:0,
                edits:boundary === 'queued edits' ? Promise.resolve().then(interrupt) : Promise.resolve(),
                source:{ files:new Map(), open:async () => step('open'),
                    capture:async () => { await step('capture'); return { files:{} }; },
                    publish:async () => step('publish'),
                    readPages:async () => { throw Error('stale build must not paginate'); } },
                compiler:{ compile:async () => {
                    calls.push('compile');
                    return { success:true, build:{ source_bindings:[] } };
                } } });
            try {
                await assert.rejects(lane.compile({ signal:ac.signal }), { name:'AbortError' });
                if (boundary === 'queued edits') assert.deepEqual(calls, []);
                else if (boundary === 'publish') assert.ok(calls.includes('compile'));
                else assert.ok(!calls.includes('compile'), `${boundary} should stop before native compilation`);
            } finally { fs.rmSync(dir, { recursive:true, force:true }); }
        }
    }
});

test('an already cancelled native request does not read source files', async () => {
    const lane = Object.create(NativeBuildLane.prototype);
    lane.version = 0;
    const ac = new AbortController(); ac.abort();
    await assert.rejects(lane.compile({ signal:ac.signal }), { name:'AbortError' });
});
