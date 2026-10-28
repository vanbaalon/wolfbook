'use strict';

const { associateNotebook, isAssociated } = require('./association');

// VS Code reports controller selection without saying whether it came from a
// user or affinity restoration. Replacing an already selected bound controller
// in the active notebook is a switch; initial association is not. Remember the
// deselection briefly because the old/new controller events can arrive in
// either order. Intent is scoped to one notebook and consumed once.
function createKernelPicker(vscode, manager, { track = () => {}, refresh = () => {},
    associate = associateNotebook, now = Date.now } = {}) {
    const departing = new Map();
    let creating = false;
    const active = notebook => !notebook.isClosed &&
        vscode.window.activeNotebookEditor?.notebook === notebook;
    const key = notebook => notebook.uri.toString();
    const select = async (notebook, entry) => {
        if (!entry?.controller?._controller || notebook.isClosed) return { associated: false };
        return associate(entry.controller, notebook, { allowReveal: false });
    };
    const restore = notebook => new Promise(resolve => setImmediate(async () => {
        // Re-read the binding: an agent may have changed it in the meantime.
        try { await select(notebook, manager.bindingFor(notebook)); } catch (_) {}
        resolve();
    }));
    const selectionChanged = async (entry, event) => {
        const notebook = event.notebook;
        if (notebook.notebookType !== 'extended-wolfram-notebook') return;
        const expected = manager.bindingFor(notebook);
        const uri = key(notebook);
        if (!event.selected) {
            if (active(notebook) && expected?.id === entry.id) {
                for (const [k, intent] of departing) if (now() - intent.at > 2000) departing.delete(k);
                departing.set(uri, { id: entry.id, notebook, at: now() });
            }
            return;
        }
        const intent = departing.get(uri);
        departing.delete(uri);
        const fromKernelId = active(notebook) && expected &&
            ((intent?.id === expected.id && intent.notebook === notebook && now() - intent.at <= 2000) ||
                (expected.id !== entry.id && isAssociated(expected.controller, notebook)))
            ? expected.id : undefined;
        try {
            if (!manager.acceptSelection(notebook, entry.id, { fromKernelId })) {
                await restore(notebook);
                return;
            }
            if (!entry.isDefault || manager.explicitBindingFor(notebook)) await manager.bind(notebook, entry.id);
            const bound = manager.bindingFor(notebook);
            for (const candidate of manager._entries.values()) {
                try {
                    candidate.controller._controller.updateNotebookAffinity(notebook,
                        candidate.id === bound?.id ? vscode.NotebookControllerAffinity.Preferred :
                            vscode.NotebookControllerAffinity.Default);
                } catch (_) {}
            }
            refresh();
        } catch (error) {
            await restore(notebook);
            vscode.window.showWarningMessage(`Cannot select Wolfram ${entry.label}: ${error.message}`);
        }
    };
    const start = async notebook => {
        if (creating || notebook.isClosed) return null;
        creating = true; // Includes the confirmation dialog, not just launch.
        try {
            const checkSource = () => {
                const source = manager.explicitBindingFor(notebook);
                if (source?.controller?.arbiter?.status(source.controller)?.busy)
                    throw new Error(`Cannot switch this notebook while Wolfram ${source.label} is busy; wait for it to finish or abort first.`);
            };
            checkSource();
            const count = [...manager._entries.values()].filter(entry => !entry.remote).length + (manager._allocating || 0);
            const full = count >= manager.maximum;
            const action = 'Start Kernel';
            const confirmation = await vscode.window.showWarningMessage(
                `${full ? `This window has ${count} kernels; the recommended count is ${manager.maximum}. Prefer reusing a repository kernel. ` : ''}Start another Wolfram process? It may consume an additional license seat. This window remembers its assignment after reload and starts it again on first evaluation.`,
                { modal: true }, action);
            if (confirmation !== action || notebook.isClosed) {
                await restore(notebook);
                return null;
            }
            checkSource(); // Work may have started while the dialog was open.
            manager.experimental = true;
            const entry = await manager.createAndBind(notebook.uri.fsPath);
            track(entry);
            const receipt = await select(notebook, entry);
            refresh();
            vscode.window.showInformationMessage(receipt.associated ?
                `Started and selected Wolfram ${entry.label}.` :
                `Started Wolfram ${entry.label} and assigned it to this notebook. Open the notebook to select its controller.`);
            return entry;
        } catch (error) {
            await restore(notebook);
            vscode.window.showWarningMessage(`Could not start a Wolfram kernel: ${error.message}`);
            return null;
        } finally {
            creating = false;
        }
    };
    return { selectionChanged, start, forget: notebook => departing.delete(key(notebook)) };
}

module.exports = { createKernelPicker };
