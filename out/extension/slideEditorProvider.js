'use strict';
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const { decodeWstpText } = require('./utils/encoding');

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
        console.log('[wslide-eval] BTL → LaTeX length:', latex.length, 'KaTeX HTML length:', html.length);
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
        try { fs.writeFileSync(tmpHtml, html, 'utf8'); } catch (e) { reject(e); return; }

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
            `--print-to-pdf=${outPath}`,
            `file://${tmpHtml}`,
        ];

        execFile(chrome, args, { timeout: 60000 }, (err, stdout, stderr) => {
            fs.unlink(tmpHtml, () => {});  // clean up temp file
            if (err) { reject(new Error(`Chrome PDF render failed: ${stderr || err.message}`)); return; }
            if (!fs.existsSync(outPath)) { reject(new Error('Chrome ran but did not produce a PDF file.')); return; }
            resolve();
        });
    });
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
        const entry = { deck, webviewPanel, document, saving: false };
        this._panels.set(docKey, entry);

        webviewPanel.webview.html = this._buildHtml(webviewPanel.webview, document);

        const deckName = path.basename(document.uri.fsPath, '.wslide');

        // ── Receive messages from the webview ──────────────────────────────
        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.cmd) {

                case 'ready': {
                    const deckToSend = _rewriteDeckImgPaths(
                        entry.deck,
                        path.dirname(document.uri.fsPath),
                        webviewPanel.webview
                    );
                    webviewPanel.webview.postMessage({
                        cmd: 'init',
                        deck: deckToSend,
                        deckName,
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

                        // Copy image folder if it exists, rewriting src paths
                        const srcImgDir  = path.join(srcDir,  'img', deckName  + '.wslide');
                        const destImgDir = path.join(destDir, 'img', newDeckName + '.wslide');
                        if (fs.existsSync(srcImgDir)) {
                            fs.mkdirSync(destImgDir, { recursive: true });
                            for (const f of fs.readdirSync(srcImgDir)) {
                                fs.copyFileSync(
                                    path.join(srcImgDir, f),
                                    path.join(destImgDir, f)
                                );
                            }
                            // Rewrite src references: img/<oldName>.wslide/ → img/<newName>.wslide/
                            const oldPrefix = `img/${deckName}.wslide/`;
                            const newPrefix = `img/${newDeckName}.wslide/`;
                            function rewriteSrcs(b) {
                                if (!b) return;
                                if (typeof b.src === 'string' && b.src.startsWith(oldPrefix)) {
                                    b.src = newPrefix + b.src.slice(oldPrefix.length);
                                }
                                (b.children || []).forEach(rewriteSrcs);
                                (b.items    || []).forEach(rewriteSrcs);
                            }
                            (newDeck.slides || []).forEach(s =>
                                (s.children || s.elements || []).forEach(rewriteSrcs)
                            );
                        }

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

                case 'upload': {
                    // Save images to img/<deckName>.wslide/ next to the .wslide file
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
                        const html = exporter.exportDeck(entry.deck);
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
                        const html = exporter.exportDeckPdf(entry.deck, path.dirname(document.uri.fsPath));
                        const defaultUri = vscode.Uri.file(
                            path.join(path.dirname(document.uri.fsPath), deckName + '.pdf')
                        );
                        const saveUri = await vscode.window.showSaveDialog({
                            defaultUri,
                            filters: { 'PDF Presentation': ['pdf'] },
                            title: 'Export Slides as PDF (one page per animation step)',
                        });
                        if (saveUri) {
                            await vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: 'Exporting PDF…',
                                cancellable: false
                            }, async () => {
                                await _exportHtmlToPdf(html, saveUri.fsPath);
                            });
                            vscode.window.showInformationMessage(`PDF exported: ${path.basename(saveUri.fsPath)}`);
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`PDF export failed: ${err.message}`);
                    }
                    break;
                }

                case 'measureResult': {
                    if (msg.id && this._measurePending && this._measurePending[msg.id]) {
                        this._measurePending[msg.id](msg.result);
                        delete this._measurePending[msg.id];
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
                            console.log('[wslide-ext] restoring zenMode.centerLayout to', restoreVal);
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
                        console.log('[wslide-eval] Evaluating block', blockId, 'input:', input.slice(0, 80));
                        const evalP = controller.session.evaluate(expr, { interactive: false });
                        const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
                        const evalResult = await Promise.race([evalP, raceTimeout]);

                        // Parse the result — session.evaluate returns {result: {type, value}, messages[]}
                        console.log('[wslide-eval] Raw result type:', evalResult?.result?.type, 'value length:', evalResult?.result?.value?.length ?? 'N/A');
                        if (evalResult?.result?.type === 'abort') {
                            sendResult({ type: 'error', error: 'Evaluation aborted.' });
                            break;
                        }
                        const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
                        console.log('[wslide-eval] resultStr prefix:', resultStr.slice(0, 80));
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

    /** Current deck for the active (or specified) editor. */
    getDeck(docUriStr) {
        const e = docUriStr ? this._panels.get(docUriStr) : this.getActiveEntry();
        return e ? JSON.parse(JSON.stringify(e.deck)) : null;
    }

    /** Replace the deck, save to file, refresh webview. */
    async applyDeck(newDeck, docUriStr) {
        const e = docUriStr ? this._panels.get(docUriStr) : this.getActiveEntry();
        if (!e) throw new Error('No active .wslide editor found');

        e.saving = true;
        try {
            e.deck = newDeck;
            const text = JSON.stringify(newDeck, (k, v) => k.startsWith('_') ? undefined : v, 2);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                e.document.uri,
                new vscode.Range(0, 0, e.document.lineCount, 0),
                text
            );
            await vscode.workspace.applyEdit(edit);
            await e.document.save();
            // Rewrite img/ paths → webview URIs before sending to the webview,
            // otherwise images appear as "not found" when the AI edits slides.
            const deckForWebview = _rewriteDeckImgPaths(
                newDeck,
                path.dirname(e.document.uri.fsPath),
                e.webviewPanel.webview
            );
            e.webviewPanel.webview.postMessage({ cmd: 'deckUpdate', deck: deckForWebview, source: 'copilot' });
        } finally {
            e.saving = false;
        }
    }

    /** List all open .wslide document URIs. */
    listOpenEditors() {
        return [...this._panels.keys()];
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
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _parseDeck(text) {
    try {
        const d = JSON.parse(text || '{}');
        if (!d.slides)         d.slides = [];
        if (!d.meta)           d.meta   = { title: 'Untitled' };
        if (!d.theme)          d.theme  = {};
        if (!d.formatVersion)  d.formatVersion = 2;
        return d;
    } catch (_) {
        return { formatVersion: 2, meta: { title: 'Untitled' }, theme: {}, slides: [] };
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

    // Remove files not in usedFiles
    let pruned = 0;
    for (const f of fs.readdirSync(imgDir)) {
        if (!usedFiles.has(f)) {
            try { fs.unlinkSync(path.join(imgDir, f)); pruned++; } catch (_) {}
        }
    }
    if (pruned > 0) {
        console.log(`[wslide] Pruned ${pruned} unused image(s) from ${imgDir}`);
    }
}

module.exports = { SlideEditorProvider };
