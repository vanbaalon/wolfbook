'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { KernelManager } = require('../manager');
const { createKernelPicker } = require('../picker');

const doc = path => ({ notebookType: 'extended-wolfram-notebook', uri: {
    fsPath: path, toString: () => `file://${path}` } });
function controller() {
    const c = { selectedNotebooks: new Set(), busy: false, affinity: new Map(),
        launchKernel: async () => {}, quitKernel: async () => {}, dispose() {} };
    c._controller = { updateNotebookAffinity: (nb, value) => c.affinity.set(nb, value) };
    c.arbiter = { status: () => ({ busy: c.busy, lifecycle: c.busy ? 'busy' : 'idle' }) };
    return c;
}
async function fixture(maximum = 3) {
    const persisted = {}, calls = { selections: [], warnings: [], info: [], config: [], factories: 0, tracks: [] };
    let failPersist = false, failLaunch = false, time = 1000;
    const context = { workspaceState: { get: (k, d) => persisted[k] ?? d,
        update: async (k, v) => { if (failPersist) throw Error('storage failed'); persisted[k] = v; } } };
    const manager = new KernelManager(context, { maximum, factory: async () => {
        calls.factories++; const c = controller();
        c.launchKernel = async () => { if (failLaunch) throw Error('license unavailable'); };
        return c;
    } });
    const shared = manager.addDefault(controller());
    const assigned = await manager.create();
    const nb = doc('/tmp/picker/assigned.wb');
    await manager.bind(nb, assigned.id);
    assigned.controller.selectedNotebooks.add(nb);
    const vscode = { NotebookControllerAffinity: { Preferred: 2, Default: 1 }, ConfigurationTarget: { Workspace: 2 },
        window: { activeNotebookEditor: { notebook: nb },
            showWarningMessage: async (...args) => { calls.warnings.push(args); return undefined; },
            showInformationMessage: message => calls.info.push(message) },
        workspace: { getConfiguration: () => ({ update: async (...args) => calls.config.push(args) }) } };
    const picker = createKernelPicker(vscode, manager, { now: () => time,
        track: entry => calls.tracks.push(entry), associate: async (ctrl, notebook, options) => {
            calls.selections.push({ ctrl, notebook, options }); return { associated: true };
        } });
    const event = (entry, selected, notebook = nb) => picker.selectionChanged(entry, { selected, notebook });
    return { manager, shared, assigned, nb, vscode, picker, event, calls, persisted,
        advance: ms => { time += ms; }, failPersist: () => { failPersist = true; }, failLaunch: () => { failLaunch = true; } };
}

test('native picker can replace an explicitly saved binding (old deselection first)', async () => {
    const f = await fixture();
    f.assigned.controller.selectedNotebooks.delete(f.nb);
    await f.event(f.assigned, false);
    await f.event(f.shared, true);
    assert.equal(f.manager.bindingFor(f.nb), f.shared);
    assert.equal(f.calls.warnings.length, 0);
    assert.ok(Object.values(f.persisted['wolfbook.kernelBindings.v1']).includes('default'));
    assert.equal(f.assigned.controller.affinity.get(f.nb), 1);
    assert.equal(f.shared.controller.affinity.get(f.nb), 2);
});
test('switch also works when the new controller event arrives first', async () => {
    const f = await fixture();
    await f.event(f.shared, true);
    await f.event(f.assigned, false);
    assert.equal(f.manager.bindingFor(f.nb), f.shared);
});
test('initial automatic K1 selection cannot steal a private binding', async () => {
    const f = await fixture();
    f.assigned.controller.selectedNotebooks.clear();
    await f.event(f.shared, true);
    assert.equal(f.manager.bindingFor(f.nb), f.assigned);
    assert.equal(f.calls.selections[0].ctrl, f.assigned.controller);
    assert.equal(f.calls.selections[0].options.allowReveal, false);
});
test('background, expired, closed and reopened notebooks cannot reuse picker intent', async () => {
    for (const mode of ['background', 'expired', 'closed', 'reopened']) {
        const f = await fixture();
        f.assigned.controller.selectedNotebooks.clear();
        await f.event(f.assigned, false);
        if (mode === 'background') f.vscode.window.activeNotebookEditor = { notebook: doc('/tmp/other.wb') };
        if (mode === 'expired') f.advance(2001);
        if (mode === 'closed') { f.picker.forget(f.nb); f.nb.isClosed = true; }
        const nb = mode === 'reopened' ? doc(f.nb.uri.fsPath) : f.nb;
        if (mode === 'reopened') f.vscode.window.activeNotebookEditor = { notebook: nb };
        await f.event(f.shared, true, nb);
        assert.equal(f.manager.bindingFor(nb), f.assigned, mode);
    }
});
test('busy source/destination and persistence failure restore selection and binding', async () => {
    for (const mode of ['source', 'destination', 'storage']) {
        const f = await fixture();
        if (mode === 'source') f.assigned.controller.busy = true;
        if (mode === 'destination') f.shared.controller.busy = true;
        if (mode === 'storage') f.failPersist();
        await f.event(f.shared, true);
        assert.equal(f.manager.bindingFor(f.nb), f.assigned);
        assert.equal(f.calls.selections.at(-1).ctrl, f.assigned.controller);
        assert.match(f.calls.warnings.at(-1)[0], mode === 'storage' ? /storage failed/ : /busy/);
    }
});
test('unavailable bindings remain unavailable instead of falling back to default', async () => {
    const f = await fixture();
    f.manager._entries.delete(f.assigned.id);
    await f.event(f.shared, true);
    assert.equal(f.manager.bindingFor(f.nb), null);
    assert.equal(f.calls.selections.length, 0);
});
test('deliberate switch to a remote kernel persists its slot, without moving other notebooks', async () => {
    const f = await fixture(); const other = doc('/tmp/picker/other.wb');
    await f.manager.bind(other, f.assigned.id);
    const remote = f.manager.addRemote(controller(), { kernel_id: 'remote-k4', kernel_label: 'K4',
        clientId: 'another-window', kernel_slot: 'default' });
    await f.event(remote, true);
    assert.equal(f.manager.bindingFor(f.nb), remote);
    assert.equal(f.manager.bindingFor(other), f.assigned);
});
test('creation above the recommendation requires no settings change', async () => {
    const f = await fixture(2);
    f.vscode.window.showWarningMessage = async (...args) => { f.calls.warnings.push(args); return args[2]; };
    const created = await f.picker.start(f.nb);
    assert.ok(created);
    assert.deepEqual(f.calls.config, []);
    assert.equal(f.manager.maximum, 2);
    assert.equal(f.manager.bindingFor(f.nb), created);
    assert.equal(f.calls.tracks[0], created);
    assert.equal(f.calls.selections[0].notebook, f.nb);
    assert.equal(f.calls.warnings[0][2], 'Start Kernel');
    assert.match(f.calls.warnings[0][0], /recommended/);
    assert.equal(f.manager.capacity().above_recommended, true);
    assert.match(f.calls.info[0], /Started and selected/);
});
test('cancelling creation restores the binding and never launches or changes limits', async () => {
    const f = await fixture(2); const before = f.calls.factories;
    assert.equal(await f.picker.start(f.nb), null);
    assert.equal(f.calls.factories, before);
    assert.equal(f.calls.config.length, 0);
    assert.equal(f.manager.bindingFor(f.nb), f.assigned);
    assert.equal(f.calls.selections[0].ctrl, f.assigned.controller);
});
test('pending confirmation prevents duplicate launches and preserves exact notebook target', async () => {
    const f = await fixture(); let confirm;
    f.vscode.window.showWarningMessage = () => new Promise(resolve => { confirm = resolve; });
    const pending = f.picker.start(f.nb);
    assert.equal(await f.picker.start(f.nb), null);
    f.vscode.window.activeNotebookEditor = { notebook: doc('/tmp/another-tab.wb') };
    confirm('Start Kernel');
    const created = await pending;
    assert.equal(f.manager.bindingFor(f.nb), created);
    assert.equal(f.calls.selections[0].notebook, f.nb);
    assert.equal(f.calls.selections[0].options.allowReveal, false);
    assert.equal(f.calls.factories, 2);
});
test('failed launch cleans up and restores the previous controller with an actionable error', async () => {
    const f = await fixture(); f.failLaunch();
    f.vscode.window.showWarningMessage = async (...args) => { f.calls.warnings.push(args); return args[2]; };
    assert.equal(await f.picker.start(f.nb), null);
    assert.equal(f.manager.size, 2);
    assert.equal(f.manager.bindingFor(f.nb), f.assigned);
    assert.equal(f.calls.selections.at(-1).ctrl, f.assigned.controller);
    assert.match(f.calls.warnings.at(-1)[0], /license unavailable/);
    assert.equal(f.calls.info.length, 0);
});
test('creation refuses a busy binding before launching or raising limits', async () => {
    const f = await fixture(2); f.assigned.controller.busy = true;
    const before = f.calls.factories;
    assert.equal(await f.picker.start(f.nb), null);
    assert.equal(f.calls.factories, before);
    assert.equal(f.calls.config.length, 0);
    assert.equal(f.calls.selections[0].ctrl, f.assigned.controller);
    assert.match(f.calls.warnings[0][0], /busy/);
});
test('creation does not depend on writable settings', async () => {
    const f = await fixture(2);
    f.vscode.window.showWarningMessage = async (...args) => args[2];
    f.vscode.workspace.getConfiguration = () => { throw Error('settings unavailable'); };
    assert.ok(await f.picker.start(f.nb));
    assert.equal(f.manager.maximum, 2);
    assert.equal(f.calls.factories, 2);
});
test('background association is reported as assigned, not falsely selected', async () => {
    const f = await fixture();
    f.vscode.window.showWarningMessage = async (...args) => args[2];
    const picker = createKernelPicker(f.vscode, f.manager, { associate: async () => ({ associated: false }) });
    const entry = await picker.start(f.nb);
    assert.equal(f.manager.bindingFor(f.nb), entry);
    assert.match(f.calls.info[0], /assigned/);
    assert.doesNotMatch(f.calls.info[0], /and selected/);
});
test('remote controllers do not consume local capacity, and counts above 8 are allowed', async () => {
    const f = await fixture(3);
    f.manager.addRemote(controller(), { kernel_id: 'remote', clientId: 'another-window' });
    f.vscode.window.showWarningMessage = async (...args) => { f.calls.warnings.push(args); return args[2]; };
    assert.ok(await f.picker.start(f.nb));
    assert.equal(f.calls.config.length, 0);
    assert.equal(f.calls.warnings[0][2], 'Start Kernel');
    const ceiling = await fixture(8);
    while (ceiling.manager.size < 8) await ceiling.manager.create();
    ceiling.vscode.window.showWarningMessage = async (...args) => { ceiling.calls.warnings.push(args); return args[2]; };
    assert.ok(await ceiling.picker.start(ceiling.nb));
    assert.match(ceiling.calls.warnings[0][0], /recommended/);
    assert.equal(ceiling.manager.capacity().local_kernels, 9);
    assert.equal(ceiling.calls.config.length, 0);
    assert.equal(ceiling.calls.factories, 8);
});
