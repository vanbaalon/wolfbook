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
// Kernel selection commands act on a notebook editor. Target an exact visible
// editor through notebook.selectKernel, even when WPaper has focus. Hidden
// notebooks stay hidden unless the caller explicitly allows opening one.

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
 * @param {{ restoreActive?: boolean, timeoutMs?: number, allowReveal?: boolean, notebookEditor?: import('vscode').NotebookEditor }} opts
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

    const activeIsTarget = () =>
        vscode.window.activeNotebookEditor?.notebook?.uri?.toString() === nbDoc.uri.toString();
    const sameNotebook = editor => editor?.notebook?.uri?.toString() === nbDoc.uri.toString();
    let targetEditor = sameNotebook(opts.notebookEditor) ? opts.notebookEditor : null;
    const visibleTarget = () => targetEditor ||
        (vscode.window.visibleNotebookEditors || []).find(sameNotebook) ||
        (activeIsTarget() ? vscode.window.activeNotebookEditor : null);

    // VS Code's API command translates the exact NotebookEditor to its widget
    // ID. The internal command without that ID targets the active tab instead.
    let selectCommand = '_notebook.selectKernel';
    try {
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes('notebook.selectKernel')) selectCommand = 'notebook.selectKernel';
    } catch (_) {}
    const targeted = selectCommand === 'notebook.selectKernel';
    if (opts.allowReveal === false && !(targeted ? visibleTarget() : activeIsTarget())) {
        return done(isAssociated(ctrl, nbDoc), 'background-selection-pending');
    }

    const attempt = async (preserveFocus) => {
        if (opts.allowReveal !== false && !(targeted ? visibleTarget() : activeIsTarget())) {
            try {
                targetEditor = await vscode.window.showNotebookDocument(nbDoc, {
                    viewColumn: vscode.ViewColumn.Active, preserveFocus, preview: false,
                });
            } catch (_) {}
        }
        if (isAssociated(ctrl, nbDoc)) return true;
        // An asynchronous command lookup/reveal may race with a user switching
        // to WPaper. Never select a kernel against the wrong active tab.
        const editor = targeted ? visibleTarget() : null;
        if (targeted ? !editor : !activeIsTarget()) return false;
        const nbUri = nbDoc.uri.toString();
        return await new Promise(resolve => {
            let settled = false;
            let subscription, poll, deadline;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(poll);
                clearTimeout(deadline);
                try { subscription?.dispose(); } catch (_) {}
                resolve(ok);
            };
            subscription = ctrl._controller.onDidChangeSelectedNotebooks(ev => {
                if (ev.selected && ev.notebook.uri.toString() === nbUri) finish(true);
            });
            const check = () => {
                if (settled) return;
                if (isAssociated(ctrl, nbDoc)) { finish(true); return; }
                poll = setTimeout(check, 50);
            };
            poll = setTimeout(check, 50);
            deadline = setTimeout(() => finish(isAssociated(ctrl, nbDoc)), timeoutMs);
            try {
                // Set up timers first: selection can synchronously fire while
                // executeCommand is called, and finish must clear every timer.
                Promise.resolve(vscode.commands.executeCommand(selectCommand, {
                    id: ctrl._controller.id,
                    extension: 'wolfbook.wolfbook',
                    label: ctrl._controller.label,
                    ...(targeted ? { notebookEditor: editor } : {}),
                })).catch(() => finish(isAssociated(ctrl, nbDoc)));
            } catch (_) { finish(isAssociated(ctrl, nbDoc)); }
        });
    };

    let ok = await attempt(true);
    let method = 'select-kernel';
    if (!ok && opts.allowReveal !== false) {
        ok = await attempt(false);
        method = 'select-kernel-focused';
    }

    // Give the user back the notebook they were looking at.
    if (opts.allowReveal !== false && opts.restoreActive !== false && previousActive && previousActive !== nbDoc) {
        try {
            await vscode.window.showNotebookDocument(previousActive, { preserveFocus: true });
        } catch (_) {}
    }
    return done(ok, ok ? method : 'timeout');
}

module.exports = { associateNotebook, isAssociated };
