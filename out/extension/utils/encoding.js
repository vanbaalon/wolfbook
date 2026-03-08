"use strict";
/*
 * utils/encoding.js — Wolfbook string encoding / escaping utilities
 *
 * Pure functions with no external dependencies; safe to call from any context.
 */

/**
 * escapeHtml — escape a string for safe HTML embedding.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * decodeWolframOctal — decode WSTP's C-style octal byte sequences back to Unicode.
 *
 * WSTP emits non-ASCII text as raw UTF-8 bytes encoded as \NNN octal sequences,
 * e.g. λ → \316\273 (bytes 0xCE 0xBB).  Consecutive \NNN sequences form a
 * single multi-byte character and must be decoded as one UTF-8 unit.
 * @param {string} s
 * @returns {string}
 */
function decodeWolframOctal(s) {
    return String(s).replace(/(\\[0-7]{3})+/g, match => {
        const bytes = [];
        for (let i = 0; i < match.length; i += 4) {
            bytes.push(parseInt(match.slice(i + 1, i + 4), 8));
        }
        try {
            return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
        } catch (_) {
            return match;   // leave as-is if invalid UTF-8
        }
    });
}

/**
 * escapeWL — escape a JS string for embedding inside a Wolfram string literal
 * (wrapping double-quotes and backslashes).
 * @param {string} code
 * @returns {string}
 */
function escapeWL(code) {
    return code.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

module.exports = { escapeHtml, decodeWolframOctal, escapeWL };
