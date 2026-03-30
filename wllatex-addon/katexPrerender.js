"use strict";
// =============================================================
// katexPrerender.ts  —  Mode B: KaTeX pre-renderer
//
// Runs in the extension host (Node.js process).
// MUST NOT use any DOM API (document, window, HTMLElement, …).
// KaTeX is imported as a plain Node.js module — it ships its
// own glyph data as inline SVG paths, so no font files need to
// be reachable from the Webview.
//
// The returned HTML fragment is self-contained: the Webview only
// needs to set `container.innerHTML = html`.  It still needs the
// KaTeX CSS loaded in its <head> for correct layout.
// =============================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prerenderLatex = prerenderLatex;
const katex_1 = __importDefault(require("katex"));
// ----------------------------------------------------------
// KaTeX options shared across all pre-render calls.
// strict: false  — required for `\textcolor{#rrggbb}{…}`
// throwOnError: false — degrade gracefully; never crash the host
// ----------------------------------------------------------
const BASE_OPTIONS = { output: 'html', // suppress katex-mathml layer; keep only the visual HTML    throwOnError: false,
    errorColor: '#cc0000',
    trust: false,
    strict: false, // required for \textcolor and non-standard commands
    macros: {
        '\\dd': '\\mathrm{d}', // differential d
        '\\R': '\\mathbb{R}', // shorthand blackboard R
        '\\C': '\\mathbb{C}', // shorthand blackboard C
        '\\N': '\\mathbb{N}', // shorthand blackboard N
    },
};
// ----------------------------------------------------------
// Minimal HTML escaping — for the error-fallback path only.
// (KaTeX-rendered output must NOT be escaped; KaTeX emits safe HTML.)
// ----------------------------------------------------------
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// ----------------------------------------------------------
// prerenderLatex
//   latex       — LaTeX string from boxToLatex C++ addon
//   displayMode — true for display math (centred block),
//                 false for inline math
//
// Returns a self-contained HTML string (never throws).
// ----------------------------------------------------------
function prerenderLatex(latex, displayMode = true) {
    try {
        return katex_1.default.renderToString(latex, { ...BASE_OPTIONS, displayMode });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fallback: styled error span — Webview does innerHTML so this is safe
        return (`<span class="wolfbook-render-error" ` +
            `style="color:#cc0000;font-family:monospace;white-space:pre-wrap">` +
            `[LaTeX error] ${escapeHtml(msg)}<br>` +
            `<small>${escapeHtml(latex)}</small>` +
            `</span>`);
    }
}
//# sourceMappingURL=katexPrerender.js.map