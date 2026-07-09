'use strict';
/**
 * Oberon — Wolfram kernel shim (MVP-2b).
 *
 * A thin, structured wrapper around the shared `WolframNotebookKernel`
 * controller that exposes ONE clean async function: `evalOnce()`.
 *
 * Design goals:
 *   - Oberon NEVER touches MCP/LM tool plumbing or notebook UI internals.
 *   - The Fairy only sees a bounded, summarised JSON result — never the
 *     raw kernel transcript and never an unbounded string.
 *   - Honours an AbortSignal so user Abort cancels in-flight evals.
 *   - Times out via TimeConstrained on the kernel side (clean WL abort)
 *     with a Promise.race backstop for a frozen kernel.
 *   - Reports `kernel_unavailable` distinctly so callers can degrade.
 *
 * This is NOT a security boundary. It runs WL in the same kernel as the
 * user's notebooks. The Charm/Fairy prompts are the policy layer.
 */

const { cleanPrintLine } = require('../../utils/encoding');

let _getController = null;

/** @param {() => any} fn */
function setControllerProvider(fn) { _getController = fn; }

// M6: post-restart seeder. Registered by the fairy run with a closure over its
// workDir. After the kernel restarts, all registered util definitions are
// re-evaluated ONCE so probes can keep calling them by name. Cleared at run end.
let _postRestartSeeder = null;

/** @param {(null | (() => Promise<string>))} fn — returns WL seed code, or null to clear. */
function setPostRestartSeeder(fn) { _postRestartSeeder = (typeof fn === 'function') ? fn : null; }

const OUTPUT_HARD_CAP = 4000;     // chars
const PRINT_CAP       = 2000;     // chars (combined)
const MSG_CAP         = 1000;     // chars (combined)
const DEFAULT_TIMEOUT = 15;       // seconds
const MAX_TIMEOUT     = 60;       // seconds
// A cold WolframKernel (spawn + WSTP handshake + first-eval autoloads) can take
// far longer than a few seconds to become responsive. These bound how long we
// wait for a (re)start to resolve — deliberately generous so a slow boot is never
// mistaken for a failed restart (which used to cascade into escalate) and so a
// probe fired during startup waits for the kernel instead of "timing out".
const KERNEL_RESUME_TIMEOUT = 60000;   // ms — wait for restart to become ready
const KERNEL_BOOT_TIMEOUT   = 60000;   // ms — probe waits this long for a booting kernel

// ── Non-critical kernel messages ─────────────────────────────────────────────
// Numerical-solver convergence/tolerance warnings that USUALLY still return a
// usable result. Treating them as hard probe failures (the blanket "any Sym::tag:
// ⇒ failure" rule) discarded good roots and forced FindRoot thrash (see run
// Q_PQ9OKM: 59% probe-fail dominated by FindRoot::lstol). When the ONLY messages
// are in this set, the probe stays OK, the result is kept, and the warning is
// surfaced so the agent verifies the residual before recording.
const NON_CRITICAL_MESSAGE_TAGS = new Set([
    'FindRoot::lstol', 'FindRoot::cvmit',
    'FindMinimum::lstol', 'FindMinimum::cvmit', 'FindMaximum::lstol', 'FindMaximum::cvmit',
    'NMinimize::cvmit', 'NMaximize::cvmit',
    'NIntegrate::ncvb', 'NIntegrate::slwcon',
    'NSum::ncvb', 'NProduct::ncvb',
    'General::precw', 'General::munfl', 'General::stop',
]);

/**
 * Build the WL code that suppresses the non-critical messages — used as a visible,
 * transparent `Off[...]` cell at the top of working.wb / clean.wb and in the kernel
 * seed. Single source of truth: NON_CRITICAL_MESSAGE_TAGS.
 * @returns {string} e.g. "Off[FindRoot::lstol]; Off[FindRoot::cvmit]; ... ;"
 */
function buildSuppressionCode() {
    // General::stop is informational ("further output will be suppressed") — keep it
    // out of the explicit Off[] cell; the rest are safe to silence for the numerics.
    const list = [...NON_CRITICAL_MESSAGE_TAGS].filter(t => t !== 'General::stop');
    return list.map(t => `Off[${t}]`).join('; ') + ';';
}

/** Extract `Symbol::tag` message tags from kernel output text. */
function extractMessageTags(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(/([A-Z][A-Za-z0-9]*::[A-Za-z][A-Za-z0-9]*)/g)) out.add(m[1]);
    return [...out];
}

/**
 * Classify the messages in kernel output text.
 * @returns {{ tags:string[], critical:string[], soft:string[], hasMessages:boolean, allNonCritical:boolean }}
 */
function classifyMessages(text) {
    const tags = extractMessageTags(text);
    const critical = tags.filter(t => !NON_CRITICAL_MESSAGE_TAGS.has(t));
    const soft     = tags.filter(t =>  NON_CRITICAL_MESSAGE_TAGS.has(t));
    return { tags, critical, soft, hasMessages: tags.length > 0, allNonCritical: tags.length > 0 && critical.length === 0 };
}

function kernelStatus() {
    if (!_getController) return { available: false, reason: 'shim_not_initialised' };
    let c;
    try { c = _getController(); } catch (_) { return { available: false, reason: 'controller_unavailable' }; }
    if (!c)                                            return { available: false, reason: 'no_controller' };
    if (!c.session)                                    return { available: false, reason: 'no_session' };
    if (c.kernelStatusString !== 'resolved')           return { available: false, reason: `kernel_${c.kernelStatusString || 'unknown'}` };
    return { available: true, controller: c };
}

/**
 * Evaluate one Wolfram expression with structured result + bounded output.
 *
 * @param {{ expression: string, timeoutSeconds?: number, signal?: AbortSignal }} args
 * @returns {Promise<{
 *   ok: boolean,
 *   kind: 'ok'|'error'|'timeout'|'aborted'|'kernel_unavailable'|'kernel_dead'|'busy',
 *   value: string|null,            // truncated stringified output (≤OUTPUT_HARD_CAP)
 *   truncated: boolean,
 *   originalLength: number,        // chars before truncation
 *   prints: string|null,           // combined Print[] output, capped
 *   messages: string|null,         // WL warnings/errors, capped
 *   durationMs: number,
 *   timeoutSeconds: number,
 *   error: string|null,            // human-readable error message when !ok
 * }>}
 */
async function evalOnce(args) {
    const first = await _attemptEval(args);
    // If the kernel link is dead, try ONCE to restart and re-run the
    // expression so a single hiccup doesn't kill the agent's turn. The
    // result is tagged with `kernelRestarted: true` so the Fairy can emit
    // an `omen.kernel_restarted` and surface a warning to the user.
    if (!_isDeadLinkResult(first)) return first;

    const restarted = await _attemptKernelRestart();
    if (!restarted.ok) {
        return Object.assign({}, first, {
            kernelRestarted: false,
            error: (first.error || 'kernel link dead') +
                   ` — restart attempt failed: ${restarted.reason || 'unknown'}`,
        });
    }

    // Brief settle wait, then retry.
    await _sleep(500);
    const second = await _attemptEval(args);
    return Object.assign({}, second, { kernelRestarted: true });
}

/** Return true if a `mkResult` envelope looks like a dead-link failure. */
function _isDeadLinkResult(r) {
    if (!r || r.ok) return false;
    if (r.kind === 'timeout' || r.kind === 'aborted' || r.kind === 'busy') return false;
    if (r.kind === 'kernel_dead') return true;
    const msg = String((r.error || '') + ' ' + (r.messages || '')).toLowerCase();
    // Common WSTP / MathLink dead-link signatures:
    return /link\s*(is)?\s*(dead|closed|broken)/.test(msg)
        || /mlclosed|mldead|wstp.*(closed|dead|broken)/.test(msg)
        || /kernel.*(died|crashed|gone|not\s+responding)/.test(msg)
        || /epipe|enotconn|econnreset/.test(msg)
        || /session\.evaluate is not a function/.test(msg)
        || /no\s+session/.test(msg);
}

/** Attempt to restart the kernel via the active controller. */
async function _attemptKernelRestart() {
    if (!_getController) return { ok: false, reason: 'shim_not_initialised' };
    let c;
    try { c = _getController(); } catch (_) { return { ok: false, reason: 'controller_unavailable' }; }
    if (!c) return { ok: false, reason: 'no_controller' };
    if (typeof c.restartKernel !== 'function') return { ok: false, reason: 'no_restartKernel' };
    try {
        c.restartKernel();
    } catch (e) {
        return { ok: false, reason: 'restartKernel_threw: ' + ((e && e.message) || String(e)) };
    }
    // Wait for the kernel to come back to `resolved` state. A cold restart can
    // take 30s+; too short a deadline reports `kernel_did_not_resume` while the
    // kernel is still launching, which then cascaded run_clean into escalate.
    const deadline = Date.now() + KERNEL_RESUME_TIMEOUT;
    while (Date.now() < deadline) {
        const s = kernelStatus();
        if (s.available) {
            // Also wait for any queued execution to drain after restart.
            const drainDeadline = Date.now() + 3000;
            while (Date.now() < drainDeadline) {
                const c = s.controller;
                if (!c._evalDispatched && c.executionQueue.queueLength() === 0) break;
                await _sleep(150);
            }
            return { ok: true };
        }
        await _sleep(250);
    }
    return { ok: false, reason: 'kernel_did_not_resume' };
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** True when a kernelStatus().reason means "a kernel is coming up" (worth waiting
 *  for) rather than "no kernel infrastructure exists" (nothing to wait for). */
function _isKernelStarting(reason) {
    const r = String(reason || '');
    return r === 'no_session' || r.startsWith('kernel_');
}

/** @private — internal single-shot evaluation. */
async function _attemptEval(args) {
    const expression = String((args && args.expression) || '').trim();
    const timeoutSeconds = clampInt(args && args.timeoutSeconds, DEFAULT_TIMEOUT, 1, MAX_TIMEOUT);
    const signal = args && args.signal;
    let t0 = Date.now();

    if (!expression) {
        return mkResult({ ok: false, kind: 'error', durationMs: 0, timeoutSeconds, error: 'expression is empty' });
    }

    // Wait for the kernel to finish (re)starting before the evaluation begins.
    // A cold kernel can take tens of seconds to resolve; firing a probe at it and
    // counting that startup against the probe's timeout made the first probe of a
    // run spuriously "time out". Block here (up to KERNEL_BOOT_TIMEOUT) so the
    // timeout clock only starts once the kernel is actually ready — but only while
    // the kernel is genuinely starting up (a session exists / is resolving). If
    // there's no controller at all, there's nothing to wait for, so fail fast.
    let status = kernelStatus();
    if (!status.available) {
        const bootDeadline = Date.now() + KERNEL_BOOT_TIMEOUT;
        while (!status.available && _isKernelStarting(status.reason) && Date.now() < bootDeadline) {
            if (signal && signal.aborted) {
                return mkResult({ ok: false, kind: 'aborted', durationMs: Date.now()-t0, timeoutSeconds, error: 'aborted while waiting for kernel' });
            }
            await _sleep(300);
            status = kernelStatus();
        }
        if (!status.available) {
            return mkResult({
                ok: false, kind: 'kernel_unavailable', durationMs: Date.now()-t0, timeoutSeconds,
                error: `kernel not available (${status.reason})`,
            });
        }
    }
    const controller = status.controller;

    if (controller._evalDispatched || controller.executionQueue.queueLength() > 0) {
        // Wait for the kernel to become idle. This is bounded generously (not by the
        // probe timeout) so a busy/queued kernel doesn't count against eval time.
        const idleDeadline = Date.now() + Math.max(KERNEL_BOOT_TIMEOUT, timeoutSeconds * 1000);
        while (controller._evalDispatched || controller.executionQueue.queueLength() > 0) {
            if (signal && signal.aborted) {
                return mkResult({ ok: false, kind: 'aborted', durationMs: Date.now()-t0, timeoutSeconds, error: 'aborted while waiting for idle kernel' });
            }
            if (Date.now() >= idleDeadline) {
                return mkResult({
                    ok: false, kind: 'busy', durationMs: Date.now()-t0, timeoutSeconds,
                    error: 'kernel is busy with another evaluation (waited for idle)',
                });
            }
            await _sleep(200);
        }
    }

    // Kernel is ready and idle — (re)start the clock HERE so neither startup nor
    // queue-wait time is charged to this evaluation's timeout.
    t0 = Date.now();

    const wlSec   = Math.max(1, timeoutSeconds - 1);
    const wrapped =
        `Block[{$wbR$}, $wbR$ = TimeConstrained[(${expression}), ${wlSec}, "$WBTIMEOUT$"]; ` +
        `If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", ` +
        `If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;

    const prints = [];
    let abortOnSignal = null;
    if (signal) {
        if (signal.aborted) {
            return mkResult({ ok: false, kind: 'aborted', durationMs: Date.now()-t0, timeoutSeconds, error: 'aborted before dispatch' });
        }
        abortOnSignal = () => { try { controller.session.abort && controller.session.abort(); } catch (_) {} };
        signal.addEventListener('abort', abortOnSignal, { once: true });
    }

    let result, hardTimeout;
    try {
        const evalP = controller.session.evaluate(wrapped, {
            interactive: false,
            onPrint: (p) => { if (typeof p === 'string') prints.push(cleanPrintLine(p)); },
        });
        // Hard backstop: TimeConstrained returns the sentinel cleanly, but if the
        // kernel itself freezes we still need to unblock the caller.
        const hardP = new Promise((_, rej) => {
            hardTimeout = setTimeout(() => rej(new Error('hard_timeout')), (timeoutSeconds + 5) * 1000);
        });
        result = await Promise.race([evalP, hardP]);
    } catch (e) {
        clearTimeout(hardTimeout);
        if (signal && abortOnSignal) signal.removeEventListener('abort', abortOnSignal);
        const msg = String(e && e.message || e);
        if (signal && signal.aborted) {
            return mkResult({ ok: false, kind: 'aborted', durationMs: Date.now()-t0, timeoutSeconds, error: 'aborted' });
        }
        if (msg === 'hard_timeout') {
            try { controller.session.abort && controller.session.abort(); } catch (_) {}
            return mkResult({ ok: false, kind: 'timeout', durationMs: Date.now()-t0, timeoutSeconds, error: `kernel did not respond within ${timeoutSeconds+5}s (hard backstop)` });
        }
        // Tag dead-link-shaped errors with kind:'kernel_dead' so the
        // outer `evalOnce` retry layer can pick them up reliably.
        const lowered = msg.toLowerCase();
        const dead = /link\s*(is)?\s*(dead|closed|broken)|mlclosed|mldead|kernel.*(died|crashed|gone)|epipe|enotconn|session\.evaluate is not a function/.test(lowered);
        return mkResult({
            ok: false,
            kind: dead ? 'kernel_dead' : 'error',
            durationMs: Date.now()-t0,
            timeoutSeconds,
            error: (dead ? 'kernel link dead: ' : 'kernel error: ') + msg,
        });
    }
    clearTimeout(hardTimeout);
    if (signal && abortOnSignal) signal.removeEventListener('abort', abortOnSignal);

    const durationMs = Date.now() - t0;
    const msgs = summariseMessages(result && result.messages);
    const printStr = prints.length ? capStr(prints.join('\n').replace(/\n$/, ''), PRINT_CAP) : null;

    const r = result && result.result;
    if (!r || r.type == null) {
        return mkResult({ ok: true, kind: 'ok', value: null, durationMs, timeoutSeconds, prints: printStr, messages: msgs });
    }
    if (r.type === 'abort') {
        return mkResult({ ok: false, kind: 'aborted', durationMs, timeoutSeconds, error: 'kernel reported abort', prints: printStr, messages: msgs });
    }
    if (r.type === 'string' && r.value === '$WBTIMEOUT$') {
        return mkResult({
            ok: false, kind: 'timeout', durationMs, timeoutSeconds,
            error: `evaluation exceeded ${wlSec}s — kernel is alive; simplify or raise timeoutSeconds (max ${MAX_TIMEOUT})`,
            prints: printStr, messages: msgs,
        });
    }
    if (r.type === 'string' && typeof r.value === 'string') {
        const raw = r.value.replace(/\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        const truncated = raw.length > OUTPUT_HARD_CAP;
        return mkResult({
            ok: true, kind: 'ok',
            value: truncated ? raw.slice(0, OUTPUT_HARD_CAP) : raw,
            truncated, originalLength: raw.length,
            durationMs, timeoutSeconds, prints: printStr, messages: msgs,
        });
    }
    return mkResult({ ok: true, kind: 'ok', value: null, durationMs, timeoutSeconds, prints: printStr, messages: msgs });
}

function summariseMessages(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const lines = arr.map(m => {
        if (typeof m === 'string') return m;
        if (m && typeof m === 'object') {
            return (m.symbol || m.tag || 'msg') + ': ' + (m.text || m.message || JSON.stringify(m));
        }
        return String(m);
    });
    return capStr(lines.join('\n'), MSG_CAP);
}

function capStr(s, n) {
    if (s.length <= n) return s;
    return s.slice(0, n) + `\n[truncated — ${s.length} chars total]`;
}

function clampInt(v, def, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function mkResult(o) {
    return {
        ok:             !!o.ok,
        kind:           o.kind,
        value:          o.value == null ? null : o.value,
        truncated:      !!o.truncated,
        originalLength: typeof o.originalLength === 'number' ? o.originalLength : (o.value ? o.value.length : 0),
        prints:         o.prints || null,
        messages:       o.messages || null,
        durationMs:     o.durationMs || 0,
        timeoutSeconds: o.timeoutSeconds,
        error:          o.error || null,
        kernelRestarted: !!o.kernelRestarted,
    };
}

/** Public wrapper — restart the kernel and wait for it to be ready. */
async function restartKernel() {
    const result = await _attemptKernelRestart();
    // M6: re-seed registered utils once, after the fresh kernel is ready, so probes
    // can keep calling them by name without per-probe re-pasting.
    if (result && result.ok !== false && _postRestartSeeder) {
        try {
            const seed = await _postRestartSeeder();
            if (seed && seed.trim()) {
                await evalOnce({ expression: seed, timeoutSeconds: DEFAULT_TIMEOUT });
            }
        } catch (_) { /* seeding is best-effort */ }
    }
    return result;
}

/**
 * Replay all CODE cells of a .wb / .vsnb / .evsnb notebook in order, in the
 * current Wolfram kernel session. Used to restore state after a kernel
 * restart so the Fairy / Skeptic operate on the same definitions that the
 * notebook visibly contains.
 *
 * Reads the notebook JSON from disk (no VS Code API dependency) and runs
 * each code cell via `evalOnce`. Stops on the first hard kernel failure
 * (dead link), but continues past per-cell errors / warnings (they were
 * presumably present on the original run too).
 *
 * @param {string} nbPath               absolute path to a notebook JSON file
 * @param {{ signal?: AbortSignal,
 *           timeoutSeconds?: number,
 *           maxCells?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   evaluatedCount: number,
 *   skippedCount: number,
 *   errors: Array<{ cellIndex: number, error: string }>,
 *   reason?: string,
 * }>}
 */
async function replayNotebook(nbPath, opts) {
    const fsp = require('fs/promises');
    const sig    = opts && opts.signal;
    const tSec   = (opts && opts.timeoutSeconds) || 30;
    const maxN   = (opts && opts.maxCells) || 200;

    let raw;
    try { raw = await fsp.readFile(nbPath, 'utf8'); }
    catch (e) { return { ok: false, evaluatedCount: 0, skippedCount: 0, errors: [], reason: `read_failed: ${e && e.message || String(e)}` }; }

    let nb;
    try { nb = JSON.parse(raw); }
    catch (e) { return { ok: false, evaluatedCount: 0, skippedCount: 0, errors: [], reason: `json_parse_failed: ${e && e.message || String(e)}` }; }

    if (!nb || !Array.isArray(nb.cells)) {
        return { ok: false, evaluatedCount: 0, skippedCount: 0, errors: [], reason: 'no_cells_array' };
    }

    // Extract code cells preserving original index for error reporting.
    // VS Code notebook cells encode `kind` as 1 (markup) or 2 (code).
    const codeCells = [];
    for (let i = 0; i < Math.min(nb.cells.length, maxN); i++) {
        const c = nb.cells[i];
        if (!c) continue;
        const isCode = c.kind === 2
            || c.cell_type === 'code'
            || (c.languageId && /wolfram|mathematica/i.test(String(c.languageId)));
        if (!isCode) continue;
        const src = String(c.value || c.source || '').trim();
        if (!src) continue;
        codeCells.push({ index: i, source: src });
    }

    let evaluated = 0;
    let skipped   = 0;
    const errors = [];
    for (const cell of codeCells) {
        if (sig && sig.aborted) {
            return { ok: false, evaluatedCount: evaluated, skippedCount: codeCells.length - evaluated, errors, reason: 'aborted' };
        }
        const r = await _attemptEval({ expression: cell.source, timeoutSeconds: tSec, signal: sig });
        if (_isDeadLinkResult(r)) {
            return { ok: false, evaluatedCount: evaluated, skippedCount: codeCells.length - evaluated - 1, errors, reason: 'kernel_dead_mid_replay' };
        }
        if (!r.ok) {
            errors.push({ cellIndex: cell.index, error: r.error || r.kind || 'unknown' });
            skipped++;
        } else {
            evaluated++;
        }
    }
    return { ok: true, evaluatedCount: evaluated, skippedCount: skipped, errors };
}

/**
 * Execute all code cells of a .wb notebook through the wolfbook NotebookController
 * (the same path as the user clicking "Run All"), then return per-cell results with
 * error/warning detection.  This is the correct fix for run_clean: it produces rich
 * rendered outputs in the notebook, identical to what the user sees when running.
 *
 * Falls back to evalOnce-based replayNotebook when the notebook file cannot be opened
 * as a VS Code document (e.g. tests, non-VS Code environments).
 *
 * @param {string} nbPath  absolute path to a .wb notebook file
 * @param {{ signal?: AbortSignal, timeoutSeconds?: number }} [opts]
 * @returns {Promise<{
 *   allClean:   boolean,
 *   cellCount:  number,
 *   failures:   Array<{ cellIndex: number, cellId: string, output: string|null, messages: string|null }>,
 *   allResults: Array<{ cellIndex: number, cellId: string, ok: boolean, clean: boolean,
 *                        output: string|null, messages: string|null, error: string|null }>,
 *   usedFallback: boolean,
 * }>}
 */
async function runNotebook(nbPath, opts) {
    const vscode = (() => { try { return require('vscode'); } catch (_) { return null; } })();
    if (!vscode) return _runNotebookFallback(nbPath, opts);

    const { TextDecoder } = require('util');
    const decoder = new TextDecoder();
    const timeoutSec = Math.max(10, (opts && opts.timeoutSeconds) || 120);
    const signal = opts && opts.signal;

    // 1. Open the notebook document (reads from disk).
    let nbDoc;
    try {
        nbDoc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(nbPath));
    } catch (_) {
        return _runNotebookFallback(nbPath, opts);
    }

    // 2. Show the notebook in an editor tab to force the wolfbook controller to be
    // associated BEFORE we call createNotebookCellExecution.  Without this, newly-
    // created notebooks (e.g. clean.wb written by the harness) trigger the 'not
    // associated' error inside execute().  The re-association dance there takes
    // ≥2000ms, which races with our 500ms poll → false allClean:true with no output.
    // preserveFocus:true avoids stealing the user's cursor.
    try {
        await vscode.window.showNotebookDocument(nbDoc, {
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: true,
        });
    } catch (_) { /* non-fatal — proceed anyway */ }

    // 3. Get the wolfbook controller — prefer silent (agent-mode) execution.
    const status = kernelStatus();
    const ctrl = status.available ? status.controller : null;
    const useSilent = !!(ctrl && typeof ctrl.execute === 'function');

    if (useSilent) {
        try { await ctrl.abortAndWait(5000); } catch (_) {}
        ctrl._silentExecution = true;
    }

    const allResults = [];
    let allClean = true;
    const globalDeadline = Date.now() + timeoutSec * 1000;

    try {
        for (let idx = 0; idx < nbDoc.cellCount; idx++) {
            if (signal && signal.aborted) break;
            const cell = nbDoc.cellAt(idx);
            if (cell.kind !== vscode.NotebookCellKind.Code) continue;
            const langId = cell.document.languageId || '';
            if (!/wolfram|mathematica/i.test(langId)) continue;

            const remaining = globalDeadline - Date.now();
            if (remaining <= 0) break;

            if (useSilent) {
                // Scroll the notebook editor to reveal this cell before executing.
                try {
                    const ed = vscode.window.visibleNotebookEditors.find(
                        e => e.notebook.uri.fsPath === nbDoc.uri.fsPath);
                    if (ed) ed.revealRange(
                        new vscode.NotebookRange(idx, idx + 1),
                        vscode.NotebookEditorRevealType.Default);
                } catch (_) {}

                ctrl._wolframExecPending = true;
                // Fire without await — checkoutExecutionQueue runs async inside execute().
                // We poll _evalDispatched + queueLength() below to wait for completion.
                try { ctrl.execute([cell], nbDoc, ctrl._controller); } catch (_) {}

                // Poll for idle. Initial delay is 2500ms (safely past the 2000ms
                // re-association timeout inside execute(), so we never see a false idle).
                const cellDeadline = Math.min(globalDeadline, Date.now() + Math.min(remaining, 300000));
                let seenIdle = false;
                await new Promise(resolve => {
                    const poll = () => {
                        if (signal && signal.aborted) { resolve(); return; }
                        const idle = !ctrl._evalDispatched && ctrl.executionQueue.queueLength() === 0;
                        if (idle) {
                            if (!seenIdle) { seenIdle = true; setTimeout(poll, 200); return; }
                            resolve();
                        } else {
                            seenIdle = false;
                            if (Date.now() >= cellDeadline) resolve();
                            else setTimeout(poll, 200);
                        }
                    };
                    setTimeout(poll, 2500);
                });
            } else {
                // Non-silent fallback: use notebook.cell.execute via VS Code command.
                // Requires the document to be visible; skip if not possible.
                break;
            }

            // Read back outputs from the executed cell.
            const updatedCell = nbDoc.cellAt(idx);
            const outs = [];
            let errMime = false;
            for (const output of updatedCell.outputs) {
                const mimes = output.items.map(it => it.mime);
                if (mimes.includes('application/vnd.code.notebook.error')) errMime = true;
                const plainItem = output.items.find(it => it.mime === 'text/plain');
                if (plainItem) {
                    try {
                        const txt = decoder.decode(plainItem.data).trim();
                        if (txt) outs.push(txt);
                    } catch (_) {}
                }
            }

            // Errors and CRITICAL warnings block clean delivery; non-critical
            // convergence warnings (FindRoot::lstol, …) are tolerated and reported.
            const cls = classifyMessages(outs.join('\n'));
            const hasError = errMime || cls.critical.length > 0;
            const softOnly = !hasError && cls.soft.length > 0;
            const isClean  = !hasError && cls.soft.length === 0;   // pristine
            // Only errors/critical warnings fail the clean run; soft warnings pass.
            if (hasError) allClean = false;

            const cellId = cell.metadata && (cell.metadata.id || Object.values(cell.metadata)[0]) || `cell_${idx}`;
            const combined = outs.join('\n') || null;
            allResults.push({
                cellIndex: allResults.length,
                cellId:    String(cellId),
                ok:        !hasError,
                clean:     !hasError,                   // soft warnings count as deliverable
                pristine:  isClean,
                softWarnings: softOnly ? cls.soft.join(', ') : null,
                output:    combined,
                messages:  (softOnly || hasError) ? combined : null,
                error:     hasError   ? combined : null,
            });
        }
    } finally {
        if (useSilent && ctrl) {
            ctrl._silentExecution = false;
            ctrl._agentGuardActive = false;
        }
    }

    const failures = allResults.filter(r => !r.clean);
    return { allClean, cellCount: allResults.length, failures, allResults, usedFallback: false };
}

/** evalOnce-based fallback for non-VS Code environments (tests, CLI). */
async function _runNotebookFallback(nbPath, opts) {
    const fsp = require('fs/promises');
    let nb;
    try { nb = JSON.parse(await fsp.readFile(nbPath, 'utf8')); } catch (_) { nb = { cells: [] }; }
    const cells = (nb.cells || []).filter(c => c.kind === 2 && /wolfram|mathematica/i.test(String(c.language || c.languageId || '')));
    const allResults = [];
    let allClean = true;
    for (let i = 0; i < cells.length; i++) {
        if (opts && opts.signal && opts.signal.aborted) break;
        const r = await evalOnce({ expression: cells[i].value || '', timeoutSeconds: 30, signal: opts && opts.signal });
        const cls = classifyMessages(r.messages || '');
        const hasError   = !r.ok || cls.critical.length > 0;
        const softOnly   = !hasError && cls.soft.length > 0;
        const isClean    = !hasError && cls.soft.length === 0;
        if (hasError) allClean = false;
        allResults.push({
            cellIndex: i, cellId: cells[i].id || `cell_${i}`,
            ok: !hasError, clean: !hasError, pristine: isClean,
            softWarnings: softOnly ? cls.soft.join(', ') : null,
            output: r.value || null, messages: r.messages || null, error: r.error || null,
        });
    }
    const failures = allResults.filter(r => !r.clean);
    return { allClean, cellCount: allResults.length, failures, allResults, usedFallback: true };
}

/**
 * I2 (run Q_2N8616): apply a cell edit THROUGH the open VS Code notebook document
 * when the target notebook is open, so the on-disk file and the in-memory document
 * can never diverge. A disk-only JSON write is invisible to an already-open (and
 * possibly dirty) document — run_clean then executes STALE cells and reports the
 * same failures the edit was meant to fix.
 *
 * Preserves the cell's metadata (step tags/ids) and saves the document, so disk
 * and editor stay in lockstep.
 *
 * @param {string} nbPath        absolute path to the .wb file
 * @param {number} absCellIndex  ABSOLUTE cell index in the notebook (not code-only)
 * @param {string} newCode
 * @returns {Promise<{ applied: boolean, reason?: string }>}  applied:false → caller
 *          should fall back to the disk-JSON write.
 */
async function editNotebookCell(nbPath, absCellIndex, newCode) {
    let vscode;
    try { vscode = require('vscode'); } catch (_) { return { applied: false, reason: 'no vscode' }; }
    try {
        const doc = (vscode.workspace.notebookDocuments || [])
            .find(d => d && d.uri && d.uri.fsPath === nbPath);
        if (!doc) return { applied: false, reason: 'document not open' };
        if (absCellIndex < 0 || absCellIndex >= doc.cellCount) {
            return { applied: false, reason: `cell index ${absCellIndex} out of range (${doc.cellCount})` };
        }
        const cell = doc.cellAt(absCellIndex);
        const data = new vscode.NotebookCellData(cell.kind, newCode, cell.document.languageId || 'wolfram');
        data.metadata = cell.metadata;   // preserve step tags / ids
        const nbEdit = vscode.NotebookEdit.replaceCells(
            new vscode.NotebookRange(absCellIndex, absCellIndex + 1), [data]);
        const we = new vscode.WorkspaceEdit();
        we.set(doc.uri, [nbEdit]);
        const ok = await vscode.workspace.applyEdit(we);
        if (!ok) return { applied: false, reason: 'applyEdit rejected' };
        await doc.save();
        return { applied: true };
    } catch (e) {
        return { applied: false, reason: (e && e.message) || String(e) };
    }
}

/** @private — no-op snapshot helper; real one lives in tools/index.js */
function _snapshotViewport() { return null; }

/**
 * Insert a wolfram code cell (optionally preceded by a markdown note cell) into
 * an already-open VS Code notebook document, execute it via the wolfbook
 * controller, and return the text result — same interface as evalOnce.
 *
 * Unlike evalOnce (which wraps in ToString[InputForm]), this path uses the
 * wolfbook NotebookController so the cell gets full rich rendering (LaTeX, SVG,
 * MathML) in the tab. The text/plain output item is returned as `value` for the
 * agent. Only one evaluation happens — no double-eval.
 *
 * @param {import('vscode').NotebookDocument} nbDoc  — must already be open + associated
 * @param {string} code
 * @param {{ timeoutSeconds?: number, signal?: AbortSignal, note?: string, probeId?: string }} opts
 */
/**
 * Ensure the wolfbook controller is associated with `nbDoc` so that
 * createNotebookCellExecution() succeeds.
 *
 * Root cause of the "first N probes return ok:true but value:null" bug:
 *   updateNotebookAffinity(Preferred) alone does NOT trigger
 *   onDidChangeSelectedNotebooks for a notebook that is open but not the
 *   active editor — VS Code only auto-selects based on affinity when the
 *   notebook is shown and active.  Without a real selection event,
 *   createNotebookCellExecution() throws "not associated", the 2-second
 *   recovery in execute() times out, the cell is silently skipped, and
 *   evalInNotebook returns { ok: true, value: null }.
 *
 * Fix: show the document with preserveFocus:true (so it becomes the active
 * editor without stealing keyboard focus), then call notebook.selectKernel
 * with our specific id/extension — the silent, no-picker form that reliably
 * triggers onDidChangeSelectedNotebooks for the now-active notebook.
 */
async function associateNotebook(nbDoc) {
    const vscode = (() => { try { return require('vscode'); } catch (_) { return null; } })();
    if (!vscode) return;
    const ks = kernelStatus();
    if (!ks.available) return;
    const ctrl = ks.controller;
    if (ctrl.selectedNotebooks.has(nbDoc)) return;

    // Set affinity so VS Code prefers us for future opens of this notebook type.
    try {
        ctrl._controller.updateNotebookAffinity(
            nbDoc, vscode.NotebookControllerAffinity.Preferred);
    } catch (_) {}

    // Show the notebook as the active editor (preserveFocus so the user's
    // keyboard focus stays where it is).  This is required because
    // notebook.selectKernel operates on the currently active notebook editor.
    try {
        await vscode.window.showNotebookDocument(nbDoc, {
            viewColumn:    vscode.ViewColumn.Active,
            preserveFocus: true,
        });
    } catch (_) {}

    // notebook.selectKernel with id+extension silently selects our controller
    // for the now-active notebook.  Wait for onDidChangeSelectedNotebooks
    // confirming the specific notebook was selected (not some other tab).
    if (!ctrl.selectedNotebooks.has(nbDoc)) {
        const nbUri = nbDoc.uri.toString();
        await new Promise(resolve => {
            const d = ctrl._controller.onDidChangeSelectedNotebooks(ev => {
                if (ev.selected && ev.notebook.uri.toString() === nbUri) {
                    d.dispose(); resolve();
                }
            });
            vscode.commands.executeCommand('notebook.selectKernel', {
                id:        ctrl._controller.id,
                extension: 'wolfbook.wolfbook',
                label:     ctrl._controller.label,
            }).then(undefined, () => {});
            // Fallback poll in case the event fires before the listener is registered.
            const check = () => {
                if (ctrl.selectedNotebooks.has(nbDoc)) { d.dispose(); resolve(); return; }
                setTimeout(check, 50);
            };
            setTimeout(check, 50);
            setTimeout(() => { d.dispose(); resolve(); }, 3000);
        });
    }
}

// ── Agent-view side channel (Oberon-only, on-demand) ─────────────────────────
//
// After a probe cell renders for the HUMAN (rich LaTeX/boxes — unchanged), the
// agent gets a separate, compact view of the SAME result: a capped InputForm
// string + a kernel-computed "shape" line (Head, dims, numeric?, leaf count, and
// a flag for unevaluated formal heads like CircleTimes). This is computed by ONE
// extra non-interactive evaluation that reads Out[$Line-1] — the cell's result —
// so the agent's code is NOT re-run (no double side effects) and $Line is not
// perturbed. It runs ONLY when callers pass opts.agentView (i.e. the fairy probe
// path); ordinary interactive notebooks never trigger it, so general wolfbook use
// is unaffected.
//
// The helper is self-seeding (idempotent, survives kernel restart): the defs are
// installed once behind a guard, then the view is returned as a JSON string.
const AGENT_VIEW_SEED =
    'If[!TrueQ[WolfbookAgent`seeded],' +
    'WolfbookAgent`shape[expr_]:=Module[{h=Head[expr],dims=Dimensions[expr],lc=LeafCount[expr],found,keys},' +
    'found=DeleteCases[Map[Function[s,{SymbolName[s],Count[expr,Blank[s],Infinity]}],{CircleTimes,TensorProduct,Inactive,HoldForm,Defer}],{_,0}];' +
    'keys=If[AssociationQ[expr]," {"<>StringRiffle[ToString/@Keys[expr],","]<>"}",""];' +
    'StringJoin[SymbolName[h],' +
    'If[ArrayQ[expr]&&dims=!={}," "<>StringRiffle[ToString/@dims,"x"],""],' +
    'keys,' +
    'If[ArrayQ[expr],If[ArrayQ[expr,_,NumericQ]," numeric"," NON-numeric(symbolic)"],""],' +
    '" leaves="<>ToString[lc],' +
    'If[found=!={}," unevaluated{"<>StringRiffle[(#[[1]]<>"x"<>ToString[#[[2]]])&/@found,","]<>"}",""]]];' +
    'WolfbookAgent`view[n_,cap_]:=Module[{r=Out[n],iv},iv=ToString[r,InputForm];' +
    'ExportString[<|"iv"->StringTake[iv,UpTo[cap]],"len"->StringLength[iv],"shape"->WolfbookAgent`shape[r]|>,"JSON"]];' +
    'WolfbookAgent`seeded=True];';

/**
 * Compute the agent-facing view (capped InputForm + shape line) of a cell result
 * via one non-interactive kernel evaluation. Prefers an explicit `outN` (parsed from
 * the cell's "Out[N]=" output line — deterministic); falls back to $Line-1. Never
 * throws; returns null on any failure so callers keep the human/LaTeX value.
 * @param {object} controller
 * @param {number} cap
 * @param {number|null} outN  the kernel Out[] line of the result, if known
 * @returns {Promise<{ inputForm:string, length:number, shape:string }|null>}
 */
/**
 * Decode a "byte string" (all code points ≤ 0xFF, produced when a UTF-8 byte
 * stream is wrapped char-per-byte, e.g. by ExportString[..., "JSON"]) back to
 * proper UTF-8 text. Returns the input unchanged when it is not byte-shaped or
 * when the bytes are not valid UTF-8 (no U+FFFD is ever introduced).
 * @param {string} s
 * @returns {string}
 */
function decodeUtf8ByteString(s) {
    if (typeof s !== 'string') return s;
    let hasHigh = false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 0xFF) return s;          // real Unicode text, not a byte stream
        if (c >= 0x80) hasHigh = true;
    }
    if (!hasHigh) return s;              // pure ASCII — nothing to decode
    const decoded = Buffer.from(s, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? s : decoded;
}

async function computeAgentView(controller, cap = 300, outN = null) {
    try {
        if (!controller || !controller.session) return null;
        const target = (Number.isInteger(outN) && outN > 0) ? String(outN) : '$Line-1';
        const expr = `(${AGENT_VIEW_SEED} WolfbookAgent\`view[${target}, ${cap}])`;
        const res = await controller.session.evaluate(expr, { interactive: false });
        const r = res && res.result;
        if (!r || r.type !== 'string' || typeof r.value !== 'string') return null;
        // ExportString[..., "JSON"] returns a BYTE string: every non-ASCII char in the
        // payload arrives as its UTF-8 bytes mapped to U+0080–U+00FF code points ("≈" →
        // "â"). Parsing that directly mojibakes every recorded probe output,
        // which then fails self-verification against a clean re-eval (run Q25: confidence
        // demoted to 0.6 on all three charms from this alone). Re-decode before parsing.
        const parsed = JSON.parse(decodeUtf8ByteString(r.value));
        if (!parsed || typeof parsed.shape !== 'string') return null;
        return {
            inputForm: String(parsed.iv != null ? parsed.iv : ''),
            length:    Number(parsed.len) || 0,
            shape:     parsed.shape,
        };
    } catch (_) {
        return null;
    }
}

async function evalInNotebook(nbDoc, code, opts = {}) {
    if (!nbDoc) return { ok: false, kind: 'kernel_unavailable', value: null, durationMs: 0, messages: null, prints: null };
    const vscode = (() => { try { return require('vscode'); } catch (_) { return null; } })();
    if (!vscode) return { ok: false, kind: 'kernel_unavailable', value: null, durationMs: 0, messages: null, prints: null };
    const { TextDecoder } = require('util');
    const decoder = new TextDecoder();

    const { timeoutSeconds = DEFAULT_TIMEOUT, signal, note = null, probeId = null, prevAnalysis = null, agentView = false } = opts;
    const t0 = Date.now();

    const ks = kernelStatus();
    if (!ks.available) {
        return { ok: false, kind: 'kernel_unavailable', value: null, durationMs: Date.now() - t0, messages: null, prints: null };
    }
    const ctrl = ks.controller;

    // Guarantee controller association before attempting execution.
    // updateNotebookAffinity(Preferred) is the VS Code-blessed way to auto-select
    // a controller for a notebook without showing the kernel picker.
    if (!ctrl.selectedNotebooks.has(nbDoc)) {
        await associateNotebook(nbDoc);
    }

    // Build cells: optional reflection on previous probe, optional note title, then code cell.
    const cells = [];
    if (prevAnalysis) {
        cells.push(new vscode.NotebookCellData(
            vscode.NotebookCellKind.Markup,
            `> ${prevAnalysis}`,
            'markdown',
        ));
    }
    if (note) {
        const probeLabel = probeId ? `**Probe ${parseInt(probeId.replace(/^\D+/, ''), 10) || probeId}**\n\n` : '';
        cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, `${probeLabel}${note}`, 'markdown'));
    }
    cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'wolfram'));

    // Insert BEFORE a trailing pinned status cell so the status box stays last and is
    // never re-pinned (which is what made the notebook jump). Otherwise append at end.
    let insertIdx = nbDoc.cellCount;
    try {
        if (insertIdx > 0) {
            const lastCell = nbDoc.cellAt(insertIdx - 1);
            if (lastCell && lastCell.metadata && lastCell.metadata.oberon === 'status') insertIdx -= 1;
        }
    } catch (_) {}
    const edit = new vscode.WorkspaceEdit();
    edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(insertIdx, cells)]);
    await vscode.workspace.applyEdit(edit);

    // Code cell is always the last in cells[]; its index is insertIdx + cells.length - 1.
    const codeIdx = insertIdx + cells.length - 1;
    const liveCell = nbDoc.cellAt(codeIdx);

    ctrl._silentExecution = true;
    ctrl._wolframExecPending = true;
    try { ctrl.execute([liveCell], nbDoc, ctrl._controller); } catch (_) {}
    ctrl._silentExecution = false;

    const timeoutMs = timeoutSeconds * 1000;
    const deadline  = t0 + timeoutMs;

    await new Promise(resolve => {
        let seenIdle = false;
        const poll = () => {
            if (signal && signal.aborted) { resolve(); return; }
            const idle = !ctrl._evalDispatched && ctrl.executionQueue.queueLength() === 0;
            if (idle) {
                if (!seenIdle) { seenIdle = true; setTimeout(poll, 200); return; }
                resolve();
            } else {
                seenIdle = false;
                if (Date.now() >= deadline) { resolve(); return; }
                setTimeout(poll, 200);
            }
        };
        // 500ms initial wait — enough for checkoutExecutionQueue to set _evalDispatched.
        setTimeout(poll, 500);
    });

    const durationMs = Date.now() - t0;

    if (signal && signal.aborted) {
        return { ok: false, kind: 'aborted', value: null, durationMs, messages: null, prints: null };
    }
    if (durationMs >= timeoutMs) {
        return { ok: false, kind: 'timeout', value: null, durationMs, messages: null, prints: null };
    }

    // Read text result from cell outputs.
    const updatedCell = nbDoc.cellAt(codeIdx);
    const outs = [];
    let errMime = false;
    for (const output of updatedCell.outputs) {
        const mimes = output.items.map(it => it.mime);
        if (mimes.includes('application/vnd.code.notebook.error')) errMime = true;
        const plainItem = output.items.find(it => it.mime === 'text/plain');
        if (plainItem) {
            try {
                const txt = decoder.decode(plainItem.data).trim();
                if (txt) outs.push(txt);
            } catch (_) {}
        }
    }

    const raw = outs.join('\n');
    // A probe FAILS on a runtime error or any CRITICAL kernel message. Non-critical
    // convergence/tolerance warnings (FindRoot::lstol, …) do NOT fail it — the result
    // is kept and the warning is surfaced so the agent verifies the residual.
    const cls = classifyMessages(raw);
    const hasError = errMime || cls.critical.length > 0;
    const softWarning = (!hasError && cls.soft.length) ? cls.soft.join(', ') : null;
    const truncated = raw.length > OUTPUT_HARD_CAP;
    const value = raw.length ? (truncated ? raw.slice(0, OUTPUT_HARD_CAP) : raw) : null;

    // Agent-view side channel: on-demand only (opts.agentView), and only for a clean
    // result. The human cell rendering above is left exactly as-is; this is one extra
    // non-interactive read of the cell's Out[N] to give the agent InputForm + a shape
    // line. outN is parsed from the cell's own "Out[N]=" output text (deterministic);
    // computeAgentView falls back to $Line-1 if it's not present.
    let agentValue = null, agentValueLen = 0, agentShape = null, multiOutput = false;
    if (agentView && !hasError) {
        // A multi-statement cell produces several Out[N] lines. The agent view must
        // mirror what a re-evaluation of the WHOLE cell returns — the LAST expression's
        // value (CompoundExpression semantics) — so parse the LAST Out[N], not the
        // first. Run Q32: agentValue picked Out[91] ("216") while the self-verify
        // recheck returned Out[94]'s value → guaranteed false mismatch → 0.45 cascade.
        const outMatches = [...raw.matchAll(/(?:^|\n)\s*Out\[(\d+)\]/g)];
        multiOutput = outMatches.length > 1;
        const outN = outMatches.length ? parseInt(outMatches[outMatches.length - 1][1], 10) : null;
        const av = await computeAgentView(ctrl, 300, outN);
        if (av) { agentValue = av.inputForm; agentValueLen = av.length; agentShape = av.shape; }
    }

    return {
        ok:             !hasError,
        kind:           hasError ? 'error' : 'ok',
        value,
        truncated,
        originalLength: raw.length,
        durationMs,
        messages:       hasError ? value : null,
        softWarning,
        prints:         null,
        agentValue,
        agentValueLen,
        agentShape,
        multiOutput,
    };
}

/**
 * Delete the last `count` cells from an already-open VS Code notebook document.
 * Used to remove failed-probe cells (those that produced kernel messages) from
 * the working notebook so they don't clutter the exploration history.
 */
async function removeLastCells(nbDoc, count) {
    if (!nbDoc || count <= 0) return;
    const vscode = (() => { try { return require('vscode'); } catch (_) { return null; } })();
    if (!vscode) return;
    const startIdx = nbDoc.cellCount - count;
    if (startIdx < 0) return;
    const edit = new vscode.WorkspaceEdit();
    edit.set(nbDoc.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(startIdx, nbDoc.cellCount))]);
    await vscode.workspace.applyEdit(edit).catch(() => {});
}

module.exports = { setControllerProvider, setPostRestartSeeder, kernelStatus, evalOnce, associateNotebook, evalInNotebook, computeAgentView, decodeUtf8ByteString, removeLastCells, restartKernel, replayNotebook, runNotebook, editNotebookCell, classifyMessages, buildSuppressionCode, NON_CRITICAL_MESSAGE_TAGS, OUTPUT_HARD_CAP, MAX_TIMEOUT, DEFAULT_TIMEOUT, AGENT_VIEW_SEED };
