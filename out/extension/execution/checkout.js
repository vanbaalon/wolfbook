'use strict';
// execution/checkout.js — checkoutExecutionQueue and _cleanupImgDir.
// Extracted from controller.js. Functions receive `self` (= WolframNotebookKernel) as first arg.

const vscode  = require('vscode');
const path    = require('path');
const fs      = require('fs');
const { scrollLog } = require('../utils/dev-logger');
const _output = require('../output/renderer');

async function checkoutExecutionQueue(self) {
    const currentExecution = self.executionQueue.getNextPendingExecution();
    if (!currentExecution) return;

    // Was this cell queued via openDialogSubsession() on an idle kernel?
    // If so, add the "subsession" badge to every Out[...] label this run.
    const _isSubsession = self._subsessionCellUris.delete(
        currentExecution.execution.cell.document.uri.toString()
    );

    const code = currentExecution.execution.cell.document.getText();

    // Cancel the Dynamic loop for this cell before starting a new execution.
    if (self._dynamicWidgets) {
        const _cUri = currentExecution.execution.cell.document.uri.toString();
        const _prev = self._dynamicWidgets.get(_cUri);
        if (_prev) { _prev.active = false; scrollLog('[dyn] cancelled cell loop for re-execution'); }
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
        self.executionQueue.end(currentExecution.id, false);
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

    self.executionQueue.start(currentExecution.id);
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
        const _startMode = self._pendingScrollMode || 'advance';
        const _startVae  = self._pendingViewportAtExecute;
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
                else if (ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; i++; }
                else if (ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; i++; }
                else if ((ch === "\n" || ch === "\r") && depth === 0 && cDepth === 0) {
                    // potential split point
                    const t = current.trim();
                    if (t.length > 0) parts.push({ text: t, startLine: exprStartLine, endLine: lineNum });
                    current = "";
                    if (ch === "\r" && next === "\n") i++; // CRLF
                    i++;
                    lineNum++;
                    exprStartLine = lineNum;
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
        const maxLen = Number(self.config.get("maxOutputLength") || 105000);

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

        // Wait for any ongoing idle sub() call to finish before starting evaluate().
        // Concurrent sub() + evaluate() on the same WSTP link causes
        // "WSGet out of sequence" / connection-lost errors.
        if (self._dynIdleMutex) await self._dynIdleMutex;

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
            const syntaxResult = await self.session.sub(
                "VsCodeSyntaxCheck[" + JSON.stringify(code) + "]"
            );
            if (syntaxResult && syntaxResult.type === "string" && syntaxResult.value) {
                const syntaxJson = JSON.parse(syntaxResult.value);
                if (syntaxJson.errors && syntaxJson.errors.length > 0) {
                    self.handleSyntaxErrors(currentExecution.execution.cell, syntaxJson.errors);
                }
            }
        } catch (syntaxErr) {
            self.writeDebugLog(`[CHECKOUT] Syntax check error (non-fatal): ${syntaxErr.message}`);
        }

        try {
            await self.session.evaluate(
                `VsCodeSetImgDir["${self.escapeWL(imgDir)}", "${self.escapeWL(imgRel)}"]`,
                { interactive: false }
            );
        } catch (imgDirErr) {
            self.writeDebugLog(`[CHECKOUT] VsCodeSetImgDir failed (non-fatal): ${imgDirErr.message}`);
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
            if (self.isAborting) { anyAborted = true; break; }

            const { text: subExpr, startLine: _subStartLine, endLine: _subEndLine } = subExprs[i];

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
                        '<div style="color:#888;font-style:italic;font-size:12px;padding:4px 0;">' +
                        '⏳ Dynamic — start a computation to see live updates</div>',
                        'x-application/wolfram-language-html'
                    ),
                    // TODO-1g: initial text/plain so Copilot knows which Dynamic expression this slot holds
                    vscode.NotebookCellOutputItem.text(
                        '(* Dynamic[' + _dynInnerText + '] — waiting for computation *)', 'text/plain'
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
            // Increment per-sub-expression dispatch epoch.
            // LiveEvaluations tracks individual sub-expression dispatches after the
            // widget started.  Dynamic[...] and pure-comment slots do not count.
            self._dispatchEpoch = (self._dispatchEpoch + 1) & 0xFFFFFF;

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
                    const text = self.decodeWolframOctal(pkt.replace(/\\012/g, '\n'));
                    return '<pre class="vscode-wolfram-print-output">' + self.escapeHtml(text) + '</pre>';
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
            const r = await self.session.evaluate(subExpr, {
                onPrint: line => {
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
                    const msgHtml = '<div class="vscode-wolfram-message-output" style="'
                        + 'color:#f44;border-left:3px solid #f44;'
                        + 'background:rgba(255,68,68,0.08);'
                        + 'padding:4px 8px;margin:2px 0;border-radius:0 3px 3px 0;'
                        + 'font-family:monospace;white-space:pre-wrap">'
                        + self.escapeHtml(msg) + '</div>';
                    const msgItem = new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(msgHtml, 'x-application/wolfram-language-html'),
                        vscode.NotebookCellOutputItem.text(msg, 'text/plain'),
                    ]);
                    if (currentExecution.hasOutput) {
                        await currentExecution.execution.appendOutput(msgItem);
                    } else {
                        currentExecution.hasOutput = true;  // set BEFORE await — prevents race
                        await currentExecution.execution.replaceOutput(msgItem);
                    }
                    printOutput = null;  // next Print starts a fresh block
                },
                onDialogBegin: (level) => {
                },
                onDialogPrint: (line) => {
                    // Feed collector set by openDialogSubsession(); ignore otherwise.
                    if (self._dialogPrintCollector) self._dialogPrintCollector(line);
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
                self.isAborting = false;
                anyAborted = true;
                // Do not show any output on abort — just stop silently.
                break;
            }

            // ---- Render the result if non-Null (outputName non-empty) ----
            // VsCodeRender[N] reads Out[N] from the kernel's history via a
            // non-interactive evaluate() (EvaluatePacket) on the main kernel queue.
            // _renderingActive blocks Dynamic widget interrupts for the duration.
            if (r.outputName && lineN > 0) {
                self._renderingActive = true;
                try {
                    const renderResult = await self.session.evaluate(
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
                            self.escapeHtml(renderMsg) + '</div>';
                        // TODO-1e: expose render-phase messages to Copilot as text/plain
                        const msgOut = new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(msgHtml, "x-application/wolfram-language-html"),
                            vscode.NotebookCellOutputItem.text(renderMsg, "text/plain")
                        ]);
                        if (currentExecution.hasOutput) {
                            await currentExecution.execution.appendOutput(msgOut);
                        } else {
                            currentExecution.hasOutput = true;
                            await currentExecution.execution.replaceOutput(msgOut);
                        }
                    }

                    if (renderResult?.result?.type === "string" && renderResult.result.value) {
                        let html = self._processWLLatexBoxes(self._fixImageUris(renderResult.result.value));
                        const _subsBadge = _isSubsession
                            ? '<span style="font-size:9px;color:#e8a020;background:rgba(232,160,32,0.12);border:1px solid rgba(232,160,32,0.35);border-radius:3px;padding:1px 5px;margin-right:6px;font-style:italic;">subsession</span>'
                            : '';
                        const outLabel =
                            `${_subsBadge}<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;

                        // Detect skeleton (Short[] applied kernel-side) OR raw truncation
                        const isSkeleton = html.includes('data-wolfram-is-skeleton');
                        // Always generate a unique outputId — needed by format-switch buttons
                        // on ALL outputs (not only truncated ones).
                        const outputId = (self._outputIdCounter++).toString();
                        // isGfx: read the authoritative marker embedded by VsCodeRender/VsCodeRenderFull,
                        // NOT from CSS classes — those vary by format (WL/TeX/LaTeX have no image classes).
                        const _isGfx = html.includes('vscode-wolfram-gfx-marker');
                        // TODO-1a/1b: extract text/plain for AI context before truncation/wrapping
                        const _plainText = _output.extractPlainText(html, r.outputName, _isGfx, code);
                        // Re-resolve format now that isGfx is known: _resolveFormat sanitises
                        // incompatible format/type combos (e.g. WLLatex for a graphics output)
                        // so the header and format-switch buttons always reflect the right set.
                        const _effectiveFmt = self._resolveFormat(execCell, _isGfx);
                        self._outputRegistry.set(outputId,
                            { cell: execCell, outN: lineN, outName: r.outputName, format: _effectiveFmt, isGfx: _isGfx });
                        const headerRow = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" data-session-epoch="${self._sessionEpoch}" data-output-id="${outputId}" data-out-n="${lineN}" data-output-format="${_effectiveFmt}" data-output-is-graphics="${_isGfx ? '1' : '0'}">${outLabel}</div>`;
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
                                   self.makeTruncationBanner(outputId, bannerLabel);
                            self.truncatedOutputCells.set(_oid,
                                { cell: currentExecution.execution.cell, outN: lineN, shortLines: 20, isSkeleton });
                            self.writeDebugLog(
                                `[CHECKOUT] ${isSkeleton ? 'Skeleton' : 'Truncated'} output OutN=${lineN} OutputID=${_oid}`);
                        } else {
                            html = `<div class="wl-output-block">${headerRow}<div class="wl-output-content">${html}</div></div>`;
                        }

                        const _outItems = [
                            vscode.NotebookCellOutputItem.text(html, "x-application/wolfram-language-html")
                        ];
                        if (_plainText) _outItems.push(vscode.NotebookCellOutputItem.text(_plainText, "text/plain"));
                        const outObj = new vscode.NotebookCellOutput(_outItems);
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
                            const fallback = await self.session.evaluate(
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
                                `<pre class="vscode-wolfram-text-output">${self.escapeHtml(fbText)}</pre>` +
                                `</div></div>`;
                            const fbOut = new vscode.NotebookCellOutput([
                                vscode.NotebookCellOutputItem.text(fbHtml, "x-application/wolfram-language-html"),
                                vscode.NotebookCellOutputItem.text(`${r.outputName} ${fbText}`, "text/plain")
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
                    self.writeDebugLog(
                        `[CHECKOUT] Render error for sub ${i+1}: ${renderErr.message}`);
                    // InputForm fallback
                    try {
                        const fallback = await self.session.evaluate(
                            `ToString[Out[${lineN}], InputForm]`,
                            { interactive: false }
                        );
                        if (fallback?.result?.type === "string" && fallback.result.value) {
                            const outLabel =
                                `<span style="font-size:10px;color:#888;margin-right:8px;">${r.outputName}</span>`;
                            const fbHtml =
                                `<div>${outLabel}<pre class="vscode-wolfram-text-output">` +
                                self.escapeHtml(fallback.result.value) + '</pre></div>';
                            const fbOut = new vscode.NotebookCellOutput([
                                vscode.NotebookCellOutputItem.text(fbHtml, "x-application/wolfram-language-html"),
                                vscode.NotebookCellOutputItem.text(`${r.outputName} ${fallback.result.value}`, "text/plain")
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
                    self._renderingActive = false;
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
        // Deactivate early-start ref — execution is now closed; subsequent
        // _putAllOutputs calls in the widget switch to createNotebookCellExecution.
        if (_dynEarlyRef) { _dynEarlyRef.active = false; _dynEarlyRef = null; }
        scrollLog('[checkout-end] _evalDispatched = false | execution.end() done');

        // Force-close any Dialog[] that a Dynamic widget cycle may have left open
        // when the main evaluation finished mid-cycle. isDialogOpen can be stale,
        // so call unconditionally whenever dynamic widgets are running.
        if (self._dynamicWidgets && self._dynamicWidgets.size > 0) {
            self.session.closeAllDialogs?.();
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
                self._restoreSelection(_refineIdx, _refineNb);

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
            self.executionQueue.end(currentExecution.id, false);
            self.checkoutExecutionQueue();
            return;
        }
        // For all other errors, write to the debug log file only (not the Output panel).
        if (self.logFile !== 'Off') {
            try { fs.appendFileSync(self.logFile, `[CHECKOUT] Fatal error: ${err.message}\n`); } catch (_) {}
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
                      ${self.escapeHtml(err.message)}</div>`,
                    "text/html"
                )
            ])
        ]);
        self.executionQueue.end(currentExecution.id, false);
        // If fatal link error — auto-restart the session
        if (isFatal && self.session) {
            self.writeDebugLog("[CHECKOUT] Fatal link error — auto-restarting session");
            vscode.window.showWarningMessage("Kernel link error detected — restarting kernel automatically.");
            self.restartKernel();
            return;  // don't call checkoutExecutionQueue; restartKernel does it after relaunch
        }
    }

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
