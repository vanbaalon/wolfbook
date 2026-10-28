'use strict';

// Keep VS Code's controller affinity in step with KernelManager bindings.
//
// Cells run on whichever controller VS Code has SELECTED for a notebook, but a
// binding made outside the kernel picker (wolfbook_kernelManager bind/create/
// default/unbind, a .tex binding) only updated the manager's map. An in-memory
// notebook an agent had moved to K2 therefore got its first tab on K1 — the
// kernel holding none of its definitions. Affinity never overrides a selection
// already made; it decides what VS Code picks when a notebook needs one, which
// is exactly the moment an in-memory notebook is first shown.

const NB_TYPE = 'extended-wolfram-notebook';

function syncBindingAffinities(vscode, manager) {
    let updated = 0;
    const owners = new Set();
    for (const nb of vscode.workspace.notebookDocuments || []) {
        if (nb.notebookType !== NB_TYPE) continue;
        const owner = manager.bindingFor(nb.uri.fsPath);
        if (!owner) continue;
        owners.add(owner.controller);
        for (const entry of manager._entries.values()) {
            try {
                entry.controller._controller.updateNotebookAffinity(nb, entry.id === owner.id
                    ? vscode.NotebookControllerAffinity.Preferred
                    : vscode.NotebookControllerAffinity.Default);
                updated++;
            } catch (_) {}
        }
    }
    // Rebinding an already visible notebook need not fire a visibility or
    // controller-selection event. Affinity alone leaves its old offline filter
    // in place even after a successful run on an already running kernel.
    for (const controller of owners) controller._syncKernelRendererState?.();
    return updated;
}

module.exports = { syncBindingAffinities };
