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
        self._evalModeStatusBar.command = 'wolfbook.evalMode.auto';
    } else if (m === 'advance') {
        self._evalModeStatusBar.text    = '$(arrow-down) WL: Advance';
        self._evalModeStatusBar.tooltip = 'Eval mode: Advance — scroll to output, move to next cell. Click to force Refine.';
        self._evalModeStatusBar.command = 'wolfbook.evalMode.refine';
    } else {
        self._evalModeStatusBar.text    = '$(symbol-misc) WL: Auto';
        self._evalModeStatusBar.tooltip = 'Eval mode: Auto — changed cell → Refine, unchanged → Advance. Click to force Advance.';
        self._evalModeStatusBar.command = 'wolfbook.evalMode.advance';
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
// Refine-mode viewport guard
//
// Uses onDidChangeCellExecutionState to detect execution lifecycle.
// At Idle time, performs ONE viewport + selection restore — the most robust
// approach per the VSCode source analysis (ScrolFixPlan.md).
//
// Why a single restore at Idle instead of continuous counter-scrolling:
//   - VS Code's scroll anchoring (mechanism 2, NotebookCellList) is HELPFUL
//     during streaming output — it keeps the input cell visible as output
//     grows below.  Fighting it continuously causes back-and-forth jitter.
//   - VS Code's handleAutoReveal (mechanism 1) fires only at start()/end()
//     boundaries, so mid-execution the viewport is mostly stable.
//   - A single restore at Idle is deterministic — no timing races with
//     rAF frames, no fragile 50ms debounce windows.
//
// The guard is armed for refine-mode keyboard executions AND for agent-tool
// executions.  Identification keys:
//   controller._refineGuardActive  — set true by execute() for refine mode
//   controller._agentGuardActive   — set true by tools before calling execute()
//
// Drift detection: for keyboard (refine) mode, if the user manually scrolled
// away (>2 cells from saved position) the restore is skipped to respect intent.
// For agent mode, drift detection is DISABLED — VS Code scrolled to the cell
// intentionally (not the user), so we always restore.

function registerExecutionScrollGuard(context, getController) {
    let _guardActive      = false;
    let _guardCellIndex   = null;
    let _guardNotebook    = null;
    let _guardIsAgent     = false;   // true when armed by an agent tool (no drift check)
    let _safetyTimeout    = null;

    function _doRestore(label) {
        if (!_guardActive) return;
        _guardActive = false;
        const _wasAgent = _guardIsAgent;
        _guardIsAgent = false;
        if (_safetyTimeout) { clearTimeout(_safetyTimeout); _safetyTimeout = null; }

        const self = getController();
        if (!self) { scrollLog('[scroll-guard]', label, 'no controller — skip'); return; }

        const savedRange = self._scrollGuardSavedViewport;
        const savedSels  = self._scrollGuardSavedSelections;
        self._scrollGuardSavedViewport   = null;
        self._scrollGuardSavedSelections = null;

        // Find the notebook editor for the guarded notebook.
        let nbEditor = null;
        for (const ed of vscode.window.visibleNotebookEditors) {
            if (ed.notebook === _guardNotebook) { nbEditor = ed; break; }
        }
        if (!nbEditor) { scrollLog('[scroll-guard]', label, 'no matching editor — skip'); return; }

        // Drift detection: if the user manually scrolled away (>2 cells from saved
        // position), skip the restore to respect their intent.
        // Agent mode: skip drift check — the scroll was VS Code reacting to execution
        // start, not the user scrolling.
        if (!_wasAgent) {
            const currentRange = nbEditor.visibleRanges[0];
            if (savedRange && currentRange) {
                const drift = Math.abs(currentRange.start - savedRange.start);
                if (drift > 2) {
                    scrollLog('[scroll-guard]', label, 'drift', drift, '> 2 cells — user scrolled, respecting');
                    _guardCellIndex = null;
                    _guardNotebook  = null;
                    return;
                }
            }
        }

        // Restore viewport position.
        if (savedRange) {
            try {
                nbEditor.revealRange(savedRange, vscode.NotebookEditorRevealType.AtTop);
                scrollLog('[scroll-guard]', label, _wasAgent ? '(agent) viewport restored to cell' : 'viewport restored to cell', savedRange.start);
            } catch (e) {
                scrollLog('[scroll-guard]', label, 'revealRange error:', e.message);
            }
        }

        // Restore cell selection so focus doesn't jump to next cell.
        if (savedSels && savedSels.length > 0) {
            try {
                nbEditor.selections = savedSels;
                scrollLog('[scroll-guard]', label, 'selections restored');
            } catch (_) {}
        }

        _guardCellIndex = null;
        _guardNotebook  = null;
    }

    // ── Continuous agent counter-scroll: react to every visible-range change ──
    // VS Code's handleAutoReveal fires at start()/end() and may override a single
    // revealRange call. This listener re-asserts the saved position on every frame
    // change during an agent execution. Disabled for refine mode (the cell is
    // already in view, so handleAutoReveal doesn't cause a visible jump).
    let _agentScrollDisposable = null;
    let _agentCounterScrolling = false; // reentrance guard

    function _installAgentScrollLock(notebook, savedRange) {
        _disposeAgentScrollLock();
        if (!savedRange) return;
        _agentCounterScrolling = false;
        _agentScrollDisposable = vscode.window.onDidChangeNotebookEditorVisibleRanges(e => {
            if (_agentCounterScrolling) return;
            if (e.notebookEditor.notebook !== notebook) return;
            const current = e.visibleRanges[0];
            if (!current) return;
            const drift = Math.abs(current.start - savedRange.start);
            if (drift <= 0) return; // already at saved position
            _agentCounterScrolling = true;
            try {
                e.notebookEditor.revealRange(savedRange, vscode.NotebookEditorRevealType.AtTop);
                scrollLog('[agent-scroll-lock] counter-scroll from cell', current.start, 'back to', savedRange.start);
            } catch (_) {}
            // Allow next event after a short delay to prevent tight recursion.
            setTimeout(() => { _agentCounterScrolling = false; }, 30);
        });
    }

    function _disposeAgentScrollLock() {
        if (_agentScrollDisposable) {
            _agentScrollDisposable.dispose();
            _agentScrollDisposable = null;
        }
        _agentCounterScrolling = false;
    }

    if (!vscode.notebooks?.onDidChangeCellExecutionState) {
        scrollLog('[scroll-guard] vscode.notebooks.onDidChangeCellExecutionState not available — skipping');
        return;
    }

    const _stateListener = vscode.notebooks.onDidChangeCellExecutionState(evt => {
        const ExecState = vscode.NotebookCellExecutionState;

        if (evt.state === ExecState.Executing) {
            const self = getController();
            if (!self) return;
            const isRefine = !!self._refineGuardActive;
            const isAgent  = !!self._agentGuardActive;
            if (!isRefine && !isAgent) return;
            // Consume the flags so duplicate Executing events don't re-arm.
            self._refineGuardActive = false;
            self._agentGuardActive  = false;

            _guardCellIndex = evt.cell.index;
            _guardNotebook  = evt.cell.notebook;
            _guardActive    = true;
            _guardIsAgent   = isAgent && !isRefine;
            scrollLog('[scroll-guard] armed', _guardIsAgent ? '(agent)' : '(refine)', '— cell', _guardCellIndex);

            // Agent mode: install continuous scroll lock to fight handleAutoReveal.
            if (_guardIsAgent) {
                const savedRange = self._scrollGuardSavedViewport;
                _installAgentScrollLock(_guardNotebook, savedRange);
            }

            // Safety timeout: if Idle never fires (kernel crash), clean up after 30s.
            if (_safetyTimeout) clearTimeout(_safetyTimeout);
            _safetyTimeout = setTimeout(() => {
                _disposeAgentScrollLock();
                _doRestore('safety-timeout');
            }, 30000);

        } else if (evt.state === ExecState.Idle) {
            if (_guardActive &&
                _guardCellIndex === evt.cell.index &&
                _guardNotebook  === evt.cell.notebook) {
                scrollLog('[scroll-guard] Idle — restoring viewport for cell', evt.cell.index);
                // Remove the scroll lock BEFORE the final restore so the
                // restore's own revealRange is not re-triggered.
                _disposeAgentScrollLock();
                _doRestore('idle');
            }
        }
    });

    context.subscriptions.push(_stateListener);
}

// ---------------------------------------------------------------------------

module.exports = {
    markKeyboardExecution,
    setEvalMode,
    updateEvalModeStatusBar,
    restoreSelection,
    scrollToInputCellAnimated,
    registerExecutionScrollGuard,
};
