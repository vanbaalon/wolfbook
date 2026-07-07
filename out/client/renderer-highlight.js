/*
 * renderer-highlight.js — Inline syntax highlighter, CSS injector, line-number gutter.
 * Extracted from index-with-messaging.js (Round 10 refactor).
 *
 * Licensed under the Apache License, Version 2.0
 */

import { WL_CSS } from './renderer-css.js';
import { KATEX_CSS } from './katex-css.js';

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
    // KaTeX CSS with inlined fonts must be present BEFORE output HTML is set:
    // VS Code measures the cell height synchronously after renderOutputItem,
    // and a stylesheet arriving later re-sizes every math output (visible jump).
    const k = doc.createElement('style');
    k.setAttribute('data-katex-css', '1');
    k.textContent = KATEX_CSS;
    (doc.head || doc.body || doc.documentElement).appendChild(k);
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

export { applyInlineHighlight, injectRendererCSS, addLineNumberGutter };
