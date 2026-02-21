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
div.mathml-output { overflow-x:auto; }
`;

function injectRendererCSS(doc) {
    if (doc.querySelector('style[data-wolfram-renderer]')) return;
    const s = doc.createElement('style');
    s.setAttribute('data-wolfram-renderer', '1');
    s.textContent = WL_CSS;
    (doc.head || doc.body || doc.documentElement).appendChild(s);
    console.log('[WolframRenderer] CSS injected into document');
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
                    ? 'body { filter: grayscale(0.75) opacity(0.55); transition: filter 0.4s, opacity 0.4s; }'
                    : 'body { filter: none; opacity: 1; transition: filter 0.4s, opacity 0.4s; }';
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

            // Double requestAnimationFrame: first rAF fires at the start of the next
            // paint frame (layout not yet complete), second rAF fires after the browser
            // has finished layout and the cell has its final rendered height.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    console.log('[WolframRenderer] render layout COMPLETE — cell height is stable (double-rAF)');
                });
            });
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
            });
            
            // ---- Wrap-toggle buttons for MathML divs ----
            // Append each button to .wl-output-header (same flex row as Out[N]= label)
            const mathmlDivs = element.querySelectorAll('div.mathml-output');
            console.log('[WolframRenderer] Found', mathmlDivs.length, 'div.mathml-output elements');
            mathmlDivs.forEach((div, index) => {
                let isWrapped = false;
                const btn = document.createElement('button');
                btn.innerHTML = '&#8659; Wrap';
                btn.title = 'Toggle line-wrap / scroll for this expression';
                btn.style.cssText = 'padding:1px 7px;font-size:11px;cursor:pointer;' +
                                    'background:rgba(100,100,100,0.1);border:1px solid rgba(128,128,128,0.4);' +
                                    'border-radius:3px;flex-shrink:0;margin-left:auto;';
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    isWrapped = !isWrapped;
                    console.log('[WolframRenderer] Wrap toggle', index, isWrapped ? '→ wrap' : '→ scroll');
                    if (isWrapped) {
                        div.style.overflowX = 'hidden';
                        div.style.overflowWrap = 'break-word';
                        div.style.wordBreak = 'break-all';
                        div.style.whiteSpace = 'normal';
                        div.style.display = 'block';
                        div.style.width = '100%';
                        div.querySelectorAll('math,mrow,mo,mi,mn,mfrac,msup,msub').forEach(el => {
                            el.style.maxWidth = '100%';
                            el.style.overflowWrap = 'break-word';
                            el.style.wordBreak = 'break-all';
                            el.style.display = 'inline-block';
                        });
                        btn.innerHTML = '&#8596; Scroll';
                    } else {
                        div.style.overflowX = 'auto';
                        div.style.overflowWrap = '';
                        div.style.wordBreak = '';
                        div.style.whiteSpace = '';
                        div.style.display = '';
                        div.style.width = '';
                        div.querySelectorAll('math,mrow,mo,mi,mn,mfrac,msup,msub').forEach(el => {
                            el.style.maxWidth = '';
                            el.style.overflowWrap = '';
                            el.style.wordBreak = '';
                            el.style.display = '';
                        });
                        btn.innerHTML = '&#8659; Wrap';
                    }
                    // After toggling, scroll back to the top of this output so the
                    // user sees the beginning (the output may have grown/shrunk).
                    if (context && context.postMessage) {
                        try {
                            context.postMessage({ type: 'scroll-to-output', outputId: currentOutputId });
                            console.log('[WolframRenderer] scroll-to-output sent for outputId:', currentOutputId);
                        } catch (err) {
                            console.warn('[WolframRenderer] scroll-to-output postMessage failed:', err);
                        }
                    }
                });
                // Append button into the flex header row (.wl-output-header) so it appears
                // inline next to the Out[N]= label, not below the output content.
                const block = div.closest('.wl-output-block');
                const header = block && block.querySelector('.wl-output-header');
                if (header) {
                    header.appendChild(btn);
                    console.log('[WolframRenderer] Appended wrap button to .wl-output-header[' + index + ']');
                } else {
                    // Fallback for outputs without the block structure
                    div.insertAdjacentElement('afterend', btn);
                    console.log('[WolframRenderer] Fallback: inserted wrap button after div.mathml-output[' + index + ']');
                }
            });
        },
        
        disposeOutputItem(outputId) {
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

