'use strict';
// execution/checkout.js — checkoutExecutionQueue and _cleanupImgDir.
// Extracted from controller.js. Functions receive `self` (= WolframNotebookKernel) as first arg.

const vscode  = require('vscode');
const path    = require('path');
const fs      = require('fs');
const { scrollLog, wstpLog } = require('../utils/dev-logger');
const _output = require('../output/renderer');

async function checkoutExecutionQueue(self) {
    let currentExecution;
    try {
        currentExecution = self.executionQueue.getNextPendingExecution();
    } catch (_getErr) {
        return;
    }
    if (!currentExecution) {
        scrollLog('[checkout] getNextPending → null (queue empty or all started), returning');
        return;
    }

    // Was this cell queued via openDialogSubsession() on an idle kernel?
    // If so, add the "subsession" badge to every Out[...] label this run.
    const _isSubsession = self._subsessionCellUris.delete(
        currentExecution.execution.cell.document.uri.toString()
    );

    const code = currentExecution.execution.cell.document.getText();

    // Cancel the Dynamic loop for this cell before starting a new execution.
    // cancel() resolves state._cancelPromise, which unblocks any pending
    // subAuto race in the old runLoop so it exits immediately.
    if (self._dynamicWidgets) {
        const _cUri = currentExecution.execution.cell.document.uri.toString();
        const _prev = self._dynamicWidgets.get(_cUri);
        if (_prev) {
            if (_prev.cancel) _prev.cancel(); else _prev.active = false;
            self._dynamicWidgets.delete(_cUri);
            scrollLog('[dyn] cancelled cell loop for re-execution');
        }
    }
    if (self._dynCells) self._dynCells.delete(
        currentExecution.execution.cell.document.uri.toString());

    // TODO-1d: Markdown cells render natively — never send to kernel.
    // Silently complete so Run-All continues without ToExpression::sntx noise.
    if (currentExecution.execution.cell.kind === vscode.NotebookCellKind.Markup) {
        self.executionQueue.start(currentExecution.id);
        self.executionQueue.end(currentExecution.id, true);
        self.checkoutExecutionQueue();
        return;
    }

    if (!code.trim()) {
        self.executionQueue.start(currentExecution.id);
        self.executionQueue.end(currentExecution.id, true);  // empty cell = silent success
        self.checkoutExecutionQueue();  // advance to next queued cell
        return;
    }

    // Clear previous diagnostics and decorations
    self.diagnosticCollection.delete(currentExecution.execution.cell.document.uri);
    self.clearSyntaxErrorDecorations(currentExecution.execution.cell);
    self.clearRuntimeMsgDecoration(currentExecution.execution.cell);

    // Capture previous outputs BEFORE start() — VS Code clears them internally
    // when execution starts, causing a height-0 flash. We deep-snapshot the raw
    // item data so the objects remain valid after start() invalidates cell.outputs.
    // Filter out the consolidated AI-context error output (wolfram-html sentinel +
    // application/vnd.code.notebook.error) — it is always regenerated fresh at end
    // of the new run, so restoring it would duplicate the error block.
    const _isAiErrorOutput = o => {
        const mimes = (o.items || []).map(it => it.mime);
        return mimes.includes('x-application/wolfram-language-html') &&
               mimes.includes('application/vnd.code.notebook.error');
    };
    const prevOutputsSnap = currentExecution.execution.cell.outputs
        .filter(o => !_isAiErrorOutput(o))
        .map(o => ({
        items: (o.items || []).map(it => ({ mime: it.mime, data: it.data }))
    }));
    const _t0 = Date.now();
    scrollLog('[start] cell', currentExecution.execution.cell.index,
              '| prevOutputs:', prevOutputsSnap.length,
              '| t=', _t0);

    const _isSilentExec = !!currentExecution.execution._isSilent;
    try {
        self.executionQueue.start(currentExecution.id);
    } catch (_startErr) {
    }
    scrollLog('[start] after executionQueue.start() | dt=', Date.now() - _t0, 'ms', '| silent:', _isSilentExec);


    // Restore previous outputs WITHOUT await so start()+replaceOutput are sent
    // in the same synchronous JS turn. VS Code's extension host batches API calls
    // made in the same tick into a single IPC message, meaning clear+restore can
    // arrive at the renderer together — avoiding the one-frame blank-output flash.
    // Silent mode: start() is a no-op — VS Code never cleared outputs, skip restore.
    if (!_isSilentExec && prevOutputsSnap.length > 0) {
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
    self._cellLastSource.set(_cellUriForLog, code);
    // Clear dirty flag — the current source is now the baseline for next comparison.
    self._cellDirty.delete(_cellUriForLog);

    if (self.logFile !== "Off") {
        self.appendFileWrite(self.logFile, self.logString("Input: " + code));
    }

    try {
        if (!self.session) throw new Error("No kernel session — please launch the kernel first.");

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
            let lineNum = 0;           // current line in `code` (counts all \n)
            let exprStartLine = 0;     // line where the current expression started
            while (i < code.length) {
                const ch   = code[i];
                const next = i + 1 < code.length ? code[i + 1] : "";
                if (inStr) {
                    if (ch === '\n') lineNum++;
                    current += ch;
                    if      (ch === "\\") { if (i + 1 < code.length) { current += next; i++; } }
                    else if (ch === '"')  { inStr = false; }
                    i++; continue;
                }
                if (cDepth > 0) {
                    if (ch === '\n') lineNum++;
                    current += ch;
                    if      (ch === "(" && next === "*") { cDepth++; current += next; i += 2; }
                    else if (ch === "*" && next === ")") { cDepth--; current += next; i += 2; }
                    else i++;
                    continue;
                }
                if (ch === '"')                    { inStr = true;  current += ch; i++; }
                else if (ch === "(" && next === "*") { cDepth = 1; current += ch + next; i += 2; }
                else if (ch === "<" && next === "|") { depth++; current += ch + next; i += 2; }  // <| Association open
                else if (ch === "|" && next === ">") { depth--; current += ch + next; i += 2; }  // |> Association close
                else if (ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; i++; }
                else if (ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; i++; }
                else if ((ch === "\n" || ch === "\r") && depth === 0 && cDepth === 0) {
                    // potential split point
                    const t = current.trim();
                    // Keep lines together when current ends with a continuation operator
                    const endsWithOp = t.length > 0 && /(&&|\|\||->|:>|\/\/\.|\/\/|\/\/@|\/@|@@|<>|~~|;;|\^:=|:=|\+=|-=|\*=|\/=|[+\-*\/=,&|~@?])$/.test(t);
                    // Peek at first non-whitespace char(s) of the next line
                    let peekPos = i + 1;
                    if (ch === '\r' && next === '\n') peekPos = i + 2;
                    while (peekPos < code.length && (code[peekPos] === ' ' || code[peekPos] === '\t')) peekPos++;
                    const peekCh  = peekPos < code.length ? code[peekPos] : '';
                    const peekTwo = (peekPos + 1 < code.length) ? code.slice(peekPos, peekPos + 2) : peekCh;
                    const startsWithOp = t.length > 0 && peekCh.length > 0 && (
                        '=+-*/,|~@?'.includes(peekCh) ||
                        peekTwo === '&&' || peekTwo === '||' || peekTwo === '->' || peekTwo === ':>' ||
                        peekTwo === '//' || peekTwo === '<>' || peekTwo === '!=' || peekTwo === '>=' || peekTwo === '<='
                    );
                    if (endsWithOp || startsWithOp) {
                        // Continuation line — replace newline with space so WL
                        // sees "a + b +c" (one expression), not "a + b\n+c" (two).
                        current += ' ';
                        if (ch === '\r' && next === '\n') i++; // skip \r of CRLF
                        i++;
                        lineNum++;
                    } else {
                    if (t.length > 0) parts.push({ text: t, startLine: exprStartLine, endLine: lineNum });
                    current = "";
                    if (ch === "\r" && next === "\n") i++; // CRLF
                    i++;
                    lineNum++;
                    exprStartLine = lineNum;
                    }
                } else {
                    if (ch === '\n') lineNum++;   // newlines inside nested brackets
                    current += ch; i++;
                }
            }
            const t = current.trim();
            if (t.length > 0) parts.push({ text: t, startLine: exprStartLine, endLine: lineNum });
            return parts.length > 0 ? parts : [{ text: code, startLine: 0, endLine: code.split('\n').length - 1 }];
        })();
        // Per-cell format override takes precedence over the global setting.
        const format = self._resolveFormat(currentExecution.execution.cell);
        const scale  = Number(self.config.get("imageScale")   || 0.8);
        const maxLen = Number(self.config.get("maxOutputLength") || 1000000);

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
        self._cleanupImgDir(currentExecution.execution.cell.notebook, imgDir);

        // NOTE: _evalDispatched and _dispatchEpoch are set AFTER the setup phase
        // (syntax check + VsCodeSetImgDir) so the Dynamic widget does not interrupt
        // these sub()/evaluate() calls. Interrupting the syntax-check sub() while it
        // is in flight desynchronises the WSTP packet stream and causes the subsequent
        // cell evaluate() to hang forever. The flag is set just before the subExpr
        // loop, which is the earliest point the kernel is processing real cell code.

        // ---- Wait for any pending subAuto to drain ----
        // If a Dynamic loop's subAuto() is still in-flight at the C++ level,
        // our setup sub()/evaluate() calls would block behind it.  If C++ is
        // wedged (stale packets after Dialog-heavy eval), that blocks forever.
        // Wait briefly so the C++ call can finish; if it doesn't, the Dynamic
        // loop's _subAutoLock prevents new subAuto calls from piling on.
        if (self._subAutoLock) {
            scrollLog('[checkout] waiting for pending subAuto to drain...');
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | subAuto drain wait start`);
            try {
                await Promise.race([
                    self._subAutoLock,
                    new Promise(r => setTimeout(r, 3000))
                ]);
            } catch (_) {}
            scrollLog('[checkout] subAuto drain done | lock still held:', !!self._subAutoLock);
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | subAuto drain done | lock held: ${!!self._subAutoLock}`);
        }

        // ---- Syntax check on full cell text (non-blocking, non-fatal) ----
        // Use the C++ syntaxCheck() when available (zero kernel round-trip).
        // Falls back to VsCodeSyntaxCheck via sub() if the addon is older.
        self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | syntax check start`);
        try {
            let syntaxResult;
            if (self._syntaxCheck) {
                // Synchronous C++ structural check — no kernel needed
                const _nbp = vscode.window.activeNotebookEditor?.notebook.uri?.fsPath;
                const _t0 = Date.now();
                wstpLog(_nbp, `→ [syntaxCheck]  ${code.slice(0, 200)}`);
                const _scVal = self._syntaxCheck(code);
                wstpLog(_nbp, `← [syntaxCheck]  ok  ${Date.now()-_t0}ms  ${_scVal.slice(0, 200)}`);
                syntaxResult = { type: 'string', value: _scVal };
            } else {
                syntaxResult = await self.session.evaluate(
                    "VsCodeSyntaxCheck[" + JSON.stringify(code) + "]", { interactive: false }
                );
            }
            if (syntaxResult && syntaxResult.type === "string" && syntaxResult.value) {
                const syntaxJson = JSON.parse(syntaxResult.value);
                if (syntaxJson.errors && syntaxJson.errors.length > 0) {
                    self.handleSyntaxErrors(currentExecution.execution.cell, syntaxJson.errors);
                }
            }
        } catch (syntaxErr) {
            self.writeDebugLog(`[CHECKOUT] Syntax check error (non-fatal): ${syntaxErr.message}`);
        }

        const _coT0 = Date.now();
        const _imgDirChanged = (self._lastMainImgDir !== imgDir) || (self._lastMainImgRel !== imgRel);

        // ---- Update $WBNotebookDirectory before each cell ----
        // This keeps NotebookDirectory[] / WBDirectory[] correct when the user
        // runs cells in different notebooks that share a kernel.
        // We only send a kernel round-trip when the notebook has changed.
        {
            let _cellNbDir = path.dirname(nbFsPath);
            if (process.platform === 'win32') _cellNbDir = _cellNbDir.replace(/\\/g, '/');
            if (_cellNbDir !== self._lastNbDir) {
                const _esc = _cellNbDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                try {
                    await self.session.evaluate(
                        `$WBNotebookDirectory = "${_esc}"`,
                        { interactive: false, rejectDialog: true }
                    );
                    self._lastNbDir = _cellNbDir;
                    scrollLog('[checkout] $WBNotebookDirectory updated to', _cellNbDir);
                } catch (_e) {
                    self.writeDebugLog(`[CHECKOUT] $WBNotebookDirectory update failed (non-fatal): ${_e.message}`);
                }
            }
        }

        if (_imgDirChanged) {
            scrollLog('[checkout] VsCodeSetImgDir start | cell', currentExecution.execution.cell.index);
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | VsCodeSetImgDir start`);
            try {
                await self.session.evaluate(
                    `VsCodeSetImgDir["${self.escapeWL(imgDir)}", "${self.escapeWL(imgRel)}"]`,
                    { interactive: false, rejectDialog: true }
                );
                self._lastMainImgDir = imgDir;
                self._lastMainImgRel = imgRel;
                scrollLog('[checkout] VsCodeSetImgDir done | dt=', Date.now() - _coT0, 'ms');
                self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | VsCodeSetImgDir done | dt=${Date.now() - _coT0}ms`);
            } catch (imgDirErr) {
                self.writeDebugLog(`[CHECKOUT] VsCodeSetImgDir failed (non-fatal): ${imgDirErr.message}`);
            }
        } else {
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | VsCodeSetImgDir skipped (unchanged)`);
        }

        // Install interrupt handler only when needed (first run after launch/restart,
        // or after an abort, which clears handler registration in the kernel).
        // This still runs before _evalDispatched=true so Dynamic loops cannot interrupt it.
        const _needInterruptInstall = !self._interruptHandlerInstalled;
        if (_needInterruptInstall) {
            scrollLog('[checkout] interrupt handler reinstall start | cell', currentExecution.execution.cell.index);
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | interrupt handler reinstall start`);
            try {
                await self.session.evaluate(
                    'Quiet[Internal`AddHandler["Interrupt", Function[Null, Dialog[]]]]',
                    { interactive: false, rejectDialog: true }
                );
                self._interruptHandlerInstalled = true;
                scrollLog('[checkout] interrupt handler reinstalled at cell start | dt=', Date.now() - _coT0, 'ms');
                self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | interrupt handler done | dt=${Date.now() - _coT0}ms`);
            } catch (hdlrErr) {
                self.writeDebugLog(`[CHECKOUT] interrupt handler reinstall failed (non-fatal): ${hdlrErr.message}`);
            }
        } else {
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | interrupt handler reinstall skipped (already installed)`);
        }

        let firstLineNum  = 0;
        let anyAborted    = false;
        let anyMessages   = false;   // true if any kernel message was emitted this cell
        let msgTexts      = [];      // message texts, accumulated for the consolidated AI-context output at cell end
        let _runtimeDiags = [];      // vscode.Diagnostic entries for runtime kernel messages (set after loop)

        // Detect keyboard-initiated execution (set by wolfram.executeCell command).
        // We compare by cell INDEX (number) + notebook reference rather than
        // object identity — VS Code may wrap cells in different proxy objects,
        // making === unreliable across the async execution boundary.
        // hasScrolled ensures we only scroll once — on first output — not on
        // every subsequent print line or result.
        const execCell       = currentExecution.execution.cell;
        const isKeyboardExec = (
            self._pendingScrollCellIndex    !== null &&
            self._pendingScrollCellIndex    === execCell.index &&
            self._pendingScrollCellNotebook === execCell.notebook
        );
        if (isKeyboardExec) {
            self._pendingScrollCellIndex    = null;
            self._pendingScrollCellNotebook = null;
        }
        const execMode  = self._pendingScrollMode || 'advance';

        // ---- Counter-scroll at execution START ----
        // executionQueue.start() triggers VS Code's internal revealRange showing
        // the executing cell.
        // Keyboard advance: counter-scroll the executing cell to AtTop.
        // Keyboard refine:  skip — scroll guard handles it at Idle.
        // Agent execution:  skip — scroll guard also handles it at Idle (no drift check).
        // Agent-abort-pending: suppress to avoid scrolling to the aborted user cell.
        if (!self._agentAbortPending && isKeyboardExec) {
            const _startCell = currentExecution.execution.cell;
            const _startNb   = _startCell.notebook;
            const _startIdx  = _startCell.index;
            const _startMode = execMode;
            scrollLog('[start-reveal] keyboard | mode:', _startMode, '| cell:', _startIdx);

            if (_startMode !== 'refine') {
                const _doStartReveal = (label) => {
                    try {
                        for (const _sed of vscode.window.visibleNotebookEditors) {
                            if (_sed.notebook === _startNb) {
                                const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
                                _sed.revealRange(new RC(_startIdx, _startIdx + 1),
                                                 vscode.NotebookEditorRevealType.AtTop);
                                scrollLog('[start-reveal]', label, 'advance: AtTop cell', _startIdx);
                                break;
                            }
                        }
                    } catch (e) { scrollLog('[start-reveal] error:', e.message); }
                };
                setTimeout(() => _doStartReveal('t=0'),  0);
                setTimeout(() => _doStartReveal('t=16'), 16);
                setTimeout(() => _doStartReveal('t=32'), 32);
                setTimeout(() => _doStartReveal('t=50'), 50);
            } else {
                scrollLog('[start-reveal] refine: skipped — scroll guard handles it');
            }
        } // end counter-scroll block
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
        self._evalDispatched = true;
        // NOTE: _cellEpoch increments at the END of the cell (just before executionQueue.end())
        // so LiveCells counts a cell only after all sub-expressions have finished and
        // all outputs have been committed and are visible.
        // _dispatchEpoch increments per sub-expression (inside the for loop) so that
        // LiveEvaluations counts individual sub-expression dispatches, not cell-level.
        scrollLog('[checkout] _evalDispatched = true | cell', currentExecution.execution.cell.index, '| cellEpoch (pre-cell)', self._cellEpoch);
        self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | _evalDispatched = true`);

        // ---- Evaluate each sub-expression one by one ----
        // Each goes through the interactive kernel main loop → gets its own
        // Out[N]= label and increments $Line.  Rendering is a separate batch
        // sub() call that reads Out[N] without polluting In/Out.
        //
        // _dynEarlyRef: set when a Dynamic widget is started inline (before the
        // cell's remaining sub-expressions run).  Deactivated after execution.end()
        // so the widget switches from replaceOutputItems to createNotebookCellExecution.
        let _dynEarlyRef = null;

        // ---- Helper: build compact, collapsible HTML for kernel warning messages ----
        // Single short message → compact inline div.
        // Single long message (>120 chars or multi-line) → <details> spoiler.
        // Multiple messages → grouped <details> with count in summary.
        const buildMsgGroupHtml = (parts) => {
            const baseStyle =
                'color:#f44;border-left:3px solid #f44;' +
                'background:rgba(255,68,68,0.08);' +
                'padding:2px 6px;margin:1px 0;border-radius:0 3px 3px 0;' +
                'font-family:monospace;font-size:0.85em';
            if (parts.length === 1) {
                const msg = parts[0];
                const escaped = self.escapeHtml(msg);
                const isLong = msg.length > 120 || msg.includes('\n');
                if (isLong) {
                    const preview = self.escapeHtml(msg.split('\n')[0].slice(0, 100));
                    return `<details class="vscode-wolfram-message-output" style="${baseStyle}">` +
                        `<summary style="cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${preview}\u2026</summary>` +
                        `<pre style="margin:4px 0;white-space:pre-wrap;font-size:1em">${escaped}</pre>` +
                        '</details>';
                }
                return `<div class="vscode-wolfram-message-output" style="${baseStyle};white-space:pre-wrap">` +
                    escaped + '</div>';
            }
            // Multiple messages — grouped collapsible block.
            const items = parts.map(msg =>
                '<div style="padding:2px 0 2px 4px;border-top:1px solid rgba(255,68,68,0.15)">' +
                self.escapeHtml(msg) + '</div>'
            ).join('');
            return `<details class="vscode-wolfram-message-output" style="${baseStyle}">` +
                `<summary style="cursor:pointer">${parts.length}\u00a0warnings</summary>` +
                items +
                '</details>';
        };

        for (let i = 0; i < subExprs.length; i++) {
            if (self.isAborting) { anyAborted = true; break; }

            let { text: subExpr, startLine: _subStartLine, endLine: _subEndLine } = subExprs[i];
            // Substitute display-only Unicode operators back to ASCII for the kernel.
            // The formatter renders -> as → (\u2192) and :> as ⧴ (\u29f4).
            subExpr = subExpr.replace(/\u2192/g, '->').replace(/\u29f4/g, ':>');
            scrollLog('[checkout] sub', i, '/', subExprs.length, 'start | cell', currentExecution.execution.cell.index, '| expr:', subExpr.slice(0, 60));
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | sub ${i}/${subExprs.length} start | expr: ${subExpr.slice(0, 80)}`);

            // ---- Skip Dynamic[...] — bypass kernel entirely ----
            // Dynamic slots are rendered by the widget loop; we never send
            // Dynamic[...] to session.evaluate() (it would stall for a FrontEnd).
            // Place a placeholder, and if there are subsequent executable
            // sub-expressions in this same cell, start the widget loop NOW
            // (early-start) so it renders live while those sub-exprs run.
            if (subExpr.startsWith('Dynamic[') && subExpr.endsWith(']')) {
                const _dynInnerText = subExpr.slice('Dynamic['.length, -1);
                const _dynPlaceholder = new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(
                        '<div data-dynamic="1"></div>',
                        'x-application/wolfram-language-html'
                    ),
                    // TODO-1g: initial text/plain so Copilot knows which Dynamic expression this slot holds
                    vscode.NotebookCellOutputItem.text(
                        '(* Dynamic[' + _dynInnerText + '] *)', 'text/plain'
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
                    const _moreDyn   = subExprs.slice(i + 1).some(s => { const t = s.text.trim(); return t.startsWith('Dynamic[') && t.endsWith(']'); });
                    const _hasSubseq = subExprs.slice(i + 1).some(s => { const t = s.text.trim(); return t && !(t.startsWith('(*') && t.endsWith('*)')); });
                    if (!_moreDyn && _hasSubseq) {
                        const _dynExprsEarly = self._splitTopLevelExprs(code).filter(e => e.isDynamic);
                        if (_dynExprsEarly.length > 0) {
                            _dynEarlyRef = { exec: currentExecution.execution, active: true };
                            self._startDynamicCell(execCell, _dynExprsEarly, imgDir, imgRel, _dynEarlyRef);
                        }
                    }
                }
                continue;
            }

            // Skip pure comment sub-expressions entirely — they produce no kernel output
            // and must not count as a dispatch for LiveEvaluations / LiveCells.
            if (/^\(\*[\s\S]*\*\)$/.test(subExpr)) continue;

            // ---- Handle WBInclude["path"] — intercept, convert, insert cells ----
            // Never sent to the kernel; the converter runs out-of-process.
            {
                const _wbm = /^WBInclude\["((?:[^"\\]|\\.)*)"\]$/.exec(subExpr.trim());
                if (_wbm) {
                    const { handleWBInclude } = require('./wb-include');
                    const _execCell   = currentExecution.execution.cell;
                    const _nbDir      = path.dirname(_execCell.notebook.uri.fsPath);
                    const _insertIdx  = _execCell.index;
                    await handleWBInclude(self, _wbm[1], _nbDir, currentExecution, _insertIdx);
                    continue;
                }
            }

            // ---- Handle WBExport[] / WBExport["path"] — save notebook as .nb ----
            // Never sent to the kernel.
            {
                const _wbem = /^WBExport\[(?:"((?:[^"\\]|\\.)*)")?\]$/.exec(subExpr.trim());
                if (_wbem) {
                    const { handleWBExport } = require('./wb-export');
                    const _execCell = currentExecution.execution.cell;
                    const _nbFsPath = _execCell.notebook.uri.fsPath;
                    const _nbDir    = path.dirname(_nbFsPath);
                    await handleWBExport(_wbem[1] || null, _nbDir, _nbFsPath, currentExecution);
                    continue;
                }
            }

            // ---- Handle WBPrompt["prompt"] / WBPrompt["prompt", "wolfbook"->True/False] ----
            // Never sent to the kernel.
            // wolfbook->True  (default): routes through @wolfbook agent.
            // wolfbook->False           : sends the prompt as plain Copilot chat.
            {
                const _wbpm = /^WBPrompt\["((?:[^"\\]|\\.)*)" *(?:, *"wolfbook" *-> *(True|False) *)?\]$/.exec(subExpr.trim());
                if (_wbpm) {
                    const { handleWBPrompt } = require('./wb-prompt');
                    const _execCell = currentExecution.execution.cell;
                    const _useWolfbook = _wbpm[2] !== 'False'; // default true
                    await handleWBPrompt(_wbpm[1], _useWolfbook, currentExecution, _execCell);
                    continue;
                }
            }

            // ---- WB* syntax-error diagnostics ----
            // If an expression starts with a known WB prefix but didn't match any
            // valid pattern above, show a helpful error instead of silently falling
            // through to the kernel (which would return a meaningless symbol error).
            {
                const _wbDiag = {
                    WBInclude: {
                        usage: [
                            'WBInclude["path/to/file.wl"]',
                        ],
                        notes: 'Inserts the contents of a .wl / .m / .wls / .nb file as new cells immediately after this cell.',
                    },
                    WBExport: {
                        usage: [
                            'WBExport[]',
                            'WBExport["path/to/output.nb"]',
                        ],
                        notes: 'Saves the current notebook as a Mathematica .nb file. Without an argument, saves alongside the .wb file.',
                    },
                    WBPrompt: {
                        usage: [
                            'WBPrompt["your task description"]',
                            'WBPrompt["your task description", "wolfbook"->True]',
                            'WBPrompt["your task description", "wolfbook"->False]',
                        ],
                        notes: [
                            '"wolfbook"->True  (default) — routes the prompt through the @wolfbook agent, which has live kernel access and can insert cells.',
                            '"wolfbook"->False — sends the raw prompt to plain Copilot chat.',
                        ].join('<br>'),
                    },
                };
                const _wbKey = Object.keys(_wbDiag).find(k => subExpr.trim().startsWith(k + '['));
                if (_wbKey) {
                    const _d = _wbDiag[_wbKey];
                    const _usageHtml = _d.usage.map(u =>
                        `<code style="background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:12px;">${u.replace(/</g,'&lt;')}</code>`
                    ).join('<br>');
                    const _html =
                        `<div style="font-size:12px;padding:6px 0;">` +
                        `<span style="color:#c00;font-weight:bold;">\u26A0 ${_wbKey}: syntax error</span><br><br>` +
                        `<b>Valid usage:</b><br>${_usageHtml}<br><br>` +
                        `<span style="color:#555;">${_d.notes}</span></div>`;
                    const _plain = `${_wbKey} syntax error.\nValid usage:\n${_d.usage.join('\n')}\n${_d.notes.replace(/<br>/g,'\n').replace(/<[^>]+>/g,'')}`;
                    const _out = new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(_html, 'x-application/wolfram-language-html'),
                        vscode.NotebookCellOutputItem.text(_plain, 'text/plain'),
                    ]);
                    if (currentExecution.hasOutput) {
                        await currentExecution.execution.appendOutput(_out);
                    } else {
                        currentExecution.hasOutput = true;
                        await currentExecution.execution.replaceOutput(_out);
                    }
                    continue;
                }
            }

            // Increment per-sub-expression dispatch epoch.
            // LiveEvaluations tracks individual sub-expression dispatches after the
            // widget started.  Dynamic[...] and pure-comment slots do not count.
            self._dispatchEpoch = (self._dispatchEpoch + 1) & 0xFFFFFF;

            // Per-sub-expression print accumulator
            let printOutput       = null;
            let printHtml         = "";
            let printText         = "";  // plain-text mirror for the AI-readable text/plain MIME item
            const printLineQueue  = [];
            let printFlushPending = false;

            // Per-sub-expression message (warning) accumulator.
            // All kernel warnings for this sub-expression share one output cell,
            // updated in-place as each new message arrives (live grouping).
            let msgOutput    = null;
            const msgHtmlParts = [];

            const flushPrint = async () => {
                if (printLineQueue.length === 0) { printFlushPending = false; return; }
                const packets = printLineQueue.splice(0);
                // Decode \012 → real newlines, then decode Wolfram octal byte escapes → Unicode.
                // Each WSTP TextPacket becomes one <pre> block; internal newlines render
                // as-is so OutputForm ASCII art (e.g. exponents above the line) is preserved.
                const decodedTexts = packets.map(pkt => self.decodeWolframOctal(pkt.replace(/\\012/g, '\n')));
                // If a Print packet is a WL box expression wrapped in BoxData[...] (e.g. from
                // OGRe/packages that use CellPrint falling back to Print in script mode), render
                // it via BTL→KaTeX instead of showing raw box syntax in a <pre>.
                const htmlParts = decodedTexts.map(text => {
                    const t = text.trim();
                    if (t.startsWith('BoxData[') && t.endsWith(']')) {
                        const inner = t.slice(8, -1);                    // strip outer BoxData[…]
                        // WSTP doubles backslashes in text content; un-double them so
                        // InputForm escapes like \" and \[Eta] reach BTL correctly.
                        const unesc = inner.replace(/\\\\/g, '\\');
                        const clean = unesc.replace(/\n\s*>?\s*/g, ' '); // strip Wolfram ">" line-fold markers and collapse whitespace
                        const b64   = Buffer.from(clean).toString('base64');
                        const rawB64 = Buffer.from(t).toString('base64'); // original verbatim string from kernel
                        return `<div class="vscode-wolfram-wllatex-boxes" data-boxes-b64="${b64}" data-raw-b64="${rawB64}"></div>`;
                    }
                    return '<pre class="vscode-wolfram-print-output">' + self.escapeHtml(text) + '</pre>';
                });
                const btlLogPath = path.join(imgDir, 'btl.log');
                const _nbUri_btl = currentExecution.execution.cell.notebook.uri;
                const newHtml = self._processWLLatexBoxes(htmlParts.join(''), btlLogPath, undefined, undefined, undefined, _nbUri_btl);
                const newText = decodedTexts.map(t => t.trim().startsWith('BoxData[') ? '[formula]' : t).join('');
                if (printOutput) {
                    printHtml += newHtml;
                    printText += newText;
                    await currentExecution.execution.replaceOutputItems(
                        [
                            vscode.NotebookCellOutputItem.text(printHtml, "x-application/wolfram-language-html"),
                            vscode.NotebookCellOutputItem.text('Print: ' + printText.trimEnd(), "text/plain")
                        ],
                        printOutput
                    );
                } else {
                    printHtml   = newHtml;
                    printText   = newText;
                    printOutput = new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(printHtml, "x-application/wolfram-language-html"),
                        vscode.NotebookCellOutputItem.text('Print: ' + printText.trimEnd(), "text/plain")
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
            const _subT0 = Date.now();
            const r = await self.session.evaluate(subExpr, {
                onPrint: line => {
                    // Suppress Wolfram's internal scheduling noise — this message
                    // is emitted by $Inspector[] / the ScheduledTask mechanism when
                    // it can't find a safe evaluation window and is not user output.
                    if (line.startsWith('Still waiting for a safe time to evaluate $Inspector')) return;
                    // Suppress the MathLink interrupt menu prompt that Mathematica emits
                    // as TEXTPKT output when ParallelEvaluate/ParallelKernels trigger
                    // a MathLink-level interrupt on a sub-kernel connection. This is
                    // internal kernel communication noise, not user-visible output.
                    if (line.includes('Your options are:') &&
                        (line.includes('interrupt') || line.includes('abort') || line.includes('continue'))) return;
                    printLineQueue.push(line);
                    if (!printFlushPending) {
                        printFlushPending = true;
                        setImmediate(() => flushPrint());
                    }
                },
                // TODO-1e: one individual amber box per message (visible to user);
                // a single consolidated AI-context output is appended after the loop (see below).
                onMessage: async msg => {
                    anyMessages = true;
                    msgTexts.push(msg);
                    // Highlight the source line(s) in the input with a pink background.
                    self.applyRuntimeMsgDecoration(execCell, _subStartLine, _subEndLine);
                    // Register as a VS Code diagnostic so Copilot's "Fix using Copilot" badge appears.
                    // Runtime errors (not syntax errors) are registered here; syntax errors
                    // are intentionally NOT registered (see errors.js) to avoid Copilot deprioritising
                    // kernel errors in favour of UTF / session-usage hints.
                    const _msgRng = new vscode.Range(
                        new vscode.Position(Math.max(0, _subStartLine), 0),
                        new vscode.Position(Math.max(0, _subEndLine), 9999)
                    );
                    const _diag = new vscode.Diagnostic(_msgRng, msg, vscode.DiagnosticSeverity.Error);
                    _diag.source = 'Wolfram Kernel';
                    _runtimeDiags.push(_diag);
                    msgHtmlParts.push(msg);
                    const groupedMsgHtml = buildMsgGroupHtml(msgHtmlParts);
                    const plainMsgText   = msgHtmlParts.join('\n');
                    if (msgOutput) {
                        // Update the existing grouped output in-place.
                        await currentExecution.execution.replaceOutputItems(
                            [
                                vscode.NotebookCellOutputItem.text(groupedMsgHtml, 'x-application/wolfram-language-html'),
                                vscode.NotebookCellOutputItem.text(plainMsgText, 'text/plain'),
                            ],
                            msgOutput
                        );
                    } else {
                        msgOutput = new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(groupedMsgHtml, 'x-application/wolfram-language-html'),
                            vscode.NotebookCellOutputItem.text(plainMsgText, 'text/plain'),
                        ]);
                        if (currentExecution.hasOutput) {
                            await currentExecution.execution.appendOutput(msgOutput);
                        } else {
                            currentExecution.hasOutput = true;  // set BEFORE await — prevents race
                            await currentExecution.execution.replaceOutput(msgOutput);
                        }
                    }
                    printOutput = null;  // next Print starts a fresh block
                },
                onDialogPrint: (line) => {
                    // Feed collector set by openDialogSubsession(); ignore otherwise.
                    if (self._dialogPrintCollector) self._dialogPrintCollector(line);
                },
                // NOTE: onDialogBegin/onDialogEnd intentionally omitted.
                // Passing them sets hasOnDialogBegin=true in C++, which makes
                // it respond 'i' to MENUPKT (idle-kernel interrupt).  On
                // Wolfram 3/ARM64, 'i' to MENUPKT does not open Dialog[] and
                // hangs the evaluate() permanently.  Without these callbacks
                // C++ responds 'c' (continue) — the interrupt is dismissed and
                // the evaluate resolves normally.
                // v0.6.2 safety fallback: any BEGINDLGPKT (e.g. from a stale
                // ScheduledTask after Dynamic teardown) is auto-closed by C++
                // when hasOnDialogBegin=false — no hang, no legacy loop entered.
            });
            scrollLog('[checkout] sub', i, 'done | dt=', Date.now() - _subT0, 'ms | aborted:', r.aborted, '| outputName:', r.outputName || '(none)');
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | sub ${i} done | dt=${Date.now() - _subT0}ms | aborted: ${r.aborted}`);

            const lineN = r.cellIndex;
            if (i === 0 && lineN > 0) firstLineNum = lineN;
            // Force-flush any remaining print lines (synchronous callbacks
            // that fired before any await could yield).
            printFlushPending = false;
            if (printLineQueue.length > 0) await flushPrint();

            if (r.aborted) {
                scrollLog('[checkout] r.aborted received — sub-expr', i, 'cell', currentExecution.execution.cell.index,
                          '| clearing isAborting (' + self.isAborting + ')');
                if (self.logFile !== 'Off') {
                    try { fs.appendFileSync(self.logFile, `[ABORT-PKT] sub ${i} cell ${currentExecution.execution.cell.index} — aborted packet received, clearing isAborting\n`); } catch (_) {}
                }
                self.isAborting = false;
                anyAborted = true;
                // Do not show any output on abort — just stop silently.
                break;
            }

            // ---- Render the result if non-Null (outputName non-empty) ----
            // VsCodeRender[N] reads Out[N] from the kernel's history via a
            // non-interactive evaluate() (EvaluatePacket) on the main kernel queue.
            // rejectDialog: true ensures any BEGINDLGPKT during render is auto-closed
            // by C++, preventing Pattern-C deadlocks without needing _renderingActive.
            if (r.outputName && lineN > 0) {
                // Hoist outputId and placeholder-state before try/catch so catch can access them.
                const outputId = (self._outputIdCounter++).toString();
                let _placeholderShown = false;
                let _placeholderAppended = Promise.resolve();
                let _phTimer = null;
                try {
                    // Resolve format per sub-expression using stable index i.
                    // knownIsGfx is undefined here (we learn it from the rendered HTML),
                    // but resolveFormat already sanitises incompatible combos after render.
                    // Using i guarantees the saved per-output choice is picked up even when
                    // the global Out[N] counter changed on re-evaluation.
                    const subFmt = self._resolveFormat(execCell, undefined, i);

                    // Build placeholder HTML — only shown after 1 s if render is slow.
                    // (MathematicaServer cold-start ~4 s on first SVG; subsequent renders are fast.)
                    const _phOutLabel = `<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;
                    const _phHeaderRow = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" data-session-epoch="${self._sessionEpoch}" data-output-id="${outputId}" data-out-n="${lineN}" data-sub-idx="${i}" data-output-format="${subFmt}" data-output-is-graphics="0">${_phOutLabel}</div>`;
                    const _phHtml = `<div class="wl-output-block">${_phHeaderRow}<div class="wl-output-content"><span style="color:var(--vscode-descriptionForeground,#888);font-style:italic;font-size:12px;">&#8987; Rendering\u2026</span></div></div>`;
                    const _phOut = new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(_phHtml, "x-application/wolfram-language-html")]);
                    // Show placeholder only if render takes >1 s — fast renders skip it entirely.
                    _phTimer = setTimeout(() => {
                        _placeholderShown = true;
                        _placeholderAppended = (
                            currentExecution.hasOutput
                                ? currentExecution.execution.appendOutput(_phOut)
                                : currentExecution.execution.replaceOutput(_phOut).then(() => { currentExecution.hasOutput = true; })
                        );
                    }, 1000);

                    // Helper: replace the placeholder with real content.
                    // Fast path (placeholder never shown): uses normal append/replace.
                    // Slow path (placeholder shown after 1 s): finds by outputId and swaps in-place.
                    const _replacePlaceholder = async (finalItems) => {
                        const finalOut = new vscode.NotebookCellOutput(finalItems);
                        if (_placeholderShown) {
                            const allOuts = [...execCell.outputs];
                            const tgtIdx = allOuts.findIndex(o => {
                                try { return new TextDecoder().decode(o.items[0].data).includes(`data-output-id="${outputId}"`); } catch { return false; }
                            });
                            if (tgtIdx !== -1) {
                                allOuts[tgtIdx] = finalOut;
                                await currentExecution.execution.replaceOutput(allOuts);
                            } else {
                                await currentExecution.execution.appendOutput(finalOut);
                            }
                        } else {
                            if (currentExecution.hasOutput) {
                                await currentExecution.execution.appendOutput(finalOut);
                            } else {
                                await currentExecution.execution.replaceOutput(finalOut);
                                currentExecution.hasOutput = true;
                            }
                        }
                    };

                    scrollLog('[checkout] VsCodeRender start | sub', i, '| lineN', lineN, '| format', subFmt);
                    const _renderT0 = Date.now();
                    const renderResult = await self.session.evaluate(
                        `VsCodeRender[${lineN}, "${subFmt}", ${scale}]`,
                        { interactive: false, rejectDialog: true }
                    );
                    clearTimeout(_phTimer);
                    await _placeholderAppended;  // ensure placeholder append completes before replacing
                    scrollLog('[checkout] VsCodeRender done | dt=', Date.now() - _renderT0, 'ms | ph:', _placeholderShown, '| type:', renderResult?.result?.type);
                    // ---- Forward any messages emitted during the render call ----
                    // e.g. $RecursionLimit::reclim from a recursive Format rule.
                    // In the non-interactive render path these were previously silently
                    // discarded because no onMessage callback was wired.  Now they are
                    // captured in renderResult.messages and shown as amber warning boxes.
                    for (const renderMsg of (renderResult.messages || [])) {
                        // Render-phase messages (e.g. $RecursionLimit::reclim) — amber, compact.
                        const isLong = renderMsg.length > 120 || renderMsg.includes('\n');
                        let renderMsgHtml;
                        if (isLong) {
                            const preview = self.escapeHtml(renderMsg.split('\n')[0].slice(0, 100));
                            renderMsgHtml =
                                '<details class="vscode-wolfram-message-output" style="' +
                                'color:#cc8800;border-left:3px solid #cc8800;' +
                                'background:rgba(204,136,0,0.08);' +
                                'padding:2px 6px;margin:1px 0;border-radius:0 3px 3px 0;' +
                                'font-family:monospace;font-size:0.85em">' +
                                `<summary style="cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}\u2026</summary>` +
                                '<pre style="margin:4px 0;white-space:pre-wrap;font-size:1em">' + self.escapeHtml(renderMsg) + '</pre>' +
                                '</details>';
                        } else {
                            renderMsgHtml =
                                '<div class="vscode-wolfram-message-output" style="' +
                                'color:#cc8800;border-left:3px solid #cc8800;' +
                                'background:rgba(204,136,0,0.08);' +
                                'padding:2px 6px;margin:1px 0;border-radius:0 3px 3px 0;' +
                                'font-family:monospace;font-size:0.85em;white-space:pre-wrap">' +
                                self.escapeHtml(renderMsg) + '</div>';
                        }
                        const msgOut = new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(renderMsgHtml, "x-application/wolfram-language-html"),
                            vscode.NotebookCellOutputItem.text(renderMsg, "text/plain")
                        ]);
                        await currentExecution.execution.appendOutput(msgOut);
                    }

                    if (renderResult?.result?.type === "string" && renderResult.result.value) {
                        const btlLogPath2 = path.join(imgDir, 'btl.log');
                        const _nbUri_btl2 = currentExecution.execution.cell.notebook.uri;
                        let html = self._processWLLatexBoxes(self._fixImageUris(renderResult.result.value), btlLogPath2, undefined, undefined, undefined, _nbUri_btl2);
                        const _subsBadge = _isSubsession
                            ? '<span style="font-size:9px;color:#e8a020;background:rgba(232,160,32,0.12);border:1px solid rgba(232,160,32,0.35);border-radius:3px;padding:1px 5px;margin-right:6px;font-style:italic;">subsession</span>'
                            : '';
                        const outLabel =
                            `${_subsBadge}<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;

                        // Detect skeleton: VsCodeRender sets data-wolfram-is-skeleton="1" when
                        // Shallow[] was applied.  We trust this flag alone — the skeleton chars
                        // (\[LeftSkeleton] U+F761, \[RightSkeleton] U+F762) are inside the
                        // base64-encoded WLLatex box blob and invisible to regex on the HTML string.
                        const isSkeleton = html.includes('data-wolfram-is-skeleton');
                        // outputId was already allocated above (before rendering).
                        // isGfx: read the authoritative marker embedded by VsCodeRender/VsCodeRenderFull,
                        // NOT from CSS classes — those vary by format (WL/TeX/LaTeX have no image classes).
                        const _isGfx = html.includes('vscode-wolfram-gfx-marker');
                        // TODO-1a/1b: extract text/plain for AI context before truncation/wrapping
                        const _plainText = _output.extractPlainText(html, r.outputName, _isGfx, code);
                        // Re-resolve format now that isGfx is known: sanitises
                        // incompatible combos (e.g. WLLatex for a graphics output).
                        // This is the format that was actually rendered (subFmt was
                        // passed to VsCodeRender but the kernel promotes expr-only
                        // formats to SVG for graphics — resolveFormat mirrors that).
                        const _effectiveFmt = self._resolveFormat(execCell, _isGfx, i);
                        self._outputRegistry.set(outputId,
                            { cell: execCell, outN: lineN, subIdx: i, outName: r.outputName, format: _effectiveFmt, isGfx: _isGfx });
                        const headerRow = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" data-session-epoch="${self._sessionEpoch}" data-output-id="${outputId}" data-out-n="${lineN}" data-sub-idx="${i}" data-output-format="${_effectiveFmt}" data-output-is-graphics="${_isGfx ? '1' : '0'}">${outLabel}</div>`;
                        // Graphics outputs are <img src="file.svg/png"/> — tiny HTML that
                        // never needs truncation; applying it would corrupt the tag.
                        // BTL-paged outputs already have their content split into pages;
                        // the full HTML can be large (KaTeX spans) but the user sees only
                        // page 0. Skip the truncation banner in that case.
                        const _btlAlreadyPaged = html.includes('wl-matrix-pager');
                        // Always show the skeleton banner regardless of BTL paging.
                        // _btlAlreadyPaged only blocks raw HTML clipping (which would corrupt the pager structure).
                        if (!_isGfx && (html.length > maxLen || isSkeleton)) {                                const _oid = outputId;
                            // For raw truncation: clip at a safe HTML boundary near maxLen.
                            // Skip clipping when BTL already paginated — pager HTML must stay intact.
                            let displayHtml;
                            if (!_btlAlreadyPaged && html.length > maxLen) {
                                // Find the last closing tag before maxLen to avoid clipping mid-tag/mid-KaTeX
                                let cutAt = maxLen;
                                // Search backwards from maxLen for the last </span> or </div>
                                const searchFrom = html.substring(0, maxLen);
                                const lastClose = Math.max(
                                    searchFrom.lastIndexOf('</span>'),
                                    searchFrom.lastIndexOf('</div>'),
                                    searchFrom.lastIndexOf('</td>'),
                                    searchFrom.lastIndexOf('</tr>')
                                );
                                if (lastClose > maxLen * 0.5) {
                                    cutAt = lastClose + (searchFrom.substring(lastClose).match(/^<\/\w+>/) || [''])[0].length;
                                }
                                displayHtml = html.substring(0, cutAt);
                                // Close any unclosed tags to prevent DOM corruption
                                const openTags = [];
                                const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g;
                                let m2;
                                while ((m2 = tagRe.exec(displayHtml)) !== null) {
                                    const full = m2[0];
                                    if (full.endsWith('/>')) continue; // self-closing
                                    const tagName = m2[1].toLowerCase();
                                    if (full.startsWith('</')) {
                                        // closing tag — pop matching open
                                        for (let j = openTags.length - 1; j >= 0; j--) {
                                            if (openTags[j] === tagName) { openTags.splice(j, 1); break; }
                                        }
                                    } else {
                                        openTags.push(tagName);
                                    }
                                }
                                // Close remaining open tags in reverse order
                                for (let j = openTags.length - 1; j >= 0; j--) {
                                    displayHtml += `</${openTags[j]}>`;
                                }
                            } else {
                                // BTL already paged, or within maxLen but is skeleton — show as-is
                                displayHtml = html;
                            }
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
                                   self.makeTruncationBanner(outputId, bannerLabel);
                            self.truncatedOutputCells.set(_oid,
                                { cell: currentExecution.execution.cell, outN: lineN, shallowBreadth: 500, isSkeleton });
                            self.writeDebugLog(
                                `[CHECKOUT] ${isSkeleton ? 'Skeleton' : 'Truncated'} output OutN=${lineN} OutputID=${_oid}`);
                        } else {
                            html = `<div class="wl-output-block">${headerRow}<div class="wl-output-content">${html}</div></div>`;
                        }

                        const _outItems = [
                            vscode.NotebookCellOutputItem.text(html, "x-application/wolfram-language-html")
                        ];
                        if (_plainText) _outItems.push(vscode.NotebookCellOutputItem.text(_plainText, "text/plain"));
                        scrollLog('[first-output] replacePlaceholder with real content | dt=', Date.now() - _t0, 'ms | cell', currentExecution.execution.cell.index);
                        await _replacePlaceholder(_outItems);
                    } else {
                        // Render returned non-string (most likely $Aborted from
                        // $RecursionLimit::reclim caused by a recursive Format rule,
                        // e.g. Format[x]=Style[x,Red]).  The message was shown above.
                        // Fall back to CheckAbort[ToString[Out[N], InputForm], ...].
                        try {
                            const fallback = await self.session.evaluate(
                                `CheckAbort[ToString[Out[${lineN}], InputForm], "(output unavailable)"]`,
                                { interactive: false, rejectDialog: true }
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
                                `<pre class="vscode-wolfram-text-output">${self.escapeHtml(fbText)}</pre>` +
                                `</div></div>`;
                            await _replacePlaceholder([
                                vscode.NotebookCellOutputItem.text(fbHtml, "x-application/wolfram-language-html"),
                                vscode.NotebookCellOutputItem.text(`${r.outputName} ${fbText}`, "text/plain")
                            ]);
                        } catch (_) {}
                    }
                } catch (renderErr) {
                    clearTimeout(_phTimer);
                    await _placeholderAppended;
                    self.writeDebugLog(
                        `[CHECKOUT] Render error for sub ${i+1}: ${renderErr.message}`);
                    // InputForm fallback
                    try {
                        const fallback = await self.session.evaluate(
                            `ToString[Out[${lineN}], InputForm]`,
                            { interactive: false, rejectDialog: true }
                        );
                        if (fallback?.result?.type === "string" && fallback.result.value) {
                            const outLabel =
                                `<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;
                            const fbHtml =
                                `<div>${outLabel}<pre class="vscode-wolfram-text-output">` +
                                self.escapeHtml(fallback.result.value) + '</pre></div>';
                            const fbItems = [
                                vscode.NotebookCellOutputItem.text(fbHtml, "x-application/wolfram-language-html"),
                                vscode.NotebookCellOutputItem.text(`${r.outputName} ${fallback.result.value}`, "text/plain")
                            ];
                            const fbOut = new vscode.NotebookCellOutput(fbItems);
                            if (_placeholderShown) {
                                const allOuts = [...execCell.outputs];
                                const tgtIdx = allOuts.findIndex(o => {
                                    try { return new TextDecoder().decode(o.items[0].data).includes(`data-output-id="${outputId}"`); } catch { return false; }
                                });
                                if (tgtIdx !== -1) {
                                    allOuts[tgtIdx] = fbOut;
                                    await currentExecution.execution.replaceOutput(allOuts);
                                } else {
                                    await currentExecution.execution.appendOutput(fbOut);
                                }
                            } else {
                                if (currentExecution.hasOutput) {
                                    await currentExecution.execution.appendOutput(fbOut);
                                } else {
                                    await currentExecution.execution.replaceOutput(fbOut);
                                    currentExecution.hasOutput = true;
                                }
                            }
                        }
                    } catch (_) {}
                }
            }
        }

        scrollLog('[checkout] sub-expr loop done | cell', currentExecution.execution.cell.index, '| total dt=', Date.now() - _coT0, 'ms | anyAborted:', anyAborted);
        self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | loop done | dt=${Date.now() - _coT0}ms | aborted: ${anyAborted}`);

        // Race condition: abort fired just as the last sub finished naturally.
        // r.aborted=false (kernel completed before SIGINT took effect), so the
        // abort-packet path never cleared isAborting.  Clear it now so the retry
        // timers in commands.js abort() don't send SIGINTs to the idle kernel
        // (which would trigger the interrupt→Dialog[] handler on a resting kernel).
        if (self.isAborting && !anyAborted) {
            self.writeDebugLog(`[CHECKOUT] cell ${currentExecution.execution.cell.index} | computation beat the abort — clearing isAborting to stop retry SIGINTs`);
            self.isAborting = false;
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
        // setTimeout closure captures a potentially stale self._refineSavedCursor.
        const _savedCursor    = _wasRefine ? self._refineSavedCursor    : null;
        const _savedCursorUri = _wasRefine ? self._refineSavedCursorUri : null;

        // ---- Read viewport-at-execute (captured at Shift+Enter time), then clear it ----
        const _viewportAtExecute = self._pendingViewportAtExecute;
        self._pendingViewportAtExecute = null;

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
        // Refine mode: skip next-cell collapse trick — the scroll guard
        // restores viewport at Idle, so suppressing [n,n+2) is unnecessary.
        if (isKeyboardExec && !_wasRefine) {
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
        self._cellEpoch = (self._cellEpoch + 1) & 0xFFFFFF;
        scrollLog('[checkout-end] execution.end() about to fire — cell', execCell.index,
                  '| wasRefine:', _wasRefine, '| viewportAtExecute:', _viewportAtExecute, '| cellEpoch', self._cellEpoch);
        // Register runtime kernel-message diagnostics so Copilot's "Fix using Copilot"
        // badge appears in the cell editor gutter.  Accumulated above in _runtimeDiags.
        if (_runtimeDiags.length > 0) {
            self.diagnosticCollection.set(currentExecution.execution.cell.document.uri, _runtimeDiags);
        }
        // Append a hidden consolidated error output: wolfram-html sentinel first so our
        // renderer claims the output (user sees nothing) but VS Code still detects the
        // application/vnd.code.notebook.error MIME for the Copilot fix trigger.
        // text/plain carries all messages for Copilot's context window.
        if (anyMessages && !anyAborted) {
            const _combinedMsgs = msgTexts.join('\n');
            await currentExecution.execution.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.text('<span style="display:none"></span>', 'x-application/wolfram-language-html'),
                vscode.NotebookCellOutputItem.text(_combinedMsgs, 'text/plain'),
                vscode.NotebookCellOutputItem.error({ name: 'WolframKernelMessage', message: _combinedMsgs, stack: '' }),
            ]));
        }
        // anyMessages: mark cell as errored so VS Code shows the Copilot AI-fix button
        self.executionQueue.end(currentExecution.id, !anyAborted && !anyMessages);
        self._evalDispatched = false;
        self._evalEndedAt = Date.now();
        // Refresh Global` symbol highlighting once the kernel is idle.
        setTimeout(() => {
            try { require('./global-symbols').updateAll(self).catch(() => {}); } catch (_) {}
        }, 200);
        // Deactivate early-start ref — execution is now closed; subsequent
        // _putAllOutputs calls in the widget switch to createNotebookCellExecution.
        if (_dynEarlyRef) { _dynEarlyRef.active = false; _dynEarlyRef = null; }
        scrollLog('[checkout-end] _evalDispatched = false | execution.end() done');
        self.writeDebugLog(`[CHECKOUT] cell ${execCell.index} | execution.end() done | aborted: ${anyAborted} | messages: ${anyMessages}`);

        // Force-close any Dialog[] that a Dynamic widget cycle may have left open
        // when the main evaluation finished mid-cycle. isDialogOpen can be stale,
        // so call unconditionally whenever dynamic widgets are running.
        if (self._dynamicWidgets && self._dynamicWidgets.size > 0) {
            self.session.closeAllDialogs?.();
        }

        // ---- Dynamic widgets: scan all top-level expressions in the cell ----
        // Supports mixed cells: Dynamic[e1]\n1+1\nDynamic[e2] → 2 widgets + 1 static.
        // Non-Dynamic expressions are already rendered by the kernel; their outputs
        // are preserved in the shared per-cell outputs array and left untouched.
        {
            const _topExprs = self._splitTopLevelExprs(code);
            const _dynExprs = _topExprs.filter(e => e.isDynamic);
            scrollLog('[dyn] splitTopLevel | total exprs:', _topExprs.length,
                '| dynExprs:', _dynExprs.length,
                '| cell.outputs.length:', execCell.outputs.length,
                '| exprs:', _topExprs.map(e => (e.isDynamic ? 'DYN' : 'static') + '[' + e.slotIndex + ']').join(', '));
            if (_dynExprs.length > 0) {
                scrollLog('[dyn] found', _dynExprs.length, 'Dynamic expr(s) — starting cell loop | slots:',
                    _dynExprs.map(d => d.slotIndex + '=' + d.dynInner.slice(0, 20)).join(', '));
                if (!self._dynCells) self._dynCells = new Map();
                // If the widget was early-started (inline, before execution.end()),
                // DON'T restart it — just refresh snapOutputs so it includes all
                // outputs appended by the subsequent sub-expressions (Print/results).
                const _cUri = execCell.document.uri.toString();
                const _earlyState = self._dynamicWidgets && self._dynamicWidgets.get(_cUri);
                if (_earlyState && _earlyState.earlyStart) {
                    const _fullOuts = Array.from(execCell.outputs);
                    self._dynCells.set(_cUri, { cell: execCell, outputs: _fullOuts });
                    _earlyState.refreshSnapshots(_fullOuts);
                } else {
                    self._dynCells.set(execCell.document.uri.toString(),
                        { cell: execCell, outputs: Array.from(execCell.outputs) });
                    self._startDynamicCell(execCell, _dynExprs, imgDir, imgRel, null);
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
        if (isKeyboardExec && !self._agentAbortPending) {
            const _peNb   = execCell.notebook;
            const _peIdx  = execCell.index;
            const _vae    = _viewportAtExecute !== null ? _viewportAtExecute : _peIdx;
            // +1 margin: visibleRanges[0].start returns first FULLY visible cell;
            // partially-visible top cell gives start = cellIndex+1.
            const _cellWasVisible = !_wasRefine || (_vae <= _peIdx + 1);
            scrollLog('[post-end-reveal] cellWasVisible:', _cellWasVisible, '| _vae:', _vae, '| cell:', _peIdx);

            if (_cellWasVisible) {
                if (_wasRefine) {
                    // Refine: scroll guard in scroll/manager.js handles viewport restoration
                    // at Idle time with drift detection — no counter-scrolls needed here.
                    scrollLog('[post-end-reveal] refine: skipped — scroll guard handles it');
                } else {
                    const _doReveal = (label) => {
                        try {
                            for (const ed of vscode.window.visibleNotebookEditors) {
                                if (ed.notebook === _peNb) {
                                    const RangeCtor = vscode.NotebookRange ?? vscode.NotebookCellRange;
                                    // Advance: always AtTop — deterministic pin.
                                    ed.revealRange(new RangeCtor(_peIdx, _peIdx + 1),
                                                   vscode.NotebookEditorRevealType.AtTop);
                                    scrollLog('[post-end-reveal]', label, 'advance: AtTop cell', _peIdx);
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
                }
            } else {
                scrollLog('[post-end-reveal] cell', _peIdx, 'clearly above viewport at execute (_vae=' + _vae + ') — not overriding VS Code scroll');
            }
        }

        // ---- Refine mode: restore selection + edit mode + cursor AFTER execution.end() ----
        // execution.end() causes VS Code to exit edit mode and advance selection to N+1.
        // We restore at t=150ms (after all post-execution processing) + retry at t=400ms.
        // showTextDocument on the cell URI enters edit mode WITHOUT scrolling the viewport
        // (we omit the `selection` option and restore cursor manually afterward).
        if (_wasRefine) {
            scrollLog('[refine-post-end] scheduling restore for cell', _refineIdx);

            const _doRefineRestore = (delay, label) => {
                setTimeout(() => {
                    scrollLog('[refine-post-end]', label, '| cell', _refineIdx);
                    try {
                        // Always fix notebook selection first
                        self._restoreSelection(_refineIdx, _refineNb);

                        if (!_savedCursor) {
                            scrollLog('[refine-post-end]', label, 'no saved cursor — staying in command mode');
                            return;
                        }

                        const _editCell = _refineNb.cellAt(_refineIdx);

                        // If already in edit mode on this cell, just restore cursor
                        const _ae = vscode.window.activeTextEditor;
                        if (_ae && _ae.document.uri.toString() === _editCell.document.uri.toString()) {
                            _ae.selection = _savedCursor;
                            scrollLog('[refine-post-end]', label, 'already in edit mode — cursor restored');
                            return;
                        }

                        // Enter edit mode via showTextDocument (no selection → no revealRange scroll).
                        // Then restore cursor manually on the returned editor.
                        scrollLog('[refine-post-end]', label, 'calling showTextDocument on cell', _refineIdx);
                        vscode.window.showTextDocument(_editCell.document, {
                            preview: false,
                            viewColumn: vscode.ViewColumn.Active,
                        }).then(ed => {
                            if (_savedCursor && ed) {
                                ed.selection = _savedCursor;
                                scrollLog('[refine-post-end]', label, 'cursor restored —',
                                    `anchor(${_savedCursor.anchor.line},${_savedCursor.anchor.character})`,
                                    `active(${_savedCursor.active.line},${_savedCursor.active.character})`);
                            }
                        }, e => {
                            scrollLog('[refine-post-end]', label, 'showTextDocument error:', e?.message);
                        });
                    } catch (e) {
                        scrollLog('[refine-post-end]', label, 'error:', e?.message);
                    }
                }, delay);
            };

            _doRefineRestore(150, 't=150');
            // Retry in case first attempt was overridden by lingering VS Code events
            _doRefineRestore(400, 't=400');
        }

    } catch (err) {
        // ALWAYS reset _evalDispatched — no matter what error occurred, the
        // checkout loop is done and VS Code must return to non-evaluating state.
        self._evalDispatched = false;
        self._evalEndedAt = Date.now();
        scrollLog('[checkout-catch] _evalDispatched = false | err:', err?.message);

        // "Cannot modify cell output after calling resolve" (VS Code ≤ 1.80) or
        // "NotebookCellExecution has been resolved already!" (VS Code ≥ 1.81) or
        // similar — a benign race that occurs when abort/restart clears the execution
        // before output arrives.  Silently ignore — do not write to the Output panel.
        const isResolvedRace = err.message && (
            err.message.includes('Cannot modify cell output after calling resolve') ||
            err.message.includes('resolved already') ||
            err.message.includes('has been resolved')
        );
        if (isResolvedRace) {
            self.executionQueue.end(currentExecution.id, false);
            self.checkoutExecutionQueue();
            return;
        }
        // For all other errors, write to the debug log file only (not the Output panel).
        if (self.logFile !== 'Off') {
            try { fs.appendFileSync(self.logFile, `[CHECKOUT] Fatal error: ${err.message}\n`); } catch (_) {}
        }
        // If the session is broken (link error), mark it dead so user knows to restart.
        // Match actual error strings from the C++ WSTP addon:
        //   "WSTP connection was lost." / "WSTP link error" — from WSErrorMessage()
        //   "Failed to send packet to kernel" / "failed to send EvaluatePacket" — from evaluate_worker / sub workers
        //   "Session is closed" — from JS guard
        const isFatal = err.message && (
            err.message.includes("WSGetFunction") ||
            err.message.includes("WSTP link") ||
            err.message.includes("WSTP connection") ||
            err.message.includes("WSTP error") ||
            err.message.includes("Session is closed") ||
            err.message.includes("WSNextPacket") ||
            err.message.includes("ILLEGALPKT") ||
            err.message.includes("Failed to send") ||
            err.message.includes("failed to send") ||
            err.message.includes("link error") ||
            err.message.includes("pkt=0")
        );
        try {
            await currentExecution.execution.replaceOutput([
                new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(
                        `<div style="color:red;padding:8px;border:1px solid red;border-radius:4px">
                          ${isFatal ? '&#128165; Fatal kernel error — restarting automatically:<br>' : ''}
                          ${self.escapeHtml(err.message)}</div>`,
                        "text/html"
                    )
                ])
            ]);
        } catch (_outputErr) {
            scrollLog('[checkout-catch] replaceOutput failed:', _outputErr?.message);
        }
        self.executionQueue.end(currentExecution.id, false);
        // Drain ALL remaining queued cells — the link is broken, don't attempt them.
        self.executionQueue.clear();
        // If fatal link error — auto-restart the session
        if (isFatal && self.session) {
            self.writeDebugLog("[CHECKOUT] Fatal link error — auto-restarting session");
            vscode.window.showWarningMessage("Kernel link error detected — restarting kernel automatically.");
            self.restartKernel();
            return;  // don't call checkoutExecutionQueue; restartKernel does it after relaunch
        }
        // Non-fatal error: queue already cleared above, nothing more to dequeue.
        return;
    }

    // Normal completion — advance to the next queued cell.
    self.checkoutExecutionQueue();
}

// -----------------------------------------------------------------------
// GC: scan all cell outputs AND markdown source for image paths still live,
// then delete every .svg/.png in imgDir that is not referenced.
// Runs synchronously via Node.js fs — no kernel round-trip, no timing issues.
// Called at the START of each execution, and on notebook cell changes.

function cleanupImgDir(self, notebook, imgDir) {
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
        self.writeDebugLog(`[GC] _cleanupImgDir failed (non-fatal): ${err.message}`);
    }
}

// -----------------------------------------------------------------------

module.exports = { checkoutExecutionQueue, cleanupImgDir };
