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
 * decodeWstpText — consolidated WSTP text decoder.
 *
 * Handles two WSTP escape mechanisms:
 * 1. Octal byte escapes (\NNN) — \012 (newline), \011 (tab), \015 (CR),
 *    and multi-byte UTF-8 sequences (e.g. \316\273 → λ).
 * 2. Backslash doubling — WSTP doubles every \ in string content,
 *    so JSON escape sequences like \" become \\" which breaks JSON.parse.
 *    Un-doubling restores the original text.
 *
 * Order matters: octal decode first (consumes \NNN patterns), then
 * un-double backslashes (restores JSON escape sequences).
 * @param {string} s
 * @returns {string}
 */
function decodeWstpText(s) {
    let result = decodeWolframOctal(String(s));
    // Un-double WSTP backslash escaping: \\\\ → \\
    result = result.replace(/\\\\/g, '\\');
    return result;
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

// Optional box-to-LaTeX provider — injected by tools/index.js at load time so encoding.js
// stays dependency-free.  fn receives the raw BoxData[...] string and returns a LaTeX string
// or null/undefined on failure.
let _boxToLatexProvider = null;
function setBoxToLatexProvider(fn) { _boxToLatexProvider = fn; }

/**
 * cleanPrintLine — convert a raw WSTP TextPacket (onPrint callback) into human-readable text.
 *
 * Handles:
 *  - *STR* prefix: kernel-tagged string value — strip prefix, decode WSTP escaping
 *  - BoxData[InterpretationBox["display", expr, ...]]: extract second arg (the expr text)
 *  - BoxData[...]: opaque typeset formula — return '[formula]' placeholder
 *  - *SVG* / *HTML* / *WBP*: binary/rich content — return descriptive placeholder
 *  - Multi-arg Print: args separated by ASCII File Separator (\x1c) — process each part
 *  - Plain text: decode WSTP octal byte sequences and backslash doubling
 *  - \\012: newline escape from WSTP TextPacket
 * @param {string} rawLine  Raw string from the onPrint callback
 * @returns {string}
 */
function cleanPrintLine(rawLine) {
    const s = rawLine.replace(/\\012/g, '\n');
    // Multi-arg Print separates args with ASCII File Separator (\x1c)
    const parts = s.split('\x1c');
    const cleaned = parts.map(t => {
        // *STR* prefix: the kernel tagged this as a plain string value
        if (t.startsWith('*STR*')) {
            return decodeWstpText(t.slice(5));
        }
        // BoxData[...]: try the injected BTL provider first (converts boxes → LaTeX via C++ addon)
        if (t.startsWith('BoxData[')) {
            if (_boxToLatexProvider) {
                try {
                    const latex = _boxToLatexProvider(t);
                    if (latex != null && latex !== '') return latex;
                } catch (_) {}
            }
            // Fallback: InterpretationBox second arg is readable without BTL
            if (t.startsWith('BoxData[InterpretationBox[')) {
                const inner = t.slice('BoxData[InterpretationBox['.length);
                if (inner.startsWith('"')) {
                    let i = 1;
                    while (i < inner.length) {
                        if (inner[i] === '"' && inner[i - 1] !== '\\') break;
                        i++;
                    }
                    const rest = inner.slice(i + 1).replace(/^\s*,\s*/, '');
                    const m = rest.match(/^([\s\S]*?),\s*(?:Editable|AutoDelete)\s*->/);
                    if (m) return decodeWstpText(m[1].trim());
                }
            }
            return '[formula]';
        }
        // Binary/rich content — not useful as plain text
        if (t.startsWith('*SVG*')) return '[graphics]';
        if (t.startsWith('*HTML*')) return '[info]';
        if (t.startsWith('*WBP*')) return t.slice(5);
        // Plain text: decode WSTP octal byte sequences (\316\223 → Γ) and backslash doubling
        return decodeWstpText(t);
    });
    return cleaned.join('');
}

module.exports = { escapeHtml, decodeWolframOctal, decodeWstpText, escapeWL, cleanPrintLine, setBoxToLatexProvider };
