'use strict';

// Stability: notebook ↔ kernel bindings across the in-memory → tab transition.
//
// An agent can open a notebook with no editor (resolveNotebookDocument), bind it
// to an isolated kernel and run cells there. When the user then opens it as a
// tab, VS Code selects a controller for it, and extension.js turns that
// selection into kernelManager.bind(). Two failures lived here:
//
//   * bind() to the kernel the notebook ALREADY uses threw "Cannot rebind while
//     the source or destination kernel is busy" — so opening the tab mid-run
//     toasted "Cannot select Wolfram K2" for a no-op;
//   * an MCP bind only updated the manager's map, never VS Code's controller
//     affinity, so the first tab could land on K1 — the kernel holding none of
//     the notebook's definitions. kernel/affinity.js keeps them in step.

const assert = require('assert');
const { KernelManager } = require('../manager');
const { syncBindingAffinities } = require('../affinity');

const Affinity = { Default: 1, Preferred: 2 };

function controller(label) {
    const c = {
        label, busy: false,
        _controller: { label, affinity: new Map(), updateNotebookAffinity(nb, a) { this.affinity.set(nb.uri.fsPath, a); } },
        kernelStatusString: 'resolved',
        launchKernel: async () => {}, quitKernel: async () => {}, dispose: () => {},
    };
    c.arbiter = { status: () => ({ lifecycle: c.busy ? 'busy' : 'idle', busy: c.busy }) };
    return c;
}
const doc = fsPath => ({ notebookType: 'extended-wolfram-notebook', uri: { fsPath, toString: () => `file://${fsPath}` } });

(async () => {
    const persisted = {};
    const context = { workspaceState: { get: (k, d) => (k in persisted ? persisted[k] : d), update: async (k, v) => { persisted[k] = v; } } };
    const c1 = controller('K1');
    const manager = new KernelManager(context, { experimental: true, maximum: 3, factory: async () => controller('iso') });
    const k1 = manager.addDefault(c1);
    const k2 = await manager.create();

    const nbPath = '/tmp/stab/agent.wb';
    await manager.bind(nbPath, k2.id);

    // ---- 1. Re-selecting the SAME kernel while it is busy is a no-op, not an error.
    k2.controller.busy = true;
    await manager.bind(nbPath, k2.id);   // the tab-open path; used to throw
    assert.strictEqual(manager.bindingFor(nbPath).id, k2.id, 'binding unchanged');

    // Unbound notebook on the busy default kernel, same story (single-kernel case).
    c1.busy = true;
    await manager.bind('/tmp/stab/fresh.wb', k1.id);
    c1.busy = false;

    // ---- 2. A real MOVE while busy is still refused — that guard is load-bearing.
    await assert.rejects(manager.bind(nbPath, k1.id), /busy/, 'moving off a busy kernel must be refused');
    k2.controller.busy = false;

    // ---- 3. Affinity follows the binding, for every open notebook.
    const vscode = {
        NotebookControllerAffinity: Affinity,
        workspace: { notebookDocuments: [doc(nbPath), doc('/tmp/stab/other.wb'),
            { notebookType: 'jupyter-notebook', uri: { fsPath: '/tmp/x.ipynb' } }] },
    };
    // Wired exactly like extension.js: every manager change re-syncs.
    manager.onDidChange(() => syncBindingAffinities(vscode, manager));
    await manager.bind(nbPath, k2.id);   // what wolfbook_kernelManager bind does
    manager._emit();
    assert.strictEqual(k2.controller._controller.affinity.get(nbPath), Affinity.Preferred, 'bound kernel is Preferred');
    assert.strictEqual(c1._controller.affinity.get(nbPath), Affinity.Default, 'the default kernel steps back');
    assert.strictEqual(c1._controller.affinity.get('/tmp/stab/other.wb'), Affinity.Preferred,
        'an unbound notebook stays with the default kernel');
    assert.ok(!c1._controller.affinity.has('/tmp/x.ipynb'), 'foreign notebook types are untouched');

    // Unbind → back to the default kernel.
    await manager.unbind(nbPath);
    assert.strictEqual(c1._controller.affinity.get(nbPath), Affinity.Preferred, 'unbind returns it to K1');
    assert.strictEqual(k2.controller._controller.affinity.get(nbPath), Affinity.Default);

    // A controller that throws (disposed mid-sync) must not stop the others.
    k2.controller._controller.updateNotebookAffinity = () => { throw new Error('disposed'); };
    await manager.bind(nbPath, k1.id);
    assert.strictEqual(c1._controller.affinity.get(nbPath), Affinity.Preferred, 'sync survives a throwing controller');

    console.log('stability-bindings: all assertions passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
