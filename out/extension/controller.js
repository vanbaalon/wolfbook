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

// ---- WolfbookLaTeX: C++ box→LaTeX addon + KaTeX pre-renderer (optional) ----
// Loaded lazily on first WLLatex format request. Gracefully unavailable if not built.
// Binaries live in <extension-root>/wllatex-addon/ (copied there by deploy-extension.sh).
const _BTL_ADDON_PATH       = require('path').join(__dirname, '../../wllatex-addon/wolfbook_btl.node');
const _KATEX_PRERENDER_PATH = require('path').join(__dirname, '../../wllatex-addon/katexPrerender.js');
let   _btlAddon = null;
let   _btlPrerenderLatex = null;
function _loadBtlAddon() {
    if (_btlAddon) return true;
    try {
        _btlAddon = require(_BTL_ADDON_PATH);
        _btlPrerenderLatex = require(_KATEX_PRERENDER_PATH).prerenderLatex;
        return true;
    } catch (_) { return false; }
}

// ---- Scroll / focus debug logging ----
// scrollLog() writes to both the DevTools console AND a dedicated file:
//   <workspace>/Temporary Docs/wolfram-scroll-debug.log
// Set SCROLL_DEBUG = false to disable all scroll logging.
const SCROLL_DEBUG = true;
let _scrollLogPath = null;  // resolved once on first write
let _dynLogPath    = null;
function _resolveScrollLogPath() {
    if (_scrollLogPath) return _scrollLogPath;
    const folders = (typeof vscode !== 'undefined') && vscode.workspace && vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const extFolder = folders.find(f => f.name === 'VSCodeWolframExtension');
    const base = extFolder ? extFolder.uri.fsPath : folders[0].uri.fsPath;
    _scrollLogPath = require('path').join(base, 'Temporary Docs', 'wolfram-scroll-debug.log');
    _dynLogPath    = require('path').join(base, 'Temporary Docs', 'wolfram-dyn-debug.log');
    return _scrollLogPath;
}
function scrollLog(...args) {
    if (!SCROLL_DEBUG) return;
    const msg = '[scroll] ' + args.join(' ');
    console.log(msg);
    const p = _resolveScrollLogPath();
    if (p) {
        try {
            require('fs').appendFileSync(p, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch (_) {}
    }
}
// dynLog() — dedicated diagnostic log for Dynamic rendering, truncated on each kernel start.
function dynLog(...args) {
    const msg = args.join(' ');
    console.log('[dyn-dbg] ' + msg);
    _resolveScrollLogPath();  // ensure _dynLogPath is set
    if (_dynLogPath) {
        try {
            require('fs').appendFileSync(_dynLogPath, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch (_) {}
    }
}
// Hex-dump helper: show first N bytes of a string as 'XX XX ...' for encoding diagnosis.
function _hexDump(str, n) {
    const buf = Buffer.from(String(str).slice(0, n * 4), 'utf8').slice(0, n);
    return Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join(' ');
}

// (SCROLL_DELAY_MS removed — Advance-mode scroll now fires on Shift+Enter,
// not on first output arrival, so no layout-wait delay is needed.)

// ---- lazy-load the native WSTP addon (requires wstp/build/Release/wstp.node) ----
let WstpSession;
try {
    WstpSession = require("../../wstp/build/Release/wstp.node").WstpSession;
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
        // Promise-chain mutex: only one Dynamic widget may hold the dialog at a time.
        this._dynDialogMutex = Promise.resolve();
        this._abortPending   = false;
        // True only between (await _dynIdleMutex resolves) and executionQueue.end().
        // The Dialog busy-path guards on this so interrupt() is never sent while the
        // kernel is queued-but-idle (between executionQueue.start and session.evaluate).
        this._evalDispatched = false;
        // Incremented every time a new cell begins executing (when _evalDispatched → true).
        // The Dialog busy path captures this before awaiting the mutex and re-checks after;
        // if the epoch changed the loop ended and a NEW cell started while we waited —
        // sending interrupt() now would interrupt the wrong (innocent) cell.
        this._dispatchEpoch = 0;
        this._cellEpoch     = 0;  // increments once per cell; used by LiveCells expiry
        // True while VsCodeRender[N] (ExportString SVG) is executing in the main kernel.
        // Dynamic widget loops skip their interrupt cycle during this window so they
        // cannot abort an in-flight ExportString/Rasterize call.
        this._renderingActive = false;
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
                }
            }
        });
        // Scroll-after-evaluation tracking: stored by cell INDEX (number), not
        // object reference, because VS Code may return different proxy objects
        // from createNotebookCellExecution than were passed in.
        this._pendingScrollCellIndex    = null;  // set by markKeyboardExecution()
        this._pendingScrollCellNotebook = null;  // set by markKeyboardExecution()
        this._pendingScrollMode         = null;  // 'advance' | 'refine' — set by execute()
        this._pendingViewportAtExecute  = null;  // cell-index of viewport top at Shift+Enter time

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

        // ---- Log all notebook selection/focus changes ----
        // This captures VS Code's auto-advance to the next cell after Shift+Enter
        // as well as any manual navigation — visible in DevTools console + scroll log file.
        vscode.window.onDidChangeNotebookEditorSelection(event => {
            const ed  = event.notebookEditor;
            const sel = event.selections;
            const indices = sel.map(r => `${r.start}-${r.end}`).join(', ');
            scrollLog('[sel-change] →', indices,
                      '| nb:', ed.notebook.uri.fsPath.split('/').pop());
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
            this.outputPanel.print(`[Renderer] message: ${JSON.stringify(message)}`);

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
                    this.outputPanel.print(`[Reformat] outputId ${outputId} not found in registry`);
                    return;
                }
                // Remember format for next evaluation of this cell
                this._cellOutputFormat.set(info.cell.document.uri.toString(), newFormat);
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
                        this.outputPanel.print(`[Reformat] render returned non-string (aborted?) for Out[${info.outN}] — keeping previous output`);
                    }
                } catch (rfErr) {
                    this.outputPanel.print(`[Reformat] error: ${rfErr.message}`);
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
                this.outputPanel.print(`Controller selected for: ${notebook.uri.fsPath}`);
            } else {
                this.selectedNotebooks.delete(notebook);
            }
            if (this.selectedNotebooks.size === 0) {
                this.quitKernel();
            }
        });

        // Clear syntax decorations when user edits
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
        const timestamp = new Date().toISOString();
        this.outputPanel.print(message);
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const extFolder = workspaceFolders.find(f => f.name === "VSCodeWolframExtension");
            const logPath = extFolder
                ? path.join(extFolder.uri.fsPath, "Temporary Docs", "wolfram-kernel-debug.log")
                : path.join(workspaceFolders[0].uri.fsPath, "wolfram-kernel-debug.log");
            try { fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`); } catch (_) {}
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

    escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // Decode Wolfram's C-style octal byte escapes back to Unicode characters.
    // WSTP emits non-ASCII text as raw UTF-8 bytes encoded as \NNN octal sequences,
    // e.g. λ → \316\273 (0xCE 0xBB in UTF-8), ϑ → \317\221 (0xCF 0x91).
    // Consecutive \NNN sequences form a single multi-byte character, so we must
    // collect the whole run and decode it as UTF-8 in one shot.
    decodeWolframOctal(s) {
        return String(s).replace(/(\\[0-7]{3})+/g, match => {
            const bytes = [];
            for (let i = 0; i < match.length; i += 4) {
                bytes.push(parseInt(match.slice(i + 1, i + 4), 8));
            }
            try {
                return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
            } catch (_) {
                return match;  // leave as-is if invalid UTF-8
            }
        });
    }

    // Tags the cell so checkoutExecutionQueue knows the scroll mode for this execution.
    // We store the cell INDEX (number) and notebook reference rather than the
    // cell object itself, because VS Code may wrap the cell in a different proxy
    // by the time checkoutExecutionQueue runs.
    // mode: 'advance' (scroll to output, advance focus) | 'refine' (no scroll, stay on cell)
    markKeyboardExecution(cell, mode = 'advance') {
        this._pendingScrollCellIndex    = cell.index;
        this._pendingScrollCellNotebook = cell.notebook;
        this._pendingScrollMode         = mode;
        scrollLog('[mark] cell index', cell.index, '| mode:', mode);
    }

    // -----------------------------------------------------------------------
    // setEvalMode: changes the manual override and updates context + status bar.
    // mode: 'auto' | 'advance' | 'refine'
    setEvalMode(mode) {
        this._evalModeOverride = mode;
        vscode.commands.executeCommand("setContext", "wolframEvalMode", mode);
        this._updateEvalModeStatusBar();
        scrollLog('eval mode override changed to:', mode);
    }

    // Update the status bar text/tooltip/command for the current override mode.
    _updateEvalModeStatusBar() {
        const m = this._evalModeOverride;
        if (m === 'refine') {
            this._evalModeStatusBar.text    = '$(sync) WL: Refine';
            this._evalModeStatusBar.tooltip = 'Eval mode: Refine — no scroll, stay on cell for iteration. Click to reset to Auto.';
            this._evalModeStatusBar.command = 'wolfram.evalMode.auto';
        } else if (m === 'advance') {
            this._evalModeStatusBar.text    = '$(arrow-down) WL: Advance';
            this._evalModeStatusBar.tooltip = 'Eval mode: Advance — scroll to output, move to next cell. Click to force Refine.';
            this._evalModeStatusBar.command = 'wolfram.evalMode.refine';
        } else {
            this._evalModeStatusBar.text    = '$(symbol-misc) WL: Auto';
            this._evalModeStatusBar.tooltip = 'Eval mode: Auto — changed cell → Refine, unchanged → Advance. Click to force Advance.';
            this._evalModeStatusBar.command = 'wolfram.evalMode.advance';
        }
    }

    // Scrolls the notebook viewport back to the evaluated cell and restores
    // the selection to that cell.  Must be called via setTimeout(0) so it fires
    // AFTER VS Code's own post-execute selection advance (which happens when the
    // executeHandler returns, i.e. after execute() returns).
    // Used by Refine mode only.  Advance mode scrolls the input cell immediately
    // via _scrollToInputCellAnimated, called from execute().
    // Restores the notebook cell SELECTION to cellIndex in place,
    // with NO viewport movement at all (no revealRange).
    // Used by Refine mode — the user's current scroll position must be preserved.
    _restoreSelection(cellIndex, notebook) {
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
    _scrollToInputCellAnimated(cellIndex, notebook) {
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
            this.writeDebugLog(`[SCROLL] revealRange failed: ${e.message}`);
            scrollLog('[advance-scroll] error:', e.message);
        }
    }

    // Relative src= paths (e.g. img/MyNotebook/wl_xxx.svg) resolve correctly
    // in the VS Code webview relative to the notebook directory — no URI
    // rewriting needed.  Kept as a no-op in case it's called from expand paths.
    _fixImageUris(html) {
        return html;
    }

    // Resolve the render format for a cell, respecting the type-split notebook defaults.
    // knownIsGfx: true/false if already known; undefined = scan registry for last output of this cell.
    // Guarantees: never returns an expression-only format (WLLatex/WLLatex2/MathML/TeX/TeXSrc) for a
    // known-graphics output, and never returns a graphics-only format (SVGSrc) for a known-expression
    // output.  Falls back to 'Auto' (→ SVG for gfx, MathML for expr in the kernel) in those cases.
    static get _EXPR_ONLY_FMTS() { return new Set(['WLLatex','WLLatex2','MathML','TeX','TeXSrc']); }
    static get _GFX_ONLY_FMTS()  { return new Set(['SVGSrc']); }
    _resolveFormat(cell, knownIsGfx) {
        const cellUri = cell.document.uri.toString();
        // 1. Per-cell explicit override (set when user clicks a format button)
        const perCell = this._cellOutputFormat.get(cellUri);
        // 2. Notebook-level default — pick the right one based on output type
        const nbUri = cell.notebook.uri.toString();
        let isGfx = knownIsGfx;
        if (isGfx === undefined) {
            // Scan registry for the most recent output of this cell
            for (const [, entry] of this._outputRegistry) {
                if (entry.cell?.document?.uri?.toString() === cellUri && entry.isGfx !== undefined) {
                    isGfx = entry.isGfx;
                }
            }
        }
        let fmt;
        if (perCell) {
            fmt = perCell;
        } else if (isGfx === true) {
            fmt = this._notebookDefaultGfxFormat.get(nbUri) || '';
        } else {
            // isGfx === false (known expression) or undefined (first eval, unknown type)
            fmt = this._notebookDefaultExprFormat.get(nbUri) || '';
        }
        if (!fmt) fmt = String(this.config.get('outputFormat') || 'Auto');
        // Sanitise: if type is known, never return a format incompatible with it.
        if (isGfx === true  && WolframNotebookKernel._EXPR_ONLY_FMTS.has(fmt)) return 'Auto';
        if (isGfx === false && WolframNotebookKernel._GFX_ONLY_FMTS.has(fmt))  return 'Auto';
        return fmt;
    }

    // Post-process HTML from the kernel: if it contains a WLLatex box-placeholder
    // div, decode the boxes, run through the C++ boxToLatex addon, then either
    // KaTeX-prerender (WLLatex) or emit a raw-latex div for webview rendering (WLLatex2).
    _processWLLatexBoxes(html) {
        const hasPrerendered = html.includes('vscode-wolfram-wllatex-boxes"');
        const hasRaw         = html.includes('vscode-wolfram-wllatex-boxes-raw"');
        if (!hasPrerendered && !hasRaw) return html;
        if (!_loadBtlAddon()) {
            return html
                .replace(/<div class="vscode-wolfram-wllatex-boxes(-raw)?"[^>]*><\/div>/g,
                    '<pre class="vscode-wolfram-text-output">WLLatex: addon not available.\n' +
                    'Build VSCodeWolfbookLaTeX first:\n  cd ~/Dropbox/MY/Programming/VSCodeWolfbookLaTeX && ./build.sh</pre>');
        }
        // Helper: run boxToLatex and return { latex, error }
        const translate = (b64) => {
            try {
                const boxStr = Buffer.from(b64, 'base64').toString('utf8');
                const result = _btlAddon.boxToLatex(boxStr);
                // boxToLatex returns { latex, error } per README
                if (result && typeof result === 'object') return { boxStr, latex: result.latex, error: result.error || null };
                // Older build that returned a plain string
                return { boxStr, latex: String(result), error: null };
            } catch (e) {
                return { boxStr: '(decode failed)', latex: '', error: String(e.message || e) };
            }
        };
        // ---- Mode A: pre-render in extension host (LaTeX button) ----
        if (hasPrerendered) {
            html = html.replace(/<div class="vscode-wolfram-wllatex-boxes" data-boxes-b64="([^"]*)">\s*<\/div>/g,
                (_, b64) => {
                    const { boxStr, latex, error } = translate(b64);
                    let rendered;
                    try {
                        rendered = _btlPrerenderLatex(latex, true);
                    } catch (e) {
                        return '<pre class="vscode-wolfram-text-output">WLLatex KaTeX error: ' +
                               this.escapeHtml(String(e.message || e)) + '</pre>';
                    }
                    const errorNote = error
                        ? `<div style="color:#e05c4e;font-size:11px;margin:2px 0;">` +
                          `⚠️ boxToLatex error: ${this.escapeHtml(error)}</div>`
                        : '';
                    const debugHtml =
                        '<details style="margin-top:4px;font-size:11px;opacity:0.65;">' +
                        '<summary style="cursor:pointer;user-select:none;">WLLatex debug</summary>' +
                        '<pre style="margin:2px 0;white-space:pre-wrap;word-break:break-all;">' +
                        '<b>boxes:</b> ' + this.escapeHtml(boxStr) + '\n' +
                        '<b>latex:</b> ' + this.escapeHtml(latex) +
                        (error ? '\n<b style="color:#e05c4e;">error:</b> ' + this.escapeHtml(error) : '') +
                        '</pre></details>';
                    return '<div class="vscode-wolfram-wllatex-prerendered">' +
                           errorNote + rendered + debugHtml + '</div>';
                });
        }
        // ---- Mode B: emit raw-latex div, rendered by webview KaTeX (LaTeX2 button) ----
        if (hasRaw) {
            html = html.replace(/<div class="vscode-wolfram-wllatex-boxes-raw" data-boxes-b64="([^"]*)">\s*<\/div>/g,
                (_, b64) => {
                    const { boxStr, latex, error } = translate(b64);
                    const latexB64 = Buffer.from(latex).toString('base64');
                    const errorAttr = error ? ` data-btl-error="${this.escapeHtml(error)}"` : '';
                    const boxesAttr = ` data-boxes-b64="${b64}"`;
                    return `<div class="vscode-wolfram-wllatex-raw-latex" data-latex-b64="${latexB64}"${errorAttr}${boxesAttr}></div>`;
                });
        }
        return html;
    }

    makeTruncationBanner(outputId, headerText, shortLines = null) {
        const slAttr = shortLines !== null ? ` data-short-lines="${shortLines}"` : '';
        const btnStyle = 'padding:1px 6px;font-size:12px;cursor:pointer;line-height:1.5;' +
            'background:transparent;border:1px solid rgba(128,128,128,0.3);' +
            'border-radius:3px;color:var(--vscode-foreground,inherit);';
        return `
<div style="margin-top:3px;padding:2px 8px;display:flex;align-items:center;gap:6px;border-left:2px solid rgba(128,128,128,0.3);"
     data-truncated-uuid="${outputId}" data-session-epoch="${this._sessionEpoch}"${slAttr}>
  <span style="font-size:11px;color:var(--vscode-descriptionForeground,#888);flex:1;">${headerText}</span>
  <button data-action="expand" style="${btnStyle}" title="Show full output">&#9654;</button>
  <button data-action="expand-more" style="${btnStyle}" title="Show +20 more lines">&#43;&#8230;</button>
  <button data-action="open-text" style="${btnStyle}" title="Open as text file">&#128196;</button>
</div>`;
    }

    // -----------------------------------------------------------------------
    execute(cells, _notebook, _controller) {
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
    escapeWL(code) {
        return code.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // -----------------------------------------------------------------------
    async checkoutExecutionQueue() {
        const currentExecution = this.executionQueue.getNextPendingExecution();
        if (!currentExecution) return;

        // Was this cell queued via openDialogSubsession() on an idle kernel?
        // If so, add the "subsession" badge to every Out[...] label this run.
        const _isSubsession = this._subsessionCellUris.delete(
            currentExecution.execution.cell.document.uri.toString()
        );

        const code = currentExecution.execution.cell.document.getText();

        // Cancel the Dynamic loop for this cell before starting a new execution.
        if (this._dynamicWidgets) {
            const _cUri = currentExecution.execution.cell.document.uri.toString();
            const _prev = this._dynamicWidgets.get(_cUri);
            if (_prev) { _prev.active = false; scrollLog('[dyn] cancelled cell loop for re-execution'); }
        }
        if (this._dynCells) this._dynCells.delete(
            currentExecution.execution.cell.document.uri.toString());

        if (!code.trim()) {
            this.executionQueue.start(currentExecution.id);
            this.executionQueue.end(currentExecution.id, false);
            return;
        }

        // Clear previous diagnostics
        this.diagnosticCollection.delete(currentExecution.execution.cell.document.uri);
        this.clearSyntaxErrorDecorations(currentExecution.execution.cell);

        // Capture previous outputs BEFORE start() — VS Code clears them internally
        // when execution starts, causing a height-0 flash. We deep-snapshot the raw
        // item data so the objects remain valid after start() invalidates cell.outputs.
        const prevOutputsSnap = currentExecution.execution.cell.outputs.map(o => ({
            items: (o.items || []).map(it => ({ mime: it.mime, data: it.data }))
        }));
        const _t0 = Date.now();
        scrollLog('[start] cell', currentExecution.execution.cell.index,
                  '| prevOutputs:', prevOutputsSnap.length,
                  '| t=', _t0);

        this.executionQueue.start(currentExecution.id);
        scrollLog('[start] after executionQueue.start() | dt=', Date.now() - _t0, 'ms');

        // ---- Counter-scroll at execution START ----
        // executionQueue.start() triggers VS Code's internal revealRange showing the executing
        // cell. For long-running evaluations this means the viewport jumps at start and stays
        // wrong for the entire duration. Fire the same freeze/pin logic that we use at end-time,
        // so the viewport is correct from the very first frame of evaluation.
        {
            const _startCell = currentExecution.execution.cell;
            const _startNb   = _startCell.notebook;
            const _startIdx  = _startCell.index;
            const _startMode = this._pendingScrollMode || 'advance';
            const _startVae  = this._pendingViewportAtExecute;
            const _vaeS      = _startVae !== null ? _startVae : _startIdx;
            const _visibleAtStart = _startMode !== 'refine' || (_vaeS <= _startIdx + 1);
            scrollLog('[start-reveal] mode:', _startMode, '| vae:', _vaeS, '| cell:', _startIdx, '| visibleAtStart:', _visibleAtStart);

            if (_visibleAtStart) {
                const _doStartReveal = (label) => {
                    try {
                        for (const _sed of vscode.window.visibleNotebookEditors) {
                            if (_sed.notebook === _startNb) {
                                const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
                                if (_startMode === 'refine') {
                                    // Refine: freeze — do nothing if cell is still visible.
                                    // Only snap back with AtTop if VS Code scrolled it fully off-screen.
                                    // visibleRanges[0].start > cellIdx+1 means cell is fully above viewport.
                                    try {
                                        const _vrNow = _sed.visibleRanges;
                                        const _topNow = (_vrNow && _vrNow.length > 0) ? _vrNow[0].start : -1;
                                        if (_topNow > _startIdx + 1) {
                                            _sed.revealRange(new RC(_startIdx, _startIdx + 1),
                                                             vscode.NotebookEditorRevealType.AtTop);
                                            scrollLog('[start-reveal]', label, 'refine: cell scrolled off, AtTop cell', _startIdx, '(topNow=' + _topNow + ')');
                                        } else {
                                            scrollLog('[start-reveal]', label, 'refine: cell still visible, no-op (topNow=' + _topNow + ')');
                                        }
                                    } catch (_) {
                                        _sed.revealRange(new RC(_startIdx, _startIdx + 1),
                                                         vscode.NotebookEditorRevealType.AtTop);
                                    }
                                } else {
                                    // Advance: always AtTop — deterministic pin.
                                    _sed.revealRange(new RC(_startIdx, _startIdx + 1),
                                                     vscode.NotebookEditorRevealType.AtTop);
                                    scrollLog('[start-reveal]', label, 'advance: AtTop cell', _startIdx);
                                }
                                break;
                            }
                        }
                    } catch (e) { scrollLog('[start-reveal] error:', e.message); }
                };
                // Fire at t=0, t=16, t=32, t=50ms — covers every rAF frame in the
                // first 3 animation frames during which VS Code fires its internal scrolls.
                setTimeout(() => _doStartReveal('t=0'),  0);
                setTimeout(() => _doStartReveal('t=16'), 16);
                setTimeout(() => _doStartReveal('t=32'), 32);
                setTimeout(() => _doStartReveal('t=50'), 50);
            }
        }

        // Restore previous outputs WITHOUT await so start()+replaceOutput are sent
        // in the same synchronous JS turn. VS Code's extension host batches API calls
        // made in the same tick into a single IPC message, meaning clear+restore can
        // arrive at the renderer together — avoiding the one-frame blank-output flash.
        if (prevOutputsSnap.length > 0) {
            if (currentExecution.hasLaunchingPlaceholder) {
                // The only "previous" output is the "⏳ Kernel is starting…" placeholder
                // we wrote in execute().  Clear it so the real evaluation output starts fresh.
                currentExecution.execution.replaceOutput([]);  // no await
                scrollLog('[start] cleared launching placeholder | dt=', Date.now() - _t0, 'ms');
                currentExecution.hasLaunchingPlaceholder = false;
            } else {
                const restoredOutputs = prevOutputsSnap.map(o =>
                    new vscode.NotebookCellOutput(
                        o.items.map(it => new vscode.NotebookCellOutputItem(it.data, it.mime))
                    )
                );
                currentExecution.execution.replaceOutput(restoredOutputs);  // no await
                scrollLog('[start] replaceOutput(prevOutputs) fired (no-await) | dt=', Date.now() - _t0, 'ms');
            }
        }

        // ---- Record source for eval-mode auto-detection on next run ----
        // Stored at the START of execution so the NEXT Shift+Enter on this cell
        // can compare against the version that was actually evaluated.
        const _cellUriForLog = currentExecution.execution.cell.document.uri.toString();
        scrollLog('[checkout] recording source for cell', currentExecution.execution.cell.index,
                  '| uri:', _cellUriForLog.split('#')[1] || _cellUriForLog.slice(-20));
        this._cellLastSource.set(_cellUriForLog, code);
        // Clear dirty flag — the current source is now the baseline for next comparison.
        this._cellDirty.delete(_cellUriForLog);

        if (this.logFile !== "Off") {
            this.appendFileWrite(this.logFile, this.logString("Input: " + code));
        }

        try {
            if (!this.session) throw new Error("No kernel session — please launch the kernel first.");

            // ---- Split cell into top-level sub-expressions ----
            // Done entirely in JS on the raw source text so that:
            //   (a) no kernel round-trip needed (faster, no race with $Line),
            //   (b) % / %% / %%% are preserved verbatim (not resolved to Out[N-1]
            //       at parse time as ToExpression[...,HoldComplete] would do),
            //   (c) SyntaxLength treats "f\ng\nv" as one CompoundExpression
            //       so the kernel approach can't split individual newline-separated
            //       symbols correctly.
            //
            // Algorithm: walk char-by-char tracking bracket depth, string literals,
            // and nestable block comments.  Split on bare newlines at depth 0.
            const subExprs = (() => {
                const parts = [];
                let current = "";
                let depth   = 0;        // bracket nesting ( [ {
                let inStr    = false;    // inside "..."
                let cDepth   = 0;       // inside (* ... *) — nestable
                let i = 0;
                while (i < code.length) {
                    const ch   = code[i];
                    const next = i + 1 < code.length ? code[i + 1] : "";
                    if (inStr) {
                        current += ch;
                        if      (ch === "\\") { if (i + 1 < code.length) { current += next; i++; } }
                        else if (ch === '"')  { inStr = false; }
                        i++; continue;
                    }
                    if (cDepth > 0) {
                        current += ch;
                        if      (ch === "(" && next === "*") { cDepth++; current += next; i += 2; }
                        else if (ch === "*" && next === ")") { cDepth--; current += next; i += 2; }
                        else i++;
                        continue;
                    }
                    if (ch === '"')                    { inStr = true;  current += ch; i++; }
                    else if (ch === "(" && next === "*") { cDepth = 1; current += ch + next; i += 2; }
                    else if (ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; i++; }
                    else if (ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; i++; }
                    else if ((ch === "\n" || ch === "\r") && depth === 0 && cDepth === 0) {
                        // potential split point
                        const t = current.trim();
                        if (t.length > 0) parts.push(t);
                        current = "";
                        if (ch === "\r" && next === "\n") i++; // CRLF
                        i++;
                    } else { current += ch; i++; }
                }
                const t = current.trim();
                if (t.length > 0) parts.push(t);
                return parts.length > 0 ? parts : [code];
            })();
            // Per-cell format override takes precedence over the global setting.
            const format = this._resolveFormat(currentExecution.execution.cell);
            const scale  = Number(this.config.get("imageScale")   || 0.8);
            const maxLen = Number(this.config.get("maxOutputLength") || 105000);

            // ---- Set per-notebook image directory in the kernel ----
            // Each notebook gets its own img/ subfolder so SVG/PNG files from
            // different notebooks never collide.  The kernel saves each rendered
            // graphic as a UUID-named file and returns <img src="img/...">.
            const nbFsPath = currentExecution.execution.cell.notebook.uri.fsPath;
            const nbBase   = path.basename(nbFsPath, path.extname(nbFsPath));
            const imgDir   = path.join(path.dirname(nbFsPath), 'img', nbBase);
            const imgRel   = 'img/' + nbBase;  // relative to notebook dir

            // GC: scan all outputs NOW (before this execution changes them) — the
            // previous execution's outputs are committed at this point.  Delete
            // any .svg/.png in imgDir that are no longer referenced.  Pure Node.js
            // fs — no kernel round-trip, no timing dependency.
            this._cleanupImgDir(currentExecution.execution.cell.notebook, imgDir);

            // Wait for any ongoing idle sub() call to finish before starting evaluate().
            // Concurrent sub() + evaluate() on the same WSTP link causes
            // "WSGet out of sequence" / connection-lost errors.
            if (this._dynIdleMutex) await this._dynIdleMutex;

            // NOTE: _evalDispatched and _dispatchEpoch are set AFTER the setup phase
            // (syntax check + VsCodeSetImgDir) so the Dynamic widget does not interrupt
            // these sub()/evaluate() calls. Interrupting the syntax-check sub() while it
            // is in flight desynchronises the WSTP packet stream and causes the subsequent
            // cell evaluate() to hang forever. The flag is set just before the subExpr
            // loop, which is the earliest point the kernel is processing real cell code.

            // ---- Syntax check on full cell text (non-blocking, non-fatal) ----
            // IMPORTANT: must run AFTER await _dynIdleMutex so it does NOT race
            // with idle-path sub() calls from Dynamic widget loops. Concurrent
            // sub() calls on the same WSTP link cause "WSGet out of sequence".
            try {
                const syntaxResult = await this.session.sub(
                    "VsCodeSyntaxCheck[" + JSON.stringify(code) + "]"
                );
                if (syntaxResult && syntaxResult.type === "string" && syntaxResult.value) {
                    const syntaxJson = JSON.parse(syntaxResult.value);
                    if (syntaxJson.errors && syntaxJson.errors.length > 0) {
                        this.handleSyntaxErrors(currentExecution.execution.cell, syntaxJson.errors);
                    }
                }
            } catch (syntaxErr) {
                this.writeDebugLog(`[CHECKOUT] Syntax check error (non-fatal): ${syntaxErr.message}`);
            }

            try {
                await this.session.evaluate(
                    `VsCodeSetImgDir["${this.escapeWL(imgDir)}", "${this.escapeWL(imgRel)}"]`,
                    { interactive: false }
                );
            } catch (imgDirErr) {
                this.writeDebugLog(`[CHECKOUT] VsCodeSetImgDir failed (non-fatal): ${imgDirErr.message}`);
            }

            let firstLineNum = 0;
            let anyAborted   = false;

            // Detect keyboard-initiated execution (set by wolfram.executeCell command).
            // We compare by cell INDEX (number) + notebook reference rather than
            // object identity — VS Code may wrap cells in different proxy objects,
            // making === unreliable across the async execution boundary.
            // hasScrolled ensures we only scroll once — on first output — not on
            // every subsequent print line or result.
            const execCell       = currentExecution.execution.cell;
            const isKeyboardExec = (
                this._pendingScrollCellIndex    !== null &&
                this._pendingScrollCellIndex    === execCell.index &&
                this._pendingScrollCellNotebook === execCell.notebook
            );
            if (isKeyboardExec) {
                this._pendingScrollCellIndex    = null;
                this._pendingScrollCellNotebook = null;
            }
            const execMode  = this._pendingScrollMode || 'advance';
            // Scroll in Advance mode is now fired immediately on Shift+Enter (in
            // execute()), not here on first output — so no shouldScrollOnOutput flag.
            scrollLog(isKeyboardExec
                ? '[checkout-exec] cell ' + execCell.index + ' | mode: ' + execMode
                : '[checkout-exec] programmatic');

            // Mark that the interactive evaluation loop is about to start.
            // Dynamic widget loops gate interrupt() on this flag — before it is set,
            // queue[0].started is true but the kernel is still doing setup work
            // (syntax check sub() / VsCodeSetImgDir), and sending interrupt() on
            // those calls desynchronises the WSTP packet stream.
            this._evalDispatched = true;
            // NOTE: _cellEpoch increments at the END of the cell (just before executionQueue.end())
            // so LiveCells counts a cell only after all sub-expressions have finished and
            // all outputs have been committed and are visible.
            // _dispatchEpoch increments per sub-expression (inside the for loop) so that
            // LiveEvaluations counts individual sub-expression dispatches, not cell-level.
            scrollLog('[checkout] _evalDispatched = true | cell', currentExecution.execution.cell.index, '| cellEpoch (pre-cell)', this._cellEpoch);

            // ---- Evaluate each sub-expression one by one ----
            // Each goes through the interactive kernel main loop → gets its own
            // Out[N]= label and increments $Line.  Rendering is a separate batch
            // sub() call that reads Out[N] without polluting In/Out.
            //
            // _dynEarlyRef: set when a Dynamic widget is started inline (before the
            // cell's remaining sub-expressions run).  Deactivated after execution.end()
            // so the widget switches from replaceOutputItems to createNotebookCellExecution.
            let _dynEarlyRef = null;
            for (let i = 0; i < subExprs.length; i++) {
                if (this.isAborting) { anyAborted = true; break; }

                const subExpr = subExprs[i];

                // ---- Skip Dynamic[...] — bypass kernel entirely ----
                // Dynamic slots are rendered by the widget loop; we never send
                // Dynamic[...] to session.evaluate() (it would stall for a FrontEnd).
                // Place a placeholder, and if there are subsequent executable
                // sub-expressions in this same cell, start the widget loop NOW
                // (early-start) so it renders live while those sub-exprs run.
                if (subExpr.startsWith('Dynamic[') && subExpr.endsWith(']')) {
                    const _dynPlaceholder = new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(
                            '<div style="color:#888;font-style:italic;font-size:12px;padding:4px 0;">' +
                            '⏳ Dynamic — start a computation to see live updates</div>',
                            'x-application/wolfram-language-html'
                        )
                    ]);
                    if (currentExecution.hasOutput) {
                        await currentExecution.execution.appendOutput(_dynPlaceholder);
                    } else {
                        currentExecution.hasOutput = true;
                        await currentExecution.execution.replaceOutput(_dynPlaceholder);
                    }
                    // Early-start: trigger when this is the last Dynamic[...] placeholder
                    // placed AND there are still executable sub-expressions to follow.
                    // All Dynamic placeholders are now in cell.outputs, so snapOutputs in
                    // the widget is initialised with the full set of Dynamic slot objects.
                    if (!_dynEarlyRef) {
                        const _moreDyn   = subExprs.slice(i + 1).some(s => { const t = s.trim(); return t.startsWith('Dynamic[') && t.endsWith(']'); });
                        const _hasSubseq = subExprs.slice(i + 1).some(s => { const t = s.trim(); return t && !(t.startsWith('(*') && t.endsWith('*)')); });
                        if (!_moreDyn && _hasSubseq) {
                            const _dynExprsEarly = this._splitTopLevelExprs(code).filter(e => e.isDynamic);
                            if (_dynExprsEarly.length > 0) {
                                _dynEarlyRef = { exec: currentExecution.execution, active: true };
                                this._startDynamicCell(execCell, _dynExprsEarly, imgDir, imgRel, _dynEarlyRef);
                            }
                        }
                    }
                    continue;
                }

                // Skip pure comment sub-expressions entirely — they produce no kernel output
                // and must not count as a dispatch for LiveEvaluations / LiveCells.
                if (/^\(\*[\s\S]*\*\)$/.test(subExpr)) continue;
                // Increment per-sub-expression dispatch epoch.
                // LiveEvaluations tracks individual sub-expression dispatches after the
                // widget started.  Dynamic[...] and pure-comment slots do not count.
                this._dispatchEpoch = (this._dispatchEpoch + 1) & 0xFFFFFF;

                // Per-sub-expression print accumulator
                let printOutput       = null;
                let printHtml         = "";
                const printLineQueue  = [];
                let printFlushPending = false;

                const flushPrint = async () => {
                    if (printLineQueue.length === 0) { printFlushPending = false; return; }
                    const packets = printLineQueue.splice(0);
                    // Decode \012 → real newlines, then decode Wolfram octal byte escapes → Unicode.
                    // Each WSTP TextPacket becomes one <pre> block; internal newlines render
                    // as-is so OutputForm ASCII art (e.g. exponents above the line) is preserved.
                    const newHtml = packets.map(pkt => {
                        const text = this.decodeWolframOctal(pkt.replace(/\\012/g, '\n'));
                        return '<pre class="vscode-wolfram-print-output">' + this.escapeHtml(text) + '</pre>';
                    }).join('');
                    if (printOutput) {
                        printHtml += newHtml;
                        await currentExecution.execution.replaceOutputItems(
                            [vscode.NotebookCellOutputItem.text(printHtml, "x-application/wolfram-language-html")],
                            printOutput
                        );
                    } else {
                        printHtml   = newHtml;
                        printOutput = new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(printHtml, "x-application/wolfram-language-html")
                        ]);
                        if (currentExecution.hasOutput) {
                            await currentExecution.execution.appendOutput(printOutput);
                        } else {
                            currentExecution.hasOutput = true;  // set BEFORE await — prevents race with evaluate() resolving
                            await currentExecution.execution.replaceOutput(printOutput);
                        }
                    }
                    printFlushPending = false;
                    if (printLineQueue.length > 0) {
                        printFlushPending = true;
                        setImmediate(() => flushPrint());
                    }
                };

                // Evaluate the sub-expression interactively.
                // The kernel's main loop sets Out[N] and increments $Line automatically.
                // onMessage fires for kernel warnings/errors (e.g. Set::write for Protected).
                // onDialogBegin/onDialogPrint/onDialogEnd forward Dialog[] events to the
                // renderer so the dialog widget can appear while this eval is suspended.
                const r = await this.session.evaluate(subExpr, {
                    onPrint: line => {
                        printLineQueue.push(line);
                        if (!printFlushPending) {
                            printFlushPending = true;
                            setImmediate(() => flushPrint());
                        }
                    },
                    onMessage: async msg => {
                        const msgHtml =
                            '<div class="vscode-wolfram-message-output" style="color:#cc8800;padding:4px 0">' +
                            this.escapeHtml(msg) + "</div>";
                        const msgOut = new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(msgHtml, "x-application/wolfram-language-html")
                        ]);
                        if (currentExecution.hasOutput) {
                            await currentExecution.execution.appendOutput(msgOut);
                        } else {
                            currentExecution.hasOutput = true;  // set BEFORE await — prevents race with evaluate() resolving
                            await currentExecution.execution.replaceOutput(msgOut);
                        }
                        printOutput = null;  // next Print starts a fresh block
                    },
                    onDialogBegin: (level) => {
                    },
                    onDialogPrint: (line) => {
                        // Feed collector set by openDialogSubsession(); ignore otherwise.
                        if (this._dialogPrintCollector) this._dialogPrintCollector(line);
                    },
                    onDialogEnd: (level) => {
                    },
                });

                const lineN = r.cellIndex;
                if (i === 0 && lineN > 0) firstLineNum = lineN;
                // Force-flush any remaining print lines (synchronous callbacks
                // that fired before any await could yield).
                printFlushPending = false;
                if (printLineQueue.length > 0) await flushPrint();

                if (r.aborted) {
                    this.isAborting = false;
                    anyAborted = true;
                    // Do not show any output on abort — just stop silently.
                    break;
                }

                // ---- Render the result if non-Null (outputName non-empty) ----
                // VsCodeRender[N] reads Out[N] from the kernel's history via a
                // non-interactive evaluate() (EvaluatePacket) on the main kernel queue.
                // _renderingActive blocks Dynamic widget interrupts for the duration.
                if (r.outputName && lineN > 0) {
                    this._renderingActive = true;
                    try {
                        const renderResult = await this.session.evaluate(
                            `VsCodeRender[${lineN}, "${format}", ${scale}]`,
                            { interactive: false }
                        );
                        // ---- Forward any messages emitted during the render call ----
                        // e.g. $RecursionLimit::reclim from a recursive Format rule.
                        // In the non-interactive render path these were previously silently
                        // discarded because no onMessage callback was wired.  Now they are
                        // captured in renderResult.messages and shown as amber warning boxes.
                        for (const renderMsg of (renderResult.messages || [])) {
                            const msgHtml =
                                '<div class="vscode-wolfram-message-output" style="color:#cc8800;padding:4px 0">' +
                                this.escapeHtml(renderMsg) + '</div>';
                            const msgOut = new vscode.NotebookCellOutput([
                                vscode.NotebookCellOutputItem.text(msgHtml, "x-application/wolfram-language-html")
                            ]);
                            if (currentExecution.hasOutput) {
                                await currentExecution.execution.appendOutput(msgOut);
                            } else {
                                currentExecution.hasOutput = true;
                                await currentExecution.execution.replaceOutput(msgOut);
                            }
                        }

                        if (renderResult?.result?.type === "string" && renderResult.result.value) {
                            let html = this._processWLLatexBoxes(this._fixImageUris(renderResult.result.value));
                            const _subsBadge = _isSubsession
                                ? '<span style="font-size:9px;color:#e8a020;background:rgba(232,160,32,0.12);border:1px solid rgba(232,160,32,0.35);border-radius:3px;padding:1px 5px;margin-right:6px;font-style:italic;">subsession</span>'
                                : '';
                            const outLabel =
                                `${_subsBadge}<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;

                            // Detect skeleton (Short[] applied kernel-side) OR raw truncation
                            const isSkeleton = html.includes('data-wolfram-is-skeleton');
                            // Always generate a unique outputId — needed by format-switch buttons
                            // on ALL outputs (not only truncated ones).
                            const outputId = (this._outputIdCounter++).toString();
                            // isGfx: read the authoritative marker embedded by VsCodeRender/VsCodeRenderFull,
                            // NOT from CSS classes — those vary by format (WL/TeX/LaTeX have no image classes).
                            const _isGfx = html.includes('vscode-wolfram-gfx-marker');
                            // Re-resolve format now that isGfx is known: _resolveFormat sanitises
                            // incompatible format/type combos (e.g. WLLatex for a graphics output)
                            // so the header and format-switch buttons always reflect the right set.
                            const _effectiveFmt = this._resolveFormat(execCell, _isGfx);
                            this._outputRegistry.set(outputId,
                                { cell: execCell, outN: lineN, outName: r.outputName, format: _effectiveFmt, isGfx: _isGfx });
                            const headerRow = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" data-session-epoch="${this._sessionEpoch}" data-output-id="${outputId}" data-out-n="${lineN}" data-output-format="${_effectiveFmt}" data-output-is-graphics="${_isGfx ? '1' : '0'}">${outLabel}</div>`;
                            if (html.length > maxLen || isSkeleton) {                                const _oid = outputId;
                                // For raw truncation: clip at maxLen
                                const displayHtml = html.length > maxLen
                                    ? html.substring(0, maxLen)
                                    : html;
                                // Build banner label
                                let bannerLabel;
                                if (isSkeleton) {
                                    const m = html.match(/data-wolfram-atom-count="(\d+)"/);
                                    const atoms = m ? parseInt(m[1]).toLocaleString() : '?';
                                    bannerLabel = `&#128230; Large output &#8212; ${atoms} atoms (skeleton shown, full value in kernel)`;
                                } else {
                                    const fullKB  = (html.length  / 1024).toFixed(1);
                                    const shownKB = (displayHtml.length / 1024).toFixed(1);
                                    const pct = Math.min(100, Math.round(displayHtml.length / html.length * 100));
                                    bannerLabel = `&#9986; Output truncated &#8212; showing ${pct}% (${shownKB}&nbsp;KB&nbsp;/&nbsp;${fullKB}&nbsp;KB)`;
                                }
                                html = `<div class="wl-output-block">${headerRow}<div class="wl-output-content">${displayHtml}</div></div>` +
                                       this.makeTruncationBanner(outputId, bannerLabel);
                                this.truncatedOutputCells.set(_oid,
                                    { cell: currentExecution.execution.cell, outN: lineN, shortLines: 20, isSkeleton });
                                this.writeDebugLog(
                                    `[CHECKOUT] ${isSkeleton ? 'Skeleton' : 'Truncated'} output OutN=${lineN} OutputID=${_oid}`);
                            } else {
                                html = `<div class="wl-output-block">${headerRow}<div class="wl-output-content">${html}</div></div>`;
                            }

                            const outObj = new vscode.NotebookCellOutput([
                                vscode.NotebookCellOutputItem.text(html, "x-application/wolfram-language-html")
                            ]);
                            if (currentExecution.hasOutput) {
                                await currentExecution.execution.appendOutput(outObj);
                            } else {
                                scrollLog('[first-output] replaceOutput with real content | dt=', Date.now() - _t0, 'ms | cell', currentExecution.execution.cell.index);
                                await currentExecution.execution.replaceOutput(outObj);
                                currentExecution.hasOutput = true;
                            }
                        } else {
                            // Render returned non-string (most likely $Aborted from
                            // $RecursionLimit::reclim caused by a recursive Format rule,
                            // e.g. Format[x]=Style[x,Red]).  The message was shown above.
                            // Fall back to CheckAbort[ToString[Out[N], InputForm], ...].
                            try {
                                const fallback = await this.session.evaluate(
                                    `CheckAbort[ToString[Out[${lineN}], InputForm], "(output unavailable)"]`,
                                    { interactive: false }
                                );
                                const outLabel =
                                    `<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;
                                const fbText = (fallback?.result?.type === "string" && fallback.result.value)
                                    ? fallback.result.value : '(output unavailable)';
                                const fbHtml =
                                    `<div class="wl-output-block">` +
                                    `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;">${outLabel}</div>` +
                                    `<div class="wl-output-content">` +
                                    `<div class="vscode-wolfram-message-output" style="color:#cc8800;padding:4px 0">` +
                                    `Rendering failed \u2014 if you have a custom Format rule (e.g. <code>Format[x]=Style[x,Red]</code>), ` +
                                    `clear it with <code>Unset[Format[x]]</code> then re-evaluate.` +
                                    `</div>` +
                                    `<pre class="vscode-wolfram-text-output">${this.escapeHtml(fbText)}</pre>` +
                                    `</div></div>`;
                                const fbOut = new vscode.NotebookCellOutput([
                                    vscode.NotebookCellOutputItem.text(fbHtml, "x-application/wolfram-language-html")
                                ]);
                                if (currentExecution.hasOutput) {
                                    await currentExecution.execution.appendOutput(fbOut);
                                } else {
                                    await currentExecution.execution.replaceOutput(fbOut);
                                    currentExecution.hasOutput = true;
                                }
                            } catch (_) {}
                        }
                    } catch (renderErr) {
                        this.writeDebugLog(
                            `[CHECKOUT] Render error for sub ${i+1}: ${renderErr.message}`);
                        // InputForm fallback
                        try {
                            const fallback = await this.session.evaluate(
                                `ToString[Out[${lineN}], InputForm]`,
                                { interactive: false }
                            );
                            if (fallback?.result?.type === "string" && fallback.result.value) {
                                const outLabel =
                                    `<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;
                                const fbHtml =
                                    `<div>${outLabel}<pre class="vscode-wolfram-text-output">` +
                                    this.escapeHtml(fallback.result.value) + '</pre></div>';
                                const fbOut = new vscode.NotebookCellOutput([
                                    vscode.NotebookCellOutputItem.text(fbHtml, "x-application/wolfram-language-html")
                                ]);
                                if (currentExecution.hasOutput) {
                                    await currentExecution.execution.appendOutput(fbOut);
                                } else {
                                    await currentExecution.execution.replaceOutput(fbOut);
                                    currentExecution.hasOutput = true;
                                }
                            }
                        } catch (_) {}
                    } finally {
                        this._renderingActive = false;
                    }
                }
            }

            if (firstLineNum > 0) currentExecution.execution.executionOrder = firstLineNum;

            if (!currentExecution.hasOutput) {
                currentExecution.execution.clearOutput();
            }

            // ---- Capture refine-mode state BEFORE execution.end() ----
            const _wasRefine  = isKeyboardExec && execMode === 'refine';
            const _refineIdx  = _wasRefine ? execCell.index   : null;
            const _refineNb   = _wasRefine ? execCell.notebook : null;
            // Snapshot the saved cursor state for this execution before the
            // setTimeout closure captures a potentially stale this._refineSavedCursor.
            const _savedCursor    = _wasRefine ? this._refineSavedCursor    : null;
            const _savedCursorUri = _wasRefine ? this._refineSavedCursorUri : null;

            // ---- Read viewport-at-execute (captured at Shift+Enter time), then clear it ----
            const _viewportAtExecute = this._pendingViewportAtExecute;
            this._pendingViewportAtExecute = null;

            // ---- Temporarily collapse cell n+1 to suppress VS Code's [n,n+2) reveal ----
            // execution.end() internally calls revealRange([n, n+2), Default) — it tries to show
            // both the executed cell AND the next cell including its output. If cell n+1 has a
            // large output this scrolls the viewport far down.
            // Fix: collapse only the OUTPUT of cell n+1 BEFORE execution.end() so VS Code measures
            // it as a small stub (~28px) → minimal scroll.
            // IMPORTANT: do NOT set inputCollapsed:true — collapsing the Monaco editor and then
            // restoring it causes VS Code to lose the editor's line-count height measurement,
            // resulting in the cell showing only 2 lines even if it has 5+ lines of code.
            // outputCollapsed alone is sufficient to suppress the scroll jump.
            // Restore the original collapse state at t=20ms via updateCellMetadata.
            // updateCellMetadata does NOT move the viewport.
            let _nextCellCollapsed = false;
            let _nextCellCollapseIdx = -1;
            let _nextCellPrevMeta = null;
            if (isKeyboardExec) {
                try {
                    const _nextCell = execCell.notebook.cellAt(execCell.index + 1);
                    if (_nextCell) {
                        _nextCellCollapseIdx = _nextCell.index;
                        _nextCellPrevMeta = _nextCell.metadata || {};
                        // Only collapse if the cell has output (otherwise there's nothing to hide)
                        const _hasOutput = _nextCell.outputs && _nextCell.outputs.length > 0;
                        if (_hasOutput) {
                            const _collapseEdit = new vscode.WorkspaceEdit();
                            _collapseEdit.set(execCell.notebook.uri, [
                                vscode.NotebookEdit.updateCellMetadata(_nextCellCollapseIdx, {
                                    ..._nextCellPrevMeta,
                                    outputCollapsed: true
                                })
                            ]);
                            await vscode.workspace.applyEdit(_collapseEdit);
                            _nextCellCollapsed = true;
                            scrollLog('[pre-end-collapse-next] collapsed output of cell', _nextCellCollapseIdx,
                                      'to suppress [n,n+2) scroll');
                        }
                    }
                } catch (_e) {
                    scrollLog('[pre-end-collapse-next] error (non-fatal):', _e.message);
                    _nextCellCollapsed = false;
                    _nextCellCollapseIdx = -1;
                }
            }

            // _cellEpoch increments here — AFTER all sub-expression outputs are committed —
            // so LiveCells counts a cell only once the cell has fully completed.
            this._cellEpoch = (this._cellEpoch + 1) & 0xFFFFFF;
            scrollLog('[checkout-end] execution.end() about to fire — cell', execCell.index,
                      '| wasRefine:', _wasRefine, '| viewportAtExecute:', _viewportAtExecute, '| cellEpoch', this._cellEpoch);
            this.executionQueue.end(currentExecution.id, !anyAborted);
            this._evalDispatched = false;
            // Deactivate early-start ref — execution is now closed; subsequent
            // _putAllOutputs calls in the widget switch to createNotebookCellExecution.
            if (_dynEarlyRef) { _dynEarlyRef.active = false; _dynEarlyRef = null; }
            scrollLog('[checkout-end] _evalDispatched = false | execution.end() done');

            // Force-close any Dialog[] that a Dynamic widget cycle may have left open
            // when the main evaluation finished mid-cycle. isDialogOpen can be stale,
            // so call unconditionally whenever dynamic widgets are running.
            if (this._dynamicWidgets && this._dynamicWidgets.size > 0) {
                this.session.closeAllDialogs?.();
                // NOTE: do NOT reset _dynIdleMutex here. The idle path sets
                // _dynIdleMutex = new Promise(...) and calls session.sub() under that
                // mutex. Overriding it with Promise.resolve() lets checkoutExecutionQueue
                // bypass the lock — causing two concurrent session.sub() calls on the
                // same WSTP link, which desynchronises the packet stream and makes the
                // next session.evaluate() hang forever.  The idle sub() has a 3-second
                // Promise.race timeout and always calls _releaseIdle() in its finally
                // block, so checkoutExecutionQueue will unblock naturally within 3s max.
                // (The _dynIdleMutex reset IS kept in doAbort() where the kernel is
                //  explicitly killed and WSTP safety is not a concern.)
            }

            // ---- Dynamic widgets: scan all top-level expressions in the cell ----
            // Supports mixed cells: Dynamic[e1]\n1+1\nDynamic[e2] → 2 widgets + 1 static.
            // Non-Dynamic expressions are already rendered by the kernel; their outputs
            // are preserved in the shared per-cell outputs array and left untouched.
            {
                const _topExprs = this._splitTopLevelExprs(code);
                const _dynExprs = _topExprs.filter(e => e.isDynamic);
                scrollLog('[dyn] splitTopLevel | total exprs:', _topExprs.length,
                    '| dynExprs:', _dynExprs.length,
                    '| cell.outputs.length:', execCell.outputs.length,
                    '| exprs:', _topExprs.map(e => (e.isDynamic ? 'DYN' : 'static') + '[' + e.slotIndex + ']').join(', '));
                if (_dynExprs.length > 0) {
                    scrollLog('[dyn] found', _dynExprs.length, 'Dynamic expr(s) — starting cell loop | slots:',
                        _dynExprs.map(d => d.slotIndex + '=' + d.dynInner.slice(0, 20)).join(', '));
                    if (!this._dynCells) this._dynCells = new Map();
                    // If the widget was early-started (inline, before execution.end()),
                    // DON'T restart it — just refresh snapOutputs so it includes all
                    // outputs appended by the subsequent sub-expressions (Print/results).
                    const _cUri = execCell.document.uri.toString();
                    const _earlyState = this._dynamicWidgets && this._dynamicWidgets.get(_cUri);
                    if (_earlyState && _earlyState.earlyStart) {
                        const _fullOuts = Array.from(execCell.outputs);
                        this._dynCells.set(_cUri, { cell: execCell, outputs: _fullOuts });
                        _earlyState.refreshSnapshots(_fullOuts);
                    } else {
                        this._dynCells.set(execCell.document.uri.toString(),
                            { cell: execCell, outputs: Array.from(execCell.outputs) });
                        this._startDynamicCell(execCell, _dynExprs, imgDir, imgRel, null);
                    }
                }
            }

            // ---- Restore cell n+1 collapse state at t=20ms (after VS Code's rAF scroll has fired) ----
            if (_nextCellCollapsed && _nextCellCollapseIdx >= 0) {
                const _restNb2  = execCell.notebook;
                const _restIdx2 = _nextCellCollapseIdx;
                const _restMeta = _nextCellPrevMeta;
                setTimeout(async () => {
                    try {
                        const _restEdit = new vscode.WorkspaceEdit();
                        // Restore original metadata exactly — do NOT add
                        // inputCollapsed/outputCollapsed:false when they were
                        // absent, as that creates spurious diff noise in the notebook.
                        _restEdit.set(_restNb2.uri, [
                            vscode.NotebookEdit.updateCellMetadata(_restIdx2, { ..._restMeta })
                        ]);
                        await vscode.workspace.applyEdit(_restEdit);
                        scrollLog('[post-end-restore-next] t=20ms: uncollapsed cell', _restIdx2);
                    } catch (_e) {
                        scrollLog('[post-end-restore-next] error:', _e.message);
                    }
                }, 20);
            }

            // ---- Override VS Code's post-execution auto-scroll ----
            // VS Code's execution.end() internally reveals range [n, n+2) — both the
            // executed cell AND the next cell — to ensure output is visible. If cell n+1
            // is large, this scrolls far down. We override with AtTop(n) at t=0/16/32/50ms.
            //
            // AtTop is used for BOTH refine and advance:
            //   - It is deterministic: VS Code's Default([n,n+2)) cannot scroll the cell
            //     above the top of the viewport, so AtTop always wins.
            //   - InCenterIfOutsideViewport was wrong for refine: if VS Code moved the cell
            //     off-screen first, InCenter re-centers it — a large visible jump.
            //
            //   Refine + cell was clearly ABOVE viewport (_vae > cell+1): don't override.
            if (isKeyboardExec) {
                const _peNb   = execCell.notebook;
                const _peIdx  = execCell.index;
                const _vae    = _viewportAtExecute !== null ? _viewportAtExecute : _peIdx;
                // +1 margin: visibleRanges[0].start returns first FULLY visible cell;
                // partially-visible top cell gives start = cellIndex+1.
                const _cellWasVisible = !_wasRefine || (_vae <= _peIdx + 1);
                scrollLog('[post-end-reveal] cellWasVisible:', _cellWasVisible, '| _vae:', _vae, '| cell:', _peIdx);

                if (_cellWasVisible) {
                    const _doReveal = (label) => {
                        try {
                            for (const ed of vscode.window.visibleNotebookEditors) {
                                if (ed.notebook === _peNb) {
                                    const RangeCtor = vscode.NotebookRange ?? vscode.NotebookCellRange;
                                    if (_wasRefine) {
                                        // Refine: freeze — only act if VS Code scrolled cell fully off-screen.
                                        // visibleRanges[0].start > cellIdx+1 ⇒ cell is fully above viewport.
                                        try {
                                            const _vrNow = ed.visibleRanges;
                                            const _topNow = (_vrNow && _vrNow.length > 0) ? _vrNow[0].start : -1;
                                            if (_topNow > _peIdx + 1) {
                                                ed.revealRange(new RangeCtor(_peIdx, _peIdx + 1),
                                                               vscode.NotebookEditorRevealType.AtTop);
                                                scrollLog('[post-end-reveal]', label, 'refine: cell scrolled off, AtTop cell', _peIdx, '(topNow=' + _topNow + ')');
                                            } else {
                                                scrollLog('[post-end-reveal]', label, 'refine: cell still visible, no-op (topNow=' + _topNow + ')');
                                            }
                                        } catch (_) {
                                            ed.revealRange(new RangeCtor(_peIdx, _peIdx + 1),
                                                           vscode.NotebookEditorRevealType.AtTop);
                                        }
                                    } else {
                                        // Advance: always AtTop — deterministic pin.
                                        ed.revealRange(new RangeCtor(_peIdx, _peIdx + 1),
                                                       vscode.NotebookEditorRevealType.AtTop);
                                        scrollLog('[post-end-reveal]', label, 'advance: AtTop cell', _peIdx);
                                    }
                                    break;
                                }
                            }
                        } catch (e) {
                            scrollLog('[post-end-reveal] error (non-fatal):', e.message);
                        }
                    };
                    // t=0/16/32/50ms: cover every rAF frame during which VS Code fires its scroll.
                    setTimeout(() => _doReveal('t=0'),  0);
                    setTimeout(() => _doReveal('t=16'), 16);
                    setTimeout(() => _doReveal('t=32'), 32);
                    setTimeout(() => _doReveal('t=50'), 50);
                } else {
                    scrollLog('[post-end-reveal] cell', _peIdx, 'clearly above viewport at execute (_vae=' + _vae + ') — not overriding VS Code scroll');
                }
            }

            // ---- Refine mode: restore selection + edit mode + cursor AFTER execution.end() ----
            // execution.end() may cause VS Code to emit post-execution selection events.
            // setTimeout(0) runs after those events.
            if (_wasRefine) {
                scrollLog('[refine-post-end] scheduling restore for cell', _refineIdx);
                setTimeout(() => {
                    // 1. Restore notebook cell selection (no viewport movement)
                    scrollLog('[refine-post-end t=0] restoring selection to cell', _refineIdx);
                    this._restoreSelection(_refineIdx, _refineNb);

                    // 2. Enter edit mode via showTextDocument — targets the cell's
                    //    TextDocument URI directly, bypassing the notebook.cell.edit
                    //    command which internally calls focusNotebookCell →
                    //    revealInViewAtTop and unconditionally scrolls the viewport.
                    //    showTextDocument enters edit mode without the automatic
                    //    revealRange that `selection` in ShowOptions would trigger.
                    //    We restore the cursor manually on the returned editor so
                    //    that setting .selection on an already-focused doc does NOT
                    //    call revealRange and does NOT scroll the viewport.
                    setTimeout(() => {
                        scrollLog('[refine-post-end t=30] entering edit mode via showTextDocument on cell', _refineIdx);
                        try {
                            const _editCell = _refineNb.cellAt(_refineIdx);

                            // If no cursor was saved, the user was in command mode when
                            // Shift+Enter was pressed (activeTextEditor was null at that time).
                            // In that case, stay in command mode after execution — do NOT call
                            // showTextDocument, which would scroll the viewport via revealRange.
                            if (!_savedCursor) {
                                scrollLog('[refine-post-end t=30] _savedCursor is null (command mode) — skipping showTextDocument, staying in command mode');
                                return;
                            }

                            // If the active text editor is already this cell's document,
                            // don't call showTextDocument at all — it would call revealRange
                            // internally even without a `selection` option, scrolling the viewport.
                            // Just restore the cursor directly on the active editor.
                            const _activeEd = vscode.window.activeTextEditor;
                            if (_activeEd && _activeEd.document.uri.toString() === _editCell.document.uri.toString()) {
                                scrollLog('[refine-post-end t=30] cell already active editor — skipping showTextDocument, restoring cursor only');
                                if (_savedCursor && _activeEd) {
                                    _activeEd.selection = _savedCursor;
                                    scrollLog('[refine-post-end] cursor restored on already-active editor');
                                }
                                return;
                            }

                            const _showOpts = {
                                preview: false,
                                viewColumn: vscode.ViewColumn.Active,
                                // NOTE: `selection` is intentionally omitted here.
                                // Passing `selection` to showTextDocument causes VS Code to call
                                // revealRange internally, which scrolls the viewport to show the
                                // cursor — exactly what Refine mode must NOT do.
                                // Instead we set ed.selection manually after the promise resolves;
                                // mutating .selection on an already-focused TextEditor does not
                                // trigger revealRange and therefore does not move the viewport.
                            };
                            scrollLog('[refine-post-end t=30] showTextDocument (no selection option) — cursor will be set manually');
                            vscode.window.showTextDocument(_editCell.document, _showOpts).then(
                                (ed) => {
                                    // Restore cursor without scrolling: set .selection directly on
                                    // the already-open editor (does NOT call revealRange).
                                    if (_savedCursor && ed) {
                                        ed.selection = _savedCursor;
                                        scrollLog('[refine-post-end] cursor restored manually —',
                                            `anchor(${_savedCursor.anchor.line},${_savedCursor.anchor.character})`,
                                            `active(${_savedCursor.active.line},${_savedCursor.active.character})`);
                                    } else {
                                        scrollLog('[refine-post-end] showTextDocument resolved — edit mode entered (no saved cursor)');
                                    }
                                },
                                e => {
                                    // Fallback: showTextDocument may fail for some cell URI schemes.
                                    // Fall back to notebook.cell.edit + manual cursor restore.
                                    scrollLog('[refine-post-end] showTextDocument error:', e?.message,
                                              '— falling back to notebook.cell.edit');
                                    vscode.commands.executeCommand('notebook.cell.edit').then(() => {
                                        if (_savedCursor && _savedCursorUri) {
                                            const txtEd = vscode.window.activeTextEditor;
                                            if (txtEd && txtEd.document.uri.toString() === _savedCursorUri) {
                                                txtEd.selection = _savedCursor;
                                                scrollLog('[refine-post-end] fallback cursor restored');
                                            }
                                        }
                                    }, () => {});
                                }
                            );
                        } catch (e) {
                            scrollLog('[refine-post-end] showTextDocument exception:', e?.message);
                        }
                    }, 30);
                }, 0);
            }

        } catch (err) {
            // "Cannot modify cell output after calling resolve" is a benign race
            // that occurs when abort clears the execution before output arrives.
            // Silently ignore it — do not write to the Output panel.
            const isResolvedRace = err.message && err.message.includes('Cannot modify cell output after calling resolve');
            if (isResolvedRace) {
                this.executionQueue.end(currentExecution.id, false);
                this.checkoutExecutionQueue();
                return;
            }
            // For all other errors, write to the debug log file only (not the Output panel).
            if (this.logFile !== 'Off') {
                try { fs.appendFileSync(this.logFile, `[CHECKOUT] Fatal error: ${err.message}\n`); } catch (_) {}
            }
            // If the session is broken (link error), mark it dead so user knows to restart
            const isFatal = err.message && (
                err.message.includes("WSGetFunction") ||
                err.message.includes("WSTP link") ||
                err.message.includes("Session is closed") ||
                err.message.includes("WSNextPacket") ||
                err.message.includes("ILLEGALPKT")
            );
            await currentExecution.execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(
                        `<div style="color:red;padding:8px;border:1px solid red;border-radius:4px">
                          ${isFatal ? '&#128165; Fatal kernel error — please restart:<br>' : ''}
                          ${this.escapeHtml(err.message)}</div>`,
                        "text/html"
                    )
                ])
            ]);
            this.executionQueue.end(currentExecution.id, false);
            // If fatal link error — auto-restart the session
            if (isFatal && this.session) {
                this.writeDebugLog("[CHECKOUT] Fatal link error — auto-restarting session");
                vscode.window.showWarningMessage("Kernel link error detected — restarting kernel automatically.");
                this.restartKernel();
                return;  // don't call checkoutExecutionQueue; restartKernel does it after relaunch
            }
        }

        this.checkoutExecutionQueue();
    }

    // -----------------------------------------------------------------------
    // Replace a truncated output (identified by its data-truncated-uuid) with fullHtml
    async _replaceOutputByUuid(cell, uuid, fullHtml, outN) {
        // Look up stored metadata so that after expansion the format buttons are
        // rebuilt with the correct format, outName, and graphics flag.
        const regInfo    = this._outputRegistry.get(uuid);
        const fmt        = regInfo?.format || 'Auto';
        const outName    = regInfo?.outName || ('Out[' + outN + ']=');
        const outLabel   = `<span style="font-size:10px;color:#888;margin-right:8px;">${outName}</span>`;
        const _isGfxUuid = regInfo?.isGfx ?? (fullHtml.includes('vscode-wolfram-svg-output') || fullHtml.includes('vscode-wolfram-png-output'));
        const finalHtml =
            `<div class="wl-output-block">` +
            `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" ` +
            `data-session-epoch="${this._sessionEpoch}" data-output-id="${uuid}" ` +
            `data-out-n="${outN}" data-output-format="${fmt}" data-output-is-graphics="${_isGfxUuid ? '1' : '0'}">${outLabel}</div>` +
            `<div class="wl-output-content">${fullHtml}</div>` +
            `</div>`;
        // Snapshot outputs BEFORE start() — start() can clear cell.outputs in some VS Code versions
        let targetIndex = -1;
        const allOutputs = [...cell.outputs];
        for (let i = 0; i < allOutputs.length; i++) {
            const output = allOutputs[i];
            if (output.items && output.items.length > 0) {
                try {
                    const html = new TextDecoder().decode(output.items[0].data);
                    if (html.includes(`data-truncated-uuid="${uuid}"`)) {
                        targetIndex = i;
                        break;
                    }
                } catch (_) {}
            }
        }
        if (targetIndex === -1) {
            vscode.window.showWarningMessage("Could not find truncated output to replace.");
            return;
        }

        allOutputs[targetIndex] = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(finalHtml, "x-application/wolfram-language-html")
        ]);
        const tempExec = this._controller.createNotebookCellExecution(cell);
        tempExec.start();
        tempExec.replaceOutput(allOutputs);
        tempExec.end(true);
    }

    // -----------------------------------------------------------------------
    // Replace any output identified by its data-output-id (for format switching).
    // Rebuilds the header with the new format data attribute so buttons stay correct.
    async _replaceOutputById(cell, outputId, contentHtml, outN, outName, newFormat, bannerHtml = '') {
        const outLabel   = `<span style="font-size:10px;color:#888;margin-right:8px;">${outName || ('Out[' + outN + ']=')} </span>`;
        // Prefer stored isGfx flag (set at initial render) so switching to WL/TeX doesn't
        // lose the graphics-specific button set.
        const _regEntry  = this._outputRegistry.get(outputId);
        const _isGfxById = _regEntry?.isGfx ?? (contentHtml.includes('vscode-wolfram-svg-output') || contentHtml.includes('vscode-wolfram-png-output'));
        const headerRow  = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" ` +
                           `data-session-epoch="${this._sessionEpoch}" data-output-id="${outputId}" ` +
                           `data-out-n="${outN}" data-output-format="${newFormat}" data-output-is-graphics="${_isGfxById ? '1' : '0'}">${outLabel}</div>`;
        const finalHtml  = `<div class="wl-output-block">${headerRow}<div class="wl-output-content">${contentHtml}</div></div>` + bannerHtml;

        let targetIndex = -1;
        const allOutputs = [...cell.outputs];
        for (let i = 0; i < allOutputs.length; i++) {
            const output = allOutputs[i];
            if (output.items && output.items.length > 0) {
                try {
                    const html = new TextDecoder().decode(output.items[0].data);
                    if (html.includes(`data-output-id="${outputId}"`)) {
                        targetIndex = i;
                        break;
                    }
                } catch (_) {}
            }
        }
        if (targetIndex === -1) {
            this.outputPanel.print(`[_replaceOutputById] outputId ${outputId} not found in cell outputs`);
            return;
        }
        allOutputs[targetIndex] = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(finalHtml, "x-application/wolfram-language-html")
        ]);
        const tempExec = this._controller.createNotebookCellExecution(cell);
        tempExec.start();
        tempExec.replaceOutput(allOutputs);
        tempExec.end(true);
    }

    // -----------------------------------------------------------------------
    // GC: scan all cell outputs AND markdown source for image paths still live,
    // then delete every .svg/.png in imgDir that is not referenced.
    // Runs synchronously via Node.js fs — no kernel round-trip, no timing issues.
    // Called at the START of each execution, and on notebook cell changes.
    _cleanupImgDir(notebook, imgDir) {
        try {
            if (!imgDir || !fs.existsSync(imgDir)) return;
            const nbDir  = path.dirname(notebook.uri.fsPath);
            // Collect all currently-referenced absolute image paths
            const live = new Set();
            for (const cell of notebook.getCells()) {
                // 1) Scan rendered outputs for data-wl-img (Wolfram graphics)
                for (const output of cell.outputs) {
                    for (const item of output.items) {
                        try {
                            const html = new TextDecoder().decode(item.data);
                            for (const m of html.matchAll(/data-wl-img="([^"]+)"/g)) {
                                live.add(m[1]);
                            }
                        } catch (_) {}
                    }
                }
                // 2) Scan Markdown source text for pasted images: ![...](img/...)
                if (cell.kind === vscode.NotebookCellKind.Markup) {
                    const src = cell.document.getText();
                    for (const m of src.matchAll(/\(!.*?\)\s*\(([^)]+\.(?:png|svg))\)/gi)) {
                        const rel = m[1];
                        live.add(path.isAbsolute(rel) ? rel : path.join(nbDir, rel));
                    }
                    // Also match bare Markdown image: ![alt](path)
                    for (const m of src.matchAll(/!\[[^\]]*\]\(([^)]+\.(?:png|svg))\)/gi)) {
                        const rel = m[1];
                        live.add(path.isAbsolute(rel) ? rel : path.join(nbDir, rel));
                    }
                    // Also match HTML img tag: <img src="path">
                    for (const m of src.matchAll(/src="([^"]+\.(?:png|svg))"/gi)) {
                        const rel = m[1];
                        live.add(path.isAbsolute(rel) ? rel : path.join(nbDir, rel));
                    }
                }
            }
            // Delete any .svg/.png not in the live set
            const files = fs.readdirSync(imgDir);
            let deleted = 0;
            for (const fname of files) {
                if (!/\.(svg|png)$/i.test(fname)) continue;
                const fpath = path.join(imgDir, fname);
                if (!live.has(fpath)) {
                    try { fs.unlinkSync(fpath); deleted++; } catch (_) {}
                }
            }
        } catch (err) {
            this.writeDebugLog(`[GC] _cleanupImgDir failed (non-fatal): ${err.message}`);
        }
    }

    // -----------------------------------------------------------------------
    handleSyntaxErrors(cell, errors) {
        const cellText    = cell.document.getText();
        const diagnostics = [];
        const ranges      = [];

        for (const error of errors) {
            let range;
            if (error.line !== undefined && error.column !== undefined) {
                const line   = Math.max(0, error.line - 1);
                const col    = Math.max(0, error.column - 1);
                range = new vscode.Range(
                    new vscode.Position(line, col),
                    new vscode.Position(line, col + 1)
                );
            } else if (error.character !== undefined) {
                const charPos = Math.max(0, Math.min(error.character, cellText.length));
                const pos     = cell.document.positionAt(charPos);
                range = new vscode.Range(pos, pos.translate(0, 1));
            } else {
                continue;
            }
            const diag = new vscode.Diagnostic(range, error.message || "Syntax error",
                vscode.DiagnosticSeverity.Error);
            diag.source = "Wolfram";
            diagnostics.push(diag);
            ranges.push(range);
        }

        this.diagnosticCollection.set(cell.document.uri, diagnostics);
        this.applySyntaxErrorDecorations(cell, ranges);
    }

    applySyntaxErrorDecorations(cell, ranges) {
        if (ranges.length === 0) return;
        const cellKey = cell.document.uri.toString();
        this.cellDecorations.set(cellKey, ranges);
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === cellKey
        );
        if (!editor) return;

        // Pulsing animation
        let pulseCount = 0;
        const pulse = () => {
            if (pulseCount >= 6) {
                editor.setDecorations(this.syntaxErrorDecoration, ranges);
                return;
            }
            const dt = vscode.window.createTextEditorDecorationType({
                backgroundColor: pulseCount % 2 === 0 ? "rgba(255,0,0,0.5)" : "rgba(255,0,0,0.2)",
                border: "2px solid rgba(255,0,0,0.8)",
                borderRadius: "3px",
                isWholeLine: false,
            });
            editor.setDecorations(dt, ranges);
            pulseCount++;
            setTimeout(() => { dt.dispose(); pulse(); }, 200);
        };
        pulse();
    }

    clearSyntaxErrorDecorations(cell) {
        const cellKey = cell.document.uri.toString();
        this.cellDecorations.delete(cellKey);
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === cellKey
        );
        if (editor) editor.setDecorations(this.syntaxErrorDecoration, []);
    }

    // -----------------------------------------------------------------------
    // ⌥⇧↵ — evaluate the active cell inside a Dialog[] subsession on the
    // live running kernel, write the result to that cell's output with a
    // "Dialog: Out" label, then exit the dialog so the main eval resumes.
    //
    // Flow:
    //   1. Interrupt the kernel → Wolfram interrupt handler opens Dialog[].
    //   2. Poll until session.isDialogOpen (max 5 s).
    //   3. dialogEval(cellCode) → WExpr result; Print[] lines collected via
    //      onDialogPrint on the in-flight checkoutExecutionQueue evaluate().
    //   4. exitDialog() → main evaluation resumes.
    //   5. Write result + print lines to the cell's output.
    async openDialogSubsession() {
        if (!this.session || this.kernelStatusString !== 'resolved') {
            vscode.window.showWarningMessage('No kernel running — start the kernel first.');
            return;
        }
        if (this.session.isDialogOpen) {
            vscode.window.showWarningMessage('A dialog subsession is already open.');
            return;
        }
        // Resolve the active cell first — needed for both idle and busy paths.
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) { vscode.window.showWarningMessage('No active notebook editor.'); return; }
        const sel = editor.selections;
        if (!sel || sel.length === 0) { vscode.window.showWarningMessage('No cell selected.'); return; }
        const cell = editor.notebook.cellAt(sel[0].start);
        if (!cell || cell.kind !== vscode.NotebookCellKind.Code) {
            vscode.window.showWarningMessage('Select a code cell to evaluate in the dialog (select a code cell first).');
            return;
        }
        const cellCode = cell.document.getText().trim();
        if (!cellCode) { vscode.window.showWarningMessage('Cell is empty.'); return; }

        const busy = this.executionQueue.queue.length > 0 && this.executionQueue.queue[0].started;

        // ---- Idle kernel: queue cell through the normal execution pipeline ----
        // The full rendering machinery (SVG graphics, LaTeX, format buttons, etc.)
        // applies exactly as with Shift+Enter.  The only visible difference is the
        // amber "subsession" badge placed next to each Out[...]=  label.
        if (!busy) {
            this._subsessionCellUris.add(cell.document.uri.toString());
            const execution = this._controller.createNotebookCellExecution(cell);
            this.executionQueue.push(execution);
            this.checkoutExecutionQueue();
            return;
        }

        // ---- Busy kernel: interrupt and open Dialog[] subsession ----
        // Collect Print[] lines from inside the dialog via onDialogPrint
        const dialogPrintLines = [];
        this._dialogPrintCollector = line => dialogPrintLines.push(line);

        const sent = this.session.interrupt();
        if (!sent) {
            this._dialogPrintCollector = null;
            vscode.window.showWarningMessage('Could not send interrupt to kernel.');
            return;
        }

        // Poll until dialog opens (max 8 s); show status so user knows it's working
        const statusMsg = vscode.window.setStatusBarMessage('⏳ Dialog: waiting for kernel interrupt…');
        const deadline = Date.now() + 8000;
        while (!this.session.isDialogOpen && Date.now() < deadline) {
            await new Promise(res => setTimeout(res, 50));
        }
        statusMsg.dispose();
        if (!this.session.isDialogOpen) {
            this._dialogPrintCollector = null;
            vscode.window.showWarningMessage(
                'Kernel did not open Dialog[] within 8 s. ' +
                'The computation may have finished, or the kernel may be unresponsive. ' +
                'Try again, or restart the kernel.'
            );
            return;
        }
        // Notebook image directory so the subkernel can save SVG files there.
        const _subNbPath = cell.notebook.uri.fsPath;
        const _subNbBase = path.basename(_subNbPath, path.extname(_subNbPath));
        const _subImgDir = path.join(path.dirname(_subNbPath), 'img', _subNbBase);
        const _subImgRel = 'img/' + _subNbBase;
        try { fs.mkdirSync(_subImgDir, { recursive: true }); } catch (_) {}

        const _dlgFormat = this._resolveFormat(cell);
        const _dlgScale  = Number(this.config.get('imageScale') || 0.8);

        // Create a VS Code execution for this cell so it shows the running spinner.
        const execution = this._controller.createNotebookCellExecution(cell);
        execution.start(Date.now());
        await execution.replaceOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(
                '<div style="color:#e8a020;font-size:11px;font-style:italic;">⏳ Subsession: evaluating…</div>',
                'x-application/wolfram-language-html'
            )
        ])]);

        // Step 1: Evaluate cellCode inside the Dialog[], Export to a fixed .mx file,
        // then return the path. No intermediate variables — avoids Module/With issues.
        const _tmpFile = _subImgDir.replace(/\\/g, '/') + '/_subsession_transfer.mx';
        const _dlgSentExpr = '(Export["' + _tmpFile + '", ToExpression["' +
            this.escapeWL(cellCode) + '"]]; "' + _tmpFile + '")';
        scrollLog('[subsession-dlg] cellCode:', cellCode);
        scrollLog('[subsession-dlg] tmp file:', _tmpFile);
        scrollLog('[subsession-dlg] sent to dialogEval:', _dlgSentExpr);
        let _dlgTmpFile = null;
        let _dlgEvalError = null;
        try {
            const _dlgWexpr = await this.session.dialogEval(_dlgSentExpr);
            scrollLog('[subsession-dlg] raw WExpr back:', JSON.stringify(_dlgWexpr));
            // We already know _tmpFile in JS — just check Export didn't return $Failed.
            // Don't use _dlgWexpr.value as path: TEXTPKT wrapping breaks paths with spaces.
            const _rawVal = (_dlgWexpr && _dlgWexpr.value) ? String(_dlgWexpr.value) : '';
            if (_dlgWexpr && (_dlgWexpr.type === 'string' || _dlgWexpr.type === 'symbol') &&
                    !_rawVal.includes('Failed') && !_rawVal.includes('$Failed')) {
                _dlgTmpFile = _tmpFile;  // use our JS-computed path directly
                scrollLog('[subsession-dlg] Export succeeded, using JS path:', _dlgTmpFile);
            } else if (_dlgWexpr && _dlgWexpr.error) {
                _dlgEvalError = _dlgWexpr.error;
                scrollLog('[subsession-dlg] WExpr error:', _dlgEvalError);
            } else {
                _dlgEvalError = 'Export returned: ' + JSON.stringify(_dlgWexpr);
                scrollLog('[subsession-dlg] Export failed:', _dlgEvalError);
            }
        } catch (_err) {
            _dlgEvalError = _err.message;
            scrollLog('[subsession-dlg] dialogEval threw:', _dlgEvalError);
        }

        const _dlgPrintLines = [...dialogPrintLines];
        this._dialogPrintCollector = null;

        // Step 2: Exit dialog immediately — main kernel resumes.
        // Subkernel render runs independently after this.
        try { await this.session.exitDialog(); } catch (_) {}
        scrollLog('[subsession-dlg] exitDialog() done');

        // Step 3: Render via the subkernel — full VsCodeRenderExpr pipeline
        // (SVG/PNG graphics, WLLatex, MathML, etc.) identical to normal evaluation.
        const _subsBadge =
            '<span style="font-size:9px;color:#e8a020;background:rgba(232,160,32,0.12);' +
            'border:1px solid rgba(232,160,32,0.35);border-radius:3px;padding:1px 5px;' +
            'margin-right:6px;font-style:italic;">subsession</span>';

        const parts = [];

        if (_dlgPrintLines.length > 0) {
            const printHtml = _dlgPrintLines.map(line => {
                const text = this.decodeWolframOctal(line.replace(/\\012/g, '\n'));
                return '<pre class="vscode-wolfram-print-output">' + this.escapeHtml(text) + '</pre>';
            }).join('');
            parts.push(printHtml);
        }

        if (_dlgEvalError || _dlgTmpFile === null) {
            const _errMsg = _dlgEvalError || 'dialog eval returned no result';
            parts.push(
                '<div style="display:flex;align-items:baseline;gap:4px;padding:3px 0">' +
                _subsBadge +
                '<span style="font-size:10px;color:#e8a020;margin-right:8px;">Out=</span>' +
                '<span style="color:#f44747;font-family:Consolas,monospace;font-size:13px;">' +
                this.escapeHtml(_errMsg) + '</span></div>'
            );
        } else {
            let _renderHtml  = null;
            let _renderError = null;
            try {
                const _subKern = await this._ensureSubKernel(_subImgDir, _subImgRel);
                // Import the .mx file — binary WL expression, no encoding issues.
                const _subExpr = 'VsCodeRenderExpr[Import["' + _dlgTmpFile +
                    '"], "' + _dlgFormat + '", ' + _dlgScale + ']';
                scrollLog('[subsession-render] tmp file:', _dlgTmpFile);
                scrollLog('[subsession-render] VsCodeRenderExpr call:', _subExpr);
                const _renderResult = await _subKern.evaluate(_subExpr, { interactive: false });
                scrollLog('[subsession-render] result type:', _renderResult?.result?.type,
                          '| value length:', _renderResult?.result?.value?.length ?? 'n/a',
                          '| messages:', JSON.stringify(_renderResult?.messages ?? []));
                // Clean up temp file regardless of render result.
                try { require('fs').unlinkSync(_dlgTmpFile); } catch (_) {}
                if (_renderResult && _renderResult.result &&
                        _renderResult.result.type === 'string' && _renderResult.result.value) {
                    _renderHtml = this._processWLLatexBoxes(
                        this._fixImageUris(_renderResult.result.value)
                    );
                } else {
                    _renderError = 'subkernel render returned no HTML — result: ' +
                        JSON.stringify(_renderResult?.result);
                    scrollLog('[subsession-render] NO HTML:', _renderError);
                }
            } catch (_re) {
                _renderError = _re.message;
                scrollLog('[subsession-render] threw:', _renderError);
            }

            const _headerLabel =
                _subsBadge +
                '<span style="font-size:10px;color:#888;margin-right:8px;">Out=</span>';

            if (_renderHtml) {
                const _headerRow =
                    '<div class="wl-output-header" style="display:flex;align-items:center;' +
                    'gap:6px;width:100%;min-height:22px;" data-session-epoch="' + this._sessionEpoch + '">' +
                    _headerLabel + '</div>';
                parts.push(
                    '<div class="wl-output-block">' + _headerRow +
                    '<div class="wl-output-content">' + _renderHtml + '</div></div>'
                );
            } else {
                // Subkernel render failed — InputForm text fallback.
                const _errNote = _renderError
                    ? '<div style="color:#FFA500;font-size:11px;margin:0 0 2px;">Render failed (' +
                      this.escapeHtml(_renderError) + ') — showing InputForm</div>'
                    : '';
                parts.push(
                    '<div style="padding:3px 0">' +
                    '<div style="display:flex;align-items:baseline;gap:4px;margin-bottom:2px;">' +
                    _headerLabel + '</div>' +
                    _errNote +
                    '<pre class="vscode-wolfram-text-output" style="white-space:pre-wrap;' +
                    'overflow-wrap:break-word;margin:0;">' +
                    this.escapeHtml('(tmp file: ' + (_dlgTmpFile || 'none') + ')') + '</pre></div>'
                );
            }
        }

        await execution.replaceOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(
                '<div data-session-epoch="' + this._sessionEpoch + '">' + parts.join('') + '</div>',
                'x-application/wolfram-language-html'
            )
        ])]);
        execution.end(true, Date.now());
    }

    // -----------------------------------------------------------------------
    // Split cell code into top-level WL expressions, bracket-depth aware.
    // Returns [{text, slotIndex, isDynamic, dynInner}].
    _splitTopLevelExprs(code) {
        const exprs = [];
        let depth = 0, inStr = false, start = 0;
        for (let i = 0; i < code.length; i++) {
            const ch = code[i];
            if (inStr) {
                if (ch === '\\') i++;
                else if (ch === '"') inStr = false;
            } else if (ch === '"') {
                inStr = true;
            } else if ('[({'.includes(ch)) {
                depth++;
            } else if ('])}'.includes(ch)) {
                depth--;
            } else if (ch === '\n' && depth === 0) {
                const text = code.slice(start, i).trim();
                if (text) exprs.push(text);
                start = i + 1;
            }
        }
        const last = code.slice(start).trim();
        if (last) exprs.push(last);
        let outputIdx = 0;
        return exprs.map((text, idx) => {
            const isDynamic = text.startsWith('Dynamic[') && text.endsWith(']');
            // Pure comments ( (* ... *) on their own line ) produce no kernel output
            // and must NOT advance the output-slot counter. If they did, the slotIndex
            // assigned to a following Dynamic[...] would be 1 instead of 0, causing
            // _putAllOutputs to write the rendered value to a phantom second output
            // while the placeholder at index 0 stays forever.
            const isComment = text.startsWith('(*') && text.endsWith('*)');
            const slotIndex = outputIdx;
            if (!isComment) outputIdx++;
            let dynInner = null, dynLiveTime = null, dynLiveEvals = null, dynLiveCells = null;
            if (isDynamic) {
                const fullInner = text.slice('Dynamic['.length, -1);
                const parts = this._splitAtTopLevelCommas(fullInner);
                dynInner = parts[0];
                for (let k = 1; k < parts.length; k++) {
                    const ltm = parts[k].match(/^LiveTime\s*->\s*([0-9]*\.?[0-9]+)/);
                    const lev = parts[k].match(/^LiveEvaluations\s*->\s*([0-9]+)/);
                    const lce = parts[k].match(/^LiveCells\s*->\s*([0-9]+)/);
                    if (ltm) dynLiveTime  = parseFloat(ltm[1]);
                    if (lev) dynLiveEvals = parseInt(lev[1], 10);
                    if (lce) dynLiveCells = parseInt(lce[1], 10);
                }
            }
            return { text, slotIndex, isDynamic, dynInner, dynLiveTime, dynLiveEvals, dynLiveCells };
        });
    }

    // Split string s at top-level commas (depth-0), respecting nested brackets and strings.
    // Used to separate Dynamic[expr, LiveTime->t, LiveEvaluations->n] arguments.
    _splitAtTopLevelCommas(s) {
        const parts = [];
        let depth = 0, inStr = false, start = 0;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; }
            else if (ch === '"') { inStr = true; }
            else if ('[({'.includes(ch)) depth++;
            else if ('])}'.includes(ch)) depth--;
            else if (ch === ',' && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
        }
        parts.push(s.slice(start).trim());
        return parts;
    }

    // Dynamic cell loop:
    //   ONE loop per cell. Each cycle mirrors exactly ⌥⇧↵:
    //     1. Wait until kernel is busy.
    //     2. Interrupt once → wait for Dialog[].
    //     3. dialogEval each Dynamic slot sequentially (same dialog session).
    //     4. exitDialog() → kernel resumes.
    //     5. Render each exported slot via subkernel → update all outputs at once.
    //     6. Wait 500ms, repeat.
    _startDynamicCell(cell, dynExprs, imgDir, imgRel, ownedExec) {
        const epoch   = this._sessionEpoch;
        const cellUri = cell.document.uri.toString();

        if (!this._dynamicWidgets) this._dynamicWidgets = new Map();
        const prev = this._dynamicWidgets.get(cellUri);
        if (prev) prev.active = false;
        const state = { active: true };
        this._dynamicWidgets.set(cellUri, state);

        // earlyStart: true when started inline (before execution.end() of the owner cell).
        // refreshSnapshots: called after execution.end() to update snapOutputs with the
        // full set of cell outputs (Print[] results + static sub-expression outputs).
        state.earlyStart = !!(ownedExec);
        state.refreshSnapshots = (newOutputs) => {
            // Replace contents of snapOutputs array in-place (keeps same reference).
            const src = newOutputs || Array.from(cell.outputs);
            snapOutputs.length = 0;
            for (const o of src) snapOutputs.push(o);
        };

        // Prewarm the render subkernel as soon as the first Dynamic widget is registered
        // so init.wl is already loaded by the time the first Dialog render happens.
        this._prewarmSubKernel();

        // Snapshot of all cell outputs (preserves static-slot outputs across updates).
        if (!this._dynCells) this._dynCells = new Map();
        const snapOutputs = Array.from(cell.outputs);
        this._dynCells.set(cellUri, { cell, outputs: snapOutputs });

        scrollLog('[dyn] cell loop start | slots:', dynExprs.map(d => d.slotIndex).join(','), '| epoch:', epoch);

        // Expiry limits: take the most restrictive value across all Dynamic slots.
        const liveTimeSec   = dynExprs.reduce((m, d) => (d.dynLiveTime  != null && d.dynLiveTime  < m) ? d.dynLiveTime  : m, Infinity);
        // LiveEvaluations: counts individual sub-expression dispatches (not cell-level).
        const liveEvalLimit = dynExprs.reduce((m, d) => (d.dynLiveEvals != null && d.dynLiveEvals < m) ? d.dynLiveEvals : m, Infinity);
        // LiveCells: counts cell-level dispatches (one per Shift+Enter).
        const liveCellLimit = dynExprs.reduce((m, d) => (d.dynLiveCells != null && d.dynLiveCells < m) ? d.dynLiveCells : m, Infinity);
        const _liveStartTime    = Date.now();
        const _epochAtStart     = this._dispatchEpoch;
        // For early-start widgets (ownedExec != null) the Dynamic's own cell has already
        // incremented _cellEpoch — offset by -1 so LiveCells->1 counts the own cell as
        // dispatch #1 and expires at the end of that cell.
        // For normal (non-early-start) widgets the own cell is not counted; dispatches
        // start from the NEXT cell (matching LiveCells->2 in test S).
        // _cellEpoch now increments at the END of each cell (after all outputs committed).
        // At widget-start time it has NOT yet incremented for the current cell even in
        // early-start mode, so no offset is needed for ownedExec.
        const _cellEpochAtStart = this._cellEpoch || 0;

        // _badgeExtra: small counter appended to the live/paused badge text.
        // e.g. ' · 3 evals' or ' · 2 cells · 8s'. Updated before each _putAllOutputs call.
        let _badgeExtra = '';
        // Latest dispatch counts — kept in outer scope so _badge(status, de) can build
        // per-slot badge extras without needing them passed through call chains.
        let _latestEvalsSince = 0, _latestCellsSince = 0;
        const _updateBadgeExtra = (evalsSince, cellsSince) => {
            _latestEvalsSince = evalsSince;
            _latestCellsSince = cellsSince;
            const _evLeft   = isFinite(liveEvalLimit) ? Math.max(0, liveEvalLimit - evalsSince) : null;
            const _cellLeft = isFinite(liveCellLimit) ? Math.max(0, liveCellLimit - cellsSince)  : null;
            const _secLeft  = isFinite(liveTimeSec)   ? Math.max(0, Math.round(liveTimeSec - (Date.now() - _liveStartTime) / 1000)) : null;
            const _parts = [];
            if (_evLeft   !== null) _parts.push(_evLeft   + ' eval'  + (_evLeft   === 1 ? '' : 's'));
            if (_cellLeft !== null) _parts.push(_cellLeft + ' cell'  + (_cellLeft === 1 ? '' : 's'));
            if (_secLeft  !== null) _parts.push(_secLeft  + 's');
            _badgeExtra = _parts.length ? ' · ' + _parts.join(' · ') : '';
        };
        // Set initial counter for the pre-loop 'waiting' display (0 dispatches consumed yet).
        _updateBadgeExtra(0, 0);

        // _isExpired: legacy flag (kept for safety).
        // _slotExpired[i]: true once slot i's output has been blanked and loop should skip it.
        // _slotTimeExpiredPending[i]: LiveTime deadline passed for slot i but kernel still busy;
        //   _putAllOutputs shows ⊘ badge for that slot while waiting for idle.
        let _isExpired = false;
        const _slotExpired            = new Array(dynExprs.length).fill(false);
        const _slotTimeExpiredPending = new Array(dynExprs.length).fill(false);
        const _markExpired = () => { _isExpired = true; };

        // _badge(status, de): build the badge HTML for one Dynamic slot.
        // When `de` is provided its own LiveXxx limits are shown (per-slot badge).
        // Falls back to the shared _badgeExtra when de is null/undefined.
        const _badge = (status, de) => {
            let badgeExtra = _badgeExtra; // shared fallback
            if (de) {
                // Compute badge extra using only the limits that belong to this specific slot.
                const _parts = [];
                if (de.dynLiveEvals != null) {
                    const left = Math.max(0, de.dynLiveEvals - _latestEvalsSince);
                    _parts.push(left + ' eval' + (left === 1 ? '' : 's'));
                }
                if (de.dynLiveCells != null) {
                    const left = Math.max(0, de.dynLiveCells - _latestCellsSince);
                    _parts.push(left + ' cell' + (left === 1 ? '' : 's'));
                }
                if (de.dynLiveTime != null) {
                    const left = Math.max(0, Math.round(de.dynLiveTime - (Date.now() - _liveStartTime) / 1000));
                    _parts.push(left + 's');
                }
                badgeExtra = _parts.length ? ' · ' + _parts.join(' · ') : '';
            }
            const color = status === 'live'    ? '#c678dd'
                        : status === 'paused'  ? '#888'
                        : status === 'expired' ? '#e06c75'
                        : '#e8a020';
            const bg    = status === 'live'    ? 'rgba(198,120,221,0.12)'
                        : status === 'paused'  ? 'rgba(128,128,128,0.10)'
                        : status === 'expired' ? 'rgba(224,108,117,0.12)'
                        : 'rgba(232,160,32,0.12)';
            const bd    = status === 'live'    ? 'rgba(198,120,221,0.35)'
                        : status === 'paused'  ? 'rgba(128,128,128,0.25)'
                        : status === 'expired' ? 'rgba(224,108,117,0.35)'
                        : 'rgba(232,160,32,0.35)';
            const label = status === 'live'    ? '⟳ Dynamic' + badgeExtra
                        : status === 'paused'  ? '⏸ Dynamic' + badgeExtra
                        : status === 'expired' ? '⊘ Dynamic' + badgeExtra
                        : '⏳ Dynamic' + badgeExtra + ' — start a computation to see live updates';
            return '<span style="font-size:9px;color:' + color + ';background:' + bg + ';' +
                   'border:1px solid ' + bd + ';border-radius:3px;padding:1px 6px;' +
                   'margin-right:6px;font-style:italic;">' + label + '</span>';
        };

        // Update all Dynamic slot outputs in a single createNotebookCellExecution call.
        // htmlBySlot: { slotIndex: htmlString } — slots absent from the map keep their current output.
        const _putAllOutputs = async (htmlBySlot, status) => {
            // Guard: if the session epoch changed (kernel restarted), do not write
            // stale output over the cleared cells.
            if (this._sessionEpoch !== epoch) return;
            try {
                const t = Date.now();
                // Early-start mode: the main execution is still open so
                // createNotebookCellExecution would fail.  Instead, update just the
                // Dynamic slot in-place via the owned execution's replaceOutputItems.
                if (ownedExec && ownedExec.active) {
                    for (let _i = 0; _i < dynExprs.length; _i++) {
                        const de = dynExprs[_i];
                        if (_slotExpired[_i]) continue; // already cleared — leave blank
                        if (de.slotIndex >= snapOutputs.length) continue;
                        const _slotStatus = _slotTimeExpiredPending[_i] ? 'expired' : status;
                        const html = htmlBySlot[de.slotIndex] || null;
                        const body = html
                            ? '<div class="wl-output-content">' + html + '</div>'
                            : '<div style="color:#888;font-style:italic;font-size:12px;padding:4px 0;">Waiting for computation…</div>';
                        const newItem = vscode.NotebookCellOutputItem.text(
                            '<div data-dynamic="1" data-epoch="' + epoch + '">'
                            + '<div style="display:flex;align-items:center;padding:2px 0 4px;">'
                            + _badge(_slotStatus, de) + '</div>' + body + '</div>',
                            'x-application/wolfram-language-html'
                        );
                        try {
                            await ownedExec.exec.replaceOutputItems([newItem], snapOutputs[de.slotIndex]);
                        } catch (_roe) { /* execution may have ended — silently ignore */ }
                    }
                    return;
                }
                const exe = this._controller.createNotebookCellExecution(cell);
                exe.start(t);
                const snap = snapOutputs.slice();
                for (let i = 0; i < dynExprs.length; i++) {
                    const de = dynExprs[i];
                    if (_slotExpired[i]) {
                        // Slot already cleared — write an explicit empty-string item so
                        // renderOutputItem fires and sets innerHTML='' on the stale container.
                        // (NotebookCellOutput([]) has zero items → renderOutputItem is never
                        // called → old HTML stays visible until the file is re-opened.)
                        if (de.slotIndex < snap.length) snap[de.slotIndex] = new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text('', 'x-application/wolfram-language-html')
                        ]);
                        continue;
                    }
                    const _slotStatus = _slotTimeExpiredPending[i] ? 'expired' : status;
                    const html = htmlBySlot[de.slotIndex] || null;
                    const body = html
                        ? '<div class="wl-output-content">' + html + '</div>'
                        : '<div style="color:#888;font-style:italic;font-size:12px;padding:4px 0;">Waiting for computation…</div>';
                    const out = new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(
                            '<div data-dynamic="1" data-epoch="' + epoch + '">'
                            + '<div style="display:flex;align-items:center;padding:2px 0 4px;">'
                            + _badge(_slotStatus, de) + '</div>' + body + '</div>',
                            'x-application/wolfram-language-html'
                        )
                    ]);
                    if (de.slotIndex < snap.length) snap[de.slotIndex] = out;
                    else { while (snap.length < de.slotIndex) snap.push(new vscode.NotebookCellOutput([])); snap.push(out); }
                }
                for (let i = 0; i < snap.length; i++) snapOutputs[i] = snap[i];
                if (this._dynCells && this._dynCells.has(cellUri))
                    this._dynCells.get(cellUri).outputs = snap;
                await exe.replaceOutput(snap);
                exe.end(true, t);
            } catch (e) { scrollLog('[dyn] _putAllOutputs error:', e.message); }
        };

        // _clearOneSlot(slotIdx): blank ONE Dynamic slot output without touching other slots.
        // Reads cell.outputs fresh to pick up Print/static outputs written since the last
        // _putAllOutputs, syncs snapOutputs, then replaces only the expired slot with empty.
        const _clearOneSlot = async (slotIdx) => {
            if (this._sessionEpoch !== epoch) return;
            if (ownedExec && ownedExec.active) return; // can't open a new execution during early-start
            try {
                const _live = Array.from(cell.outputs);
                while (snapOutputs.length > _live.length) snapOutputs.pop();
                for (let _ii = 0; _ii < _live.length; _ii++) snapOutputs[_ii] = _live[_ii];
                const snap = snapOutputs.slice();
                // Use an empty-string item (not zero-item output) so renderOutputItem fires
                // and clears innerHTML on the stale container immediately.
                if (slotIdx < snap.length) snap[slotIdx] = new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text('', 'x-application/wolfram-language-html')
                ]);
                for (let _ii = 0; _ii < snap.length; _ii++) snapOutputs[_ii] = snap[_ii];
                if (this._dynCells?.has(cellUri)) this._dynCells.get(cellUri).outputs = snap;
                const _cExe = this._controller.createNotebookCellExecution(cell);
                _cExe.start(Date.now()); await _cExe.replaceOutput(snap); _cExe.end(true, Date.now());
            } catch (_) {}
        };

        // Show initial waiting badge.
        _putAllOutputs({}, 'waiting');

        const runLoop = async () => {
            let cycle = 0;
            const htmlBySlot     = {}; // last rendered html per slot — shown with 'paused' badge when idle
            const lastHtmlBySlot = {}; // raw htmlStr from subkernel — used to skip unchanged renders
            let lastBusy = false; // track busy→idle transition to avoid repeated executions
            // _lastIdleRenderEpoch: the _dispatchEpoch value at the time of the last idle render.
            // null = never rendered yet (always do the first render).
            // Non-null: skip idle render unless _dispatchEpoch has advanced (meaning a new
            // evaluation has been dispatched — completed OR currently running — since last render).
            let _lastIdleRenderEpoch = null;
            // _lastBadgeTickTime: timestamp of last badge-only refresh (for LiveTime countdown).
            // Used to tick the timer display once per second even when slot content hasn't changed.
            let _lastBadgeTickTime = 0;
            // Safety counter: tracks how many consecutive interrupt cycles got no dialog.
            // When >= 1 we know the kernel is inside Pause[N] or a C++ compute-bound
            // section that ignores WSInterruptMessage.  Sending another interrupt while
            // Pause is about to end causes a WSTP-level deadlock where dialogEval AND
            // exitDialog both hang indefinitely (confirmed in test_pause_interrupt.js P6).
            // We back off and wait for the evaluation to end naturally instead.
            let _consecutiveNoDialog = 0;
            // abort() clears Internal`AddHandler["Interrupt",...] on the kernel side
            // (confirmed by WSTP regression test P5).  After any abort(), we must
            // reinstall the handler before the next interrupt attempt, otherwise
            // interrupt() fires but no Dialog[] opens and all subsequent cycles are dead.
            // _reinstallPromise tracks the in-flight sub() reinstall so we can await it.
            let _handlerNeedsReinstall = false;
            let _reinstallPromise = Promise.resolve();
            // Counts consecutive cycles where isDialogOpen=true in the pre-mutex guard.
            // If a stale dialog is stuck open (e.g. exitDialog resolved for level-2→1 but
            // level 1 was never closed), every cycle spins here forever.  After 10 cycles
            // (~2 s) we force-abort to break the deadlock.
            let _staleDialogCycles = 0;
            while (true) {
                cycle++;
                if (!state.active || this._sessionEpoch !== epoch) {
                    scrollLog('[dyn] cell loop exit | cycle:', cycle);
                    this._dynamicWidgets.delete(cellUri);
                    // Clear cell output immediately so stale Dynamic content doesn't
                    // linger after kernel restart — don't rely on launchKernel timing.
                    try {
                        const _exitExe = this._controller.createNotebookCellExecution(cell);
                        _exitExe.start(Date.now());
                        await _exitExe.replaceOutput([]);
                        _exitExe.end(true, Date.now());
                    } catch (_) {}
                    return;
                }

                // LiveTime / LiveEvaluations / LiveCells expiry checks.
                // LiveEvaluations: sub-expression dispatch count since widget start.
                // LiveCells: cell-level dispatch count since widget start.
                const _evalsSinceStart = (this._dispatchEpoch - _epochAtStart + 0x1000000) & 0xFFFFFF;
                const _cellsSinceStart = ((this._cellEpoch || 0) - _cellEpochAtStart + 0x1000000) & 0xFFFFFF;
                // Update badge counter so next _putAllOutputs reflects current remaining counts.
                _updateBadgeExtra(_evalsSinceStart, _cellsSinceStart);

                // Busy = any evaluation is queued (started or pending) AND we are not in abort.
                // Check queue.length only (not queue[0].started) so sub() calls stop as soon
                // as a new cell is queued — before executionQueue.start() is called — preventing
                // concurrent sub()+evaluate() collisions on the WSTP link.
                // NOTE: computed BEFORE the LiveTime check so we can wait for !busy before clearing.
                const busy = !this._abortPending && this.executionQueue.queue.length > 0;

                // LiveTime expiry: once the wall-clock deadline passes, mark expired and show
                // the red ⊘ badge (once). If the kernel is still busy, wait for it to finish
                // before clearing the output — so the user sees the expiry state, not a void.
                // --- Per-slot expiry ---
                // LiveTime: once the deadline passes show ⊘ badge for that slot only;
                //   clear it when the kernel becomes idle (!busy).
                // LiveEvals / LiveCells: clear the slot as soon as the Nth dispatch finishes.
                for (let _si = 0; _si < dynExprs.length; _si++) {
                    if (_slotExpired[_si]) continue;
                    const _de = dynExprs[_si];
                    if (_de.dynLiveTime != null && (Date.now() - _liveStartTime) / 1000 >= _de.dynLiveTime) {
                        if (!_slotTimeExpiredPending[_si]) {
                            scrollLog('[dyn] slot', _si, 'LiveTime expired | liveTime:', _de.dynLiveTime);
                            _slotTimeExpiredPending[_si] = true;
                            // Re-render with ⊘ badge for this slot only; other slots unaffected.
                            await _putAllOutputs(htmlBySlot, 'live');
                        }
                        if (!busy) {
                            _slotExpired[_si] = true;
                            await _clearOneSlot(_de.slotIndex);
                        }
                    }
                    if (!busy) {
                        if (_de.dynLiveEvals != null && _evalsSinceStart >= _de.dynLiveEvals) {
                            scrollLog('[dyn] slot', _si, 'LiveEvaluations expired | limit:', _de.dynLiveEvals);
                            _slotExpired[_si] = true;
                            await _clearOneSlot(_de.slotIndex);
                        } else if (_de.dynLiveCells != null && _cellsSinceStart >= _de.dynLiveCells) {
                            scrollLog('[dyn] slot', _si, 'LiveCells expired | limit:', _de.dynLiveCells);
                            _slotExpired[_si] = true;
                            await _clearOneSlot(_de.slotIndex);
                        }
                    }
                }
                // Exit the widget loop only when every slot has expired.
                if (_slotExpired.every(v => v)) {
                    scrollLog('[dyn] all slots expired — cell loop exit | cellUri:', cellUri);
                    this._dynamicWidgets.delete(cellUri);
                    return;
                }

                scrollLog('[dyn] cycle', cycle, '| busy:', busy, '| dlgOpen:', this.session?.isDialogOpen, '| dispatched:', this._evalDispatched, '| cND:', _consecutiveNoDialog, '| stale:', _staleDialogCycles, '| evalsSince:', _evalsSinceStart);

                if (!busy) {
                    // Recovery: if a dialog was left open after evaluation ended
                    // (e.g. exitDialog failed mid-cycle), kernel is frozen — close it.
                    if (this.session?.isDialogOpen) {
                        scrollLog('[dyn] idle but dlgOpen=true — acquiring mutex for recovery exitDialog');
                        let _releaseRec;
                        const _prevRec = this._dynDialogMutex;
                        this._dynDialogMutex = new Promise(r => _releaseRec = r);
                        await _prevRec;
                        try {
                            if (this.session?.isDialogOpen) {
                                scrollLog('[dyn] idle recovery: calling closeAllDialogs');
                                this.session.closeAllDialogs?.();
                                await new Promise(r => setTimeout(r, 300));
                            }
                        } finally {
                            _releaseRec();
                        }
                        continue;
                    }

                    // ---- Idle-eval path ----
                    // When nothing is running, evaluate Dynamic slots directly via sub().
                    // Serialized via _dynIdleMutex — only ONE cell loop calls sub() at a
                    // time: concurrent sub() calls stack on the WSTP link and all time out.
                    // Skip if dialog is open (recovery block above handles that).
                    // Also skip if no new evaluation has been dispatched since the last
                    // idle render — nothing could have changed in the kernel state.
                    const _queueEmpty = this.executionQueue.queue.length === 0;
                    const _epochUnchanged = _lastIdleRenderEpoch !== null
                        && this._dispatchEpoch === _lastIdleRenderEpoch;
                    if (_queueEmpty && !this._abortPending && !this.session.isDialogOpen
                            && !_epochUnchanged
                            && (Date.now() - (this._dynLastIdleRender || 0)) > 1000) {
                        // Acquire global idle mutex.
                        if (!this._dynIdleMutex) this._dynIdleMutex = Promise.resolve();
                        let _releaseIdle;
                        const _prevIdle = this._dynIdleMutex;
                        this._dynIdleMutex = new Promise(r => _releaseIdle = r);
                        await _prevIdle;
                        // Re-check after acquiring — another loop may have just fired.
                        if (!state.active || this._sessionEpoch !== epoch
                                || this.executionQueue.queue.length > 0
                                || this._abortPending || this.session.isDialogOpen
                                || (Date.now() - (this._dynLastIdleRender || 0)) < 800) {
                            _releaseIdle();
                            await new Promise(r => setTimeout(r, 300));
                            continue;
                        }
                        // Pre-flight: always close any stale dialog before sub().
                        this.session.closeAllDialogs?.();
                        this._dynLastIdleRender = Date.now();
                        const scale = Number(this.config?.get?.('imageScale') ?? 0.8) || 0.8;
                        const idlePending = {};
                        try {
                            for (const de of dynExprs) {
                                if (!state.active || this._sessionEpoch !== epoch) break;
                                const escaped = de.dynInner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                                const expr = 'VsCodeDynExportValue["' + escaped + '"]';
                                dynLog('IDLE-SEND | cycle', cycle, '| slot', de.slotIndex);
                                try {
                                    const res = await Promise.race([
                                        this.session.sub(expr),
                                        new Promise((_, rej) => setTimeout(() => rej(new Error('idle-sub timeout 3s')), 3000))
                                    ]);
                                    const _rv = res?.value;
                                    if (typeof _rv === 'string' && _rv.startsWith('WLVAL:FILE:')) {
                                        const tmpFile = _rv.slice('WLVAL:FILE:'.length)
                                            .replace(/\\012/g, '').replace(/\\015/g, '')
                                            .replace(/[^a-zA-Z0-9/_.-]/g, '');
                                        idlePending[de.slotIndex] = tmpFile;
                                    }
                                } catch(_idleErr) {
                                    dynLog('IDLE-SEND-ERR | cycle', cycle, '| slot', de.slotIndex, '|', _idleErr.message);
                                }
                            }
                        } finally { _releaseIdle(); }
                        if (Object.keys(idlePending).length > 0) {
                            let _anyIdleChanged = false;
                            try {
                                const _subKern = await this._ensureSubKernel(imgDir, imgRel);
                                for (const [slotIdxStr, tmpFile] of Object.entries(idlePending)) {
                                    const slotIdx = Number(slotIdxStr);
                                    const fileEsc = tmpFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                                    const renderExpr = 'Module[{dynVal=Import["' + fileEsc + '"]},VsCodeRenderExpr[dynVal,"Auto",' + scale + ']]';
                                    try {
                                        const renderRes = await _subKern.sub(renderExpr);
                                        const htmlStr = renderRes?.value;
                                        if (typeof htmlStr === 'string' && htmlStr.length > 0) {
                                            dynLog('IDLE-RENDER-OK | cycle', cycle, '| slot', slotIdx, '| htmlLen:', htmlStr.length,
                                                   '| changed:', htmlStr !== lastHtmlBySlot[slotIdx]);
                                            if (htmlStr !== lastHtmlBySlot[slotIdx]) {
                                                lastHtmlBySlot[slotIdx] = htmlStr;
                                                htmlBySlot[slotIdx] = this._processWLLatexBoxes(this._fixImageUris(htmlStr));
                                                _anyIdleChanged = true;
                                            }
                                        }
                                    } catch(_) {
                                    } finally {
                                        try { require('fs').unlinkSync(tmpFile); } catch(_) {}
                                    }
                                }
                            } catch(_subErr) {
                                dynLog('IDLE-SUBKERN-ERR | cycle', cycle, '|', _subErr.message);
                            }
                            // Redraw if value changed, OR if LiveTime is set (need to refresh
                            // the countdown even when the slot value is the same).
                            if (_anyIdleChanged || (isFinite(liveTimeSec) && !_isExpired)) {
                                _lastBadgeTickTime = Date.now();
                                await _putAllOutputs(htmlBySlot, 'live');
                            }
                        }
                        // Record the epoch we just rendered at — suppress further idle
                        // renders until a new evaluation is dispatched.
                        _lastIdleRenderEpoch = this._dispatchEpoch;
                        lastBusy = false;
                        await new Promise(r => setTimeout(r, 800));
                        continue;
                    }

                    // Only update output once on the busy→idle transition.
                    // Do NOT call createNotebookCellExecution every 300ms — VS Code
                    // treats each call as a cell execution and spams the output area.
                    if (lastBusy) {
                        // Evaluation finished — clear cached values and show "waiting".
                        // Do NOT show last-rendered values with a "paused" badge:
                        // those values belonged to the now-finished computation.
                        for (const k of Object.keys(htmlBySlot)) delete htmlBySlot[k];
                        await _putAllOutputs({}, 'waiting');
                    }
                    lastBusy = false;
                    // LiveTime countdown tick: refresh badge every ~1 s on the idle path
                    // so the displayed countdown decreases monotonically even when the
                    // slot value hasn't changed (i.e. _anyIdleChanged was false).
                    // Use per-slot check: tick if any slot with LiveTime is still active.
                    const _anyLiveTimeActive = dynExprs.some((de, _i) => de.dynLiveTime != null && !_slotExpired[_i]);
                    if (_anyLiveTimeActive
                            && (Date.now() - _lastBadgeTickTime) >= 950) {
                        _lastBadgeTickTime = Date.now();
                        await _putAllOutputs(htmlBySlot, 'live');
                    }
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }
                // Reset the no-dialog backoff counter when a fresh busy period begins.
                if (!lastBusy) {
                    if (_consecutiveNoDialog > 0) scrollLog('[dyn] cycle', cycle, '| fresh busy period — resetting cND:', _consecutiveNoDialog, '→ 0');
                    _consecutiveNoDialog = 0;
                }
                lastBusy = true;
                // If the LiveEvaluations or LiveCells limit has already been reached,
                // do NOT interrupt — let the computation finish undisturbed.
                // The expiry check in the !busy block fires once the queue drains.
                // Show the red ⊘ expired badge once on first entry so the user knows
                // the limit was hit and no more updates are coming.
                if (isFinite(liveEvalLimit) && _evalsSinceStart >= liveEvalLimit) {
                    if (!_isExpired) {
                        scrollLog('[dyn] busy-path: LiveEvaluations limit reached, showing expired badge');
                        _markExpired();
                        await _putAllOutputs(htmlBySlot, 'expired');
                    }
                    await new Promise(r => setTimeout(r, 300)); continue;
                }
                if (isFinite(liveCellLimit) && _cellsSinceStart >= liveCellLimit) {
                    if (!_isExpired) {
                        scrollLog('[dyn] busy-path: LiveCells limit reached, showing expired badge');
                        _markExpired();
                        await _putAllOutputs(htmlBySlot, 'expired');
                    }
                    await new Promise(r => setTimeout(r, 300)); continue;
                }
                // Gate: only send interrupt() once the kernel is actually computing.
                // _evalDispatched is set true after _dynIdleMutex resolves (just before
                // the first session.evaluate() call). Before that, queue[0].started is
                // already true but the kernel is still idle — interrupt() on an idle
                // kernel corrupts the WSTP link ("WSGet out of sequence").
                if (!this._evalDispatched) {
                    await new Promise(r => setTimeout(r, 100)); continue;
                }

                // Skip this cycle if the kernel is actively rendering (ExportString/SVG).
                // Sending an interrupt now would abort ExportString mid-call and corrupt
                // the SVG pipeline state. Just wait and retry next cycle.
                if (this._renderingActive) {
                    await new Promise(r => setTimeout(r, 150));
                    continue;
                }

                // Skip if dialog is already open — don't interrupt, just wait.
                // Fast path: if consecutiveNoDialog >= 1 and a dialog opens, this is
                // the DEFERRED interrupt (sent earlier, fired late after Pause[N] ended).
                // Exit it immediately to let the cell continue — do NOT abort.
                // Watchdog: if this has been true for >= 10 consecutive 200 ms cycles
                // (~2 s) the dialog is stale (exitDialog closed level-2→1 but level-1
                // was never closed, or abort() left residual state).  Force-abort to
                // break the deadlock rather than spinning forever.
                if (this.session.isDialogOpen) {
                    if (_consecutiveNoDialog >= 1) {
                        // Deferred-interrupt dialog: we sent an interrupt earlier that
                        // Pause[] didn't open right away — it fired after Pause ended.
                        // Close it cleanly so the cell's next expression can complete.
                        scrollLog('[dyn] cycle', cycle, '| deferred-dialog detected (cND:', _consecutiveNoDialog, ') — calling exitDialog to unblock cell');
                        const _t_dd = Date.now();
                        try {
                            await Promise.race([
                                this.session.exitDialog(),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('deferred-dlg-timeout')), 2000))
                            ]);
                            scrollLog('[dyn] cycle', cycle, '| deferred-dialog exitDialog done | dlgOpen after:', this.session.isDialogOpen, '| dt:', Date.now() - _t_dd, 'ms');
                            if (!this.session.isDialogOpen) _consecutiveNoDialog = 0;
                        } catch (e) {
                            scrollLog('[dyn] cycle', cycle, '| deferred-dialog exitDialog failed:', e.message, '| dlgOpen after:', this.session.isDialogOpen);
                        }
                        await new Promise(r => setTimeout(r, 200));
                        continue;
                    }
                    scrollLog('[dyn] cycle', cycle, '| pre-mutex dlgOpen=true | staleCount now:', _staleDialogCycles + 1, '| cND:', _consecutiveNoDialog);
                    _staleDialogCycles++;
                    if (_staleDialogCycles >= 10) {
                        _staleDialogCycles = 0;
                        scrollLog('[dyn] cycle', cycle, '| stale dialog (10 cycles) — force-abort to recover | cND was:', _consecutiveNoDialog);
                        try { this.session.abort(); } catch(_) {}
                        _handlerNeedsReinstall = true;
                        _reinstallPromise = this.session.sub?.(
                            'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]'
                        ).then(() => {
                            _handlerNeedsReinstall = false;
                            scrollLog('[dyn] interrupt handler reinstalled after stale-dialog abort');
                        }).catch(e => {
                            _handlerNeedsReinstall = false;
                            scrollLog('[dyn] stale-dialog reinstall failed:', e.message);
                        }) ?? Promise.resolve();
                        const _tsd = Date.now();
                        while (this.session.isDialogOpen && Date.now() - _tsd < 3000)
                            await new Promise(r => setTimeout(r, 50));
                    }
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }
                _staleDialogCycles = 0;

                // ---- Global dialog mutex: serialises interrupt+dialogEval+exitDialog ----
                // across ALL concurrent Dynamic cell loops so two loops never send competing
                // interrupts and open nested Dialog[] sessions simultaneously.
                let _releaseDlg;
                const _prevDlg = this._dynDialogMutex;
                this._dynDialogMutex = new Promise(r => _releaseDlg = r);
                // Snapshot the dispatch epoch BEFORE yielding — if the epoch changes while
                // we await the mutex the current evaluation ended (and possibly a new one
                // started) so we must NOT send interrupt() to whoever is running now.
                const _epochBeforeMutex = this._dispatchEpoch;
                await _prevDlg;

                // Re-check after acquiring lock (another loop may have just used the dialog).
                if (!state.active || this._sessionEpoch !== epoch) { _releaseDlg(); continue; }
                // Abort is pending — release immediately so abort can proceed cleanly.
                if (this._abortPending) { scrollLog('[dyn] cycle', cycle, '| abort pending — skip'); _releaseDlg(); continue; }
                // Rendering started while we were waiting on the mutex — release and retry.
                if (this._renderingActive) { _releaseDlg(); await new Promise(r => setTimeout(r, 150)); continue; }
                if (this.session.isDialogOpen) { _releaseDlg(); await new Promise(r => setTimeout(r, 200)); continue; }
                // KEY RACE FIX: the evaluation that was running when we queued for the mutex
                // may have finished and a NEW cell may have started while we were waiting.
                // Re-check _evalDispatched: if it is false, no cell is executing right now —
                // sending interrupt() would hit the idle kernel and corrupt the WSTP link.
                if (!this._evalDispatched) {
                    scrollLog('[dyn] cycle', cycle, '| evalDispatched=false after mutex — skip interrupt');
                    _releaseDlg();
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }
                // Also check epoch: even if dispatched=true, it may belong to a NEW cell
                // (old cell ended, new cell started, epoch bumped). Interrupting the new
                // cell's first expression would be equally wrong.
                if (this._dispatchEpoch !== _epochBeforeMutex) {
                    scrollLog('[dyn] cycle', cycle, '| epoch changed while awaiting mutex (',
                              _epochBeforeMutex, '->', this._dispatchEpoch, ') — skip interrupt');
                    _releaseDlg();
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }

                // SAFETY guard: if the previous interrupt was silently swallowed (no
                // dialog opened within 2500ms), do NOT immediately retry.  Retrying while
                // the kernel is inside Pause[N]→completion transition triggers an
                // irrecoverable WSTP deadlock (test_pause_interrupt.js P3/P6).
                // Instead, wait for the eval to finish naturally (the !busy path).
                if (_consecutiveNoDialog >= 1) {
                    scrollLog('[dyn] cycle', cycle, '| consecutiveNoDialog:', _consecutiveNoDialog,
                              '— skipping interrupt | epoch:', this._dispatchEpoch, '| evalsSince:', _evalsSinceStart);
                    _releaseDlg();
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                // Handler reinstall may be in flight after a previous abort().
                // Wait for it to complete before attempting the next interrupt —
                // otherwise we interrupt with no handler and the dialog never opens.
                if (_handlerNeedsReinstall) {
                    _releaseDlg();
                    scrollLog('[dyn] cycle', cycle, '| handler reinstall pending — awaiting before next interrupt');
                    await _reinstallPromise;
                    if (!state.active || this._sessionEpoch !== epoch) continue;
                    // One-cycle pause so the kernel can register the new handler.
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }

                let gotIdxs = [];
                let pendingValues = {}; // slotIndex → FullForm string (populated inside Dialog[])
                const scale = Number(this.config?.get?.('imageScale') ?? 0.8) || 0.8;
                // Busy-gone watcher: rejects dialogEval immediately when main evaluation
                // finishes mid-cycle so we never hang for the full 8s timeout.
                let _busyWatcher = null;
                let _busyGoneReject = null;
                const _busyGoneProm = new Promise((_, rej) => { _busyGoneReject = rej; });
                try {
                // ---- Single interrupt. Wait up to 2500ms — NO retry interrupt. ----
                // Pre-flight closeAllDialogs: isDialogOpen is often stale. Reset
                // any stale dialog state before the interrupt so the C++ state is clean.
                this.session.closeAllDialogs?.();
                const sent = this.session.interrupt();
                scrollLog('[dyn] cycle', cycle, '| interrupt sent:', sent, '| epoch:', this._dispatchEpoch, '| evalsSince:', _evalsSinceStart);
                if (!sent) { await new Promise(r => setTimeout(r, 500)); continue; }

                const t1 = Date.now();
                while (!this.session.isDialogOpen && Date.now() - t1 < 2500)
                    await new Promise(r => setTimeout(r, 25));
                const dlgOpen = this.session.isDialogOpen;
                scrollLog('[dyn] cycle', cycle, '| dlgOpen:', dlgOpen, '| waited:', Date.now() - t1, 'ms');
                if (!dlgOpen) {
                    // Dialog never opened — kernel is inside Pause[N] or a compute-bound
                    // section that ignores WSInterruptMessage.  Increment backoff counter
                    // so the next cycle skips the interrupt entirely and just waits.
                    _consecutiveNoDialog++;
                    scrollLog('[dyn] cycle', cycle, '| no dialog — consecutiveNoDialog:', _consecutiveNoDialog,
                              '(will skip interrupt next cycle until eval ends)');
                    this.session.closeAllDialogs?.();
                    await new Promise(r => setTimeout(r, 300)); continue;
                }
                // Dialog opened — reset backoff counter.
                _consecutiveNoDialog = 0;

                // Start watcher now (dialog is confirmed open).
                _busyWatcher = setInterval(() => {
                    const _stillBusy = !this._abortPending &&
                        this.executionQueue.queue.length > 0 && this.executionQueue.queue[0].started;
                    if (!_stillBusy) { clearInterval(_busyWatcher); _busyWatcher = null; _busyGoneReject(new Error('busy-lost')); }
                }, 150);

                // ---- Evaluate each Dynamic slot: export evaluated value to .mx temp file ----
                // VsCodeDynExportValue["exprString"] evaluates the expression inside Dialog[]
                // (where Do-loop variables like n are visible) and exports the CONCRETE result
                // (e.g. a fully-built Graphics[...]) to a temp .mx file.
                // IMPORTANT: NO CheckAbort wrapper — inside Dialog[] after an interrupt,
                // CheckAbort traps the active abort flag and returns $Failed immediately
                // before any expression is evaluated. The subsession (⌥⇧↵) uses the same
                // approach and is proven correct.
                // After exitDialog(), the file is imported on _subKernel (separate process)
                // and rendered via VsCodeRenderExpr — full SVG/MathML, no context needed.
                for (let i = 0; i < dynExprs.length; i++) {
                    const de      = dynExprs[i];
                    const escaped = de.dynInner.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const expr    = 'VsCodeDynExportValue["' + escaped + '"]';
                    dynLog('SEND | cycle', cycle, '| slot', de.slotIndex, '| expr:', de.dynInner.slice(0, 60));
                    try {
                        const res = await Promise.race([
                            this.session.dialogEval(expr),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000)),
                            _busyGoneProm,
                        ]);
                        const _rv = res?.value;
                        dynLog('RECV | cycle', cycle, '| slot', de.slotIndex,
                               '| type:', res?.type, '| len:', String(_rv).length,
                               '| starts:', String(_rv).slice(0, 80));
                        if (res && !res.error && typeof _rv === 'string' && _rv.startsWith('WLVAL:FILE:')) {
                            // WSTP text-mode inserts ' \012>   ' line-continuation into long strings.
                            // Step 1: strip the 4-char WSTP escape literals \012 \015 (else their
                            //         digits '012' survive the path-char filter below).
                            // Step 2: strip all non-path characters (space, >, \, etc.)
                            const tmpFile = _rv.slice('WLVAL:FILE:'.length)
                                .replace(/\\012/g, '').replace(/\\015/g, '')
                                .replace(/[^a-zA-Z0-9/_.-]/g, '');
                            dynLog('WLVAL-FILE | cycle', cycle, '| slot', de.slotIndex,
                                   '| cleanPath:', tmpFile);
                            pendingValues[de.slotIndex] = tmpFile;
                            gotIdxs.push(i);
                        } else if (res && !res.error && typeof _rv === 'string' && _rv === 'WLVAL:FAILED') {
                            dynLog('WLVAL-FAILED | cycle', cycle, '| slot', de.slotIndex);
                            // Keep previous output — expression returned $Failed (e.g. n not yet set).
                        } else if (res && !res.error && typeof _rv === 'string' && _rv.length > 0) {
                            dynLog('RAW-FALLBACK | cycle', cycle, '| slot', de.slotIndex,
                                   '| raw[0..120]:', _rv.slice(0, 120));
                            const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                            htmlBySlot[de.slotIndex] =
                                '<pre style="margin:0;padding:4px 0;font-size:12px;color:#c00;' +
                                'font-family:monospace;white-space:pre-wrap;">'
                                + '⚠ restart kernel to load VsCodeDynExportValue\n\n'
                                + _esc(_rv.slice(0, 500)) + '</pre>';
                            gotIdxs.push(i);
                        } else {
                            dynLog('NULL/ERR | cycle', cycle, '| slot', de.slotIndex,
                                   '| res:', JSON.stringify(res)?.slice(0, 120));
                        }
                    } catch (e) {
                        if (e.message === 'busy-lost') {
                            dynLog('BUSY-LOST | cycle', cycle, '| slot', de.slotIndex, '— eval ended mid-dialog, closing dialog');
                        } else {
                            dynLog('THROW | cycle', cycle, '| slot', de.slotIndex, '| err:', e.message);
                            scrollLog('[dyn] cycle', cycle, '| slot', de.slotIndex, '| dialogEval error:', e.message);
                        }
                        break;  // don't try remaining slots
                    }
                }

                // ---- Exit dialog — retry up to 5 times if it hangs or only partially closes. ----
                // IMPORTANT: exitDialog() can resolve without timeout AND yet the dialog is
                // still open when the kernel is at Dialog level 2 (nested after a previous
                // abort): exitDialog closes level 2 → level 1, returning successfully, but
                // isDialogOpen is still true.  We must check isDialogOpen after each call
                // and keep retrying until the dialog is genuinely closed.
                let exited = false;
                scrollLog('[dyn] cycle', cycle, '| exitDialog loop start (up to 5 attempts) | dlgOpen:', this.session.isDialogOpen);
                for (let attempt = 0; attempt < 5 && !exited; attempt++) {
                    const _t_ed = Date.now();
                    try {
                        await Promise.race([
                            this.session.exitDialog(),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('exitDialog timeout')), 2000))
                        ]);
                        // exitDialog resolved — but it may have only closed one level.
                        // Check whether the dialog is genuinely closed now.
                        await new Promise(r => setTimeout(r, 30));
                        if (!this.session.isDialogOpen) {
                            exited = true;
                            scrollLog('[dyn] cycle', cycle, '| exitDialog attempt', attempt + 1, 'succeeded | dt:', Date.now() - _t_ed, 'ms');
                        } else {
                            scrollLog('[dyn] cycle', cycle, '| exitDialog attempt', attempt + 1,
                                      '— resolved but dialog still open (nested level), retrying | dt:', Date.now() - _t_ed, 'ms');
                        }
                    } catch (e) {
                        scrollLog('[dyn] cycle', cycle, '| exitDialog attempt', attempt + 1, 'failed:', e.message, '| dt:', Date.now() - _t_ed, 'ms');
                    }
                }
                // All exitDialog attempts failed — the kernel is stuck inside Dialog[]
                // (e.g. ExportString/Rasterize is still running). Abort the kernel to
                // forcibly terminate the stuck computation and release the WSTP link.
                if (!exited) {
                    dynLog('ABORT | cycle', cycle, '| exitDialog failed 5 times — aborting kernel');
                    try { this.session.abort(); } catch(_) {}
                    // abort() clears Internal`AddHandler["Interrupt",...] on the kernel.
                    // Schedule handler reinstall via sub() — runs after the aborted eval
                    // finishes ($Aborted response) and before any queued evaluate() calls.
                    _handlerNeedsReinstall = true;
                    _reinstallPromise = this.session.sub?.(
                        'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]'
                    ).then(() => {
                        _handlerNeedsReinstall = false;
                        scrollLog('[dyn] interrupt handler reinstalled after abort');
                    }).catch(e => {
                        _handlerNeedsReinstall = false;
                        scrollLog('[dyn] handler reinstall failed:', e.message);
                    }) ?? Promise.resolve();
                    // Wait up to 3s for the dialog to close post-abort.
                    const _ta = Date.now();
                    while (this.session.isDialogOpen && Date.now() - _ta < 3000)
                        await new Promise(r => setTimeout(r, 50));
                    dynLog('ABORT-WAIT | cycle', cycle, '| dlgOpen after abort:', this.session.isDialogOpen, '| waited:', Date.now()-_ta, 'ms');
                    // If the kernel is still stuck in Dialog[] after abort, we cannot
                    // recover without a kernel restart.  Suspend the widget loop until
                    // the session epoch changes (i.e. user restarts the kernel).
                    if (this.session.isDialogOpen) {
                        dynLog('STUCK | cycle', cycle, '| kernel stuck — suspending widget loop until kernel restart');
                        await _putAllOutputs(htmlBySlot, 'paused');
                        // Spin until epoch changes (kernel restarted) then exit loop.
                        while (this._sessionEpoch === epoch && state.active)
                            await new Promise(r => setTimeout(r, 500));
                        return;  // exit runLoop
                    }
                }

                const t2 = Date.now();
                while (this.session.isDialogOpen && Date.now() - t2 < 2000)
                    await new Promise(r => setTimeout(r, 30));
                scrollLog('[dyn] cycle', cycle, '| dialog closed after', Date.now() - t2, 'ms | slots:', gotIdxs.length);
                // Last-resort: dialog still open after all exits + 2s wait — abort to prevent
                // the pre-mutex isDialogOpen guard from spinning forever on next cycles.
                if (this.session.isDialogOpen) {
                    scrollLog('[dyn] cycle', cycle, '| dialog still open after t2 wait — aborting to prevent spin');
                    try { this.session.abort(); } catch(_) {}
                    _handlerNeedsReinstall = true;
                    _reinstallPromise = this.session.sub?.(
                        'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]'
                    ).then(() => {
                        _handlerNeedsReinstall = false;
                        scrollLog('[dyn] interrupt handler reinstalled after t2-abort');
                    }).catch(e => {
                        _handlerNeedsReinstall = false;
                        scrollLog('[dyn] t2-abort reinstall failed:', e.message);
                    }) ?? Promise.resolve();
                    const _t2a = Date.now();
                    while (this.session.isDialogOpen && Date.now() - _t2a < 3000)
                        await new Promise(r => setTimeout(r, 50));
                }

                // Brief pause so kernel resumes Do loop before next interrupt.
                await new Promise(r => setTimeout(r, 150));
                } finally {
                    if (_busyWatcher) { clearInterval(_busyWatcher); _busyWatcher = null; }
                    _releaseDlg();
                }

                if (!state.active || this._sessionEpoch !== epoch) continue;

                // ---- Render pending slot values on _subKernel ----
                // Dialog[] is now closed. pendingValues holds .mx temp file paths.
                // The _subKernel is a separate process — SVG export cannot block the main kernel.
                // This mirrors the subsession (⌥⇧↵) render path exactly.
                let _anyChanged = false;
                if (Object.keys(pendingValues).length > 0) {
                    try {
                        const _subKern = await this._ensureSubKernel(imgDir, imgRel);
                for (const [slotIdxStr, tmpFile] of Object.entries(pendingValues)) {
                    const slotIdx  = Number(slotIdxStr);
                    const fileEsc  = tmpFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const renderExpr = 'Module[{dynVal=Import["' + fileEsc + '"]},VsCodeRenderExpr[dynVal,"Auto",' + scale + ']]';
                    dynLog('RENDER | cycle', cycle, '| slot', slotIdx,
                           '| tmpFile:', tmpFile,
                           '| renderExpr[0..80]:', renderExpr.slice(0, 80));
                    try {
                        const renderRes = await _subKern.sub(renderExpr);
                        const htmlStr   = renderRes?.value;
                        if (typeof htmlStr === 'string' && htmlStr.length > 0) {
                            const _changed = htmlStr !== lastHtmlBySlot[slotIdx];
                            dynLog('RENDER-OK | cycle', cycle, '| slot', slotIdx,
                                   '| htmlLen:', htmlStr.length,
                                   '| changed:', _changed,
                                   '| html[0..200]:', _changed ? htmlStr.slice(0, 200) : '(skipped)');
                            if (_changed) {
                                lastHtmlBySlot[slotIdx] = htmlStr;
                                htmlBySlot[slotIdx] = this._processWLLatexBoxes(
                                    this._fixImageUris(htmlStr)
                                );
                                _anyChanged = true;
                            }
                                } else {
                                    dynLog('RENDER-EMPTY | cycle', cycle, '| slot', slotIdx,
                                           '| res:', JSON.stringify(renderRes)?.slice(0, 80));
                                }
                            } catch (renderErr) {
                                dynLog('RENDER-ERR | cycle', cycle, '| slot', slotIdx, '|', renderErr.message);
                            } finally {
                                // Clean up temp file.
                                try { require('fs').unlinkSync(tmpFile); } catch (_) {}
                            }
                        }
                    } catch (subKernErr) {
                        dynLog('SUBKERN-ERR | cycle', cycle, '|', subKernErr.message);
                    }
                }

                // Only redraw if at least one slot actually changed this cycle.
                if (_anyChanged) await _putAllOutputs(htmlBySlot, 'live');
                scrollLog('[dyn] cycle', cycle, '| done | sleeping 500ms');
                await new Promise(r => setTimeout(r, 500));
            }
        };

        setTimeout(() => runLoop().catch(e => {
            scrollLog('[dyn] runLoop error:', e.message);
            // --- Safety cleanup: ensure a crash never leaves the kernel in a blocked state ---
            // Mark widget inactive so no further output writes happen.
            state.active = false;
            this._dynamicWidgets.delete(cellUri);
            // Close any Dialog[] the crashed cycle may have left open — a stuck dialog
            // blocks ALL future kernel evaluations until it is closed.
            try { this.session.closeAllDialogs?.(); } catch (_) {}
            // Release the dialog mutex so other widget loops (and new evaluations) can proceed.
            // A leaked mutex would deadlock every subsequent busy-path interrupt attempt.
            this._dynDialogMutex = Promise.resolve();
            // Reset idle mutex too — a leaked sub() hold would block checkoutExecutionQueue.
            this._dynIdleMutex = Promise.resolve();
            // Clear stale Dynamic HTML from the cell so the output area doesn't show
            // a permanently frozen '⟳ Dynamic' badge.
            try {
                const _errExe = this._controller.createNotebookCellExecution(cell);
                _errExe.start(Date.now());
                _errExe.replaceOutput([]).then(() => _errExe.end(true, Date.now())).catch(() => { try { _errExe.end(true, Date.now()); } catch(_){} });
            } catch (_) {}
        }), 250);
    }

    // Render a WExpr as a plain InputForm string (for Dialog: Out display)
    _wexprToInputForm(expr) {
        if (!expr || typeof expr !== 'object') return String(expr);
        if (expr.error) return '(error: ' + String(expr.error) + ')';
        if (expr.type === 'integer' || expr.type === 'real') return String(expr.value);
        if (expr.type === 'string')
            return '"' + String(expr.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        if (expr.type === 'symbol') return String(expr.value);
        if (expr.type === 'function') {
            const head = String(expr.head || '?');
            const args = (expr.args || []).map(a => this._wexprToInputForm(a)).join(', ');
            return head + '[' + args + ']';
        }
        return JSON.stringify(expr);
    }

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
    async pasteImageAsCell(args = {}) {
        this.outputPanel.print('[PasteImage] triggered, platform=' + process.platform);

        if (process.platform !== 'darwin') {
            vscode.window.showWarningMessage('Paste Image is currently supported on macOS only.');
            return;
        }

        // ---- Locate active notebook + currently selected cell ----
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) {
            this.outputPanel.print('[PasteImage] ERROR: no active notebook editor');
            vscode.window.showWarningMessage('No active notebook editor.');
            return;
        }
        const sel = editor.selections;
        if (!sel || sel.length === 0) {
            this.outputPanel.print('[PasteImage] ERROR: no cell selected');
            vscode.window.showWarningMessage('No cell selected.');
            return;
        }
        const cell = editor.notebook.cellAt(sel[0].start);
        this.outputPanel.print(`[PasteImage] active cell index=${cell.index}`);

        // ---- Extract clipboard image to a temp PNG via osascript ----
        // Tries PNG first; falls back to TIFF (macOS default for screenshots/
        // images copied from apps), then converts to PNG using sips.
        const { spawnSync } = require('child_process');
        const ts        = Date.now();
        const tmpPng    = path.join(os.tmpdir(), `wl_paste_${ts}.png`);
        const tmpTiff   = path.join(os.tmpdir(), `wl_paste_${ts}.tiff`);
        const tmpScript = path.join(os.tmpdir(), `wl_asc_${ts}.scpt`);
        const ascript = [
            // Try PNG first
            'set wroteFile to false',
            'try',
            `  set imgData to the clipboard as «class PNGf»`,
            `  set fRef to open for access POSIX file ${JSON.stringify(tmpPng)} with write permission`,
            '  write imgData to fRef',
            '  close access fRef',
            '  set wroteFile to true',
            'end try',
            // Fall back to TIFF if PNG not available
            'if not wroteFile then',
            '  try',
            `    set imgData to the clipboard as «class TIFF»`,
            `    set fRef to open for access POSIX file ${JSON.stringify(tmpTiff)} with write permission`,
            '    write imgData to fRef',
            '    close access fRef',
            '  on error errMsg',
            `    set fErr to open for access POSIX file "${tmpPng}.err" with write permission`,
            '    write errMsg to fErr',
            '    close access fErr',
            '  end try',
            'end if',
        ].join('\n');
        this.outputPanel.print(`[PasteImage] running osascript, tmpPng=${tmpPng}`);
        let spawnResult;
        try {
            fs.writeFileSync(tmpScript, ascript, 'utf8');
            spawnResult = spawnSync('osascript', [tmpScript], { timeout: 6000 });
        } catch (spawnErr) {
            this.outputPanel.print('[PasteImage] osascript spawn ERROR: ' + spawnErr.message);
        } finally {
            try { fs.unlinkSync(tmpScript); } catch(_) {}
        }
        if (spawnResult) {
            this.outputPanel.print(
                `[PasteImage] osascript exit=${spawnResult.status}` +
                (spawnResult.stderr ? ' stderr=' + spawnResult.stderr.toString().trim() : '')
            );
        }
        // Report AppleScript error if any
        const errFile = tmpPng + '.err';
        if (fs.existsSync(errFile)) {
            try {
                this.outputPanel.print('[PasteImage] AppleScript error: ' + fs.readFileSync(errFile, 'utf8').trim());
                fs.unlinkSync(errFile);
            } catch(_) {}
        }
        // Convert TIFF → PNG via sips (built into macOS) if we got a TIFF
        if (!fs.existsSync(tmpPng) && fs.existsSync(tmpTiff)) {
            this.outputPanel.print('[PasteImage] clipboard was TIFF — converting with sips');
            const sips = spawnSync('sips', ['--setProperty', 'format', 'png', tmpTiff, '--out', tmpPng], { timeout: 8000 });
            this.outputPanel.print(`[PasteImage] sips exit=${sips.status}` +
                (sips.stderr ? ' ' + sips.stderr.toString().trim() : ''));
            try { fs.unlinkSync(tmpTiff); } catch(_) {}
        }
        const pngExists = fs.existsSync(tmpPng);
        const pngSize   = pngExists ? fs.statSync(tmpPng).size : 0;
        this.outputPanel.print(`[PasteImage] tmpPng exists=${pngExists} size=${pngSize}`);

        if (!pngExists || pngSize === 0) {
            try { if (pngExists) fs.unlinkSync(tmpPng); } catch(_) {}
            this.outputPanel.print('[PasteImage] no PNG on clipboard — aborting');
            vscode.window.showWarningMessage(
                'No image found on clipboard — copy an image first, then press ⌘⇧V.'
            );
            return;
        }

        // ---- Ask above or below (skip dialog when called from between-cell toolbar) ----
        let insertAbove = false;
        if (!args.insertBelow) {
            // Brief delay so the cmd+shift+v keypress event settles before the
            // QuickPick opens — otherwise the residual kepress dismisses/accepts it instantly.
            await new Promise(resolve => setTimeout(resolve, 150));
            const choice = await vscode.window.showQuickPick(
                ['↑  Insert Above current cell', '↓  Insert Below current cell'],
                { title: 'Paste Image As Cell', placeHolder: 'Where should the image cell go?' }
            );
            if (!choice) {
                try { fs.unlinkSync(tmpPng); } catch(_) {}
                this.outputPanel.print('[PasteImage] user cancelled position dialog');
                return;
            }
            insertAbove = choice.startsWith('↑');
        }
        this.outputPanel.print(`[PasteImage] insertAbove=${insertAbove}`);

        // ---- Compute destination inside the notebook img/ folder ----
        const notebook  = editor.notebook;
        const nbFsPath  = notebook.uri.fsPath;
        const nbBase    = path.basename(nbFsPath, path.extname(nbFsPath));
        const imgDirAbs = path.join(path.dirname(nbFsPath), 'img', nbBase);
        const imgRel    = 'img/' + nbBase;
        const fname     = `paste_${Date.now()}.png`;
        const dstPath   = path.join(imgDirAbs, fname);
        this.outputPanel.print(`[PasteImage] dstPath=${dstPath}`);

        try { fs.mkdirSync(imgDirAbs, { recursive: true }); } catch(_) {}

        // ---- Convert / copy (Wolfram normalises format; plain copy as fallback) ----
        const status = vscode.window.setStatusBarMessage('⏳ Saving clipboard image…');
        try {
            if (this.session && this.kernelStatusString === 'resolved') {
                // Mathematica Import→Export: handles TIFF/BMP/EMF/etc. → PNG
                this.outputPanel.print('[PasteImage] kernel available — using Wolfram Export/Import');
                const wlSrc = this.escapeWL(tmpPng);
                const wlDst = this.escapeWL(dstPath);
                const exportResult = await this.session.sub(`Export["${wlDst}", Import["${wlSrc}"]]`);
                this.outputPanel.print('[PasteImage] Wolfram export result: ' + JSON.stringify(exportResult));
            } else {
                this.outputPanel.print('[PasteImage] kernel not running — using direct file copy');
            }
            if (!fs.existsSync(dstPath)) {
                this.outputPanel.print('[PasteImage] dst missing after Export — falling back to fs.copy');
                fs.copyFileSync(tmpPng, dstPath);
            }
        } catch (saveErr) {
            this.outputPanel.print('[PasteImage] save ERROR: ' + saveErr.message + ' — falling back to fs.copy');
            try { fs.copyFileSync(tmpPng, dstPath); } catch(copyErr) {
                this.outputPanel.print('[PasteImage] fs.copy also failed: ' + copyErr.message);
            }
        } finally {
            status.dispose();
            try { fs.unlinkSync(tmpPng); } catch(_) {}
        }

        if (!fs.existsSync(dstPath)) {
            this.outputPanel.print('[PasteImage] ERROR: dstPath not created');
            vscode.window.showErrorMessage('Failed to save pasted image.');
            return;
        }
        this.outputPanel.print(`[PasteImage] image saved OK (${fs.statSync(dstPath).size} bytes)`);

        // ---- Read PNG dimensions from header (bytes 16-23) to set explicit half-width ----
        let widthAttr = '';
        try {
            const hdr = Buffer.alloc(24);
            const fd  = fs.openSync(dstPath, 'r');
            fs.readSync(fd, hdr, 0, 24, 0);
            fs.closeSync(fd);
            const pxWidth = hdr.readUInt32BE(16);
            widthAttr = ` width="${Math.round(pxWidth / 2)}"`;
            this.outputPanel.print(`[PasteImage] PNG width=${pxWidth}px → display ${Math.round(pxWidth / 2)}px`);
        } catch (e) {
            this.outputPanel.print('[PasteImage] could not read PNG dimensions: ' + e.message);
        }

        // ---- Insert a Markdown cell with the image ----
        const cellData  = new vscode.NotebookCellData(
            vscode.NotebookCellKind.Markup,
            `<img src="${imgRel}/${fname}"${widthAttr} alt="pasted image"/>`,
            'markdown'
        );
        const insertIdx = insertAbove ? cell.index : cell.index + 1;
        this.outputPanel.print(`[PasteImage] inserting Markdown cell at index ${insertIdx}`);
        const edit      = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, [cellData])]);
        await vscode.workspace.applyEdit(edit);
        this.outputPanel.print('[PasteImage] done ✓');
    }

    // -----------------------------------------------------------------------
    // Apply / clear the "kernel offline" gray overlay on all visible wolfram
    // notebook editors, and notify the renderer webview.
    _applyKernelOfflineUI() {
        try { this._rendererMessaging.postMessage({ type: 'kernel-offline' }); } catch (_) {}
        this._setNotebookCellColorsOffline(true);
    }

    _clearKernelOfflineUI() {
        try { this._rendererMessaging.postMessage({ type: 'kernel-online' }); } catch (_) {}
        this._setNotebookCellColorsOffline(false);
    }

    // Desaturate / restore notebook cell background colours when the kernel goes offline.
    // The cell editor colours live in workbench.colorCustomizations — we cache the originals
    // and replace them with luminance-equivalent grays while offline.
    _setNotebookCellColorsOffline(offline) {
        try {
            const config = vscode.workspace.getConfiguration('workbench');
            const currentColors = config.get('colorCustomizations') || {};
            const KEYS = [
                'notebook.cellEditorBackground',
                'notebook.editorBackground',
                'notebook.cellBorderColor',
                'notebook.inactiveFocusedCellBorder',
                'notebook.collapsedCellBackground'
            ];
            const hasAny = KEYS.some(k => currentColors[k]);
            if (!hasAny) return;
            if (offline) {
                if (this._notebookColorCache) {
                    // Cache was loaded from globalState on reload (constructor path).
                    // The workspace may still show original colours if the previous
                    // session crashed before quitKernel() wrote the gray values.
                    // Derive gray from the cached originals and force-write to workspace.
                    const updatedColors = { ...currentColors };
                    let anyDirty = false;
                    for (const k of KEYS) {
                        const orig = this._notebookColorCache[k];
                        if (orig) {
                            const gray = this._toGrayscaleHex(orig);
                            if (currentColors[k] !== gray) { updatedColors[k] = gray; anyDirty = true; }
                        }
                    }
                    if (anyDirty) config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace).catch(() => {});
                    return;
                }
                // First time going offline this session — build cache from current colours.
                this._notebookColorCache = {};
                const updatedColors = { ...currentColors };
                for (const k of KEYS) {
                    if (currentColors[k]) {
                        this._notebookColorCache[k] = currentColors[k];
                        updatedColors[k] = this._toGrayscaleHex(currentColors[k]);
                    }
                }
                // Persist cache to globalState so it survives a VS Code window reload
                // while the kernel is offline (otherwise original colors are lost on reload).
                if (this._extContext) {
                    this._extContext.globalState.update('wolfbook.notebookColorCache', this._notebookColorCache).catch(() => {});
                }
                config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace).catch(() => {});
            } else {
                // Restore from cache
                if (!this._notebookColorCache) return;
                const updatedColors = { ...currentColors };
                for (const k of KEYS) {
                    if (this._notebookColorCache[k]) updatedColors[k] = this._notebookColorCache[k];
                }
                this._notebookColorCache = null;
                // Clear the persisted cache now that colors are restored.
                if (this._extContext) {
                    this._extContext.globalState.update('wolfbook.notebookColorCache', null).catch(() => {});
                }
                config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace).catch(() => {});
            }
        } catch (_) {}
    }

    // Luminance-preserving hex→gray conversion (e.g. "#F0FFF0" → "#FAFAFA")
    _toGrayscaleHex(hex) {
        try {
            const num = parseInt(hex.replace('#', ''), 16);
            const r = (num >> 16) & 0xFF, g = (num >> 8) & 0xFF, b = num & 0xFF;
            const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            return '#' + ((1 << 24) | (gray << 16) | (gray << 8) | gray).toString(16).slice(1);
        } catch (_) { return hex; }
    }

    // -----------------------------------------------------------------------
    async launchKernel() {
        console.log('[launchKernel] entering (WSTP)');

        let kernelInitPath = path.join(this.extensionPath, "resources", "init.wl");
        if (process.platform === "win32") kernelInitPath = kernelInitPath.replace(/\\/g, "/");

        const kernelCommand = this.findKernel.resolveKernel();
        console.log(`[launchKernel] kernel path: ${kernelCommand}`);

        if (!WstpSession) {
            vscode.window.showErrorMessage("wstp.node addon not available — cannot launch kernel.");
            return;
        }

        this.kernelStatusString = 'launching';
        this._applyKernelOfflineUI();  // make sure UI stays gray during launch

        try {
            console.log('[launchKernel] creating WstpSession…');
            // Increment epoch so the renderer knows outputs from this point belong
            // to a fresh session.  Broadcast happens after init.wl loads.
            this._sessionEpoch++;
            // Stop all running Dynamic widgets — they belong to the old session.
            if (this._dynamicWidgets) {
                for (const state of this._dynamicWidgets.values()) state.active = false;
                this._dynamicWidgets.clear();
            }
            // Clear Dynamic widget outputs from all cells so stale content disappears.
            if (this._dynCells) {
                for (const { cell: _dc } of this._dynCells.values()) {
                    try {
                        const _clrExec = this._controller.createNotebookCellExecution(_dc);
                        _clrExec.start(Date.now());
                        await _clrExec.replaceOutput([]);
                        _clrExec.end(true, Date.now());
                    } catch (_e) { /* cell may already be gone */ }
                }
                this._dynCells.clear();
            }
            // Reset dialog mutex so new widgets start on a clean chain.
            this._dynDialogMutex = Promise.resolve();
            this._dynIdleMutex   = Promise.resolve();
            this._abortPending   = false;
            this._renderingActive = false;
            // Clear per-output registries — Out[N] values don't survive a kernel restart,
            // so any format-switch buttons referencing them must become inert.
            this._outputRegistry.clear();
            this.truncatedOutputCells.clear();
            // Truncate both debug logs on every kernel start so only fresh data is visible.
            _resolveScrollLogPath();
            if (_dynLogPath)    try { require('fs').writeFileSync(_dynLogPath,    ''); } catch(_){}
            if (_scrollLogPath) try { require('fs').writeFileSync(_scrollLogPath, ''); } catch(_){}
            dynLog('=== KERNEL START ===', new Date().toISOString());
            this.session = new WstpSession(kernelCommand, { interactive: true });

            // Load init.wl via sub() so it runs as a priority batch call and
            // does NOT count as a user evaluation (does not increment $Line).
            console.log(`[launchKernel] loading init.wl from: ${kernelInitPath}`);
            const initExpr = await this.session.sub(
                `Get["${kernelInitPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`
            );
            console.log(`[launchKernel] init.wl loaded, result=${JSON.stringify(initExpr)}`);

            // Push initial config
            const cfg = this.config.getKernelRelatedConfigs();
            for (const [k, v] of Object.entries(cfg)) {
                const vStr = typeof v === "string" ? `"${v}"` : String(v);
                await this.session.sub(`$setKernelConfig["${k}", ${vStr}]`).catch(() => {});
            }

            // Set $PageWidth so Print[] / OutputForm wraps at the configured width
            // instead of the default 78 characters.  Two times the default (156)
            // avoids most wrapping while keeping ASCII-art power notation readable.
            const printPageWidth = this.config.get("notebook.print.pageWidth") ?? 156;
            // Update $PageWidth so the Print[] override in init.wl picks up the
            // user-configured value (init.wl sets the default of 156 at launch;
            // this call overrides it with whatever the workspace setting says).
            await this.session.sub(`$PageWidth = ${printPageWidth}`).catch(() => {});

            // Set NotebookDirectory[] to the directory of the currently active wolfram
            // notebook so that Get["relative/path"] and friends work as expected.
            const _wolframNbEditor = vscode.window.visibleNotebookEditors.find(
                ed => ed.notebook.notebookType === 'extended-wolfram-notebook'
            );
            if (_wolframNbEditor) {
                let _nbDir = path.dirname(_wolframNbEditor.notebook.uri.fsPath);
                if (process.platform === 'win32') _nbDir = _nbDir.replace(/\\/g, '/');
                const _nbDirEsc = _nbDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                await this.session.sub(
                    `Unprotect[NotebookDirectory]; NotebookDirectory[] = "${_nbDirEsc}"; Protect[NotebookDirectory]`
                ).catch(() => {});
                console.log('[launchKernel] NotebookDirectory set to:', _nbDir);
            }

            // Note: the interrupt → Dialog[] handler is installed by init.wl
            // (Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]).
            // No separate evaluate() call needed here — that would waste a $Line slot
            // (making the user's first cell show In[2] instead of In[1]) and could
            // double-register the handler (two Dialog[] calls per interrupt).

            this.kernelStatusString = "resolved";
            vscode.commands.executeCommand("setContext", "wolframKernelActive", true);
            vscode.window.showInformationMessage("Wolfram kernel launched (WSTP), ready for evaluation.");
            console.log('[launchKernel] kernel ready');
            this._clearKernelOfflineUI();
            // Notify renderer that a new session started — it will remove stale
            // Out[N]= labels and expand banners tagged with the old epoch.
            try {
                this._rendererMessaging.postMessage({ type: 'session-changed', epoch: this._sessionEpoch });
            } catch (_) {}
            // Process any cells that were queued while the kernel was launching
            // (e.g. via preVisualStart before the kernel was ready).
            // .then() callers also invoke checkoutExecutionQueue, but calling it
            // here as well ensures no cell is missed if the caller forgets,
            // and the extra call is always safe (returns immediately if queue[0]
            // is already 'started').
            scrollLog('[launchKernel] resolved — calling checkoutExecutionQueue | queue:', this.executionQueue.queueLength());
            this.checkoutExecutionQueue();
        } catch (err) {
            console.error(`[launchKernel] error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to launch Wolfram kernel: ${err.message}`);
            this.kernelStatusString = "unresolved";
            this._applyKernelOfflineUI();
        }
    }

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // _prewarmSubKernel — fire-and-forget: start the subkernel and load init.wl
    // as soon as the first Dynamic widget is registered, so the first real render
    // doesn't pay the cold-start penalty (~1–2 s for a new WstpSession + init.wl).
    // _ensureSubKernel() will reuse _subKernelInitPromise and just set imgDir.
    _prewarmSubKernel() {
        if (this._subKernel && this._subKernelReady)  return; // already warm
        if (this._subKernelInitPromise)               return; // already warming
        if (!WstpSession)                             return; // addon unavailable
        const kernelCommand    = this.findKernel.resolveKernel();
        let kernelInitPath     = path.join(this.extensionPath, 'resources', 'init.wl');
        if (process.platform === 'win32') kernelInitPath = kernelInitPath.replace(/\\/g, '/');
        const _initEscaped = kernelInitPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        console.log('[subKernel] prewarming…');
        this._subKernelInitPromise = (async () => {
            this._subKernel = new WstpSession(kernelCommand, { interactive: false });
            await this._subKernel.sub('Get["' + _initEscaped + '"]');
            this._subKernelReady = true;
            console.log('[subKernel] prewarm complete (ready for imgDir)');
        })().catch(e => {
            console.warn('[subKernel] prewarm failed:', e.message);
            this._subKernelInitPromise = null;
            this._subKernel = null;
            this._subKernelReady = false;
        });
    }

    // -----------------------------------------------------------------------
    // _ensureSubKernel — lazily boot a second kernel for subsession rendering.
    // - Loads the same init.wl so VsCodeRenderExpr is available.
    // - Updates VsCodeSetImgDir on every call so SVG files land in the right place.
    // - If _prewarmSubKernel() already ran, this only sets imgDir (fast path).
    async _ensureSubKernel(imgDir, imgRel) {
        const _setImgDir = 'VsCodeSetImgDir["' + this.escapeWL(imgDir) + '", "' + this.escapeWL(imgRel) + '"]';
        if (this._subKernel && this._subKernelReady) {
            try { await this._subKernel.sub(_setImgDir); } catch (_) {}
            return this._subKernel;
        }
        if (this._subKernelInitPromise) {
            await this._subKernelInitPromise;
            if (this._subKernel && this._subKernelReady) {
                try { await this._subKernel.sub(_setImgDir); } catch (_) {}
                return this._subKernel;
            }
        }
        this._subKernelInitPromise = (async () => {
            if (!WstpSession) throw new Error('wstp.node addon not available — cannot start subkernel');
            const kernelCommand = this.findKernel.resolveKernel();
            let kernelInitPath = path.join(this.extensionPath, 'resources', 'init.wl');
            if (process.platform === 'win32') kernelInitPath = kernelInitPath.replace(/\\/g, '/');
            const _initEscaped = kernelInitPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            console.log('[subKernel] launching…');
            this._subKernel = new WstpSession(kernelCommand, { interactive: false });
            await this._subKernel.sub('Get["' + _initEscaped + '"]');
            await this._subKernel.sub(_setImgDir);
            this._subKernelReady = true;
            console.log('[subKernel] ready');
        })();
        await this._subKernelInitPromise;
        return this._subKernel;
    }

    // -----------------------------------------------------------------------
    quitKernel() {
        console.log('[quitKernel] closing session');
        // Close subkernel first (it has no queue to drain).
        if (this._subKernel) {
            try { this._subKernel.close(); } catch (_) {}
            this._subKernel = null;
            this._subKernelReady = false;
            this._subKernelInitPromise = null;
        }
        if (this.session) {
            try { this.session.close(); } catch (_) {}
            this.session = undefined;
        }
        this.kernelStatusString = "unresolved";
        vscode.commands.executeCommand("setContext", "wolframKernelActive", false);
        this._applyKernelOfflineUI();
    }

    // -----------------------------------------------------------------------
    abortEvaluation() {
        // Dynamic cell loops are NOT killed on abort — they stay alive and naturally
        // transition to "paused" state once busy becomes false after the abort.

        if (this.isAborting || this._abortPending) return;
        if (!this.session) { this.executionQueue.clear(); return; }

        // Signal widget loops to skip their current dialog cycle immediately.
        this._abortPending = true;

        // Queue the actual kernel abort AFTER the current dialog mutex is released.
        // This ensures we never call session.abort() mid-dialogEval, which confuses
        // the WSTP link and prevents the aborted packet from ever arriving.
        // Hard 2s fallback: if the dialog cycle takes longer, abort fires anyway.
        const prevMutex = this._dynDialogMutex;
        let _releaseMutexAbort;
        this._dynDialogMutex = new Promise(r => _releaseMutexAbort = r);

        const doAbort = () => {
            this._abortPending = false;
            this._evalDispatched = false;
            this._cellEpoch     = ((this._cellEpoch || 0) + 1) & 0xFFFFFF;
            this._dispatchEpoch = (this._dispatchEpoch + 1) & 0xFFFFFF;
            _releaseMutexAbort(); // restore the mutex chain for future widget cycles

            // Reset idle-sub mutex so any checkoutExecutionQueue waiting on it
            // can proceed immediately after abort — don't wait for 3s sub() timeout.
            this._dynIdleMutex = Promise.resolve();

            // Always close any stale dialog state before abort — closeAllDialogs()
            // rejects all pending dialogEval/exitDialog promises immediately,
            // so they don't hang while the kernel processes the abort.
            this.session.closeAllDialogs?.();

            const didAbort = this.session.abort();
            scrollLog('[abort] session.abort() =>', didAbort);

            if (!didAbort) {
                this.executionQueue.clear();
                return;
            }

            // Only set isAborting if the checkout loop is still alive to receive
            // the aborted packet. If execution already finished (queue empty or
            // not started), skip it — there's nothing to clear it, and isAborting
            // would block all future evaluations.
            const hasActiveCheckout = this.executionQueue.queue.length > 0 &&
                                      this.executionQueue.queue[0].started;
            this.executionQueue.clear();

            if (!hasActiveCheckout) {
                scrollLog('[abort] no active checkout — not setting isAborting');
                return;
            }

            this.isAborting = true;
            // Safety net: force-clear after 1s in case the aborted packet
            // arrives but no handler processes it (timing edge case).
            setTimeout(() => {
                if (this.isAborting) {
                    scrollLog('[abort] safety timeout: forcing isAborting = false after 1s');
                    this.isAborting = false;
                }
            }, 1000);
        };

        // Wait for widget loop to release the mutex (max 2s), then abort.
        Promise.race([
            prevMutex,
            new Promise(r => setTimeout(r, 2000))
        ]).then(doAbort);
    }

    // -----------------------------------------------------------------------
    restartKernel() {
        this.writeDebugLog("[RESTART] restartKernel called");
        if (this.isAborting) {
            this.writeDebugLog("[RESTART] overriding in-progress abort");
        }
        this.isAborting = false;
        this.executionQueue.clear();

        const hadKernel = !!this.session;
        this.quitKernel();

        if (hadKernel || true) {
            setTimeout(() => {
                this.launchKernel().catch(err => {
                    vscode.window.showErrorMessage(`Failed to restart kernel: ${err.message}`);
                });
            }, 300);
        }
    }

    // -----------------------------------------------------------------------
    writeFileChecked(filePath, text) {
        writeFile(filePath, text, err => {
            if (!err) return;
            vscode.window.showErrorMessage(
                `Unable to write file ${filePath}\n${err.message}`, "Retry", "Save As…", "Dismiss"
            ).then(value => {
                if (value === "Retry") this.writeFileChecked(filePath, text);
                else if (value === "Save As…") {
                    vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(filePath),
                        filters: { "All Files": ["*"] }
                    }).then(uri => { if (uri) this.writeFileChecked(uri.fsPath, text); });
                }
            });
        });
    }
}

exports.WolframNotebookKernel = WolframNotebookKernel;
exports.scrollLog = scrollLog;
//# sourceMappingURL=controller.js.map
