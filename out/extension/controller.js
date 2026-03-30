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
    // Pipe C++ DiagLog messages into the extension debug log.
    if (typeof _addon.setDiagHandler === 'function') {
        const { scrollLog: _sl } = require('./utils/dev-logger');
        _addon.setDiagHandler(msg => { _sl('[C++]', msg); });
    }
} catch (e) {
    console.error("[Controller] Failed to load wstp.node:", e.message);
}

class WolframNotebookKernel {
    constructor(extContext) {
        this.notebookConfig = vscode.workspace.getConfiguration("wolfram", null);
        this._id                 = "wolfram-notebook-kernel";
        this._label              = "Wolfram Kernel";
        this._supportedLanguages = ["wolfram"];

        this.findKernel         = new find_kernel_1.FindKernel();
        this.kernelStatusString = "unresolved";
        this.extensionPath      = "";
        this.isAborting         = false;
        // Collects Print[] lines emitted inside a Dialog[] subsession.
        // Set by openDialogSubsession(), cleared when done.
        this._dialogPrintCollector = null;
        // Cell URIs queued for subsession-tagged execution (⌥⇧↵ on idle kernel).
        // checkoutExecutionQueue() reads + clears this to add the "subsession" badge.
        this._subsessionCellUris = new Set();

        // Sub-kernel: a second WstpSession used exclusively to render results
        // obtained via dialogEval() on the main kernel. Initialized lazily on
        // first ⌥⇧↵ with a busy kernel. Reuses init.wl so VsCodeRenderExpr is
        // available exactly as in normal evaluations.
        /** @type {import("../../wstp").WstpSession | null} */
        this._subKernel = null;
        this._subKernelReady = false;
        this._subKernelInitPromise = null;
        this._abortPending   = false;
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
                        const savedExpr = this._extContext.globalState.get('wolfbook.nbDefaultFmtExpr.' + key)
                                       || this._extContext.globalState.get('wolfbook.nbDefaultFmt.'     + key);
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
                                for (const [_k, _v] of Object.entries(_saved)) {
                                    if (!this._cellOutputFormat.has(_k))
                                        this._cellOutputFormat.set(_k, _v);
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
                                            if (!this._cellOutputFormat.has(k))
                                                this._cellOutputFormat.set(k, fmt);
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
        this.extensionPath = this.thisExtension?.extensionPath || "";



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

            if (message.type === "expand-truncated-output" && message.uuid) {
                const info = this.truncatedOutputCells.get(message.uuid);
                if (!info) {
                    vscode.window.showWarningMessage("Cannot expand: output info not found.");
                    return;
                }
                // Hard limits: 3-second render timeout + 100 KB HTML size guard.
                // MathML for large lists (e.g. Range[500]) is 80-400 KB and freezes
                // the browser layout engine, so we fall back to plain InputForm text.
                const RENDER_TIMEOUT_MS = 3000;
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
                        htmlVal = this._processWLLatexBoxes(this._fixImageUris(renderResult.result.value));
                            if (htmlVal.length > MAX_HTML_BYTES) {
                                failReason = `output too large (${(htmlVal.length / 1024).toFixed(0)} KB HTML \u2014 would freeze browser)`;
                                htmlVal = null;
                            } else {
                                failReason = null;
                            }
                        }
                    } catch (raceErr) {
                        failReason = raceErr.message === 'render-timeout'
                            ? 'MathML render timed out (> 3 s)'
                            : raceErr.message;
                    }

                    if (htmlVal) {
                        await this._replaceOutputByUuid(info.cell, message.uuid, htmlVal, info.outN);
                        this.truncatedOutputCells.delete(message.uuid);
                    } else {
                        // Fall back: plain InputForm text with wrap-friendly pre block
                        this.writeDebugLog(`[EXPAND] Falling back to InputForm \u2014 reason: ${failReason}`);
                        const fallback = await this.session.evaluate(
                            `ToString[Out[${info.outN}], InputForm]`,
                            { interactive: false }
                        );
                        let text = fallback?.result?.type === "string"
                            ? fallback.result.value
                            : `(could not retrieve Out[${info.outN}])`;
                        // Decode WL unicode escapes: \:03B1 -> α  (InputForm emits these)
                        text = text.replace(/\\:([0-9A-Fa-f]{4})/g,
                            (_, h) => String.fromCharCode(parseInt(h, 16)));
                        // Content-only (no Out[N]= label) — _replaceOutputByUuid adds the label
                        const content =
                            `<div style="color:#FFA500;font-size:11px;margin:0 0 4px;">${failReason} \u2014 showing plain text</div>` +
                            `<pre class="vscode-wolfram-text-output" style="white-space:pre-wrap;` +
                            `overflow-wrap:break-word;font-family:Consolas,monospace;font-size:12px;margin:0;">` +
                            this.escapeHtml(text) + `</pre>`;
                        await this._replaceOutputByUuid(info.cell, message.uuid, content, info.outN);
                        this.truncatedOutputCells.delete(message.uuid);
                        vscode.window.showWarningMessage(`Expand: ${failReason} \u2014 showing plain text.`);
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
                        const doc = await vscode.workspace.openTextDocument(pathResult.result.value);
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

            } else if (message.type === 'expand-more-output' && message.uuid) {
                const outputId = message.uuid;
                const info = this.truncatedOutputCells.get(outputId);
                const regInfo = this._outputRegistry.get(outputId);
                if (!info || !regInfo) return;
                const newShortLines = (info.shortLines || 20) + 20;
                info.shortLines = newShortLines;
                this.truncatedOutputCells.set(outputId, info);
                const fmt2 = regInfo.format || this._resolveFormat(info.cell, regInfo?.isGfx);
                const scale2 = Number(this.config.get('imageScale') || 0.8);
                try {
                    const moreResult = await this.session.evaluate(
                        `Module[{e=Short[Out[${info.outN}],${newShortLines}]},VsCodeRenderExpr[e,"${fmt2}",${scale2}]]`,
                        { interactive: false }
                    );
                    if (moreResult?.result?.type === 'string' && moreResult.result.value) {
                        const moreHtml = this._fixImageUris(moreResult.result.value);
                        const bannerLabel2 = `&#128230; Large output &#8212; Short[&#8230;,${newShortLines}] (click Full for complete)`;
                        const bannerHtml2 = this.makeTruncationBanner(outputId, bannerLabel2, newShortLines);
                        await this._replaceOutputById(info.cell, outputId, moreHtml, info.outN, regInfo.outName, fmt2, bannerHtml2);
                    }
                } catch (moreErr) {
                    vscode.window.showWarningMessage(`Expand more failed: ${moreErr.message}`);
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
                    const rfResult = await this.session.evaluate(
                        `VsCodeRender[${info.outN}, "${newFormat}", ${_rfScale}]`,
                        { interactive: false }
                    );
                    // Forward render-time messages (e.g. $RecursionLimit::reclim)
                    for (const rfMsg of (rfResult.messages || [])) {
                        vscode.window.showWarningMessage(`Render message: ${rfMsg}`);
                    }
                    if (rfResult?.result?.type === 'string' && rfResult.result.value) {
                        const rfHtml = this._processWLLatexBoxes(this._fixImageUris(rfResult.result.value));
                        // Update registry so subsequent switches see the new format
                        info.format = newFormat;
                        this._outputRegistry.set(outputId, info);
                        // Preserve truncation banner if reformatted output is still a skeleton
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
                    this.session.sub(`$setKernelConfig["${k}", ${vStr}]`).catch(() => {});
                }
            }
        });

        // Notebook selection
        this._controller.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
            if (selected) {
                this.selectedNotebooks.add(notebook);
                if (DEV_MODE) this.outputPanel.print(`Controller selected for: ${notebook.uri.fsPath}`);
            } else {
                this.selectedNotebooks.delete(notebook);
            }
            if (this.selectedNotebooks.size === 0) {
                this.quitKernel();
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
            }
            // Track cell edits for mode auto-detection.
            // Notebook cell documents use the 'vscode-notebook-cell' URI scheme.
            // Any edit marks the cell dirty so that running it for the first time
            // after editing is correctly detected as Refine (source changed), even
            // if it has never been evaluated before.
            if (event.document.uri.scheme === 'vscode-notebook-cell' &&
                event.contentChanges.length > 0) {
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
    // rewriting needed.  Kept as a no-op in case it's called from expand paths.
    // Relative src= paths resolve correctly in the VS Code webview — no-op passthrough.
    _fixImageUris(html) { return html; }

    // Output type sets — delegated to output/renderer constants.
    static get _EXPR_ONLY_FMTS() { return _output.EXPR_ONLY_FMTS; }
    static get _GFX_ONLY_FMTS()  { return _output.GFX_ONLY_FMTS; }

    // Resolve the render format for a cell output — thin wrapper.
    // outN: output index within the cell (1-based); pass undefined when not yet known.
    _resolveFormat(cell, knownIsGfx, outN)  { return _output.resolveFormat(this, cell, knownIsGfx, outN); }

    // Post-process HTML containing WLLatex box placeholders — thin wrapper.
    _processWLLatexBoxes(html, logPath) { return _output.processWLLatexBoxes(this, html, logPath); }

    makeTruncationBanner(outputId, headerText, shortLines = null) { return _output.makeTruncationBanner(this, outputId, headerText, shortLines); }
    async _replaceOutputByUuid(cell, uuid, fullHtml, outN) { return _output.replaceOutputByUuid(this, cell, uuid, fullHtml, outN); }
    async _replaceOutputById(cell, outputId, contentHtml, outN, outName, newFormat, bannerHtml = '') { return _output.replaceOutputById(this, cell, outputId, contentHtml, outN, outName, newFormat, bannerHtml); }

    // -----------------------------------------------------------------------
    execute(cells, _notebook, _controller) {
        // Reset refine guard flag — set to true below if this is a refine keyboard eval.
        this._refineGuardActive = false;
        // Detect keyboard-triggered execution (Shift+Enter on the selected cell).
        // IMPORTANT: VS Code advances the selection from N → N+1 BEFORE calling
        // execute([cell N]).  So at the time execute() is called, selIdx is already
        // the next cell, and cells[0].index === selIdx - 1 (diff = 1).
        // Edge case: Shift+Enter on the last cell — no next cell, so selection stays
        // at N and diff = 0.  Both diffs are treated as keyboard-triggered.
        // Multi-cell runs (Run All) or programmatic calls produce diff ≠ 0 or 1.
        if (cells.length === 1) {
            const ed = vscode.window.activeNotebookEditor;
            if (ed && ed.notebook === cells[0].notebook && ed.selections.length > 0) {
                const selIdx  = ed.selections[0].start;
                const cellIdx = cells[0].index;
                const diff    = selIdx - cellIdx;
                scrollLog('execute() — cell index', cellIdx, '| selection index', selIdx,
                          '| diff', diff);
                if (diff === 1 || diff === 0) {
                    // ---- Determine eval mode ----
                    // Auto-detect: if the cell source changed since the last evaluation
                    // → Refine (stay on cell); otherwise → Advance (scroll output + advance focus).
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

                    // Snapshot viewport top at the moment Shift+Enter is pressed.
                    // Used later by checkoutExecutionQueue to decide whether to
                    // freeze the viewport (cell visible) or let VS Code scroll
                    // (cell was already above the viewport).
                    try {
                        const _vr = ed.visibleRanges;
                        this._pendingViewportAtExecute = (_vr && _vr.length > 0) ? _vr[0].start : cellIdx;
                    } catch (_) { this._pendingViewportAtExecute = cellIdx; }
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
                        // Let VS Code advance the selection to N+1 freely.
                        // Scroll the evaluated cell's input to the top of the viewport
                        // immediately on Shift+Enter — no waiting for first output.
                        // Because the cell is already at top when output arrives, it
                        // fills in below with no post-output viewport jump.
                        const _advIdx = cellIdx;
                        const _advNb  = cells[0].notebook;
                        const _advT0  = Date.now();
                        scrollLog('[advance] scheduling immediate input-cell animated scroll for cell', _advIdx);
                        setTimeout(() => {
                            // setTimeout(0) lets VS Code's selection advance (N→N+1) happen
                            // first, then we scroll the EVALUATED cell (not the newly selected one).
                            scrollLog('[advance t=0] scrolling cell', _advIdx, 'to top (animated) | dt=', Date.now() - _advT0, 'ms since execute()');
                            this._scrollToInputCellAnimated(_advIdx, _advNb);
                        }, 0);
                    }

                    scrollLog('[execute] current sel:', ed.selections.map(r => r.start + '-' + r.end).join(', '));
                } else {
                    scrollLog('  → programmatic (diff=' + diff + ') — scroll skipped');
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
                const execution = this._controller.createNotebookCellExecution(cell);
                const queueId   = this.executionQueue.push(execution);
                execution.token.onCancellationRequested(() => {
                    this.outputPanel.print("Cell execution cancelled by user");
                    this.abortEvaluation();
                });
            }
            scrollLog('[execute] kernel resolved — calling checkoutExecutionQueue | queue:', this.executionQueue.queueLength());
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
                const execution = this._controller.createNotebookCellExecution(cell);
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
    _prewarmSubKernel()                  { _lifecycle.prewarmSubKernel(this, WstpSession); }
    async _ensureSubKernel(imgDir, imgRel) { return _lifecycle.ensureSubKernel(this, WstpSession, imgDir, imgRel); }
    quitKernel()                         { _lifecycle.quitKernel(this); }

    // -----------------------------------------------------------------------
    abortEvaluation() { return _editor.abortEvaluation(this); }
    // -----------------------------------------------------------------------
    restartKernel() { return _editor.restartKernel(this); }
    // -----------------------------------------------------------------------
    writeFileChecked(filePath, text) { return _editor.writeFileChecked(this, filePath, text); }
}

exports.WolframNotebookKernel = WolframNotebookKernel;
exports.scrollLog = scrollLog;
//# sourceMappingURL=controller.js.map
