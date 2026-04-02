"use strict";
/*
 * output/renderer.js — Wolfbook output rendering helpers
 *
 * Extracted from controller.js (Round 4 refactoring).
 * All exported functions take the WolframNotebookKernel instance as `self`
 * where they need access to controller state.
 *
 * Responsibilities:
 *   - _resolveFormat: pick the render format for a cell (respecting per-cell
 *     overrides, notebook defaults, and output-type constraints).
 *   - _processWLLatexBoxes: post-process HTML containing WLLatex box
 *     placeholders — run via C++ boxToLatex addon + KaTeX pre-renderer.
 *   - makeTruncationBanner: build the expand/expand-more/open-text banner HTML.
 *   - _replaceOutputByUuid: replace a truncated output in-place by UUID.
 *   - _replaceOutputById: replace an output by output-id (format switching).
 *   - _fixImageUris: currently a no-op pass-through (kept for future use).
 *
 * Output type sets (used by _resolveFormat):
 *   EXPR_ONLY_FMTS, GFX_ONLY_FMTS
 *
 * State accessed on `self`:
 *   _cellOutputFormat, _outputRegistry, _notebookDefaultGfxFormat,
 *   _notebookDefaultExprFormat, _sessionEpoch, _controller, config
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { DEV_MODE } = require('../utils/dev-logger');
const _encoding = require('../utils/encoding');
const { wlUTFtoNames } = require('../namedchars');

// ---- WolfbookLaTeX C++ addon (lazy-loaded, shared with controller) --------
// We re-expose the same module-level lazy references that controller.js uses,
// loaded independently here since this module has its own require scope.
// Platform-aware: tries prebuilt/wolfbook_btl-<platform>-<arch>.node first,
// then falls back to the generic wolfbook_btl.node (locally compiled).
const _BTL_DIR              = require('path').join(__dirname, '../../../wllatex-addon');
const _KATEX_PRERENDER_PATH = require('path').join(__dirname, '../../../wllatex-addon/katexPrerender.js');
let _btlAddon = null;
let _btlPrerenderLatex = null;
function _loadBtlAddon() {
    if (_btlAddon) return true;
    try {
        const _fs = require('fs');
        const _prebuilt = require('path').join(_BTL_DIR, 'prebuilt',
            `wolfbook_btl-${process.platform}-${process.arch}.node`);
        const _fallback = require('path').join(_BTL_DIR, 'wolfbook_btl.node');
        const _addonPath = _fs.existsSync(_prebuilt) ? _prebuilt : _fallback;
        _btlAddon = require(_addonPath);
        _btlPrerenderLatex = require(_KATEX_PRERENDER_PATH).prerenderLatex;
        return true;
    } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Output type sets — never return an expr-only format for graphics or vice-versa

const EXPR_ONLY_FMTS = new Set(['WLLatex','WLLatex2','WLLatexSrc','SVGT','MathML','TeX','TeXSrc']);
const GFX_ONLY_FMTS  = new Set(['SVGSrc']);

// ---------------------------------------------------------------------------
// Format resolution

// Resolve the render format for a cell output, respecting the type-split notebook defaults.
// outN:        stable 0-based local sub-expression index within the cell (i from the eval loop),
//              NOT the global Out[N] counter.  Pass undefined when outN is not yet known.
// knownIsGfx: true/false if already known; undefined = scan registry for last output of this cell.
// Guarantees: never returns an expression-only format (WLLatex/WLLatex2/MathML/TeX/TeXSrc) for a
// known-graphics output, and never returns a graphics-only format (SVGSrc) for a known-expression
// output.  Falls back to 'Auto' (→ SVG for gfx, MathML for expr in the kernel) in those cases.
function resolveFormat(self, cell, knownIsGfx, outN) {
    const cellUri = cell.document.uri.toString();
    // 1a. Per-output explicit override (keyed cellUri:outN — most specific)
    const perOutput = (outN !== undefined) ? self._cellOutputFormat.get(cellUri + ':' + outN) : undefined;
    // 1b. Per-cell fallback (legacy / first-eval before outN is known)
    const perCell = perOutput ?? self._cellOutputFormat.get(cellUri);
    // 2. Notebook-level default — pick the right one based on output type
    const nbUri = cell.notebook.uri.toString();
    let isGfx = knownIsGfx;
    if (isGfx === undefined) {
        // Scan registry for the most recent output of this cell
        for (const [, entry] of self._outputRegistry) {
            if (entry.cell?.document?.uri?.toString() === cellUri && entry.isGfx !== undefined) {
                isGfx = entry.isGfx;
            }
        }
    }
    let fmt;
    if (perCell) {
        fmt = perCell;
    } else if (isGfx === true) {
        fmt = self._notebookDefaultGfxFormat.get(nbUri) || '';
    } else {
        // isGfx === false (known expression) or undefined (first eval, unknown type)
        fmt = self._notebookDefaultExprFormat.get(nbUri) || '';
    }
    if (!fmt) fmt = String(self.config.get('outputFormat') || 'WLLatex');
    // Sanitise: if type is known, never return a format incompatible with it.
    // WLLatex/WLLatex2 are expression-only; graphics always fall back to 'Auto' (→ SVG).
    if (isGfx === true  && EXPR_ONLY_FMTS.has(fmt)) return 'Auto';
    if (isGfx === false && GFX_ONLY_FMTS.has(fmt))  return 'Auto';
    return fmt;
}

// ---------------------------------------------------------------------------
// WLLatex box post-processing

// Post-process HTML from the kernel: if it contains a WLLatex box-placeholder
// div, decode the boxes, run through the C++ boxToLatex addon, then either
// KaTeX-prerender (WLLatex) or emit a raw-latex div for webview rendering (WLLatex2).
function processWLLatexBoxes(self, html, logPath, pageWidthEm = 0, source = '', lineBreakOpts = null) {
    // If no logPath was given, try to derive one from the active notebook
    if (!logPath) {
        try {
            const ed = vscode.window.activeNotebookEditor;
            if (ed && ed.notebook.uri.scheme === 'file') {
                const nbFsPath = ed.notebook.uri.fsPath;
                const nbBase = path.basename(nbFsPath, path.extname(nbFsPath));
                logPath = path.join(path.dirname(nbFsPath), 'img', nbBase, 'btl.log');
            }
        } catch (_) {}
    }
    const hasPrerendered = html.includes('vscode-wolfram-wllatex-boxes"');
    const hasRaw         = html.includes('vscode-wolfram-wllatex-boxes-raw"');
    const hasSrc         = html.includes('vscode-wolfram-wllatex-boxes-src"');
    if (!hasPrerendered && !hasRaw && !hasSrc) return html;
    if (!_loadBtlAddon()) {
        return html
            .replace(/<div class="vscode-wolfram-wllatex-boxes(-raw|-src)?"[^>]*><\/div>/g,
                '<pre class="vscode-wolfram-text-output">WLLatex: addon not available.\n' +
                'Build VSCodeWolfbookLaTeX first:\n  cd ~/Dropbox/MY/Programming/VSCodeWolfbookLaTeX && ./build.sh</pre>');
    }
    const lbOpts = (lineBreakOpts && typeof lineBreakOpts === 'object')
        ? { ...lineBreakOpts }
        : { pageWidth: pageWidthEm };
    if (!(lbOpts.pageWidth > 0)) lbOpts.pageWidth = pageWidthEm;
    const lbOptsText = JSON.stringify(lbOpts);
    // Helper: run boxToLatex and return { latex, error }
    const translate = (b64) => {
        try {
            let boxStr = Buffer.from(b64, 'base64').toString('utf8');
            // Convert all Unicode chars + \|XXXX hex escapes to \[Name] for BTL
            boxStr = wlUTFtoNames(boxStr);
            const result = _btlAddon.boxToLatex(boxStr);
            // boxToLatex returns { latex, error } per README
            if (result && typeof result === 'object') return { boxStr, latex: result.latex, error: result.error || null };
            // Older build that returned a plain string
            return { boxStr, latex: String(result), error: null };
        } catch (e) {
            return { boxStr: '(decode failed)', latex: '', error: String(e.message || e) };
        }
    };
    // ---- Mode A: pre-render in extension host (LaTeX button) ----
    if (hasPrerendered) {
        html = html.replace(/<div class="vscode-wolfram-wllatex-boxes" data-boxes-b64="([^"]*)"(?:\s+data-raw-b64="([^"]*)")?\s*>\s*<\/div>/g,
            (_, b64, rawB64) => {
                const { boxStr, latex, error } = translate(b64);
                // Apply line-breaking if enabled and we have a container width estimate.
                const _lineBreakEnabled = self.config?.get('notebook.rendering.lineBreaking') !== false;
                let latexFinal = latex;
                let lineBreakStatus = 'disabled';
                if (_lineBreakEnabled) {
                    if (!(pageWidthEm > 5)) {
                        lineBreakStatus = 'skipped (pageWidthEm=' + pageWidthEm + ')';
                    } else if (!_btlAddon.lineBreakLatex) {
                        lineBreakStatus = 'unavailable';
                    } else {
                        try {
                            latexFinal = _btlAddon.lineBreakLatex(latex, lbOpts);
                            lineBreakStatus = latexFinal !== latex ? 'applied' : 'no-change (fits in width)';
                        } catch (e) {
                            latexFinal = latex;
                            lineBreakStatus = 'error: ' + String(e.message || e);
                        }
                    }
                }
                // Write to btl.log if a log path was supplied (Print/BoxData path only)
                if (logPath) {
                    try {
                        const ts = new Date().toISOString();
                        const rawText = rawB64 ? Buffer.from(rawB64, 'base64').toString('utf8') : '';
                        const sep = '='.repeat(72) + '\n';
                        const entry = sep +
                            ts + (source ? '  [' + source + ']' : '') + '\n' +
                            '-- kernel output --\n' + rawText + '\n' +
                            '-- btl input (cleaned boxes) --\n' + boxStr + '\n' +
                            '-- btl output (latex) --\n' + latex + '\n' +
                            '-- pageWidthEm: ' + pageWidthEm + '  lineBreak: ' + lineBreakStatus +
                            '  opts: ' + lbOptsText + ' --\n' +
                            (error ? '-- btl error --\n' + error + '\n' : '');
                        fs.mkdirSync(path.dirname(logPath), { recursive: true });
                        fs.appendFileSync(logPath, entry);
                    } catch (_) {}
                }
                let rendered;
                try {
                    rendered = _btlPrerenderLatex(latexFinal, true);
                } catch (e) {
                    return '<pre class="vscode-wolfram-text-output">WLLatex KaTeX error: ' +
                           _encoding.escapeHtml(String(e.message || e)) + '</pre>';
                }
                const errorNote = error
                    ? `<div style="color:#e05c4e;font-size:11px;margin:2px 0;">` +
                      `⚠️ boxToLatex error: ${_encoding.escapeHtml(error)}</div>`
                    : '';
                const lineBrokenAttr = lineBreakStatus === 'applied' ? ' data-line-broken="1"' : '';
                // Embed data-latex-b64 so extractPlainText and AI tools can read the raw LaTeX
                const _latexB64ForA = Buffer.from(latexFinal).toString('base64');
                return `<div class="vscode-wolfram-wllatex-prerendered" data-page-width-em="${pageWidthEm}"${lineBrokenAttr} data-latex-b64="${_latexB64ForA}">` +
                       errorNote + rendered + '</div>';
            });
    }
    // ---- Mode B: emit raw-latex div, rendered by webview KaTeX (LaTeX2 button) ----
    if (hasRaw) {
        html = html.replace(/<div class="vscode-wolfram-wllatex-boxes-raw" data-boxes-b64="([^"]*)">\s*<\/div>/g,
            (_, b64) => {
                const { boxStr, latex, error } = translate(b64);
                // Apply line-breaking in extension host before handing latex to webview
                const _lineBreakEnabled = self.config?.get('notebook.rendering.lineBreaking') !== false;
                let latexFinal = latex;
                let lineBreakStatus = 'disabled';
                if (_lineBreakEnabled) {
                    if (!(pageWidthEm > 5)) {
                        lineBreakStatus = 'skipped (pageWidthEm=' + pageWidthEm + ')';
                    } else if (!_btlAddon.lineBreakLatex) {
                        lineBreakStatus = 'unavailable';
                    } else {
                        try {
                            latexFinal = _btlAddon.lineBreakLatex(latex, lbOpts);
                            lineBreakStatus = latexFinal !== latex ? 'applied' : 'no-change (fits in width)';
                        } catch (e) {
                            latexFinal = latex;
                            lineBreakStatus = 'error: ' + String(e.message || e);
                        }
                    }
                }
                if (logPath) {
                    try {
                        const ts = new Date().toISOString();
                        const sep = '='.repeat(72) + '\n';
                        const entry = sep +
                            ts + (source ? '  [' + source + ']' : '') + '\n' +
                            '-- pageWidthEm: ' + pageWidthEm + '  lineBreak: ' + lineBreakStatus +
                            '  opts: ' + lbOptsText + ' --\n' +
                            '-- btl input (cleaned boxes) --\n' + boxStr + '\n' +
                            '-- btl output (latex) --\n' + latex + '\n' +
                            (error ? '-- btl error --\n' + error + '\n' : '');
                        fs.mkdirSync(path.dirname(logPath), { recursive: true });
                        fs.appendFileSync(logPath, entry);
                    } catch (_) {}
                }
                const latexB64 = Buffer.from(latexFinal).toString('base64');
                const errorAttr = error ? ` data-btl-error="${_encoding.escapeHtml(error)}"` : '';
                // Embed a short readable LaTeX preview as text content so that AI tools
                // reading the raw HTML see decoded LaTeX rather than an opaque base64 blob.
                // The webview overwrites this with the KaTeX-rendered DOM when it loads.
                const _PREVIEW_LEN = 300;
                const _latexPreview = latexFinal.length > _PREVIEW_LEN
                    ? _encoding.escapeHtml(latexFinal.substring(0, _PREVIEW_LEN)) + '\u2026'
                    : _encoding.escapeHtml(latexFinal);
                return `<div class="vscode-wolfram-wllatex-raw-latex" data-latex-b64="${latexB64}"${errorAttr}>${_latexPreview}</div>`;
            });
    }
    // ---- Mode C: emit src-latex div containing raw LaTeX for source display (WLLatexSrc button) ----
    if (hasSrc) {
        html = html.replace(/<div class="vscode-wolfram-wllatex-boxes-src" data-boxes-b64="([^"]*)">\s*<\/div>/g,
            (_, b64) => {
                const { boxStr, latex, error } = translate(b64);
                // Apply the same line-breaking as Mode A so the source stays in sync with rendered output
                const _lineBreakEnabled = self.config?.get('notebook.rendering.lineBreaking') !== false;
                let latexFinal = latex;
                if (_lineBreakEnabled && pageWidthEm > 5 && _btlAddon.lineBreakLatex) {
                    try { latexFinal = _btlAddon.lineBreakLatex(latex, lbOpts); } catch (_) {}
                }
                if (logPath) {
                    try {
                        const ts = new Date().toISOString();
                        const sep = '='.repeat(72) + '\n';
                        const entry = sep +
                            ts + (source ? '  [' + source + ']' : '') + '\n' +
                            '-- pageWidthEm: ' + pageWidthEm + ' (mode C — src display)  opts: ' + lbOptsText + ' --\n' +
                            '-- btl input (cleaned boxes) --\n' + boxStr + '\n' +
                            '-- btl output (latex) --\n' + latexFinal + '\n' +
                            (error ? '-- btl error --\n' + error + '\n' : '');
                        fs.mkdirSync(path.dirname(logPath), { recursive: true });
                        fs.appendFileSync(logPath, entry);
                    } catch (_) {}
                }
                const latexB64 = Buffer.from(latexFinal).toString('base64');
                const errorAttr = error ? ` data-btl-error="${_encoding.escapeHtml(error)}"` : '';
                return `<div class="vscode-wolfram-wllatex-src-latex" data-latex-b64="${latexB64}"${errorAttr}></div>`;
            });
    }
    return html;
}

// ---------------------------------------------------------------------------
// Truncation banner

function makeTruncationBanner(self, outputId, headerText, shortLines = null) {
    const slAttr = shortLines !== null ? ` data-short-lines="${shortLines}"` : '';
    const btnStyle = 'padding:1px 6px;font-size:12px;cursor:pointer;line-height:1.5;' +
        'background:transparent;border:1px solid rgba(128,128,128,0.3);' +
        'border-radius:3px;color:var(--vscode-foreground,inherit);';
    return `
<div style="margin-top:3px;padding:2px 8px;display:flex;align-items:center;gap:6px;border-left:2px solid rgba(128,128,128,0.3);"
     data-truncated-uuid="${outputId}" data-session-epoch="${self._sessionEpoch}"${slAttr}>
  <span style="font-size:11px;color:var(--vscode-descriptionForeground,#888);flex:1;">${headerText}</span>
  <button data-action="expand" style="${btnStyle}" title="Show full output">&#9654;</button>
  <button data-action="expand-more" style="${btnStyle}" title="Show +20 more lines">&#43;&#8230;</button>
  <button data-action="open-text" style="${btnStyle}" title="Open as text file">&#128196;</button>
</div>`;
}

// ---------------------------------------------------------------------------
// In-place output replacement

// Replace a truncated (skeleton) output identified by its UUID with the full HTML.
// Rebuilds the output block header so format buttons remain correct.
async function replaceOutputByUuid(self, cell, uuid, fullHtml, outN) {
    // Look up stored metadata so that after expansion the format buttons are
    // rebuilt with the correct format, outName, and graphics flag.
    const regInfo    = self._outputRegistry.get(uuid);
    const fmt        = regInfo?.format || 'Auto';
    const outName    = regInfo?.outName || ('Out[' + outN + ']=');
    const outLabel   = `<span style="font-size:10px;color:#888;margin-right:8px;">${outName}</span>`;
    const _isGfxUuid = regInfo?.isGfx ?? (fullHtml.includes('vscode-wolfram-svg-output') || fullHtml.includes('vscode-wolfram-png-output'));
    const finalHtml =
        `<div class="wl-output-block">` +
        `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" ` +
        `data-session-epoch="${self._sessionEpoch}" data-output-id="${uuid}" ` +
        `data-out-n="${outN}" data-sub-idx="${regInfo?.subIdx ?? ''}" data-output-format="${fmt}" data-output-is-graphics="${_isGfxUuid ? '1' : '0'}">${outLabel}</div>` +
        `<div class="wl-output-content">${fullHtml}</div>` +
        `</div>`;
    // Snapshot outputs BEFORE start() — start() can clear cell.outputs in some VS Code versions
    let targetIndex = -1;
    const allOutputs = [...cell.outputs];
    for (let i = 0; i < allOutputs.length; i++) {
        const output = allOutputs[i];
        if (output.items && output.items.length > 0) {
            try {
                const html = new TextDecoder().decode(output.items[0].data);
                if (html.includes(`data-truncated-uuid="${uuid}"`)) {
                    targetIndex = i;
                    break;
                }
            } catch (_) {}
        }
    }
    if (targetIndex === -1) {
        vscode.window.showWarningMessage("Could not find truncated output to replace.");
        return;
    }

    allOutputs[targetIndex] = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(finalHtml, "x-application/wolfram-language-html")
    ]);
    const tempExec = self._controller.createNotebookCellExecution(cell);
    tempExec.start();
    tempExec.replaceOutput(allOutputs);
    tempExec.end(true);
}

// Replace any output identified by its data-output-id (for format switching).
// Rebuilds the header with the new format data attribute so buttons stay correct.
async function replaceOutputById(self, cell, outputId, contentHtml, outN, outName, newFormat, bannerHtml = '') {
    const outLabel   = `<span style="font-size:10px;color:#888;margin-right:8px;">${outName || ('Out[' + outN + ']=')} </span>`;
    // Prefer stored isGfx flag (set at initial render) so switching to WL/TeX doesn't
    // lose the graphics-specific button set.
    const _regEntry  = self._outputRegistry.get(outputId);
    const _isGfxById = _regEntry?.isGfx ?? (contentHtml.includes('vscode-wolfram-svg-output') || contentHtml.includes('vscode-wolfram-png-output'));
    const _subIdxById = _regEntry?.subIdx;
    const headerRow  = `<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" ` +
                       `data-session-epoch="${self._sessionEpoch}" data-output-id="${outputId}" ` +
                       `data-out-n="${outN}" data-sub-idx="${_subIdxById ?? ''}" data-output-format="${newFormat}" data-output-is-graphics="${_isGfxById ? '1' : '0'}">${outLabel}</div>`;
    const finalHtml  = `<div class="wl-output-block">${headerRow}<div class="wl-output-content">${contentHtml}</div></div>` + bannerHtml;

    let targetIndex = -1;
    const allOutputs = [...cell.outputs];
    for (let i = 0; i < allOutputs.length; i++) {
        const output = allOutputs[i];
        if (output.items && output.items.length > 0) {
            try {
                const html = new TextDecoder().decode(output.items[0].data);
                if (html.includes(`data-output-id="${outputId}"`)) {
                    targetIndex = i;
                    break;
                }
            } catch (_) {}
        }
    }
    if (targetIndex === -1) {
        if (DEV_MODE) self.outputPanel.print(`[_replaceOutputById] outputId ${outputId} not found in cell outputs`);
        return;
    }
    allOutputs[targetIndex] = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(finalHtml, "x-application/wolfram-language-html")
    ]);
    const tempExec = self._controller.createNotebookCellExecution(cell);
    tempExec.start();
    tempExec.replaceOutput(allOutputs);
    tempExec.end(true);
}

// ---------------------------------------------------------------------------
// Extract a readable text/plain string from a rendered output HTML block.
// Used by execution/checkout.js (live evaluation) and serializer.js (on load)
// to attach an AI-readable MIME item alongside `x-application/wolfram-language-html`.
//
// Priority:
//   1. isGfx=true → "(* output: graphics *)\n<cellSource>" (TODO-1b)
//   2. data-latex-b64 present → "<outName> <latex>"          (TODO-1a, all WLLatex modes)
//   3. vscode-wolfram-text-output → "<outName> <text>"       (Print[], InputForm fallbacks)
//   4. null — nothing useful to expose
function extractPlainText(html, outName, isGfx, cellSource) {
    if (isGfx) {
        return `(* output: graphics *)\n${cellSource || ''}`;
    }
    // All WLLatex variants embed data-latex-b64 (Modes A/B/C of processWLLatexBoxes)
    const latexMatch = html.match(/data-latex-b64="([^"]+)"/);
    if (latexMatch) {
        try {
            const latex = Buffer.from(latexMatch[1], 'base64').toString('utf8');
            if (latex.trim()) return `${outName} ${latex}`;
        } catch (_) {}
    }
    // Kernel message/warning output — may be <div> (single short) or <details> (long/grouped).
    const msgMatch = html.match(/<(?:div|details)[^>]*class="vscode-wolfram-message-output"[^>]*>([\s\S]*?)<\/(?:div|details)>/);
    if (msgMatch) {
        const text = msgMatch[1]
            .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        if (text.trim()) return text.trim();
    }
    // Plain text output (Print[], ToString[], InputForm fallbacks)
    const textMatch = html.match(/<pre[^>]*class="vscode-wolfram-text-output"[^>]*>([\s\S]*?)<\/pre>/);
    if (textMatch) {
        const text = textMatch[1]
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        if (text.trim()) return `${outName} ${text.trim()}`;
    }
    return null;
}

// ---------------------------------------------------------------------------

module.exports = {
    EXPR_ONLY_FMTS,
    GFX_ONLY_FMTS,
    resolveFormat,
    processWLLatexBoxes,
    makeTruncationBanner,
    replaceOutputByUuid,
    replaceOutputById,
    extractPlainText,
};
