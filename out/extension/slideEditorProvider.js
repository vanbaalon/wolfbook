'use strict';
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const { decodeWstpText } = require('./utils/encoding');
const { devLog, LOG_CHANNELS } = require('./utils/dev-logger');

// ---- BTL (BoxToLatex) addon for eval block LaTeX rendering ----
const _BTL_DIR = path.join(__dirname, '../../wllatex-addon');
const _KATEX_PRERENDER_PATH = path.join(__dirname, '../../wllatex-addon/katexPrerender.js');
let _btlAddon = null;
let _btlPrerenderLatex = null;
let _wlUTFtoNames = null;

function _loadBtl() {
    if (_btlAddon) return true;
    try {
        const prebuilt = path.join(_BTL_DIR, 'prebuilt',
            `wolfbook_btl-${process.platform}-${process.arch}.node`);
        const fallback = path.join(_BTL_DIR, 'wolfbook_btl.node');
        const addonPath = fs.existsSync(prebuilt) ? prebuilt : fallback;
        _btlAddon = require(addonPath);
        _btlPrerenderLatex = require(_KATEX_PRERENDER_PATH).prerenderLatex;
        _wlUTFtoNames = require('./namedchars').wlUTFtoNames;
        return true;
    } catch (e) {
        console.warn('[wslide-eval] BTL addon not available:', e.message);
        return false;
    }
}

/**
 * Convert base64-encoded Wolfram box expression to KaTeX HTML via BTL.
 * Returns { type: 'latex', html, latex } on success, or { type: 'text', text } on failure.
 */
function _evalBoxesToKaTeX(context, b64boxes, containerWidthPx) {
    if (!_loadBtl()) {
        // BTL not available — decode boxes and show as text
        try {
            const boxStr = Buffer.from(b64boxes, 'base64').toString('utf8');
            return { type: 'text', text: boxStr };
        } catch (_) {
            return { type: 'text', text: '(BTL addon not available)' };
        }
    }
    try {
        let boxStr = Buffer.from(b64boxes, 'base64').toString('utf8');
        boxStr = _wlUTFtoNames(boxStr);
        const btlOpts = { trigOmitParens: true, trigPowerForm: true };
        const result = _btlAddon.boxToLatex(boxStr, btlOpts);
        let latex = (result && typeof result === 'object') ? result.latex : String(result);
        const error = (result && typeof result === 'object') ? result.error : null;
        if (error) console.warn('[wslide-eval] BTL error:', error);

        // Line-break if width is available (approximate em width from px)
        const pageWidthEm = Math.max(0, Math.round(containerWidthPx / 10));
        if (pageWidthEm > 5 && _btlAddon.lineBreakLatex) {
            try {
                latex = _btlAddon.lineBreakLatex(latex, { pageWidth: pageWidthEm });
            } catch (_) {}
        }

        // Pre-render via KaTeX in Node.js
        const html = _btlPrerenderLatex(latex, true /* displayMode */);
        devLog(LOG_CHANNELS.SLIDE, '[wslide-eval] BTL → LaTeX length:', latex.length, 'KaTeX HTML length:', html.length);
        return { type: 'latex', html, latex };
    } catch (e) {
        console.error('[wslide-eval] BTL/KaTeX error:', e.message);
        try {
            const boxStr = Buffer.from(b64boxes, 'base64').toString('utf8');
            return { type: 'text', text: boxStr };
        } catch (_) {
            return { type: 'error', error: 'BTL rendering failed: ' + e.message };
        }
    }
}

// ── PDF export via headless Chrome ───────────────────────────────────────────
// Writes `html` to a temp file, renders it with headless Chrome, and saves
// the resulting PDF to `outPath`.  On failure, tries Edge then raises.
//
// Page size is set via CSS @page inside the HTML (1920pt × 1080pt, margin:0),
// so each .slide-page div becomes exactly one landscape PDF page.

const { execFile } = require('child_process');
const os = require('os');

function _findChrome() {
    const candidates = process.platform === 'darwin' ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ] : process.platform === 'win32' ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ] : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return null;
}

function _exportHtmlToPdf(html, outPath) {
    return new Promise((resolve, reject) => {
        const chrome = _findChrome();
        if (!chrome) {
            reject(new Error(
                'No Chrome/Chromium found. Install Google Chrome and try again.'
            ));
            return;
        }
        // Write HTML to a temp file Chrome can open via file:// URL
        const tmpHtml = path.join(os.tmpdir(), `wslide_pdf_${Date.now()}.html`);
        // Use an isolated user-data-dir so headless Chrome does not conflict
        // with any already-running Chrome instances sharing the default profile.
        const tmpUserDataDir = path.join(os.tmpdir(), `wslide_chrome_${Date.now()}`);
        try { fs.writeFileSync(tmpHtml, html, 'utf8'); } catch (e) { reject(e); return; }
        try { fs.mkdirSync(tmpUserDataDir, { recursive: true }); } catch (e) { /* ignore */ }

        const args = [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-extensions',
            '--run-all-compositor-stages-before-draw',
            '--no-pdf-header-footer',
            // 1920×1080 px at 96 dpi = 20×11.25 inches = 1920×1080 pt at 96 dpi
            // Chrome --print-to-pdf uses CSS @page size, so set it explicitly too
            '--print-to-pdf-no-header',
            `--user-data-dir=${tmpUserDataDir}`,
            `--print-to-pdf=${outPath}`,
            `file://${tmpHtml}`,
        ];

        execFile(chrome, args, { timeout: 60000 }, (err, stdout, stderr) => {
            fs.unlink(tmpHtml, () => {});  // clean up temp html
            fs.rm(tmpUserDataDir, { recursive: true, force: true }, () => {});  // clean up user-data-dir
            if (err) { reject(new Error(`Chrome PDF render failed: ${stderr || err.message}`)); return; }
            if (!fs.existsSync(outPath)) { reject(new Error('Chrome ran but did not produce a PDF file.')); return; }
            resolve();
        });
    });
}

// Find python3 on the system: check PATH first, then common install locations.
function _findPython() {
    const { execSync } = require('child_process');
    // Try PATH first
    try {
        const p = execSync('which python3', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (p && fs.existsSync(p)) return p;
    } catch (_) {}
    // Fall back to common locations
    const candidates = process.platform === 'darwin' ? [
        '/opt/anaconda3/bin/python3',
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        '/usr/bin/python3',
    ] : process.platform === 'win32' ? [
        'python3.exe',
        'python.exe',
    ] : [
        '/usr/bin/python3',
        '/usr/local/bin/python3',
    ];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return null;
}

// Check that python3 is available and pypdf is installed.
// Returns null if OK, or an error string with install instructions.
function _checkPythonDeps() {
    const python = _findPython();
    if (!python) {
        return 'Python 3 not found. Install it from https://python.org or via Homebrew (brew install python).';
    }
    const { execSync } = require('child_process');
    try {
        execSync(`"${python}" -c "import pypdf"`, { timeout: 5000, stdio: 'ignore' });
    } catch (_) {
        return `pypdf not installed. Run: ${python} -m pip install pypdf`;
    }
    return null;
}

// Parse a slide range string like "1-5, 7, 10-12" into sorted 0-based indices.
function _parseSlideRange(input, total) {
    const indices = new Set();
    for (const part of input.split(',')) {
        const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!m) continue;
        const from = Math.max(1, parseInt(m[1]));
        const to   = m[2] ? Math.min(total, parseInt(m[2])) : from;
        for (let i = from; i <= to; i++) indices.add(i - 1);
    }
    return [...indices].sort((a, b) => a - b);
}

// Max fragmentOrder across all blocks in a slide (0 = no animation).
function _maxFragOrder(slide) {
    let m = 0;
    function walk(node) {
        (node.children || []).forEach(b => { if ((b.fragmentOrder || 0) > m) m = b.fragmentOrder; walk(b); });
        (node.items    || []).forEach(b => { if ((b.fragmentOrder || 0) > m) m = b.fragmentOrder; walk(b); });
    }
    walk(slide);
    return m;
}

// Assemble an ordered array of PNG paths into a single PDF using Chrome's
// --print-to-pdf. Each PNG becomes one page. No Python dependency needed.
function _assemblePngsToPdf(pngPaths, outPath) {
    return new Promise((resolve, reject) => {
        const chrome = _findChrome();
        // Build a minimal HTML: one full-bleed image per @page.
        // Chrome --print-to-pdf honours the @page size and break-after rules.
        const pages = pngPaths.map(p => {
            const fileUrl = 'file://' + p.replace(/\\/g, '/');
            return `<div class="page"><img src="${fileUrl.replace(/"/g, '%22')}"></div>`;
        }).join('\n');
        const html = `<!DOCTYPE html><html><head>
<style>
@page{size:20in 11.25in;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#000;}
.page{width:1920px;height:1080px;overflow:hidden;break-after:page;break-inside:avoid;}
.page:last-child{break-after:auto;}
img{width:1920px;height:1080px;display:block;}
</style></head><body>${pages}</body></html>`;

        const tag    = Date.now();
        const tmpHtml = path.join(os.tmpdir(), `wslide_asm_${tag}.html`);
        const tmpUdd  = path.join(os.tmpdir(), `wslide_udd_${tag}`);
        try { fs.writeFileSync(tmpHtml, html, 'utf8'); } catch (e) { reject(e); return; }
        try { fs.mkdirSync(tmpUdd, { recursive: true }); } catch (_) {}

        const args = [
            '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions',
            '--run-all-compositor-stages-before-draw',
            '--print-to-pdf-no-header', '--no-pdf-header-footer',
            `--user-data-dir=${tmpUdd}`,
            `--print-to-pdf=${outPath}`,
            `file://${tmpHtml}`,
        ];
        execFile(chrome, args, { timeout: 120000 }, (err) => {
            fs.unlink(tmpHtml, () => {});
            fs.rm(tmpUdd, { recursive: true, force: true }, () => {});
            if (err) { reject(new Error(`PDF assembly failed: ${err.message}`)); return; }
            if (!fs.existsSync(outPath)) { reject(new Error('Chrome assembly did not produce a PDF.')); return; }
            resolve();
        });
    });
}

// Screenshot a standalone HTML page to a PNG using Chrome headless.
// Uses the full GPU rendering pipeline — shadows, gradients, and all CSS effects render correctly.
function _screenshotHtmlToPng(html, outPath) {
    return new Promise((resolve, reject) => {
        const chrome = _findChrome();
        const tag = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const tmpHtml = path.join(os.tmpdir(), `wslide_shot_${tag}.html`);
        const tmpUdd  = path.join(os.tmpdir(), `wslide_udd_${tag}`);
        try { fs.writeFileSync(tmpHtml, html, 'utf8'); } catch (e) { reject(e); return; }
        try { fs.mkdirSync(tmpUdd, { recursive: true }); } catch (_) {}
        const args = [
            '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions',
            '--run-all-compositor-stages-before-draw',
            '--window-size=1920,1080', '--hide-scrollbars', '--force-device-scale-factor=1',
            `--user-data-dir=${tmpUdd}`,
            `--screenshot=${outPath}`,
            `file://${tmpHtml}`,
        ];
        execFile(chrome, args, { timeout: 30000 }, (err) => {
            fs.unlink(tmpHtml, () => {});
            fs.rm(tmpUdd, { recursive: true, force: true }, () => {});
            if (err) { reject(new Error(`Screenshot failed: ${err.message}`)); return; }
            if (!fs.existsSync(outPath)) { reject(new Error('Chrome ran but produced no screenshot.')); return; }
            resolve();
        });
    });
}

// Merge an array of PNG files into one PDF using python3 + img2pdf.
// img2pdf embeds PNGs losslessly — pixel-perfect output, no JPEG artefacts.
function _mergeImagesToPdf(pngPaths, outputPath) {
    return new Promise((resolve, reject) => {
        const python = _findPython();
        // img2pdf reads DPI from PNG metadata; Chrome writes 96dpi → 20×11.25in page
        const script = [
            'import sys, img2pdf',
            'with open(sys.argv[-1], "wb") as f:',
            '    f.write(img2pdf.convert(sys.argv[1:-1]))',
        ].join('\n');
        const tmpScript = path.join(os.tmpdir(), `wslide_imgpdf_${Date.now()}.py`);
        try { fs.writeFileSync(tmpScript, script, 'utf8'); } catch (e) { reject(e); return; }
        execFile(python, [tmpScript, ...pngPaths, outputPath], { timeout: 120000 }, (err, _stdout, stderr) => {
            fs.unlink(tmpScript, () => {});
            if (err) reject(new Error(`Image→PDF failed: ${stderr || err.message}`));
            else resolve();
        });
    });
}

// Run async tasks with limited concurrency. items[i] → fn(item, i) → result[i].
async function _runConcurrent(items, concurrency, fn) {
    const results = new Array(items.length);
    const queue = items.map((item, i) => [i, item]);
    async function worker() {
        while (queue.length) {
            const [i, item] = queue.shift();
            results[i] = await fn(item, i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

// Non-blocking: if a render dependency (katex/prismjs) is missing, surface a
// clear warning with a copyable install command. Exports still proceed (degraded)
// so the user is never hard-blocked, but they know why output won't match the editor.
function _warnMissingExportDeps() {
    try {
        const exporter = require('./slideExporter');
        const missing = exporter.checkExportDependencies ? exporter.checkExportDependencies() : [];
        if (!missing.length) return;
        const pkgs = missing.map(m => m.pkg).join(' ');
        const installCmd = `cd "Extension Development" && npm install ${pkgs}`;
        const detail = missing.map(m => `${m.pkg} (${m.purpose})`).join(', ');
        vscode.window.showWarningMessage(
            `Slide export is missing ${detail} — exports will NOT match the editor. Install: ${installCmd}`,
            'Copy install command'
        ).then(choice => {
            if (choice === 'Copy install command') vscode.env.clipboard.writeText(installCmd);
        });
    } catch (_) { /* never block export on the check itself */ }
}

// onProgress(message, increment) — optional VS Code progress callback
async function _exportDeckToPdf(deck, deckDir, outPath, onProgress, opts) {
    const exporter = require('./slideExporter');
    const slides = (deck.slides || []).filter(s => !s.hidden);
    // finalOnly: one page per slide rendered at its FINAL state (all fragments
    // revealed) — for publishing/handout PDFs. Default (false): the Beamer-style
    // per-step export with one page per animation click — for presenting.
    const finalOnly = !!(opts && opts.finalOnly);

    // Pre-flight
    if (!_findChrome()) throw new Error('No Chrome/Chromium found. Install Google Chrome and try again.');

    // Collect all (slide, step) pages in display order
    const pages = [];
    for (const slide of slides) {
        const maxFrag = _maxFragOrder(slide);
        if (finalOnly) {
            // step = maxFrag makes every fragment visible (nothing has fo > step)
            pages.push({ slide, step: maxFrag });
        } else {
            for (let step = 0; step <= maxFrag; step++) pages.push({ slide, step });
        }
    }

    onProgress && onProgress(`Rendering ${pages.length} ${finalOnly ? 'slide' : 'frame'}(s)…`, 5);

    // Screenshot each frame in parallel (6 concurrent Chrome instances)
    const tmpPngs = new Array(pages.length).fill(null);
    let done = 0;
    try {
        await _runConcurrent(pages, 6, async ({ slide, step }, i) => {
            const html = exporter.exportSlideStepHtml(slide, step, deck, deckDir);
            const png  = path.join(os.tmpdir(), `wslide_frame_${Date.now()}_${i}.png`);
            await _screenshotHtmlToPng(html, png);
            tmpPngs[i] = png;
            done++;
            onProgress && onProgress(`Rendered ${done}/${pages.length} ${finalOnly ? 'slides' : 'frames'}…`, 85 / pages.length);
        });

        onProgress && onProgress('Assembling PDF…', 8);
        await _assemblePngsToPdf(tmpPngs, outPath);
        onProgress && onProgress('Done', 2);
    } finally {
        tmpPngs.forEach(f => f && fs.unlink(f, () => {}));
    }
}

// Module-level reference for wolfslide tools to reach the active provider.
let _activeProvider = null;

class SlideEditorProvider {
    static viewType = 'wolfbook.slideEditor';

    constructor(context) {
        this._context = context;
        // Entries: Map<docUriString, {deck, webviewPanel, document, saving}>
        this._panels = new Map();
        this._getController = null;
        this._slideClipboard = null; // shared slide clipboard across all open .wslide editors
        _activeProvider = this;
    }

    /** For wolfslide tools */
    static getInstance() { return _activeProvider; }

    /** Provide kernel access from the extension activation. */
    setGetController(fn) { this._getController = fn; }

    /** Returns the visible panel entry, or the most recently added one. */
    getActiveEntry() {
        for (const [, e] of this._panels) {
            if (e.webviewPanel.visible) return e;
        }
        return this._panels.size > 0 ? [...this._panels.values()][0] : null;
    }

    // -------------------------------------------------------------------------
    // CustomTextEditorProvider interface
    // -------------------------------------------------------------------------
    async resolveCustomTextEditor(document, webviewPanel, _token) {
        const docKey  = document.uri.toString();
        const exporter = require('./slideExporter');

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
            ],
        };

        let deck = _parseDeck(document.getText());
        const entry = { deck, webviewPanel, document, saving: false, currentSlideIndex: 0, _undoStack: [], _scope: null };
        this._panels.set(docKey, entry);

        webviewPanel.webview.html = this._buildHtml(webviewPanel.webview, document);

        const deckName = path.basename(document.uri.fsPath, '.wslide');

        // ── Receive messages from the webview ──────────────────────────────
        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.cmd) {

                case 'ready': {
                    const deckDir = path.dirname(document.uri.fsPath);
                    const deckToSend = _rewriteDeckImgPaths(entry.deck, deckDir, webviewPanel.webview);
                    let initClipboard = null;
                    if (this._slideClipboard) {
                        const clip = this._slideClipboard;
                        initClipboard = _translateSlideImages(
                            clip.slides, clip.srcDeckDir, clip.srcDeckName,
                            deckDir, deckName, webviewPanel.webview
                        );
                    }
                    webviewPanel.webview.postMessage({
                        cmd: 'init',
                        deck: deckToSend,
                        deckName,
                        slideClipboard: initClipboard,
                    });
                    break;
                }

                case 'save': {
                    entry.saving = true;
                    try {
                        const reverted = _revertDeckImgPaths(
                            msg.deck,
                            path.dirname(document.uri.fsPath)
                        );
                        // Fix any foreign webview URIs that _revertDeckImgPaths couldn't convert
                        // (cross-directory paste before clipboard translation was active)
                        const saveDir     = path.dirname(document.uri.fsPath);
                        const saveImgDir  = path.join(saveDir, 'img', deckName + '.wslide');
                        _walkDeckSrcs(reverted, src => {
                            if (!src || !src.includes('vscode')) return src;
                            try {
                                let fsPath;
                                if (src.startsWith('vscode-resource:')) {
                                    fsPath = decodeURIComponent(src.replace(/^vscode-resource:\/\//, '/').replace(/^vscode-resource:/, ''));
                                } else {
                                    const u = new URL(src);
                                    fsPath = decodeURIComponent(u.pathname);
                                    if (/^\/[A-Za-z]:/.test(fsPath)) fsPath = fsPath.slice(1);
                                }
                                if (fs.existsSync(fsPath)) {
                                    const fname = path.basename(fsPath);
                                    fs.mkdirSync(saveImgDir, { recursive: true });
                                    const dest = path.join(saveImgDir, fname);
                                    if (!fs.existsSync(dest)) fs.copyFileSync(fsPath, dest);
                                    return `img/${deckName}.wslide/${fname}`;
                                }
                            } catch (_) {}
                            return src;
                        });
                        // Snapshot pre-edit state so wolfslide_undo can revert UI edits
                        if (entry.deck) {
                            if (!entry._undoStack) entry._undoStack = [];
                            entry._undoStack.push(JSON.parse(JSON.stringify(entry.deck)));
                            if (entry._undoStack.length > 20) entry._undoStack.shift();
                        }
                        entry.deck = reverted;
                        const text = JSON.stringify(reverted, (k, v) => k.startsWith('_') ? undefined : v, 2);
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(
                            document.uri,
                            new vscode.Range(0, 0, document.lineCount, 0),
                            text
                        );
                        await vscode.workspace.applyEdit(edit);
                        await document.save();
                        // Prune images no longer referenced by any block
                        _pruneUnusedImages(reverted, path.dirname(document.uri.fsPath), deckName);
                    } finally {
                        entry.saving = false;
                    }
                    webviewPanel.webview.postMessage({ cmd: 'saveAck', id: msg.id });
                    break;
                }

                case 'saveas': {
                    try {
                        const srcDir  = path.dirname(document.uri.fsPath);
                        const defaultUri = vscode.Uri.file(
                            path.join(srcDir, deckName + '_copy.wslide')
                        );
                        const destUri = await vscode.window.showSaveDialog({
                            defaultUri,
                            filters: { 'Wolfbook Slides': ['wslide'] },
                            title: 'Save Slide Deck As',
                        });
                        if (!destUri) break;

                        const destPath    = destUri.fsPath;
                        const destDir     = path.dirname(destPath);
                        const newDeckName = path.basename(destPath, '.wslide');

                        // Deep-clone the current deck and update title
                        const newDeck = JSON.parse(JSON.stringify(entry.deck));
                        if (newDeck.meta) newDeck.meta.title = newDeckName;

                        // Copy all referenced images to the new location (handles pasted slides
                        // from other files that may use img/<otherDeckName>.wslide/ paths)
                        const destImgDir = path.join(destDir, 'img', newDeckName + '.wslide');
                        function fixImgSrcs(b) {
                            if (!b) return;
                            if (typeof b.src === 'string' && /^img\/[^/]+\.wslide\//.test(b.src)) {
                                const fname = b.src.replace(/^img\/[^/]+\.wslide\//, '');
                                const srcFilePath = path.join(srcDir, b.src);
                                if (fs.existsSync(srcFilePath)) {
                                    try {
                                        fs.mkdirSync(destImgDir, { recursive: true });
                                        const destFilePath = path.join(destImgDir, fname);
                                        if (!fs.existsSync(destFilePath)) fs.copyFileSync(srcFilePath, destFilePath);
                                    } catch (_) {}
                                }
                                b.src = `img/${newDeckName}.wslide/${fname}`;
                            }
                            (b.children || []).forEach(fixImgSrcs);
                            (b.items    || []).forEach(fixImgSrcs);
                        }
                        (newDeck.slides || []).forEach(s =>
                            (s.children || s.elements || []).forEach(fixImgSrcs)
                        );

                        // Write the new .wslide file
                        fs.writeFileSync(destPath, JSON.stringify(newDeck, null, 2), 'utf8');

                        // Open the new file in a new editor tab
                        await vscode.commands.executeCommand(
                            'vscode.openWith',
                            destUri,
                            'wolfbook.slideEditor'
                        );

                        // Tell the current webview the operation succeeded
                        webviewPanel.webview.postMessage({
                            cmd: 'saveasAck',
                            deckName,          // keep the current tab name unchanged
                        });
                        vscode.window.showInformationMessage(`Saved as: ${path.basename(destPath)}`);
                    } catch (err) {
                        vscode.window.showErrorMessage(`Save As failed: ${err.message}`);
                    }
                    break;
                }

                case 'slideClipboard': {
                    // Webview notifies host of a copy/cut.
                    // Revert webview URIs → relative paths so the data is portable across panels.
                    const srcDeckDir = path.dirname(document.uri.fsPath);
                    const slidesReverted = _revertDeckImgPaths(
                        { slides: msg.slides || [] }, srcDeckDir
                    ).slides;
                    this._slideClipboard = { slides: slidesReverted, srcDeckDir, srcDeckName: deckName };
                    // Broadcast to other panels — copy images and rewrite paths for each target
                    for (const [key, otherEntry] of this._panels) {
                        if (key === docKey) continue;
                        const otherDeckName = path.basename(otherEntry.document.uri.fsPath, '.wslide');
                        const otherDeckDir  = path.dirname(otherEntry.document.uri.fsPath);
                        const translated = _translateSlideImages(
                            slidesReverted, srcDeckDir, deckName,
                            otherDeckDir, otherDeckName, otherEntry.webviewPanel.webview
                        );
                        otherEntry.webviewPanel.webview.postMessage({ cmd: 'slideClipboard', slides: translated });
                    }
                    break;
                }

                case 'upload': {
                    const deckDir = path.dirname(document.uri.fsPath);
                    const imgDir  = path.join(deckDir, 'img', deckName + '.wslide');
                    fs.mkdirSync(imgDir, { recursive: true });
                    const urls = (msg.files || []).map(f => {
                        const rawName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'image.png';
                        // Always prefix with a timestamp so repeated pastes never collide
                        // (and browser cache is automatically busted by the unique path).
                        const safeName = Date.now() + '_' + rawName;
                        const destPath = path.join(imgDir, safeName);
                        fs.writeFileSync(destPath, Buffer.from(f.data, 'base64'));
                        return webviewPanel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    });
                    webviewPanel.webview.postMessage({ cmd: 'uploadAck', id: msg.id, result: urls });
                    break;
                }

                case 'export': {
                    try {
                        _warnMissingExportDeps();
                        const exDeckDir = path.dirname(document.uri.fsPath);
                        // Preferred: serialize the webview's LIVE rendered DOM and wrap it in
                        // Reveal.js (navigation + fragment animation + per-slide transitions).
                        // Fall back to the string Reveal renderer if the round-trip fails.
                        let html = await this._buildSerializedHtml(entry, null, deckName, 'reveal');
                        if (!html) html = exporter.exportDeck(entry.deck, { deckDir: exDeckDir });
                        const defaultUri = vscode.Uri.file(
                            path.join(path.dirname(document.uri.fsPath), deckName + '.html')
                        );
                        const saveUri = await vscode.window.showSaveDialog({
                            defaultUri,
                            filters: { 'HTML Presentation': ['html'] },
                            title: 'Export Slides as Standalone HTML',
                        });
                        if (saveUri) {
                            fs.writeFileSync(saveUri.fsPath, html, 'utf8');
                            vscode.window.showInformationMessage(`Exported: ${path.basename(saveUri.fsPath)}`);
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`Export failed: ${err.message}`);
                    }
                    break;
                }

                case 'exportPdf': {
                    try {
                        _warnMissingExportDeps();
                        const deckDir  = path.dirname(document.uri.fsPath);
                        const allSlides = entry.deck.slides || [];
                        const total    = allSlides.length;

                        // ── Export style: presenting vs publishing ───────────
                        const stylePick = await vscode.window.showQuickPick([
                            { label: '$(book) Publishing — one page per slide',
                              detail: 'Final state of each slide, animations ignored. Best for handouts / sharing.',
                              value: 'final' },
                            { label: '$(play) Presenting — one page per animation step',
                              detail: 'Beamer-style: a separate page for each click/fragment reveal.',
                              value: 'steps' },
                        ], { title: 'PDF Export — style?', placeHolder: 'How should animations be handled?' });
                        if (!stylePick) break;
                        const finalOnly = stylePick.value === 'final';

                        // ── Slide selection ──────────────────────────────────
                        const pick = await vscode.window.showQuickPick([
                            { label: `All slides (${total})`,     value: 'all' },
                            { label: 'Current slide only',        value: 'current' },
                            { label: 'Custom range…',             value: 'custom' },
                        ], { title: 'PDF Export — which slides?', placeHolder: 'Select slide range' });
                        if (!pick) break;

                        let slideIndices; // 0-based indices into allSlides
                        if (pick.value === 'all') {
                            slideIndices = allSlides.map((_, i) => i);
                        } else if (pick.value === 'current') {
                            slideIndices = [entry.currentSlideIndex ?? 0];
                        } else {
                            const input = await vscode.window.showInputBox({
                                prompt: `Slide range (1–${total}). Examples: "1-5", "1,3,7", "2-4,8-10"`,
                                placeHolder: `1-${total}`,
                                validateInput: v => {
                                    const parsed = _parseSlideRange(v, total);
                                    return parsed.length ? null : 'No valid slide numbers found';
                                },
                            });
                            if (!input) break;
                            slideIndices = _parseSlideRange(input, total);
                        }

                        const deckSubset = Object.assign({}, entry.deck, {
                            slides: slideIndices.map(i => allSlides[i]).filter(Boolean),
                        });
                        const rangeLabel = pick.value === 'all' ? '' : `_slides${slideIndices.map(i => i+1).join('-')}`;
                        // Distinguish the per-step "presenting" PDF so it doesn't overwrite
                        // the clean per-slide "publishing" one (which keeps the plain name).
                        const styleLabel = finalOnly ? '' : '_steps';
                        const defaultUri = vscode.Uri.file(
                            path.join(deckDir, deckName + styleLabel + rangeLabel + '.pdf')
                        );
                        const saveUri = await vscode.window.showSaveDialog({
                            defaultUri,
                            filters: { 'PDF Presentation': ['pdf'] },
                            title: 'Export Slides as PDF',
                        });
                        if (saveUri) {
                            await vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: 'Exporting PDF…',
                                cancellable: false
                            }, async (progress) => {
                                // Publishing mode: print the SAME serialized HTML the editor
                                // produces, so PDF == HTML == editor. (Presenting mode keeps
                                // the per-step screenshot pipeline.)
                                let serialHtml = null;
                                if (finalOnly) {
                                    progress.report({ message: 'Rendering slides…', increment: 5 });
                                    serialHtml = await this._buildSerializedHtml(entry, slideIndices, deckName, 'static');
                                }
                                if (serialHtml) {
                                    progress.report({ message: 'Writing PDF…', increment: 80 });
                                    await _exportHtmlToPdf(serialHtml, saveUri.fsPath);
                                    return;
                                }
                                await _exportDeckToPdf(deckSubset, deckDir, saveUri.fsPath,
                                    (msg, increment) => progress.report({ message: msg, increment }),
                                    { finalOnly }
                                );
                            });
                            vscode.window.showInformationMessage(`PDF exported: ${path.basename(saveUri.fsPath)}`);
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`PDF export failed: ${err.message}`);
                    }
                    break;
                }

                case 'slideChange': {
                    entry.currentSlideIndex = msg.slideIndex ?? 0;
                    break;
                }

                case 'measureResult': {
                    if (msg.id && this._measurePending && this._measurePending[msg.id]) {
                        this._measurePending[msg.id](msg.result);
                        delete this._measurePending[msg.id];
                    }
                    break;
                }

                case 'screenshotResult': {
                    if (msg.id && this._screenshotPending && this._screenshotPending[msg.id]) {
                        this._screenshotPending[msg.id](msg);
                        delete this._screenshotPending[msg.id];
                    }
                    break;
                }

                case 'serializeDeckResult': {
                    if (msg.id && this._serializePending && this._serializePending[msg.id]) {
                        this._serializePending[msg.id](msg);
                        delete this._serializePending[msg.id];
                    }
                    break;
                }

                case 'presentFullscreen': {
                    // Zen mode hides ALL VS Code chrome (tabs, sidebar, activity bar,
                    // status bar) AND enters OS fullscreen (hiding title bar / window
                    // controls on macOS).  We track state to avoid accidentally toggling
                    // OUT of zen mode if it's already active.
                    console.log('[wslide-ext] presentFullscreen: _presZenMode=', this._presZenMode);
                    if (!this._presZenMode) {
                        // Prevent the gray "centered-layout-margin" divs that zen mode injects
                        // when zenMode.centerLayout is true (the VS Code default).
                        // Strategy: flip the config to false BEFORE entering zen mode so the
                        // margins are never created.  We restore the original value on exit.
                        const zenCfg = vscode.workspace.getConfiguration('zenMode');
                        const origCenterLayout = zenCfg.get('centerLayout');
                        this._presOrigCenterLayout = origCenterLayout;
                        if (origCenterLayout !== false) {
                            console.log('[wslide-ext] setting zenMode.centerLayout=false to prevent margin divs');
                            await zenCfg.update('centerLayout', false, vscode.ConfigurationTarget.Global);
                        }
                        vscode.commands.executeCommand('workbench.action.toggleZenMode');
                        this._presZenMode = true;
                    }
                    break;
                }

                case 'exitFullscreen': {
                    console.log('[wslide-ext] exitFullscreen: _presZenMode=', this._presZenMode);
                    if (this._presZenMode) {
                        vscode.commands.executeCommand('workbench.action.toggleZenMode');
                        this._presZenMode = false;
                        // Restore zenMode.centerLayout to whatever the user had before
                        if (this._presOrigCenterLayout !== false) {
                            const zenCfg = vscode.workspace.getConfiguration('zenMode');
                            const restoreVal = (this._presOrigCenterLayout === undefined) ? undefined : this._presOrigCenterLayout;
                            devLog(LOG_CHANNELS.SLIDE, '[wslide-ext] restoring zenMode.centerLayout to', restoreVal);
                            // undefined = remove the override (revert to default)
                            zenCfg.update('centerLayout', restoreVal, vscode.ConfigurationTarget.Global);
                        }
                    }
                    break;
                }

                case 'evalBlock': {
                    // Evaluate a Mathematica expression and return the result.
                    // Graphics → SVG; Non-graphics → boxes → BTL → KaTeX LaTeX;
                    // Fallback → Rasterize PNG → base64 image.
                    const blockId = msg.blockId;
                    const input   = msg.input;
                    const imgW    = msg.w || 800;
                    const timeout = 30; // seconds

                    const sendResult = (output) => {
                        webviewPanel.webview.postMessage({ cmd: 'evalBlockResult', blockId, output });
                    };

                    try {
                        const controller = this._getController?.();
                        if (!controller || !controller.session) {
                            sendResult({ type: 'error', error: 'Kernel not connected. Start a Wolfram kernel first.' });
                            break;
                        }
                        if (controller._evalDispatched) {
                            sendResult({ type: 'error', error: 'Kernel is busy with another evaluation. Try again shortly.' });
                            break;
                        }

                        // Build the evaluation expression:
                        // Graphics → SVG string; non-graphics → base64 boxes for BTL;
                        // fallbacks to Rasterize PNG or InputForm text.
                        const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                        const expr = `Block[{$wbRes$, $wbSvg$, $wbImg$, $wbBoxes$, $wbGfx$, $wbParsed$, $wbTO$},
  (* Parse without evaluating — catches syntax errors before timeout wrapping *)
  $wbParsed$ = Quiet[ToExpression["${escaped}", InputForm, Hold]];
  If[!MatchQ[$wbParsed$, Hold[_]],
    "ERROR:Syntax error in expression",
    (* $wbTO$ is Block-local so it can never collide with a real result *)
    $wbRes$ = TimeConstrained[ReleaseHold[$wbParsed$], ${timeout}, $wbTO$];
    If[$wbRes$ === $wbTO$,
      "ERROR:Evaluation timed out after ${timeout}s",
      $wbGfx$ = !FreeQ[$wbRes$, _Graphics | _Graphics3D | _Graph | _GeoGraphics | _Legended | _Image | _Image3D];
      If[$wbGfx$,
        (* Graphics: try SVG with text-to-outlines, fall back to plain SVG, then PNG *)
        $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None, "ConvertTextToOutlines" -> True]];
        If[!StringQ[$wbSvg$] || !StringContainsQ[$wbSvg$, "<svg"],
          $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None]]];
        If[StringQ[$wbSvg$] && StringContainsQ[$wbSvg$, "<svg"],
          "SVG:" <> $wbSvg$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ],
        (* Non-graphics: With[] injects value past MakeBoxes HoldAllComplete *)
        $wbBoxes$ = Quiet[Check[With[{$wbVal$ = $wbRes$}, ToString[MakeBoxes[$wbVal$, TraditionalForm], InputForm]], $Failed]];
        If[StringQ[$wbBoxes$] && StringLength[$wbBoxes$] > 0,
          "BOXES:" <> $wbBoxes$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ]
      ]
    ]
  ]
]`;
                        devLog(LOG_CHANNELS.SLIDE, '[wslide-eval] Evaluating block', blockId, 'input:', input.slice(0, 80));
                        const evalP = controller.session.evaluate(expr, { interactive: false });
                        const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
                        const evalResult = await Promise.race([evalP, raceTimeout]);

                        // Parse the result — session.evaluate returns {result: {type, value}, messages[]}
                        devLog(LOG_CHANNELS.SLIDE, '[wslide-eval] Raw result type:', evalResult?.result?.type, 'value length:', evalResult?.result?.value?.length ?? 'N/A');
                        if (evalResult?.result?.type === 'abort') {
                            sendResult({ type: 'error', error: 'Evaluation aborted.' });
                            break;
                        }
                        const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
                        devLog(LOG_CHANNELS.SLIDE, '[wslide-eval] resultStr prefix:', resultStr.slice(0, 80));
                        const now = new Date().toLocaleTimeString();

                        if (resultStr.startsWith('SVG:')) {
                            // Decode WSTP octal escapes + un-double backslashes (same as checkout.js)
                            let svg = decodeWstpText(resultStr.slice(4));
                            // Clip to <svg…</svg> boundaries
                            const svgStart = svg.indexOf('<svg');
                            if (svgStart > 0) svg = svg.slice(svgStart);
                            const svgEnd = svg.toLowerCase().lastIndexOf('</svg>');
                            if (svgEnd >= 0) svg = svg.slice(0, svgEnd + 6);
                            svg = svg.replace(/[\n\r]/g, '');
                            // Strip SVG font definitions (Chrome/Electron dropped SVG 1.1 fonts)
                            svg = svg.replace(/<font[\s\S]*?<\/font>/gi, '');
                            svg = svg.replace(/<font-face[\s\S]*?\/>/gi, '');
                            // Map Wolfram font families to browser-safe equivalents
                            svg = svg.replace(/MathematicaMono-Regular/g, '"Courier New", Courier, monospace');
                            svg = svg.replace(/MathematicaSans-Regular/g, 'Arial, Helvetica, sans-serif');
                            svg = svg.replace(/Mathematica1-Bold/g, 'serif');
                            svg = svg.replace(/Mathematica1/g, 'serif');
                            sendResult({ type: 'svg', data: svg, evaluatedAt: now });
                        } else if (resultStr.startsWith('BOXES:')) {
                            // Non-graphics: run through BTL C++ addon → LaTeX → KaTeX pre-render
                            // Decode WSTP octal escapes + un-double backslashes, then encode to
                            // base64 in JS (matches checkout.js; avoids Wolfram ExportString encoding mismatch)
                            const cleanBoxes = decodeWstpText(resultStr.slice(6));
                            const b64boxes = Buffer.from(cleanBoxes).toString('base64');
                            const output = _evalBoxesToKaTeX(this._context, b64boxes, imgW);
                            output.evaluatedAt = now;
                            sendResult(output);
                        } else if (resultStr.startsWith('IMAGE:')) {
                            const b64 = resultStr.slice(6);
                            sendResult({ type: 'image', data: 'data:image/png;base64,' + b64, evaluatedAt: now });
                        } else if (resultStr.startsWith('TEXT:')) {
                            sendResult({ type: 'text', text: resultStr.slice(5), evaluatedAt: now });
                        } else if (resultStr.startsWith('ERROR:')) {
                            sendResult({ type: 'error', error: resultStr.slice(6), evaluatedAt: now });
                        } else {
                            // Unexpected format — show as text
                            sendResult({ type: 'text', text: resultStr, evaluatedAt: now });
                        }
                    } catch (err) {
                        sendResult({ type: 'error', error: err.message || String(err) });
                    }
                    break;
                }
            }
        }, undefined, this._context.subscriptions);

        // ── Sync external edits (e.g. git checkout, direct file edit) ──────
        const onchange = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== docKey) return;
            if (e.contentChanges.length === 0)          return;
            if (entry.saving)                            return; // we caused this
            const newDeck = _parseDeck(e.document.getText());
            entry.deck = newDeck;
            entry._undoStack = []; // external edit clears tool undo history
            const deckToSend = _rewriteDeckImgPaths(
                newDeck,
                path.dirname(document.uri.fsPath),
                webviewPanel.webview
            );
            webviewPanel.webview.postMessage({ cmd: 'deckUpdate', deck: deckToSend });
        });

        webviewPanel.onDidDispose(() => {
            onchange.dispose();
            this._panels.delete(docKey);
        }, null, this._context.subscriptions);
    }

    // ── Build the webview HTML ─────────────────────────────────────────────
    _buildHtml(webview, document) {
        const htmlFile = path.join(this._context.extensionPath, 'media', 'wslide-editor.html');
        let html = fs.readFileSync(htmlFile, 'utf8');
        html = html.replace(/__CSP_SOURCE__/g, webview.cspSource);
        return html;
    }

    // =========================================================================
    // Wolfslide tool API  (called by tools/index.js wolfslide handlers)
    // =========================================================================

    /**
     * Find an open TextDocument for a .wslide file, falling back to any open one.
     * Used when _panels doesn't have the entry (custom editor not yet resolved).
     * Handles URI key mismatches (percent-encoding, different path formats).
     */
    _findTextDoc(docUriStr) {
        const allWslide = vscode.workspace.textDocuments.filter(d => d.uri.fsPath.endsWith('.wslide'));
        if (!docUriStr) return allWslide[0] ?? null;
        // Exact URI string match
        let doc = allWslide.find(d => d.uri.toString() === docUriStr);
        if (doc) return doc;
        // fsPath match — handles percent-encoding differences and file:// vs vscode-file:// schemes
        try {
            const wantPath = vscode.Uri.parse(docUriStr).fsPath;
            doc = allWslide.find(d => d.uri.fsPath === wantPath);
        } catch (_) {}
        return doc ?? null;
    }

    /**
     * Resolve a panel entry, with TextDocument fallback for when the custom
     * editor webview hasn't been resolved yet (e.g. after extension host reload).
     * Returns { e, document } where e may be null if only the TextDoc fallback is available.
     */
    _resolveEntry(docUriStr) {
        // 1. Try exact key match in _panels
        let e = docUriStr ? this._panels.get(docUriStr) : this.getActiveEntry();
        if (e) return { e, document: e.document };
        // 2. URI encoding mismatch: try fsPath match within _panels
        if (docUriStr) {
            try {
                const wantPath = vscode.Uri.parse(docUriStr).fsPath;
                for (const [, entry] of this._panels) {
                    if (entry.document.uri.fsPath === wantPath) return { e: entry, document: entry.document };
                }
            } catch (_) {}
        }
        // 3. TextDocument fallback: custom editor not yet resolved but file is open
        const textDoc = this._findTextDoc(docUriStr);
        return textDoc ? { e: null, document: textDoc } : { e: null, document: null };
    }

    /** Session-scoped task anchor — shown prominently in getContext to keep the model focused. */
    getScope(docUriStr) {
        const { e } = this._resolveEntry(docUriStr);
        return e ? (e._scope || null) : null;
    }
    setScope(docUriStr, scope) {
        const { e } = this._resolveEntry(docUriStr);
        if (e) e._scope = scope || null;
    }

    /** Current deck for the active (or specified) editor. */
    getDeck(docUriStr) {
        const { e, document } = this._resolveEntry(docUriStr);
        if (e) return JSON.parse(JSON.stringify(e.deck));
        // TextDocument fallback: parse the raw JSON from the open file
        return document ? _parseDeck(document.getText()) : null;
    }

    /** Absolute filesystem directory of the .wslide file (or null). */
    getDeckDir(docUriStr) {
        const { e, document } = this._resolveEntry(docUriStr);
        const doc = e ? e.document : document;
        return doc ? path.dirname(doc.uri.fsPath) : null;
    }

    /** Like getDeck but with webview URIs reverted to relative img/ paths (suitable for static export). */
    getDeckOnDisk(docUriStr) {
        const { e, document } = this._resolveEntry(docUriStr);
        const doc = e ? e.document : document;
        if (!doc) return null;
        if (e && e.deck) {
            const deckDir = path.dirname(doc.uri.fsPath);
            return _revertDeckImgPaths(JSON.parse(JSON.stringify(e.deck)), deckDir);
        }
        return document ? _parseDeck(document.getText()) : null;
    }

    /** Replace the deck, save to file, refresh webview (if resolved).
     * opts.skipUndoPush — if true, don't push current state onto the undo stack
     *   (used by undo itself so a redo is not accidentally created). */
    async applyDeck(newDeck, docUriStr, opts) {
        const { e, document } = this._resolveEntry(docUriStr);
        if (!document) throw new Error('No active .wslide editor found');

        if (e) e.saving = true;
        try {
            if (e && !opts?.skipUndoPush) {
                // Push a snapshot of the current deck onto the undo stack (capped at 20)
                e._undoStack = e._undoStack || [];
                e._undoStack.push(JSON.parse(JSON.stringify(e.deck)));
                if (e._undoStack.length > 20) e._undoStack.shift();
            }
            if (e) e.deck = newDeck;
            const text = JSON.stringify(newDeck, (k, v) => k.startsWith('_') ? undefined : v, 2);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                text
            );
            await vscode.workspace.applyEdit(edit);
            await document.save();
            // Send live update to the webview only if it has been resolved
            if (e) {
                const deckForWebview = _rewriteDeckImgPaths(
                    newDeck,
                    path.dirname(document.uri.fsPath),
                    e.webviewPanel.webview
                );
                e.webviewPanel.webview.postMessage({ cmd: 'deckUpdate', deck: deckForWebview, source: 'copilot' });
            }
        } finally {
            if (e) e.saving = false;
        }
    }

    /** Force-reload the deck from the current document text, reset undo stack, and push to webview.
     * Call after external edits or a confusing undo sequence to get a clean state. */
    reloadDeck(docUriStr) {
        const { e, document } = this._resolveEntry(docUriStr);
        if (!e || !document) return null;
        const freshDeck = _parseDeck(document.getText());
        e.deck = freshDeck;
        e._undoStack = [];
        const deckForWebview = _rewriteDeckImgPaths(
            freshDeck,
            path.dirname(document.uri.fsPath),
            e.webviewPanel.webview
        );
        e.webviewPanel.webview.postMessage({ cmd: 'deckUpdate', deck: deckForWebview });
        return freshDeck;
    }

    /** List all open .wslide document URIs (panels + unresolved TextDocuments). */
    listOpenEditors() {
        const inPanels = new Set(this._panels.keys());
        // Also surface any .wslide TextDocuments not yet resolved as custom editors
        const fromTextDocs = vscode.workspace.textDocuments
            .filter(d => d.uri.fsPath.endsWith('.wslide') && !inPanels.has(d.uri.toString()))
            .map(d => d.uri.toString());
        return [...inPanels, ...fromTextDocs];
    }

    /** Request rendered measurements from the webview for a specific slide. */
    async measureSlide(slideIndex, docUriStr) {
        const e = docUriStr ? this._panels.get(docUriStr) : this.getActiveEntry();
        if (!e) throw new Error('No active .wslide editor found');
        if (!this._measurePending) this._measurePending = {};
        if (!this._measureNextId) this._measureNextId = 0;
        const id = ++this._measureNextId;
        return new Promise((resolve, reject) => {
            this._measurePending[id] = resolve;
            e.webviewPanel.webview.postMessage({ cmd: 'measure', id, slideIndex });
            // Timeout after 5s
            setTimeout(() => {
                if (this._measurePending[id]) {
                    delete this._measurePending[id];
                    reject(new Error('Measurement timed out'));
                }
            }, 5000);
        });
    }

    /**
     * Capture the slide as a JPEG image (base64 data URL) using html2canvas in the webview.
     * @param {number} slideIndex  0-based slide index
     * @param {string} [docUriStr] optional docUri to target a specific panel
     * @param {number} [scale]     capture scale (default 0.5 → 960x540 px)
     * @returns {Promise<string>} base64 JPEG data URL, e.g. "data:image/jpeg;base64,..."
     */
    async screenshotSlide(slideIndex, docUriStr, scale) {
        const e = docUriStr ? this._panels.get(docUriStr) : this.getActiveEntry();
        if (!e) throw new Error('No active .wslide editor found');
        if (!this._screenshotPending) this._screenshotPending = {};
        if (!this._screenshotNextId) this._screenshotNextId = 0;
        const id = ++this._screenshotNextId;
        return new Promise((resolve, reject) => {
            this._screenshotPending[id] = (msg) => {
                if (msg.error) reject(new Error(msg.error));
                else resolve(msg.dataUrl);
            };
            e.webviewPanel.webview.postMessage({ cmd: 'screenshot', id, slideIndex, scale: scale || 0.5 });
            // Timeout after 30s (html2canvas may need to load from CDN first)
            setTimeout(() => {
                if (this._screenshotPending[id]) {
                    delete this._screenshotPending[id];
                    reject(new Error('Screenshot timed out'));
                }
            }, 30000);
        });
    }

    /**
     * Ask the webview to serialize every slide with the LIVE renderer (KaTeX +
     * Prism applied, images inlined) and return the DOM + slide CSS. This is the
     * editor's own output, so the export is guaranteed identical to the viewer.
     * @returns {Promise<{slides:{background,hidden,html}[], slideCSS:string, themeVars:string}>}
     */
    async serializeDeck(entry) {
        const e = entry || this.getActiveEntry();
        if (!e) throw new Error('No active .wslide editor found');
        if (!this._serializePending) this._serializePending = {};
        if (!this._serializeNextId) this._serializeNextId = 0;
        const id = ++this._serializeNextId;
        return new Promise((resolve, reject) => {
            this._serializePending[id] = (msg) => {
                if (msg.error) reject(new Error(msg.error));
                else resolve({ slides: msg.slides || [], slideCSS: msg.slideCSS || '', themeVars: msg.themeVars || '' });
            };
            e.webviewPanel.webview.postMessage({ cmd: 'serializeDeck', id });
            setTimeout(() => {
                if (this._serializePending[id]) {
                    delete this._serializePending[id];
                    reject(new Error('Deck serialization timed out'));
                }
            }, 45000);
        });
    }

    /**
     * Build editor-accurate export HTML from the webview's live DOM. Returns the
     * HTML string, or null if serialization fails (caller falls back to the
     * string exporter). slideIndices (0-based into deck.slides) optionally limits
     * the output to a subset, preserving order.
     */
    async _buildSerializedHtml(entry, slideIndices, title, mode) {
        try {
            const exporter = require('./slideExporter');
            const parts = await this.serializeDeck(entry);
            if (!parts || !parts.slides || !parts.slides.length) return null;
            if (Array.isArray(slideIndices)) {
                parts.slides = slideIndices.map(i => parts.slides[i]).filter(Boolean);
                if (!parts.slides.length) return null;
            }
            // 'reveal' → interactive presentation (navigation, fragment animation,
            // per-slide transitions). 'static' → one page per slide (for PDF/print).
            return (mode === 'static')
                ? exporter.assembleSerializedDeck(parts, { title: title || 'Presentation' })
                : exporter.assembleSerializedReveal(parts, { title: title || 'Presentation' });
        } catch (err) {
            console.warn('[wslide] serialized export unavailable, using string exporter:', err && err.message);
            return null;
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _parseDeck(text) {
    try {
        const d = JSON.parse(text || '{}');
        if (!d.slides)         d.slides = [];
        if (!d.meta)           d.meta   = { title: 'Untitled' };
        if (!d.theme)          d.theme  = {};
        if (!d.formatVersion)  d.formatVersion = 2;
        // v3 migration: normalize legacy "elements" array key → "children"
        function _normalizeNode(node) {
            if (!node) return;
            if (Array.isArray(node.elements) && !node.children) {
                node.children = node.elements;
                delete node.elements;
            }
            (node.children || []).forEach(_normalizeNode);
            (node.items    || []).forEach(_normalizeNode);
        }
        d.slides.forEach(s => {
            if (Array.isArray(s.elements) && !s.children) {
                s.children = s.elements;
                delete s.elements;
            }
            (s.children || []).forEach(_normalizeNode);
        });
        if (d.formatVersion < 3) d.formatVersion = 3;
        return d;
    } catch (_) {
        return { formatVersion: 3, meta: { title: 'Untitled' }, theme: {}, slides: [] };
    }
}

function _extMime(ext) {
    const m = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',  '.gif': 'image/gif',
        '.svg': 'image/svg+xml', '.webp': 'image/webp',
    };
    return m[(ext || '').toLowerCase()] || 'application/octet-stream';
}

// ── Image path rewriting ───────────────────────────────────────────────────
// On disk:    src = "img/<deckname>.wslide/<file.png>"  (relative path)
// In webview: src = webview URI (absolute, loadable by the webview)

/** Deep-walk all block src fields in a deck and apply transform fn. */
function _walkDeckSrcs(deck, fn) {
    const d = JSON.parse(JSON.stringify(deck));
    function walkBlock(b) {
        if (!b) return;
        if (typeof b.src === 'string') b.src = fn(b.src);
        (b.children || []).forEach(walkBlock);
        (b.items    || []).forEach(walkBlock);
        (b.elements || []).forEach(walkBlock);
    }
    (d.slides || []).forEach(s => {
        (s.children || s.elements || []).forEach(walkBlock);
    });
    return d;
}
/**
 * Copy image files from srcDeckDir into destDeckDir (if different) and return
 * the slides array with paths rewritten for destDeck.  If destWebview is given,
 * paths are returned as webview URIs; otherwise as relative img/ paths.
 */
function _translateSlideImages(slides, srcDeckDir, srcDeckName, destDeckDir, destDeckName, destWebview) {
    const destPrefix  = `img/${destDeckName}.wslide/`;
    const sameLocation = path.resolve(srcDeckDir) === path.resolve(destDeckDir) && srcDeckName === destDeckName;
    function translateSrc(src) {
        if (!src || !src.startsWith('img/')) return src;
        const m = src.match(/^img\/[^/]+\.wslide\/(.+)$/);
        if (!m) return src;
        const fname = m[1];
        if (!sameLocation) {
            const srcFilePath = path.join(srcDeckDir, src);
            const destImgDir  = path.join(destDeckDir, destPrefix);
            if (fs.existsSync(srcFilePath)) {
                try {
                    fs.mkdirSync(destImgDir, { recursive: true });
                    const destFilePath = path.join(destImgDir, fname);
                    if (!fs.existsSync(destFilePath)) fs.copyFileSync(srcFilePath, destFilePath);
                } catch (_) {}
            }
        }
        if (destWebview) {
            return destWebview.asWebviewUri(vscode.Uri.file(path.join(destDeckDir, destPrefix, fname))).toString();
        }
        return `${destPrefix}${fname}`;
    }
    function walkBlock(b) {
        if (!b) return;
        if (typeof b.src === 'string') b.src = translateSrc(b.src);
        (b.children || []).forEach(walkBlock);
        (b.items    || []).forEach(walkBlock);
        (b.elements || []).forEach(walkBlock);
    }
    const cloned = JSON.parse(JSON.stringify(slides));
    cloned.forEach(s => (s.children || s.elements || []).forEach(walkBlock));
    return cloned;
}
/** Replace relative img/ paths → webview URIs (for sending to webview). */
function _rewriteDeckImgPaths(deck, deckDir, webview) {
    return _walkDeckSrcs(deck, src => {
        if (!src.startsWith('img/')) return src;
        const absPath = path.join(deckDir, src);
        return webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
    });
}

/** Replace webview URIs that are inside the deckDir → relative img/ paths (for saving to disk). */
function _revertDeckImgPaths(deck, deckDir) {
    const deckDirNorm = deckDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    return _walkDeckSrcs(deck, src => {
        const rel = _webviewUriToRelative(src, deckDirNorm);
        return rel || src;
    });
}

/** Extract a relative path from a VS Code webview URI, or return null. */
function _webviewUriToRelative(src, deckDirNormSlash) {
    if (!src || src.startsWith('data:') || !src.includes('vscode')) return null;
    try {
        let fsPath;
        if (src.startsWith('vscode-resource:')) {
            fsPath = decodeURIComponent(src.replace(/^vscode-resource:\/\//, '/').replace(/^vscode-resource:/, ''));
        } else {
            // https://file+.vscode-resource.vscode-cdn.net/path...
            const u = new URL(src);
            fsPath = decodeURIComponent(u.pathname);
            // Windows: /C:/... → remove leading slash
            if (/^\/[A-Za-z]:/.test(fsPath)) fsPath = fsPath.slice(1);
        }
        fsPath = fsPath.replace(/\\/g, '/');
        if (fsPath.startsWith(deckDirNormSlash)) {
            return fsPath.slice(deckDirNormSlash.length);
        }
    } catch (_) {}
    return null;
}

/**
 * Delete image files in img/<deckName>.wslide/ that are not referenced by
 * any block in the deck.  Safe: only touches the specific img sub-folder.
 */
function _pruneUnusedImages(deck, deckDir, deckName) {
    const imgDir = path.join(deckDir, 'img', deckName + '.wslide');
    if (!fs.existsSync(imgDir)) return;

    // Collect all relative src paths used in the deck
    const usedFiles = new Set();
    const prefix = `img/${deckName}.wslide/`;
    function walkBlock(b) {
        if (!b) return;
        if (typeof b.src === 'string' && b.src.startsWith(prefix)) {
            usedFiles.add(b.src.slice(prefix.length));
        }
        (b.children || []).forEach(walkBlock);
        (b.items    || []).forEach(walkBlock);
        (b.elements || []).forEach(walkBlock);
    }
    (deck.slides || []).forEach(s =>
        (s.children || s.elements || []).forEach(walkBlock)
    );

    // Remove files not in usedFiles — but only if they are older than 2 hours.
    // Images created by an in-progress agent run may not yet be referenced;
    // deleting them immediately would break those runs.
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    let pruned = 0;
    for (const f of fs.readdirSync(imgDir)) {
        if (usedFiles.has(f)) continue;
        try {
            const stat = fs.statSync(path.join(imgDir, f));
            if (Date.now() - stat.mtimeMs < TWO_HOURS_MS) continue; // too recent — keep
            fs.unlinkSync(path.join(imgDir, f)); pruned++;
        } catch (_) {}
    }
    if (pruned > 0) {
        console.log(`[wslide] Pruned ${pruned} unused image(s) from ${imgDir}`);
    }
}

module.exports = { SlideEditorProvider };
