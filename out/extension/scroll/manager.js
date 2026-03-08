"use strict";
/*
 * scroll/manager.js — Wolfbook scroll and evaluation-mode management
 *
 * Extracted from controller.js (Round 3 refactoring).
 * All exported functions take the WolframNotebookKernel instance as `self`.
 *
 * Responsibilities:
 *   - markKeyboardExecution: record which cell triggered a keyboard eval and
 *     in which mode (advance / refine), so checkoutExecutionQueue can scroll.
 *   - setEvalMode / _updateEvalModeStatusBar: manage the manual override mode
 *     and keep the VS Code status bar item in sync.
 *   - restoreSelection: move the cell selection back to the evaluated cell
 *     without changing the viewport (Refine mode).
 *   - scrollToInputCellAnimated: scroll the cell's input to the top of the
 *     viewport before output arrives (Advance mode).
 *
 * State stored on `self`:
 *   _pendingScrollCellIndex, _pendingScrollCellNotebook, _pendingScrollMode
 *   _evalModeOverride, _evalModeStatusBar
 */

const vscode = require('vscode');
const { scrollLog } = require('../utils/dev-logger');

// ---------------------------------------------------------------------------
// Keyboard execution tracking

// Tags the cell so checkoutExecutionQueue knows the scroll mode for this execution.
// We store the cell INDEX (number) and notebook reference rather than the
// cell object itself, because VS Code may wrap the cell in a different proxy
// by the time checkoutExecutionQueue runs.
// mode: 'advance' (scroll to output, advance focus) | 'refine' (no scroll, stay on cell)
function markKeyboardExecution(self, cell, mode = 'advance') {
    self._pendingScrollCellIndex    = cell.index;
    self._pendingScrollCellNotebook = cell.notebook;
    self._pendingScrollMode         = mode;
    scrollLog('[mark] cell index', cell.index, '| mode:', mode);
}

// ---------------------------------------------------------------------------
// Eval mode override

// setEvalMode: changes the manual override and updates context + status bar.
// mode: 'auto' | 'advance' | 'refine'
function setEvalMode(self, mode) {
    self._evalModeOverride = mode;
    vscode.commands.executeCommand("setContext", "wolframEvalMode", mode);
    updateEvalModeStatusBar(self);
    scrollLog('eval mode override changed to:', mode);
}

// Update the status bar text/tooltip/command for the current override mode.
function updateEvalModeStatusBar(self) {
    const m = self._evalModeOverride;
    if (m === 'refine') {
        self._evalModeStatusBar.text    = '$(sync) WL: Refine';
        self._evalModeStatusBar.tooltip = 'Eval mode: Refine — no scroll, stay on cell for iteration. Click to reset to Auto.';
        self._evalModeStatusBar.command = 'wolfram.evalMode.auto';
    } else if (m === 'advance') {
        self._evalModeStatusBar.text    = '$(arrow-down) WL: Advance';
        self._evalModeStatusBar.tooltip = 'Eval mode: Advance — scroll to output, move to next cell. Click to force Refine.';
        self._evalModeStatusBar.command = 'wolfram.evalMode.refine';
    } else {
        self._evalModeStatusBar.text    = '$(symbol-misc) WL: Auto';
        self._evalModeStatusBar.tooltip = 'Eval mode: Auto — changed cell → Refine, unchanged → Advance. Click to force Advance.';
        self._evalModeStatusBar.command = 'wolfram.evalMode.advance';
    }
}

// ---------------------------------------------------------------------------
// Viewport operations

// Restores the notebook cell SELECTION to cellIndex in place,
// with NO viewport movement at all (no revealRange).
// Used by Refine mode — the user's current scroll position must be preserved.
function restoreSelection(self, cellIndex, notebook) {
    scrollLog('[restore-sel] → cell', cellIndex, '(selection only, no scroll)');
    try {
        for (const ed of vscode.window.visibleNotebookEditors) {
            if (ed.notebook === notebook) {
                const RangeCtor = vscode.NotebookRange ?? vscode.NotebookCellRange;
                ed.selections = [new RangeCtor(cellIndex, cellIndex + 1)];
                scrollLog('[restore-sel] done — selection set to cell', cellIndex);
                return;
            }
        }
        scrollLog('[restore-sel] no matching editor found');
    } catch (e) {
        scrollLog('[restore-sel] error (non-fatal):', e.message);
    }
}

// Scrolls the evaluated cell's input to the top of the viewport.
// Called immediately on Shift+Enter (via setTimeout(0) in execute()), NOT
// deferred to first-output arrival.  Because the cell is already at the top
// when output arrives, the output fills in below with no viewport jump.
function scrollToInputCellAnimated(self, cellIndex, notebook) {
    scrollLog('[advance-scroll] scrolling cell', cellIndex, 'to top');
    try {
        for (const ed of vscode.window.visibleNotebookEditors) {
            if (ed.notebook === notebook) {
                const RangeCtor = vscode.NotebookRange ?? vscode.NotebookCellRange;
                ed.revealRange(new RangeCtor(cellIndex, cellIndex),
                              vscode.NotebookEditorRevealType.AtTop);
                scrollLog('[advance-scroll] done');
                return;
            }
        }
        scrollLog('[advance-scroll] no matching editor — skipped');
    } catch (e) {
        self.writeDebugLog(`[SCROLL] revealRange failed: ${e.message}`);
        scrollLog('[advance-scroll] error:', e.message);
    }
}

// ---------------------------------------------------------------------------

module.exports = {
    markKeyboardExecution,
    setEvalMode,
    updateEvalModeStatusBar,
    restoreSelection,
    scrollToInputCellAnimated,
};
