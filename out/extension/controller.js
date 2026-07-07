"use strict";
/*
 *  wolfbook
 *
 *  Copyright (c) 2026 Nikolay Gromov. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  Based on vscode-wolfram by Tianhuan Lu (Apache 2.0).
 *  Refactored February 2026: replaced ZeroMQ transport with native WSTP addon.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WolframNotebookKernel = void 0;

const vscode    = require("vscode");
const path      = require("path");
const os        = require("os");
const fs        = require("fs");
const { writeFile, appendFile, readFileSync } = require("fs");
const ui_items_1       = require("./ui-items");
const notebook_config_1 = require("./notebook-config");
const notebook_kernel_1 = require("./notebook-kernel");
const find_kernel_1    = require("./find-kernel");
const configCompat = require("./config-compat");

// ---- WolfbookLaTeX: C++ box→LaTeX addon (loaded lazily by output/renderer) ----
// Paths kept here for reference; actual loading is in output/renderer.js.

// ---- Dev diagnostics: DEV_MODE, SCROLL_DEBUG, scrollLog, dynLog, _hexDump ----
const { DEV_MODE, SCROLL_DEBUG, scrollLog, dynLog, _hexDump, truncateLogs } = require('./utils/dev-logger');

// ---- String encoding helpers: escapeHtml, decodeWolframOctal, escapeWL ----
const _encoding = require('./utils/encoding');

// ---- Kernel lifecycle: launchKernel, quitKernel, subkernel, offline UI ----
const _lifecycle = require('./kernel/lifecycle');

// ---- Scroll / eval-mode management ----
const _scroll = require('./scroll/manager');

// ---- Output rendering: resolveFormat, processWLLatexBoxes, banners, replace ----
const _output = require('./output/renderer');

// ---- Dynamic widgets and Dialog[] subsession ----
const _dynamic = require('./dynamic/subsession');

// ---- Syntax error diagnostics and decorations ----
const _syntax = require('./syntax/errors');

// ---- Editor commands: paste image, abort, restart, writeFile ----
const _editor = require('./editor/commands');

// ---- Execution dispatch loop and image GC ----
const _execution = require('./execution/checkout');


// (SCROLL_DELAY_MS removed — Advance-mode scroll now fires on Shift+Enter,
// not on first output arrival, so no layout-wait delay is needed.)

// ---- lazy-load the native WSTP addon (platform-aware) ----
// Tries wstp/prebuilt/wstp-<platform>-<arch>.node first (bundled prebuilt),
// then falls back to wstp/build/Release/wstp.node (locally compiled).
let WstpSession;
let _addonSyntaxCheck;   // pure-C++ structural syntax check (no kernel needed)
try {
    const _path = require('path');
    const _fs   = require('fs');
    const _plat = process.platform; // 'darwin' | 'win32' | 'linux'
    const _arch = process.arch;     // 'arm64'  | 'x64'
    const _prebuilt = _path.join(__dirname, '../../wstp/prebuilt',
                                 `wstp-${_plat}-${_arch}.node`);
    const _fallback = _path.join(__dirname, '../../wstp/build/Release/wstp.node');
    const _addonPath = _fs.existsSync(_prebuilt) ? _prebuilt : _fallback;
    const _addon = require(_addonPath);
    WstpSession = _addon.WstpSession;
    if (typeof _addon.syntaxCheck === 'function') {
        _addonSyntaxCheck = _addon.syntaxCheck;
    }
    // Pipe C++ DiagLog messages into the extension debug log.
    if (typeof _addon.setDiagHandler === 'function') {
        const { scrollLog: _sl, wstpLog: _wl } = require('./utils/dev-logger');
        _addon.setDiagHandler(msg => { _sl('[C++]', msg); _wl('[C++]', msg); });
    }
} catch (e) {
    console.error("[Controller] Failed to load wstp.node:", e.message);
}

// ---------------------------------------------------------------------------
// Silent execution shim: mimics NotebookCellExecution API but writes outputs
// via WorkspaceEdit instead of going through VS Code's execution lifecycle.
// This avoids triggering auto-reveal (scroll to cell), output clearing on
// start(), and the Executing/Idle state events — so the viewport stays put
// and no spinner appears.  Used by AI agent tools (_silentExecution = true).
// ---------------------------------------------------------------------------
function _createSilentExecution(cell, controller) {
    const _cell = cell;
    const _controller = controller;
    // Lazily-created real NotebookCellExecution — only VS Code's execution API
    // can write cell outputs, so we MUST use a real one.  We defer creation
    // until the first output write to avoid the spinner/reveal for cells that
    // produce no output.
    let _realExec = null;
    let _savedViewport = null;   // NotebookRange — first visibleRange before start
    let _savedEditor   = null;   // the specific editor whose viewport was saved
    let _executionOrder = undefined;

    function _saveScroll() {
        try {
            // Only guard when 2+ editors are open for this notebook.
            // With a single editor, tools scroll it freely.
            const uri = _cell.notebook.uri.toString();
            const matching = vscode.window.visibleNotebookEditors.filter(
                ed => ed.notebook.uri.toString() === uri
            );
            if (matching.length < 2) return;
            // Protect the leftmost editor.
            const leftEd = matching.reduce((best, ed) =>
                (ed.viewColumn ?? 999) <= (best.viewColumn ?? 999) ? ed : best
            );
            const vr = leftEd.visibleRanges;
            if (vr && vr.length > 0) { _savedViewport = vr[0]; _savedEditor = leftEd; }
        } catch (_) {}
    }

    function _restoreScroll() {
        if (!_savedViewport || !_savedEditor) return;
        try {
            _savedEditor.revealRange(_savedViewport, vscode.NotebookEditorRevealType.AtTop);
        } catch (_) {}
    }

    function _ensureRealExec() {
        if (_realExec) return _realExec;
        _saveScroll();
        _realExec = _controller.createNotebookCellExecution(_cell);
        _realExec.start(Date.now());
        if (_executionOrder !== undefined) _realExec.executionOrder = _executionOrder;
        // Restore scroll right away — VS Code reveals on start()
        setTimeout(() => _restoreScroll(), 30);
        return _realExec;
    }

    return {
        cell: _cell,
        _isSilent: true,
        token: {
            isCancellationRequested: false,
            onCancellationRequested: (_cb) => ({ dispose: () => {} })
        },

        get executionOrder() { return _executionOrder; },
        set executionOrder(v) {
            _executionOrder = v;
            if (_realExec) _realExec.executionOrder = v;
        },

        start(_timestamp) { /* no-op — queue calls this but we defer to first output write */ },

        end(_success, _timestamp) {
            if (_realExec) {
                try { _realExec.end(!!_success, Date.now()); } catch (_) {}
                // Restore scroll after VS Code processes the end event
                setTimeout(() => _restoreScroll(), 50);
            }
            // If no output was written, _realExec is null — no execution to end,
            // and VS Code never knew about this cell.  That's fine.
        },

        async replaceOutput(outputs) {
            const exec = _ensureRealExec();
            const arr = Array.isArray(outputs) ? outputs : (outputs ? [outputs] : []);
            await exec.replaceOutput(arr);
        },

        async appendOutput(output) {
            const exec = _ensureRealExec();
            await exec.appendOutput(output);
        },

        async replaceOutputItems(items, targetOutput) {
            const exec = _ensureRealExec();
            await exec.replaceOutputItems(items, targetOutput);
        },

        clearOutput() {
            if (_realExec) {
                _realExec.clearOutput();
            }
        }
    };
}

class WolframNotebookKernel {
    constructor(extContext) {
        this.notebookConfig = configCompat.getConfiguration();
        this._id                 = "wolfram-notebook-kernel";
        this._label              = "Wolfram Kernel";
        this._supportedLanguages = ["wolfram"];

        this.findKernel         = new find_kernel_1.FindKernel();
        this.kernelStatusString = "unresolved";
        this._onKernelReady     = null;   // optional callback() — called when kernel reaches 'resolved'
        this.extensionPath      = "";
        this.isAborting         = false;
        // Collects Print[] lines emitted inside a Dialog[] subsession.
        // Set by openDialogSubsession(), cleared when done.
        this._dialogPrintCollector = null;
        // Cell URIs queued for subsession-tagged execution (⌥⇧↵ on idle kernel).
        // checkoutExecutionQueue() reads + clears this to add the "subsession" badge.
        this._subsessionCellUris = new Set();

        this._abortPending   = false;
        // Main-kernel setup caches:
        // - _lastMainImgDir/_lastMainImgRel: last VsCodeSetImgDir target pushed to kernel
        // - _interruptHandlerInstalled: whether Interrupt->Dialog[] handler is known installed
        this._lastMainImgDir = null;
        this._lastMainImgRel = null;
        this._interruptHandlerInstalled = false;
        // C++ structural syntax checker — set when wstp.node exposes syntaxCheck().
        // checkout.js uses this instead of sending VsCodeSyntaxCheck to the kernel.
        this._syntaxCheck = _addonSyntaxCheck || null;
        // True only between executionQueue.start() and executionQueue.end().
        // Guards interrupt() so it is never sent while the kernel is queued-but-idle.
        this._evalDispatched = false;
        // Incremented every time a new cell begins executing (when _evalDispatched → true).
        this._dispatchEpoch = 0;
        this._cellEpoch     = 0;  // increments once per cell; used by LiveCells expiry
        // Per-cell shared outputs array for mixed Dynamic+static cells.
        this._dynCells = new Map();

        /** @type {import("../../wstp").WstpSession | undefined} */
        this.session = undefined;

        vscode.commands.executeCommand("setContext", "wolframKernelActive", false);
        this.outputPanel    = new ui_items_1.NotebookOutputPanel("Wolfram Language Notebook");
        this.config         = new notebook_config_1.NotebookConfig();
        this.executionQueue = new notebook_kernel_1.ExecutionQueue();
        this.selectedNotebooks = new Set();
        this._quitKernelTimer  = null;

        this.thisExtension       = vscode.extensions.getExtension("wolfbook.wolfbook");
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection("wolfram-syntax");

        // Decoration type for syntax-error highlighting
        this.syntaxErrorDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: "rgba(255, 0, 0, 0.3)",
            border: "2px solid rgba(255, 0, 0, 0.8)",
            borderRadius: "3px",
            isWholeLine: false,
            overviewRulerColor: "red",
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });

        // Decoration type for runtime kernel-message highlighting (whole input line, pink).
        // Applied when onMessage fires during evaluation; cleared on next execution start.
        this.runtimeMsgDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(255, 100, 100, 0.12)",
            borderLeft: "3px solid rgba(244, 71, 71, 0.55)",
            overviewRulerColor: "rgba(244,71,71,0.6)",
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });
        this.runtimeMsgDecorationCells = new Map();  // docUri → ranges[]

        // Decoration type for hover-output source highlighting (subtle blue glow).
        // Applied while the user hovers an output; cleared on mouseleave.
        this.hoverOutputDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(100, 160, 255, 0.08)",
            borderLeft: "3px solid rgba(100, 160, 255, 0.35)",
        });
        this._hoverOutputDecorCell = null;  // currently-decorated cell docUri

        this.cellDecorations      = new Map();  // docUri -> ranges[]
        this.truncatedOutputCells = new Map();  // outputId -> {cell, outN}
        // Per-output registry — maps uniqueOutputId → {cell, outN, outName, format}.
        // Populated for every rendered result output (truncated or not) so that
        // the format-switch buttons can trigger a re-render from any output.
        this._outputRegistry     = new Map();
        // Per-cell format override — maps cellUri → 'MathML'|'SVG'|'InputForm'.
        // Set by the user clicking a format button; read at the start of each
        // evaluation to select the render format for that cell.
        this._cellOutputFormat   = new Map();
        // Per-notebook default format — SPLIT by output type so graphics and
        // expression defaults are independent.  Double-clicking a button on a
        // graphics output sets _notebookDefaultGfxFormat; on an expression output
        // sets _notebookDefaultExprFormat.  Both are persisted to globalState.
        this._notebookDefaultGfxFormat  = new Map();   // notebookUri → format (graphics)
        this._notebookDefaultExprFormat = new Map();   // notebookUri → format (expressions)
        this._outputIdCounter    = 0;  // monotonic counter for unique outputIds
        // Session epoch: incremented on every kernel launch so the renderer can
        // remove dynamic elements (Out[N]= labels, expand banners) from old sessions.
        // Use a random non-zero initial epoch so that all outputs stored by any
        // prior VS Code session (which used a different random epoch) are cleaned up
        // by the renderer's session-changed handler on notebook open/reload.
        this._sessionEpoch = (Math.random() * 999998 | 0) + 1;
        // Container pixel widths keyed by notebook URI string.
        // Replaces the old scalar _latexPageWidthPx/_latexPageWidthEm so that
        // multiple open notebooks each get the correct width for their webview.
        this._latexPageWidthPxMap = new Map(); // uriStr → px
        this._latexPageWidthEmMap = new Map(); // uriStr → em
        // Fallback scalars kept for backward-compat (watch-panel, etc.).
        this._latexPageWidthEm = 0;
        this._latexPageWidthPx = 0;
        // Proportionality coefficient: how many real rendered px correspond to one
        // C++ "em" unit used inside lineBreakLatex's width estimator.
        // Calibrated dynamically: when rendered KaTeX overflows the container,
        // K is bumped up so the next render uses a smaller pageWidthEm.
        // Default 19 is measured from KaTeX's actual rendering at default font size.
        this._pxPerCppEm = 19;
        // Extension context — used to persist per-notebook settings (globalState).
        this._extContext = extContext || null;

        // Scroll-position persistence: save top-visible cell index for each notebook
        // so we can restore it on reopen.  Keys are notebook URI strings.
        this._scrollPosTimers   = new Map();  // nbUri → debounce timer id
        this._scrollPosRestored = new Set();  // nbUris already restored this session

        // If the extension was reloaded while the kernel was offline, workspace
        // colorCustomizations may still have the grayscale values written by the
        // previous session.  Keep the saved cache in memory so that
        // _clearKernelOfflineUI() can restore the original colours once the kernel
        // is ready.  Do NOT call _setNotebookCellColorsOffline(false) here:
        // that issues an async config.update(green) whose completion races with
        // the onDidChangeVisibleNotebookEditors handler that fires immediately
        // after registration — that handler reads the workspace value before the
        // async write commits, sees the old gray values, and stores them as the
        // "originals", so the subsequent kernel-online restore ends up writing
        // gray instead of green.  Keeping the cache in memory and letting the
        // kernel-resolved path do the restore avoids the race entirely.
        if (this._extContext) {
            const _savedColorCache = this._extContext.globalState.get('wolfbook.notebookColorCache');
            if (_savedColorCache) {
                this._notebookColorCache = _savedColorCache;
                // colours stay gray in workspace until kernel resolves
            }
        }

        // Apply offline renderer overlay to any wolfram notebook that becomes visible
        // while the kernel is not running.
        // Also restores per-notebook default output format from persistent storage.
        // Also sends session-changed so the renderer can clean up stale session elements
        // from a previous run (e.g. when the notebook is reopened without restarting VS Code).
        vscode.window.onDidChangeVisibleNotebookEditors(() => {
            if (this.kernelStatusString !== 'resolved') this._applyKernelOfflineUI();
            // Auto-launch kernel when a wolfram notebook becomes visible and kernel has
            // never been started (unresolved) in this session window.
            if (this.kernelStatusString === 'unresolved') {
                const _hasWolframNb = vscode.window.visibleNotebookEditors.some(
                    ed => ed.notebook.notebookType === 'extended-wolfram-notebook'
                );
                if (_hasWolframNb) {
                    scrollLog('[auto-launch] wolfram nb visible + kernel unresolved — scheduling launch in 800ms');
                    setTimeout(() => {
                        if (this.kernelStatusString === 'unresolved') {
                            scrollLog('[auto-launch] 800ms fired — launching kernel | queue:', this.executionQueue.queueLength());
                            this.launchKernel().then(() => {
                                scrollLog('[auto-launch] launchKernel resolved | status:', this.kernelStatusString, '| queue:', this.executionQueue.queueLength());
                                if (this.kernelStatusString === 'resolved') this.checkoutExecutionQueue();
                            }).catch(err => {
                                scrollLog('[auto-launch] launchKernel FAILED:', err.message);
                                vscode.window.showErrorMessage(`Auto-launch failed: ${err.message}`);
                                this.executionQueue.clear();
                            });
                        } else {
                            scrollLog('[auto-launch] 800ms fired but status is', this.kernelStatusString, '— skipping duplicate launch');
                        }
                    }, 800);
                }
            }
            // Send current epoch so renderer removes stale Out-headers/banners from old sessions
            try {
                this._rendererMessaging.postMessage(
                    { type: 'session-changed', epoch: this._sessionEpoch }
                );
            } catch (_) {}
            // Restore per-notebook default format for newly visible notebooks
            if (this._extContext) {
                for (const ed of vscode.window.visibleNotebookEditors) {
                    const key = ed.notebook.uri.toString();
                    if (!this._notebookDefaultGfxFormat.has(key) && !this._notebookDefaultExprFormat.has(key)) {
                        const savedGfx  = this._extContext.globalState.get('wolfbook.nbDefaultFmtGfx.'  + key);
                        // Legacy key migration: old single key falls to expr default
                        // Also migrate removed formats WLLatex2/WLLatexSrc → WLLatex
                        const _migrateFmt = f => (f === 'WLLatex2' || f === 'WLLatexSrc') ? 'WLLatex' : f;
                        const savedExpr = _migrateFmt(
                            this._extContext.globalState.get('wolfbook.nbDefaultFmtExpr.' + key)
                            || this._extContext.globalState.get('wolfbook.nbDefaultFmt.'   + key) || '');
                        if (savedGfx)  this._notebookDefaultGfxFormat.set(key, savedGfx);
                        if (savedExpr) this._notebookDefaultExprFormat.set(key, savedExpr);
                        if (savedGfx || savedExpr) {
                            try {
                                this._rendererMessaging.postMessage(
                                    { type: 'nb-default-format', formatGfx: savedGfx || '', formatExpr: savedExpr || '' }
                                );
                            } catch (_) {}
                        }
                    }
                    // Restore per-output format overrides from globalState (primary)
                    // and from saved output HTML (fallback for outputs written before
                    // the globalState persistence was added).
                    if (this._extContext) {
                        try {
                            const _storeKey = 'wolfbook.perOutputFmt.' + key;
                            const _saved    = this._extContext.globalState.get(_storeKey);
                            if (_saved && typeof _saved === 'object') {
                                const _mFmt = f => (f === 'WLLatex2' || f === 'WLLatexSrc') ? 'WLLatex' : f;
                                for (const [_k, _v] of Object.entries(_saved)) {
                                    if (!this._cellOutputFormat.has(_k))
                                        this._cellOutputFormat.set(_k, _mFmt(_v));
                                }
                            }
                        } catch (_) {}
                    }
                    // HTML-scan fallback for outputs that predate globalState persistence.
                    for (let ci = 0; ci < ed.notebook.cellCount; ci++) {
                        const cell = ed.notebook.cellAt(ci);
                        const cellUri = cell.document.uri.toString();
                        for (const output of cell.outputs) {
                            for (const item of output.items) {
                                if (item.mime !== 'x-application/wolfram-language-html' && item.mime !== 'text/html') continue;
                                try {
                                    const html = Buffer.from(item.data).toString('utf8');
                                    // Match data-sub-idx and data-output-format from each output header
                                    const re = /data-sub-idx="(\d+)"[^>]*data-output-format="([^"]+)"|data-output-format="([^"]+)"[^>]*data-sub-idx="(\d+)"/g;
                                    let match;
                                    while ((match = re.exec(html)) !== null) {
                                        const subIdx = match[1] ?? match[4];
                                        const fmt    = match[2] ?? match[3];
                                        if (subIdx !== undefined && fmt && fmt !== 'Auto') {
                                            const k = cellUri + ':' + subIdx;
                                            const _mf = (f => (f === 'WLLatex2' || f === 'WLLatexSrc') ? 'WLLatex' : f)(fmt);
                                            if (!this._cellOutputFormat.has(k))
                                                this._cellOutputFormat.set(k, _mf);
                                        }
                                    }
                                } catch (_) {}
                                break; // only first html item per output
                            }
                        }
                    }
                    // Restore last scroll position (once per notebook, per session)
                    if (this._extContext && !this._scrollPosRestored.has(key)) {
                        this._scrollPosRestored.add(key);
                        const savedCell = this._extContext.workspaceState.get('wolfbook.scrollPos.' + key);
                        if (savedCell && savedCell > 0) {
                            const _cellCount = ed.notebook.cellCount;
                            const _target    = Math.min(savedCell, Math.max(0, _cellCount - 1));
                            // Delay slightly to let VS Code finish its own initial layout scroll
                            setTimeout(() => {
                                try {
                                    const RC = vscode.NotebookRange;
                                    ed.revealRange(new RC(_target, _target + 1),
                                        vscode.NotebookEditorRevealType.AtTop);
                                } catch (_) {}
                            }, 400);
                        }
                    }
                }
            }
        });

        // Save scroll position whenever the user scrolls a wolfram notebook.
        // Debounced 1 s so we don't thrash workspaceState on every wheel tick.
        vscode.window.onDidChangeNotebookEditorVisibleRanges(event => {
            if (event.notebookEditor.notebook.notebookType !== 'extended-wolfram-notebook') return;
            if (!this._extContext) return;
            const key    = event.notebookEditor.notebook.uri.toString();
            const ranges = event.visibleRanges;
            if (!ranges || ranges.length === 0) return;
            const topCell = ranges[0].start;
            clearTimeout(this._scrollPosTimers.get(key));
            this._scrollPosTimers.set(key, setTimeout(() => {
                this._extContext.workspaceState.update('wolfbook.scrollPos.' + key, topCell);
            }, 1000));
        });
        // Scroll-after-evaluation tracking: stored by cell INDEX (number), not
        // object reference, because VS Code may return different proxy objects
        // from createNotebookCellExecution than were passed in.
        this._pendingScrollCellIndex    = null;  // set by markKeyboardExecution()
        this._pendingScrollCellNotebook = null;  // set by markKeyboardExecution()
        this._pendingScrollMode         = null;  // 'advance' | 'refine' — set by execute()
        this._pendingViewportAtExecute  = null;  // cell-index of viewport top at Shift+Enter time
        this._refineGuardActive         = false; // true while a refine-mode keyboard eval is about to dispatch
        this._agentGuardActive          = false; // true while an agent tool eval is about to dispatch
        this._wolframExecPending        = false; // true when execution was initiated by wolfbook (keyboard or tool)

        // Saved viewport state for refine-mode scroll restoration at Idle.
        // Set by wolfram.executeCell in extension.js BEFORE execute() is called.
        this._scrollGuardSavedViewport   = null;  // NotebookRange (visibleRanges[0])
        this._scrollGuardSavedSelections = null;  // NotebookRange[] (editor.selections)

        // ---- Eval mode: two-mode scroll/focus behaviour ----
        // _cellLastSource: maps cellUri → source text of last evaluation.
        // Used to auto-detect Mode A (unchanged cell) vs Mode B (changed cell).
        this._cellLastSource   = new Map();
        // _cellDirty: set of cellUris edited since their last evaluation (or ever,
        // if never evaluated).  Populated by onDidChangeTextDocument so that editing
        // a cell before its first evaluation is detected as srcChanged = true → Refine.
        this._cellDirty        = new Set();
        this._evalModeOverride = this.notebookConfig.get("evalMode", "auto") || "auto";

        // Status bar item shows the active eval mode; click cycles to next.
        this._evalModeStatusBar = vscode.window.createStatusBarItem(
            "wolfram-eval-mode", vscode.StatusBarAlignment.Right, 99
        );
        this._evalModeStatusBar.name = "Wolfram Eval Mode";
        this._evalModeStatusBar.show();
        vscode.commands.executeCommand("setContext", "wolframEvalMode", this._evalModeOverride);
        this._updateEvalModeStatusBar();

        this.logFile = this.notebookConfig.get("advanced.notebook.logDirectory", "Off");
        if (this.logFile !== "Off") {
            this.logFile = this.logFile + "/Notebook-Log-" + new Date().toUTCString() + ".txt";
            this.logFile = this.logFile.replace(/,|\(|\)|:/g, "-");
            this.outputPanel.print(`Log file = ${this.logFile}`);
        }

        this._controller = vscode.notebooks.createNotebookController(
            this._id, "extended-wolfram-notebook", this._label
        );
        this._controller.supportedLanguages = this._supportedLanguages;
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this.execute.bind(this);
        this.preExecuteHook = null; // async (cells) => void — set by extension for pre-exec format
        this._suppressDirtyTracking = false; // true while preExecuteHook runs
        this.extensionPath = this.thisExtension?.extensionPath || "";

        // ---- Auto-associate this controller with every wolfbook notebook ----
        // Without calling updateNotebookAffinity(..., Preferred) the controller is
        // NOT associated on fresh installs — VS Code has no saved preference and
        // Shift+Enter silently fails until the user clicks the "play" button to
        // trigger kernel selection.  Setting Preferred makes VS Code automatically
        // select us for every extended-wolfram-notebook without user interaction.
        const _claimNotebook = (nb) => {
            if (nb.notebookType === 'extended-wolfram-notebook') {
                this._controller.updateNotebookAffinity(nb, vscode.NotebookControllerAffinity.Preferred);
            }
        };
        // Claim all notebooks already open when the extension activates
        for (const nb of vscode.workspace.notebookDocuments) { _claimNotebook(nb); }
        // Claim notebooks opened later
        vscode.workspace.onDidOpenNotebookDocument(nb => _claimNotebook(nb));

        // ---- Eagerly select controller when a wolfbook notebook becomes active ----
        // updateNotebookAffinity(Preferred) is not enough: VS Code runs its own
        // auto-selection pass synchronously during notebook open, BEFORE our
        // onDidOpenNotebookDocument handler fires, so Preferred is set too late
        // for the initial open.  As a result createNotebookCellExecution() throws
        // "not associated" on the first Shift+Enter and the cell is skipped.
        // Calling notebook.selectKernel with a specific id/extension silently
        // selects our controller (no picker UI) whenever the notebook becomes
        // the active editor, guaranteeing association before any keystroke.
        vscode.window.onDidChangeActiveNotebookEditor(editor => {
            if (!editor) return;
            const nb = editor.notebook;
            if (nb.notebookType !== 'extended-wolfram-notebook') return;
            this._controller.updateNotebookAffinity(nb, vscode.NotebookControllerAffinity.Preferred);
            vscode.commands.executeCommand('notebook.selectKernel', {
                id:        this._controller.id,
                extension: 'wolfbook.wolfbook',
                label:     this._controller.label,
            }).then(undefined, () => {});
        });



        // ---- Auto-GC when cells are deleted from any wolfram notebook ----
        // Runs _cleanupImgDir for the affected notebook so pasted/rendered images
        // whose cells were removed get deleted from img/<nbBase>/ immediately.
        vscode.workspace.onDidChangeNotebookDocument(event => {
            const hasCellRemovals = event.cellChanges.some(c =>
                c.document == null  // cell was removed (no longer has a document)
            ) || event.contentChanges.some(c => c.removedCells && c.removedCells.length > 0);
            if (!hasCellRemovals) return;
            const notebook  = event.notebook;
            const nbFsPath  = notebook.uri.fsPath;
            const nbBase    = path.basename(nbFsPath, path.extname(nbFsPath));
            const imgDir    = path.join(path.dirname(nbFsPath), 'img', nbBase);
            // Debounce: wait 15 s — GC is non-urgent and we don't want it to
            // fire on every keystroke-induced cell change while editing.
            clearTimeout(this._gcDebounce);
            this._gcDebounce = setTimeout(() => this._cleanupImgDir(notebook, imgDir), 15000);
        });

        // ---- Renderer messaging: expand / open-as-text buttons ----
        this._rendererMessaging = vscode.notebooks.createRendererMessaging("wolfram-notebook-renderer");
        this._rendererMessaging.onDidReceiveMessage(async event => {
            const message = event.message;
            // event.editor is the NotebookEditor the renderer message came from.
            // Store its notebook URI so btl.log writes use the correct path even
            // when the user has moved focus to another panel (activeNotebookEditor
            // would be null in that case).
            const _eventNbUri = event.editor?.notebook?.uri;
            if (DEV_MODE) this.outputPanel.print(`[Renderer] message: ${JSON.stringify(message)}`);

            // Renderer webview just registered its message listener — re-broadcast
            // current kernel status so it applies the correct offline/online CSS
            // immediately (the initial kernel-offline sent during activate() may have
            // been dropped if the webview wasn't loaded yet).
            if (message.type === 'renderer-ready') {
                const _kState = this.kernelStatusString === 'resolved' ? 'kernel-online' : 'kernel-offline';
                scrollLog('[renderer-ready] re-broadcasting', _kState, '| epoch:', this._sessionEpoch);
                try { this._rendererMessaging.postMessage({ type: _kState }); } catch (_) {}
                try { this._rendererMessaging.postMessage({ type: 'session-changed', epoch: this._sessionEpoch }); } catch (_) {}
                return;
            }

            // Renderer reports its container pixel width — keyed by the notebook
            // that owns this webview so two open notebooks don't clobber each other.
            if (message.type === 'container-width' && message.widthPx > 0) {
                const targetPx = Math.floor(message.widthPx * 0.80);
                const baseFontSizePx = Math.max(8, Number(this.config.get('notebook.rendering.lineBreaking.baseFontSizePx') ?? 16));
                const targetEm = Math.floor(targetPx / baseFontSizePx);
                if (_eventNbUri) {
                    const _key = _eventNbUri.toString();
                    this._latexPageWidthPxMap.set(_key, targetPx);
                    this._latexPageWidthEmMap.set(_key, targetEm);
                }
                // Also update the scalars as a fallback for watch-panel / unknown context.
                this._latexPageWidthPx = targetPx;
                this._latexPageWidthEm = targetEm;
                return;
            }

            // Unconditional debug message from the webview after every render.
            // Logs all measured widths to btl.log so we can diagnose measurement issues.
            if (message.type === 'render-width-debug') {
                try {
                    const _nbUri = _eventNbUri || vscode.window.activeNotebookEditor?.notebook?.uri;
                    if (_nbUri && _nbUri.scheme === 'file') {
                        const nbFsPath = _nbUri.fsPath;
                        const nbBase = path.basename(nbFsPath, path.extname(nbFsPath));
                        const logPath = path.join(path.dirname(nbFsPath), 'img', nbBase, 'btl.log');
                        fs.mkdirSync(path.dirname(logPath), { recursive: true });
                        const divsStr = (message.divs || []).map(d =>
                            `{pw:${d.pw} lb:${d.lb} rendW:${d.rendW ? d.rendW.toFixed(1) : 0}}`
                        ).join(' ');
                        const katexStr = (message.katexWidths || []).join(',');

                        const entry =
                            `${new Date().toISOString()}  [render-width-debug]\n` +
                            `-- headerW: ${message.headerW || 0}` +
                            `  preRenderWidth: ${message.preRenderWidth}` +
                            `  containerW: ${message.containerW}` +
                            `  windowInnerWidth: ${message.windowInnerWidth}\n` +
                            `-- pageWidthPx: ${this._latexPageWidthPx}  pageWidthEm: ${this._latexPageWidthEm}\n` +
                            `-- divs: ${divsStr || '(none)'}  katexWidths: [${katexStr}]\n`;
                        fs.appendFileSync(logPath, entry);
                        // Trim btl.log to last 400 lines
                        try { const _ll = fs.readFileSync(logPath, 'utf8').split('\n'); if (_ll.length > 400) fs.writeFileSync(logPath, _ll.slice(-400).join('\n')); } catch (_) {}
                    }
                } catch (_) {}
                return;
            }

            // Feedback is kept for diagnostics only. We intentionally do not
            // adapt calibration here: pageWidthPx is treated as the objective
            // container width target.
            if (message.type === 'katex-width-feedback' &&
                message.renderedPx > 0 && message.pageWidthEm > 0 && message.containerPx > 0) {
                try {
                    const _nbUri = _eventNbUri ||
                        vscode.window.activeNotebookEditor?.notebook?.uri;
                    if (_nbUri && _nbUri.scheme === 'file') {
                        const nbFsPath = _nbUri.fsPath;
                        const nbBase = path.basename(nbFsPath, path.extname(nbFsPath));
                        const logPath = path.join(path.dirname(nbFsPath), 'img', nbBase, 'btl.log');
                        fs.mkdirSync(path.dirname(logPath), { recursive: true });
                        const entry =
                            `========================================================================\n` +
                            `${new Date().toISOString()}  [katex-feedback]\n` +
                            `-- renderedPx: ${message.renderedPx.toFixed(1)}` +
                            `  pageWidthEm: ${message.pageWidthEm}` +
                            `  containerPx: ${message.containerPx}` +
                            `  overflow: ${message.overflow}` +
                            `  lineBroken: ${message.lineBroken}\n` +
                            `-- note: calibration disabled (pageWidthPx is authoritative)` +
                            `  pageWidthPx: ${this._latexPageWidthPx}` +
                            `  pageWidthEm: ${this._latexPageWidthEm}\n`;
                        fs.appendFileSync(logPath, entry);
                        // Trim btl.log to last 400 lines
                        try { const _ll = fs.readFileSync(logPath, 'utf8').split('\n'); if (_ll.length > 400) fs.writeFileSync(logPath, _ll.slice(-400).join('\n')); } catch (_) {}
                    }
                } catch (_) {}
                return;
            }

            if (message.type === "expand-truncated-output" && message.uuid) {
                const info = this.truncatedOutputCells.get(message.uuid);
                if (!info) {
                    vscode.window.showWarningMessage("Cannot expand: output info not found.");
                    return;
                }
                // Hard limits: 30-second render timeout + 1 MB HTML size guard.
                // The user explicitly clicked "Full" so they expect a wait.
                const RENDER_TIMEOUT_MS = 30000;
                const MAX_HTML_BYTES     = 1024 * 1024;  // 1 MB
                try {
                    const regInfo = this._outputRegistry.get(message.uuid);
                    const _cellUri = info.cell.document.uri.toString();
                    const fmt = regInfo?.format || this._resolveFormat(info.cell, regInfo?.isGfx);
                    const renderPromise = this.session.evaluate(
                        `VsCodeRenderFull[${info.outN}, "${fmt}", 0.8]`,
                        { interactive: false }
                    );
                    const timeoutPromise = new Promise((_, rej) =>
                        setTimeout(() => rej(new Error('render-timeout')), RENDER_TIMEOUT_MS)
                    );

                    let htmlVal = null;
                    let failReason = 'render returned no result';
                    try {
                        const renderResult = await Promise.race([renderPromise, timeoutPromise]);
                        if (renderResult?.result?.type === "string" && renderResult.result.value) {
                        htmlVal = this._processWLLatexBoxes(this._fixImageUris(renderResult.result.value), undefined, undefined, undefined, undefined, info.cell.notebook.uri);
                            if (htmlVal.length > MAX_HTML_BYTES) {
                                failReason = `output too large (${(htmlVal.length / 1024).toFixed(0)} KB HTML \u2014 would freeze browser)`;
                                htmlVal = null;
                            } else {
                                failReason = null;
                            }
                        }
                    } catch (raceErr) {
                        failReason = raceErr.message === 'render-timeout'
                            ? 'Render timed out (> 30 s)'
                            : raceErr.message;
                    }

                    if (htmlVal) {
                        await this._replaceOutputByUuid(info.cell, message.uuid, htmlVal, info.outN);
                        this.truncatedOutputCells.delete(message.uuid);
                    } else {
                        // Don't fall back to InputForm (dangerous for huge outputs).
                        // Instead show a warning message and keep the banner with "Open as text file".
                        this.writeDebugLog(`[EXPAND] Full expansion failed \u2014 reason: ${failReason}`);
                        const _btnStyle = 'padding:1px 6px;font-size:12px;cursor:pointer;line-height:1.5;' +
                            'background:transparent;border:1px solid rgba(128,128,128,0.3);' +
                            'border-radius:3px;color:var(--vscode-foreground,inherit);';
                        const failBanner =
                            `<div style="margin-top:3px;padding:4px 8px;display:flex;align-items:center;gap:6px;border-left:2px solid #FFA500;"` +
                            ` data-truncated-uuid="${message.uuid}" data-session-epoch="${this._sessionEpoch}">` +
                            `<span style="font-size:11px;color:#FFA500;flex:1;">&#9888; ${this.escapeHtml(failReason)} \u2014 try opening as a text file instead</span>` +
                            `<button data-action="open-text" style="${_btnStyle}" title="Open as text file">&#128196; Open as text</button>` +
                            `</div>`;
                        await this._replaceOutputByUuid(info.cell, message.uuid, failBanner, info.outN);
                        // Keep the truncatedOutputCells entry so "Open as text" still works.
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(`Expand failed: ${err.message}`);
                }

            } else if (message.type === "open-truncated-as-text" && message.uuid) {
                const info = this.truncatedOutputCells.get(message.uuid);
                if (!info) {
                    vscode.window.showWarningMessage("Cannot open as text: output info not found.");
                    return;
                }
                try {
                    const pageWidth = this.config.get("notebook.textOutput.pageWidth") ?? 100;
                    const pathResult = await this.session.evaluate(
                        `VsCodeOpenAsText[${info.outN}, ${pageWidth}]`,
                        { interactive: false }
                    );
                    if (pathResult?.result?.type === "string" && pathResult.result.value) {
                        const rawPath = String(pathResult.result.value).trim();
                        this.writeDebugLog(`[OPEN_TEXT] raw path: ${rawPath}`);

                        let targetUri;
                        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath)) {
                            // Accept file://... and other URI-like strings returned by WL.
                            targetUri = vscode.Uri.parse(rawPath);
                        } else {
                            // Normalize plain filesystem paths (including ~ expansion).
                            const expanded = rawPath.startsWith('~/')
                                ? path.join(os.homedir(), rawPath.slice(2))
                                : rawPath;
                            targetUri = vscode.Uri.file(path.resolve(expanded));
                        }

                        let doc;
                        try {
                            doc = await vscode.workspace.openTextDocument(targetUri);
                        } catch (openErr) {
                            // Fallback: if kernel returned a bad path, still open content directly.
                            const fallback = await this.session.evaluate(
                                `ToString[Out[${info.outN}], InputForm]`,
                                { interactive: false }
                            );
                            const text = (fallback?.result?.type === 'string' && fallback.result.value)
                                ? fallback.result.value
                                : `(could not retrieve Out[${info.outN}])`;
                            doc = await vscode.workspace.openTextDocument({ content: text, language: 'wolfram' });
                            this.writeDebugLog(`[OPEN_TEXT] path open failed (${String(openErr && openErr.message || openErr)}); used content fallback`);
                        }

                        await vscode.window.showTextDocument(doc, { preview: false });
                        vscode.window.showInformationMessage("Output opened in text file.");
                        this._rendererMessaging.postMessage(
                            { type: 'open-text-done', uuid: message.uuid },
                            event.editor
                        );
                    } else {
                        this._rendererMessaging.postMessage(
                            { type: 'open-text-error', uuid: message.uuid },
                            event.editor
                        );
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(`Open as text failed: ${err.message}`);
                    this._rendererMessaging.postMessage(
                        { type: 'open-text-error', uuid: message.uuid },
                        event.editor
                    );
                }

            } else if (message.type === 'open-output-as-text' && message.outputId) {
                // 📄 txt button in output header — open full expression as text file.
                // Works for all outputs (truncated or not) via _outputRegistry.
                const regEntry = this._outputRegistry.get(message.outputId);
                const truncEntry = this.truncatedOutputCells.get(message.outputId);
                const txtInfo = regEntry || truncEntry;
                if (!txtInfo) {
                    vscode.window.showWarningMessage("Cannot open as text: output info not found.");
                } else {
                    try {
                        const pageWidth = this.config.get("notebook.textOutput.pageWidth") ?? 100;
                        const pathResult = await this.session.evaluate(
                            `VsCodeOpenAsText[${txtInfo.outN}, ${pageWidth}]`,
                            { interactive: false }
                        );
                        if (pathResult?.result?.type === "string" && pathResult.result.value) {
                            const rawPath = String(pathResult.result.value).trim();
                            let targetUri;
                            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath)) {
                                targetUri = vscode.Uri.parse(rawPath);
                            } else {
                                const expanded = rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
                                targetUri = vscode.Uri.file(path.resolve(expanded));
                            }
                            let doc;
                            try {
                                doc = await vscode.workspace.openTextDocument(targetUri);
                            } catch (_) {
                                const fallback = await this.session.evaluate(`ToString[Out[${txtInfo.outN}], InputForm]`, { interactive: false });
                                const text = (fallback?.result?.type === 'string' && fallback.result.value) ? fallback.result.value : `(could not retrieve Out[${txtInfo.outN}])`;
                                doc = await vscode.workspace.openTextDocument({ content: text, language: 'wolfram' });
                            }
                            await vscode.window.showTextDocument(doc, { preview: false });
                        } else {
                            vscode.window.showWarningMessage("Open as text: kernel returned no path.");
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`Open as text failed: ${err.message}`);
                    }
                }

            } else if (message.type === 'expand-more-output' && message.uuid) {
                const outputId = message.uuid;
                const info = this.truncatedOutputCells.get(outputId);
                const regInfo = this._outputRegistry.get(outputId);
                if (!info || !regInfo) return;
                // Progressive expansion: increase breadth by 500 each click.
                const newBreadth = (info.shallowBreadth || 0) + 500;
                info.shallowBreadth = newBreadth;
                this.truncatedOutputCells.set(outputId, info);
                const fmt2 = regInfo.format || this._resolveFormat(info.cell, regInfo?.isGfx);
                const scale2 = Number(this.config.get('imageScale') || 0.8);
                const _moreLogPath = this._lastMainImgDir ? path.join(this._lastMainImgDir, 'btl.log') : null;
                let _moreReplaced = false;
                try {
                    // VsCodeRenderShallow returns a plain HTML string just like VsCodeRender —
                    // no JSON wrapping. data-wolfram-is-skeleton="1" is present when still truncated.
                    const moreResult = await this.session.evaluate(
                        `VsCodeRenderShallow[${info.outN},${newBreadth},"${fmt2}",${scale2}]`,
                        { interactive: false }
                    );
                    if (moreResult?.result?.type === 'string' && moreResult.result.value) {
                        const rawHtml = moreResult.result.value;
                        // Allow BTL paging — when expand-more produces >maxRows lines,
                        // the output gets a pager just like the full-expression path.
                        const moreHtml = this._processWLLatexBoxes(this._fixImageUris(rawHtml), _moreLogPath, null, 'expand-more', undefined, info.cell.notebook.uri);
                        // Check rawHtml (before BTL processing) — the skeleton wrapper div is on the
                        // outer layer and BTL only replaces the inner wllatex-boxes div, but checking
                        // rawHtml is more reliable since BTL never sees the outer wrapper.
                        const hasSkeleton = rawHtml.includes('data-wolfram-is-skeleton');
                        if (hasSkeleton) {
                            const bannerLabel2 = `&#128230; Large output &#8212; Shallow[&#8230;,${newBreadth}] (click Full for complete)`;
                            const bannerHtml2 = this.makeTruncationBanner(outputId, bannerLabel2, newBreadth);
                            await this._replaceOutputById(info.cell, outputId, moreHtml, info.outN, regInfo.outName, fmt2, bannerHtml2);
                        } else {
                            await this._replaceOutputById(info.cell, outputId, moreHtml, info.outN, regInfo.outName, fmt2, '');
                            this.truncatedOutputCells.delete(outputId);
                        }
                        _moreReplaced = true;
                    }
                } catch (moreErr) {
                    vscode.window.showWarningMessage(`Expand more failed: ${moreErr.message}`);
                } finally {
                    if (!_moreReplaced) {
                        try { this._rendererMessaging.postMessage({ type: 'expand-more-reset', uuid: outputId }, event.editor); } catch (_) {}
                    }
                }

            } else if (message.type === 'output-page-request') {
                // Client requests a specific page for a server-side pager.
                // Render the requested page and postMessage it back as 'output-page-result'.
                const { pagerId, page } = message;
                if (pagerId && typeof page === 'number') {
                    try {
                        const result = _output.renderPageForPager(this, pagerId, page);
                        if (result && result.html) {
                            this._rendererMessaging.postMessage(
                                { type: 'output-page-result', pagerId, page, html: result.html, latexB64: result.latexB64 || '' },
                                event.editor
                            );
                            // Prefetch adjacent pages into cache while user reads the current page.
                            // renderPageForPager is idempotent (cached); this just pre-warms the
                            // BTL parse for N+1 and N-1 so subsequent navigation is instant.
                            const _pgEntry = this._pagerStore ? this._pagerStore.get(pagerId) : null;
                            const _pgTotal = _pgEntry ? (_pgEntry.totalPages || 0) : 0;
                            const _pgCtrl  = this;
                            if (_pgTotal > 1) {
                                setImmediate(() => {
                                    if (page + 1 < _pgTotal) _output.renderPageForPager(_pgCtrl, pagerId, page + 1);
                                    setImmediate(() => {
                                        if (page - 1 >= 0) _output.renderPageForPager(_pgCtrl, pagerId, page - 1);
                                    });
                                });
                            }
                        }
                    } catch (pgErr) {
                        if (DEV_MODE) this.outputPanel.print(`[PAGE] render page ${page} for pager ${pagerId} failed: ${pgErr.message}`);
                    }
                }

            } else if (message.type === "scroll-to-output" && message.outputId) {
                // Wrap button clicked — scroll to the top of that output's cell.
                // Find the cell that owns this outputId by scanning all visible cells.
                scrollLog('scroll-to-output received for outputId:', message.outputId);
                let found = false;
                for (const ed of vscode.window.visibleNotebookEditors) {
                    for (let i = 0; i < ed.notebook.cellCount; i++) {
                        const cell = ed.notebook.cellAt(i);
                        for (const output of cell.outputs) {
                            if (output.id === message.outputId) {
                                const RangeCtor = vscode.NotebookRange ?? vscode.NotebookCellRange;
                                ed.revealRange(
                                    new RangeCtor(i, i),
                                    vscode.NotebookEditorRevealType.AtTop
                                );
                                scrollLog('scroll-to-output — scrolled to cell index', i);
                                found = true;
                                break;
                            }
                        }
                        if (found) break;
                    }
                    if (found) break;
                }
                if (!found) scrollLog('scroll-to-output — outputId not found in any visible cell');

            } else if (message.type === 'reformat-output' && message.outputId) {
                // Format-switch button clicked in renderer: re-render Out[N] in the
                // requested format and replace the existing cell output in place.
                const { outputId, newFormat } = message;
                if (newFormat === 'WLLatexSrc') return; // handled client-side via data-latex-b64
                const info = this._outputRegistry.get(outputId);
                if (!info) {
                    if (DEV_MODE) this.outputPanel.print(`[Reformat] outputId ${outputId} not found in registry`);
                    return;
                }
                // Remember format for this specific output (keyed cellUri:subIdx) so that
                // other outputs of the same cell keep their own formats.
                // subIdx is the stable 0-based local sub-expression index (not Out[N]).
                const _fmtKey = info.cell.document.uri.toString() + ':' + info.subIdx;
                this._cellOutputFormat.set(_fmtKey, newFormat);
                // Persist to globalState so format survives extension-host restarts.
                if (this._extContext) {
                    try {
                        const _nbUri    = info.cell.notebook.uri.toString();
                        const _storeKey = 'wolfbook.perOutputFmt.' + _nbUri;
                        const _existing = this._extContext.globalState.get(_storeKey) || {};
                        _existing[_fmtKey] = newFormat;
                        this._extContext.globalState.update(_storeKey, _existing).catch(() => {});
                    } catch (_) {}
                }
                const _rfScale = Number(this.config.get('imageScale') || 0.8);
                try {
                    // If the user has expanded via +… (shallowBreadth is set), honour that breadth
                    // so format-switching does not reset the skeleton back to the auto-small level.
                    // Otherwise fall through to VsCodeRender's own auto-breadth logic.
                    const _truncEntry = this.truncatedOutputCells.get(outputId);
                    const _rfBreadth  = _truncEntry?.shallowBreadth || 0;
                    const _rfExpr = _rfBreadth
                        ? `VsCodeRenderShallow[${info.outN},${_rfBreadth},"${newFormat}",${_rfScale}]`
                        : `VsCodeRender[${info.outN},"${newFormat}",${_rfScale}]`;
                    const rfResult = await this.session.evaluate(_rfExpr, { interactive: false });
                    // Forward render-time messages (e.g. $RecursionLimit::reclim)
                    for (const rfMsg of (rfResult.messages || [])) {
                        vscode.window.showWarningMessage(`Render message: ${rfMsg}`);
                    }
                    if (rfResult?.result?.type === 'string' && rfResult.result.value) {
                        const rfHtml = this._processWLLatexBoxes(this._fixImageUris(rfResult.result.value), undefined, undefined, undefined, undefined, info.cell.notebook.uri);
                        // Update registry so subsequent switches see the new format
                        info.format = newFormat;
                        this._outputRegistry.set(outputId, info);
                        // Preserve truncation banner if reformatted output is still a skeleton.
                        // VsCodeRender sets data-wolfram-is-skeleton="1" on the outer wrapper div;
                        // after BTL processing skeleton chars are converted to KaTeX HTML and are
                        // no longer detectable via regex, so rely solely on this attribute.
                        const rfIsSkeleton = rfHtml.includes('data-wolfram-is-skeleton');
                        let rfBannerHtml = '';
                        if (rfIsSkeleton) {
                            const existingEntry = this.truncatedOutputCells.get(outputId);
                            const sl = existingEntry?.shortLines || 20;
                            this.truncatedOutputCells.set(outputId, {
                                ...(existingEntry || {}),
                                cell: info.cell, outN: info.outN, isSkeleton: true, shortLines: sl
                            });
                            const mRf = rfHtml.match(/data-wolfram-atom-count="(\d+)"/);
                            const atomsRf = mRf ? parseInt(mRf[1]).toLocaleString() : '?';
                            rfBannerHtml = this.makeTruncationBanner(outputId,
                                `&#128230; Large output &#8212; ${atomsRf} atoms (skeleton shown)`, sl);
                        }
                        await this._replaceOutputById(
                            info.cell, outputId, rfHtml, info.outN, info.outName, newFormat, rfBannerHtml);
                        // No viewport scroll — user's scroll position is preserved as-is.
                    } else {
                        // Render returned non-string (aborted — e.g. recursive Format rule).
                        // Keep the existing output intact; message already shown above.
                        if (DEV_MODE) this.outputPanel.print(`[Reformat] render returned non-string (aborted?) for Out[${info.outN}] — keeping previous output`);
                    }
                } catch (rfErr) {
                    if (DEV_MODE) this.outputPanel.print(`[Reformat] error: ${rfErr.message}`);
                    vscode.window.showWarningMessage(`Reformat failed: ${rfErr.message}`);
                }
            }

            if (message.type === 'set-notebook-default-format' && message.newFormat) {
                // Store default format for whatever notebook is active in a visible editor.
                // isGfx distinguishes the graphics default (SVG/TikZ) from the expression
                // default (WLLatex/MathML/TeX etc.) so they remain fully independent.
                for (const ed of vscode.window.visibleNotebookEditors) {
                    if (ed.notebook) {
                        const nbKey = ed.notebook.uri.toString();
                        if (message.isGfx) {
                            this._notebookDefaultGfxFormat.set(nbKey, message.newFormat);
                            if (this._extContext) {
                                try { this._extContext.globalState.update('wolfbook.nbDefaultFmtGfx.' + nbKey, message.newFormat); } catch (_) {}
                            }
                        } else {
                            this._notebookDefaultExprFormat.set(nbKey, message.newFormat);
                            if (this._extContext) {
                                try { this._extContext.globalState.update('wolfbook.nbDefaultFmtExpr.' + nbKey, message.newFormat); } catch (_) {}
                            }
                        }
                        break;
                    }
                }
            }

            // ---- Renderer-side timing log (scroll jerk diagnosis) ----
            if (message.type === 'render-timing') {
                scrollLog('[renderer]', '[' + message.phase + ']',
                          'id:', message.id,
                          '| t_renderer:', message.t,
                          '| lag:', Date.now() - message.t, 'ms',
                          message.h !== undefined ? ('| scrollH:' + message.h) : '');
            }

            // ---- Hover output → highlight source lines in the input cell ----
            if (message.type === 'hover-output') {
                const nb = event.editor?.notebook;
                if (nb && message.cellIdx != null) {
                    try {
                        const cell = nb.cellAt(message.cellIdx);
                        const cellUri = cell.document.uri.toString();
                        const editor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === cellUri
                        );
                        if (editor) {
                            const startLine = Math.max(0, message.start ?? 0);
                            const endLine   = Math.max(startLine, message.end ?? startLine);
                            editor.setDecorations(this.hoverOutputDecoration, [
                                new vscode.Range(
                                    new vscode.Position(startLine, 0),
                                    new vscode.Position(endLine, 0)
                                )
                            ]);
                            this._hoverOutputDecorCell = cellUri;
                        }
                    } catch (_) {}
                }
                return;
            }
            if (message.type === 'hover-output-end') {
                if (this._hoverOutputDecorCell) {
                    const editor = vscode.window.visibleTextEditors.find(
                        e => e.document.uri.toString() === this._hoverOutputDecorCell
                    );
                    if (editor) editor.setDecorations(this.hoverOutputDecoration, []);
                    this._hoverOutputDecorCell = null;
                }
                return;
            }

            // ---- Double-click output header → navigate cursor to source line ----
            if (message.type === 'goto-source') {
                const nb = event.editor?.notebook;
                const nbEditor = event.editor;
                if (!nb || !nbEditor || message.cellIdx == null) return;
                try {
                    const cell = nb.cellAt(message.cellIdx);
                    const startLine = Math.max(0, message.start ?? 0);
                    const endLine   = Math.max(startLine, message.end ?? startLine);
                    const startPos  = new vscode.Position(startLine, 0);
                    const endPos    = new vscode.Position(endLine, 0);
                    const range     = new vscode.Range(startPos, endPos);
                    // Scroll the notebook view to show the source cell
                    nbEditor.revealRange(
                        new vscode.NotebookRange(message.cellIdx, message.cellIdx + 1),
                        vscode.NotebookEditorRevealType.Default
                    );
                    // Place cursor at the source line if the cell editor is visible
                    const cellUri = cell.document.uri.toString();
                    const cellEditor = vscode.window.visibleTextEditors.find(
                        e => e.document.uri.toString() === cellUri
                    );
                    if (cellEditor) {
                        cellEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                        cellEditor.selection = new vscode.Selection(startPos, startPos);
                    } else {
                        // Cell not yet in edit mode — open it
                        await vscode.window.showTextDocument(cell.document, {
                            selection: range,
                            preserveFocus: false,
                        });
                    }
                } catch (_) {}
                return;
            }

            // ---- InformationDataGrid symbol badge click → open docs in Watch panel ----
            // Renderer posts { type: 'doc-lookup', symbol: 'Sin' } when user clicks a
            // symbol badge in ?*pattern* search results.  We delegate to the same
            // wolfbook.expandHoverDoc command used by hover-tooltip 📖 links.
            if (message.type === 'doc-lookup' && message.symbol) {
                try {
                    await vscode.commands.executeCommand('wolfbook.expandHoverDoc', message.symbol);
                } catch (err) {
                    scrollLog('[doc-lookup] executeCommand error:', err.message);
                }
                return;
            }

            // ---- Dialog subsystem messages ----
            if (message.type === 'dialog-eval-request' && message.expr !== undefined) {
                const rid = message.requestId;
                if (this.session && this.session.isDialogOpen) {
                    this.session.dialogEval(String(message.expr))
                        .then(result => {
                            this._rendererMessaging.postMessage({ type: 'dialog-eval-result', result, requestId: rid });
                        })
                        .catch(err => {
                            this._rendererMessaging.postMessage({ type: 'dialog-eval-error', error: err.message, requestId: rid });
                        });
                } else {
                    this._rendererMessaging.postMessage({ type: 'dialog-eval-error', error: 'No dialog open', requestId: rid });
                }
            }
            if (message.type === 'dialog-exit-request') {
                if (this.session && this.session.isDialogOpen) {
                    this.session.exitDialog(message.retVal || undefined).catch(() => {});
                }
            }
        });

        // Config change → re-send to kernel
        this.config.onDidChange(config => {
            if (this.session) {
                const cfg = config.getKernelRelatedConfigs();
                for (const [k, v] of Object.entries(cfg)) {
                    const vStr = typeof v === "string" ? `"${v}"` : String(v);
                    this.session.evaluate(`$setKernelConfig["${k}", ${vStr}]`, { interactive: false }).catch(() => {});
                }
            }
        });

        // Notebook selection
        this._controller.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
            if (selected) {
                this.selectedNotebooks.add(notebook);
                // Cancel any pending kernel shutdown (e.g. Save As deselects old notebook
                // then immediately selects new one — don't kill the kernel in between).
                if (this._quitKernelTimer) {
                    clearTimeout(this._quitKernelTimer);
                    this._quitKernelTimer = null;
                }
                if (DEV_MODE) this.outputPanel.print(`Controller selected for: ${notebook.uri.fsPath}`);
            } else {
                this.selectedNotebooks.delete(notebook);
            }
            if (this.selectedNotebooks.size === 0) {
                // Debounce: Save As fires selected:false for old URI then selected:true for
                // new URI in rapid succession.  Wait 500 ms so we don't kill the kernel
                // needlessly; cancel in the selected:true branch above if it arrives first.
                this._quitKernelTimer = setTimeout(() => {
                    this._quitKernelTimer = null;
                    if (this.selectedNotebooks.size === 0) this.quitKernel();
                }, 500);
            }
        });

        // Re-associate controller after "Save As": VS Code does NOT fire
        // onDidOpenNotebookDocument for Save As — it renames the URI in-place.
        // onDidRenameFiles IS fired; re-claim any renamed wolfbook notebook.
        vscode.workspace.onDidRenameFiles(event => {
            for (const { newUri } of event.files) {
                const nb = vscode.workspace.notebookDocuments.find(
                    n => n.uri.toString() === newUri.toString());
                if (nb && nb.notebookType === 'extended-wolfram-notebook') {
                    this._controller.updateNotebookAffinity(
                        nb, vscode.NotebookControllerAffinity.Preferred);
                }
            }
        });

        // Clear syntax + runtime-message decorations when user edits
        vscode.workspace.onDidChangeTextDocument(event => {
            const docUri = event.document.uri.toString();
            if (this.cellDecorations.has(docUri)) {
                this.cellDecorations.delete(docUri);
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.toString() === docUri
                );
                if (editor) editor.setDecorations(this.syntaxErrorDecoration, []);
                this.diagnosticCollection.delete(event.document.uri);
            }
            if (this.runtimeMsgDecorationCells.has(docUri)) {
                this.runtimeMsgDecorationCells.delete(docUri);
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.toString() === docUri
                );
                if (editor) editor.setDecorations(this.runtimeMsgDecoration, []);
                this.diagnosticCollection.delete(event.document.uri);
            }
            // Track cell edits for mode auto-detection.
            // Notebook cell documents use the 'vscode-notebook-cell' URI scheme.
            // Any edit marks the cell dirty so that running it for the first time
            // after editing is correctly detected as Refine (source changed), even
            // if it has never been evaluated before.
            // Suppress during preExecuteHook so formatter edits don't count as user edits.
            if (event.document.uri.scheme === 'vscode-notebook-cell' &&
                event.contentChanges.length > 0 &&
                !this._suppressDirtyTracking) {
                this._cellDirty.add(docUri);
            }
        });
    }

    // -----------------------------------------------------------------------
    dispose() {
        this.quitKernel();
        this._controller.dispose();
    }

    // -----------------------------------------------------------------------
    writeDebugLog(message) {
        if (!DEV_MODE) return;
        const timestamp = new Date().toISOString();
        this.outputPanel.print(message);
        const logPath = this._resolveDebugLogPath();
        if (logPath) {
            try {
                fs.mkdirSync(path.dirname(logPath), { recursive: true });
                fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
            } catch (_) {}
        }
    }

    /** Compute kernel debug log path: img/<nbBase>/wolfram-kernel-debug.log */
    _resolveDebugLogPath() {
        // Try active notebook editor first
        const ed = vscode.window.activeNotebookEditor;
        if (ed && ed.notebook && ed.notebook.uri.scheme === 'file') {
            const nbFsPath = ed.notebook.uri.fsPath;
            const nbBase   = path.basename(nbFsPath, path.extname(nbFsPath));
            const imgDir   = path.join(path.dirname(nbFsPath), 'img', nbBase);
            this._lastDebugLogPath = path.join(imgDir, 'wolfram-kernel-debug.log');
        }
        // Fall back to cached path (e.g. during abort when no editor is focused)
        return this._lastDebugLogPath || null;
    }

    /** Truncate the kernel debug log (called on kernel start). */
    clearDebugLog() {
        const logPath = this._resolveDebugLogPath();
        if (logPath) {
            try {
                fs.mkdirSync(path.dirname(logPath), { recursive: true });
                fs.writeFileSync(logPath, '');
            } catch (_) {}
        }
    }

    logString(str) {
        return "[" + new Date().toUTCString() + "] " + str + "\n";
    }

    appendFileWrite(p, text) {
        appendFile(p, text, err => {
            if (err) vscode.window.showErrorMessage(`Unable to write log: ${err.message}`);
        });
    }

    escapeHtml(s) { return _encoding.escapeHtml(s); }

    // Decode Wolfram's C-style octal byte escapes back to Unicode characters.
    // (Implementation in utils/encoding.js)
    decodeWolframOctal(s) { return _encoding.decodeWolframOctal(s); }

    // Tags the cell so checkoutExecutionQueue knows the scroll mode for this execution.
    // mode: 'advance' | 'refine'
    markKeyboardExecution(cell, mode = 'advance') { _scroll.markKeyboardExecution(this, cell, mode); }

    // -----------------------------------------------------------------------
    // setEvalMode: changes the manual override and updates context + status bar.
    // mode: 'auto' | 'advance' | 'refine'
    setEvalMode(mode)              { _scroll.setEvalMode(this, mode); }
    _updateEvalModeStatusBar()     { _scroll.updateEvalModeStatusBar(this); }

    // Scrolls notebook viewport back to the evaluated cell (Refine mode only).
    _restoreSelection(cellIndex, notebook)          { _scroll.restoreSelection(this, cellIndex, notebook); }

    // Scrolls the cell's input to the top of the viewport (Advance mode).
    _scrollToInputCellAnimated(cellIndex, notebook) { _scroll.scrollToInputCellAnimated(this, cellIndex, notebook); }

    // Relative src= paths (e.g. img/MyNotebook/wl_xxx.svg) resolve correctly
    // in the VS Code webview relative to the notebook directory — no URI
    // rewriting needed.  What DOES need fixing: kernel <img> tags carry no
    // width/height, so the cell is measured at ~zero height and jumps when
    // the image loads.  Inject the dimensions from the already-written file.
    _fixImageUris(html) { return _output.injectImageDimensions(html); }

    // Output type sets — delegated to output/renderer constants.
    static get _EXPR_ONLY_FMTS() { return _output.EXPR_ONLY_FMTS; }
    static get _GFX_ONLY_FMTS()  { return _output.GFX_ONLY_FMTS; }

    // Resolve the render format for a cell output — thin wrapper.
    // outN: output index within the cell (1-based); pass undefined when not yet known.
    _resolveFormat(cell, knownIsGfx, outN)  { return _output.resolveFormat(this, cell, knownIsGfx, outN); }

    // Convert a pixel width to the C++ em units expected by lineBreakLatex,
    // using base font size (deterministic conversion).
    pxToPageWidthEm(widthPx) {
        const baseFontSizePx = Math.max(8, Number(this.config.get('notebook.rendering.lineBreaking.baseFontSizePx') ?? 16));
        return widthPx > 0 ? Math.floor(widthPx * 0.80 / baseFontSizePx) : 0;
    }

    // Build the native line-break options from runtime width info + user settings.
    // nbUri: optional vscode.Uri of the notebook being rendered — used to look up
    // the per-notebook container width rather than the last-updated global fallback.
    _getLineBreakOptions(widthOverrideEm, nbUri) {
        let pageWidth, pageWidthPx;
        const baseFontSizePx = Math.max(8, Number(this.config.get('notebook.rendering.lineBreaking.baseFontSizePx') ?? 16));
        if (widthOverrideEm !== undefined && widthOverrideEm > 0) {
            pageWidth    = Math.floor(widthOverrideEm);
            pageWidthPx  = Math.floor(widthOverrideEm * baseFontSizePx);
        } else if (nbUri) {
            const _key = typeof nbUri === 'string' ? nbUri : nbUri.toString();
            const _px  = this._latexPageWidthPxMap.get(_key) ?? 0;
            const _em  = this._latexPageWidthEmMap.get(_key) ?? 0;
            pageWidthPx = _px > 0 ? _px : this._latexPageWidthPx;
            pageWidth   = _em > 0 ? _em : this._latexPageWidthEm;
        } else {
            pageWidthPx = this._latexPageWidthPx;
            pageWidth   = this._latexPageWidthEm;
        }
        if (pageWidth   <= 0) pageWidth   = 80;
        if (pageWidthPx <= 0) pageWidthPx = 0;
        const indentStep = Math.max(0, Math.floor(Number(this.config.get('notebook.rendering.lineBreaking.indentStep') ?? 2)));
        const maxDelimDepth = Math.max(1, Math.floor(Number(this.config.get('notebook.rendering.lineBreaking.maxDelimDepth') ?? 2)));
        const maxIterations = Math.max(1, Math.floor(Number(this.config.get('notebook.rendering.lineBreaking.maxIterations') ?? 5)));
        const compact = this.config.get('notebook.rendering.lineBreaking.compact') === true;

        return {
            pageWidth,
            pageWidthPx,
            baseFontSizePx,
            indentStep,
            compact,
            maxDelimDepth,
            maxIterations,
            maxRows: Number(this.config?.get('notebook.rendering.maxMatrixRows') ?? 100),
        };
    }

    // Post-process HTML containing WLLatex box placeholders — thin wrapper.
    // widthOverride: optional em width to use instead of the notebook's container width
    // (e.g. pass the watch-panel's own width when rendering for the side panel).
    // nbUri: optional vscode.Uri of the notebook — used to look up the correct
    // per-notebook container width when two notebooks are open side-by-side.
    // source: optional label written to btl.log ('notebook', 'watch-panel', etc.)
    _processWLLatexBoxes(html, logPath, widthOverride, source, extraOpts, nbUri) {
        const lineBreakOpts = { ...this._getLineBreakOptions(widthOverride, nbUri), ...(extraOpts || {}) };
        return _output.processWLLatexBoxes(this, html, logPath, lineBreakOpts.pageWidth, source, lineBreakOpts);
    }

    makeTruncationBanner(outputId, headerText, shortLines = null) { return _output.makeTruncationBanner(this, outputId, headerText, shortLines); }
    async _replaceOutputByUuid(cell, uuid, fullHtml, outN) { return _output.replaceOutputByUuid(this, cell, uuid, fullHtml, outN); }
    async _replaceOutputById(cell, outputId, contentHtml, outN, outName, newFormat, bannerHtml = '') { return _output.replaceOutputById(this, cell, outputId, contentHtml, outN, outName, newFormat, bannerHtml); }

    // -----------------------------------------------------------------------
    async execute(cells, _notebook, _controller) {
        // Reset refine guard flag — set to true below if this is a refine keyboard eval.
        this._refineGuardActive = false;

        // ── Silent execution mode ──
        // When _silentExecution is true (set by AI tools), bypass keyboard/scroll detection.
        const isSilent = !!this._silentExecution;
        if (isSilent) {
            scrollLog('[execute] SILENT mode — skipping keyboard/scroll detection');
        }

        // ── Snapshot keyboard/selection state BEFORE any await ──
        // applyEdit inside preExecuteHook can cause VS Code to mutate ed.selections,
        // changing diff and breaking advance/refine detection if read after the await.
        let _kbEd = null, _kbSelIdx = -1, _kbCellIdx = -1, _kbDiff = -1, _kbVr = null;
        if (!isSilent && cells.length === 1) {
            const _ed0 = vscode.window.activeNotebookEditor;
            if (_ed0 && _ed0.notebook === cells[0].notebook && _ed0.selections.length > 0) {
                _kbSelIdx  = _ed0.selections[0].start;
                _kbCellIdx = cells[0].index;
                _kbDiff    = _kbSelIdx - _kbCellIdx;
                if (_kbDiff === 1 || _kbDiff === 0) {
                    _kbEd = _ed0;
                    try {
                        const _vr0 = _ed0.visibleRanges;
                        _kbVr = (_vr0 && _vr0.length > 0) ? _vr0[0].start : _kbCellIdx;
                    } catch (_) { _kbVr = _kbCellIdx; }
                }
            }
        }

        // ── Pre-execution hook (auto-format) ──
        // Suppress dirty tracking so formatter edits don't pollute advance/refine detection.
        if (!isSilent && this.preExecuteHook) {
            this._suppressDirtyTracking = true;
            try { await this.preExecuteHook(cells); }
            finally { this._suppressDirtyTracking = false; }
            // Note: workspace.applyEdit on a notebook cell URI can cause VS Code to
            // reopen the cell's text editor (enter edit mode).
            // For advance mode we close it below (after mode detection).
            // For refine mode we intentionally leave it open — _doRefineRestore in
            // checkout.js takes the "already in edit mode" fast path to restore cursor.
        }

        // Clear the pending-exec flag (was used by the now-removed external-tool guard).
        this._wolframExecPending = false;

        // Detect keyboard-triggered execution (Shift+Enter on the selected cell).
        // IMPORTANT: VS Code advances the selection from N → N+1 BEFORE calling
        // execute([cell N]).  So at the time execute() is called, selIdx is already
        // the next cell, and cells[0].index === selIdx - 1 (diff = 1).
        // Edge case: Shift+Enter on the last cell — no next cell, so selection stays
        // at N and diff = 0.  Both diffs are treated as keyboard-triggered.
        // Multi-cell runs (Run All) or programmatic calls produce diff ≠ 0 or 1.
        // Selection/diff were captured BEFORE the preExecuteHook await — see above.
        if (!isSilent && cells.length === 1) {
            const ed = _kbEd;
            if (ed) {
                const selIdx  = _kbSelIdx;
                const cellIdx = _kbCellIdx;
                const diff    = _kbDiff;
                scrollLog('execute() — cell index', cellIdx, '| selection index', selIdx,
                          '| diff', diff);
                // diff is always 0 or 1 here — _kbEd is only set for those cases.
                {
                    // ---- Determine eval mode ----
                    // Auto-detect: if the cell source changed since the last evaluation
                    // → Refine (stay on cell); otherwise → Advance (scroll output + advance focus).
                    // currentSrc is read AFTER the preExecuteHook so it reflects the formatted text.
                    const currentSrc   = cells[0].document.getText();
                    const cellUri      = cells[0].document.uri.toString();
                    const lastSrc      = this._cellLastSource.get(cellUri);
                    // srcChanged is true when:
                    //   (a) cell was evaluated before AND source differs from that evaluation, OR
                    //   (b) cell was edited (via keyboard) before its very first evaluation.
                    // Case (b) is tracked by _cellDirty so that edit-then-run-first-time
                    // is correctly detected as Refine rather than Advance.
                    const srcChanged   = (lastSrc !== undefined && lastSrc !== currentSrc)
                                     || (lastSrc === undefined  && this._cellDirty.has(cellUri));
                    const autoDetected = srcChanged ? 'refine' : 'advance';
                    const effectiveMode = (this._evalModeOverride !== 'auto')
                        ? this._evalModeOverride : autoDetected;

                    scrollLog('[execute] cell', cellIdx,
                              '| diff=' + diff,
                              '| override=' + this._evalModeOverride,
                              '| autoDetected=' + autoDetected,
                              '| effective=' + effectiveMode,
                              '| srcChanged=' + srcChanged,
                              '| lastSrc:', lastSrc === undefined ? 'NONE(first run)'
                                          : (lastSrc === currentSrc ? 'SAME' : 'CHANGED'));

                    this.markKeyboardExecution(cells[0], effectiveMode);

                    // Viewport snapshot was captured BEFORE the preExecuteHook await.
                    this._pendingViewportAtExecute = _kbVr;
                    scrollLog('[execute] viewportAtExecute:', this._pendingViewportAtExecute);

                    if (effectiveMode === 'refine') {
                        // ---- REFINE MODE ----
                        // Arm the scroll guard to pin the viewport during streaming output.
                        this._refineGuardActive = true;
                        // Note: cursor position is saved earlier — in the wolfram.executeCell
                        // command handler in extension.js, BEFORE the Shift+Enter key event
                        // causes VS Code to exit edit mode and blur the cell text editor.
                        // By the time execute() runs here, activeTextEditor is already null.
                        // _refineSavedCursor / _refineSavedCursorUri are set by executeCell.

                        // VS Code advances selection to N+1 when execute() returns.
                        // Undo that in the next tick — ONLY restore selection, NO scroll.
                        // Do NOT call cell.edit here: execution.end() will kill it anyway.
                        const refineNb      = cells[0].notebook;
                        const refineCellIdx = cellIdx;
                        scrollLog('[refine] scheduling setTimeout(0) to restore selection to cell', cellIdx);
                        setTimeout(() => {
                            scrollLog('[refine t=0] restoring notebook selection to cell', refineCellIdx);
                            this._restoreSelection(refineCellIdx, refineNb);
                        }, 0);

                    } else {
                        // ---- ADVANCE MODE ----
                        // preExecuteHook's applyEdit may have reopened the cell editor.
                        // Close it so the cell exits edit mode as the user expects.
                        // (Refine mode intentionally skips this — it needs the editor open.)
                        vscode.commands.executeCommand('notebook.cell.quitEdit').then(undefined, () => {});
                        // In VS Code, the selection is already advanced N→N+1 before
                        // execute() is called (diff === 1).  In Antigravity and some
                        // other hosts the selection is NOT pre-advanced (diff === 0),
                        // so we must do it explicitly here.
                        // Scroll the evaluated cell's input to the top of the viewport
                        // immediately on Shift+Enter — no waiting for first output.
                        // Because the cell is already at top when output arrives, it
                        // fills in below with no post-output viewport jump.
                        const _advIdx = cellIdx;
                        const _advNb  = cells[0].notebook;
                        const _advT0  = Date.now();
                        const _needExplicitAdvance = (diff === 0);   // Antigravity: not pre-advanced
                        scrollLog('[advance] scheduling immediate input-cell animated scroll for cell', _advIdx,
                            _needExplicitAdvance ? '(will explicitly advance selection)' : '(VS Code already advanced)');
                        setTimeout(() => {
                            // setTimeout(0) lets VS Code's own selection advance (if any) settle,
                            // then scroll the EVALUATED cell (not the newly selected one).
                            scrollLog('[advance t=0] scrolling cell', _advIdx, 'to top (animated) | dt=', Date.now() - _advT0, 'ms since execute()');
                            // Explicitly advance selection when the host didn't do it (Antigravity).
                            // Silent AI executions never reach here (isSilent guard above).
                            // User keyboard executions should advance in ALL modes, including collab.
                            if (_needExplicitAdvance) {
                                const _nextIdx = _advIdx + 1;
                                if (_nextIdx < _advNb.cellCount) {
                                    try {
                                        const _advEd = vscode.window.visibleNotebookEditors.find(e => e.notebook === _advNb);
                                        if (_advEd) {
                                            const RC = vscode.NotebookRange;
                                            _advEd.selections = [new RC(_nextIdx, _nextIdx + 1)];
                                            scrollLog('[advance t=0] explicitly set selection to cell', _nextIdx);
                                        }
                                    } catch (_) {}
                                }
                            }
                            this._scrollToInputCellAnimated(_advIdx, _advNb);
                        }, 0);
                    }

                    scrollLog('[execute] current sel:', ed.selections.map(r => r.start + '-' + r.end).join(', '));
                }
            } else {
                scrollLog('execute() — no active notebook editor match — programmatic');
            }
        } else {
            scrollLog('execute() —', cells.length, 'cells — multi-cell run, no scroll');
        }

        if (this.isAborting) {
            vscode.window.showWarningMessage("Cannot execute: abort in progress.");
            return;
        }
        if (this.kernelStatusString === "resolved") {
            for (const cell of cells) {
                // Don't double-queue a cell that already has a pending execution.
                if (this.executionQueue.hasPendingForCell(cell)) { scrollLog('[execute] cell', cell.index, 'already pending — skipping double-queue'); continue; }
                // Always use the real VS Code execution API so outputs are written to
                // the notebook and visible to the user.  Auto-scroll is suppressed by
                // the scroll guard (_agentGuardActive) which restores the viewport at Idle.
                let execution;
                try {
                    execution = this._controller.createNotebookCellExecution(cell);
                } catch (e) {
                    if (!String(e?.message).includes('not associated')) throw e;
                    // Controller not associated (first run / Save As).  Set up
                    // selected:true listener BEFORE triggering selection, then call
                    // notebook.selectKernel with our specific ID so VS Code selects
                    // silently (no picker UI) and fires selected:true.
                    // IMPORTANT: check ev.notebook URI matches — not just ev.selected —
                    // to avoid resolving early when a DIFFERENT open notebook gets selected.
                    const _cellNbUri = cell.notebook.uri.toString();
                    const reAssociated = await new Promise(resolve => {
                        const d = this._controller.onDidChangeSelectedNotebooks(ev => {
                            if (ev.selected && ev.notebook.uri.toString() === _cellNbUri) { d.dispose(); resolve(true); }
                        });
                        vscode.commands.executeCommand('notebook.selectKernel', {
                            id: this._controller.id,
                            extension: 'wolfbook.wolfbook',
                            label: this._controller.label,
                        }).then(undefined, () => {});
                        setTimeout(() => { d.dispose(); resolve(false); }, 3000);
                    });
                    if (!reAssociated) { vscode.commands.executeCommand('notebook.selectKernel'); continue; }
                    execution = this._controller.createNotebookCellExecution(cell);
                }
                const queueId   = this.executionQueue.push(execution);
                execution.token.onCancellationRequested(() => {
                    this.outputPanel.print("Cell execution cancelled by user");
                    this.abortEvaluation();
                });
            }
            scrollLog('[execute] kernel resolved — calling checkoutExecutionQueue | queue:', this.executionQueue.queueLength(), '| silent:', isSilent);
            this.checkoutExecutionQueue();
        } else {
            // Kernel not running: queue the cells and auto-launch.
            // checkoutExecutionQueue() is called after launch succeeds so the
            // queued cells execute immediately without user re-running them.
            scrollLog('[execute] kernel status:', this.kernelStatusString, '— queuing', cells.length, 'cell(s)');
            // Ensure the offline overlay is applied — in case the renderer loaded
            // after the initial kernel-offline message was sent (or was never sent).
            this._applyKernelOfflineUI();
            for (const cell of cells) {
                // Don't double-queue a cell that already has a pending execution
                // (guards against rapid Shift+Enter before kernel is ready).
                if (this.executionQueue.hasPendingForCell(cell)) { scrollLog('[execute] cell', cell.index, 'already pending — skipping'); continue; }
                let execution;
                try {
                    execution = this._controller.createNotebookCellExecution(cell);
                } catch (e) {
                    if (!String(e?.message).includes('not associated')) throw e;
                    const _cellNbUri2 = cell.notebook.uri.toString();
                    const reAssociated = await new Promise(resolve => {
                        const d = this._controller.onDidChangeSelectedNotebooks(ev => {
                            if (ev.selected && ev.notebook.uri.toString() === _cellNbUri2) { d.dispose(); resolve(true); }
                        });
                        vscode.commands.executeCommand('notebook.selectKernel', {
                            id: this._controller.id,
                            extension: 'wolfbook.wolfbook',
                            label: this._controller.label,
                        }).then(undefined, () => {});
                        setTimeout(() => { d.dispose(); resolve(false); }, 3000);
                    });
                    if (!reAssociated) { vscode.commands.executeCommand('notebook.selectKernel'); continue; }
                    execution = this._controller.createNotebookCellExecution(cell);
                }
                const queueId   = this.executionQueue.push(execution);
                scrollLog('[execute] queued cell', cell.index, 'as', queueId, '| queue size now:', this.executionQueue.queueLength());
                // Show the running spinner immediately — don't wait for launchKernel to finish.
                this.executionQueue.preVisualStart(queueId);
                // Write a "Kernel is starting…" placeholder so the user sees progress
                // in the output area while the kernel boots.  checkoutExecutionQueue will
                // discard this and replace it with real output once evaluation begins.
                execution.replaceOutput([new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(
                        '<div style="color:#aaa;font-style:italic;font-size:12px;padding:4px 0">' +
                        '⏳ Kernel is starting\u2026</div>',
                        'x-application/wolfram-language-html'
                    )
                ])]).catch(() => {});
                this.executionQueue.markLaunchingPlaceholder(queueId);
                execution.token.onCancellationRequested(() => {
                    this.outputPanel.print("Cell execution cancelled by user");
                    this.abortEvaluation();
                });
            }
            if (this.kernelStatusString !== 'launching') {
                scrollLog('[execute] status is', this.kernelStatusString, '— calling launchKernel');
                vscode.window.showInformationMessage('Kernel not running — launching kernel and queuing evaluation…');
                this.launchKernel().then(() => {
                    scrollLog('[execute] launchKernel resolved | status:', this.kernelStatusString, '| queue:', this.executionQueue.queueLength());
                    if (this.kernelStatusString === 'resolved') this.checkoutExecutionQueue();
                }).catch(err => {
                    scrollLog('[execute] launchKernel FAILED:', err?.message);
                    this.executionQueue.clear();
                });
            } else {
                // Already launching (e.g. auto-launch in progress) — cells are queued,
                // checkoutExecutionQueue() will be called when launchKernel() resolves.
                scrollLog('[execute] status is launching — cells queued, waiting for launchKernel to resolve | queue:', this.executionQueue.queueLength());
            }
        }
    }

    // -----------------------------------------------------------------------
    // escapeWL: escape a JS string for embedding inside a Wolfram string literal
    escapeWL(code) { return _encoding.escapeWL(code); }
    // -----------------------------------------------------------------------
    // Core evaluation dispatch loop — thin wrapper.
    async checkoutExecutionQueue() { return _execution.checkoutExecutionQueue(this); }

    // Image directory GC — thin wrapper.
    _cleanupImgDir(notebook, imgDir) { return _execution.cleanupImgDir(this, notebook, imgDir); }

    handleSyntaxErrors(cell, errors) { return _syntax.handleSyntaxErrors(this, cell, errors); }
    applySyntaxErrorDecorations(cell, ranges) { return _syntax.applySyntaxErrorDecorations(this, cell, ranges); }
    clearSyntaxErrorDecorations(cell) { return _syntax.clearSyntaxErrorDecorations(this, cell); }
    applyRuntimeMsgDecoration(cell, startLine, endLine) { return _syntax.applyRuntimeMsgDecoration(this, cell, startLine, endLine); }
    clearRuntimeMsgDecoration(cell) { return _syntax.clearRuntimeMsgDecoration(this, cell); }
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // ⌥⇧↵ — evaluate the active cell inside a Dialog[] subsession — thin wrapper.
    async openDialogSubsession() { return _dynamic.openDialogSubsession(this); }

    // Split cell code into top-level WL expressions — thin wrapper.
    _splitTopLevelExprs(code) { return _dynamic.splitTopLevelExprs(code); }

    // Split string at top-level commas — thin wrapper.
    _splitAtTopLevelCommas(s) { return _dynamic.splitAtTopLevelCommas(s); }

    // Dynamic cell poll loop — thin wrapper.
    _startDynamicCell(cell, dynExprs, imgDir, imgRel, ownedExec) {
        return _dynamic.startDynamicCell(this, cell, dynExprs, imgDir, imgRel, ownedExec);
    }

    // Render a WExpr as InputForm string — thin wrapper.
    _wexprToInputForm(expr) { return _dynamic.wexprToInputForm(expr); }

    // -----------------------------------------------------------------------
    // ⌘⇧V — Paste clipboard image as a new Markdown cell.
    //
    // Flow:
    //   1. Read clipboard PNG via osascript (macOS) into a temp file.
    //   2. Show QuickPick: Insert Above / Insert Below current cell.
    //   3. Copy image to the notebook's img/<nbBase>/ directory.
    //      If the kernel is running, use Mathematica Export/Import so any
    //      clipboard format (TIFF, BMP, etc.) is normalised to PNG.
    //   4. Insert a Markdown cell:  ![pasted image](img/<nbBase>/<name>.png)
    // args.insertBelow = true  → skip dialog, insert below (used from between-cell toolbar)
    async pasteImageAsCell(args = {}) { return _editor.pasteImageAsCell(this, args); }
    // -----------------------------------------------------------------------
    // Kernel offline UI — thin wrappers delegating to kernel/lifecycle.js
    _applyKernelOfflineUI()              { _lifecycle.applyKernelOfflineUI(this); }
    _clearKernelOfflineUI()              { _lifecycle.clearKernelOfflineUI(this); }

    // -----------------------------------------------------------------------
    // Kernel launch — thin wrapper delegating to kernel/lifecycle.js
    async launchKernel() { return _lifecycle.launchKernel(this, WstpSession); }

    // -----------------------------------------------------------------------
    // Sub-kernel and shutdown — thin wrappers delegating to kernel/lifecycle.js
    _prewarmSubKernel()                  { /* no-op: subkernel removed */ }
    quitKernel()                         { _lifecycle.quitKernel(this); }

    // -----------------------------------------------------------------------
    abortEvaluation() { return _editor.abortEvaluation(this); }

    // Abort any ongoing evaluation and wait for the queue to drain.
    // Used by AI tools to claim priority over user-initiated evaluations.
    // Returns a promise that resolves when the kernel is idle.
    async abortAndWait(timeoutMs = 10000) {
        if (this.executionQueue.queueLength() === 0 && !this._evalDispatched && !this.isAborting) {
            scrollLog('[abortAndWait] queue empty, not dispatched, not aborting — already idle');
            return; // already idle
        }
        scrollLog('[abortAndWait] aborting — queue:', this.executionQueue.queueLength(),
                  '| evalDispatched:', this._evalDispatched,
                  '| isAborting:', this.isAborting);
        // Signal checkout.js to suppress post-end scroll for the aborted user cell.
        this._agentAbortPending = true;
        vscode.window.showInformationMessage('⚡ AI tool has taken kernel priority — your evaluation was aborted.');
        this.abortEvaluation();

        // abortEvaluation() clears _evalDispatched and the queue immediately,
        // but sets isAborting=true if the kernel is processing a packet.
        // isAborting is cleared only when the kernel sends back the abort-ack.
        // We MUST wait for isAborting to become false — otherwise the next
        // execute() call hits the `if (this.isAborting) return;` guard.
        const deadline = Date.now() + timeoutMs;
        await new Promise(resolve => {
            const poll = () => {
                const isIdle = this.executionQueue.queueLength() === 0
                            && !this._evalDispatched
                            && !this.isAborting;
                if (isIdle || Date.now() >= deadline) {
                    if (!isIdle) scrollLog('[abortAndWait] timed out — forcing idle state');
                    resolve();
                } else {
                    setTimeout(poll, 100);
                }
            };
            setTimeout(poll, 100);
        });
        // Force-clear stale abort state on timeout so the next execution isn't blocked.
        if (this.isAborting) {
            scrollLog('[abortAndWait] force-clearing isAborting after timeout');
            this.isAborting = false;
        }
        if (this._abortPending) {
            this._abortPending = false;
        }
        this._agentAbortPending = false;
        scrollLog('[abortAndWait] done — queue:', this.executionQueue.queueLength(),
                  '| evalDispatched:', this._evalDispatched,
                  '| isAborting:', this.isAborting);
    }

    // -----------------------------------------------------------------------
    restartKernel() { return _editor.restartKernel(this); }
    // -----------------------------------------------------------------------
    writeFileChecked(filePath, text) { return _editor.writeFileChecked(this, filePath, text); }
}

exports.WolframNotebookKernel = WolframNotebookKernel;
exports.scrollLog = scrollLog;
//# sourceMappingURL=controller.js.map
