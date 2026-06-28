'use strict';
/**
 * Oberon — Mathematica verification primitives (MVP-4).
 *
 * Tiny structured wrapper around `core/wolframShim.evalOnce` that exposes a
 * handful of *verification-grade* operations used by the Ward runner. None
 * of these functions are a security boundary — they evaluate Wolfram
 * Language in the *same* live kernel as the user's notebook. This is
 * "controlled automation for trusted local use", NOT a sandbox.
 *
 * All operations:
 *   - are timeout-bounded (via the shim's TimeConstrained + hard backstop),
 *   - honour an AbortSignal,
 *   - return bounded, structured output (no unbounded transcripts),
 *   - never throw on Wolfram errors — they return `{ ok: false, ... }`.
 *
 * A small *literal* denylist filters out the obvious things (`Run`, `DeleteFile`,
 * `URLDownload`, `RunProcess`, `Import["!..."]`, etc.).  This is a tripwire,
 * not a sandbox: a determined adversary can trivially bypass it.  Callers
 * that need real isolation must use an external sandbox.
 */

const wolframShim = require('../core/wolframShim');

const DEFAULT_TIMEOUT_S = 15;

// Conservative literal denylist — substring match, case-sensitive (WL is
// case-sensitive).  Tripwire only.
const DENY_TOKENS = [
    'Run[', 'RunProcess[', 'StartProcess[',
    'DeleteFile[', 'DeleteDirectory[', 'CopyFile[', 'RenameFile[',
    'URLDownload[', 'URLExecute[', 'URLFetch[', 'URLRead[',
    'Import["!',  'Import[\'!',
    'CreateFile[', 'WriteString[',
    'SystemOpen[',
    'Export[',  // arbitrary path writes
];

function denylistViolation(expr) {
    if (typeof expr !== 'string') return null;
    for (const tok of DENY_TOKENS) {
        if (expr.indexOf(tok) !== -1) return tok;
    }
    return null;
}

/**
 * Symbolic identity check.  Returns `equal: true` only when Wolfram can
 * prove `lhs - rhs == 0`; `false` only when it produces a non-zero
 * canonical residual; `null` when the result is symbolic and unresolved.
 *
 * @param {{ lhs: string, rhs: string, timeoutSeconds?: number, signal?: AbortSignal }} args
 * @returns {Promise<{
 *   ok: boolean, equal: boolean|null, residual: string|null, raw: string|null,
 *   durationMs: number, kind: string, error: string|null
 * }>}
 */
async function symbolicSimplify({ lhs, rhs, timeoutSeconds = DEFAULT_TIMEOUT_S, signal } = {}) {
    if (typeof lhs !== 'string' || !lhs.trim() || typeof rhs !== 'string' || !rhs.trim()) {
        return mk({ ok: false, equal: null, residual: null, raw: null, durationMs: 0, kind: 'bad_args', error: 'lhs/rhs must be non-empty strings' });
    }
    const combined = `(${lhs}) - (${rhs})`;
    const deny = denylistViolation(combined);
    if (deny) {
        return mk({ ok: false, equal: null, residual: null, raw: null, durationMs: 0, kind: 'denied', error: `expression contains denied token: ${deny}` });
    }
    // We ask for both a normalised residual AND a PossibleZeroQ flag so we can
    // distinguish "provably zero" from "couldn't simplify".
    const wl =
        `Module[{r$, z$}, ` +
            `r$ = FullSimplify[(${lhs}) - (${rhs})]; ` +
            `z$ = TrueQ[PossibleZeroQ[r$]]; ` +
            `{If[z$, "ZERO", "NONZERO"], ToString[r$, InputForm]}` +
        `]`;
    const r = await wolframShim.evalOnce({ expression: wl, timeoutSeconds, signal });
    if (!r.ok) {
        return mk({ ok: false, equal: null, residual: null, raw: r.value, durationMs: r.durationMs, kind: r.kind, error: r.error });
    }
    const parsed = parseTwoElementList(r.value);
    if (!parsed) {
        return mk({ ok: true, equal: null, residual: null, raw: r.value, durationMs: r.durationMs, kind: 'unparsed', error: null });
    }
    const [flag, residual] = parsed;
    if (flag === 'ZERO') {
        return mk({ ok: true, equal: true, residual: '0', raw: r.value, durationMs: r.durationMs, kind: 'ok', error: null });
    }
    if (flag === 'NONZERO') {
        // Try a cheap second opinion — if the residual is a literal number != 0
        // we report equal=false; otherwise unresolved.
        const num = parseFloat(residual);
        if (Number.isFinite(num)) {
            return mk({ ok: true, equal: num === 0, residual, raw: r.value, durationMs: r.durationMs, kind: 'ok', error: null });
        }
        return mk({ ok: true, equal: null, residual, raw: r.value, durationMs: r.durationMs, kind: 'unresolved', error: null });
    }
    return mk({ ok: true, equal: null, residual, raw: r.value, durationMs: r.durationMs, kind: 'unparsed', error: null });
}

/**
 * Numeric probe.  Evaluates `expression`, parses it as a real number, and
 * compares to `expected` within `tolerance` (relative + absolute).
 *
 * Working precision: by default the Critic re-evaluates at 20 digits. If the
 * expression itself contains an explicit precision hint (e.g. `N[expr, 80]`
 * or `WorkingPrecision -> 80`), that precision is used instead, so the
 * Critic doesn't accidentally re-check a high-precision claim at machine
 * precision and dispute a perfectly correct residual.
 *
 * @param {{ expression: string, expected: number, tolerance?: number,
 *           workingPrecision?: number,
 *           timeoutSeconds?: number, signal?: AbortSignal }} args
 */
async function numericProbe({ expression, expected, tolerance = 1e-8, workingPrecision, timeoutSeconds = DEFAULT_TIMEOUT_S, signal } = {}) {
    if (typeof expression !== 'string' || !expression.trim()) {
        return mkN({ ok: false, withinTol: null, value: null, diff: null, durationMs: 0, kind: 'bad_args', error: 'expression must be a non-empty string' });
    }
    if (typeof expected !== 'number' || !Number.isFinite(expected)) {
        return mkN({ ok: false, withinTol: null, value: null, diff: null, durationMs: 0, kind: 'bad_args', error: 'expected must be a finite number' });
    }
    const deny = denylistViolation(expression);
    if (deny) {
        return mkN({ ok: false, withinTol: null, value: null, diff: null, durationMs: 0, kind: 'denied', error: `expression contains denied token: ${deny}` });
    }
    // Pick re-eval precision: explicit `workingPrecision` wins; otherwise
    // try to extract a hint from the expression; otherwise 20 digits.
    const prec = Math.max(15, Math.min(200, Number(workingPrecision) || detectDeclaredPrecision(expression) || 20));
    const wl = `ToString[N[${expression}, ${prec}], InputForm]`;
    const r = await wolframShim.evalOnce({ expression: wl, timeoutSeconds, signal });
    if (!r.ok) {
        return mkN({ ok: false, withinTol: null, value: null, diff: null, durationMs: r.durationMs, kind: r.kind, error: r.error });
    }
    const raw = String(r.value || '').trim().replace(/^"|"$/g, '');
    const num = parseFloat(raw);
    if (!Number.isFinite(num)) {
        return mkN({ ok: true, withinTol: null, value: raw, diff: null, durationMs: r.durationMs, kind: 'non_numeric', error: null });
    }
    const diff = Math.abs(num - expected);
    const tol  = Math.max(tolerance, tolerance * Math.max(Math.abs(num), Math.abs(expected)));
    return mkN({
        ok: true,
        withinTol: diff <= tol,
        value: num,
        diff,
        durationMs: r.durationMs,
        kind: 'ok',
        error: null,
    });
}

/**
 * Best-effort extraction of a declared precision hint from a WL expression.
 * Returns an integer P, or null if no hint is present.
 *
 *   N[expr, 80]                  → 80
 *   N[expr, 80.]                 → 80
 *   WorkingPrecision -> 100      → 100
 *   SetPrecision[expr, 50]       → 50
 *   $MinPrecision = 60           → 60   (rare; still informative)
 */
function detectDeclaredPrecision(expr) {
    if (typeof expr !== 'string') return null;
    const candidates = [];
    const re1 = /\bN\s*\[\s*[^,\[\]]*(?:\[[^\]]*\])?[^,]*,\s*(\d{2,4})/g;
    const re2 = /WorkingPrecision\s*->\s*(\d{2,4})/g;
    const re3 = /SetPrecision\s*\[[^,]+,\s*(\d{2,4})/g;
    const re4 = /\$MinPrecision\s*=\s*(\d{2,4})/g;
    for (const re of [re1, re2, re3, re4]) {
        let m;
        while ((m = re.exec(expr)) !== null) {
            const p = parseInt(m[1], 10);
            if (Number.isFinite(p) && p >= 16 && p <= 5000) candidates.push(p);
        }
    }
    if (!candidates.length) return null;
    return Math.max(...candidates);
}

/**
 * Evaluate a Wolfram boolean expression; expects True/False.
 *
 * @param {{ expression: string, timeoutSeconds?: number, signal?: AbortSignal }} args
 * @returns {Promise<{ ok: boolean, value: boolean|null, raw: string|null, durationMs: number, kind: string, error: string|null }>}
 */
async function evaluateBoolean({ expression, timeoutSeconds = DEFAULT_TIMEOUT_S, signal } = {}) {
    if (typeof expression !== 'string' || !expression.trim()) {
        return { ok: false, value: null, raw: null, durationMs: 0, kind: 'bad_args', error: 'expression must be a non-empty string' };
    }
    const deny = denylistViolation(expression);
    if (deny) {
        return { ok: false, value: null, raw: null, durationMs: 0, kind: 'denied', error: `expression contains denied token: ${deny}` };
    }
    const wl = `ToString[(${expression}) /. {True -> "TRUE", False -> "FALSE"}]`;
    const r = await wolframShim.evalOnce({ expression: wl, timeoutSeconds, signal });
    if (!r.ok) {
        return { ok: false, value: null, raw: r.value, durationMs: r.durationMs, kind: r.kind, error: r.error };
    }
    const raw = String(r.value || '').trim();
    if (raw === 'TRUE')  return { ok: true, value: true,  raw, durationMs: r.durationMs, kind: 'ok', error: null };
    if (raw === 'FALSE') return { ok: true, value: false, raw, durationMs: r.durationMs, kind: 'ok', error: null };
    return { ok: true, value: null, raw, durationMs: r.durationMs, kind: 'non_boolean', error: null };
}

/**
 * Numeric random testing of an algebraic equality.
 *
 * Substitutes each free symbol in `lhs - rhs` with a uniformly-drawn real on
 * `[-range, range]`, evaluates the residual numerically at high precision,
 * and reports whether |residual| < tolerance.  Repeated `samples` times.
 *
 * This is a *useful* but FALLIBLE check: a passing random test does NOT
 * prove the identity, only that it survived the sampled inputs.  A failing
 * sample is a strong disproof (modulo numerical precision).
 *
 * Returns `withinTol: 'all' | 'some' | 'none' | null` and the worst-case
 * residual seen.
 *
 * @param {{ lhs:string, rhs:string, samples?:number, range?:number,
 *           tolerance?:number, timeoutSeconds?:number, signal?:AbortSignal }} args
 * @returns {Promise<{
 *   ok:boolean, withinTol: 'all'|'some'|'none'|null,
 *   samples:number, passed:number, failed:number, skipped:number,
 *   worstResidual: number|null, durationMs:number, kind:string, error:string|null
 * }>}
 */
async function numericRandomTest({
    lhs, rhs, samples = 3, range = 3, tolerance = 1e-6,
    timeoutSeconds = DEFAULT_TIMEOUT_S, signal,
} = {}) {
    const empty = (kind, error) => ({
        ok: false, withinTol: null, samples: 0, passed: 0, failed: 0, skipped: 0,
        worstResidual: null, durationMs: 0, kind, error,
    });
    if (typeof lhs !== 'string' || !lhs.trim() || typeof rhs !== 'string' || !rhs.trim()) {
        return empty('bad_args', 'lhs/rhs must be non-empty strings');
    }
    const combined = `(${lhs}) - (${rhs})`;
    const deny = denylistViolation(combined);
    if (deny) return empty('denied', `expression contains denied token: ${deny}`);

    const n   = Math.max(1, Math.min(8, samples|0));
    const rng = Math.max(0.1, Math.min(1e6, +range || 3));
    const tol = Math.max(0, +tolerance || 1e-6);

    // Build a WL one-shot:
    //   Module[{res$ = (lhs) - (rhs), syms$, out$},
    //     syms$ = DeleteDuplicates @ Cases[res$, _Symbol, {0, Infinity}];
    //     syms$ = Select[syms$, Context[#] === "Global`" &];
    //     out$ = Table[
    //       Block[{r$},
    //         r$ = N[res$ /. Thread[syms$ -> RandomReal[{-RNG, RNG}, Length[syms$]]], 20];
    //         If[NumericQ[r$] && Im[r$] == 0, Abs[r$], "SKIP"]
    //       ], {N}];
    //     ToString[out$, InputForm]
    //   ]
    const wl =
        `Module[{res$, syms$, out$}, ` +
            `res$ = (${lhs}) - (${rhs}); ` +
            `syms$ = DeleteDuplicates@Cases[res$, _Symbol, {0, Infinity}]; ` +
            `syms$ = Select[syms$, Context[#] === "Global\`" &]; ` +
            `out$ = Table[ ` +
                `Block[{r$}, ` +
                    `r$ = N[res$ /. Thread[syms$ -> RandomReal[{-${rng}, ${rng}}, Length[syms$]]], 20]; ` +
                    `If[NumericQ[r$] && Im[r$] === 0, Abs[r$], "SKIP"]` +
                `], {${n}}]; ` +
            `ToString[out$, InputForm]` +
        `]`;

    const r = await wolframShim.evalOnce({ expression: wl, timeoutSeconds, signal });
    if (!r.ok) return { ok: false, withinTol: null, samples: n, passed: 0, failed: 0, skipped: n,
                        worstResidual: null, durationMs: r.durationMs || 0, kind: r.kind, error: r.error };

    const raw = String(r.value || '').trim();
    // Expect like: {0.0000…, 1.23e-22, "SKIP"}
    const inner = raw.replace(/^\{\s*|\s*\}$/g, '');
    if (!inner) {
        return { ok: true, withinTol: null, samples: n, passed: 0, failed: 0, skipped: n,
                 worstResidual: null, durationMs: r.durationMs || 0, kind: 'empty', error: null };
    }
    const parts = inner.split(',').map(s => s.trim());
    let passed = 0, failed = 0, skipped = 0, worst = null;
    for (const p of parts) {
        if (p === '"SKIP"' || p === 'SKIP') { skipped++; continue; }
        const x = parseFloat(p);
        if (!Number.isFinite(x)) { skipped++; continue; }
        if (worst == null || x > worst) worst = x;
        if (x <= tol) passed++; else failed++;
    }
    const checked = passed + failed;
    let withinTol = null;
    if (checked === 0) withinTol = null;
    else if (failed === 0) withinTol = 'all';
    else if (passed === 0) withinTol = 'none';
    else withinTol = 'some';
    return {
        ok: true, withinTol,
        samples: n, passed, failed, skipped,
        worstResidual: worst,
        durationMs: r.durationMs || 0,
        kind: 'ok', error: null,
    };
}

/**
 * Fresh-kernel verification (not yet supported).
 *
 * The existing `WolframNotebookKernel` controller is a single shared
 * session; spawning a second isolated kernel is a larger refactor (would
 * need a second WSTP session + lifecycle ownership).  Documented stub
 * returns `supported: false` so callers can degrade cleanly.  When this
 * is implemented, Wards should re-verify on the fresh kernel to rule out
 * state pollution by the Fairy.
 *
 * @returns {{ supported: false, reason: string }}
 */
function freshKernel() {
    return { supported: false, reason: 'shared_kernel_only — multi-session WSTP not yet wired (planned MVP-5+)' };
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseTwoElementList(s) {
    if (typeof s !== 'string') return null;
    // Expect: {"ZERO", "...residual..."} or {"NONZERO", "...residual..."}
    const m = s.match(/^\s*\{\s*"(ZERO|NONZERO)"\s*,\s*"([\s\S]*)"\s*\}\s*$/);
    if (!m) return null;
    // Unescape inner quotes / backslashes from InputForm.
    const residual = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return [m[1], residual];
}

function mk(o) {
    return {
        ok: !!o.ok,
        equal: typeof o.equal === 'boolean' ? o.equal : null,
        residual: o.residual == null ? null : String(o.residual).slice(0, 800),
        raw: o.raw == null ? null : String(o.raw).slice(0, 800),
        durationMs: o.durationMs || 0,
        kind: o.kind || 'unknown',
        error: o.error || null,
    };
}

function mkN(o) {
    return {
        ok: !!o.ok,
        withinTol: typeof o.withinTol === 'boolean' ? o.withinTol : null,
        value: o.value == null ? null : o.value,
        diff: typeof o.diff === 'number' ? o.diff : null,
        durationMs: o.durationMs || 0,
        kind: o.kind || 'unknown',
        error: o.error || null,
    };
}

module.exports = {
    symbolicSimplify,
    numericProbe,
    numericRandomTest,
    evaluateBoolean,
    freshKernel,
    denylistViolation,
    DENY_TOKENS,
};
