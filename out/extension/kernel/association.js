'use strict';

// Controller ↔ notebook association (the phantom-run fix, extracted from
// oberon/core/wolframShim.js so the MCP cell pipeline shares one copy).
//
// updateNotebookAffinity(Preferred) alone does NOT trigger
// onDidChangeSelectedNotebooks for a notebook that is open but not the active
// editor — VS Code only auto-selects on affinity when the notebook is shown and
// active. Without a real selection event, createNotebookCellExecution() throws
// "not associated", the 3-second recovery in execute() times out, and the cell
// is silently skipped while the caller reports success.
//
// notebook.selectKernel operates on the ACTIVE notebook editor only — there is
// no per-document form — so association must (transiently) make the target
// notebook the active tab. Never call notebook.selectKernel with NO argument
// from agent code: that opens the kernel picker UI, a modal an agent can never
// dismiss.

/** Is the wolfbook controller selected for this notebook document? */
function isAssociated(ctrl, nbDoc) {
    return !!ctrl?.selectedNotebooks?.has?.(nbDoc);
}

/**
 * Ensure `ctrl` (a WolframNotebookKernel) is associated with `nbDoc` so that
 * createNotebookCellExecution() succeeds. Never throws.
 *
 * @param {object} ctrl   WolframNotebookKernel (has ._controller, .selectedNotebooks)
 * @param {import('vscode').NotebookDocument} nbDoc
 * @param {{ restoreActive?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<{associated: boolean, method: string, elapsedMs: number}>}
 */
async function associateNotebook(ctrl, nbDoc, opts = {}) {
    const started = Date.now();
    const done = (associated, method) =>
        ({ associated, method, elapsedMs: Date.now() - started });
    let vscode;
    try { vscode = require('vscode'); } catch (_) { return done(false, 'no-vscode'); }
    if (!ctrl || !ctrl._controller || !nbDoc) return done(false, 'no-controller');
    if (isAssociated(ctrl, nbDoc)) return done(true, 'already');

    const timeoutMs = Math.max(500, Number(opts.timeoutMs) || 3000);
    const previousActive = vscode.window.activeNotebookEditor?.notebook || null;

    try {
        ctrl._controller.updateNotebookAffinity(
            nbDoc, vscode.NotebookControllerAffinity.Preferred);
    } catch (_) {}

    // notebook.selectKernel targets the active editor, so the notebook must be
    // shown first. preserveFocus:true keeps keyboard focus where it is; whether
    // the revealed editor also becomes activeNotebookEditor is version-dependent,
    // hence the preserveFocus:false retry below.
    const attempt = async (preserveFocus) => {
        try {
            await vscode.window.showNotebookDocument(nbDoc, {
                viewColumn: vscode.ViewColumn.Active, preserveFocus,
            });
        } catch (_) {}
        if (isAssociated(ctrl, nbDoc)) return true;
        const nbUri = nbDoc.uri.toString();
        return await new Promise(resolve => {
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                try { d.dispose(); } catch (_) {}
                resolve(ok);
            };
            const d = ctrl._controller.onDidChangeSelectedNotebooks(ev => {
                if (ev.selected && ev.notebook.uri.toString() === nbUri) finish(true);
            });
            vscode.commands.executeCommand('notebook.selectKernel', {
                id:        ctrl._controller.id,
                extension: 'wolfbook.wolfbook',
                label:     ctrl._controller.label,
            }).then(undefined, () => {});
            // Fallback poll in case the event fired before the listener registered.
            const check = () => {
                if (settled) return;
                if (isAssociated(ctrl, nbDoc)) { finish(true); return; }
                setTimeout(check, 50);
            };
            setTimeout(check, 50);
            setTimeout(() => finish(isAssociated(ctrl, nbDoc)), timeoutMs);
        });
    };

    let ok = await attempt(true);
    let method = 'select-kernel';
    if (!ok) {
        ok = await attempt(false);
        method = 'select-kernel-focused';
    }

    // Give the user back the notebook they were looking at.
    if (opts.restoreActive !== false && previousActive && previousActive !== nbDoc) {
        try {
            await vscode.window.showNotebookDocument(previousActive, { preserveFocus: true });
        } catch (_) {}
    }
    return done(ok, ok ? method : 'timeout');
}

module.exports = { associateNotebook, isAssociated };
