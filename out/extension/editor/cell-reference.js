'use strict';

// Visible, copyable notebook references.
//
// Wolfbook's MCP tools define a cell number as its 1-based notebook position.
// Keep this UI deliberately tied to that definition: it must never invent a
// separate numbering scheme that disagrees with wolfbook_getNotebookContext.

const vscode = require('vscode');
const { getCellToolId } = require('../tools/shared');

const NOTEBOOK_TYPE = 'extended-wolfram-notebook';
const COPY_COMMAND = 'wolfbook.copyCellReference';

// Supplied by extension.js. assignClientId() allocates a suffix against the live
// registry, so it must never be called twice for one window — this reads the id
// that window already published. It is resolved late (activation registers this
// module before the MCP identity exists), hence the guard.
let _clientIdSource = null;
function _getClientId() {
    try { return _clientIdSource ? _clientIdSource() || '' : ''; }
    catch (_) { return ''; }
}

function _notebookForCellUri(uri) {
    const uriString = typeof uri === 'string' ? uri : uri?.toString();
    if (!uriString) return null;
    for (const notebook of vscode.workspace.notebookDocuments || []) {
        if (notebook.notebookType !== NOTEBOOK_TYPE) continue;
        for (let index = 0; index < notebook.cellCount; index++) {
            const cell = notebook.cellAt(index);
            if (cell.document.uri.toString() === uriString) return { notebook, cell, index };
        }
    }
    return null;
}

function _formatReference(index, cell) {
    // This spelling matches the reference shown to MCP agents.
    return `Cell ${index + 1} (cellId: ${getCellToolId(cell)})`;
}

function _notebookName(notebook) {
    const p = notebook?.uri?.fsPath || notebook?.uri?.path || '';
    return p ? p.split(/[\\/]/).pop() : '';
}

// A cell id ALONE does not address a cell. It is the fragment of the
// vscode-notebook-cell URI, which is positional: cell 4 of every wolfbook
// notebook is `W3sZmlsZQ`. And a bare filename is no better here — this
// workspace has 144 notebooks called clean.wb. What the MCP tools actually
// route on is client + notebook, so a reference worth pasting has to carry
// both, plus the absolute path to settle the duplicate names.
function _formatAddressableReference(index, cell, notebook, clientId) {
    const name = _notebookName(notebook);
    let first = _formatReference(index, cell);
    if (name) first += ` · ${name}`;
    if (clientId) first += ` @ ${clientId}`;
    const fsPath = notebook?.uri?.fsPath;
    return fsPath ? `${first}\n${fsPath}` : first;
}

async function _copyCellReference(cellUri) {
    const found = _notebookForCellUri(cellUri);
    if (!found) {
        vscode.window.showWarningMessage('Wolfbook could not find that notebook cell.');
        return;
    }
    const reference = _formatAddressableReference(
        found.index, found.cell, found.notebook, _getClientId());
    await vscode.env.clipboard.writeText(reference);
    vscode.window.setStatusBarMessage(
        `Copied ${_formatReference(found.index, found.cell)}`, 2500);
}

function _lineForCell(cell) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== cell.document.uri.toString()) return '';
    return ` · line ${editor.selection.active.line + 1}`;
}

function register(context, clientIdSource) {
    _clientIdSource = typeof clientIdSource === 'function' ? clientIdSource : null;
    const cellStatusChanged = new vscode.EventEmitter();
    const status = vscode.window.createStatusBarItem(
        'wolfbook-cell-reference', vscode.StatusBarAlignment.Right, 98
    );
    context.subscriptions.push(cellStatusChanged, status);

    const refreshStatus = (notebookEditor = vscode.window.activeNotebookEditor) => {
        if (!notebookEditor || notebookEditor.notebook?.notebookType !== NOTEBOOK_TYPE) {
            status.hide();
            return;
        }
        const selection = notebookEditor.selections?.[0] || notebookEditor.selection;
        const index = selection?.start;
        if (!Number.isInteger(index) || index < 0 || index >= notebookEditor.notebook.cellCount) {
            status.hide();
            return;
        }
        const cell = notebookEditor.notebook.cellAt(index);
        if (cell.kind !== vscode.NotebookCellKind.Code) {
            status.hide();
            return;
        }
        const name = _notebookName(notebookEditor.notebook);
        // This bar is window-global: with several notebooks open, "Cell 4" alone
        // does not say which one it means. The in-cell item below is already
        // inside its notebook and stays short.
        status.text = `$(notebook) ${name ? name + ' · ' : ''}Cell ${index + 1}${_lineForCell(cell)}`;
        status.tooltip = `${_formatAddressableReference(
            index, cell, notebookEditor.notebook, _getClientId())
            }\nClick to copy this MCP cell reference.`;
        // Unlike cell status-bar items, a window status-bar command receives no
        // implicit cell context. Refresh its explicit URI with the active cell.
        status.command = { command: COPY_COMMAND, arguments: [cell.document.uri.toString()] };
        status.show();
    };

    const cellStatusProvider = {
        onDidChangeCellStatusBarItems: cellStatusChanged.event,
        provideCellStatusBarItems(cell) {
            if (cell.kind !== vscode.NotebookCellKind.Code) return [];
            const found = _notebookForCellUri(cell.document.uri);
            if (!found) return [];
            const item = new vscode.NotebookCellStatusBarItem(
                `$(symbol-number) Cell ${found.index + 1}`,
                vscode.NotebookCellStatusBarAlignment.Right
            );
            // Right alignment keeps this in the lower cell bar, beside the
            // language label, rather than consuming source-editor space.
            item.priority = 100;
            item.tooltip = `${_formatAddressableReference(
                found.index, cell, found.notebook, _getClientId())
                }\n\nClick to copy this MCP cell reference.`;
            item.command = { command: COPY_COMMAND, arguments: [cell.document.uri.toString()] };
            return item;
        },
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(COPY_COMMAND, _copyCellReference),
        vscode.notebooks.registerNotebookCellStatusBarItemProvider(
            NOTEBOOK_TYPE, cellStatusProvider
        ),
        vscode.workspace.onDidChangeNotebookDocument(event => {
            if (event.notebook.notebookType !== NOTEBOOK_TYPE) return;
            cellStatusChanged.fire();
            refreshStatus();
        }),
        vscode.window.onDidChangeNotebookEditorSelection(event => refreshStatus(event.notebookEditor)),
        vscode.window.onDidChangeActiveNotebookEditor(editor => refreshStatus(editor)),
        vscode.window.onDidChangeActiveTextEditor(() => refreshStatus()),
        // Cell selection identifies the notebook cell; text-editor selection
        // supplies the source line within that cell.
        vscode.window.onDidChangeTextEditorSelection(() => refreshStatus())
    );

    refreshStatus();
}

module.exports = { register, COPY_COMMAND, _formatReference, _formatAddressableReference };
