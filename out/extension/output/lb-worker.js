'use strict';
/**
 * lb-worker.js — Worker thread for async LaTeX line-breaking (phase 2 of two-phase BTL rendering).
 *
 * Receives via workerData:
 *   addonPath        — absolute path to wolfbook_btl.node
 *   katexPrerenderPath — absolute path to katexPrerender.js
 *   latex            — raw LaTeX string from boxToLatex (phase 1)
 *   lbOpts           — lineBreakLatex options (pageWidth, maxRows, etc.)
 *
 * Posts back:
 *   { ok: true,  totalPages: 1, html: string, latexFinal: string }   — single-page result (pre-rendered)
 *   { ok: true,  totalPages: N, latexFinal: string, allPageLatex: string[]|null } — multi-page (main thread builds pager)
 *   { ok: false, error: string } — failure (phase-1 result stays on screen)
 */
const { workerData, parentPort } = require('worker_threads');
const { addonPath, katexPrerenderPath, latex, lbOpts,
        logPath, source, rawText, boxStr, pageWidthEm } = workerData;
try {
    const btl = require(addonPath);
    if (!btl.lineBreakLatex) {
        parentPort.postMessage({ ok: false, error: 'lineBreakLatex not available in this build' });
        return;
    }
    const { prerenderLatex } = require(katexPrerenderPath);
    const lbr = btl.lineBreakLatex(latex, { ...lbOpts, allPages: true });
    let latexFinal = latex;
    let totalPages = 1;
    let allPageLatex = null;
    let lineBreakStatus = 'no-change';
    if (lbr && typeof lbr === 'object') {
        latexFinal = lbr.result || latex;
        totalPages = lbr.totalPages || 1;
        allPageLatex = (Array.isArray(lbr.pages) && lbr.pages.length > 1) ? lbr.pages : null;
    } else if (typeof lbr === 'string') {
        latexFinal = lbr;
    }
    lineBreakStatus = totalPages > 1
        ? 'paged: ' + totalPages + ' pages'
        : latexFinal !== latex ? 'applied' : 'no-change (fits in width)';
    // Write btl.log (optional — do not block result on log failure)
    if (logPath) {
        try {
            const fs = require('fs');
            const path = require('path');
            const ts = new Date().toISOString();
            const sep = '='.repeat(72) + '\n';
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, sep + ts + (source ? '  [' + source + ']' : '') + '\n' +
                '-- kernel output --\n' + (rawText || '') + '\n' +
                '-- btl input (cleaned boxes) --\n' + (boxStr || '') + '\n' +
                '-- btl output (latex) --\n' + latex + '\n' +
                '-- pageWidthEm: ' + pageWidthEm + '  lineBreak: ' + lineBreakStatus +
                '  opts: ' + JSON.stringify(lbOpts) + ' --\n');
        } catch (_) {}
    }
    if (totalPages === 1) {
        // Prerender KaTeX here in the worker — saves main thread work.
        const html = prerenderLatex(latexFinal, true);
        parentPort.postMessage({ ok: true, totalPages: 1, html, latexFinal });
    } else {
        // Multi-page: send raw latex data back. Main thread builds pager (needs _pagerStore).
        parentPort.postMessage({ ok: true, totalPages, latexFinal, allPageLatex });
    }
} catch (e) {
    parentPort.postMessage({ ok: false, error: String(e.message || e) });
}
