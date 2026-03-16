'use strict';
// execution/wb-include.js — handles WBInclude["file.nb"] interception.
// Converts the target .nb file using the bundled converter toolchain,
// then returns an array of NotebookCellData objects ready for insertion.

const vscode  = require('vscode');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { spawn } = require('child_process');

/**
 * Run the bundled nb→evsnb converter on `nbAbsPath`.
 * Resolves with the array of VS Code NotebookCellData to insert.
 *
 * @param {string} extensionPath  — self.extensionPath
 * @param {string} nbAbsPath      — absolute path to the .nb file
 * @returns {Promise<vscode.NotebookCellData[]>}
 */
async function convertNbToCells(extensionPath, nbAbsPath) {
    const converterDir = path.join(extensionPath, 'resources');
    const wlsScript    = path.join(converterDir, 'convert_nb_to_vsnb.wls');

    if (!fs.existsSync(wlsScript)) {
        throw new Error(`Converter script not found: ${wlsScript}`);
    }
    if (!fs.existsSync(nbAbsPath)) {
        throw new Error(`File not found: ${nbAbsPath}`);
    }

    // Use a temp file so we never write into the user's source directory
    const evsnbPath = path.join(os.tmpdir(), `wb-include-${crypto.randomBytes(6).toString('hex')}.evsnb`);

    // Run wolframscript.  Paths are passed via env vars (WB_INPUT / WB_OUTPUT) so
    // that spaces in directory names don't cause argument-splitting inside wolframscript.
    // CWD = converterDir so that nb2m (which writes its .m output to CWD) is found.
    let stdout = '', stderr = '';
    await new Promise((resolve, reject) => {
        const proc = spawn('wolframscript', ['-script', wlsScript], {
            cwd: converterDir,
            env: { ...process.env, WB_INPUT: nbAbsPath, WB_OUTPUT: evsnbPath }
        });
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', err => reject(new Error(`Failed to launch wolframscript: ${err.message}`)));
        proc.on('close', code => {
            if (code !== 0) {
                reject(new Error(`Converter exited with code ${code}.\nstdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`));
            } else {
                resolve();
            }
        });
    });

    if (!fs.existsSync(evsnbPath)) {
        throw new Error(
            `Converter finished but output file not found.\nstdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`
        );
    }

    let jsonText;
    try {
        jsonText = fs.readFileSync(evsnbPath, 'utf8');
    } finally {
        try { fs.unlinkSync(evsnbPath); } catch (_) {}  // always clean up temp
    }

    const parsed = JSON.parse(jsonText);
    const rawCells = parsed.cells || [];

    // Map JSON cell descriptors → NotebookCellData
    return rawCells.map(c => {
        const kind = c.kind === 1
            ? vscode.NotebookCellKind.Markup
            : vscode.NotebookCellKind.Code;
        const lang = kind === vscode.NotebookCellKind.Markup ? 'markdown' : (c.languageId || 'wolfram');
        return new vscode.NotebookCellData(kind, c.value || '', lang);
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
        cells = await convertNbToCells(self.extensionPath, nbAbsPath);
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
