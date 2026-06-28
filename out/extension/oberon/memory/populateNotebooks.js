'use strict';
/**
 * Oberon — populate research notebooks (charm findings + quest summary).
 *
 * Single source of truth for the post-pipeline notebook population step.
 * Used by BOTH paths:
 *   - User-initiated runs (out/extension/oberon/index.js)
 *   - Test-suite runs    (out/extension/oberon/core/research.js)
 *
 * Crucial invariant: this code MUST NOT edit the `.wb` JSON on disk
 * directly. The flow is always:
 *   1. `prepareCharmNotebook` / `prepareSummaryNotebook` write an empty
 *      `.wb` skeleton (`{"cells":[],"metadata":{...}}`).
 *   2. We open it via `vscode.workspace.openNotebookDocument(uri)`.
 *   3. Cells are inserted via the VS Code Notebook API
 *      (`WorkspaceEdit.insertCells` / `NotebookEdit.insertCells`).
 *   4. We `save()` and (optionally) close the notebook tab.
 *
 * Any failure is recorded as a structured `omen` event on the telemetry
 * bus so regressions become visible in the Control Room. Never throws.
 */

const vscode = require('vscode');
const { prepareCharmNotebook, buildCharmTrailerCells, getCharmNotebookPath } = require('./charmNotebook');
const { prepareSummaryNotebook } = require('./summaryNotebook');

/**
 * Populate the charm findings notebook and the quest summary notebook.
 *
 * @param {{
 *   quest:      object,
 *   charm:      object,
 *   scroll:     object,
 *   reviewOut?: object | null,
 *   bus?:       { appendEvent: Function } | null,
 *   show?:      boolean,              // default true — pop the tab open
 *   closeCharm?: boolean,             // default true — close charm tab when not dirty
 *   existingCharmNotebookPath?: string | null,  // path from Fairy's notebookWriter (if any)
 * }} opts
 * @returns {Promise<{ charmNotebookPath: string|null, summaryNotebookPath: string|null }>}
 */
async function populateResearchNotebooks(opts) {
    const {
        quest, charm, scroll,
        reviewOut = null,
        bus = null,
        show = true,
        closeCharm = true,
        existingCharmNotebookPath = null,
    } = opts || {};

    let charmNotebookPath   = null;
    let summaryNotebookPath = null;

    const meta = { questId: quest && quest.id, charmId: charm && charm.id };

    // ── Step 1: Charm findings notebook ───────────────────────────────────
    try {
        // When the Fairy has already written live cells into the notebook via
        // notebookWriter, NEVER overwrite the skeleton — that would erase all
        // the live cells. Instead, detect cells via existingCharmNotebookPath
        // and append only the findings/verdict trailer at the end.
        //
        // Guard: if the Fairy failed without calling wolfram_eval (no notebookPath),
        // but the charm notebook file already exists on disk (from a prior run),
        // use it in APPEND MODE so a failed rerun never erases previous work.
        let candPath = existingCharmNotebookPath;
        if (!candPath) {
            const defaultPath = getCharmNotebookPath({ quest, charm });
            if (defaultPath) {
                try {
                    const fsp = require('fs/promises');
                    const stat = await fsp.stat(defaultPath);
                    if (stat.size > 50) candPath = defaultPath; // file exists and has content
                } catch (_) { /* file doesn't exist — fresh run, proceed normally */ }
            }
        }
        let hasLiveCells = false;
        let nbDoc = null;

        if (candPath) {
            try {
                nbDoc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(candPath));
                hasLiveCells = nbDoc.cellCount > 0;
                charmNotebookPath = candPath;
            } catch (_) {
                hasLiveCells = false;
            }
        }

        if (hasLiveCells && nbDoc) {
            // APPEND MODE — live cells already present from Fairy's notebookWriter.
            // Append only the verdict/findings trailer at the end.
            if (show) {
                try { await vscode.window.showNotebookDocument(nbDoc, { preserveFocus: false }); } catch (_) {}
            }
            const trailerDescriptors = buildCharmTrailerCells({ quest, charm, scroll, reviewOut });
            const trailerCells = trailerDescriptors.map(c =>
                new vscode.NotebookCellData(
                    c.kind === 1 ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
                    c.value,
                    c.languageId,
                )
            );
            const trailerEdit = new vscode.WorkspaceEdit();
            trailerEdit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(nbDoc.cellCount, trailerCells)]);
            await vscode.workspace.applyEdit(trailerEdit);
            await nbDoc.save();
            // Leave the tab open — user is actively watching this notebook.
        } else {
            // FRESH MODE — no live cells; use original prepareCharmNotebook flow.
            const nbResult = await prepareCharmNotebook({ quest, charm, scroll, reviewOut });
            if (nbResult) {
                charmNotebookPath = nbResult.path;
                const nbUri = vscode.Uri.file(nbResult.path);
                nbDoc = await vscode.workspace.openNotebookDocument(nbUri);
                if (show) {
                    try { await vscode.window.showNotebookDocument(nbDoc, { preserveFocus: false }); } catch (_) {}
                }
                const cellData = nbResult.cells.map(c =>
                    new vscode.NotebookCellData(
                        c.kind === 1 ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
                        c.value,
                        c.languageId,
                    )
                );
                const edit = new vscode.WorkspaceEdit();
                edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(0, cellData)]);
                await vscode.workspace.applyEdit(edit);
                await nbDoc.save();
                // Close the charm notebook to free memory.
                // If isDirty is true after save(), the user has made manual edits — keep open.
                if (closeCharm && !nbDoc.isDirty) {
                    try {
                        for (const group of vscode.window.tabGroups.all) {
                            for (const tab of group.tabs) {
                                if (tab.input && tab.input.uri &&
                                    tab.input.uri.toString() === nbDoc.uri.toString()) {
                                    await vscode.window.tabGroups.close(tab, true);
                                }
                            }
                        }
                    } catch (_) {}
                }
            } else {
                await _omen(bus, 'charm_notebook_skipped', 'prepareCharmNotebook returned null (no workspace?)', meta);
            }
        }
    } catch (e) {
        await _omen(bus, 'charm_notebook_failed', (e && e.message) || String(e), meta);
    }

    // ── Step 2: Quest summary notebook ────────────────────────────────────
    try {
        const sumResult = await prepareSummaryNotebook({
            quest, charm, scroll, reviewOut, charmNotebookPath,
        });
        if (sumResult) {
            summaryNotebookPath = sumResult.path;
            const sumUri = vscode.Uri.file(sumResult.path);
            const sumDoc = await vscode.workspace.openNotebookDocument(sumUri);
            if (show) {
                try { await vscode.window.showNotebookDocument(sumDoc, { preserveFocus: false }); } catch (_) {}
            }
            const sumCells = sumResult.cells.map(c =>
                new vscode.NotebookCellData(
                    c.kind === 1 ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
                    c.value,
                    c.languageId,
                )
            );
            const sumEdit = new vscode.WorkspaceEdit();
            sumEdit.set(sumDoc.uri, [vscode.NotebookEdit.insertCells(0, sumCells)]);
            await vscode.workspace.applyEdit(sumEdit);
            await sumDoc.save();
        } else {
            await _omen(bus, 'summary_notebook_skipped', 'prepareSummaryNotebook returned null (no workspace?)', meta);
        }
    } catch (e) {
        await _omen(bus, 'summary_notebook_failed', (e && e.message) || String(e), meta);
    }

    return { charmNotebookPath, summaryNotebookPath };
}

async function _omen(bus, kind, message, meta) {
    if (!bus || typeof bus.appendEvent !== 'function') return;
    try {
        await bus.appendEvent('omen', { kind, message }, meta);
    } catch (_) { /* never throw from notebook population */ }
}

module.exports = { populateResearchNotebooks };
