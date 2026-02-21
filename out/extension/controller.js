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

// ---- Scroll debug flag ----
// Set SCROLL_DEBUG = false to silence [scroll] logs in production.
const SCROLL_DEBUG = true;
const scrollLog = (...args) => SCROLL_DEBUG && console.log('[scroll]', ...args);

// Delay (ms) before calling revealRange after first output arrives.
// Must be long enough for the renderer webview to finish browser layout
// (innerHTML set → layout pass → stable cell height).  300 ms covers
// MathML and SVG outputs; reduce if outputs are always fast to render.
const SCROLL_DELAY_MS = 300;

// ---- lazy-load the native WSTP addon (requires wstp/build/Release/wstp.node) ----
let WstpSession;
try {
    WstpSession = require("../../wstp/build/Release/wstp.node").WstpSession;
} catch (e) {
    console.error("[Controller] Failed to load wstp.node:", e.message);
}

class WolframNotebookKernel {
    constructor() {
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
        // Session epoch: incremented on every kernel launch so the renderer can
        // remove dynamic elements (Out[N]= labels, expand banners) from old sessions.
        this._sessionEpoch = 0;

        // Apply offline renderer overlay to any wolfram notebook that becomes visible
        // while the kernel is not running.
        vscode.window.onDidChangeVisibleNotebookEditors(() => {
            if (this.kernelStatusString !== 'resolved') this._applyKernelOfflineUI();
        });
        // Scroll-after-evaluation tracking: stored by cell INDEX (number), not
        // object reference, because VS Code may return different proxy objects
        // from createNotebookCellExecution than were passed in.
        this._pendingScrollCellIndex    = null;  // set by markKeyboardExecution()
        this._pendingScrollCellNotebook = null;  // set by markKeyboardExecution()

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
        // as well as any manual navigation — visible in DevTools console.
        vscode.window.onDidChangeNotebookEditorSelection(event => {
            const ed  = event.notebookEditor;
            const sel = event.selections;
            const indices = sel.map(r => `${r.start}-${r.end}`).join(', ');
            scrollLog('[selection-change] notebook editor selection →', indices,
                      '| editor notebook uri:', ed.notebook.uri.fsPath.split('/').pop());
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
                const MAX_HTML_BYTES     = 100 * 1024;
                try {
                    const renderPromise = this.session.evaluate(
                        `VsCodeRenderFull[${info.outN}, "Auto", 0.8]`,
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
                            htmlVal = this._fixImageUris(renderResult.result.value);
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

    // Called by wolfram.executeCell command before invoking execute().
    // Tags the cell so checkoutExecutionQueue knows to scroll after first output.
    // We store the cell INDEX (number) and notebook reference rather than the
    // cell object itself, because VS Code may wrap the cell in a different proxy
    // by the time checkoutExecutionQueue runs.
    markKeyboardExecution(cell) {
        this._pendingScrollCellIndex    = cell.index;
        this._pendingScrollCellNotebook = cell.notebook;
        scrollLog('keyboard execution marked — scroll armed for cell index', cell.index);
    }

    // Immediately scrolls back to the evaluated cell to cancel VS Code's
    // auto-advance scroll (which fires before execute() is called).
    // Called synchronously inside execute() — no deferral.
    _counterScrollNow(cell) {
        const cellIndex = cell.index;
        const notebook  = cell.notebook;
        scrollLog('_counterScrollNow — immediately scrolling to cell', cellIndex,
                  'to cancel VS Code auto-advance');
        try {
            for (const ed of vscode.window.visibleNotebookEditors) {
                if (ed.notebook === notebook) {
                    const RangeCtor = vscode.NotebookRange ?? vscode.NotebookCellRange;
                    ed.revealRange(
                        new RangeCtor(cellIndex, cellIndex),
                        vscode.NotebookEditorRevealType.AtTop
                    );
                    scrollLog('_counterScrollNow — done');
                    return;
                }
            }
        } catch (e) {
            scrollLog('_counterScrollNow error (non-fatal):', e.message);
        }
    }

    // Scroll the notebook editor to show the output cell with minimum movement.
    //
    // RevealType.AtTop: always aligns the top of the output cell to the top of
    // the viewport — correct for both short and tall outputs.
    //
    // The revealRange call is DEFERRED by SCROLL_DELAY_MS so it fires after:
    //   (a) VS Code's auto-advance of focus to the next input cell, AND
    //   (b) the renderer webview finishes browser layout of the new HTML.
    // setTimeout(0) only wins race (a); the browser needs ~1-2 animation frames
    // after innerHTML is set before cell heights are stable.
    _scrollToOutputCell(cell) {
        // Capture identity before deferring — cell object may be stale by timeout
        const cellIndex = cell.index;
        const notebook  = cell.notebook;
        scrollLog('_scrollToOutputCell — cell index:', cellIndex,
                  '(deferring', SCROLL_DELAY_MS + 'ms to allow browser layout)');
        setTimeout(() => {
            scrollLog('(deferred) revealRange firing — cell index:', cellIndex);
            try {
                for (const ed of vscode.window.visibleNotebookEditors) {
                    if (ed.notebook === notebook) {
                        // vscode.NotebookCellRange was renamed to vscode.NotebookRange
                        // in VS Code API ~1.68. Use whichever exists.
                        const RangeCtor = vscode.NotebookRange ?? vscode.NotebookCellRange;
                        // AtTop: always aligns the top of the cell to the top of the viewport.
                        // Default (minimal scroll) scrolls the BOTTOM edge into view for tall
                        // outputs, landing the user at the end of the output — wrong behaviour.
                        scrollLog('calling revealRange — using', RangeCtor.name,
                                  'with NotebookEditorRevealType.AtTop');
                        ed.revealRange(
                            new RangeCtor(cellIndex, cellIndex),
                            vscode.NotebookEditorRevealType.AtTop
                        );
                        scrollLog('revealRange dispatched — VS Code applies minimal scroll');
                        return;
                    }
                }
                scrollLog('no matching notebook editor found — scroll skipped');
            } catch (e) {
                this.writeDebugLog(`[SCROLL] revealRange failed: ${e.message}`);
                scrollLog('revealRange error:', e.message);
            }
        }, SCROLL_DELAY_MS);
    }

    // Relative src= paths (e.g. img/MyNotebook/wl_xxx.svg) resolve correctly
    // in the VS Code webview relative to the notebook directory — no URI
    // rewriting needed.  Kept as a no-op in case it's called from expand paths.
    _fixImageUris(html) {
        return html;
    }

    makeTruncationBanner(outputId, headerText) {
        return `
<div style="margin-top:6px;padding:8px 12px;background:rgba(255,165,0,0.1);border-left:3px solid #FFA500;border-radius:4px"
     data-truncated-uuid="${outputId}" data-session-epoch="${this._sessionEpoch}">
  <div style="color:#FF8C00;font-weight:bold;margin-bottom:6px;font-size:12px;">
    ${headerText}
  </div>
  <div style="display:flex;gap:8px;">
    <button data-action="expand"
      style="padding:4px 10px;background:rgba(255,165,0,0.12);color:var(--vscode-foreground,#333);border:1px solid rgba(255,140,0,0.5);border-radius:3px;cursor:pointer;font-size:11px;">
      &#128269; Expand Inline
    </button>
    <button data-action="open-text"
      style="padding:4px 10px;background:rgba(255,165,0,0.12);color:var(--vscode-foreground,#333);border:1px solid rgba(255,140,0,0.5);border-radius:3px;cursor:pointer;font-size:11px;">
      &#128196; Open as Text File
    </button>
  </div>
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
                    // diff=1: normal Shift+Enter — selection already advanced to next cell
                    // diff=0: Shift+Enter on last cell — no next cell, selection stayed
                    scrollLog('  → keyboard-triggered (diff=' + diff + ') — arming scroll for cell', cellIdx);
                    this.markKeyboardExecution(cells[0]);
                    // VS Code already scrolled to the next cell (selection-change fired
                    // before execute()).  Counter-scroll back to the evaluated cell
                    // IMMEDIATELY here (synchronous, no delay) so the user never sees
                    // the "jump to next input" — this fires in the same event loop tick
                    // as execute(), before VS Code has a chance to paint the next cell.
                    this._counterScrollNow(cells[0]);
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

            const format = String(this.config.get("outputFormat") || "Auto");
            const scale  = Number(this.config.get("imageScale")   || 0.8);
            const maxLen = Number(this.config.get("maxOutputLength") || 100000);

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
            let hasScrolled = false;
            scrollLog(isKeyboardExec
                ? 'keyboard execution confirmed — cell index ' + execCell.index + ' — scroll armed'
                : 'programmatic execution — scroll skipped entirely');

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
                        // First real output has landed — scroll into view if keyboard-triggered
                        if (isKeyboardExec && !hasScrolled) {
                            hasScrolled = true;
                            scrollLog('first Print output arrived — triggering scroll check');
                            this._scrollToOutputCell(currentExecution.execution.cell);
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
                        if (renderResult?.result?.type === "string" && renderResult.result.value) {
                            let html = this._fixImageUris(renderResult.result.value);
                            const outLabel =
                                `<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;

                            // Detect skeleton (Short[] applied kernel-side) OR raw truncation
                            const isSkeleton = html.includes('data-wolfram-is-skeleton');
                            const headerRow = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;" data-session-epoch="${this._sessionEpoch}">${outLabel}</div>`;
                            if (html.length > maxLen || isSkeleton) {
                                const outputId = currentExecution.id + "-" + i;
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
                                this.truncatedOutputCells.set(outputId,
                                    { cell: currentExecution.execution.cell, outN: lineN });
                                this.writeDebugLog(
                                    `[CHECKOUT] ${isSkeleton ? 'Skeleton' : 'Truncated'} output OutN=${lineN} OutputID=${outputId}`);
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
                            // First real output (or only output) — scroll into view if keyboard-triggered
                            if (isKeyboardExec && !hasScrolled) {
                                hasScrolled = true;
                                scrollLog('first render result arrived — triggering scroll check');
                                this._scrollToOutputCell(currentExecution.execution.cell);
                            }
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

            this.executionQueue.end(currentExecution.id, !anyAborted);

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
        const outLabel = `<span style="font-size:10px;color:#888;margin-right:8px;">Out[${outN}]=</span>`;
        const finalHtml =
            `<div class="wl-output-block">` +
            `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;" data-session-epoch="${this._sessionEpoch}">${outLabel}</div>` +
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
    // GC: scan all cell outputs for data-wl-img paths that are still live,
    // then delete every .svg/.png in imgDir that is not referenced.
    // Runs synchronously via Node.js fs — no kernel round-trip, no timing issues.
    // Called at the START of each execution so previous outputs are committed.
    _cleanupImgDir(notebook, imgDir) {
        try {
            if (!imgDir || !fs.existsSync(imgDir)) return;
            // Collect all currently-referenced absolute image paths
            const live = new Set();
            for (const cell of notebook.getCells()) {
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
//# sourceMappingURL=controller.js.map
