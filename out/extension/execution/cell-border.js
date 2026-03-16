'use strict';
const vscode = require('vscode');

// ---------------------------------------------------------------------------
// Execution-state styling for notebook cells.
//
// TWO mechanisms:
//   1. workbench.colorCustomizations → notebook.cellBorderColor  (outer cell
//      outline via CSS var --vscode-notebook-cellBorderColor, same mechanism
//      used by the kernel-offline UI).  Changed globally for the duration of
//      any active execution, then restored.
//   2. createTextEditorDecorationType → backgroundColor only  (per-cell
//      background tint; borderLeft is NOT used here as it is clipped inside
//      the Monaco editor container and is not visible as the cell outline).
// ---------------------------------------------------------------------------

// Vivid gold background — executing cell.
const executing = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 215, 0, 0.12)',
    overviewRulerColor: '#FFD700',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
});

// Pale gold background — queued (not yet running).
const queued = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 215, 0, 0.05)',
    overviewRulerColor: 'rgba(255, 215, 0, 0.40)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
});

// Track which cells have decoration state so editors can re-apply on visibility change.
// Map: cell document URI string → 'executing' | 'queued'
const _cellState = new Map();

// ---------------------------------------------------------------------------
// Global outer border: workbench.colorCustomizations → notebook.cellBorderColor
// This is the ONLY way to change cell-editor-part outline from an extension.
// ---------------------------------------------------------------------------
const _COLOR_KEY = 'notebook.cellBorderColor';
const _EXEC_COLOR  = '#B8860B';   // dark gold — vivid, clear "executing" signal
const _QUEUE_COLOR = '#8B7536';   // muted gold — "queued, not yet running"
let _savedBorderColor = undefined;  // undefined = not currently overriding

function _setGlobalBorder(active) {
    try {
        const config = vscode.workspace.getConfiguration('workbench');
        const currentColors = config.get('colorCustomizations') || {};
        if (active) {
            // Save original (may be absent — stored as null to distinguish from "not saved")
            if (_savedBorderColor === undefined) {
                _savedBorderColor = currentColors[_COLOR_KEY] ?? null;
            }
            const hasExec = [..._cellState.values()].some(s => s === 'executing');
            const color   = hasExec ? _EXEC_COLOR : _QUEUE_COLOR;
            if (currentColors[_COLOR_KEY] === color) return;
            config.update('colorCustomizations', { ...currentColors, [_COLOR_KEY]: color },
                vscode.ConfigurationTarget.Workspace).catch(() => {});
        } else {
            if (_savedBorderColor === undefined) return;  // nothing to restore
            const updatedColors = { ...currentColors };
            if (_savedBorderColor !== null) {
                updatedColors[_COLOR_KEY] = _savedBorderColor;
            } else {
                delete updatedColors[_COLOR_KEY];
            }
            _savedBorderColor = undefined;
            config.update('colorCustomizations', updatedColors,
                vscode.ConfigurationTarget.Workspace).catch(() => {});
        }
    } catch (_) {}
}

function _findEditor(cell) {
    const uri = cell.document.uri.toString();
    return vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri);
}

function _fullRange(editor) {
    const last = Math.max(0, editor.document.lineCount - 1);
    return [new vscode.Range(0, 0, last, editor.document.lineAt(last).text.length)];
}

function _applyState(editor, state) {
    const range = _fullRange(editor);
    if (state === 'executing') {
        editor.setDecorations(executing, range);
        editor.setDecorations(queued, []);
    } else if (state === 'queued') {
        editor.setDecorations(queued, range);
        editor.setDecorations(executing, []);
    } else {
        editor.setDecorations(executing, []);
        editor.setDecorations(queued, []);
    }
}

function _applyToCell(cell, state) {
    const uri = cell.document.uri.toString();
    const hadAny = _cellState.size > 0;
    if (state) {
        _cellState.set(uri, state);
    } else {
        _cellState.delete(uri);
    }
    const hasAny = _cellState.size > 0;

    // Update the global outer border.
    if (hasAny) {
        _setGlobalBorder(true);   // sets vivid or muted gold based on cellState contents
    } else if (hadAny) {
        _setGlobalBorder(false);  // restore original
    }

    // Per-cell background decoration.
    const ed = _findEditor(cell);
    if (ed) {
        _applyState(ed, state);
    }
}

function setExecuting(cell) { _applyToCell(cell, 'executing'); }
function setQueued(cell)    { _applyToCell(cell, 'queued'); }
function clearBorder(cell)  { _applyToCell(cell, null); }

// ---------------------------------------------------------------------------
// Markdown cell editing background
// Used when a markup cell is in edit mode — gives a subtle blue tint so it
// is visually distinct from Wolfram code cells.
// ---------------------------------------------------------------------------

const _markdownEditing = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(80, 150, 255, 0.09)',
});

function _applyMarkdownStyle(editor) {
    try {
        if (editor.document.uri.scheme !== 'vscode-notebook-cell') return;
        // Walk all open notebook documents to find the cell and check its kind.
        const uriStr = editor.document.uri.toString();
        let isMarkup = false;
        for (const nb of (vscode.workspace.notebookDocuments || [])) {
            for (const cell of nb.getCells()) {
                if (cell.document.uri.toString() === uriStr) {
                    isMarkup = (cell.kind === vscode.NotebookCellKind.Markup);
                    break;
                }
            }
            if (isMarkup) break;
        }
        if (!isMarkup) return;
        const last = Math.max(0, editor.document.lineCount - 1);
        const range = [new vscode.Range(0, 0, last, editor.document.lineAt(last).text.length)];
        editor.setDecorations(_markdownEditing, range);
        console.log('[cell-border] markdown editing style applied');
    } catch (e) {
        console.warn('[cell-border] _applyMarkdownStyle error:', e.message);
    }
}

function registerCellDecorations(context) {
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            for (const ed of editors) {
                if (ed.document.uri.scheme !== 'vscode-notebook-cell') continue;
                // Re-apply execution background decoration.
                const state = _cellState.get(ed.document.uri.toString());
                if (state) _applyState(ed, state);
                // Apply markdown background.
                _applyMarkdownStyle(ed);
            }
        })
    );
    // Apply to already-visible cell editors at activation time.
    for (const ed of vscode.window.visibleTextEditors) {
        _applyMarkdownStyle(ed);
    }
}

module.exports = { setExecuting, setQueued, clearBorder, executing, queued, registerCellDecorations };

module.exports = { setExecuting, setQueued, clearBorder, executing, queued, registerCellDecorations };


