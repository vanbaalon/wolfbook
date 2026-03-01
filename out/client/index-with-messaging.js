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

// ---- Developer mode flag ----
// Gate all diagnostic console.log / console.warn behind this flag so end-user
// installs produce no renderer noise.  Set to true manually on the dev machine.
// (Webviews run in a sandboxed browser context with no Node.js access, so
// auto-detection via os.userInfo() is not available here.)
const DEV_MODE = false;
if (!DEV_MODE) { const _noop = () => {}; console.log = _noop; console.warn = _noop; }

// Module-level marker — confirms this file (index-with-messaging.js) was loaded
console.log('[WolframRenderer] *** index-with-messaging.js MODULE LOADED ***');

// CSS for WL custom elements (wrow, w, wsub, wsup, wfrac…) + MathML helpers
const WL_CSS = `
:root { --fraction-line-width: max(0.08em,1px); --script-font-size: max(71%,8pt); --line-height: 1.1; }
w,wb,wrow,wsub,wsup,wsubsup,wover,wunder,wunderover,wfrac,wsqrt,wgraph,wgrid,wframe,wpane,wunknown,wfailed {
  margin:0;padding:0;border:0;font-size:100%;font:inherit;vertical-align:baseline;
  display:inline-block;white-space:nowrap;line-height:var(--line-height); }
.wexpr { font-family: Consolas, Courier, monospace; line-height: var(--line-height); }
.wexpr.traditional-form { font-family: 'Times New Roman', Times, serif; }
.wexpr > wrow, .wexpr > w, wframe > wrow, wframe > w, wpane > wrow, wpane > w
  { display:inline;white-space:normal;word-break:normal;overflow-wrap:anywhere; }
wrow > wrow, wrow > w { white-space:inherit;word-break:inherit;overflow-wrap:inherit; }
w.italic { font-style:italic; }
wfrac { text-align:center;margin:0 0.2ch;padding:0 0.2ch; }
wfrac > :first-child { display:block; }
wfrac > :last-child { display:grid; }
wfrac > :last-child > :first-child { border-top:solid var(--fraction-line-width);
  height:calc(1em * var(--line-height));margin-top:calc(-0.45em * var(--line-height));
  margin-bottom:calc(-0.4em * var(--line-height));transform:translateY(calc(0.6em * var(--line-height))); }
wfrac > :last-child > :last-child { display:block;z-index:1; }
wsup > :last-child { font-size:var(--script-font-size);vertical-align:1.3ex; }
wsub > :last-child { font-size:var(--script-font-size);vertical-align:-0.7ex; }
pre { font-family: Consolas, Courier, monospace; }
pre > .wl-message { color: var(--vscode-editorError-foreground); }
pre.vscode-wolfram-print-output { font-size:0.85em; margin:0; padding:0; line-height:1.3; }
pre.vscode-wolfram-text-output, pre.vscode-wolfram-tex-source {
  font-family: var(--vscode-editor-font-family, var(--vscode-font-family, Consolas, monospace));
  font-size: var(--vscode-editor-font-size, 13px);
  background: #1e1e1e;
  color: #d4d4d4;
  border: 1px solid rgba(80,80,80,0.5);
  border-radius: 3px; padding: 6px 10px 6px 3.2em;
  white-space: pre-wrap; overflow-wrap: break-word; line-height: 1.5; margin: 2px 0; }
.wl-line-gutter { position:absolute;left:0;top:0;bottom:0;width:2.5em;padding:6px 3px 6px 0;
  text-align:right;color:rgba(180,180,180,0.5);font-size:0.82em;line-height:1.5;
  user-select:none;pointer-events:none;overflow:hidden;background:#1e1e1e;
  font-family:var(--vscode-editor-font-family,Consolas,monospace); }
@keyframes wl-fmt-flash {
  0%   { outline:2px solid rgba(218,165,32,0.85);outline-offset:1px; }
  70%  { outline:2px solid rgba(218,165,32,0.5);outline-offset:1px; }
  100% { outline:2px solid rgba(218,165,32,0);outline-offset:1px; }
}
button.wl-nb-default-fmt { animation:wl-fmt-flash 1.5s ease-out forwards; }
img.vscode-wolfram-svg-output, img.vscode-wolfram-png-output { background: transparent; }
.vscode-wolfram-svg-output > svg > rect:first-child { fill: none !important; }
div.mathml-output { overflow-x:auto; }
div.vscode-wolfram-tex-output { overflow-x:auto; padding: 4px 0; }
/* Inline syntax highlight tokens */
.wl-hl-str  { color: #ce9178; }
.wl-hl-cmt  { color: #6a9955; font-style: italic; }
.wl-hl-num  { color: #b5cea8; }
.wl-hl-sym  { color: #4ec9b0; }
.wl-hl-cmd  { color: #569cd6; }
.wl-hl-math { color: #c586c0; }
.wl-hl-brk  { color: #ffd700; }
`;

// ---- Inline syntax highlighter — no CDN required ----
function applyInlineHighlight(pre, lang) {
    const raw = pre.textContent;
    if (!raw) return;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Returns sorted, non-overlapping token list from blockRules
    function collectTokens(text, blockRules) {
        const toks = [];
        for (const {re, cls} of blockRules) {
            const r = new RegExp(re.source, (re.flags.replace('g','') + 'g'));
            let m;
            while ((m = r.exec(text)) !== null)
                toks.push({ start: m.index, end: m.index + m[0].length, cls });
        }
        toks.sort((a, b) => a.start - b.start);
        const clean = []; let last = 0;
        for (const t of toks) { if (t.start >= last) { clean.push(t); last = t.end; } }
        return clean;
    }

    function buildHtml(text, blockRules, leafRules) {
        const toks = collectTokens(text, blockRules);
        let html = '', pos = 0;
        for (const t of toks) {
            if (t.start > pos) {
                let plain = esc(text.slice(pos, t.start));
                for (const {re, cls} of leafRules)
                    plain = plain.replace(re, `<span class="wl-hl-${cls}">$1</span>`);
                html += plain;
            }
            html += `<span class="wl-hl-${t.cls}">${esc(text.slice(t.start, t.end))}</span>`;
            pos = t.end;
        }
        if (pos < text.length) {
            let plain = esc(text.slice(pos));
            for (const {re, cls} of leafRules)
                plain = plain.replace(re, `<span class="wl-hl-${cls}">$1</span>`);
            html += plain;
        }
        return html;
    }

    let html;
    if (lang === 'mathematica') {
        html = buildHtml(raw,
            [ { re: /"(?:[^"\\]|\\.)*"/g, cls: 'str' },
              { re: /\(\*[\s\S]*?\*\)/g,    cls: 'cmt' } ],
            [ { re: /\b(\d[\d.]*(?:`\d+)?(?:\*\^[+-]?\d+)?)\b/g, cls: 'num' },
              { re: /\b([A-Z][a-zA-Z0-9$`]*)\b/g,                 cls: 'sym' } ]);
    } else if (lang === 'latex') {
        html = buildHtml(raw,
            [ { re: /%[^\n]*/g,               cls: 'cmt' },
              { re: /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, cls: 'math' } ],
            [ { re: /(\\[a-zA-Z]+\*?)/g, cls: 'cmd' },
              { re: /(\{|\})/g,           cls: 'brk' },
              { re: /\b(\d[\d.]*)\b/g,    cls: 'num' } ]);
    } else { return; }
    pre.innerHTML = html;
}

function injectRendererCSS(doc) {
    if (doc.querySelector('style[data-wolfram-renderer]')) return;
    const s = doc.createElement('style');
    s.setAttribute('data-wolfram-renderer', '1');
    s.textContent = WL_CSS;
    (doc.head || doc.body || doc.documentElement).appendChild(s);
    console.log('[WolframRenderer] CSS injected into document');
}

// Add a line-number gutter to a pre element that has been wrapped by wrapWithCopy
// (which gives it a position:relative parent div).
function addLineNumberGutter(pre) {
    const lines = pre.textContent.split('\n');
    if (lines.length < 2) return;
    const gutter = document.createElement('div');
    gutter.className = 'wl-line-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= lines.length; i++) {
        const ln = document.createElement('div'); ln.textContent = String(i);
        gutter.appendChild(ln);
    }
    if (pre.parentNode) pre.parentNode.appendChild(gutter);
}

export function activate(context) {
    console.log('[WolframRenderer] activate() called');
    console.log('[WolframRenderer] context:', context);
    console.log('[WolframRenderer] context.postMessage available:', !!(context && context.postMessage));
    const disposables = {};

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
            if (msg.type === 'nb-default-format') {
                // Controller restored the saved defaults for this notebook on reopen.
                // formatGfx and formatExpr are independent — either may be empty.
                if (msg.formatGfx)  wolframNbDefaultGfxFormat  = msg.formatGfx;
                if (msg.formatExpr) wolframNbDefaultExprFormat = msg.formatExpr;
                // No persistent highlight — default is remembered internally only.
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
        });
        // Announce to the extension that this renderer instance is ready to receive
        // kernel-offline / kernel-online messages. The extension will respond with
        // the current kernel status immediately, correcting the case where the
        // extension sent kernel-offline before this webview's listener was live.
        try { context.postMessage({ type: 'renderer-ready' }); } catch (_) {}
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

            // Decode WL octal escapes (\012 = \n, \015 = \r) that the kernel
            // inlines into MathML/HTML strings. The browser renders MathML fine
            // with actual newlines (whitespace is ignored) but shows \012 literally
            // as text when CSS overrides break the MathML renderer.
            const cleanHtml = rawHtml
                .replace(/\\015\\012/g, '\n')  // CRLF octal pair
                .replace(/\\015/g, '\n')
                .replace(/\\012/g, '\n');

            console.log('[WolframRenderer] HTML preview (first 300 chars):', cleanHtml.substring(0, 300));

            // Render HTML content
            element.innerHTML = cleanHtml;
            console.log('[WolframRenderer] innerHTML assigned — browser layout starting');

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
            
            // ---- Format + zoom buttons for each output header ----
            // Each .wl-output-header[data-out-n] gets a button group:
            //   TXT | SVG | ∑  (format selectors)
            //   ⊕ ⊖ (MathML zoom, only when MathML)
            //   ↓ Wrap / ↔ Scroll toggle (MathML only)
            const BTN_BASE = 'padding:1px 6px;font-size:12px;cursor:pointer;line-height:1.5;' +
                             'background:transparent;border:1px solid rgba(128,128,128,0.3);' +
                             'border-radius:3px;flex-shrink:0;color:var(--vscode-foreground,inherit);';
            const BTN_ACTIVE = 'border-color:rgba(128,128,128,0.7);';

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
                // Graphics outputs (SVG/PNG image): WL | SVG | src (raw SVG XML)
                // Symbolic outputs: WL | SVG | TeX | src (TeXSrc) | ∑ (MathML)
                const isGraphics = header.getAttribute('data-output-is-graphics') === '1';
                const formats = isGraphics
                    ? [['WL', 'InputForm'], ['SVG', 'SVG'], ['TikZ', 'SVGSrc']]
                    : [['WL', 'InputForm'], ['SVG', 'SVG'], ['TeX', 'TeX'], ['src', 'TeXSrc'], ['LaTeX', 'WLLatex'], ['LaTeX2', 'WLLatex2'], ['\u2211', 'MathML']];
                formats.forEach(([label, fmtKey]) => {
                    const b = document.createElement('button');
                    b.textContent = label;
                    b.title = (fmtKey === 'InputForm' ? 'Wolfram Language text (InputForm)'
                            : fmtKey === 'SVG'       ? 'Rasterized image (SVG/PNG)'
                            : fmtKey === 'TeX'       ? 'LaTeX rendered with KaTeX'
                            : fmtKey === 'TeXSrc'    ? 'LaTeX source (TeXForm)'
                            : fmtKey === 'SVGSrc'    ? 'TikZ (via svg2tikz)'
                            : fmtKey === 'WLLatex'   ? 'TraditionalForm \u2192 KaTeX (pre-rendered in extension host)'
                            : fmtKey === 'WLLatex2'  ? 'TraditionalForm \u2192 KaTeX (rendered in webview, faster for simple exprs)'
                                                     : 'Symbolic math (MathML)')
                            + '\n· double-click to set as default for this notebook';
                    b.style.cssText = BTN_BASE + (outFmt === fmtKey ? BTN_ACTIVE : '');
                    b.setAttribute('data-fmt-key', fmtKey);
                    b.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (!outputId) return;
                        const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
                        if (context && context.postMessage) {
                            try { context.postMessage({ type: 'reformat-output', outputId, newFormat: fmtKey, scrollY }); }
                            catch (err) { console.error('[WolframRenderer] postMessage error:', err); }
                        }
                    });
                    b.addEventListener('dblclick', (e) => {
                        e.preventDefault(); e.stopPropagation();
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

            // ---- TeXSrc: decode base64 → populate <pre> textContent ----
            element.querySelectorAll('pre.vscode-wolfram-tex-source[data-tex-b64]').forEach(pre => {
                try { pre.textContent = atob(pre.getAttribute('data-tex-b64') || ''); }
                catch(e) { pre.textContent = '(base64 decode error)'; }
                pre.removeAttribute('data-tex-b64');
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
            const texDivs = element.querySelectorAll('div.vscode-wolfram-tex-output[data-tex-b64]');
            if (texDivs.length > 0) {
                const renderWithKatex = (katex) => {
                    texDivs.forEach(div => {
                        let raw = '';
                        try { raw = atob(div.getAttribute('data-tex-b64') || ''); } catch(e) {}
                        try {
                            div.innerHTML = katex.renderToString(raw, {
                                displayMode: true, throwOnError: false,
                                output: 'html', trust: false
                            });
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
                                        try { d.textContent = atob(d.getAttribute('data-tex-b64') || ''); } catch(e) {}
                                    });
                                }
                            }, 100);
                            return;
                        }
                        const script = document.createElement('script');
                        script.src = KATEX_BASE + 'katex.min.js'; script.setAttribute('data-katex-js', '1');
                        script.onload = () => cb(window.katex);
                        script.onerror = () => texDivs.forEach(d => {
                            try { d.textContent = atob(d.getAttribute('data-tex-b64') || ''); } catch(e) {}
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

            // ---- WLLatex2: render raw-latex divs in the webview via KaTeX ----
            const rawLatexDivs = element.querySelectorAll('div.vscode-wolfram-wllatex-raw-latex[data-latex-b64]');
            if (rawLatexDivs.length > 0) {
                const renderRawWithKatex = (katex) => {
                    rawLatexDivs.forEach(div => {
                        const btlError = div.getAttribute('data-btl-error');
                        const rawBoxes = (() => { try { return atob(div.getAttribute('data-boxes-b64') || ''); } catch(e) { return ''; } })();
                        let latex = '';
                        try { latex = atob(div.getAttribute('data-latex-b64') || ''); } catch(e) {}
                        // Error banner from boxToLatex (parse error etc.)
                        const errBanner = btlError
                            ? `<div style="color:#e05c4e;font-size:11px;margin:0 0 3px;">⚠️ boxToLatex error: ${btlError.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`
                            : '';
                        // Debug disclosure widget
                        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                        const debugHtml =
                            '<details style="margin-top:4px;font-size:11px;opacity:0.65;">' +
                            '<summary style="cursor:pointer;user-select:none;">WLLatex2 debug</summary>' +
                            '<pre style="margin:2px 0;white-space:pre-wrap;word-break:break-all;">' +
                            '<b>boxes:</b> ' + esc(rawBoxes) + '\n' +
                            '<b>latex:</b> ' + esc(latex) +
                            (btlError ? '\n<b style="color:#e05c4e;">error:</b> ' + esc(btlError) : '') +
                            '</pre></details>';
                        let rendered = '';
                        try {
                            rendered = katex.renderToString(latex, {
                                displayMode: true, throwOnError: false,
                                output: 'html', trust: false
                            });
                        } catch(e) {
                            rendered = '<pre style="color:#e05c4e;">KaTeX error: ' + esc(String(e.message||e)) + '</pre>';
                        }
                        div.innerHTML = errBanner + rendered + debugHtml;
                    });
                    // ---- Height fix: KaTeX renders async (CDN load), so VS Code may have
                    // already measured this cell's height as 0 (empty latex divs). Trigger
                    // a sentinel DOM mutation so VS Code's ResizeObserver re-measures the
                    // cell with the now-populated KaTeX content, preventing cells from
                    // stacking on top of each other. ----
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            try {
                                const _d = element.ownerDocument || document;
                                const sentinel = _d.createElement('div');
                                sentinel.style.cssText = 'height:0;width:0;overflow:hidden;position:absolute;pointer-events:none;';
                                element.appendChild(sentinel);
                                requestAnimationFrame(() => { try { sentinel.remove(); } catch(_) {} });
                            } catch(_) {}
                        });
                    });
                };
                if (typeof window !== 'undefined' && window.katex) {
                    renderRawWithKatex(window.katex);
                } else {
                    // Reuse the same KaTeX CDN loading path as the TeX block
                    const KATEX_VER2 = '0.16.9';
                    const KATEX_BASE2 = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VER2}/dist/`;
                    if (!document.querySelector('link[data-katex-css]')) {
                        const lnk = document.createElement('link');
                        lnk.rel = 'stylesheet'; lnk.href = KATEX_BASE2 + 'katex.min.css';
                        lnk.setAttribute('data-katex-css', '1');
                        document.head.appendChild(lnk);
                    }
                    if (document.querySelector('script[data-katex-js]')) {
                        let tries2 = 0;
                        const poll2 = setInterval(() => {
                            if (window.katex || ++tries2 > 50) {
                                clearInterval(poll2);
                                if (window.katex) renderRawWithKatex(window.katex);
                            }
                        }, 100);
                    } else {
                        const scr2 = document.createElement('script');
                        scr2.src = KATEX_BASE2 + 'katex.min.js'; scr2.setAttribute('data-katex-js', '1');
                        scr2.onload = () => renderRawWithKatex(window.katex);
                        document.head.appendChild(scr2);
                    }
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

