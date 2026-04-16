'use strict';
/**
 * wolframDebugAdapter.js  —  DAP bridge
 *
 * Thin adapter between VSCode's Debug Adapter Protocol (DAP) and the existing
 * DebugController.  All kernel communication stays in DebugController; this
 * class only translates DAP messages to DebugController method calls and fires
 * DAP events in response to DebugController EventEmitter callbacks.
 *
 * Registered in extension.js via vscode.debug.registerDebugAdapterDescriptorFactory.
 */
const vscode = require('vscode');
const { devLog, LOG_CHANNELS } = require('../utils/dev-logger');

/** Map 0-based bp lines to kernel {depth, localStep} strings using deepest-match. */
function _bpLinesToKernelSteps(lines, steps) {
    const seen = new Set();
    const result = [];
    for (const line of lines) {
        const covering = steps.filter(s => s.startLine <= line && line <= s.endLine);
        if (!covering.length) continue;
        const deepest = covering.reduce((best, s) => s.depth > best.depth ? s : best);
        const key = `${deepest.depth}:${deepest.localStep}`;
        if (!seen.has(key)) { seen.add(key); result.push(`{${deepest.depth}, ${deepest.localStep}}`); }
    }
    return result;
}

/** Extract a scalar value from a WExpr (integer / real / string / symbol). */
function _wExprString(w) {
    if (!w) return null;
    if (w.type === 'string' || w.type === 'symbol' ||
        w.type === 'integer' || w.type === 'real' || w.type === 'biginteger') return String(w.value);
    // List/function head: fall back to head name
    if (w.type === 'function') {
        const h = typeof w.head === 'string' ? w.head : (w.head?.value ?? '');
        if (h === 'String' && w.args?.length === 1) return _wExprString(w.args[0]);
    }
    return null;
}

class WolframDebugAdapter {
    /**
     * @param {import('./debugController').DebugController} debugController
     * @param {import('./breakpointManager').BreakpointManager} bpMgr
     * @param {() => any} getController  Returns the WolframNotebookKernel instance
     */
    constructor(debugController, bpMgr, getController) {
        this._dc  = debugController;
        this._bpMgr = bpMgr;
        this._getController = getController;

        this._seq = 1;
        this._onDidSendMessage = new vscode.EventEmitter();
        this.onDidSendMessage  = this._onDidSendMessage.event;

        // Cache the last known value for each watch expression so VS Code's Watch
        // panel keeps showing fresh data even when the dialog closes before the
        // evaluate request arrives (user pressed F10 before VS Code round-tripped).
        this._evalCache = new Map();

        // Note: serial eval queue lives on debugController._evalQueue so that
        // both _onDialogBegin (controller) and _onEvaluate (adapter) share it.

        // Subscribe to DebugController events
        this._pauseSub  = debugController.onDidPause(({ reason }) => {
            this._sendEvent('stopped', {
                reason,
                threadId: 1,
                allThreadsStopped: true,
            });
        });
        this._finishSub = debugController.onDidFinish(() => {
            this._evalCache.clear();
            this._sendEvent('terminated', {});
        });
    }

    // ── vscode.DebugAdapter interface ────────────────────────────────────────

    handleMessage(msg) {
        if (msg.type === 'request') {
            this._dispatchRequest(msg).catch(err => {
                console.error('[wolfbook-dap] unhandled error in', msg.command, err);
            });
        }
    }

    dispose() {
        this._pauseSub?.dispose();
        this._finishSub?.dispose();
        this._onDidSendMessage.dispose();
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    _sendResponse(request, body = {}, success = true) {
        this._onDidSendMessage.fire({
            type:        'response',
            seq:         this._seq++,
            request_seq: request.seq,
            command:     request.command,
            success,
            body,
        });
    }

    _sendErrorResponse(request, message) {
        this._onDidSendMessage.fire({
            type:        'response',
            seq:         this._seq++,
            request_seq: request.seq,
            command:     request.command,
            success:     false,
            message,
            body:        { error: { id: 1, format: message } },
        });
    }

    _sendEvent(event, body = {}) {
        this._onDidSendMessage.fire({
            type:  'event',
            seq:   this._seq++,
            event,
            body,
        });
    }

    // ── Request dispatcher ────────────────────────────────────────────────────

    async _dispatchRequest(req) {
        switch (req.command) {
            case 'initialize':         return this._onInitialize(req);
            case 'launch':             return this._onLaunch(req);
            case 'configurationDone':  return this._onConfigurationDone(req);
            case 'setBreakpoints':     return this._onSetBreakpoints(req);
            case 'threads':            return this._onThreads(req);
            case 'stackTrace':         return this._onStackTrace(req);
            case 'scopes':             return this._onScopes(req);
            case 'variables':          return this._onVariables(req);
            case 'evaluate':           return this._onEvaluate(req);
            case 'next':               return this._onNext(req);
            case 'stepIn':             return this._onStepIn(req);
            case 'stepOut':            return this._onStepOut(req);
            case 'continue':           return this._onContinue(req);
            case 'pause':              return this._sendResponse(req);  // already paused
            case 'disconnect':
            case 'terminate':          return this._onDisconnect(req);
            default:
                // Unknown request — send an empty success response so DAP stays healthy
                return this._sendResponse(req);
        }
    }

    // ── Handlers ─────────────────────────────────────────────────────────────

    _onInitialize(req) {
        this._sendResponse(req, {
            supportsEvaluateForHovers:         true,
            supportsTerminateRequest:          true,
            supportsConfigurationDoneRequest:  true,
            supportsSingleThreadDebuggee:      true,
            supportSuspendDebuggee:            false,
            supportsSteppingGranularity:       false,
            supportsBreakpointLocationsRequest:false,
            supportsRestartRequest:            false,
        });
        // Signal that we are ready to receive setBreakpoints etc.
        this._sendEvent('initialized');
    }

    async _onLaunch(req) {
        const args = req.arguments || {};
        let cell = null;

        if (args.cellUri) {
            // Search ALL open notebook editors — activeNotebookEditor may have
            // shifted to the Run & Debug panel by the time this request arrives.
            const allEditors = [
                vscode.window.activeNotebookEditor,
                ...(vscode.window.visibleNotebookEditors ?? []),
            ];
            for (const nbEd of allEditors) {
                if (!nbEd) continue;
                for (let i = 0; i < nbEd.notebook.cellCount; i++) {
                    const c = nbEd.notebook.cellAt(i);
                    if (c.document.uri.toString() === args.cellUri) { cell = c; break; }
                }
                if (cell) break;
            }
            if (!cell) console.warn('[wolfbook-dap] launch: cellUri not found in any open notebook:', args.cellUri);
        }

        if (!cell) {
            // Fall back to currently selected cell (no cellUri provided)
            const editor = vscode.window.activeNotebookEditor;
            if (editor && editor.selections.length > 0) {
                cell = editor.notebook.cellAt(editor.selections[0].start);
            }
        }

        console.log('[wolfbook-dap] launch: cellUri=', args.cellUri, '| found cell index=', cell?.index ?? 'none');
        this._sendResponse(req);

        if (cell) {
            // startDebugCell is async; first stopped event comes from onDidPause
            this._dc.startDebugCell(cell).catch(err =>
                console.error('[wolfbook-dap] startDebugCell error:', err));
        } else {
            // Nothing to debug — terminate the session immediately
            this._sendEvent('terminated', {});
        }
    }

    _onConfigurationDone(req) {
        this._sendResponse(req);
    }

    async _onSetBreakpoints(req) {
        const source = req.arguments?.source;
        const dapBps = req.arguments?.breakpoints || [];

        console.log('[wolfbook-dap] setBreakpoints: source.path=', source?.path,
            '| sourceRef=', source?.sourceReference,
            '| bpCount=', dapBps.length,
            '| lines=', dapBps.map(b => b.line)
            ,'| _xfm=', !!this._dc._xfm, '| active=', this._dc._active);

        // ── Find the cell across ALL open notebook editors ───────────────────
        let cell = null;
        const allEditors = [
            vscode.window.activeNotebookEditor,
            ...(vscode.window.visibleNotebookEditors ?? []),
        ];
        for (const nbEd of allEditors) {
            if (!nbEd) continue;
            for (let i = 0; i < nbEd.notebook.cellCount; i++) {
                const c = nbEd.notebook.cellAt(i);
                if (source?.path && c.document.uri.toString() === source.path) { cell = c; break; }
            }
            if (cell) break;
        }
        console.log('[wolfbook-dap] setBreakpoints: cellFound=', !!cell);

        if (!cell) {
            return this._sendResponse(req, { breakpoints: dapBps.map(() => ({ verified: false })) });
        }

        // ── Session active ───────────────────────────────────────────────────
        // extension.js suppresses onDidChangeBreakpoints during a Wolfram DAP
        // session, so _bpMgr is NOT auto-updated.  _onSetBreakpoints IS the
        // authoritative sync point: dapBps is the complete current breakpoint
        // set for this source — rebuild _bpMgr from it, then push to kernel.
        if (this._dc._active && this._dc._xfm) {
            // Rebuild _bpMgr for this cell from the authoritative dapBps set
            this._bpMgr.clearBreakpoints(cell);
            for (const bp of dapBps) {
                this._bpMgr.addBreakpointAt(cell.document.uri.toString(), (bp.line || 1) - 1);
            }

            const result = dapBps.map(bp => {
                const line0 = (bp.line || 1) - 1;
                const match = this._dc._xfm.steps.find(
                    s => s.startLine <= line0 && line0 <= s.endLine
                );
                return match
                    ? { verified: true, line: match.startLine + 1 }
                    : { verified: false, line: bp.line };
            });

            // Push updated breakpoints to kernel if paused, via serial queue
            const ctrl = this._getController();
            const dialogOpenNow = ctrl?.session?.isDialogOpen;
            const bpLines = [...this._bpMgr.getBreakpointsForCell(cell)];
            const bpSteps = _bpLinesToKernelSteps(bpLines, this._dc._xfm.steps);
            console.log('[wolfbook-dap] setBreakpoints ACTIVE: dialogOpenNow=', dialogOpenNow,
                '| bpLines=', bpLines, '| bpSteps=', bpSteps,
                '| will-enqueue=', dialogOpenNow);
            if (dialogOpenNow) {
                const bpExpr = `wolfbookDebug$Breakpoints = {${bpSteps.join(', ')}}`;
                this._dc._evalQueue = this._dc._evalQueue.catch(() => {}).then(async () => {
                    const stillOpen = ctrl?.session?.isDialogOpen;
                    console.log('[wolfbook-dap] setBreakpoints QUEUE-SLOT firing: stillOpen=', stillOpen, '| bpExpr=', bpExpr);
                    if (!stillOpen) { console.warn('[wolfbook-dap] setBreakpoints QUEUE-SLOT: dialog closed before push ran!'); return; }
                    await ctrl.session.dialogEval(bpExpr);
                    console.log('[wolfbook-dap] setBreakpoints QUEUE-SLOT: push done');
                }).catch(err => console.error('[wolfbook-dap] setBreakpoints QUEUE-SLOT error:', err));
            } else {
                console.warn('[wolfbook-dap] setBreakpoints ACTIVE: dialog NOT open — push skipped (will rely on _onDialogBegin re-push)');
            }
            return this._sendResponse(req, { breakpoints: result });
        }

        // ── Pre-launch: session not yet started, store raw 0-based lines + verify.
        // Don't call clearBreakpoints here — onDidChangeBreakpoints in extension.js
        // is the authoritative source and already populated _bpMgr.  We just need
        // to make sure lines are in _bpMgr (they will be) and verify them.
        if (this._dc._xfm) {
            // xfm exists but session not active — map to step startLines
            const result = dapBps.map(bp => {
                const line0 = (bp.line || 1) - 1;
                const match = this._dc._xfm.steps.find(
                    s => s.startLine <= line0 && line0 <= s.endLine
                );
                if (match) {
                    this._bpMgr.addBreakpointAt(cell.document.uri.toString(), match.startLine);
                    return { verified: true, line: match.startLine + 1 };
                }
                return { verified: false, line: bp.line };
            });
            return this._sendResponse(req, { breakpoints: result });
        }

        // _xfm is null: DAP handshake before launch — store raw 0-based lines.
        // onDidChangeBreakpoints already synced these, but ensure _bpMgr has them.
        this._bpMgr.clearBreakpoints(cell);
        for (const bp of dapBps) {
            this._bpMgr.addBreakpointAt(cell.document.uri.toString(), (bp.line || 1) - 1);
        }
        console.log('[wolfbook-dap] setBreakpoints: pre-launch stored lines=',
            [...this._bpMgr.getBreakpointsForCell(cell)]);
        return this._sendResponse(req, { breakpoints: dapBps.map(bp => ({ verified: false, line: bp.line })) });
    }

    _onThreads(req) {
        this._sendResponse(req, {
            threads: [{ id: 1, name: 'Wolfram Kernel' }],
        });
    }

    _onStackTrace(req) {
        const si = this._dc._lastStepInfo;  // { depth, localStep, iterVars }
        const cell = this._dc._cell;
        const xfm  = this._dc._xfm;

        if (!si || !cell || !xfm) {
            return this._sendResponse(req, { stackFrames: [], totalFrames: 0 });
        }

        const { depth, localStep, iterVars } = si;
        const frames = [];

        // Current frame
        const currentStep = xfm.steps.find(
            s => s.depth === depth && s.localStep === localStep
        );
        const cellName = `Cell ${cell.index + 1}`;
        const cellPath = cell.document.uri.toString();

        if (currentStep) {
            let iterDesc = '';
            if (iterVars && typeof iterVars === 'object') {
                const pairs = Object.entries(iterVars).map(([k, v]) => `${k}=${v}`);
                if (pairs.length > 0) iterDesc = ' — ' + pairs.join(', ');
            }
            const frameName = depth > 0
                ? `Depth ${depth}, step ${localStep}${iterDesc}`
                : `Step ${localStep + 1}/${xfm.steps.filter(s => s.depth === 0).length}`;

            frames.push({
                id:     depth * 1000 + localStep,
                name:   frameName,
                source: { name: cellName, path: cellPath },
                line:   currentStep.startLine + 1,
                column: currentStep.startChar + 1,
            });
        }

        // Top-level frame (if different from current)
        if (depth > 0) {
            const topSteps = xfm.steps.filter(s => s.depth === 0);
            const topStep  = topSteps.length > 0 ? topSteps[0] : null;
            frames.push({
                id:     0,
                name:   `Top level — ${topSteps.length} step(s)`,
                source: { name: cellName, path: cellPath },
                line:   topStep ? topStep.startLine + 1 : 1,
                column: topStep ? topStep.startChar + 1 : 1,
            });
        }

        this._sendResponse(req, {
            stackFrames: frames,
            totalFrames: frames.length,
        });
    }

    _onScopes(req) {
        const frameId = req.arguments?.frameId ?? 0;
        const depth   = Math.floor(frameId / 1000);

        this._sendResponse(req, {
            scopes: [
                {
                    name:               'Iterator Variables',
                    variablesReference: 1000 + depth,
                    expensive:          false,
                },
                {
                    name:               'Watch Variables',
                    variablesReference: 2000 + depth,
                    expensive:          false,
                },
            ],
        });
    }

    _onVariables(req) {
        const ref = req.arguments?.variablesReference ?? 0;
        const variables = [];

        if (ref >= 1000 && ref < 2000) {
            // Iterator variables
            const iterVars = this._dc._lastStepInfo?.iterVars || {};
            for (const [name, value] of Object.entries(iterVars)) {
                variables.push({
                    name,
                    value:              String(value),
                    variablesReference: 0,
                    evaluateName:       name,
                });
            }
        } else if (ref >= 2000) {
            // Watch variables
            for (const wv of this._dc.lastWatchValues) {
                variables.push({
                    name:               wv.name,
                    value:              wv.short,
                    variablesReference: 0,
                    evaluateName:       wv.name,
                    type:               wv.full !== wv.short ? wv.full : undefined,
                });
            }
        }

        console.log('[wolfbook-dap] variables: ref=', ref, '| count=', variables.length,
            '| vars=', variables.map(v => `${v.name}=${v.value}`).join(', '));
        this._sendResponse(req, { variables });
    }

    async _onEvaluate(req) {
        const expr    = (req.arguments?.expression || '').trim();
        const context = req.arguments?.context || 'repl';

        if (!expr) {
            return this._sendResponse(req, { result: '', variablesReference: 0 });
        }

        devLog(LOG_CHANNELS.DEBUGGER, '[wolfbook-dap] evaluate: expr=', expr, '| context=', context,
            '| hasIterVars=', !!this._dc._lastStepInfo?.iterVars,
            '| dialogOpen=', this._getController()?.session?.isDialogOpen,
            '| cacheSize=', this._evalCache.size);

        // ── Fast path: iterator vars (always current at pause, no kernel call) ──
        const iterVars = this._dc._lastStepInfo?.iterVars;
        if (iterVars && Object.prototype.hasOwnProperty.call(iterVars, expr)) {
            const v = String(iterVars[expr]);
            this._evalCache.set(expr, v);
            return this._sendResponse(req, { result: v, variablesReference: 0 });
        }

        const ctrl = this._getController();
        const dialogOpen = ctrl?.session?.isDialogOpen;

        // ── When paused: evaluate via kernel using a serial queue ──────────────
        // The Dialog subsession is single-threaded.  Chain all evaluate calls
        // onto this._evalQueue so they run one at a time without blocking the
        // Node.js event loop.  (VS Code Watch panel sends N parallel evaluate
        // requests the moment the debugger pauses — they would otherwise race.)
        if (dialogOpen) {
            devLog(LOG_CHANNELS.DEBUGGER, '[wolfbook-dap] evaluate: enqueueing kernel eval for', expr);
            const kernelExpr = context === 'hover'
                ? `ToString[Short[${expr}, 3], OutputForm]`
                : `ToString[TimeConstrained[${expr}, 5], OutputForm]`;

            const resultP = new Promise((resolve, reject) => {
                // .catch(() => {}) prevents a prior rejected slot from poisoning the queue
                this._dc._evalQueue = this._dc._evalQueue.catch(() => {}).then(async () => {
                    // Re-check: dialog may have closed while waiting in the queue
                    if (!ctrl?.session?.isDialogOpen) {
                        const cached = this._evalCache.get(expr);
                        if (cached !== undefined) { resolve(cached); return; }
                        reject(new Error('Not paused'));
                        return;
                    }
                    try {
                        const wexpr = await ctrl.session.dialogEval(kernelExpr);
                        let value;
                        if (wexpr?.type === 'string') {
                            value = wexpr.value;
                        } else if (wexpr?.type === 'integer' || wexpr?.type === 'real' || wexpr?.type === 'symbol' || wexpr?.type === 'biginteger') {
                            value = String(wexpr.value);
                        } else {
                            value = _wExprString(wexpr) ?? JSON.stringify(wexpr);
                        }
                        resolve(value);
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            try {
                const value = await resultP;
                devLog(LOG_CHANNELS.DEBUGGER, '[wolfbook-dap] evaluate: GOT VALUE for', expr, '=', value?.substring?.(0, 80) ?? value);
                this._evalCache.set(expr, value);
                this._sendResponse(req, { result: value, variablesReference: 0 });
            } catch (err) {
                console.warn('[wolfbook-dap] evaluate: FAILED for', expr, ':', err?.message ?? err);
                this._sendErrorResponse(req, String(err?.message ?? err));
            }
            return;
        }

        // ── Not paused: serve from cache ────────────────────────────────────────
        devLog(LOG_CHANNELS.DEBUGGER, '[wolfbook-dap] evaluate: NOT paused, serving from cache for', expr);
        const cached = this._evalCache.get(expr);
        if (cached !== undefined) {
            return this._sendResponse(req, { result: cached, variablesReference: 0 });
        }
        const wv = this._dc.lastWatchValues.find(w => w.name === expr);
        if (wv) {
            this._evalCache.set(expr, wv.short);
            return this._sendResponse(req, { result: wv.short, variablesReference: 0 });
        }
        this._sendErrorResponse(req, 'Not paused — evaluation not available');
    }

    _onNext(req) {
        this._sendResponse(req);
        this._dc.stepOver().catch(() => {});
    }

    _onStepIn(req) {
        this._sendResponse(req);
        this._dc.stepInto().catch(() => {});
    }

    _onStepOut(req) {
        this._sendResponse(req);
        this._dc.stepOut().catch(() => {});
    }

    _onContinue(req) {
        this._sendResponse(req, { allThreadsContinued: true });
        this._dc.continueRun().catch(() => {});
    }

    _onDisconnect(req) {
        this._sendResponse(req);
        if (this._dc.isActive) {
            this._dc.stop().catch(() => {});
        }
    }
}

module.exports = { WolframDebugAdapter };
