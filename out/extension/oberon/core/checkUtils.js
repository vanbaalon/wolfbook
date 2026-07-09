'use strict';
/**
 * Oberon — shared check utilities (S3.1).
 *
 * Pure helpers used by BOTH `skeptic.js` and `wards.js` for evidence
 * post-processing. Extracted to eliminate ~50 lines of duplicated code
 * and to give a single point-of-edit for tunables such as
 * `EXPR_PREVIEW_CHARS`.
 *
 * Pure helpers here have no side effects. `findUndefinedCheckSymbols` is the
 * one kernel-touching helper (it probes the live kernel via wolframShim) — it
 * lives here because it is a validation-check utility shared by run_clean /
 * probe adjudication, and its former home (skeptic.js) was removed.
 */

const wolframShim = require('./wolframShim');

const EXPR_PREVIEW_CHARS = 240;

/**
 * Whitespace-collapsed, length-capped preview of an expression. Returns
 * `null` for empty / falsy input so callers can chain optional usage.
 *
 * @param {unknown} s
 * @returns {string|null}
 */
function previewExpr(s) {
    if (!s) return null;
    return String(s).replace(/\s+/g, ' ').slice(0, EXPR_PREVIEW_CHARS);
}

/**
 * Truncate a string to `n` chars with a trailing ellipsis. Returns ''
 * for null/undefined.
 *
 * @param {unknown} s
 * @param {number}  n
 * @returns {string}
 */
function truncate(s, n) {
    if (s == null) return '';
    const str = String(s);
    return str.length <= n ? str : str.slice(0, n) + '…';
}

/**
 * Parse a string into a finite number if it represents a plain numeric
 * literal (decimal / exponent allowed). Returns `null` otherwise.
 *
 * Deliberately strict: rejects things like "Sqrt[2]", "Pi", "I", or
 * any expression with letters — those need symbolic evaluation, not
 * `parseFloat`. Without the guard, `parseFloat("12 + Pi")` would
 * silently return 12 and produce wrong downstream checks.
 *
 * @param {unknown} s
 * @returns {number|null}
 */
function parseFiniteNumber(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!/^[+-]?[\d.eE+\-]+$/.test(t)) return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
}

/**
 * Pretty-print a number for use in human-readable check messages.
 * Falls back to `String()` if input is not a number.
 *
 * @param {unknown} n
 * @returns {string}
 */
function formatNum(n) {
    if (n == null) return '?';
    if (typeof n !== 'number') return String(n);
    if (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6) return n.toExponential(4);
    return Number(n.toPrecision(8)).toString();
}

/**
 * Split a string at the top-level `==` if one exists, ignoring `===`,
 * `!=`, `<=`, `>=` and any `==` inside (), [], or {}.  Returns null if
 * no unambiguous top-level equality is found.
 *
 * @param {string} expr
 * @returns {{lhs: string, rhs: string} | null}
 */
function splitTopLevelEquality(expr) {
    let depth = 0;
    for (let i = 0; i < expr.length - 1; i++) {
        const c = expr[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        if (depth !== 0) continue;
        if (c === '=' && expr[i + 1] === '=') {
            // Disallow ===, <=, >=, != at this position.
            if (expr[i + 2] === '=') return null;
            if (i > 0 && (expr[i - 1] === '<' || expr[i - 1] === '>' || expr[i - 1] === '!')) continue;
            const lhs = expr.slice(0, i).trim();
            const rhs = expr.slice(i + 2).trim();
            if (lhs && rhs) return { lhs, rhs };
            return null;
        }
    }
    return null;
}

/**
 * Return the symbols in a validation-check expression that are undefined in
 * the live kernel: snake_case tokens (WL pattern names, never symbols) plus
 * plain tokens that are neither System` builtins nor carry any own/down/up
 * values. A check referencing any of these is not adjudicable and should be
 * skipped rather than disputed. Fail-open: kernel errors return only the
 * deterministic snake_case set. (Relocated from the removed skeptic.js; the
 * Q29 fix — shared by run_clean + probe adjudication in fairy/tools.js.)
 *
 * @param {string} expr
 * @param {AbortSignal|null} signal
 * @returns {Promise<string[]>}
 */
async function findUndefinedCheckSymbols(expr, signal) {
    const noStrings = String(expr || '').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    const tokens = [...new Set((noStrings.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*/g) || []))];
    const snake  = tokens.filter(t => /_[a-z]/.test(t));
    const plain  = tokens.filter(t => !t.includes('_'));
    const undef  = [...snake];
    if (plain.length) {
        const listWL = '{' + plain.map(t => `"${t}"`).join(', ') + '}';
        const probe =
            `Select[${listWL}, Function[n, !NameQ["System\`" <> n] && ` +
            `ToExpression[n, InputForm, Function[s, OwnValues[s] === {} && DownValues[s] === {} && UpValues[s] === {}, HoldAll]] === True]]`;
        try {
            const r = await wolframShim.evalOnce({ expression: probe, timeoutSeconds: 10, signal });
            if (r && r.ok && typeof r.value === 'string') {
                for (const m of r.value.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)) undef.push(m[1]);
            }
        } catch (_) { /* fail-open */ }
    }
    return undef;
}

module.exports = {
    EXPR_PREVIEW_CHARS,
    previewExpr,
    truncate,
    parseFiniteNumber,
    formatNum,
    splitTopLevelEquality,
    findUndefinedCheckSymbols,
};
