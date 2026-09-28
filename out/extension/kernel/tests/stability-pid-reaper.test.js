'use strict';

// Stability: launching a kernel must never kill someone else's kernel.
//
// The orphan-reaper's PID file lives in os.tmpdir() — ONE file for every window
// and every kernel on the machine. It used to be a bare PID list that every
// launchKernel() SIGTERM/SIGKILLed in full and every quitKernel() deleted. So
// starting any kernel (a second window, an isolated K2, a restart) killed every
// other live kernel. Now each entry carries its owner (extension-host PID) and
// only kernels whose owner is dead are reaped.
//
// Real processes, not mocks: a copy of the node binary named "WolframKernel" is
// the kernel (a relocated copy of /bin/sleep is SIGKILLed by macOS on launch), live and dead child processes are the owners. The test uses its own
// PID file via WOLFBOOK_PID_FILE — never the real one live windows depend on.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

if (process.platform === 'win32') { console.log('stability-pid-reaper: skipped on Windows'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pid-'));
process.env.WOLFBOOK_PID_FILE = path.join(dir, 'pids.json');
const fakeKernel = path.join(dir, 'WolframKernel');
fs.copyFileSync(process.execPath, fakeKernel);
fs.chmodSync(fakeKernel, 0o755);

const { withVscodeStub } = require('./_stub-vscode');
const lc = withVscodeStub(() => require('../lifecycle'));

const IDLE = ['-e', 'setTimeout(() => {}, 60000)'];
const spawned = [];
const start = (bin, ...args) => { const p = spawn(bin, args, { stdio: 'ignore' }); spawned.push(p.pid); return p.pid; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const deadPid = () => { const r = spawnSync('/usr/bin/true'); return r.pid; };
// A kernel whose parent died: re-parented to launchd/init (ppid 1).
const orphanKernel = () => {
    const out = execFileSync('/bin/sh', ['-c', `"${fakeKernel}" -e "setTimeout(()=>{},60000)" >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
    const pid = Number(out.trim()); spawned.push(pid); return pid;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const writeFile = entries => fs.writeFileSync(process.env.WOLFBOOK_PID_FILE, JSON.stringify(entries));

(async () => {
    try {
        // ---- Policy table (pure) -------------------------------------------
        const probe = (aliveSet, psMap) => ({
            self: 100, alive: pid => aliveSet.has(pid), ps: pid => psMap[pid] || null, platform: 'darwin',
        });
        const K = { ppid: 42, comm: '/Applications/Wolfram.app/Contents/MacOS/WolframKernel' };
        const cases = [
            ['gone',                         { pid: 1, owner: 100 }, [],        {},                    'drop'],
            ['ours (sibling kernel)',        { pid: 1, owner: 100 }, [1, 100],  { 1: K },              'keep'],
            ['another LIVE window',          { pid: 1, owner: 200 }, [1, 200],  { 1: K },              'keep'],
            ['owner dead, still a kernel',   { pid: 1, owner: 200 }, [1],       { 1: K },              'kill'],
            ['owner dead, PID reused',       { pid: 1, owner: 200 }, [1],       { 1: { ppid: 5, comm: 'Safari' } }, 'drop'],
            ['legacy, kernel of a live host',{ pid: 1, owner: null },[1],       { 1: K },              'drop'],
            ['legacy, orphaned kernel',      { pid: 1, owner: null },[1],       { 1: { ...K, ppid: 1 } }, 'kill'],
        ];
        for (const [name, entry, a, ps, want] of cases) {
            assert.strictEqual(lc._classifyPidEntry(entry, probe(new Set(a), ps)), want, name);
        }

        // ---- Real processes -------------------------------------------------
        const liveOwner   = start('/bin/sleep', '60');       // another window's extension host
        const liveKernel  = start(fakeKernel, ...IDLE);         // ...and its kernel
        const ownKernel   = start(fakeKernel, ...IDLE);         // a sibling kernel in THIS window
        const orphan      = start(fakeKernel, ...IDLE);         // kernel of a crashed window
        const reused      = start('/bin/sleep', '60');       // PID reused by a non-kernel
        const legacyLive  = start(fakeKernel, ...IDLE);         // legacy entry, parent (us) alive
        const legacyOrph  = orphanKernel();                  // legacy entry, re-parented to 1
        const dead = deadPid();
        await sleep(300);
        for (const pid of [liveOwner, liveKernel, ownKernel, orphan, reused, legacyLive, legacyOrph]) {
            assert.ok(alive(pid), `fixture process ${pid} failed to start`);
        }

        writeFile([
            { pid: liveKernel, owner: liveOwner },
            { pid: ownKernel,  owner: process.pid },
            { pid: orphan,     owner: dead },
            { pid: reused,     owner: dead },
            legacyLive,
            legacyOrph,
        ]);

        lc._killStalePids();          // what every launchKernel() does first
        await sleep(400);

        assert.ok(alive(liveKernel), 'a LIVE window\'s kernel must survive another launch');
        assert.ok(alive(ownKernel),  'a sibling kernel in this window must survive');
        assert.ok(alive(reused),     'a non-kernel that reused the PID must never be signalled');
        assert.ok(alive(legacyLive), 'a legacy entry whose host is alive must survive');
        assert.ok(!alive(orphan),    'a kernel whose window crashed is reaped');
        assert.ok(!alive(legacyOrph),'a legacy orphan (ppid 1) is reaped');

        const left = lc._loadPidFile().map(e => e.pid).sort();
        assert.deepStrictEqual(left, [liveKernel, ownKernel].sort(),
            'only live-owned entries remain tracked');

        // quit removes ONE entry, never the file other windows rely on.
        lc._appendPid(orphan + 1000000);            // this window's own record
        lc._removePid(ownKernel);
        const after = lc._loadPidFile().map(e => e.pid);
        assert.ok(after.includes(liveKernel), 'quitting one kernel keeps every other window\'s record');
        assert.ok(!after.includes(ownKernel), 'the quitting kernel\'s own record is removed');
        const mine = lc._loadPidFile().find(e => e.pid === orphan + 1000000);
        assert.strictEqual(mine.owner, process.pid, 'new records carry their owner');

        console.log('stability-pid-reaper: all assertions passed');
    } finally {
        for (const pid of spawned) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
        fs.rmSync(dir, { recursive: true, force: true });
    }
    process.exit(0);
})().catch(e => {
    for (const pid of spawned) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    console.error(e); process.exit(1);
});
