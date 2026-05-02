/*
 * Wolfram notebook renderer with messaging support for interactive expand buttons
 * 
 * Copyright (c) 2026 Nikolay Gromov
 * 
 * Created February 2026 by Nikolay Gromov
 * Features:
 *   - Interactive truncated output expansion controls
 *   - Wrap/scroll toggle for MathML expressions
 *   - Messaging system for kernel communication
 *   - Dynamic content updates via postMessage
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Inline syntax highlighter, CSS injector, line-number gutter.
// renderer-highlight.js transitively loads renderer-css.js (DEV_MODE, WL_CSS, console gate).
import { applyInlineHighlight, injectRendererCSS, addLineNumberGutter } from './renderer-highlight.js';

// Module-level marker — confirms this file (index-with-messaging.js) was loaded
console.log('[WolframRenderer] *** index-with-messaging.js MODULE LOADED ***');

export function activate(context) {
    console.log('[WolframRenderer] activate() called');
    console.log('[WolframRenderer] context:', context);
    console.log('[WolframRenderer] context.postMessage available:', !!(context && context.postMessage));
    const disposables = {};

    // ---- Wolfbook loading splash ----
    const _WB_LOGO_B64 = 'data:image/png;base64,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';
    let _wbSplashRemoved = false;
    function _wbRemoveSplash() {
        if (_wbSplashRemoved) return;
        _wbSplashRemoved = true;
        const s = document.getElementById('wb-loading-splash');
        if (s) { s.style.opacity = '0'; setTimeout(() => s.remove && s.remove(), 450); }
    }
    function _wbShowSplash() {
        if (_wbSplashRemoved) return;
        const s = document.createElement('div');
        s.id = 'wb-loading-splash';
        s.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;' +
            'background:var(--vscode-notebook-outputBackground,var(--vscode-editor-background,#1e1e1e));' +
            'z-index:99999;transition:opacity 0.4s ease;pointer-events:none;';
        const img = document.createElement('img');
        img.src = _WB_LOGO_B64;
        img.style.cssText = 'width:72px;height:72px;opacity:0.9;border-radius:14px;';
        const lbl = document.createElement('div');
        lbl.textContent = 'Wolfbook';
        lbl.style.cssText = 'margin-top:10px;color:rgba(255,255,255,0.45);font-family:' +
            'var(--vscode-font-family,sans-serif);font-size:13px;letter-spacing:2px;text-transform:uppercase;';
        const ring = document.createElement('div');
        ring.style.cssText = 'margin-top:18px;width:22px;height:22px;border-radius:50%;' +
            'border:2px solid rgba(255,255,255,0.15);border-top-color:rgba(255,255,255,0.65);' +
            'animation:_wb_spin 0.75s linear infinite;';
        const sty = document.createElement('style');
        sty.textContent = '@keyframes _wb_spin{to{transform:rotate(360deg)}}';
        s.append(sty, img, lbl, ring);
        (document.body || document.documentElement).appendChild(s);
        setTimeout(_wbRemoveSplash, 4000);
    }
    _wbShowSplash();
    // ---- end loading splash ----

    // Current kernel session epoch — incremented by the controller on every kernel launch.
    // Dynamic elements (Out[N]= headers, expand banners) are tagged with the epoch at
    // render time; when the session changes we remove all stale-epoch elements.
    let sessionEpoch = 0;

    // MathML zoom level — shared across all MathML outputs in the session.
    // Controlled by ⊕/⊖ buttons; applied as fontSize on div.mathml-output.
    let wolframMathmlZoom = 1.0;

    // TXT output font-size scale — shared across all TXT pre blocks.
    let wolframTxtFontSize = 1.0;

    // Notebook-level default output format — split by output type so graphics and
    // expression defaults are independent. Set by double-clicking a format button.
    let wolframNbDefaultGfxFormat  = '';   // graphics outputs (SVG, TikZ)
    let wolframNbDefaultExprFormat = '';   // expression outputs (WLLatex, MathML, etc.)

    // Map of uuid -> { button, origHTML } for open-text buttons awaiting reply
    const openTextPending = new Map();

    // Map of outputId -> detached div containing the saved WLLatex content DOM nodes.
    // Populated when switching to WLLatexSrc so we can restore client-side (preserving
    // pager event listeners and the current page) when switching back to WLLatex.
    const savedWLLatexContent = new Map();

    // Match tester/webview KaTeX behavior and avoid expansion-limit failures
    // on very large formulas emitted by BTL.
    const KATEX_RENDER_OPTIONS = {
        displayMode: true,
        throwOnError: false,
        output: 'html',
        trust: false,
        strict: false,
        maxExpand: 100000,
        macros: {
            '\\dd': '\\mathrm{d}',
            '\\R': '\\mathbb{R}',
            '\\C': '\\mathbb{C}',
            '\\N': '\\mathbb{N}',
        },
    };

    // Listen for replies from the extension (open-text-done / open-text-error / session-changed / kernel-offline / kernel-online)
    if (context && context.onDidReceiveMessage) {
        context.onDidReceiveMessage(msg => {
            // ---- Kernel online/offline visual state ----
            if (msg.type === 'kernel-offline' || msg.type === 'kernel-online') {
                const offline = msg.type === 'kernel-offline';
                // Inject or update a single <style> element that drives the grayscale filter.
                let ks = document.querySelector('style[data-wolfram-kernel-state]');
                if (!ks) {
                    ks = document.createElement('style');
                    ks.setAttribute('data-wolfram-kernel-state', '1');
                    (document.head || document.body || document.documentElement).appendChild(ks);
                }
                ks.textContent = offline
                    ? 'body { filter: grayscale(0.75) opacity(0.55); background-color: var(--vscode-notebook-outputBackground, var(--vscode-editor-background, #1e1e1e)); transition: filter 0.4s, opacity 0.4s; }'
                    : 'body { filter: none; opacity: 1; background-color: transparent; transition: filter 0.4s, opacity 0.4s; }';
                console.log('[WolframRenderer] kernel state →', msg.type);
                return;
            }
            if (msg.type === 'session-changed' && typeof msg.epoch === 'number') {
                console.log('[WolframRenderer] session-changed — new epoch:', msg.epoch,
                            '| old epoch:', sessionEpoch);
                sessionEpoch = msg.epoch;
                // Remove all dynamic elements tagged with an old session epoch.
                // These are: Out[N]= header rows and truncation/expand banners.
                // The raw output content (.wl-output-content) is left in place so
                // the user can still read old outputs, but the stale interactive
                // UI elements that reference kernel state are cleaned up.
                const stale = document.querySelectorAll('[data-session-epoch]');
                let removed = 0;
                stale.forEach(el => {
                    if (el.dataset.sessionEpoch !== String(msg.epoch)) {
                        el.remove();
                        removed++;
                    }
                });
                console.log('[WolframRenderer] removed', removed, 'stale dynamic element(s)');
                return;
            }
            if ((msg.type === 'open-text-done' || msg.type === 'open-text-error') && msg.uuid) {
                const entry = openTextPending.get(msg.uuid);
                if (entry) {
                    entry.button.innerHTML = entry.origHTML;
                    entry.button.disabled = false;
                    entry.button.style.cursor = '';
                    entry.button.style.opacity = '';
                    openTextPending.delete(msg.uuid);
                }
            }
            if (msg.type === 'reformat-done') {
                // scroll handled by controller revealRange — nothing to do in renderer
            }

            // ---- Server-side pager: update one page of content ----
            if (msg.type === 'output-page-result' && msg.pagerId) {
                const pager = document.querySelector('.wl-matrix-pager[data-pager-id="' + msg.pagerId + '"]');
                if (pager) {
                    const N = parseInt(pager.getAttribute('data-page-count') || '1', 10);
                    const page = typeof msg.page === 'number' ? msg.page : 0;
                    const contentDiv = pager.querySelector('.wl-matrix-page');
                    if (contentDiv && msg.html) contentDiv.innerHTML = msg.html;
                    if (msg.latexB64) pager.setAttribute('data-latex-b64', msg.latexB64);
                    pager.setAttribute('data-current-page', String(page));
                    // Update all nav bars (top + bottom)
                    pager.querySelectorAll('.wl-matrix-page-label').forEach(lbl => lbl.textContent  = `${page + 1}\u202f/\u202f${N}`);
                    pager.querySelectorAll('button[data-action="go-first"]').forEach(btn => btn.disabled = page === 0);
                    pager.querySelectorAll('button[data-action="prev-page"]').forEach(btn => btn.disabled = page === 0);
                    pager.querySelectorAll('button[data-action="next-page"]').forEach(btn => btn.disabled = page === N - 1);
                    pager.querySelectorAll('button[data-action="go-last"]').forEach(btn => btn.disabled = page === N - 1);
                }
                return;
            }

            // ---- Expand-more reset: un-stuck the "Expanding…" button ----
            if (msg.type === 'expand-more-reset' && msg.uuid) {
                const banner = document.querySelector('[data-truncated-uuid="' + msg.uuid + '"]');
                if (banner) {
                    const btn = banner.querySelector('button[data-action="expand-more"]');
                    if (btn) {
                        btn.innerHTML = '&#43;&#8230;';
                        btn.disabled = false;
                        btn.style.cssText = btn.style.cssText.replace(/cursor:[^;]+;/g, '').replace(/opacity:[^;]+;/g, '');
                    }
                }
                return;
            }
            if (msg.type === 'nb-default-format') {
                // Controller restored the saved defaults for this notebook on reopen.
                // formatGfx and formatExpr are independent — either may be empty.
                if (msg.formatGfx)  wolframNbDefaultGfxFormat  = msg.formatGfx;
                if (msg.formatExpr) wolframNbDefaultExprFormat = msg.formatExpr;
                // No persistent highlight — default is remembered internally only.
            }

            // ---- Phase-2 async line-breaking result ----
            // Replaces a wl-lb-pending placeholder with the line-broken KaTeX HTML.
            if (msg.type === 'wl-lb-result' && msg.lbId) {
                const el = document.querySelector('[data-lb-id="' + msg.lbId + '"]');
                if (el) {
                    if (msg.pagerHtml) {
                        // lineBreakLatex produced multiple pages — replace entire element with pager
                        const tmp = document.createElement('div');
                        tmp.innerHTML = msg.pagerHtml;
                        const pagerEl = tmp.firstElementChild;
                        if (pagerEl) el.replaceWith(pagerEl);
                    } else if (msg.html !== null && msg.html !== undefined) {
                        // Single-page: replace inner content and remove pending style
                        const inner = el.querySelector('.wl-lb-content');
                        if (inner) inner.innerHTML = msg.html;
                        if (msg.latexB64) el.setAttribute('data-latex-b64', msg.latexB64);
                        if (msg.lineBroken) el.setAttribute('data-line-broken', '1');
                    }
                    // Remove pending class and restore opacity (CSS transition to 1.0)
                    el.classList.remove('wl-lb-pending');
                    el.style.opacity = '';
                    el.style.transition = '';
                }
                return;
            }

            // ---- WBPrint expire — remove all WBPrint DOM nodes to free memory ----
            if (msg.type === 'wbp-expire') {
                document.querySelectorAll('.wl-wbp-output').forEach(el => el.remove());
                return;
            }

            // ---- Dialog[] subsession widget ----
            if (msg.type === 'dialog-begin') {
                showDialogWidget(context);
            }
            if (msg.type === 'dialog-print') {
                appendDialogOutput(msg.html, false);
            }
            if (msg.type === 'dialog-eval-result') {
                const s = wexprToInputForm(msg.result);
                appendDialogOutput(
                    '<div class="wl-dialog-result">' +
                        escapeHtml(s) +
                    '</div>',
                    true
                );
                // re-enable the submit button
                const btn = document.getElementById('wl-dialog-submit');
                if (btn) { btn.disabled = false; btn.textContent = 'Eval'; }
            }
            if (msg.type === 'dialog-eval-error') {
                appendDialogOutput(
                    '<div class="wl-dialog-error">' + escapeHtml(msg.error || 'Error') + '</div>',
                    true
                );
                const btn = document.getElementById('wl-dialog-submit');
                if (btn) { btn.disabled = false; btn.textContent = 'Eval'; }
            }
            if (msg.type === 'dialog-end') {
                removeDialogWidget();
            }
            // ---- Background image (applied to cell-output body) ----
            if (msg.type === 'bg-image') {
                let bgStyle = document.querySelector('style[data-wolfram-bg-image]');
                if (!bgStyle) {
                    bgStyle = document.createElement('style');
                    bgStyle.setAttribute('data-wolfram-bg-image', '1');
                    (document.head || document.documentElement).appendChild(bgStyle);
                }
                bgStyle.textContent = msg.dataUrl
                    ? `body { background-image: url('${msg.dataUrl}'); background-size: cover; background-attachment: fixed; background-position: center; }`
                    : '';
                return;
            }
        });
        // Announce to the extension that this renderer instance is ready to receive
        // kernel-offline / kernel-online messages. The extension will respond with
        // the current kernel status immediately, correcting the case where the
        // extension sent kernel-offline before this webview's listener was live.
        try { context.postMessage({ type: 'renderer-ready' }); } catch (_) {}

        // Report container width to extension host so it can pass an accurate
        // pageWidth to lineBreakLatex.  We send once immediately and re-send on
        // every resize so the value stays up-to-date when the user resizes the
        // VS Code window or panel.
        (function _initContainerWidthReporting() {
            // The most reliable width measurement is the input cell itself.
            // .cell-bottom-toolbar-container is a VS Code notebook cell DOM element
            // that lives at the same horizontal extent as the input area and does
            // NOT expand when wide output is rendered.
            function _getCellInputWidth() {
                const el = document.querySelector('.cell-bottom-toolbar-container');
                if (el) {
                    const w = el.offsetWidth || el.scrollWidth || 0;
                    if (w > 0) return w;
                }
                return 0;
            }
            function _reportWidth() {
                if (!(context && context.postMessage)) return;
                const w = _getCellInputWidth();
                if (w > 0) try { context.postMessage({ type: 'container-width', widthPx: w }); } catch (_) {}
            }
            _reportWidth();
            try {
                const _ro = new ResizeObserver(_reportWidth);
                const _target = document.querySelector('.cell-bottom-toolbar-container') || document.body;
                _ro.observe(_target);
            } catch (_) {}
        })();
    }
    
    // -----------------------------------------------------------------------
    // Helper: render a WExpr as InputForm string (for dialog result display)
    function wexprToInputForm(expr) {
        if (!expr || typeof expr !== 'object') return String(expr);
        if (expr.error) return '(error: ' + String(expr.error) + ')';
        if (expr.type === 'integer' || expr.type === 'real') return String(expr.value);
        if (expr.type === 'string') return '"' + String(expr.value).replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"';
        if (expr.type === 'symbol') return String(expr.value);
        if (expr.type === 'function') {
            const head = String(expr.head || '?');
            const args = (expr.args || []).map(wexprToInputForm).join(', ');
            return head + '[' + args + ']';
        }
        return JSON.stringify(expr);
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // -----------------------------------------------------------------------
    // Dialog widget: a fixed panel at the bottom of the notebook viewport.
    const DIALOG_PANEL_ID = 'wl-dialog-panel';

    function showDialogWidget(msgContext) {
        // Only create once; dialog-begin may fire multiple times if user
        // opens a nested level or the kernel re-opens.
        let panel = document.getElementById(DIALOG_PANEL_ID);
        if (panel) {
            panel.style.display = 'flex';
            const ta = panel.querySelector('textarea');
            if (ta) ta.focus();
            return;
        }

        // Inject dialog CSS
        let css = document.getElementById('wl-dialog-css');
        if (!css) {
            css = document.createElement('style');
            css.id = 'wl-dialog-css';
            css.textContent = `
#wl-dialog-panel {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 9999;
    background: var(--vscode-editor-background, #1e1e1e);
    border-top: 3px solid #e8a020;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.45);
    display: flex;
    flex-direction: column;
    max-height: 40vh;
    font-family: var(--vscode-editor-font-family, Consolas, monospace);
    font-size: 13px;
}
#wl-dialog-banner {
    display: flex;
    align-items: center;
    padding: 4px 10px;
    background: rgba(232,160,32,0.13);
    border-bottom: 1px solid rgba(232,160,32,0.3);
    color: #e8a020;
    font-size: 11px;
    gap: 8px;
}
#wl-dialog-banner .wl-dialog-title { font-weight: bold; flex: 1; }
#wl-dialog-close {
    cursor: pointer; background: none; border: none;
    color: #e8a020; font-size: 14px; padding: 0 4px; line-height: 1;
}
#wl-dialog-close:hover { color: #fff; }
#wl-dialog-output {
    flex: 1; overflow-y: auto; padding: 6px 12px;
    min-height: 60px;
    color: var(--vscode-editor-foreground, #d4d4d4);
}
.wl-dialog-result {
    color: #9cdcfe;
    padding: 2px 0;
    white-space: pre-wrap;
    word-break: break-all;
}
.wl-dialog-error {
    color: #f44747;
    padding: 2px 0;
    font-style: italic;
}
#wl-dialog-inputrow {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid rgba(232,160,32,0.2);
}
#wl-dialog-prompt {
    color: #e8a020;
    padding-top: 6px;
    white-space: nowrap;
    font-weight: bold;
    font-size: 12px;
    user-select: none;
}
#wl-dialog-input {
    flex: 1;
    resize: vertical;
    min-height: 36px;
    max-height: 120px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #d4d4d4);
    border: 1px solid rgba(232,160,32,0.4);
    border-radius: 3px;
    padding: 5px 8px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
}
#wl-dialog-input:focus { border-color: #e8a020; }
#wl-dialog-submit {
    background: none;
    border: 1px solid #e8a020;
    color: #e8a020;
    border-radius: 3px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    align-self: flex-start;
    margin-top: 2px;
}
#wl-dialog-submit:hover:not(:disabled) { background: rgba(232,160,32,0.15); }
#wl-dialog-submit:disabled { opacity: 0.4; cursor: default; }
`;
            (document.head || document.body || document.documentElement).appendChild(css);
        }

        panel = document.createElement('div');
        panel.id = DIALOG_PANEL_ID;
        panel.innerHTML = `
<div id="wl-dialog-banner">
  <span class="wl-dialog-title">Dialog[] subsession — kernel suspended</span>
  <span style="font-size:10px;opacity:0.8;">Shift+Enter: evaluate &nbsp;|&nbsp; Esc: exit</span>
  <button id="wl-dialog-close" title="Exit dialog (Return[])">✕</button>
</div>
<div id="wl-dialog-output"></div>
<div id="wl-dialog-inputrow">
  <span id="wl-dialog-prompt">Dialog:=</span>
  <textarea id="wl-dialog-input" rows="1" placeholder="Type Wolfram expression…" spellcheck="false"></textarea>
  <button id="wl-dialog-submit">Eval</button>
</div>`;

        document.body.appendChild(panel);

        const input  = document.getElementById('wl-dialog-input');
        const submit = document.getElementById('wl-dialog-submit');
        const close  = document.getElementById('wl-dialog-close');

        function doEval() {
            const expr = input.value.trim();
            if (!expr) return;
            input.value = '';
            submit.disabled = true;
            submit.textContent = '…';
            const requestId = Math.random().toString(36).slice(2);
            appendDialogOutput(
                '<div style="color:#888;font-size:11px;margin-top:4px;">Dialog:= ' + escapeHtml(expr) + '</div>',
                false
            );
            if (msgContext && msgContext.postMessage) {
                msgContext.postMessage({ type: 'dialog-eval-request', expr, requestId });
            }
        }

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                doEval();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                if (msgContext && msgContext.postMessage) {
                    msgContext.postMessage({ type: 'dialog-exit-request' });
                }
                removeDialogWidget();
            }
        });
        submit.addEventListener('click', () => doEval());
        close.addEventListener('click', () => {
            if (msgContext && msgContext.postMessage) {
                msgContext.postMessage({ type: 'dialog-exit-request' });
            }
            removeDialogWidget();
        });

        input.focus();
    }

    function appendDialogOutput(html, scrollToBottom) {
        const out = document.getElementById('wl-dialog-output');
        if (!out) return;
        const d = document.createElement('div');
        d.innerHTML = html;
        out.appendChild(d);
        if (scrollToBottom) out.scrollTop = out.scrollHeight;
    }

    function removeDialogWidget() {
        const panel = document.getElementById(DIALOG_PANEL_ID);
        if (panel) panel.remove();
    }

    return {
        renderOutputItem(outputItem, element) {
            _wbRemoveSplash();
            // Capture outputItem.id now — used by buttons to request scroll/expand
            const currentOutputId = outputItem.id;
            // Inject CSS once per document
            injectRendererCSS(element.ownerDocument || document);

            // SCROLL-TIMING: notify extension of renderer-side render start
            if (context && context.postMessage) {
                try { context.postMessage({ type: 'render-timing', phase: 'render-start', id: outputItem.id, t: Date.now() }); } catch(_){}
            }

            const rawHtml = outputItem.text();
            console.log('[WolframRenderer] renderOutputItem — outputItem id:', outputItem.id,
                        '| HTML length:', rawHtml.length,
                        '| hasMathML:', rawHtml.includes('class="mathml-output"'),
                        '| hasSkeleton:', rawHtml.includes('data-wolfram-is-skeleton'),
                        '| hasBanner:', rawHtml.includes('data-truncated-uuid'));

            // Decode WL/WSTP string escapes that the kernel inlines into HTML.
            // WSTP encoding rules (WSGetString):
            //   \\  → single backslash  (e.g. LaTeX \alpha arrives as \\alpha)
            //   \012 → newline          (\015\012 = CRLF)
            //   \015 → carriage return
            // Decode \012/\015 FIRST so their leading \ is not consumed by the
            // backslash step, then decode remaining \\ pairs.
            const cleanHtml = rawHtml
                .replace(/\\015\\012/g, '\n')  // CRLF octal pair
                .replace(/\\015/g, '\n')
                .replace(/\\012/g, '\n')
                .replace(/\\\\/g, '\\');       // WSTP \\ → single backslash

            console.log('[WolframRenderer] HTML preview (first 300 chars):', cleanHtml.substring(0, 300));

            // Measure the cell content width BEFORE setting innerHTML.
            // After innerHTML the element expands to fit wide KaTeX, so this is
            // the only reliable moment to get the true column width from within
            // the output iframe (cross-frame DOM access is blocked by VS Code).
            const _preRenderWidth = element.offsetWidth || element.clientWidth || 0;

            // Render HTML content
            element.innerHTML = cleanHtml;
            console.log('[WolframRenderer] innerHTML assigned — pre-render element width was:', _preRenderWidth);

            // ---- Hover output → send source-line highlight request to extension ----
            // ---- Double-click output header → navigate cursor to source line ----
            // Attach once per element; reads header data lazily at event time so it
            // works correctly even if replaceOutputItems updates the HTML later.
            if (!element._wlHoverAttached && context && context.postMessage) {
                element._wlHoverAttached = true;
                element.addEventListener('mouseenter', () => {
                    const _hdr = element.querySelector('.wl-output-header[data-cell-idx]');
                    if (!_hdr) return;
                    const _cidx = parseInt(_hdr.getAttribute('data-cell-idx'), 10);
                    if (isNaN(_cidx)) return;
                    const _sStart = parseInt(_hdr.getAttribute('data-sub-start') || '0', 10);
                    const _sEnd   = parseInt(_hdr.getAttribute('data-sub-end')   || '0', 10);
                    try { context.postMessage({ type: 'hover-output', cellIdx: _cidx, start: _sStart, end: _sEnd }); } catch (_) {}
                });
                element.addEventListener('mouseleave', () => {
                    try { context.postMessage({ type: 'hover-output-end' }); } catch (_) {}
                });
                // Double-click the output header bar → navigate to source line in cell editor
                element.addEventListener('dblclick', (evt) => {
                    const _hdr = (evt.target && evt.target.closest)
                        ? evt.target.closest('.wl-output-header[data-cell-idx]')
                        : null;
                    if (!_hdr) return;
                    const _cidx = parseInt(_hdr.getAttribute('data-cell-idx'), 10);
                    if (isNaN(_cidx)) return;
                    const _sStart = parseInt(_hdr.getAttribute('data-sub-start') || '0', 10);
                    const _sEnd   = parseInt(_hdr.getAttribute('data-sub-end')   || '0', 10);
                    try { context.postMessage({ type: 'goto-source', cellIdx: _cidx, start: _sStart, end: _sEnd }); } catch (_) {}
                });
            }

            // SCROLL-TIMING: notify extension that DOM has been updated
            if (context && context.postMessage) {
                try { context.postMessage({ type: 'render-timing', phase: 'dom-updated', id: outputItem.id, t: Date.now(), h: element.scrollHeight }); } catch(_){}
            }

            // Double requestAnimationFrame: first rAF fires at the start of the next
            // paint frame (layout not yet complete), second rAF fires after the browser
            // has finished layout and the cell has its final rendered height.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    console.log('[WolframRenderer] render layout COMPLETE — cell height is stable (double-rAF)');

                    // ---- KaTeX width calibration ----
                    // Measure the true visible content width by finding our own
                    // .wl-output-header bar (a width:100% flex row inside the output).
                    // Its getBoundingClientRect().width gives the exact visible column
                    // width, immune to content overflow.
                    if (context && context.postMessage) {
                        const _inputEl = document.querySelector('.cell-bottom-toolbar-container');

                        // Primary measurement: the header bar we inject in every output.
                        // It's a 100%-width flex div, so its rect width = visible content area.
                        const _headerEl = element.querySelector('.wl-output-header');
                        const _headerRect = _headerEl ? _headerEl.getBoundingClientRect() : null;
                        const _headerW = _headerRect ? Math.round(_headerRect.width) : 0;

                        // Fallback chain: header width → pre-render element width → toolbar
                        let containerW = _headerW > 0 ? _headerW
                                       : (_preRenderWidth > 0 ? _preRenderWidth
                                       : (_inputEl ? (_inputEl.offsetWidth || _inputEl.scrollWidth || 0) : 0));

                        // Measure rendered KaTeX content width — both Mode A (prerendered)
                        // and Mode B (raw-latex rendered by webview KaTeX).
                        const _debugDivs = element.querySelectorAll('.vscode-wolfram-wllatex-prerendered[data-page-width-em]');
                        const _debugEntries = [];
                        _debugDivs.forEach(div => {
                            const pw = parseInt(div.getAttribute('data-page-width-em') || '0', 10);
                            const lb = div.getAttribute('data-line-broken') === '1';
                            const base = div.querySelector('.katex-display .base') || div.querySelector('.base');
                            const rendW = base ? base.getBoundingClientRect().width : 0;
                            _debugEntries.push({ pw, lb, rendW });
                        });
                        // Mode B: measure .katex-display widths from raw-latex rendered divs
                        const _katexDisplays = element.querySelectorAll('.katex-display');
                        const _katexWidths = [];
                        _katexDisplays.forEach(kd => {
                            const base = kd.querySelector('.base');
                            const w = base ? base.getBoundingClientRect().width : (kd.getBoundingClientRect().width || 0);
                            _katexWidths.push(Math.round(w));
                        });
                        try {
                            context.postMessage({
                                type: 'render-width-debug',
                                containerW: containerW,
                                headerW: _headerW,
                                preRenderWidth: _preRenderWidth,
                                cellInputW: _inputEl ? (_inputEl.offsetWidth || _inputEl.scrollWidth || 0) : -1,
                                windowInnerWidth: window.innerWidth || 0,
                                divs: _debugEntries,
                                katexWidths: _katexWidths,
                            });
                        } catch (_) {}

                        // Report the measured container width to the extension host.
                        // This uses the header bar width (accurate) instead of preRenderWidth.
                        if (containerW > 0) {
                            try { context.postMessage({ type: 'container-width', widthPx: containerW }); } catch (_) {}
                        }

                        // Calibration: only update _pxPerCppEm from reliable measurements.
                        // Check both Mode A (prerendered) and Mode B (raw-latex) divs.
                        const _allKatexContainers = [..._debugDivs];
                        if (containerW > 0 && _allKatexContainers.length > 0) {
                            _allKatexContainers.forEach(div => {
                                const pw = parseInt(div.getAttribute('data-page-width-em') || '0', 10);
                                const lineBroken = div.getAttribute('data-line-broken') === '1';
                                const katexEl = div.querySelector('.katex-display .base') || div.querySelector('.base') || div.querySelector('.katex');
                                const renderedW = katexEl ? katexEl.getBoundingClientRect().width : 0;
                                if (pw > 0 && renderedW > 0) {
                                    const overflow = renderedW > containerW * 0.95;
                                    if (lineBroken || overflow) {
                                        try {
                                            context.postMessage({
                                                type: 'katex-width-feedback',
                                                renderedPx: renderedW,
                                                pageWidthEm: pw,
                                                containerPx: containerW,
                                                overflow: overflow,
                                                lineBroken: lineBroken,
                                            });
                                        } catch (_) {}
                                    }
                                }
                            });
                        }
                    }
                });
            });

            // ---- Fix: VS Code output-height truncation after loading from file ----
            // VS Code measures the output cell height immediately after renderOutputItem
            // returns. When outputs are loaded from a saved notebook, MathML web-fonts may
            // not be cached yet. Unmeasured fonts cause the browser to use fallback metrics
            // (wrong, smaller size) → VS Code caches a too-small height → the output
            // appears truncated to 2-3 lines until the user collapses/uncollapses the cell.
            //
            // Fix: after all document fonts have loaded (fonts.ready), append and immediately
            // remove a zero-height sentinel element. This DOM mutation re-triggers VS Code's
            // internal ResizeObserver with the now-correct, font-loaded scrollHeight, causing
            // VS Code to update the displayed cell height without any visible flicker.
            {
                const _ownerDoc = element.ownerDocument || document;
                const _triggerHeightFix = () => {
                    try {
                        const sentinel = _ownerDoc.createElement('div');
                        sentinel.style.cssText = 'height:0;width:0;overflow:hidden;position:absolute;pointer-events:none;';
                        element.appendChild(sentinel);
                        requestAnimationFrame(() => { try { sentinel.remove(); } catch(_) {} });
                    } catch(_) {}
                };
                if (_ownerDoc.fonts && typeof _ownerDoc.fonts.ready === 'object') {
                    _ownerDoc.fonts.ready.then(_triggerHeightFix);
                } else {
                    setTimeout(_triggerHeightFix, 300);
                }
            }
            // DEBUG: global click spy on the whole element
            element.addEventListener('click', (e) => {
                console.log('[WolframRenderer] CLICK on element — target:', e.target.tagName,
                            'data-action:', e.target.getAttribute?.('data-action'),
                            'text:', e.target.textContent?.substring(0, 40));
            }, { once: false });

            // ---- Expand / Open-as-text buttons ----
            const expandContainers = element.querySelectorAll('[data-truncated-uuid]');
            console.log('[WolframRenderer] Found', expandContainers.length, 'truncated output containers');
            
            expandContainers.forEach(container => {
                const uuid = container.getAttribute('data-truncated-uuid');
                const expandButton = container.querySelector('button[data-action="expand"]');
                const openTextButton = container.querySelector('button[data-action="open-text"]');
                
                console.log('[WolframRenderer] Container uuid:', uuid,
                            '| expandBtn:', !!expandButton,
                            '| openTextBtn:', !!openTextButton);
                
                if (!uuid) { console.warn('[WolframRenderer] Container has no uuid, skipping'); return; }

                if (expandButton) {
                    expandButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('[WolframRenderer] Expand button clicked — uuid:', uuid);
                        console.log('[WolframRenderer] postMessage available:', !!(context && context.postMessage));

                        const origHTML = expandButton.innerHTML;
                        expandButton.innerHTML = '&#9203; Expanding…';
                        expandButton.disabled = true;
                        expandButton.style.cssText += ';cursor:wait;opacity:0.7;';

                        if (context && context.postMessage) {
                            try {
                                context.postMessage({ type: 'expand-truncated-output', uuid });
                                console.log('[WolframRenderer] expand message sent OK');
                            } catch (err) {
                                console.error('[WolframRenderer] postMessage error:', err);
                                expandButton.innerHTML = origHTML;
                                expandButton.disabled = false;
                            }
                        } else {
                            console.error('[WolframRenderer] postMessage NOT available — cannot expand');
                            alert('[WolframRenderer] postMessage not available. Check requiresMessaging in package.json.');
                            expandButton.innerHTML = origHTML;
                            expandButton.disabled = false;
                        }
                    });
                }
                
                if (openTextButton) {
                    openTextButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('[WolframRenderer] Open-as-text button clicked — uuid:', uuid);
                        console.log('[WolframRenderer] postMessage available:', !!(context && context.postMessage));

                        const origHTML = openTextButton.innerHTML;
                        openTextButton.innerHTML = '&#9203; Opening…';
                        openTextButton.disabled = true;
                        openTextButton.style.cssText += ';cursor:wait;opacity:0.7;';

                        if (context && context.postMessage) {
                            try {
                                // Register for reply before sending — controller will
                                // send open-text-done or open-text-error when done.
                                openTextPending.set(uuid, { button: openTextButton, origHTML });
                                context.postMessage({ type: 'open-truncated-as-text', uuid });
                                console.log('[WolframRenderer] open-as-text message sent OK');
                            } catch (err) {
                                console.error('[WolframRenderer] postMessage error:', err);
                                openTextPending.delete(uuid);
                                openTextButton.innerHTML = origHTML;
                                openTextButton.disabled = false;
                            }
                        } else {
                            console.error('[WolframRenderer] postMessage NOT available');
                            openTextButton.innerHTML = origHTML;
                            openTextButton.disabled = false;
                        }
                    });
                }

                const expandMoreButton = container.querySelector('button[data-action="expand-more"]');
                if (expandMoreButton) {
                    expandMoreButton.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const origHTML = expandMoreButton.innerHTML;
                        expandMoreButton.innerHTML = '&#9203; Expanding…';
                        expandMoreButton.disabled = true;
                        expandMoreButton.style.cssText += ';cursor:wait;opacity:0.7;';
                        if (context && context.postMessage) {
                            try { context.postMessage({ type: 'expand-more-output', uuid }); }
                            catch (err) { expandMoreButton.innerHTML = origHTML; expandMoreButton.disabled = false; }
                        } else { expandMoreButton.innerHTML = origHTML; expandMoreButton.disabled = false; }
                    });
                }
            });
            
            // ---- InformationDataGrid symbol badges (doc-lookup) ----
            // Emitted by render-expr.wl for ?*pattern* wildcard searches.
            // Each badge has data-action="doc-lookup" data-symbol="Sin".
            // Clicking sends doc-lookup to the extension host which calls
            // wolfbook.expandHoverDoc → evalSel.docLookup → Watch panel.
            const docLookupBtns = element.querySelectorAll('button[data-action="doc-lookup"]');
            docLookupBtns.forEach(btn => {
                btn.addEventListener('mouseenter', () => {
                    btn.style.background = 'rgba(128,128,128,0.18)';
                });
                btn.addEventListener('mouseleave', () => {
                    btn.style.background = 'transparent';
                });
                btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const symbol = btn.getAttribute('data-symbol');
                    if (!symbol) return;
                    if (context && context.postMessage) {
                        try { context.postMessage({ type: 'doc-lookup', symbol }); }
                        catch (err) { console.error('[WolframRenderer] doc-lookup postMessage error:', err); }
                    }
                });
            });

            // ---- Matrix pager: prev/next page navigation (server-side page requests) ----
            const matrixPagers = element.querySelectorAll('.wl-matrix-pager[data-page-count]');
            matrixPagers.forEach(pager => {
                const N = parseInt(pager.getAttribute('data-page-count') || '1', 10);
                if (N <= 1) return;
                const pagerId = pager.getAttribute('data-pager-id') || '';
                // There may be two nav bars (top + bottom) — operate on all matching elements.
                const allLabels  = pager.querySelectorAll('.wl-matrix-page-label');
                const allFirsts  = pager.querySelectorAll('button[data-action="go-first"]');
                const allPrevs   = pager.querySelectorAll('button[data-action="prev-page"]');
                const allNexts   = pager.querySelectorAll('button[data-action="next-page"]');
                const allLasts   = pager.querySelectorAll('button[data-action="go-last"]');
                const setAllLabels = (txt)  => allLabels.forEach(el => el.textContent = txt);
                const setAllPrev   = (dis)  => { allFirsts.forEach(el => el.disabled = dis); allPrevs.forEach(el => el.disabled = dis); };
                const setAllNext   = (dis)  => { allNexts.forEach(el => el.disabled = dis); allLasts.forEach(el => el.disabled = dis); };

                const goTo = (i) => {
                    const cur = parseInt(pager.getAttribute('data-current-page') || '0', 10);
                    if (i < 0 || i >= N || i === cur) return;
                    if (!pagerId || !context || !context.postMessage) return;
                    // Disable all buttons while waiting for page content from extension host
                    setAllPrev(true); setAllNext(true);
                    setAllLabels(`\u23f3 ${i + 1}\u202f/\u202f${N}`);
                    try { context.postMessage({ type: 'output-page-request', pagerId, page: i }); }
                    catch (_) {
                        // Revert on send failure
                        setAllLabels(`${cur + 1}\u202f/\u202f${N}`);
                        setAllPrev(cur === 0); setAllNext(cur === N - 1);
                    }
                };

                // Start on page 0: prev/first always disabled, register click handlers on all bars
                setAllPrev(true);
                allFirsts.forEach(btn => btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    goTo(0);
                }));
                allPrevs.forEach(btn => btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    goTo(parseInt(pager.getAttribute('data-current-page') || '0', 10) - 1);
                }));
                allNexts.forEach(btn => btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    goTo(parseInt(pager.getAttribute('data-current-page') || '0', 10) + 1);
                }));
                allLasts.forEach(btn => btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    goTo(N - 1);
                }));
            });

            // ---- Format + zoom buttons for each output header ----
            // Each .wl-output-header[data-out-n] gets a button group:
            //   TXT | SVG | ∑  (format selectors)
            //   ⊕ ⊖ (MathML zoom, only when MathML)
            //   ↓ Wrap / ↔ Scroll toggle (MathML only)
            const BTN_BASE = 'padding:0 3px;font-size:10px;cursor:pointer;line-height:1.3;' +
                             'background:transparent;border:1px solid rgba(128,128,128,0.2);' +
                             'border-radius:2px;flex-shrink:0;color:var(--vscode-foreground,inherit);opacity:0.55;';
            const BTN_ACTIVE = 'border-color:rgba(128,128,128,0.6);opacity:0.9;';

            const outputHeaders = element.querySelectorAll('.wl-output-header[data-out-n]');
            console.log('[WolframRenderer] Found', outputHeaders.length, 'output headers for format buttons');

            outputHeaders.forEach(header => {
                const outputId   = header.getAttribute('data-output-id')   || '';
                const outFmt     = header.getAttribute('data-output-format') || 'MathML';
                const block      = header.closest('.wl-output-block');
                const mathmlDiv  = block && block.querySelector('div.mathml-output');

                const group = document.createElement('div');
                group.style.cssText = 'display:inline-flex;gap:3px;align-items:center;margin-left:auto;flex-shrink:0;';

                // -- Format buttons --
                // Graphics outputs (SVG/PNG image): WL | SVG | TikZ
                // Symbolic outputs: WL | SVG | SVG.T | LaTeX | src | 📄
                const isGraphics = header.getAttribute('data-output-is-graphics') === '1';
                const formats = isGraphics
                    ? [['WL', 'InputForm'], ['SVG', 'SVG'], ['TikZ', 'SVGSrc']]
                    : [['WL', 'InputForm'], ['SVG', 'SVG'], ['SVG.T', 'SVGT'], ['LaTeX', 'WLLatex'],
                       ...((outFmt === 'WLLatex' || outFmt === 'WLLatexSrc') ? [['src', 'WLLatexSrc']] : []),
                       ['\u{1F4C4}', 'TXT']];
                formats.forEach(([label, fmtKey]) => {
                    const b = document.createElement('button');
                    b.textContent = label;
                    b.title = fmtKey === 'TXT'
                            ? 'Open full expression as text file'
                            : (fmtKey === 'InputForm'  ? 'Wolfram Language text (InputForm)'
                            : fmtKey === 'SVG'          ? 'Rasterized image (SVG/PNG)'
                            : fmtKey === 'SVGT'         ? 'Rasterized image — TraditionalForm typesetting'
                            : fmtKey === 'SVGSrc'       ? 'TikZ (via svg2tikz)'
                            : fmtKey === 'WLLatex2'     ? 'TraditionalForm \u2192 KaTeX (webview rendering)'
                            : fmtKey === 'WLLatexSrc'   ? 'TraditionalForm \u2192 LaTeX source (btl addon)'
                                                        : 'Symbolic math (MathML)')
                            + '\n· double-click to set as default for this notebook';
                    b.style.cssText = BTN_BASE + (outFmt === fmtKey ? BTN_ACTIVE : '');
                    b.setAttribute('data-fmt-key', fmtKey);
                    b.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (!outputId) return;
                        // TXT: open full expression as text file via controller.
                        if (fmtKey === 'TXT') {
                            if (context && context.postMessage) {
                                try { context.postMessage({ type: 'open-output-as-text', outputId }); } catch (_) {}
                            }
                            return;
                        }
                        // WLLatexSrc: show current page's LaTeX source client-side — no kernel call.
                        if (fmtKey === 'WLLatexSrc') {
                            const block2 = header.closest('.wl-output-block');
                            if (block2) {
                                const srcEl = block2.querySelector('.wl-matrix-pager[data-latex-b64], .vscode-wolfram-wllatex-prerendered[data-latex-b64]');
                                let latex = '';
                                try {
                                    const _b64 = srcEl ? (srcEl.getAttribute('data-latex-b64') || '') : '';
                                    if (_b64) {
                                        const _bytes = Uint8Array.from(atob(_b64), c => c.charCodeAt(0));
                                        latex = new TextDecoder('utf-8').decode(_bytes);
                                    }
                                } catch(_) {}
                                if (latex) {
                                    const content = block2.querySelector('.wl-output-content');
                                    if (content) {
                                        const pre = document.createElement('pre');
                                        pre.className = 'vscode-wolfram-tex-source';
                                        pre.textContent = latex;
                                        // Move (not clone) DOM children into a detached div so that
                                        // pager event listeners (prev/next page etc.) are preserved.
                                        const _detached = document.createElement('div');
                                        while (content.firstChild) _detached.appendChild(content.firstChild);
                                        savedWLLatexContent.set(outputId, _detached);
                                        content.appendChild(pre);
                                        wrapWithCopy(pre, () => pre.textContent);
                                        pre.setAttribute('data-hljs-lang', 'latex');
                                        applyInlineHighlight(pre, 'latex');
                                        header.setAttribute('data-output-format', 'WLLatexSrc');
                                        group.querySelectorAll('button[data-fmt-key]').forEach(b2 => {
                                            b2.style.cssText = BTN_BASE + (b2.getAttribute('data-fmt-key') === 'WLLatexSrc' ? BTN_ACTIVE : '');
                                        });
                                    }
                                    return;
                                }
                            }
                            // No LaTeX data available (current format is not WLLatex).
                            // Switch to WLLatex first — this populates data-latex-b64 so
                            // clicking "src" again will work.
                            if (savedWLLatexContent.has(outputId)) savedWLLatexContent.delete(outputId);
                            const scrollY0 = window.scrollY || document.documentElement.scrollTop || 0;
                            if (context && context.postMessage) {
                                try { context.postMessage({ type: 'reformat-output', outputId, newFormat: 'WLLatex', scrollY: scrollY0 }); } catch (_) {}
                            }
                            return;
                        }
                        // WLLatex — restore saved content client-side if coming back from WLLatexSrc
                        // (avoids kernel round-trip and preserves current page + pager listeners).
                        if (fmtKey === 'WLLatex' && savedWLLatexContent.has(outputId)) {
                            const _block3 = header.closest('.wl-output-block');
                            const _content3 = _block3?.querySelector('.wl-output-content');
                            if (_content3) {
                                const _saved = savedWLLatexContent.get(outputId);
                                savedWLLatexContent.delete(outputId);
                                while (_content3.firstChild) _content3.removeChild(_content3.firstChild);
                                while (_saved.firstChild) _content3.appendChild(_saved.firstChild);
                                header.setAttribute('data-output-format', 'WLLatex');
                                group.querySelectorAll('button[data-fmt-key]').forEach(b2 => {
                                    b2.style.cssText = BTN_BASE + (b2.getAttribute('data-fmt-key') === 'WLLatex' ? BTN_ACTIVE : '');
                                });
                                return;
                            }
                        }
                        // Any other format while WLLatexSrc is showing — discard stale saved state.
                        if (savedWLLatexContent.has(outputId)) savedWLLatexContent.delete(outputId);
                        const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
                        if (context && context.postMessage) {
                            try { context.postMessage({ type: 'reformat-output', outputId, newFormat: fmtKey, scrollY }); }
                            catch (err) { console.error('[WolframRenderer] postMessage error:', err); }
                        }
                    });
                    b.addEventListener('dblclick', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (fmtKey === 'TXT') return; // txt is an action button, not a format
                        // Update the appropriate default variable based on output type
                        if (isGraphics) wolframNbDefaultGfxFormat  = fmtKey;
                        else            wolframNbDefaultExprFormat = fmtKey;
                        // Flash all buttons of the same type that match the new default
                        document.querySelectorAll('button[data-fmt-key]').forEach(btn => {
                            const hdr = btn.closest('.wl-output-block')?.querySelector('.wl-output-header');
                            const btnIsGfx = hdr ? hdr.getAttribute('data-output-is-graphics') === '1' : isGraphics;
                            if (btnIsGfx !== isGraphics) return;
                            btn.classList.remove('wl-nb-default-fmt');
                            if (btn.getAttribute('data-fmt-key') === fmtKey) {
                                void btn.offsetWidth; // restart animation
                                btn.classList.add('wl-nb-default-fmt');
                                setTimeout(() => btn.classList.remove('wl-nb-default-fmt'), 1600);
                            }
                        });
                        if (context && context.postMessage) {
                            try { context.postMessage({ type: 'set-notebook-default-format', newFormat: fmtKey, isGfx: isGraphics }); }
                            catch (_) {}
                        }
                    });
                    group.appendChild(b);
                });

                // -- Size controls sub-group (MathML zoom -or- TXT A±), separated visually --
                const sizeControls = [];
                if (outFmt === 'MathML') {
                    const applyZoom = () => {
                        document.querySelectorAll('div.mathml-output').forEach(d => {
                            d.style.fontSize = wolframMathmlZoom + 'em';
                        });
                    };
                    const zoomOut = document.createElement('button');
                    zoomOut.textContent = '\u2296'; zoomOut.title = 'Zoom out (MathML)';
                    zoomOut.style.cssText = BTN_BASE;
                    zoomOut.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation();
                        wolframMathmlZoom = Math.max(0.4, Math.round((wolframMathmlZoom - 0.15) * 100) / 100);
                        applyZoom(); });
                    const zoomIn = document.createElement('button');
                    zoomIn.textContent = '\u2295'; zoomIn.title = 'Zoom in (MathML)';
                    zoomIn.style.cssText = BTN_BASE;
                    zoomIn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation();
                        wolframMathmlZoom = Math.min(2.5, Math.round((wolframMathmlZoom + 0.15) * 100) / 100);
                        applyZoom(); });
                    sizeControls.push(zoomOut, zoomIn);
                } else if (outFmt === 'InputForm') {
                    const applyTxtSize = () => {
                        document.querySelectorAll('pre.vscode-wolfram-text-output').forEach(p => {
                            p.style.fontSize = wolframTxtFontSize + 'em';
                        });
                    };
                    const txtOut = document.createElement('button');
                    txtOut.textContent = 'A\u207b'; txtOut.title = 'Decrease TXT font size';
                    txtOut.style.cssText = BTN_BASE;
                    txtOut.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation();
                        wolframTxtFontSize = Math.max(0.5, Math.round((wolframTxtFontSize - 0.1) * 10) / 10);
                        applyTxtSize(); });
                    const txtIn = document.createElement('button');
                    txtIn.textContent = 'A\u207a'; txtIn.title = 'Increase TXT font size';
                    txtIn.style.cssText = BTN_BASE;
                    txtIn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation();
                        wolframTxtFontSize = Math.min(2.0, Math.round((wolframTxtFontSize + 0.1) * 10) / 10);
                        applyTxtSize(); });
                    sizeControls.push(txtOut, txtIn);
                }
                if (sizeControls.length > 0) {
                    const sizeGroup = document.createElement('div');
                    sizeGroup.style.cssText = 'display:inline-flex;gap:2px;align-items:center;' +
                        'margin-left:4px;padding-left:5px;border-left:1px solid rgba(128,128,128,0.3);';
                    sizeControls.forEach(b => sizeGroup.appendChild(b));
                    group.appendChild(sizeGroup);
                }

                // -- Wrap toggle (MathML only) --
                if (outFmt === 'MathML' && mathmlDiv) {
                        let isWrapped = false;
                        const wrapBtn = document.createElement('button');
                        wrapBtn.innerHTML = '&#8659; Wrap';
                        wrapBtn.title = 'Toggle line-wrap / scroll for this expression';
                        wrapBtn.style.cssText = BTN_BASE;
                        wrapBtn.addEventListener('click', (e) => {
                            e.preventDefault(); e.stopPropagation();
                            isWrapped = !isWrapped;
                            if (isWrapped) {
                                mathmlDiv.style.overflowX = 'hidden';
                                mathmlDiv.style.overflowWrap = 'break-word';
                                mathmlDiv.style.wordBreak = 'break-all';
                                mathmlDiv.style.whiteSpace = 'normal';
                                mathmlDiv.style.display = 'block';
                                mathmlDiv.style.width = '100%';
                                mathmlDiv.querySelectorAll('math,mrow,mo,mi,mn,mfrac,msup,msub').forEach(el => {
                                    el.style.maxWidth = '100%';
                                    el.style.overflowWrap = 'break-word';
                                    el.style.wordBreak = 'break-all';
                                    el.style.display = 'inline-block';
                                });
                                wrapBtn.innerHTML = '&#8596; Scroll';
                            } else {
                                mathmlDiv.style.overflowX = 'auto';
                                mathmlDiv.style.overflowWrap = '';
                                mathmlDiv.style.wordBreak = '';
                                mathmlDiv.style.whiteSpace = '';
                                mathmlDiv.style.display = '';
                                mathmlDiv.style.width = '';
                                mathmlDiv.querySelectorAll('math,mrow,mo,mi,mn,mfrac,msup,msub').forEach(el => {
                                    el.style.maxWidth = '';
                                    el.style.overflowWrap = '';
                                    el.style.wordBreak = '';
                                    el.style.display = '';
                                });
                                wrapBtn.innerHTML = '&#8659; Wrap';
                            }
                            if (context && context.postMessage) {
                                try { context.postMessage({ type: 'scroll-to-output', outputId: currentOutputId }); }
                                catch (err) { console.warn('[WolframRenderer] scroll-to-output postMessage failed:', err); }
                            }
                        });
                        group.appendChild(wrapBtn);
                }

                header.appendChild(group);
            });

            // ---- TeXSrc: read attribute directly (browser unescapes HTML entities like &#10; → newline) ----
            element.querySelectorAll('pre.vscode-wolfram-tex-source[data-tex-src]').forEach(pre => {
                pre.textContent = pre.getAttribute('data-tex-src') || '';
                pre.removeAttribute('data-tex-src');
            });

            // ---- Copy-to-clipboard overlay buttons for TXT, TeXSrc, SVG/PNG ----
            const COPY_BTN_CSS = 'position:absolute;top:4px;right:4px;padding:1px 5px;font-size:11px;' +
                'cursor:pointer;background:rgba(80,80,80,0.82);border:1px solid rgba(160,160,160,0.55);' +
                'color:#cccccc;border-radius:3px;opacity:0;transition:opacity 0.15s;z-index:2;line-height:1.4;';
            const WRAP_CSS = 'position:relative;display:block;';
            const makeCopyBtn = (getText) => {
                const btn = document.createElement('button');
                btn.textContent = '\u29c9'; // ⧉ copy symbol
                btn.title = 'Copy to clipboard';
                btn.style.cssText = COPY_BTN_CSS;
                btn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const text = getText();
                    if (text != null && navigator.clipboard) {
                        navigator.clipboard.writeText(text).then(() => {
                            const prev = btn.textContent;
                            btn.textContent = '\u2713'; // ✓
                            setTimeout(() => { btn.textContent = prev; }, 1300);
                        }).catch(() => {});
                    }
                });
                return btn;
            };
            const wrapWithCopy = (el, getText) => {
                const wrapper = document.createElement('div');
                wrapper.style.cssText = WRAP_CSS;
                wrapper.addEventListener('mouseenter', () => { wrapper.querySelector('button').style.opacity = '0.65'; });
                wrapper.addEventListener('mouseleave', () => { wrapper.querySelector('button').style.opacity = '0'; });
                el.parentNode.insertBefore(wrapper, el);
                wrapper.appendChild(el);
                wrapper.appendChild(makeCopyBtn(getText));
            };

            // TXT — InputForm source; mark for hljs (Mathematica)
            element.querySelectorAll('pre.vscode-wolfram-text-output').forEach(pre => {
                // Decode WL \:XXXX unicode escape sequences (InputForm uses these for non-ASCII)
                pre.textContent = pre.textContent.replace(/\\:([0-9A-Fa-f]{4})/g,
                    (_, h) => String.fromCharCode(parseInt(h, 16)));
                wrapWithCopy(pre, () => pre.textContent);
                pre.setAttribute('data-hljs-lang', 'mathematica');
            });
            // TeXSrc — LaTeX source; mark for hljs (latex)
            element.querySelectorAll('pre.vscode-wolfram-tex-source').forEach(pre => {
                wrapWithCopy(pre, () => pre.textContent);
                pre.setAttribute('data-hljs-lang', 'latex');
            });
            // SVG/PNG images — copy actual image data to clipboard
            element.querySelectorAll('img.vscode-wolfram-svg-output, img.vscode-wolfram-png-output').forEach(img => {
                const src = img.getAttribute('src') || '';
                if (!src || src.startsWith('data:')) return;
                const isPng = img.classList.contains('vscode-wolfram-png-output');
                const btn = document.createElement('button');
                btn.textContent = '\u29c9'; btn.title = 'Copy image to clipboard';
                btn.style.cssText = COPY_BTN_CSS;
                btn.addEventListener('click', async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    try {
                        if (isPng) {
                            const blob = await (await fetch(src)).blob();
                            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                        } else {
                            const text = await (await fetch(src)).text();
                            await navigator.clipboard.writeText(text);
                        }
                        const prev = btn.textContent; btn.textContent = '\u2713';
                        setTimeout(() => { btn.textContent = prev; }, 1300);
                    } catch (err) {
                        // fallback: copy path
                        try { await navigator.clipboard.writeText(img.getAttribute('data-wl-img') || src); } catch(e2) {}
                        const prev = btn.textContent; btn.textContent = '\u2713';
                        setTimeout(() => { btn.textContent = prev; }, 1300);
                    }
                });
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'position:relative;display:inline-block;';
                wrapper.addEventListener('mouseenter', () => { btn.style.opacity = '0.65'; });
                wrapper.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
                img.parentNode.insertBefore(wrapper, img);
                wrapper.appendChild(img); wrapper.appendChild(btn);
            });
            // Inline SVG divs — copy SVG source
            element.querySelectorAll('div.vscode-wolfram-svg-output').forEach(div => {
                const svgEl = div.querySelector('svg');
                if (svgEl) wrapWithCopy(div, () => svgEl.outerHTML);
            });

            // ---- KaTeX rendering for TeX output divs ----
            const texDivs = element.querySelectorAll('div.vscode-wolfram-tex-output[data-tex-src]');
            if (texDivs.length > 0) {
                const renderWithKatex = (katex) => {
                    texDivs.forEach(div => {
                        const raw = div.getAttribute('data-tex-src') || '';
                        try {
                            div.innerHTML = katex.renderToString(raw, KATEX_RENDER_OPTIONS);
                        } catch(e) {
                            div.textContent = raw;
                        }
                    });
                };
                if (typeof window !== 'undefined' && window.katex) {
                    renderWithKatex(window.katex);
                } else {
                    const KATEX_VER = '0.16.9';
                    const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VER}/dist/`;
                    const injectKatexCSS = () => {
                        if (document.querySelector('link[data-katex-css]')) return;
                        const link = document.createElement('link');
                        link.rel = 'stylesheet'; link.href = KATEX_BASE + 'katex.min.css';
                        link.setAttribute('data-katex-css', '1');
                        document.head.appendChild(link);
                    };
                    const loadKatexJS = (cb) => {
                        if (document.querySelector('script[data-katex-js]')) {
                            let tries = 0;
                            const poll = setInterval(() => {
                                if (window.katex || ++tries > 50) {
                                    clearInterval(poll);
                                    if (window.katex) cb(window.katex);
                                    else texDivs.forEach(d => {
                                        d.textContent = d.getAttribute('data-tex-src') || '';
                                    });
                                }
                            }, 100);
                            return;
                        }
                        const script = document.createElement('script');
                        script.src = KATEX_BASE + 'katex.min.js'; script.setAttribute('data-katex-js', '1');
                        script.onload = () => cb(window.katex);
                        script.onerror = () => texDivs.forEach(d => {
                            d.textContent = d.getAttribute('data-tex-src') || '';
                        });
                        document.head.appendChild(script);
                    };
                    injectKatexCSS();
                    loadKatexJS(renderWithKatex);
                }
            }

            // ---- KaTeX CSS for WLLatex pre-rendered outputs ----
            if (element.querySelector('.vscode-wolfram-wllatex-prerendered')) {
                if (!document.querySelector('link[data-katex-css]')) {
                    const _klnk = document.createElement('link');
                    _klnk.rel = 'stylesheet';
                    _klnk.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
                    _klnk.setAttribute('data-katex-css', '1');
                    document.head.appendChild(_klnk);
                }
            }

            // ---- Inline syntax highlighting (no CDN) ----
            element.querySelectorAll('[data-hljs-lang]').forEach(el => {
                const lang = el.getAttribute('data-hljs-lang');
                el.removeAttribute('data-hljs-lang');
                if (lang) applyInlineHighlight(el, lang);
                // Add line-number gutter for code pre blocks
                if (el.tagName === 'PRE') addLineNumberGutter(el);
            });

            // ---- Multi-stage height sentinel ----
            // VS Code measures output height right after renderOutputItem returns
            // (synchronously). Async content (fonts, KaTeX CDN, format buttons
            // growing the header) can change the height afterwards.  Firing the
            // sentinel at 0 ms, 250 ms and 800 ms ensures VS Code re-measures at
            // each stage and the displayed cell height stays correct when scrolling.
            // The fonts.ready sentinel above already handles the web-font case;
            // these timeouts add belt-and-suspenders coverage for all other paths.
            {
                const _triggerNow = () => {
                    try {
                        const _d = element.ownerDocument || document;
                        const s = _d.createElement('div');
                        s.style.cssText = 'height:0;width:0;overflow:hidden;position:absolute;pointer-events:none;';
                        element.appendChild(s);
                        requestAnimationFrame(() => { try { s.remove(); } catch(_){} });
                    } catch(_) {}
                };
                [0, 250, 800].forEach(delay => setTimeout(_triggerNow, delay));
            }

            // (scroll-to-top button removed — not achievable from inside per-cell iframe)
        },
        
        disposeOutputItem(outputId) {
            // SCROLL-TIMING: notify extension that output is being destroyed
            if (context && context.postMessage) {
                try { context.postMessage({ type: 'render-timing', phase: 'dispose', id: typeof outputId === 'string' ? outputId : 'all', t: Date.now() }); } catch(_){}
            }
            if (typeof outputId === 'string') {
                const disposable = disposables[outputId];
                disposable?.disconnect();
                delete disposables[outputId];
            } else {
                Object.values(disposables).forEach(d => d?.disconnect());
            }
        }
    };
}

