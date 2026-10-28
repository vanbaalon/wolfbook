'use strict';

const vscode = require('vscode');
const path = require('path');
const pendingSaves = new WeakMap();
const reportedFailures = new WeakSet();

function skipReason(cell, outcome) {
    if (outcome.aborted || outcome.failed || outcome.hasMessages || outcome.stale) return 'not-clean';
    const notebook = cell?.notebook;
    if (!notebook || notebook.isClosed || cell.document?.isClosed) return 'closed';
    if (notebook.isUntitled || notebook.uri?.scheme === 'untitled') return 'untitled';
    if (!/\.(wb|evsnb|vsnb)$/i.test(notebook.uri?.fsPath || notebook.uri?.path || '') ||
        notebook.metadata?.wolfbookNbImport || typeof notebook.save !== 'function') return 'unsupported';
    if (cell.kind !== vscode.NotebookCellKind.Code) return 'not-code';
    // An edit made during evaluation must not be saved under an old clean result.
    try {
        if (typeof outcome.source !== 'string' || cell.document.getText() !== outcome.source) return 'stale';
        if (notebook.cellAt(cell.index).document.uri.toString() !== cell.document.uri.toString()) return 'stale';
    } catch (_) { return 'stale'; }
    if (notebook.isDirty === false) return 'already-saved';
    return null;
}

/** Save through VS Code after a completed clean evaluation, without opening UI. */
async function saveAfterCleanCell(cell, outcome = {}, log) {
    const skipped = skipReason(cell, outcome);
    if (skipped) return { saved: false, reason: skipped };
    const notebook = cell.notebook;
    // Serialize saves of the same document. A later completed cell still gets a
    // save after an earlier in-flight snapshot, so its outputs are not lost.
    const previous = pendingSaves.get(notebook) || Promise.resolve();
    const save = previous.then(async () => {
        // Let execution.end() flush before asking VS Code to serialize the model.
        await new Promise(resolve => setImmediate(resolve));
        const reason = skipReason(cell, outcome);
        if (reason) return { saved: false, reason };
        try {
            if (await notebook.save()) {
                reportedFailures.delete(notebook);
                return { saved: true };
            }
            throw new Error('VS Code did not complete the save.');
        } catch (error) {
            const name = path.basename(notebook.uri.fsPath || notebook.uri.path);
            try { log?.(`[autosave] ${name}: ${error.message || error}`); } catch (_) {}
            if (!reportedFailures.has(notebook)) {
                reportedFailures.add(notebook);
                try {
                    void Promise.resolve(vscode.window.showWarningMessage(
                        `Wolfbook could not automatically save ${name}: ${error.message || error}`
                    )).catch(() => {});
                } catch (_) {}
            }
            // A failed disk save must not turn a successful kernel result into a
            // failed cell, nor stop the remaining execution queue.
            return { saved: false, reason: 'save-failed' };
        }
    });
    pendingSaves.set(notebook, save);
    try { return await save; }
    finally { if (pendingSaves.get(notebook) === save) pendingSaves.delete(notebook); }
}

module.exports = { saveAfterCleanCell };
