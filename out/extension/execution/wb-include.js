'use strict';
// execution/wb-include.js — handles WBInclude["file.nb"] interception.
// Converts the target .nb file with the in-process importer, then returns an
// array of NotebookCellData objects ready for insertion.

const vscode  = require('vscode');
const path    = require('path');
const fs      = require('fs');

/**
 * Convert `nbAbsPath` to notebook cells.
 *
 * Uses the same pure-JS importer that backs opening a .nb directly
 * (nb-import/), so this needs no wolframscript and keeps Output cells.
 *
 * @param {string} extensionPath  — self.extensionPath (unused; kept for callers)
 * @param {string} nbAbsPath      — absolute path to the .nb file
 * @param {string} [hostNbFsPath] — the notebook the cells are inserted into; its
 *                                  img/ folder receives any rendered graphics,
 *                                  since that is what the relative src resolves against
 * @returns {Promise<vscode.NotebookCellData[]>}
 */
async function convertNbToCells(extensionPath, nbAbsPath, hostNbFsPath) {
    if (!fs.existsSync(nbAbsPath)) {
        throw new Error(`File not found: ${nbAbsPath}`);
    }

    const nbImport = require('../nb-import/index');
    const source   = fs.readFileSync(nbAbsPath, 'utf8');
    const imported = await nbImport.importForHost(source, {
        sourceName: path.basename(nbAbsPath),
        hostNbFsPath,
    });

    return (imported.cells || []).map(c => {
        const kind = c.kind === 1 ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
        const lang = kind === vscode.NotebookCellKind.Markup ? 'markdown' : (c.languageId || 'wolfram');
        const cell = new vscode.NotebookCellData(kind, c.value || '', lang);
        if (kind === vscode.NotebookCellKind.Code && c.outputs && c.outputs.length) {
            cell.outputs = c.outputs.map(o => new vscode.NotebookCellOutput(
                o.items.map(it => new vscode.NotebookCellOutputItem(it.data, it.mime))
            ));
        }
        return cell;
    });
}

/**
 * Handle a WBInclude["..."] sub-expression inside checkout.js.
 *
 * Converts the target .nb file, inserts a header + resulting cells into
 * the notebook immediately after `insertAfterIndex`, and writes a
 * status message to `currentExecution`.
 *
 * @param {object} self               — WolframNotebookKernel controller
 * @param {string} nbPath             — raw path extracted from WBInclude["<nbPath>"]
 * @param {string} notebookDir        — directory of the host notebook (for relative path resolution)
 * @param {object} currentExecution   — the execution descriptor from the queue
 * @param {number} insertAfterIndex   — cell index after which to insert
 */
async function handleWBInclude(self, nbPath, notebookDir, currentExecution, insertAfterIndex) {
    // Resolve path: if relative, resolve against the host notebook's directory
    const nbAbsPath = path.isAbsolute(nbPath) ? nbPath : path.resolve(notebookDir, nbPath);
    const nbName    = path.basename(nbAbsPath);

    const showMsg = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain')
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    await showMsg(
        `<div style="color:#888;font-style:italic;font-size:12px;padding:4px 0;">⏳ WBInclude: converting <code>${nbName}</code>…</div>`,
        `WBInclude: converting ${nbName}…`
    );

    let cells;
    try {
        const hostNbFsPath = currentExecution.execution.cell.notebook.uri.fsPath;
        cells = await convertNbToCells(self.extensionPath, nbAbsPath, hostNbFsPath);
    } catch (err) {
        await showMsg(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBInclude failed: ${err.message.replace(/</g, '&lt;')}</div>`,
            `WBInclude failed: ${err.message}`
        );
        return;
    }

    // Build cell list: markdown header + converted cells
    const headerCell = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Markup,
        `## Included: ${nbName}`,
        'markdown'
    );
    const allCells = [headerCell, ...cells];

    const notebook = currentExecution.execution.cell.notebook;
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertAfterIndex + 1, allCells)]);
    await vscode.workspace.applyEdit(edit);

    // Replace the progress message with a success summary
    const successHtml =
        `<div style="color:#090;font-size:12px;padding:4px 0;">` +
        `✅ WBInclude: inserted ${cells.length} cell(s) from <code>${nbName}</code></div>`;
    const successPlain = `WBInclude: inserted ${cells.length} cell(s) from ${nbName}`;

    // Replace the last output (the progress message) with the success message
    const successOut = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(successHtml, 'x-application/wolfram-language-html'),
        vscode.NotebookCellOutputItem.text(successPlain, 'text/plain')
    ]);
    await currentExecution.execution.replaceOutput(successOut);
}

module.exports = { handleWBInclude };
