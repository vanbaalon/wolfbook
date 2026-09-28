'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { once } = require('events');
const { createLabelRegistry } = require('../label-registry');
const { KernelManager } = require('../manager');

if (process.argv[2] === '--lease-worker') {
    const registry = createLabelRegistry(process.argv[3]);
    const id = process.argv[4];
    process.on('message', message => {
        if (message.release) registry.releaseKernelLabel(message.release);
        process.send({ done: true });
    });
    process.send({ label: registry.reserveKernelLabel(id, 'K1') });
} else (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-labels-'));
    const file = path.join(tmp, 'labels.json');
    const workers = [];
    try {
        // Live processes model extension hosts allocating simultaneously.
        const labels = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
            const child = fork(__filename, ['--lease-worker', file, `window-${i}`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
            workers.push(child);
            return (await once(child, 'message'))[0].label;
        }));
        assert.strictEqual(new Set(labels).size, 8, 'concurrent windows cannot share a label');
        const registry = createLabelRegistry(file);
        const owner = JSON.parse(fs.readFileSync(file)).find(entry => entry.kernelId === 'window-0');
        registry.releaseKernelLabel(owner.kernelId);
        assert(JSON.parse(fs.readFileSync(file)).some(entry => entry.kernelId === owner.kernelId), 'foreign window must not release owner lease');
        assert.notStrictEqual(registry.reserveKernelLabel('local', owner.label), owner.label);
        assert.throws(() => registry.renameKernelLabel('local', owner.label), /already in use/);
        const before = JSON.parse(fs.readFileSync(file)).find(entry => entry.kernelId === 'local').label;
        assert.strictEqual(registry.reserveKernelLabel('local'), before, 'failed rename preserves old lease');
        registry.renameKernelLabel('local', 'Solver');
        assert.strictEqual(registry.reserveKernelLabel('local'), 'Solver');
        assert.notStrictEqual(registry.reserveKernelLabel('other', 'solver'), 'solver');
        registry.releaseKernelLabel('local');
        assert.strictEqual(registry.reserveKernelLabel('restored', 'Solver'), 'Solver', 'custom labels restore once released');

        let allocated = 0;
        const released = [];
        const manager = new KernelManager(null, {
            labelAllocator: () => `K${++allocated}`, labelReleaser: id => released.push(id),
        });
        const controller = () => ({ _controller: {}, dispose() {} });
        const local = manager.addDefault(controller());
        const remote = manager.addRemote(controller(), { kernel_id: 'remote', kernel_label: 'K15', clientId: 'other-window' });
        assert.strictEqual(allocated, 1, 'remote proxies never allocate local leases');
        assert.strictEqual(remote.label, 'K15');
        assert.throws(() => manager.rename(local.id, 'k15'), /already in use/);
        manager.releaseLabels();
        assert.deepStrictEqual(released, [local.id], 'window shutdown releases only its own kernels');

        const persisted = {};
        const managed = new KernelManager({ workspaceState: {
            get: (key, fallback) => persisted[key] ?? fallback,
            update: async (key, value) => { persisted[key] = value; },
        } }, {
            labelAllocator: registry.reserveKernelLabel, labelReleaser: registry.releaseKernelLabel,
            labelRenamer: registry.renameKernelLabel,
        });
        const entry = managed.addDefault(controller());
        assert.throws(() => managed.rename(entry.id, owner.label), /already in use/);
        assert.strictEqual(entry.controller.kernelIdentity.label, entry.label);
        managed.rename(entry.id, 'Analysis');
        assert.strictEqual(persisted['wolfbook.defaultKernelLabel.v1'], 'Analysis');
        assert.strictEqual(registry.reserveKernelLabel(entry.id), 'Analysis');
        // An old host may have released this lease and let another claim it.
        registry.releaseKernelLabel(entry.id);
        registry.reserveKernelLabel('old-host-reused-label', 'Analysis');
        managed.reconcileLabels();
        assert.notStrictEqual(entry.label, 'Analysis');
        assert.strictEqual(entry.controller.kernelIdentity.label, entry.label);
        assert.strictEqual(persisted['wolfbook.defaultKernelLabel.v1'], entry.label);
        const damaged = JSON.parse(fs.readFileSync(file));
        damaged.find(item => item.kernelId === entry.id).label = owner.label;
        fs.writeFileSync(file, JSON.stringify(damaged));
        managed.reconcileLabels();
        assert.notStrictEqual(entry.label, owner.label, 'repair duplicate leases left by an old host');

        // A delayed discovery heartbeat must not undo an owner's repaired name.
        const extension = fs.readFileSync(path.join(__dirname, '../../extension.js'), 'utf8');
        const start = extension.indexOf('const _liveKernelTopology = () => {');
        const end = extension.indexOf('const _remoteKernelDescriptors', start);
        const topology = require('vm').runInNewContext(`${extension.slice(start, end)}; _liveKernelTopology()`, {
            process: { pid: process.pid }, kernelManager: managed,
            _listLiveWindows: () => [{ pid: process.pid, kernels: [{ kernel_id: entry.id, kernel_label: 'stale-name' }] }],
        });
        assert.strictEqual(topology[0].kernel_label, entry.label);
        managed.releaseLabels();

        const corrupt = path.join(tmp, 'corrupt.json');
        fs.writeFileSync(corrupt, '[truncated');
        assert.throws(() => createLabelRegistry(corrupt).reserveKernelLabel('unsafe'), SyntaxError,
            'corrupt registry must not silently discard live reservations');
        assert.strictEqual(fs.readFileSync(corrupt, 'utf8'), '[truncated');
        console.log('Global kernel labels: concurrent allocation, foreign release, remote proxies, rename collisions, persistence, and corrupt registry passed.');
    } finally {
        await Promise.all(workers.map(async child => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exit = once(child, 'exit'); child.kill(); await exit;
        }));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
