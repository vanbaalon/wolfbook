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
function _resolveScrollLogPath() {
    if (_scrollLogPath) return _scrollLogPath;
    const folders = (typeof vscode !== 'undefined') && vscode.workspace && vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const extFolder = folders.find(f => f.name === 'VSCodeWolframExtension');
    const base = extFolder ? extFolder.uri.fsPath : folders[0].uri.fsPath;
    _scrollLogPath = require('path').join(base, 'Temporary Docs', 'wolfram-scroll-debug.log');
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

        // Apply offline renderer overlay to any wolfram notebook that becomes visible
        // while the kernel is not running.
        // Also restores per-notebook default output format from persistent storage.
        // Also sends session-changed so the renderer can clean up stale session elements
        // from a previous run (e.g. when the notebook is reopened without restarting VS Code).
        vscode.window.onDidChangeVisibleNotebookEditors(() => {
            if (this.kernelStatusString !== 'resolved') this._applyKernelOfflineUI();
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

            // ---- Dialog subsession messages ----
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
    _resolveFormat(cell, knownIsGfx) {
        const cellUri = cell.document.uri.toString();
        // 1. Per-cell explicit override (set when user clicks a format button)
        const perCell = this._cellOutputFormat.get(cellUri);
        if (perCell) return perCell;
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
        if (isGfx === true) {
            const d = this._notebookDefaultGfxFormat.get(nbUri);
            if (d) return d;
        } else if (isGfx === false) {
            const d = this._notebookDefaultExprFormat.get(nbUri);
            if (d) return d;
        }
        // 3. VS Code settings fallback
        return String(this.config.get('outputFormat') || 'Auto');
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
                        scrollLog('[advance] scheduling immediate input-cell animated scroll for cell', _advIdx);
                        setTimeout(() => {
                            // setTimeout(0) lets VS Code's selection advance (N→N+1) happen
                            // first, then we scroll the EVALUATED cell (not the newly selected one).
                            scrollLog('[advance t=0] scrolling cell', _advIdx, 'to top (animated)');
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
                const execution = this._controller.createNotebookCellExecution(cell);
                const queueId   = this.executionQueue.push(execution);
                execution.token.onCancellationRequested(() => {
                    this.outputPanel.print("Cell execution cancelled by user");
                    this.abortEvaluation();
                });
            }
            this.checkoutExecutionQueue();
        } else {
            // Kernel not running: queue the cells and auto-launch.
            // checkoutExecutionQueue() is called after launch succeeds so the
            // queued cells execute immediately without user re-running them.
            for (const cell of cells) {
                const execution = this._controller.createNotebookCellExecution(cell);
                const queueId   = this.executionQueue.push(execution);
                execution.token.onCancellationRequested(() => {
                    this.outputPanel.print("Cell execution cancelled by user");
                    this.abortEvaluation();
                });
            }
            if (this.kernelStatusString !== 'launching') {
                vscode.window.showInformationMessage('Kernel not running — launching kernel and queuing evaluation…');
                this.launchKernel().then(() => {
                    if (this.kernelStatusString === 'resolved') this.checkoutExecutionQueue();
                }).catch(() => { this.executionQueue.clear(); });
            }
            // else: already launching — cells are queued, will run once launch completes
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

        const code = currentExecution.execution.cell.document.getText();

        if (!code.trim()) {
            this.executionQueue.start(currentExecution.id);
            this.executionQueue.end(currentExecution.id, false);
            return;
        }

        // Clear previous diagnostics
        this.diagnosticCollection.delete(currentExecution.execution.cell.document.uri);
        this.clearSyntaxErrorDecorations(currentExecution.execution.cell);

        this.executionQueue.start(currentExecution.id);

        // ---- Record source for eval-mode auto-detection on next run ----
        // Stored at the START of execution so the NEXT Shift+Enter on this cell
        // can compare against the version that was actually evaluated.
        const _cellUriForLog = currentExecution.execution.cell.document.uri.toString();
        scrollLog('[checkout] recording source for cell', currentExecution.execution.cell.index,
                  '| uri:', _cellUriForLog.split('#')[1] || _cellUriForLog.slice(-20));
        this._cellLastSource.set(_cellUriForLog, code);
        // Clear dirty flag — the current source is now the baseline for next comparison.
        this._cellDirty.delete(_cellUriForLog);

        // Zero-height placeholder so VS Code collapses the output area
        await currentExecution.execution.replaceOutput([
            new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text(
                    '<div style="height:0;overflow:hidden;margin:0;padding:0;"></div>',
                    "text/html"
                )
            ])
        ]);

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
            // ---- Syntax check on full cell text (non-blocking, non-fatal) ----
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

            // ---- Evaluate each sub-expression one by one ----
            // Each goes through the interactive kernel main loop → gets its own
            // Out[N]= label and increments $Line.  Rendering is a separate batch
            // sub() call that reads Out[N] without polluting In/Out.
            for (let i = 0; i < subExprs.length; i++) {
                if (this.isAborting) { anyAborted = true; break; }

                const subExpr = subExprs[i];

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
                if (r.outputName && lineN > 0) {
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
                            const outLabel =
                                `<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;

                            // Detect skeleton (Short[] applied kernel-side) OR raw truncation
                            const isSkeleton = html.includes('data-wolfram-is-skeleton');
                            // Always generate a unique outputId — needed by format-switch buttons
                            // on ALL outputs (not only truncated ones).
                            const outputId = (this._outputIdCounter++).toString();
                            // isGfx: read the authoritative marker embedded by VsCodeRender/VsCodeRenderFull,
                            // NOT from CSS classes — those vary by format (WL/TeX/LaTeX have no image classes).
                            const _isGfx = html.includes('vscode-wolfram-gfx-marker');
                            this._outputRegistry.set(outputId,
                                { cell: execCell, outN: lineN, outName: r.outputName, format, isGfx: _isGfx });
                            const headerRow = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;" data-session-epoch="${this._sessionEpoch}" data-output-id="${outputId}" data-out-n="${lineN}" data-output-format="${format}" data-output-is-graphics="${_isGfx ? '1' : '0'}">${outLabel}</div>`;
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
                                    `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;">${outLabel}</div>` +
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

            scrollLog('[checkout-end] execution.end() about to fire — cell', execCell.index,
                      '| wasRefine:', _wasRefine);
            this.executionQueue.end(currentExecution.id, !anyAborted);
            scrollLog('[checkout-end] execution.end() done');

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
            `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;" ` +
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
        const headerRow  = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;" ` +
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
        const busy = this.executionQueue.queue.length > 0 && this.executionQueue.queue[0].started;
        if (!busy) {
            vscode.window.showInformationMessage(
                'Kernel is idle — run a long evaluation first, then press ⌥⇧↵ to inspect it.'
            );
            return;
        }
        const editor = vscode.window.activeNotebookEditor;
        if (!editor) { vscode.window.showWarningMessage('No active notebook editor.'); return; }
        const sel = editor.selections;
        if (!sel || sel.length === 0) { vscode.window.showWarningMessage('No cell selected.'); return; }
        const cell = editor.notebook.cellAt(sel[0].start);
        if (!cell || cell.kind !== vscode.NotebookCellKind.Code) {
            vscode.window.showWarningMessage('Select a code cell to evaluate in the dialog.');
            return;
        }
        const cellCode = cell.document.getText().trim();
        if (!cellCode) { vscode.window.showWarningMessage('Cell is empty.'); return; }

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
        // Create a VS Code execution for this cell so it shows the running spinner
        const execution = this._controller.createNotebookCellExecution(cell);
        execution.start(Date.now());
        await execution.replaceOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(
                '<div style="color:#e8a020;font-size:11px;font-style:italic;">⏳ Dialog: evaluating…</div>',
                'x-application/wolfram-language-html'
            )
        ])]);

        let wexpr = null;
        let evalError = null;
        try {
            wexpr = await this.session.dialogEval(cellCode);
        } catch (err) {
            evalError = err.message;
        }

        const printLines = [...dialogPrintLines];
        this._dialogPrintCollector = null;

        // Exit dialog → main eval resumes
        try { await this.session.exitDialog(); } catch (_) {}

        // Build output HTML
        const labelHtml =
            '<span style="font-size:10px;color:#e8a020;margin-right:8px;font-weight:bold;">Dialog: Out</span>';
        const parts = [];

        if (printLines.length > 0) {
            const printHtml = printLines.map(line => {
                const text = this.decodeWolframOctal(line.replace(/\\012/g, '\n'));
                return '<pre class="vscode-wolfram-print-output">' + this.escapeHtml(text) + '</pre>';
            }).join('');
            parts.push(printHtml);
        }

        if (evalError) {
            parts.push(
                '<div style="display:flex;align-items:baseline;gap:4px;padding:3px 0">' +
                labelHtml +
                '<span style="color:#f44747;font-family:Consolas,monospace;font-size:13px;">' +
                this.escapeHtml(evalError) + '</span></div>'
            );
        } else {
            const resultText = this._wexprToInputForm(wexpr);
            parts.push(
                '<div style="display:flex;align-items:baseline;gap:4px;padding:3px 0">' +
                labelHtml +
                '<span style="color:#9cdcfe;white-space:pre-wrap;word-break:break-all;' +
                'font-family:Consolas,monospace;font-size:13px;">' +
                this.escapeHtml(resultText) + '</span></div>'
            );
        }

        await execution.replaceOutput([new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(
                `<div data-session-epoch="${this._sessionEpoch}">${parts.join('')}</div>`,
                'x-application/wolfram-language-html'
            )
        ])]);
        execution.end(true, Date.now());
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
    }

    _clearKernelOfflineUI() {
        try { this._rendererMessaging.postMessage({ type: 'kernel-online' }); } catch (_) {}
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
            // Clear per-output registries — Out[N] values don't survive a kernel restart,
            // so any format-switch buttons referencing them must become inert.
            this._outputRegistry.clear();
            this.truncatedOutputCells.clear();
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
        } catch (err) {
            console.error(`[launchKernel] error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to launch Wolfram kernel: ${err.message}`);
            this.kernelStatusString = "unresolved";
            this._applyKernelOfflineUI();
        }
    }

    // -----------------------------------------------------------------------
    quitKernel() {
        console.log('[quitKernel] closing session');
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
        if (this.isAborting) {
            return;
        }
        if (!this.session) {
            this.executionQueue.clear();
            return;
        }

        // abort() is synchronous — returns true if an eval was in flight, false if idle.
        // Only set isAborting when something is actually being aborted.
        // If false (idle), it's a pure no-op: the queue is untouched and evaluations proceed normally.
        const didAbort = this.session.abort();

        if (!didAbort) {
            // Nothing was running — no-op. Don't block the queue.
            return;
        }

        // An evaluation was in flight — flag it so the checkout loop shows the indicator.
        // isAborting is cleared in checkoutExecutionQueue when wrapStatus === "aborted".
        this.isAborting = true;
        this.executionQueue.clear();
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
