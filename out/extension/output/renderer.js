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
const logPaths = require('../utils/log-paths');

/**
 * Path to btl.log for the active notebook, or null when diagnostic logs are off.
 * Lives under globalStorage — never beside the notebook, which used to litter
 * every Dropbox-synced project with an img/<nb>/btl.log.
 * @returns {string|null}
 */
function _btlLogPath() {
    try {
        const ed = vscode.window.activeNotebookEditor;
        if (!ed || ed.notebook.uri.scheme !== 'file') return null;
        return logPaths.notebookLogFile(ed.notebook.uri.fsPath, 'btl.log');
    } catch (_) {
        return null;
    }
}
const _encoding = require('../utils/encoding');
const { wlUTFtoNames, wlNameToUTF } = require('../namedchars');

// ---- WolfbookLaTeX C++ addon (lazy-loaded, shared with controller) --------
// We re-expose the same module-level lazy references that controller.js uses,
// loaded independently here since this module has its own require scope.
// Platform-aware: tries prebuilt/wolfbook_btl-<platform>-<arch>.node first,
// then falls back to the generic wolfbook_btl.node (locally compiled).
const _BTL_DIR              = require('path').join(__dirname, '../../../wllatex-addon');
const _KATEX_PRERENDER_PATH = require('path').join(__dirname, '../../../wllatex-addon/katexPrerender.js');
let _btlAddon = null;
let _btlPrerenderLatex = null;
let _btlAddonPath = null;   // cached for worker threads
function _loadBtlAddon() {
    if (_btlAddon) return true;
    try {
        const _fs = require('fs');
        const _prebuilt = require('path').join(_BTL_DIR, 'prebuilt',
            `wolfbook_btl-${process.platform}-${process.arch}.node`);
        const _fallback = require('path').join(_BTL_DIR, 'wolfbook_btl.node');
        const _addonPath = _fs.existsSync(_prebuilt) ? _prebuilt : _fallback;
        _btlAddon = require(_addonPath);
        _btlAddonPath = _addonPath;
        _btlPrerenderLatex = require(_KATEX_PRERENDER_PATH).prerenderLatex;
        return true;
    } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Output type sets — never return an expr-only format for graphics or vice-versa

const EXPR_ONLY_FMTS = new Set(['WLLatex','SVGT','MathML','TeX','TeXSrc']);
// WL3D emits a PNG poster + a sibling mesh JSON for the interactive 3D viewer;
// it is meaningless for a symbolic output, so it falls back to 'Auto' there.
const GFX_ONLY_FMTS  = new Set(['SVGSrc','WL3D']);

// ---------------------------------------------------------------------------
// Format resolution

// Resolve the render format for a cell output, respecting the type-split notebook defaults.
// outN:        stable 0-based local sub-expression index within the cell (i from the eval loop),
//              NOT the global Out[N] counter.  Pass undefined when outN is not yet known.
// knownIsGfx: true/false if already known; undefined = scan registry for last output of this cell.
// Guarantees: never returns an expression-only format (WLLatex/MathML/TeX/TeXSrc) for a
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
        // Scan registry for the isGfx flag of this cell's output.
        // When outN is known, only match entries with the same subIdx — prevents
        // a preceding plot (isGfx:true) from contaminating the next expression's
        // format lookup and causing it to be rendered as MathML instead of LaTeX.
        for (const [, entry] of self._outputRegistry) {
            if (entry.cell?.document?.uri?.toString() === cellUri && entry.isGfx !== undefined) {
                if (outN !== undefined) {
                    if (entry.subIdx === outN) isGfx = entry.isGfx;
                } else {
                    isGfx = entry.isGfx; // outN unknown: last entry wins
                }
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
    // Migrate removed formats (WLLatex2 / WLLatexSrc) to WLLatex.
    if (fmt === 'WLLatex2' || fmt === 'WLLatexSrc') fmt = 'WLLatex';
    // Sanitise: if type is known, never return a format incompatible with it.
    // WLLatex is expression-only; graphics always fall back to 'Auto' (→ SVG).
    if (isGfx === true  && EXPR_ONLY_FMTS.has(fmt)) return 'Auto';
    if (isGfx === false && GFX_ONLY_FMTS.has(fmt))  return 'Auto';
    return fmt;
}

// ---------------------------------------------------------------------------
// InformationData (result of ?Symbol) extractor.
//
// When ?Symbol is evaluated, the kernel emits an InterpretationBox whose second
// argument is InformationData[<|assoc|>, True].  The widget boxes in the first
// argument contain DynamicModuleBox / PaneSelectorBox / ButtonBox that BTL
// cannot render, producing garbled LaTeX.  This function intercepts the box
// string BEFORE it reaches BTL and builds clean HTML from the association data.
//
// Returns an HTML string on success, or null if the box is not InformationData.
function _extractInfoDataHtml(boxStr) {
    // Must be an InterpretationBox
    if (!boxStr.startsWith('InterpretationBox[')) return null;
    // Must contain InformationData[<| somewhere
    const idxInfo = boxStr.lastIndexOf('InformationData[<|');
    if (idxInfo === -1) return null;

    // Extract association content between <| ... |>
    const assocStart = idxInfo + 'InformationData[<|'.length;
    const assocEnd   = boxStr.lastIndexOf('|>');
    if (assocEnd <= assocStart) return null;
    const assoc = boxStr.slice(assocStart, assocEnd);

    // Helper: extract a string value for a given key from the WL association text.
    // Handles \" escapes inside the value string.
    const getStr = (key) => {
        const re = new RegExp('"' + key + '"\\s*->\\s*"((?:[^"\\\\]|\\\\.)*)"');
        const m = assoc.match(re);
        return m ? m[1] : '';
    };

    const fullNameRaw = getStr('FullName');
    const usageRaw    = getStr('Usage');
    if (!fullNameRaw && !usageRaw) return null;  // not enough info — skip

    // Decode WL string escapes + named characters → display text.
    // Important: \!, \(, \), \* are front-end typesetting chars (NOT WL string
    // escapes), so they survive this decode as literal backslash+char pairs.
    const decode = (s) => wlNameToUTF(
        s.replace(/\\n/g, '\n')
         .replace(/\\t/g, '\t')
         .replace(/\\"/g, '"')
         .replace(/\\\\/g, '\\')
    );
    const fullName  = decode(fullNameRaw);
    const shortName = fullName ? fullName.split('`').pop() : '';

    // Attributes (optional — may not be a string value)
    const attribsM = assoc.match(/"Attributes"\s*->\s*\{([^}]*)\}/);
    const attribs  = attribsM ? attribsM[1].trim() : '';

    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const headerColor = 'var(--vscode-descriptionForeground,#888)';

    // ---------------------------------------------------------------------------
    // Usage rendering: split on \!\(...\) inline-typeset segments.
    //
    // Usage messages for built-in symbols embed Mathematica front-end box
    // expressions as \!\(\*BoxExpr\): the \! introduces inline typeset, \( opens
    // the box, \* means "interpret as boxes", and \) closes it.  After decode()
    // these are literal backslash+char pairs, e.g. \!\(\*RowBox[{...}]\).
    //
    // We split the decoded text on these segments, run each box expression
    // through the BTL addon → KaTeX inline, and HTML-escape the plain parts.
    // For our own functions (no \!\( in usage) the plain-text path is taken.
    // ---------------------------------------------------------------------------

    // Step 1: split decoded usage text into {kind:'text'|'box', value} parts.
    const parseUsageParts = (text) => {
        const parts = [];
        let pos = 0;
        while (pos < text.length) {
            // Find next \!\( (literal chars: backslash + ! + backslash + open-paren)
            let found = -1;
            for (let i = pos; i < text.length - 3; i++) {
                if (text[i]==='\\' && text[i+1]==='!' && text[i+2]==='\\' && text[i+3]==='(') {
                    found = i; break;
                }
            }
            if (found === -1) {
                const t = text.slice(pos);
                if (t) parts.push({ kind: 'text', value: t });
                break;
            }
            if (found > pos) parts.push({ kind: 'text', value: text.slice(pos, found) });
            // Find the closing \) (backslash + close-paren)
            const contentStart = found + 4; // skip \!\(
            let closePos = -1;
            for (let i = contentStart; i < text.length - 1; i++) {
                if (text[i]==='\\' && text[i+1]===')') { closePos = i; break; }
            }
            if (closePos === -1) {
                parts.push({ kind: 'text', value: text.slice(found) });
                break;
            }
            parts.push({ kind: 'box', value: text.slice(contentStart, closePos) });
            pos = closePos + 2;
        }
        return parts;
    };

    // Step 2: render each part to HTML.
    const renderUsageParts = (parts) => {
        let html = '';
        for (const part of parts) {
            if (part.kind === 'text') {
                // Preserve newlines between multiple usage forms
                html += esc(part.value).replace(/\n/g, '<br>');
            } else {
                // Strip leading \* to get the raw box expression
                const boxExpr = part.value.startsWith('\\*') ? part.value.slice(2) : part.value;
                if (!_btlAddon || !_btlPrerenderLatex) {
                    html += `<code>${esc(boxExpr)}</code>`; // graceful fallback
                    continue;
                }
                try {
                    const r = _btlAddon.boxToLatex(boxExpr, { trigOmitParens: false, maxRows: 0 });
                    const latex = (r && typeof r === 'object') ? (r.latex || '') : String(r);
                    if (!latex) { html += `<code>${esc(boxExpr)}</code>`; continue; }
                    html += _btlPrerenderLatex(latex, false); // false = inline mode
                } catch (e) {
                    html += `<code>${esc(boxExpr)}</code>`;
                }
            }
        }
        return html;
    };

    const usageDecoded = usageRaw ? decode(usageRaw) : '';
    const usageHtml    = usageDecoded ? renderUsageParts(parseUsageParts(usageDecoded)) : '';

    let html = '<div class="wl-info-data" style="padding:6px 8px;font-family:var(--vscode-editor-font-family,monospace);">';
    if (shortName) {
        html += `<div style="font-size:14px;font-weight:bold;margin-bottom:3px;">${esc(shortName)}</div>`;
        if (fullName && fullName.includes('`')) {
            html += `<div style="font-size:11px;color:${headerColor};margin-bottom:6px;">${esc(fullName)}</div>`;
        }
    }
    if (usageHtml) {
        html += `<div style="font-size:12px;line-height:1.8;margin-bottom:4px;">${usageHtml}</div>`;
    }
    if (attribs) {
        html += `<div style="font-size:11px;color:${headerColor};">Attributes: {${esc(attribs)}}</div>`;
    }
    html += '</div>';
    return html;
}

// ---------------------------------------------------------------------------
// WLLatex box post-processing

// Post-process HTML from the kernel: if it contains a WLLatex box-placeholder
// div, decode the boxes, run through the C++ boxToLatex addon, then either
// KaTeX-prerender in extension host (WLLatex / Mode A only).
function processWLLatexBoxes(self, html, logPath, pageWidthEm = 0, source = '', lineBreakOpts = null) {
    // If no logPath was given, derive one from the active notebook.
    // null when diagnostic logs are off — every write site below is null-guarded.
    if (!logPath) logPath = _btlLogPath();
    const hasPrerendered = html.includes('vscode-wolfram-wllatex-boxes"');
    if (!hasPrerendered) return html;
    if (!_loadBtlAddon()) {
        return html
            .replace(/<div class="vscode-wolfram-wllatex-boxes"[^>]*><\/div>/g,
                '<pre class="vscode-wolfram-text-output">WLLatex: addon not available.\n' +
                'The bundled LaTeX/KaTeX math renderer (btl) could not be loaded for this platform.\n' +
                'See the Building from Source guide to compile it: https://github.com/vanbaalon/wolfbook</pre>');
    }
    const lbOpts = (lineBreakOpts && typeof lineBreakOpts === 'object')
        ? { ...lineBreakOpts }
        : { pageWidth: pageWidthEm };
    if (!(lbOpts.pageWidth > 0)) lbOpts.pageWidth = pageWidthEm;
    const lbOptsText = JSON.stringify(lbOpts);
    const _maxMatrixRows = Number(self.config?.get('notebook.rendering.maxMatrixRows') ?? 100);
    // Add maxRows to lbOpts if not already supplied by _getLineBreakOptions
    if (!('maxRows' in lbOpts)) lbOpts.maxRows = _maxMatrixRows;
    const btlOpts = {
        trigOmitParens: self.config?.get('notebook.rendering.trigOmitParens') !== false,
        trigPowerForm:  self.config?.get('notebook.rendering.trigPowerForm')  !== false,
        // If caller passed maxRows:0 in lbOpts (e.g. expand-more, no-page), honour it here too.
        maxRows: (lbOpts.maxRows === 0) ? 0 : (_maxMatrixRows > 0 ? _maxMatrixRows : 0),
    };
    // Pager store: maps pagerId → {type, data, opts} for server-side page serving.
    // Populated here, read by renderPageForPager() when client requests a page.
    if (!self._pagerStore) self._pagerStore = new Map();
    const _genPageId = () => 'pg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const translate = (b64) => {
        try {
            let boxStr = Buffer.from(b64, 'base64').toString('utf8');
            // Convert all Unicode chars + \|XXXX hex escapes to \[Name] for BTL
            boxStr = wlUTFtoNames(boxStr);
            // Check for InformationData boxes — render as HTML directly, skip BTL.
            // InterpretationBox[<widget>, InformationData[<|assoc|>, True]] contains
            // DynamicModuleBox / ButtonBox that BTL cannot render without errors.
            const _directHtml = _extractInfoDataHtml(boxStr);
            if (_directHtml !== null) {
                return { boxStr, latex: '', totalPages: 1, allPageLatex: null, error: null, _directHtml };
            }
            // allPages:true returns ALL page LaTeX strings in result.pages[]
            // in a single C++ call — avoids re-parsing the entire box string per page.
            const result = _btlAddon.boxToLatex(boxStr, {...btlOpts, allPages: true});
            // boxToLatex returns { latex, totalPages?, pages?[], error } per new API
            if (result && typeof result === 'object') {
                const allPageLatex = (Array.isArray(result.pages) && result.pages.length > 1) ? result.pages : null;
                return { boxStr, latex: result.latex, totalPages: result.totalPages || 1, allPageLatex, error: result.error || null };
            }
            // Older build that returned a plain string
            return { boxStr, latex: String(result), totalPages: 1, allPageLatex: null, error: null };
        } catch (e) {
            return { boxStr: '(decode failed)', latex: '', totalPages: 1, allPageLatex: null, error: String(e.message || e) };
        }
    };
    // ---- Mode A: pre-render in extension host (LaTeX button) ----
    if (hasPrerendered) {
        html = html.replace(/<div class="vscode-wolfram-wllatex-boxes" data-boxes-b64="([^"]*)"(?:\s+data-raw-b64="([^"]*)")?\s*>\s*<\/div>/g,
            (_, b64, rawB64) => {
                const { boxStr, latex, totalPages, allPageLatex, error, _directHtml } = translate(b64);
                // InformationData (?Symbol) — rendered directly as HTML, no BTL/KaTeX needed.
                if (_directHtml !== undefined) return _directHtml;
                // Apply line-breaking if enabled and we have a container width estimate.
                const _lineBreakEnabled = (self.config?.get('notebook.rendering.lineBreakingEnabled')
                    ?? self.config?.get('notebook.rendering.lineBreaking')) !== false;
                // Helper: optional line-break on a single latex string — no paging within a page
                const lbOptsNoPaging = { ...lbOpts, maxRows: 0 };
                const applyLineBreak = (ltx) => {
                    if (!_lineBreakEnabled || !(pageWidthEm > 5) || !_btlAddon.lineBreakLatex) return ltx;
                    try {
                        const r = _btlAddon.lineBreakLatex(ltx, lbOptsNoPaging);
                        return (r && typeof r === 'object') ? (r.result || ltx) : String(r);
                    } catch (_) { return ltx; }
                };
                const _btnStyle = 'padding:1px 7px;font-size:12px;cursor:pointer;background:transparent;' +
                    'border:1px solid rgba(128,128,128,0.3);border-radius:3px;' +
                    'color:var(--vscode-foreground,inherit);line-height:1.5;user-select:none;';
                const _labelStyle = 'font-size:11px;color:var(--vscode-descriptionForeground,#888);min-width:60px;text-align:center;';
                const _buildNavBar = (N, rowsLabel, isTop = false) =>
                    `<div class="wl-matrix-pager-bar" data-session-epoch="${self._sessionEpoch}" style="display:flex;align-items:center;gap:6px;${isTop ? 'margin-bottom:4px' : 'margin-top:4px'};padding:2px 0;">` +
                    `<button data-action="go-first" style="${_btnStyle}" title="First page" disabled>&#9198;</button>` +
                    `<button data-action="prev-page" style="${_btnStyle}" title="Previous page" disabled>&#9664;</button>` +
                    `<span class="wl-matrix-page-label" style="${_labelStyle}">1\u202f/\u202f${N}</span>` +
                    `<button data-action="next-page" style="${_btnStyle}" title="Next page">&#9654;</button>` +
                    `<button data-action="go-last" style="${_btnStyle}" title="Last page">&#9197;</button>` +
                    `<span style="font-size:10px;color:var(--vscode-descriptionForeground,#888);">(${N}\u202fpages, ${rowsLabel})</span>` +
                    `</div>`;

                // ---- Paged output handling (BTL split matrix into pages) ----
                if (totalPages > 1) {
                    // Server-side pager: store box data, send only page 0 to client.
                    // Client requests other pages via 'output-page-request' message.
                    const pagerId = _genPageId();
                    self._pagerStore.set(pagerId, { type: 'matrix', boxStr, btlOpts });
                    const p0Latex = applyLineBreak(latex);
                    let p0Rendered;
                    try { p0Rendered = _btlPrerenderLatex(p0Latex, true); }
                    catch (e) { p0Rendered = `<span style="color:#e05c4e;">KaTeX: ${_encoding.escapeHtml(String(e.message || e))}</span>`; }
                    const errorNote = error ? `<div style="color:#e05c4e;font-size:11px;margin:2px 0;">\u26a0\ufe0f boxToLatex error: ${_encoding.escapeHtml(error)}</div>` : '';
                    if (logPath) {
                        try {
                            const ts = new Date().toISOString();
                            const rawText = rawB64 ? Buffer.from(rawB64, 'base64').toString('utf8') : '';
                            const sep = '='.repeat(72) + '\n';
                            fs.mkdirSync(path.dirname(logPath), { recursive: true });
                            fs.appendFileSync(logPath, sep + ts + (source ? '  [' + source + ']' : '') + '  [PAGED: ' + totalPages + ' pages]\n' +
                                '-- kernel output --\n' + rawText + '\n' +
                                '-- btl input (cleaned boxes) --\n' + boxStr + '\n' +
                                '-- btl output (latex page 1/' + totalPages + ') --\n' + p0Latex + '\n' +
                                (error ? '-- btl error --\n' + error + '\n' : ''));
                        } catch (_) {}
                    }
                    const _latexB64ForPager = Buffer.from(p0Latex).toString('base64');
                    // Seed page 0 in cache so returning to it is free.
                    // Store allPageLatex (all page LaTeX strings from a single C++ call)
                    // so renderPageForPager only needs KaTeX prerender (fast), not boxToLatex re-parse.
                    const _p0Cache = {};
                    _p0Cache[0] = { html: p0Rendered, latexB64: _latexB64ForPager };
                    self._pagerStore.set(pagerId, { type: 'matrix', boxStr, btlOpts, totalPages, allPageLatex, _pageCache: _p0Cache });
                    return `<div class="vscode-wolfram-wllatex-prerendered wl-matrix-pager" data-session-epoch="${self._sessionEpoch}" data-current-page="0" data-page-count="${totalPages}" data-pager-id="${pagerId}" data-page-width-em="${pageWidthEm}" data-latex-b64="${_latexB64ForPager}">` +
                           errorNote + _buildNavBar(totalPages, _maxMatrixRows + '\u202frows/page', true) + `<div class="wl-matrix-page">${p0Rendered}</div>` + _buildNavBar(totalPages, _maxMatrixRows + '\u202frows/page') + '</div>';
                }

                // ---- Single-page output ----
                // Two-phase rendering: phase 1 renders without line-breaking (fast) and
                // displays immediately at reduced opacity. Phase 2 runs lineBreakLatex in a
                // worker thread and patches the element via wl-lb-result message.
                const _lbWouldRun = _lineBreakEnabled && pageWidthEm > 5 && !!_btlAddon.lineBreakLatex;
                // The phase-1 → phase-2 swap visibly changes the output height (unbroken
                // one-liner → multi-line), so it is only worth it for very large formulas.
                // lineBreakLatex is a fast native call at typical sizes, and the KaTeX
                // prerender is synchronous in both paths anyway — run small/medium LaTeX
                // through the synchronous path below so the output arrives at its final,
                // line-broken size and never changes height afterwards.
                const _SYNC_LB_MAX_CHARS = 20000;
                if (_lbWouldRun && latex.length > _SYNC_LB_MAX_CHARS && _btlAddonPath && self._rendererMessaging) {
                    // Phase 1: render unbroken, emit placeholder with reduced opacity
                    let phase1Rendered;
                    try { phase1Rendered = _btlPrerenderLatex(latex, true); }
                    catch (e) {
                        return '<pre class="vscode-wolfram-text-output">WLLatex KaTeX error: ' +
                               _encoding.escapeHtml(String(e.message || e)) + '</pre>';
                    }
                    const lbId = 'lb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
                    const _phase1LatexB64 = Buffer.from(latex).toString('base64');
                    const errorNoteP1 = error
                        ? `<div style="color:#e05c4e;font-size:11px;margin:2px 0;">\u26a0\ufe0f boxToLatex error: ${_encoding.escapeHtml(error)}</div>`
                        : '';
                    // Phase 2: spawn worker to run lineBreakLatex + KaTeX prerender
                    const { Worker } = require('worker_threads');
                    const _lbWorkerPath = require('path').join(__dirname, 'lb-worker.js');
                    const worker = new Worker(_lbWorkerPath, {
                        workerData: {
                            addonPath: _btlAddonPath,
                            katexPrerenderPath: _KATEX_PRERENDER_PATH,
                            latex,
                            lbOpts: { ...lbOpts, allPages: true },
                            logPath: logPath || null,
                            source: source || '',
                            rawText: rawB64 ? Buffer.from(rawB64, 'base64').toString('utf8') : '',
                            boxStr,
                            pageWidthEm,
                        }
                    });
                    const _msgApi = self._rendererMessaging;
                    let _workerResponded = false;
                    worker.once('message', (result) => {
                        _workerResponded = true;
                        if (!result.ok) {
                            // Phase-2 failed: remove opacity guard, keep phase-1 content as-is
                            try { _msgApi.postMessage({ type: 'wl-lb-result', lbId, html: null }); } catch (_) {}
                            return;
                        }
                        if (result.totalPages === 1) {
                            const latexB64 = Buffer.from(result.latexFinal).toString('base64');
                            const lineBroken = result.latexFinal !== latex;
                            try { _msgApi.postMessage({ type: 'wl-lb-result', lbId, html: result.html, latexB64, lineBroken }); } catch (_) {}
                        } else {
                            // lineBreakLatex produced multiple pages — build pager on main thread
                            const pagerId = _genPageId();
                            let p0Rendered;
                            try { p0Rendered = _btlPrerenderLatex(result.latexFinal, true); }
                            catch (e) { p0Rendered = `<span style="color:#e05c4e;">KaTeX: ${_encoding.escapeHtml(String(e.message || e))}</span>`; }
                            const _lbB64 = Buffer.from(result.latexFinal).toString('base64');
                            if (!self._pagerStore) self._pagerStore = new Map();
                            self._pagerStore.set(pagerId, { type: 'lb', latex, lbOpts, totalPages: result.totalPages, allPageLatex: result.allPageLatex, _pageCache: { 0: { html: p0Rendered, latexB64: _lbB64 } } });
                            const pagerHtml =
                                `<div class="vscode-wolfram-wllatex-prerendered wl-matrix-pager" data-current-page="0" data-page-count="${result.totalPages}" data-pager-id="${pagerId}" data-page-width-em="${pageWidthEm}" data-latex-b64="${_lbB64}">` +
                                (error ? `<div style="color:#e05c4e;font-size:11px;margin:2px 0;">\u26a0\ufe0f boxToLatex error: ${_encoding.escapeHtml(error)}</div>` : '') +
                                _buildNavBar(result.totalPages, _maxMatrixRows + '\u202flines/page', true) +
                                `<div class="wl-matrix-page">${p0Rendered}</div>` +
                                _buildNavBar(result.totalPages, _maxMatrixRows + '\u202flines/page') + '</div>';
                            try { _msgApi.postMessage({ type: 'wl-lb-result', lbId, pagerHtml }); } catch (_) {}
                        }
                    });
                    worker.once('error', () => {
                        _workerResponded = true;
                        try { _msgApi.postMessage({ type: 'wl-lb-result', lbId, html: null }); } catch (_) {}
                    });
                    // Safety net: if worker exits without sending a message (native crash, etc.),
                    // restore opacity so the output doesn't stay gray forever.
                    worker.once('exit', () => {
                        if (!_workerResponded) {
                            try { _msgApi.postMessage({ type: 'wl-lb-result', lbId, html: null }); } catch (_) {}
                        }
                    });
                    return `<div class="vscode-wolfram-wllatex-prerendered wl-lb-pending" data-lb-id="${lbId}" data-page-width-em="${pageWidthEm}" data-latex-b64="${_phase1LatexB64}" style="opacity:0.65;transition:opacity 0.35s">` +
                           errorNoteP1 + `<div class="wl-lb-content">${phase1Rendered}</div></div>`;
                }

                // ---- Synchronous line-breaking ----
                // Used for all small/medium LaTeX (≤ _SYNC_LB_MAX_CHARS — the common case,
                // output arrives at final size), and as the fallback when line-breaking is
                // disabled, no page width, addon unavailable, or no renderer messaging.
                let latexFinal = latex;
                let lineBreakStatus = 'disabled';
                let lbTotalPages = 1;
                let lbAllPageLatex = null;
                if (_lbWouldRun) {
                    try {
                        const lbr = _btlAddon.lineBreakLatex(latex, { ...lbOpts, allPages: true });
                        if (lbr && typeof lbr === 'object') {
                            latexFinal = lbr.result || latex;
                            lbTotalPages = lbr.totalPages || 1;
                            lbAllPageLatex = (Array.isArray(lbr.pages) && lbr.pages.length > 1) ? lbr.pages : null;
                        } else { latexFinal = String(lbr); }
                        lineBreakStatus = lbTotalPages > 1
                            ? 'paged: ' + lbTotalPages + ' pages'
                            : latexFinal !== latex ? 'applied' : 'no-change (fits in width)';
                    } catch (e) {
                        latexFinal = latex;
                        lineBreakStatus = 'error: ' + String(e.message || e);
                    }
                } else if (!_lineBreakEnabled) {
                    lineBreakStatus = 'disabled';
                } else if (!(pageWidthEm > 5)) {
                    lineBreakStatus = 'skipped (pageWidthEm=' + pageWidthEm + ')';
                } else {
                    lineBreakStatus = 'unavailable';
                }
                if (logPath) {
                    try {
                        const ts = new Date().toISOString();
                        const rawText = rawB64 ? Buffer.from(rawB64, 'base64').toString('utf8') : '';
                        const sep = '='.repeat(72) + '\n';
                        fs.mkdirSync(path.dirname(logPath), { recursive: true });
                        fs.appendFileSync(logPath, sep + ts + (source ? '  [' + source + ']' : '') + '\n' +
                            '-- kernel output --\n' + rawText + '\n' +
                            '-- btl input (cleaned boxes) --\n' + boxStr + '\n' +
                            '-- btl output (latex) --\n' + latex + '\n' +
                            '-- pageWidthEm: ' + pageWidthEm + '  lineBreak: ' + lineBreakStatus + '  opts: ' + JSON.stringify(lbOpts) + ' --\n' +
                            (error ? '-- btl error --\n' + error + '\n' : ''));
                    } catch (_) {}
                }
                // lb-paging: lineBreakLatex produced multiple pages — server-side pager
                if (lbTotalPages > 1) {
                    const pagerId = _genPageId();
                    let p0Rendered;
                    try { p0Rendered = _btlPrerenderLatex(latexFinal, true); }
                    catch (e) { p0Rendered = `<span style="color:#e05c4e;">KaTeX: ${_encoding.escapeHtml(String(e.message || e))}</span>`; }
                    const errorNote = error ? `<div style="color:#e05c4e;font-size:11px;margin:2px 0;">\u26a0\ufe0f boxToLatex error: ${_encoding.escapeHtml(error)}</div>` : '';
                    const _lbB64 = Buffer.from(latexFinal).toString('base64');
                    // Seed page 0 in cache so returning to it is free.
                    // Store allPageLatex so renderPageForPager only needs KaTeX, not lineBreakLatex re-run.
                    const _lbP0Cache = { 0: { html: p0Rendered, latexB64: _lbB64 } };
                    self._pagerStore.set(pagerId, { type: 'lb', latex, lbOpts, totalPages: lbTotalPages, allPageLatex: lbAllPageLatex, _pageCache: _lbP0Cache });
                    return `<div class="vscode-wolfram-wllatex-prerendered wl-matrix-pager" data-current-page="0" data-page-count="${lbTotalPages}" data-pager-id="${pagerId}" data-page-width-em="${pageWidthEm}" data-latex-b64="${_lbB64}">` +
                           errorNote + _buildNavBar(lbTotalPages, _maxMatrixRows + '\u202flines/page', true) + `<div class="wl-matrix-page">${p0Rendered}</div>` + _buildNavBar(lbTotalPages, _maxMatrixRows + '\u202flines/page') + '</div>';
                }
                let rendered;
                try {
                    rendered = _btlPrerenderLatex(latexFinal, true);
                } catch (e) {
                    return '<pre class="vscode-wolfram-text-output">WLLatex KaTeX error: ' +
                           _encoding.escapeHtml(String(e.message || e)) + '</pre>';
                }
                const errorNote = error
                    ? `<div style="color:#e05c4e;font-size:11px;margin:2px 0;">\u26a0\ufe0f boxToLatex error: ${_encoding.escapeHtml(error)}</div>`
                    : '';
                const lineBrokenAttr = (lineBreakStatus === 'applied' || lineBreakStatus.startsWith('paged')) ? ' data-line-broken="1"' : '';
                const _latexB64ForA = Buffer.from(latexFinal).toString('base64');
                return `<div class="vscode-wolfram-wllatex-prerendered" data-page-width-em="${pageWidthEm}"${lineBrokenAttr} data-latex-b64="${_latexB64ForA}">` +
                       errorNote + rendered + '</div>';
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

// Rewrite one plot image's width/height inside an output's stored HTML, so a
// size the reader dragged survives save and reload.
//
// This edits the stored HTML rather than re-rendering: the picture on disk is
// untouched and only the display size changes. injectImageDimensions leaves an
// existing width= alone (its negative lookahead), so nothing puts the kernel's
// size back afterwards. width <= 0 means "reset to the kernel's own size".
const IMG_TAG_RE = /<img\s[^>]*class="vscode-wolfram-(?:svg|png)-output"[^>]*>/g;

function setImageSizeInHtml(html, imgIndex, width, height) {
    let n = -1;
    return html.replace(IMG_TAG_RE, (tag) => {
        n++;
        if (n !== imgIndex) return tag;
        let core = tag.replace(/\s*\/?>\s*$/, '')
                      .replace(/\s+(?:width|height)="[^"]*"/g, '');
        if (width > 0) {
            core += ` width="${Math.round(width)}"`;
            if (height > 0) core += ` height="${Math.round(height)}"`;
        }
        return core + '/>';
    });
}

async function resizeOutputImage(self, cell, outputId, imgIndex, width, height) {
    const allOutputs = [...cell.outputs];
    let targetIndex = -1, html = null;
    for (let i = 0; i < allOutputs.length; i++) {
        const items = allOutputs[i].items || [];
        if (!items.length) continue;
        try {
            const text = new TextDecoder().decode(items[0].data);
            if (text.includes(`data-output-id="${outputId}"`)) {
                targetIndex = i; html = text; break;
            }
        } catch (_) {}
    }
    if (targetIndex === -1 || html === null) {
        if (DEV_MODE) self.outputPanel.print(`[resizeOutput] outputId ${outputId} not found`);
        return;
    }
    const next = setImageSizeInHtml(html, imgIndex | 0, width, height);
    if (next === html) return;              // nothing changed — don't dirty the file
    allOutputs[targetIndex] = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(next, "x-application/wolfram-language-html")
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
    // Prefer compact explicit preview metadata when available (Mode B raw-latex div).
    const previewMatch = html.match(/data-latex-preview="([\s\S]*?)"(?:\s|>)/);
    if (previewMatch) {
        const preview = previewMatch[1]
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ').trim();
        if (preview) {
            const nMatch = html.match(/data-latex-chars="(\d+)"/);
            const nInfo = nMatch ? ` [latex chars: ${nMatch[1]}]` : '';
            return `${outName} ${preview}${nInfo}`;
        }
    }

    // Fallback for all WLLatex variants: decode data-latex-b64 when preview metadata is absent.
    const latexMatch = html.match(/data-latex-b64="([^"]+)"/);
    if (latexMatch) {
        try {
            const latex = Buffer.from(latexMatch[1], 'base64').toString('utf8');
            if (latex.trim()) {
                const MAX = 1200;
                const trimmed = latex.trim();
                if (trimmed.length > MAX) {
                    return `${outName} ${trimmed.slice(0, MAX)}… [latex truncated: ${trimmed.length} chars total]`;
                }
                return `${outName} ${trimmed}`;
            }
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
// Render one page for a server-side pager entry.
// Called from controller.js when the client posts 'output-page-request'.
// Returns rendered KaTeX HTML for the requested page, or null on failure.
function renderPageForPager(self, pagerId, page) {
    if (!self._pagerStore) return null;
    const entry = self._pagerStore.get(pagerId);
    if (!entry) return null;
    // Cache hit: return already-rendered page immediately (O(1), no BTL re-parse)
    if (entry._pageCache && entry._pageCache[page] !== undefined) {
        return entry._pageCache[page];
    }
    _loadBtlAddon();
    if (!_btlAddon) return null;
    const logPath = _btlLogPath();
    let pageLatex = '';
    let btlError = null;
    try {
        if (entry.type === 'lb') {
            // Fast path: allPageLatex has all page LaTeX pre-computed from initial call
            if (entry.allPageLatex && page >= 0 && page < entry.allPageLatex.length) {
                pageLatex = entry.allPageLatex[page];
            } else {
                // Fallback: re-run lineBreakLatex for the requested page
                const lbr = _btlAddon.lineBreakLatex(entry.latex, { ...entry.lbOpts, requestedPage: page });
                pageLatex = (lbr && typeof lbr === 'object' && lbr.result) ? lbr.result : String(lbr || '');
            }
        } else if (entry.type === 'matrix') {
            // Fast path: allPageLatex has all page LaTeX strings pre-computed from the
            // initial boxToLatex call — just index into it (no C++ re-parse needed).
            if (entry.allPageLatex && page >= 0 && page < entry.allPageLatex.length) {
                pageLatex = entry.allPageLatex[page];
            } else {
                // Fallback: older pager entry without allPageLatex — re-run boxToLatex
                const result = _btlAddon.boxToLatex(entry.boxStr, { ...entry.btlOpts, requestedPage: page });
                if (result && typeof result === 'object') {
                    pageLatex = result.latex || '';
                    btlError = result.error || null;
                } else {
                    pageLatex = String(result || '');
                }
            }
        }
    } catch (e) {
        btlError = String(e.message || e);
        if (logPath) {
            try {
                const ts = new Date().toISOString();
                fs.mkdirSync(path.dirname(logPath), { recursive: true });
                fs.appendFileSync(logPath, '='.repeat(72) + '\n' + ts +
                    `  [page-request pager=${pagerId} page=${page}/${entry.totalPages||'?'}]\n` +
                    '-- btl error --\n' + btlError + '\n');
            } catch (_) {}
        }
        return { html: `<span style="color:#e05c4e;">BTL error (page ${page}): ${_encoding.escapeHtml(btlError)}</span>`, latexB64: '' };
    }
    if (logPath) {
        try {
            const ts = new Date().toISOString();
            const sep = '='.repeat(72) + '\n';
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, sep + ts +
                `  [page-request type=${entry.type} pager=${pagerId} page=${page}]\n` +
                '-- btl output (latex) --\n' + pageLatex + '\n' +
                (btlError ? '-- btl error --\n' + btlError + '\n' : ''));
        } catch (_) {}
    }
    const latexB64 = Buffer.from(pageLatex || '').toString('base64');
    let result;
    if (!pageLatex) {
        result = { html: `<span style="color:#888;">(empty page)</span>`, latexB64: '' };
    } else {
        try {
            result = { html: _btlPrerenderLatex(pageLatex, true), latexB64 };
        } catch (e) {
            result = { html: `<span style="color:#e05c4e;">KaTeX error: ${_encoding.escapeHtml(String(e.message || e))}</span>`, latexB64 };
        }
    }
    // Cache for instant re-access
    if (!entry._pageCache) entry._pageCache = {};
    entry._pageCache[page] = result;
    return result;
}

// ---------------------------------------------------------------------------
// Image dimension injection — layout-shift fix
//
// Kernel-produced <img> tags carry no width/height, so the webview measures
// the output at ~zero height and the cell grows when the file loads — the
// single largest source of visible layout jumps. The kernel writes the file
// before returning the HTML, so we can read the dimensions here (PNG IHDR /
// SVG width+height attrs) and inject width/height attributes. Attributes at
// intrinsic size reproduce the current rendered size exactly; the browser
// just reserves the space up front.

// path → {w,h} | null. Files are content-hash-named (immutable), so a flat
// cache with a simple size cap is enough.
const _imgDimCache = new Map();

function _svgLengthToPx(value, unit) {
    const v = parseFloat(value);
    if (!(v > 0)) return 0;
    switch (unit) {
        case 'pt': return v * 4 / 3;
        case 'pc': return v * 16;
        case 'in': return v * 96;
        case 'cm': return v * 96 / 2.54;
        case 'mm': return v * 96 / 25.4;
        default:   return v;           // px or unitless
    }
}

function _readImageDimensions(fsPath) {
    const lower = fsPath.toLowerCase();
    if (lower.endsWith('.png')) {
        const fd = fs.openSync(fsPath, 'r');
        try {
            const buf = Buffer.alloc(24);
            if (fs.readSync(fd, buf, 0, 24, 0) < 24) return null;
            // PNG signature + IHDR: width/height are big-endian uint32 at 16/20
            if (buf.readUInt32BE(0) !== 0x89504e47) return null;
            const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
            return (w > 0 && h > 0) ? { w, h } : null;
        } finally { fs.closeSync(fd); }
    }
    if (lower.endsWith('.svg')) {
        // render-expr.wl strips newlines from exported SVG, so the opening
        // <svg …> tag sits within the first few KB.
        const fd = fs.openSync(fsPath, 'r');
        let head;
        try {
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, 4096, 0);
            head = buf.toString('utf8', 0, n);
        } finally { fs.closeSync(fd); }
        const openTag = (head.match(/<svg\b[^>]*>/) || [])[0];
        if (!openTag) return null;
        const wm = openTag.match(/\bwidth="([\d.]+)(pt|px|pc|in|cm|mm)?"/);
        const hm = openTag.match(/\bheight="([\d.]+)(pt|px|pc|in|cm|mm)?"/);
        if (wm && hm) {
            const w = Math.round(_svgLengthToPx(wm[1], wm[2]));
            const h = Math.round(_svgLengthToPx(hm[1], hm[2]));
            if (w > 0 && h > 0) return { w, h };
        }
        const vb = openTag.match(/\bviewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
        if (vb) {
            const w = Math.round(parseFloat(vb[1])), h = Math.round(parseFloat(vb[2]));
            if (w > 0 && h > 0) return { w, h };
        }
        return null;
    }
    return null;
}

// Inject width/height into every wolfbook <img> tag that lacks them.
// Non-fatal: any unreadable/missing file simply leaves the tag unchanged.
function injectImageDimensions(html) {
    if (!html || html.indexOf('data-wl-img=') === -1) return html;
    return html.replace(
        /<img\s+class="vscode-wolfram-(?:svg|png)-output"\s+data-wl-img="([^"]+)"(?![^>]*\bwidth=)/g,
        (tagPrefix, imgPath) => {
            try {
                let dims = _imgDimCache.get(imgPath);
                if (dims === undefined) {
                    dims = _readImageDimensions(imgPath);
                    if (_imgDimCache.size > 500) _imgDimCache.clear();
                    _imgDimCache.set(imgPath, dims);
                }
                if (dims) return `${tagPrefix} width="${dims.w}" height="${dims.h}"`;
            } catch (_) {}
            return tagPrefix;
        }
    );
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
    resizeOutputImage,
    setImageSizeInHtml,
    extractPlainText,
    renderPageForPager,
    injectImageDimensions,
};
