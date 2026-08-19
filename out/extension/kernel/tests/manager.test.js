'use strict';

const assert = require('assert');
const { KernelManager, canonicalNotebook } = require('../manager');

function controller() {
    return {
        _controller: { label: 'initial' },
        kernelStatusString: 'resolved',
        arbiter: { status: () => ({ lifecycle: 'idle', busy: false }) },
        launchKernel: async () => {}, quitKernel: async () => {}, dispose: () => {},
    };
}

(async () => {
    const persisted = {};
    const context = { workspaceState: {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(persisted, key) ? persisted[key] : fallback,
        update: async (key, value) => { persisted[key] = value; },
    } };
    const manager = new KernelManager(context, { experimental: true, maximum: 2, factory: async () => controller() });
    const k1 = manager.addDefault(controller());
    assert.match(k1.id, /^k-[0-9a-f]{8}$/);
    assert.strictEqual(k1.controller._controller.label, 'Wolfram K1');
    assert.strictEqual(manager.bindingFor('/tmp/a.wb').id, k1.id);
    const k2 = await manager.create();
    assert.strictEqual(k2.controller._controller.label, 'Wolfram K2');
    await manager.bind('/tmp/a.wb', k2.id);
    assert.strictEqual(manager.resolve({ notebook: '/tmp/a.wb', kernel_id: k2.id }).id, k2.id);
    assert.throws(() => manager.resolve({ notebook: '/tmp/a.wb', kernel_id: k1.id }), /target changed/i);
    assert.throws(() => manager.resolve({ notebook: '/tmp/a.wb', requireExplicit: true }), /kernel_id is required/i);
    assert.strictEqual(manager.rename(k2.id, 'Solver').kernel_label, 'Solver');
    assert.strictEqual(k2.controller._controller.label, 'Wolfram Solver');
    assert.strictEqual(manager.list(['/tmp/a.wb'])[1].notebooks.length, 1);
    await manager.unbind('/tmp/a.wb');
    assert.strictEqual(manager.bindingFor('/tmp/a.wb').id, k1.id);
    await assert.rejects(manager.create(), /limit reached/i);
    assert.strictEqual(canonicalNotebook('/tmp/a.wb/'), canonicalNotebook('/tmp/a.wb'));

    // Logical slots, unlike runtime kernel IDs, survive an extension-host
    // reload and recreate both the extra process and notebook association.
    await manager.bind('/tmp/persist.wb', k2.id);
    const oldRuntimeId = k2.id;
    const managerReloaded = new KernelManager(context, { experimental: false, maximum: 2, factory: async () => controller() });
    managerReloaded.addDefault(controller());
    const restored = await managerReloaded.restore();
    assert.strictEqual(restored.length, 1);
    assert.notStrictEqual(restored[0].id, oldRuntimeId);
    assert.strictEqual(managerReloaded.explicitBindingFor('/tmp/persist.wb').id, restored[0].id);
    assert.strictEqual(restored[0].slotKey, k2.slotKey);
    await managerReloaded.stop(restored[0].id);
    const managerAfterStop = new KernelManager(context, { maximum: 2, factory: async () => controller() });
    managerAfterStop.addDefault(controller());
    assert.deepStrictEqual(await managerAfterStop.restore(), []);
    assert.strictEqual(managerAfterStop.explicitBindingFor('/tmp/persist.wb'), null);

    // A shared allocator gives separate extension hosts distinct presentation
    // numbers while their opaque IDs remain unrelated.
    let globalNumber = 0;
    const allocate = () => `K${++globalNumber}`;
    const managerA = new KernelManager(null, { labelAllocator: allocate });
    const managerB = new KernelManager(null, { labelAllocator: allocate });
    assert.strictEqual(managerA.addDefault(controller()).label, 'K1');
    assert.strictEqual(managerB.addDefault(controller()).label, 'K2');

    const remoteController = controller();
    const remote = managerA.addRemote(remoteController, {
        kernel_id: 'k-remote01', kernel_label: 'K9', clientId: 'VSCode[other]',
        generation: 'g1', workerPort: 27184,
    });
    assert.strictEqual(remote.remote, true);
    assert.strictEqual(managerA.describe(remote).owner_client_id, 'VSCode[other]');
    assert.throws(() => managerA.rename(remote.id, 'wrong-owner'), /owning VS Code window/i);
    await managerA.stop(remote.id);
    assert.strictEqual(managerA.get(remote.id), null, 'stopping a proxy detaches it without owning the remote process');

    // Separate entries can make progress concurrently; notebooks resolved to
    // the same entry share that controller's serial queue.
    let concurrent = 0, peak = 0;
    const task = async () => { concurrent++; peak = Math.max(peak, concurrent); await new Promise(r => setTimeout(r, 15)); concurrent--; };
    await Promise.all([task.call(k1.controller), task.call(k2.controller)]);
    assert.strictEqual(peak, 2);
    let chain = Promise.resolve(), serialPeak = 0;
    const serial = () => chain = chain.then(async () => { concurrent++; serialPeak = Math.max(serialPeak, concurrent); await new Promise(r => setTimeout(r, 5)); concurrent--; });
    await Promise.all([serial(), serial()]);
    assert.strictEqual(serialPeak, 1);

    // ── Phase 2 (2026-08-18 feedback): registry GC + op-id resolution ──
    // removeRemote drops size so the requireExplicit guard stops firing.
    const gc = new KernelManager(null, { labelAllocator: allocate });
    const gcDefault = gc.addDefault(controller());
    const gcRemote = gc.addRemote(controller(), {
        kernel_id: 'k-dead0001', kernel_label: 'K7', clientId: 'VSCode[gone]',
        generation: 'g-dead', workerPort: 27190,
    });
    assert.strictEqual(gc.size, 2);
    assert.throws(() => gc.resolve({ requireExplicit: true }), /kernel_id is required/i);
    assert.strictEqual(gc.removeRemote(gcRemote.id), true);
    assert.strictEqual(gc.size, 1);
    assert.strictEqual(gc.resolve({ requireExplicit: true }).id, gcDefault.id,
        'single live kernel resolves without kernel_id after GC');

    // The multi-kernel error is actionable: it names the live kernels.
    const gcRemote2 = gc.addRemote(controller(), {
        kernel_id: 'k-dead0002', kernel_label: 'K8', clientId: 'VSCode[other]',
        generation: 'g2', workerPort: 27191,
    });
    try {
        gc.resolve({ requireExplicit: true });
        assert.fail('expected throw');
    } catch (err) {
        assert.strictEqual(err.code, 'KERNEL_ID_REQUIRED');
        assert.match(err.message, /k-dead0002/);
        assert.match(err.message, /Pass kernel_id/);
        assert.ok(Array.isArray(err.kernels));
    }

    // findEntryByOperation locates the owning kernel from the op id alone.
    gcDefault.operations = { get: id => (id === 'op-a' ? { id } : null) };
    gcRemote2.operations = { get: id => (id === 'op-b' ? { id } : null) };
    assert.strictEqual(gc.findEntryByOperation('op-b').id, gcRemote2.id);
    assert.strictEqual(gc.findEntryByOperation('op-a').id, gcDefault.id);
    assert.strictEqual(gc.findEntryByOperation('op-missing'), null);
    assert.strictEqual(gc.findControllerByOperation('op-b'), gcRemote2.controller);

    console.log('kernel manager tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
