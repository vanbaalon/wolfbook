'use strict';
/**
 * debugController.js  —  Stage 5
 *
 * Helper: map 0-based breakpoint lines to kernel {depth, localStep} strings,
 * using only the DEEPEST step covering each line so that a line inside a loop
 * body doesn't also fire the enclosing Do/For/While step.
 * Deduplicates by {depth, localStep} so the same step isn't listed twice.
 */
function _bpLinesToKernelSteps(lines, steps) {
    const seen = new Set();
    const result = [];
    for (const line of lines) {
        // Collect all steps whose [startLine, endLine] range covers this line
        const covering = steps.filter(s => s.startLine <= line && line <= s.endLine);
        if (!covering.length) continue;
        // Pick the deepest (most-specific) match — avoids firing the outer loop step
        const deepest = covering.reduce((best, s) => s.depth > best.depth ? s : best);
        const key = `${deepest.depth}:${deepest.localStep}`;
        if (!seen.has(key)) { seen.add(key); result.push(`{${deepest.depth}, ${deepest.localStep}}`); }
    }
    return result;
}

/**
 * debugController.js  —  Stage 5
 *
 * Orchestrates the full debug session using the C++ addon Dialog[] API:
 *   session.isDialogOpen, session.dialogEval(), session.exitDialog()
 *   session.evaluate(code, { onDialogBegin, onDialogEnd })
 *
 * Flow per debug session:
 *   startDebugCell()
 *     → load kernelDebugInit.wl (reset kernel state)
 *     → evaluate(instrumentedCode) asynchronously — kernel pauses at Dialog[]
 *     → onDialogBegin fires → query step info → update UI → wait for step cmd
 *   stepOver/stepInto/stepOut/continueRun/runToEnd()
 *     → dialogEval(wolfbookDebug$StepXxx[]) → exitDialog()
 *     → kernel runs to next Dialog[] → onDialogBegin fires again
 *   stop()    → abortEvaluation() → _finishDebug()
 *   _finishDebug()
 *     → query all timings → apply timing decorations → clear yellow highlight
 */
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const { scrollLog } = require('../utils/dev-logger');

// ─── WExpr helpers ────────────────────────────────────────────────────────────

function _wHead(w)  { return w?.type === 'function' ? (typeof w.head === 'string' ? w.head : (w.head?.value ?? null)) : null; }
function _wArgs(w)  { return w?.type === 'function' ? (w.args || []) : []; }
function _wVal(w)   {
    if (!w) return null;
    if (w.type === 'integer' || w.type === 'real') return w.value;
    if (w.type === 'string' || w.type === 'symbol') return w.value;
    return null;
}

/** Recursively convert a WExpr to a plain JS value.
 * Association → Object, List → Array, Rule → {key, val},
 * primitives → their JS equivalents. */
function wexprToJs(w) {
    if (!w) return null;
    const head = _wHead(w);
    const args = _wArgs(w);
    if (head === 'Association') {
        const obj = {};
        for (const rule of args) {
            if (_wHead(rule) === 'Rule' || _wHead(rule) === 'RuleDelayed') {
                const [k, v] = _wArgs(rule);
                obj[_wVal(k) ?? _wHead(k)] = wexprToJs(v);
            }
        }
        return obj;
    }
    if (head === 'List')    return args.map(wexprToJs);
    if (head === 'Missing') return null;
    if (head === 'Rule' || head === 'RuleDelayed') {
        const [k, v] = args;
        return { key: wexprToJs(k), val: wexprToJs(v) };
    }
    if (w.type === 'integer' || w.type === 'real') return w.value;
    if (w.type === 'string') return w.value;
    if (w.type === 'symbol') {
        if (w.value === 'True')     return true;
        if (w.value === 'False')    return false;
        if (w.value === 'Null')     return null;
        if (w.value === 'Infinity' || w.value === 'ComplexInfinity') return Infinity;
        return w.value;
    }
    return null;
}

/** Simple HTML escaper for debug output. */
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format seconds as μs / ms / s string. */
function formatTiming(sec) {
    if (sec == null) return null;
    if (sec < 0.000001) return (sec * 1e9).toFixed(0) + ' ns';
    if (sec < 0.001)    return (sec * 1e6).toFixed(1) + ' μs';
    if (sec < 1)        return (sec * 1e3).toFixed(2) + ' ms';
    return sec.toFixed(3) + ' s';
}

// ─── DebugController ──────────────────────────────────────────────────────────

class DebugController {
    /**
     * @param {() => import('../controller').WolframNotebookKernel} getController
     * @param {import('./breakpointManager').BreakpointManager}     breakpointMgr
     * @param {import('./watchPanel').WatchPanelProvider}            watchPanel
     */
    constructor(getController, breakpointMgr, watchPanel) {
        this._getController  = getController;
        this._bpMgr          = breakpointMgr;
        this._watchPanel     = watchPanel;

        // Active session state
        this._active         = false;
        this._cell           = null;     // vscode.NotebookCell
        this._xfm            = null;     // transformCode() result
        this._evalPromise    = null;     // Promise for the running evaluation
        this._lastStepInfo   = null;     // { depth, localStep, iterVars } from last _onDialogBegin
        this._cellEditor     = null;     // saved TextEditor — avoids losing it after eval completes
        this._debugExecution = null;     // NotebookCellExecution for output/print capture
        this._debugPrintHtml = '';       // accumulated print HTML for current print block
        this._debugPrintOut  = null;     // current vscode.NotebookCellOutput for print
        this._restartPending = false;    // debounce cell-edit restart
        this._stopping       = false;    // set by stop() to suppress auto-advance

        // DAP adapter events
        this._onDidPause  = new vscode.EventEmitter();
        this.onDidPause   = this._onDidPause.event;   // fires { reason }
        this._onDidFinish = new vscode.EventEmitter();
        this.onDidFinish  = this._onDidFinish.event;  // fires void

        this._pauseCount      = 0;   // reset in startDebugCell, incremented per _onDialogBegin
        this._lastStepCommand = null; // 'step' | 'continue' | 'runToEnd' — last command type
        this._lastWatchValues = [];  // [{name, short, full}] from last _onDialogBegin
        this._watchDocMap        = new Map(); // varName → TextDocument for open-in-editor live update
        this._liveWatchInFlight      = false;    // prevents overlapping refreshLiveWatch calls

        // Clean up _watchDocMap entries when the user closes a tracked document
        vscode.workspace.onDidCloseTextDocument(doc => {
            for (const [name, d] of this._watchDocMap) {
                if (d.uri.toString() === doc.uri.toString()) { this._watchDocMap.delete(name); break; }
            }
        });

        // Shared serial queue for ALL dialogEval calls (from this controller AND
        // from the DAP adapter's _onEvaluate).  The kernel Dialog subsession is
        // single-threaded; concurrent evals corrupt the WSTP packet stream.
        this._evalQueue = Promise.resolve();

        // Decoration types (created once, reused)
        this._stepHighlight  = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
        });
        this._timingDeco     = vscode.window.createTextEditorDecorationType({
            after: {
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                fontStyle: 'italic',
                margin: '0 0 0 2em',
            },
        });
        this._pendingDeco    = vscode.window.createTextEditorDecorationType({
            after: {
                contentText: '  ⏳',
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                margin: '0 0 0 2em',
            },
        });

        // Map of "depth:localStep" → timing string (persists until cell edit or new session)
        this._timingMap      = new Map();
        this._timingCellUri  = null;

        // Set up timing clear on cell edit; also stop+offer-restart if debugging
        vscode.workspace.onDidChangeTextDocument(ev => {
            const evUri = ev.document.uri.toString();
            if (this._timingCellUri && evUri === this._timingCellUri) {
                this._clearTimings();
            }
            if (this._active && this._cell && evUri === this._cell.document.uri.toString()) {
                this._stopAndOfferRestart();
            }
        });

        // Wire watch panel callbacks
        if (watchPanel) {
            watchPanel.setCallbacks(
                name => { if (this._active) this._refreshWatchAfterAdd(name); else this.refreshLiveWatch(); this._saveWatchToNotebook(this._watchPanel.getWatchList()); },
                name => { if (this._active) this._refreshWatchPanel(); else this.refreshLiveWatch(); this._saveWatchToNotebook(this._watchPanel.getWatchList()); },
                ()   => this.refreshLiveWatch(),
                cmd  => this._handleDebugCommand(cmd),
                (uri, line) => {
                    // Remove via native VS Code API so native dots also disappear;
                    // onDidChangeBreakpoints will sync the removal back to _bpMgr.
                    const toRemove = vscode.debug.breakpoints.filter(bp =>
                        bp instanceof vscode.SourceBreakpoint &&
                        bp.location.uri.toString() === uri &&
                        bp.location.range.start.line === line
                    );
                    if (toRemove.length) vscode.debug.removeBreakpoints(toRemove);
                    else this._bpMgr.removeBreakpointLine(uri, line); // fallback
                },
                ()          => {
                    // Remove all native breakpoints on notebook-cell URIs
                    const toRemove = vscode.debug.breakpoints.filter(bp =>
                        bp instanceof vscode.SourceBreakpoint &&
                        bp.location.uri.scheme === 'vscode-notebook-cell'
                    );
                    if (toRemove.length) vscode.debug.removeBreakpoints(toRemove);
                    this._bpMgr.clearAllBreakpoints();
                },
            );
            watchPanel.setOnOpenInEditor((name, fullVal) => this._openWatchInEditor(name, fullVal));
            // Keep watch panel breakpoint list in sync whenever bps change
            this._bpMgr.setOnChange(() => {
                watchPanel.updateBreakpoints(this._bpMgr.getAllBreakpoints());
                // NOTE: do NOT push breakpoints to kernel here.
                // _onSetBreakpoints and _onDialogBegin handle kernel pushes
                // via _evalQueue.  A direct dialogEval here would race with
                // the queue and corrupt the WSTP packet stream.
            });
        }

        // Periodic live refresh (every 2 s when not debugging and watch list non-empty)
        this._liveRefreshTimer = setInterval(() => {
            if (!this._active && this._watchPanel?.getWatchList().length > 0) {
                this.refreshLiveWatch();
            }
        }, 2000);

        // Restore watch list from active notebook when switching notebooks
        vscode.window.onDidChangeActiveNotebookEditor(editor => {
            if (editor?.notebook) this._loadWatchFromNotebook(editor.notebook);
            else if (this._watchPanel && !this._active) {
                this._watchPanel.setWatchList([]);
                this.refreshLiveWatch();
            }
        });
        // Initial load from currently active notebook
        setTimeout(() => {
            const nb = vscode.window.activeNotebookEditor?.notebook;
            if (nb) this._loadWatchFromNotebook(nb);
        }, 600);
    }

    get isActive() { return this._active; }
    get lastWatchValues() { return this._lastWatchValues || []; }

    /** Open a watch variable's full value in a temporary untitled editor.
     *  The document is tracked in _watchDocMap so live watch updates its content. */
    async _openWatchInEditor(name, fullVal) {
        const content = fullVal || `(* no value for ${name} *)`;
        try {
            const doc = await vscode.workspace.openTextDocument({ content, language: 'wolfram' });
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
            this._watchDocMap.set(name, doc);
        } catch (err) {
            vscode.window.showErrorMessage('Could not open value in editor: ' + String(err));
        }
    }

    /** Update content of any editors opened via ⧉ when live watch refreshes. */
    async _updateWatchDocuments(variables) {
        if (!this._watchDocMap.size) return;
        for (const [name, doc] of [...this._watchDocMap]) {
            if (!vscode.workspace.textDocuments.some(d => d.uri.toString() === doc.uri.toString())) {
                this._watchDocMap.delete(name); continue;
            }
            const v = variables.find(v => v.name === name);
            if (!v) continue;
            const newContent = v.fullVal || v.shortVal || '';
            if (!newContent || newContent === doc.getText()) continue;
            try {
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.toString() === doc.uri.toString());
                if (!editor) continue;
                await editor.edit(editBuilder => {
                    const lastLine = doc.lineCount - 1;
                    editBuilder.replace(
                        new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).text.length),
                        newContent);
                });
            } catch (_) {}
        }
    }

    /** Save the current watch list to the active notebook's metadata. */
    async _saveWatchToNotebook(watchList) {
        const nb = vscode.window.activeNotebookEditor?.notebook;
        if (!nb) return;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.set(nb.uri, [vscode.NotebookEdit.updateNotebookMetadata(
                Object.assign({}, nb.metadata, { wolfbookWatchList: watchList })
            )]);
            await vscode.workspace.applyEdit(edit);
        } catch (_) { /* non-critical — metadata save is best-effort */ }
    }

    /** Load the watch list from a notebook's metadata and restore it in the panel. */
    _loadWatchFromNotebook(nb) {
        const list = nb?.metadata?.wolfbookWatchList;
        if (!this._watchPanel) return;
        const newList = Array.isArray(list) ? list : [];
        const currentList = this._watchPanel.getWatchList();
        // Only update if actually different (avoids flicker on focus without change)
        if (JSON.stringify(newList) === JSON.stringify(currentList)) return;
        this._watchPanel.setWatchList(newList);
        if (!this._active) this.refreshLiveWatch();
    }

    /** Parse a raw WExpr (from dialogEval or evaluate) and push to the watch panel.
     *
     *  The watch expression uses ExportString[..., "JSON"] so the result is always
     *  a WL String containing the JSON.  In menuDlgProto (interrupt-based) dialogs
     *  the WSTP backend returns TextPacket content as {type:'string'} — we JSON.parse
     *  that directly.  In the idle evaluate() path the ReturnPacket payload is also
     *  a WL String (type:'string').  Either way JSON.parse works. */
    _applyWatchWexpr(wl, raw) {
        scrollLog('[live-watch] _applyWatchWexpr | raw.type:', raw?.type, '| raw.value truthy:', !!raw?.value,
            '| raw.value repr:', JSON.stringify(String(raw?.value ?? '').slice(0, 120)));
        if (!raw) { scrollLog('[live-watch] _applyWatchWexpr: raw is null/undefined — abort'); return 0; }
        const { decodeWstpText } = require('../utils/encoding');
        let parsed = {};
        let parseErr = null;
        if (raw.type === 'string' && raw.value) {
            // Decode ALL WSTP octal escapes (\NNN) back to the actual characters.
            // This handles \012 (newline) and \011 (tab) from JSON formatting,
            // \042 (") and \134 (\) from string values containing quotes/backslashes,
            // and multi-byte UTF-8 sequences for Unicode symbols.
            const decoded = decodeWstpText(raw.value);
            // The decoded string is now proper JSON with real newlines/tabs as whitespace
            // — JSON.parse handles those natively.
            scrollLog('[live-watch] decoded JSON (first 200):', JSON.stringify(decoded.slice(0, 200)));
            try { parsed = JSON.parse(decoded); }
            catch (e) {
                parseErr = e.message;
                // Extract position from error message and dump surrounding chars
                const posMatch = parseErr.match(/position (\d+)/);
                if (posMatch) {
                    const pos = parseInt(posMatch[1]);
                    const start = Math.max(0, pos - 40);
                    const end = Math.min(decoded.length, pos + 40);
                    scrollLog('[live-watch] JSON error at pos', pos,
                        '| char code:', decoded.charCodeAt(pos),
                        '| context:', JSON.stringify(decoded.slice(start, end)),
                        '| ← pos marker at offset', pos - start);
                }
                scrollLog('[live-watch] FULL decoded JSON:', JSON.stringify(decoded));
            }
            scrollLog('[live-watch] JSON.parse ok:', parseErr == null,
                '| keys:', Object.keys(parsed).join(', ') || '(none)',
                parseErr ? '| ERROR: ' + parseErr : '');
        } else if (!raw.value) {
            scrollLog('[live-watch] _applyWatchWexpr: raw.value is falsy (empty string or missing) — type:', raw.type);
        } else {
            scrollLog('[live-watch] _applyWatchWexpr: non-string type, using wexprToJs fallback | type:', raw.type);
            // Fallback: WExpr Association (BEGINDLGPKT / future path)
            const j = wexprToJs(raw);
            if (j && typeof j === 'object' && !Array.isArray(j)) parsed = j;
            scrollLog('[live-watch] wexprToJs result keys:', Object.keys(parsed).join(', ') || '(none)');
        }
        const variables = wl.map(name => {
            const vals = parsed[name];
            scrollLog('[live-watch] var', JSON.stringify(name),
                '| found in parsed:', vals != null,
                '| vals type:', typeof vals,
                '| vals:', JSON.stringify(vals)?.slice(0, 80));
            if (vals == null) return null;
            const shortVal = (typeof vals === 'object') ? String(vals['short'] ?? '?') : String(vals);
            const fullVal  = (typeof vals === 'object') ? String(vals['full']  ?? '?') : String(vals);
            scrollLog('[live-watch] var', JSON.stringify(name), '→ shortVal:', JSON.stringify(shortVal), '| fullVal:', JSON.stringify(fullVal));
            return { name, shortVal, fullVal, isWatch: true };
        }).filter(Boolean);
        scrollLog('[live-watch] resolved', variables.length, '/', wl.length,
            '| rendered:', variables.map(v => v.name + '=' + JSON.stringify(v.shortVal)).join(', '));
        if (variables.length > 0) {
            this._watchPanel.liveUpdate(variables);
            this._updateWatchDocuments(variables).catch(() => {});
        }
        return variables.length;
    }

    async refreshLiveWatch() {
        if (this._active || !this._watchPanel) return;
        const wl = this._watchPanel.getWatchList();
        if (wl.length === 0) { this._watchPanel.liveUpdate([]); return; }

        const ctrl = this._getController();
        if (!ctrl?.session) {
            this._watchPanel.liveUpdate(wl.map(n => ({ name: n, shortVal: '—', fullVal: 'No kernel', isWatch: true })));
            return;
        }

        // Build expression: wrap in ExportString JSON so the result always comes back
        // as a plain string we can JSON.parse — works in both menuDlgProto (TextPacket)
        // and idle evaluate() (ReturnPacket WL String) paths.
        const wlEntries = wl.map(n => {
            const sym = n.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `"${sym}" -> <|"short" -> ToString[${n}, OutputForm], "full" -> ToString[${n}, InputForm]|>`;
        }).join(', ');
        const wlExpr = `ExportString[<|${wlEntries}|>, "JSON"]`;

        // Always keep ctrl._liveWatchExpr + _liveWatchCallback up to date so the
        // Dynamic loop (if active) can piggyback and evaluate watch vars in its dialog.
        ctrl._liveWatchExpr     = wlExpr;
        ctrl._liveWatchCallback = (raw) => this._applyWatchWexpr(wl, raw);

        const kernelBusy    = !!(ctrl.executionQueue?.queue?.length > 0 && !ctrl._abortPending);
        const dynActive     = !!(ctrl._dynamicWidgets?.size > 0);

        scrollLog('[live-watch] cycle | busy:', kernelBusy, '| dynActive:', dynActive,
            '| dispatched:', ctrl._evalDispatched, '| dlgOpen:', ctrl.session.isDialogOpen);

        if (kernelBusy && dynActive) {
            // Dynamic loop is running — it will pick up _liveWatchExpr via the
            // C++ registry on the next getDynamicResults() poll cycle (~300 ms).
            // No separate interrupt needed.
            scrollLog('[live-watch] deferring to Dynamic loop (dynActive) — no interrupt');
            return;
        }

        // ── Both busy and idle paths use subAuto() ──
        // subAuto() auto-routes: idle → subWhenIdle (immediate), busy → C++
        // ScheduledTask Dialog inline eval — no interrupt/SIGINT needed, so
        // long-running computations like Do[...; Pause[1], {n,1,8}] are never
        // broken by the watch panel.
        if (this._liveWatchInFlight) return;
        // Stop hammering a dead link — after 3 consecutive errors, give up until
        // the kernel is restarted (which resets _liveWatchConsecErrors via _cleanup).
        if ((this._liveWatchConsecErrors || 0) >= 3) {
            scrollLog('[live-watch] suppressed — link appears dead (' + this._liveWatchConsecErrors + ' consecutive errors)');
            return;
        }
        // Skip if a Dynamic loop's subAuto is still in-flight at the C++ level.
        // Overlapping idle-path subAuto calls can corrupt the WSTP link state.
        if (ctrl._subAutoLock) return;
        // Post-eval cooldown: C++ stale Dialog drain after busy evals can leave
        // the WSTP link broken.  Skip subAuto for 3s after eval ends.
        if (ctrl._evalEndedAt && (Date.now() - ctrl._evalEndedAt) < 3000) return;
        this._liveWatchInFlight = true;
        const _cppPromise = ctrl.session.subAuto(wlExpr);
        ctrl._subAutoLock = _cppPromise;
        _cppPromise.finally(() => {
            if (ctrl._subAutoLock === _cppPromise) ctrl._subAutoLock = null;
        });
        try {
            scrollLog('[live-watch] subAuto | busy:', kernelBusy);
            const result = await Promise.race([
                _cppPromise,
                new Promise((_, rej) => setTimeout(() => rej(new Error('watch-timeout')), 6000))
            ]);
            scrollLog('[live-watch] subAuto result type:', result?.type);
            this._applyWatchWexpr(wl, result);
            this._liveWatchConsecErrors = 0;  // success — reset counter
        } catch (err) {
            scrollLog('[live-watch] subAuto ERROR:', err.message);
            this._liveWatchConsecErrors = (this._liveWatchConsecErrors || 0) + 1;
            this._watchPanel.liveUpdate(wl.map(n => ({ name: n, shortVal: '⚠', fullVal: String(err), isWatch: true })));
        } finally {
            this._liveWatchInFlight = false;
        }
    }

    // ── Public entry point ──────────────────────────────────────────────────

    async startDebugCell(cell) {
        if (this._active) {
            vscode.window.showWarningMessage('Debug session already active. Stop the current session first.');
            return;
        }
        const ctrl = this._getController();
        if (!ctrl?.session) {
            vscode.window.showErrorMessage('No kernel session. Launch the kernel first.');
            return;
        }
        if (!cell || cell.kind !== vscode.NotebookCellKind.Code) {
            vscode.window.showInformationMessage('Select a code cell to debug.');
            return;
        }

        const code = cell.document.getText().trim();
        const { transformCode } = require('./codeTransformer');
        const bpLines = [...this._bpMgr.getBreakpointsForCell(cell)];
        scrollLog('[wolfbook-debug] startDebugCell: cellUri=', cell.document.uri.toString(), 'bpLines=', bpLines);
        const xfm = transformCode(code, bpLines);
        if (!xfm) {
            vscode.window.showInformationMessage('Cell is empty — nothing to debug.');
            return;
        }

        this._cell           = cell;
        this._xfm            = xfm;
        this._active         = true;
        this._timingMap      = new Map();
        this._timingCellUri  = cell.document.uri.toString();
        this._pauseCount     = 0;
        this._lastStepCommand = null;
        this._lastWatchValues = [];

        // Clear live-watch piggyback registration — debug session will use its own dialog
        if (ctrl._liveWatchCallback) { ctrl._liveWatchCallback = null; ctrl._liveWatchExpr = null; }

        // Save the cell's TextEditor NOW while it's guaranteed visible
        const _cellUri = cell.document.uri.toString();
        this._cellEditor = vscode.window.visibleTextEditors.find(
            ed => ed.document.uri.toString() === _cellUri
        ) || null;

        // Create a NotebookCellExecution so Print/Message output appears in the cell
        this._debugPrintHtml = '';
        this._debugPrintOut  = null;
        try {
            this._debugExecution = ctrl._controller?.createNotebookCellExecution?.(cell) ?? null;
            if (this._debugExecution) {
                this._debugExecution.start(Date.now());
                this._debugExecution.clearOutput();
                // Wire the × cancel button on the cell to stop the debug session
                this._debugExecution.token.onCancellationRequested(() => {
                    if (this._active) this.stop();
                });
            }
        } catch (_) {
            this._debugExecution = null;
        }

        vscode.commands.executeCommand('setContext', 'wolfbook.debugActive', true);
        if (this._watchPanel) this._watchPanel.setDebugActive(true);
        if (this._watchPanel) this._watchPanel.log('Starting debug session…');
        scrollLog('[wolfbook-debug] startDebugCell: active, steps=', xfm.steps.length);

        // ── Step 1: reset kernel-side debug state
        // First, close any stale Dialog[] from a previous crashed session.
        if (ctrl.session.isDialogOpen) {
            scrollLog('[wolfbook-debug] stale dialog open — closing before init');
            if (this._watchPanel) this._watchPanel.log('⚠ Closing stale dialog…');
            try { await ctrl.session.exitDialog(); } catch (_) {}
        }
        // Load the init file via WL Get[] so the kernel reads it directly —
        // avoids any string-escaping issues with large inline file content.
        const initWlPath = path.join(__dirname, 'kernelDebugInit.wl').replace(/\\/g, '/');
        const getExpr = `Get["${initWlPath}"]`;
        scrollLog('[wolfbook-debug] loading kernelDebugInit from:', initWlPath);
        try {
            await ctrl.session.evaluate(getExpr, { interactive: false });
        } catch (err) {
            this._cleanup();
            const msg = err?.message || String(err);
            scrollLog('[wolfbook-debug] init evaluate failed:', err?.message);
            if (this._watchPanel) this._watchPanel.log('✗ init failed: ' + msg);
            vscode.window.showErrorMessage('Debug init failed: ' + msg);
            return;
        }

        // ── Step 2: push watch list and breakpoints into kernel
        const wl = this._watchPanel ? this._watchPanel.getWatchList() : [];
        const bpSteps = _bpLinesToKernelSteps(bpLines, xfm.steps);
        scrollLog('[wolfbook-debug] startDebugCell: bpSteps=', bpSteps, '| steps=', xfm.steps.length);
        const initState = [
            `wolfbookDebug$WatchList = {${wl.map(n => `"${n}"`).join(', ')}}`,
            `wolfbookDebug$Breakpoints = {${bpSteps.join(', ')}}`,
        ].join(';\n');
        try {
            await ctrl.session.evaluate(initState, { interactive: false });
        } catch (_) {}

        // ── Step 3: fire the instrumented cell asynchronously
        // CRITICAL: disable Dynamic-widget auto-mode so BEGINDLGPKT from
        // wolfbookDebug$BeforeStep's Dialog[] reaches the onDialogBegin callback
        // instead of being auto-closed by the C++ inline eval path.
        // If a live-watch ScheduledTask was active, it had set dynAutoMode_=true;
        // setDynAutoMode(false) resets it and stops the timer thread.
        try { ctrl.session?.setDynAutoMode?.(false); } catch (_) {}
        this._evalPromise = ctrl.session.evaluate(xfm.instrumentedCode, {
            onDialogBegin: () => { this._onDialogBegin().catch(e => console.error('[debug] onDialogBegin error:', e)); },
            onDialogEnd:   () => { /* kernel exited dialog — loop continues */ },
            onPrint: line => {
                // Suppress internal scheduling noise — same filter as checkout.js
                if (line.startsWith('Still waiting for a safe time to evaluate $Inspector')) return;
                const text = line.replace(/\\012/g, '\n');
                if (this._watchPanel) this._watchPanel.log('[Print] ' + text.split('\n')[0]);
                const newHtml = '<pre class="vscode-wolfram-print-output">' + escapeHtml(text) + '</pre>';
                if (this._debugExecution) {
                    this._debugPrintHtml += newHtml;
                    if (this._debugPrintOut) {
                        this._debugExecution.replaceOutputItems(
                            [vscode.NotebookCellOutputItem.text(this._debugPrintHtml, 'x-application/wolfram-language-html')],
                            this._debugPrintOut
                        ).catch(() => {});
                    } else {
                        this._debugPrintOut = new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(this._debugPrintHtml, 'x-application/wolfram-language-html')
                        ]);
                        this._debugExecution.appendOutput(this._debugPrintOut).catch(() => {});
                    }
                }
            },
            onMessage: msg => {
                if (this._watchPanel) this._watchPanel.log('[Msg] ' + msg);
                if (this._debugExecution) {
                    this._debugPrintOut = null;
                    const msgHtml = '<div style="color:#f44;border-left:3px solid #f44;background:rgba(255,68,68,0.08);'
                        + 'padding:4px 8px;margin:2px 0;border-radius:0 3px 3px 0;font-family:monospace;white-space:pre-wrap">'
                        + escapeHtml(msg) + '</div>';
                    this._debugExecution.appendOutput(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(msgHtml, 'x-application/wolfram-language-html'),
                        vscode.NotebookCellOutputItem.text(msg, 'text/plain'),
                    ])).catch(() => {});
                }
            },
        });
        this._evalPromise
            .then(r   => this._finishDebug(false, null, r))
            .catch(err => this._finishDebug(true,  err));

        // Confirm session started in status bar
        vscode.window.setStatusBarMessage(
            `⬛ Wolfbook Debug: running ${xfm.steps.length} step(s) at ${xfm.maxDepth} level(s)…`, 5000);
    }

    // ── Step commands ─────────────────────────────────────────────────────────

    async stepOver()    { this._lastStepCommand = 'step';     await this._sendStep('wolfbookDebug$StepOver[]'); }
    async stepInto()    { this._lastStepCommand = 'step';     await this._sendStep('wolfbookDebug$StepInto[]'); }
    async stepOut()     { this._lastStepCommand = 'step';     await this._sendStep('wolfbookDebug$StepOut[]'); }
    async continueRun() { this._lastStepCommand = 'continue'; await this._sendStep('wolfbookDebug$Continue[]'); }
    async runToEnd()    { this._lastStepCommand = 'runToEnd'; await this._sendStep('wolfbookDebug$RunToEnd[]'); }

    _handleDebugCommand(cmd) {
        const map = {
            stepOver:   () => this.stepOver(),
            stepInto:   () => this.stepInto(),
            stepOut:    () => this.stepOut(),
            continue:   () => this.continueRun(),
            runToEnd:   () => this.runToEnd(),
            stop:       () => this.stop(),
            startDebug: () => {
                // Delegate to wolfbook.debug.debugCell — same path as F5 (fires vscode.debug.startDebugging)
                vscode.commands.executeCommand('wolfbook.debug.debugCell');
            },
        };
        const fn = map[cmd];
        if (fn) fn(); else scrollLog('[wolfbook-debug] unknown debugCommand:', cmd);
    }

    async stop() {
        if (!this._active) return;
        scrollLog('[wolfbook-debug] stop() called');
        this._stopping = true;  // suppress auto-advance even if evaluation finishes cleanly

        // Immediately clear all decorations so UI looks clean at once
        this._clearStepHighlight();
        this._clearPendingDeco();

        const ctrl = this._getController();

        // If the kernel is currently paused inside Dialog[], exit it first so the
        // evaluation thread is unblocked and the abort signal can reach it cleanly.
        if (ctrl?.session?.isDialogOpen) {
            scrollLog('[wolfbook-debug] stop: dialog open — disabling debug + exiting');
            try {
                // Disable further pauses so the kernel won't enter Dialog[] again
                await ctrl.session.dialogEval(
                    'wolfbookDebug$Active=False;wolfbookDebug$StepMode=False');
            } catch (e) { scrollLog('[wolfbook-debug] stop: dialogEval disable failed:', e?.message); }
            try { await ctrl.session.exitDialog(); } catch (e) { scrollLog('[wolfbook-debug] stop: exitDialog failed:', e?.message); }
        }

        // Abort the running evaluation
        if (ctrl) {
            scrollLog('[wolfbook-debug] stop: aborting evaluation');
            try { ctrl.abortEvaluation(); } catch (_) {}
        }

        // Force-finalize immediately — don't rely on _evalPromise rejection which
        // can be delayed or swallowed, leaving the notebook stuck in pending state.
        await this._finishDebug(true, new Error('stopped by user'));
    }

    // ── Internal step dispatch ────────────────────────────────────────────────

    async _sendStep(command) {
        const dialogOpen = this._getController()?.session?.isDialogOpen;
        scrollLog('[wolfbook-debug] _sendStep:', command, '| active=', this._active, '| dialogOpen=', dialogOpen);
        if (this._watchPanel) this._watchPanel.log(`→ ${command} (dialog=${dialogOpen})`);
        if (!this._active) return;
        const ctrl = this._getController();
        if (!ctrl?.session?.isDialogOpen) {
            vscode.window.showWarningMessage('Debug: kernel is not paused at a step.');
            return;
        }
        // Show pending indicator on the step we're about to run
        const pendingInfo = this._lastStepInfo;
        if (pendingInfo) this._applyPendingDeco(pendingInfo.depth, pendingInfo.localStep);
        // Run AFTER any pending breakpoint pushes in the queue so the kernel always
        // sees the latest wolfbookDebug$Breakpoints before it starts executing.
        await new Promise((resolve, reject) => {
            this._evalQueue = this._evalQueue.catch(() => {}).then(async () => {
                const stillOpen = ctrl?.session?.isDialogOpen;
                scrollLog('[wolfbook-debug] _sendStep QUEUE-SLOT:', command, '| stillOpen=', stillOpen);
                if (!stillOpen) { resolve(); return; }
                // Verify what breakpoints the kernel currently has before running
                try {
                    const bpCheck = await ctrl.session.dialogEval('wolfbookDebug$Breakpoints');
                    scrollLog('[wolfbook-debug] _sendStep PRE-RUN kernel bps=', JSON.stringify(bpCheck));
                } catch (e) { scrollLog('[wolfbook-debug] _sendStep: could not read bps:', e?.message); }
                try {
                    await ctrl.session.dialogEval(command);
                    await ctrl.session.exitDialog();
                    resolve();
                } catch (err) {
                    scrollLog('[wolfbook-debug] _sendStep error:', err?.message);
                    if (this._watchPanel) this._watchPanel.log(`✗ _sendStep error: ${err.message}`);
                    resolve(); // resolve, not reject — don't poison the queue
                }
            });
        }).catch(() => {});
        // Clear the current step highlight immediately — UI updates in _onDialogBegin
        this._clearStepHighlight();
    }

    // ── Dialog callback ───────────────────────────────────────────────────────

    /**
     * Enqueue a dialogEval on the shared serial queue.
     * Returns a Promise that resolves/rejects with the dialogEval result.
     */
    _queuedDialogEval(expr) {
        return new Promise((resolve, reject) => {
            // IMPORTANT: always .catch(() => {}) on _evalQueue to prevent a previous
            // rejected slot from poisoning the entire queue chain.
            this._evalQueue = this._evalQueue.catch(() => {}).then(async () => {
                const ctrl = this._getController();
                if (!ctrl?.session?.isDialogOpen) { reject(new Error('dialog not open')); return; }
                try { resolve(await ctrl.session.dialogEval(expr)); }
                catch (err) { reject(err); }
            });
        });
    }

    async _onDialogBegin() {
        scrollLog('[wolfbook-debug] _onDialogBegin | active=', this._active, '| dialogOpen=', this._getController()?.session?.isDialogOpen);
        if (this._watchPanel) this._watchPanel.log('Dialog opened (kernel paused)');
        if (!this._active) return;
        const ctrl = this._getController();
        if (!ctrl?.session?.isDialogOpen) {
            scrollLog('[wolfbook-debug] _onDialogBegin: dialog not open — skipping');
            return;
        }

        let stepInfoWexpr, watchWexpr;
        try {
            stepInfoWexpr = await this._queuedDialogEval('wolfbookDebug$GetStepInfo[]');
        } catch (err) {
            scrollLog('[wolfbook-debug] _onDialogBegin: GetStepInfo FAILED:', err?.message);
            // Dialog is still open — try to exit it and stop the session
            try { await ctrl.session.exitDialog(); } catch (_) {}
            scrollLog('[wolfbook-debug] _onDialogBegin: stopping session after GetStepInfo failure');
            this.stop();
            return;
        }
        if (!this._active) return;  // stop() may have fired while we were awaiting
        try {
            watchWexpr = await this._queuedDialogEval('wolfbookDebug$GetWatchValues[]');
        } catch (_) {}
        if (!this._active) return;

        // Parse WExprs
        const si  = wexprToJs(stepInfoWexpr) || {};
        const wvRaw = wexprToJs(watchWexpr) || {};

        const depth     = si['depth']     ?? 0;
        const localStep = si['step']      ?? 0;
        const iterVars  = si['iterVarValues'] ?? {};   // { name: value }
        const prevTiming      = si['prevTiming'] != null ? Number(si['prevTiming']) : null;
        const prevTimingDepth = si['prevTimingDepth'] ?? -1;
        const prevTimingStep  = si['prevTimingStep']  ?? -1;

        this._lastStepInfo = { depth, localStep, iterVars };
        scrollLog('[wolfbook-debug] _onDialogBegin: depth=', depth, 'step=', localStep, 'iterVars=', JSON.stringify(iterVars));
        if (this._watchPanel) this._watchPanel.log(`Paused: depth=${depth} step=${localStep}`);

        // Record timing for the step that just completed (tracked by kernel via LastCompleted)
        if (prevTiming != null && prevTimingDepth >= 0 && prevTimingStep >= 0) {
            this._timingMap.set(`${prevTimingDepth}:${prevTimingStep}`, prevTiming);
        }

        // Also pull ALL timings collected so far (covers "Continue" skipping many steps)
        if (!this._active) return;
        let allTimingsWexpr;
        try {
            allTimingsWexpr = await this._queuedDialogEval('wolfbookDebug$GetAllTimings[]');
        } catch (_) {}
        if (!this._active) return;
        if (allTimingsWexpr) {
            const allW = allTimingsWexpr;
            if (_wHead(allW) === 'Association') {
                for (const rule of _wArgs(allW)) {
                    if (_wHead(rule) === 'Rule' || _wHead(rule) === 'RuleDelayed') {
                        const [kW, vW] = _wArgs(rule);
                        if (_wHead(kW) === 'List') {
                            const [d, s, t] = [_wVal(_wArgs(kW)[0]), _wVal(_wArgs(kW)[1]), _wVal(vW)];
                            if (d != null && s != null && t != null) this._timingMap.set(`${d}:${s}`, t);
                        }
                    }
                }
            }
        }

        // Clear pending indicator (evaluation of previous step is done)
        this._clearPendingDeco();

        // Render the result of the step that JUST completed (prevTimingStep),
        // so output appears immediately as each step finishes.
        if (prevTimingDepth === 0 && prevTimingStep > 0 && this._debugExecution && ctrl) {
            const prevStepMeta = (this._xfm?.steps ?? []).find(
                s => s.depth === 0 && s.localStep === prevTimingStep);
            if (prevStepMeta && !prevStepMeta.suppressedOutput) {
                const cellForFmt = this._cell;
                const fmt = (ctrl._resolveFormat && cellForFmt)
                    ? ctrl._resolveFormat(cellForFmt)
                    : (vscode.workspace.getConfiguration('wolfram').get('notebook.rendering.outputFormat') || 'Auto');
                const scale = Number(ctrl.config?.get?.('imageScale') ??
                    vscode.workspace.getConfiguration('wolfram').get('imageScale') ?? 0.8);
                try {
                    const renderWexpr = await this._queuedDialogEval(
                        `wolfbookDebug$RenderStep[0, ${prevTimingStep}, "${fmt}", ${scale}]`);
                    // dialogEval returns raw WExpr (not wrapped in {result:{...}})
                    const rawHtml = renderWexpr?.type === 'string' ? renderWexpr.value : null;
                    if (rawHtml && this._debugExecution) {
                        const html = ctrl._processWLLatexBoxes
                            ? ctrl._processWLLatexBoxes(ctrl._fixImageUris ? ctrl._fixImageUris(rawHtml) : rawHtml)
                            : rawHtml;
                        await this._debugExecution.appendOutput(new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(
                                `<div class="wl-output-block"><div class="wl-output-content">${html}</div></div>`,
                                'x-application/wolfram-language-html'),
                        ]));
                    }
                } catch (rErr) {
                    scrollLog('[wolfbook-debug] _onDialogBegin: step render failed:', rErr?.message);
                }
            }
        }
        if (!this._active) return;

        // Re-push current breakpoints from bpMgr (user may have added/removed
        // breakpoints since the last pause while the kernel was running).
        const bpLinesNow = [...this._bpMgr.getBreakpointsForCell(this._cell || { document: { uri: { toString: () => '' } } })];
        const bpStepsNow = _bpLinesToKernelSteps(bpLinesNow, this._xfm?.steps ?? []);
        scrollLog('[wolfbook-debug] _onDialogBegin: re-pushing bpStepsNow=', bpStepsNow);
        try {
            await this._queuedDialogEval(`wolfbookDebug$Breakpoints = {${bpStepsNow.join(', ')}}`);
        } catch (_) {}

        // Apply step highlight
        this._applyStepHighlight(depth, localStep);

        // Apply timing decorations for all completed steps so far
        this._applyTimingDecorations();

        // Build variable list for watch panel
        const variables = [];
        // Iterator vars first
        if (iterVars && typeof iterVars === 'object') {
            for (const [name, value] of Object.entries(iterVars)) {
                variables.push({ name, shortVal: String(value), fullVal: String(value), isWatch: false });
            }
        }
        // Watch list
        for (const [name, vals] of Object.entries(wvRaw)) {
            if (vals && typeof vals === 'object') {
                variables.push({
                    name,
                    shortVal: String(vals['short'] ?? '?'),
                    fullVal:  String(vals['full']  ?? '?'),
                    isWatch: true,
                });
            }
        }

        // Store watch values for DAP Variables responses
        this._lastWatchValues = variables.filter(v => v.isWatch)
            .map(v => ({ name: v.name, short: v.shortVal, full: v.fullVal }));

        if (this._watchPanel) {
            this._watchPanel.update(
                { depth, localStep, iterVars },
                variables,
                prevTiming,   // timing of the step that just ran (for panel header display)
            );
        }

        // Emit DAP pause event
        this._pauseCount++;
        const pauseReason = this._pauseCount === 1 ? 'entry'
            : (this._lastStepCommand === 'continue' || this._lastStepCommand === 'runToEnd') ? 'breakpoint'
            : 'step';
        scrollLog('[wolfbook-debug] _onDialogBegin: firing stopped event, reason=', pauseReason,
            '| watchValues:', this._lastWatchValues.length,
            '| dialogOpen:', this._getController()?.session?.isDialogOpen);
        this._onDidPause.fire({ reason: pauseReason });
    }

    // ── Session end ───────────────────────────────────────────────────────────

    async _finishDebug(isError, err, evalResult = null) {
        if (!this._active) return;
        // Guard against double-call (stop() force-finishes, then Promise rejection fires too)
        if (this._finishing) return;
        this._finishing = true;
        const finishedCell = this._cell;   // capture before _cleanup() nulls it
        const wasStopping  = this._stopping;
        const ctrl = this._getController();

        scrollLog('[wolfbook-debug] _finishDebug: isError=', isError, 'wasStopping=', wasStopping,
            'hasExecution=', !!this._debugExecution, 'hasSession=', !!ctrl?.session);

        // Render and append the final cell result BEFORE ending the execution.
        // evalResult.outputName is non-empty when the last expression was non-Null.
        // Skip render if the last depth-0 step was suppressed (had a trailing ;) —
        // wolfbookDebug$Timed still returns its value (making Out[N] non-empty) but
        // Wolfram semantics say suppressed expressions should not be printed.
        const lastD0Step = (this._xfm?.steps ?? []).filter(s => s.depth === 0).slice(-1)[0];
        const _canRender = !isError && !wasStopping && evalResult?.outputName
                           && !lastD0Step?.suppressedOutput
                           && (evalResult?.cellIndex ?? 0) > 0
                           && this._debugExecution && ctrl?.session;
        console.log('[wolfbook-debug] _finishDebug: canRender=', _canRender);
        if (_canRender) {
            try {
                const cellForFmt = this._cell || finishedCell;
                const format = (ctrl._resolveFormat && cellForFmt)
                    ? ctrl._resolveFormat(cellForFmt)
                    : (vscode.workspace.getConfiguration('wolfram').get('notebook.rendering.outputFormat') || 'Auto');
                const scale  = Number(ctrl.config?.get?.('imageScale') ??
                    vscode.workspace.getConfiguration('wolfram').get('imageScale') ?? 0.8);
                scrollLog('[wolfbook-debug] _finishDebug: calling VsCodeRender[', evalResult.cellIndex, '] format=', format);
                const renderResult = await ctrl.session.evaluate(
                    `VsCodeRender[${evalResult.cellIndex}, "${format}", ${scale}]`,
                    { interactive: false, rejectDialog: true }
                );
                scrollLog('[wolfbook-debug] _finishDebug: renderResult type=', renderResult?.result?.type);
                if (renderResult?.result?.type === 'string' && renderResult.result.value) {
                    const _rawHtml = renderResult.result.value;
                    const html = ctrl._processWLLatexBoxes
                        ? ctrl._processWLLatexBoxes(ctrl._fixImageUris ? ctrl._fixImageUris(_rawHtml) : _rawHtml)
                        : _rawHtml;
                    // Re-check _debugExecution — stop() may have run during the await above
                    const dbgExec = this._debugExecution;
                    if (dbgExec) {
                        const outLabel = `<span style="font-size:10px;color:#888;margin-right:8px;">${evalResult.outputName}</span>`;
                        const wrapped  = `<div class="wl-output-block"><div class="wl-output-header" style="display:flex;align-items:center;min-height:22px;">${outLabel}</div><div class="wl-output-content">${html}</div></div>`;
                        await dbgExec.appendOutput(new vscode.NotebookCellOutput([
                            vscode.NotebookCellOutputItem.text(wrapped, 'x-application/wolfram-language-html'),
                            vscode.NotebookCellOutputItem.text(evalResult.outputName + ' ' + String(evalResult.result?.value ?? ''), 'text/plain'),
                        ]));
                        scrollLog('[wolfbook-debug] _finishDebug: output appended');
                    } else {
                        scrollLog('[wolfbook-debug] _finishDebug: _debugExecution nulled during render — output lost');
                    }
                } else {
                    scrollLog('[wolfbook-debug] _finishDebug: renderResult not HTML, aborted=', renderResult?.aborted);
                }
            } catch (renderErr) {
                scrollLog('[wolfbook-debug] _finishDebug: render failed:', renderErr?.message);
            }
        } else {
            scrollLog('[wolfbook-debug] _finishDebug: skipped output render');
        }

        // End the notebook cell execution (stops the spinner, makes output permanent)
        if (this._debugExecution) {
            try { this._debugExecution.end(!isError, Date.now()); } catch (_) {}
            this._debugExecution = null;
        }

        // Query final timings from kernel before cleanup (covers the last step).
        // Skip when the user stopped manually — the kernel may be mid-abort and
        // sending another evaluate() here can hang or corrupt the WSTP link.
        if (!wasStopping && ctrl?.session) {
            try {
                const timingsWexpr = await ctrl.session.evaluate(
                    'wolfbookDebug$GetAllTimings[]', { interactive: false });
                // Parse Association[Rule[List[depth,step], seconds], ...] directly from WExpr.
                // wexprToJs() mangles List-keyed Associations, so iterate raw args.
                const allW = timingsWexpr?.result;
                if (_wHead(allW) === 'Association') {
                    for (const rule of _wArgs(allW)) {
                        if (_wHead(rule) === 'Rule' || _wHead(rule) === 'RuleDelayed') {
                            const [kW, vW] = _wArgs(rule);
                            if (_wHead(kW) === 'List') {
                                const kArgs = _wArgs(kW);
                                const d = _wVal(kArgs[0]);
                                const s = _wVal(kArgs[1]);
                                const t = _wVal(vW);
                                if (d != null && s != null && t != null) {
                                    this._timingMap.set(`${d}:${s}`, t);
                                }
                            }
                        }
                    }
                }
                this._applyTimingDecorations();
            } catch (_) {}
        }

        // Always attempt kernel cleanup — even after abort/stop.
        // Use rejectDialog + short timeout so it won't hang if kernel is mid-abort.
        if (ctrl?.session) {
            try {
                await Promise.race([
                    ctrl.session.evaluate('wolfbookDebug$Cleanup[]', { interactive: false, rejectDialog: true }),
                    new Promise(r => setTimeout(r, 2000)),
                ]);
                scrollLog('[wolfbook-debug] _finishDebug: kernel cleanup done');
            } catch (e) {
                scrollLog('[wolfbook-debug] _finishDebug: kernel cleanup failed (ok after abort):', e?.message);
            }
        }

        this._clearStepHighlight();
        this._clearPendingDeco();
        this._applyTimingDecorations(); // final pass
        if (this._watchPanel) {
            this._watchPanel.clear();
            // Re-send the watch list names so the panel shows '…' placeholders
            // immediately (live-watch timer will fill real values in 2s).
            const _wl = this._watchPanel.getWatchList();
            if (_wl.length > 0) this._watchPanel.setWatchList(_wl);
        }

        if (isError && err) {
            scrollLog('[wolfbook-debug] session ended with error:', err?.message || String(err));
        }

        this._cleanup();
        scrollLog('[wolfbook-debug] _finishDebug complete, error=', isError);

        // Auto-advance first — if we're continuing on the next cell the DAP session
        // must stay open (no 'terminated' event) so VS Code's debug UI stays connected.
        let willAdvance = false;
        if (!isError && !wasStopping) {
            willAdvance = this._advanceToNextCell(finishedCell);
        }

        if (!willAdvance) {
            // Truly ending — notify the DAP adapter and switch watch panel to live mode.
            this._onDidFinish.fire();
            vscode.window.setStatusBarMessage('⬛ Wolfbook Debug: session ended.', 3000);
            setTimeout(() => this.refreshLiveWatch(), 400);
        }
    }

    /** After a clean debug completion, advance to the next code cell and start debugging it.
     * Returns true if a next cell was found and scheduled (DAP session stays open),
     * false if there is no next cell (caller should fire _onDidFinish). */
    _advanceToNextCell(completedCell) {
        if (!completedCell?.notebook) return false;
        const nb = completedCell.notebook;
        let nextCell = null;
        for (let i = completedCell.index + 1; i < nb.cellCount; i++) {
            const c = nb.cellAt(i);
            if (c.kind === vscode.NotebookCellKind.Code) { nextCell = c; break; }
        }
        if (!nextCell) return false;

        // Reveal the next cell so its text editor is in visibleTextEditors when
        // startDebugCell() tries to cache _cellEditor.
        const nbEditor = vscode.window.activeNotebookEditor;
        if (nbEditor) {
            try {
                const NR = vscode.NotebookRange;
                nbEditor.revealRange(
                    new NR(nextCell.index, nextCell.index + 1),
                    vscode.NotebookEditorRevealType.InCenterIfOutsideViewport
                );
            } catch (_) {}
        }

        // Brief delay so VS Code can render/focus the cell editor
        setTimeout(() => {
            scrollLog('[wolfbook-debug] auto-advancing to cell index', nextCell.index);
            this.startDebugCell(nextCell);
        }, 300);
        return true;   // caller must NOT fire _onDidFinish — DAP session stays open
    }

    _cleanup() {
        this._active        = false;
        this._cell          = null;
        this._xfm           = null;
        this._evalPromise   = null;
        this._lastStepInfo  = null;
        this._cellEditor    = null;
        if (this._debugExecution) {
            try { this._debugExecution.end(false, Date.now()); } catch (_) {}
            this._debugExecution = null;
        }

        this._stopping       = false;
        this._finishing      = false;
        vscode.commands.executeCommand('setContext', 'wolfbook.debugActive', false);
        if (this._watchPanel) this._watchPanel.setDebugActive(false);
        // Restore dynAutoMode if Dynamic widgets are still active after debug ends.
        const ctrl = this._getController();
        if (ctrl?.session && ctrl._dynamicWidgets?.size > 0) {
            try { ctrl.session.setDynAutoMode?.(true); } catch (_) {}
        }
        scrollLog('[wolfbook-debug] _cleanup done');
    }

    /**
     * Hard-reset ALL debugger state to defaults. Called by the global abort
     * and restart handlers as a last-resort to ensure no flags remain stuck.
     * This is safe to call even if no debug session was active.
     */
    resetAllState() {
        scrollLog('[wolfbook-debug] resetAllState called | wasActive=', this._active);
        // End any active execution spinner
        if (this._debugExecution) {
            try { this._debugExecution.end(false, Date.now()); } catch (_) {}
            this._debugExecution = null;
        }
        // Reset every session flag
        this._active         = false;
        this._cell           = null;
        this._xfm            = null;
        this._evalPromise    = null;
        this._lastStepInfo   = null;
        this._cellEditor     = null;
        this._debugPrintHtml = '';
        this._debugPrintOut  = null;
        this._restartPending = false;
        this._stopping       = false;
        this._finishing      = false;
        this._pauseCount     = 0;
        this._lastStepCommand = null;
        this._lastWatchValues = [];
        this._liveWatchInFlight      = false;
        this._liveWatchNoDialog      = false;
        this._liveWatchSentInterrupt = false;
        this._liveWatchConsecErrors  = 0;
        this._evalQueue      = Promise.resolve();

        // Clear UI
        this._clearStepHighlight();
        this._clearPendingDeco();
        vscode.commands.executeCommand('setContext', 'wolfbook.debugActive', false);
        if (this._watchPanel) {
            this._watchPanel.setDebugActive(false);
            this._watchPanel.clear();
        }

        // Fire finished event so DAP session terminates
        this._onDidFinish.fire();
    }

    // ── Decorations ───────────────────────────────────────────────────────────

    /** Find the cell's TextEditor — prefer the saved reference, fall back to visible editors. */
    _getCellEditor() {
        if (this._cellEditor) return this._cellEditor;
        if (!this._cell) return null;
        const uri = this._cell.document.uri.toString();
        const ed = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri) || null;
        if (ed) this._cellEditor = ed;   // cache it for future calls
        return ed;
    }

    /** Look up the step metadata for (depth, localStep). */
    _findStep(depth, localStep) {
        if (!this._xfm) return null;
        return this._xfm.steps.find(
            s => s.depth === depth && s.localStep === localStep
        ) || null;
    }

    _applyStepHighlight(depth, localStep) {
        const editor = this._getCellEditor();
        if (!editor) {
            console.log('[wolfbook-debug] _applyStepHighlight: no cell editor found');
            return;
        }
        const step = this._findStep(depth, localStep);
        if (!step) {
            console.log('[wolfbook-debug] _applyStepHighlight: no step for depth=', depth, 'localStep=', localStep);
            editor.setDecorations(this._stepHighlight, []);
            return;
        }
        const range = new vscode.Range(
            step.startLine, step.startChar,
            step.endLine,   Math.max(step.endChar, 0),
        );
        console.log('[wolfbook-debug] _applyStepHighlight: highlighting lines', step.startLine, '-', step.endLine);
        editor.setDecorations(this._stepHighlight, [range]);
    }

    _clearStepHighlight() {
        const editor = this._getCellEditor();
        if (editor) editor.setDecorations(this._stepHighlight, []);
    }

    _applyTimingDecorations() {
        const editor = this._getCellEditor();
        if (!editor || !this._xfm) return;
        const decos = [];
        for (const [key, sec] of this._timingMap) {
            const [d, ls] = key.split(':').map(Number);
            const step = this._findStep(d, ls);
            if (!step) continue;
            const timingStr = formatTiming(sec);
            if (!timingStr) continue;
            const line    = Math.min(step.endLine, editor.document.lineCount - 1);
            const endChar = step.endChar > 0 ? step.endChar
                          : editor.document.lineAt(line).text.length;
            const range   = new vscode.Range(line, endChar, line, endChar);
            decos.push({
                range,
                renderOptions: {
                    after: { contentText: `  ⏱ ${timingStr}` },
                },
            });
        }
        editor.setDecorations(this._timingDeco, decos);
    }

    _clearTimings() {
        this._timingMap.clear();
        const editor = this._getCellEditor();
        if (editor) editor.setDecorations(this._timingDeco, []);
        this._clearPendingDeco();
    }

    _applyPendingDeco(depth, localStep) {
        const editor = this._getCellEditor();
        if (!editor) return;
        const step = this._findStep(depth, localStep);
        if (!step) return;
        const line    = Math.min(step.endLine, editor.document.lineCount - 1);
        const endChar = step.endChar > 0 ? step.endChar
                      : editor.document.lineAt(line).text.length;
        const range   = new vscode.Range(line, endChar, line, endChar);
        editor.setDecorations(this._pendingDeco, [{ range }]);
    }

    _clearPendingDeco() {
        const editor = this._getCellEditor();
        if (editor) editor.setDecorations(this._pendingDeco, []);
    }

    async _refreshWatchPanel() {
        // Re-query watch values and update panel (called after add/remove watch)
        if (!this._active) return;
        const ctrl = this._getController();
        if (!ctrl?.session?.isDialogOpen) return;
        try {
            const w = await ctrl.session.dialogEval('wolfbookDebug$GetWatchValues[]');
            // rebuild variable list (iterVars not available here, just watch vars)
            const wvRaw = wexprToJs(w) || {};
            const wl    = this._watchPanel ? this._watchPanel.getWatchList() : [];
            const variables = [];
            for (const name of wl) {
                const vals = wvRaw[name];
                variables.push({
                    name,
                    shortVal: vals ? String(vals['short'] ?? '?') : '(not found)',
                    fullVal:  vals ? String(vals['full']  ?? '?') : '',
                    isWatch: true,
                });
            }
            if (this._watchPanel) this._watchPanel.update(null, variables, null);
        } catch (_) {}
    }

    /** Stop the active debug session and offer the user a Restart button.
     *  Called when the debugged cell is edited during a session. */
    _stopAndOfferRestart() {
        if (this._restartPending) return;
        this._restartPending = true;
        const cell = this._cell;    // capture before cleanup
        const ctrl = this._getController();
        if (ctrl) ctrl.abortEvaluation();
        // _finishDebug fires via _evalPromise rejection; delay prompt until settled
        setTimeout(() => {
            this._restartPending = false;
            vscode.window.showInformationMessage(
                'The debugged cell was edited. Restart debug session?',
                'Restart'
            ).then(choice => {
                if (choice === 'Restart' && cell) this.startDebugCell(cell);
            });
        }, 400);
    }

    async _refreshWatchAfterAdd(name) {
        // Push updated watch list to kernel then refresh panel
        if (!this._active) return;
        const ctrl = this._getController();
        const wl   = this._watchPanel ? this._watchPanel.getWatchList() : [];
        const wlWl = `wolfbookDebug$WatchList = {${wl.map(n => `"${n}"`).join(', ')}}`;
        if (ctrl?.session?.isDialogOpen) {
            try { await ctrl.session.dialogEval(wlWl); } catch (_) {}
        }
        await this._refreshWatchPanel();
    }
}

module.exports = { DebugController };
