// execution/wb-prompt.js — handles WBPrompt["<prompt>"] interception.
//
// When the user writes WBPrompt["do something"] in a cell and executes it,
// the extension intercepts the call (never sends it to the kernel), formats
// the prompt with a pre-amble that tells the agent which cell to target, and
// opens the Copilot Agent Chat panel with that query pre-filled.
//
// The agent receives:
//   "@wolfbook Please use wolfbook tools to perform the following task:
//    <user prompt>. Add the result below cell N."
//
// where N is the 1-based index of the WBPrompt cell in the notebook.

'use strict';
const vscode = require('vscode');

/**
 * Handle a WBPrompt["..."] sub-expression inside checkout.js.
 * Never sent to the kernel. Opens Copilot Agent Chat with a pre-filled query.
 *
 * @param {string}  promptText       - the prompt string from WBPrompt["..."]
 * @param {boolean} useWolfbook      - true (default): prefix with @wolfbook agent;
 *                                     false: send as plain Copilot chat
 * @param {object}  currentExecution - the WolframExecution wrapper (checkout.js)
 * @param {import('vscode').NotebookCell} execCell - the cell containing WBPrompt
 */
async function handleWBPrompt(promptText, useWolfbook, currentExecution, execCell) {
    const cellNumber = execCell.index + 1; // 1-based

    const fullQuery = useWolfbook
        ? `@wolfbook ${promptText}. Use wolfbook notebook cell tools to apply changes in-notebook: prefer wolfbook_insertCells (pass cells=[{kind,content},...]), and use wolfbook_editCell/wolfbook_moveCell/wolfbook_deleteCell when needed. Insert result cell(s) immediately after cell ${cellNumber}. Do not just show the result in chat — actually apply the notebook edits. Never edit the .wb file directly using file-write tools. Before writing any WL code, use wolfbook_lookupSymbol (with fetchWeb:true for unfamiliar symbols or options) to verify correct usage — do not rely on memory alone for documentation. Make sure every evaluated cell produces no errors or warnings; fix immediately if any appear.`
        : promptText;

    const showMsg = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain'),
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    const agentLabel = useWolfbook ? '@wolfbook agent' : 'Copilot chat';
    await showMsg(
        `<div style="color:#666;font-style:italic;font-size:12px;padding:4px 0;">\u{1F916} Sending to ${agentLabel}\u2026</div>`,
        `WBPrompt: sending to ${agentLabel} \u2014 "${promptText.slice(0, 80)}${promptText.length > 80 ? '\u2026' : ''}"`
    );

    // Open the Copilot chat panel with the query pre-filled and submitted.
    // 'workbench.action.chat.open' with isPartialQuery:false submits immediately.
    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: fullQuery,
            isPartialQuery: false,
        });
    } catch (err) {
        await showMsg(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">` +
            `\u26A0 Could not open Copilot Chat: ${err.message.replace(/</g, '&lt;')}<br>` +
            `Copy manually: <span style="user-select:all;font-family:monospace;font-size:11px;">${fullQuery.replace(/</g, '&lt;')}</span></div>`,
            `WBPrompt error: ${err.message}\nQuery: ${fullQuery}`
        );
    }
}

module.exports = { handleWBPrompt };
