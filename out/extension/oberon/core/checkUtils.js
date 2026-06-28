'use strict';
/**
 * Oberon — shared check utilities (S3.1).
 *
 * Pure helpers used by BOTH `skeptic.js` and `wards.js` for evidence
 * post-processing. Extracted to eliminate ~50 lines of duplicated code
 * and to give a single point-of-edit for tunables such as
 * `EXPR_PREVIEW_CHARS`.
 *
 * No side effects, no external deps. Safe to import from anywhere.
 */

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

module.exports = {
    EXPR_PREVIEW_CHARS,
    previewExpr,
    truncate,
    parseFiniteNumber,
    formatNum,
    splitTopLevelEquality,
};
