'use strict';
/**
 * askSpecialistPanel.js
 *
 * WebviewViewProvider for the "Ask Specialist" panel in the Wolfbook Debugger sidebar.
 * Agents call AskSpecialistTool → panel.ask(question, context) which renders the
 * question in Markdown + KaTeX, plays an attention beep, blinks the background, and
 * blocks until the user types a reply and clicks "Send Reply" (or Ctrl+Enter).
 *
 * Communication:
 *   Extension → Webview:  { command: 'ask',   html: string }
 *   Extension → Webview:  { command: 'clear' }
 *   Webview  → Extension: { command: 'reply',   text: string }
 *   Webview  → Extension: { command: 'dismiss' }
 */

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

const VIEW_ID = 'wolfbook.askSpecialist';

// ---------------------------------------------------------------------------
// Markdown + KaTeX server-side renderer
// ---------------------------------------------------------------------------

// Lazy-load marked (sync) from the extension's node_modules.
function _getMarked() {
    try {
        return require(path.join(__dirname, '../../../node_modules/marked'));
    } catch (_) {
        return null;
    }
}

// Lazy-load prerenderLatex from the wllatex addon.
function _getKatex() {
    try {
        return require(path.join(__dirname, '../../../wllatex-addon/katexPrerender'));
    } catch (_) {
        return null;
    }
}

/**
 * escapeHtml — minimal escape for text that won't be KaTeX/marked processed.
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * renderMarkdownKatex — convert a markdown string with embedded LaTeX to HTML.
 *
 * Strategy:
 *  1. Extract all $$…$$ (display) and $…$ (inline) math spans, replace with
 *     unique placeholders so markdown parsers don't mangle them.
 *  2. Run marked.parse() for markdown → HTML.
 *  3. Replace placeholders with KaTeX-rendered HTML.
 */
function renderMarkdownKatex(text) {
    const marked       = _getMarked();
    const katexModule  = _getKatex();
    const prerenderLatex = katexModule ? katexModule.prerenderLatex : null;

    // ── Step 1: extract math ──────────────────────────────────────────────
    const mathStore = [];  // [{latex, display}]
    function storeMath(latex, display) {
        const id = `\x00MATH${mathStore.length}\x00`;
        mathStore.push({ latex, display });
        return id;
    }

    // Replace $$...$$  (display math) first, then $...$ (inline)
    let processed = text
        // Display math: $$...$$  (non-greedy, multi-line)
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => storeMath(latex, true))
        // Inline math: $...$  (single-line, non-greedy, require non-empty)
        .replace(/\$([^$\n]+?)\$/g, (_, latex) => storeMath(latex, false));

    // ── Step 2: markdown → HTML ───────────────────────────────────────────
    let html;
    if (marked) {
        try {
            // marked v5+: marked.parse() is synchronous when no async option
            const parseResult = marked.parse ? marked.parse(processed) : marked(processed);
            html = typeof parseResult === 'string' ? parseResult : String(parseResult);
        } catch (_) {
            // Fallback: simple paragraph wrapping
            html = processed.split(/\n\n+/).map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
        }
    } else {
        // No marked: basic paragraph + bold/italic conversion
        html = processed
            .split(/\n\n+/)
            .map(p => {
                let chunk = escapeHtml(p)
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.+?)\*/g, '<em>$1</em>')
                    .replace(/`(.+?)`/g, '<code>$1</code>');
                return `<p>${chunk}</p>`;
            })
            .join('\n');
    }

    // ── Step 3: restore math ──────────────────────────────────────────────
    html = html.replace(/\x00MATH(\d+)\x00/g, (_, idx) => {
        const { latex, display } = mathStore[parseInt(idx, 10)];
        if (prerenderLatex) {
            try {
                return prerenderLatex(latex, display);
            } catch (_) {
                return `<span class="math-error">[LaTeX error: ${escapeHtml(latex)}]</span>`;
            }
        }
        // KaTeX not available — show raw LaTeX
        return display
            ? `<pre class="math-raw">$$${escapeHtml(latex)}$$</pre>`
            : `<code class="math-raw">$${escapeHtml(latex)}$</code>`;
    });

    return html;
}

// ---------------------------------------------------------------------------
// AskSpecialistPanel  (WebviewViewProvider)
// ---------------------------------------------------------------------------

class AskSpecialistPanel {
    constructor() {
        this._view    = null;       // vscode.WebviewView | null
        this._pending = null;       // { resolve: (text: string) => void } | null
        this._lastHtml = null;      // last question HTML, re-sent on panel show
    }

    /** Called by VS Code when the webview view is first opened / focused. */
    resolveWebviewView(webviewView /*, _context, _token */) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(__dirname)),                              // webview JS lives here
                vscode.Uri.file(path.join(__dirname, '../../../wllatex-addon')),    // KaTeX CSS + fonts
            ],
        };

        webviewView.webview.html = this._buildHtml(webviewView);

        // Re-send pending question whenever the panel becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this._lastHtml) {
                webviewView.webview.postMessage({ command: 'ask', html: this._lastHtml });
            }
        });

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(msg => {
            if (!this._pending) return;
            if (msg.command === 'reply' || msg.command === 'dismiss') {
                const resolve = this._pending.resolve;
                this._pending  = null;
                this._lastHtml = null;
                resolve(msg.command === 'reply' ? (msg.text || '') : '');
            }
        });

        // If there is already a pending question (ask() was called before the panel loaded),
        // send it now.
        if (this._lastHtml) {
            setImmediate(() => {
                webviewView.webview.postMessage({ command: 'ask', html: this._lastHtml });
            });
        }
    }

    /**
     * ask(questionMd, contextMd)
     *   Renders question (and optional context) markdown+LaTeX, sends it to the
     *   webview panel, and returns a Promise that resolves with the user's reply
     *   text (or '' if dismissed).
     */
    ask(questionMd, contextMd) {
        return new Promise(resolve => {
            // Cancel any previous pending promise
            if (this._pending) {
                this._pending.resolve('');
            }
            this._pending = { resolve };

            const fullMd = contextMd
                ? `**Context:** ${contextMd}\n\n---\n\n${questionMd}`
                : questionMd;

            this._lastHtml = renderMarkdownKatex(fullMd);

            if (this._view?.webview) {
                this._view.webview.postMessage({ command: 'ask', html: this._lastHtml });
            }
            // If _view is not yet set (panel not opened yet), the question will be
            // sent in resolveWebviewView / onDidChangeVisibility.
        });
    }

    // ──────────────────────────────────────────────────────────────────────
    // HTML builder
    // ──────────────────────────────────────────────────────────────────────
    _buildHtml(webviewView) {
        const webview   = webviewView.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'askSpecialistPanel.webview.js'))
        );

        // Inline KaTeX CSS with fonts embedded as base64 data-URIs
        const _katexBase = (() => {
            const primary  = path.join(__dirname, '../../../node_modules/katex/dist');
            const fallback = path.join(__dirname, '../../../wllatex-addon/node_modules/katex/dist');
            return fs.existsSync(path.join(primary, 'katex.min.css')) ? primary : fallback;
        })();
        const katexCssPath  = path.join(_katexBase, 'katex.min.css');
        const katexFontsDir = path.join(_katexBase, 'fonts');
        let katexCssInline = '';
        try {
            katexCssInline = fs.readFileSync(katexCssPath, 'utf8')
                .replace(/url\(fonts\/([^)]+)\)/g, (match, fontFile) => {
                    try {
                        const buf  = fs.readFileSync(path.join(katexFontsDir, fontFile));
                        const ext  = path.extname(fontFile).toLowerCase();
                        const mime = ext === '.woff2' ? 'font/woff2'
                                   : ext === '.woff'  ? 'font/woff'
                                   : 'font/ttf';
                        return `url(data:${mime};base64,${buf.toString('base64')})`;
                    } catch (_) { return match; }
                });
        } catch (_) { /* KaTeX CSS not available */ }

        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline' ${webview.cspSource}`,
            `font-src ${webview.cspSource} data:`,
            `script-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data: https:`,
        ].join('; ');

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${katexCssInline}</style>
<style>
  /* ── KaTeX overrides ──────────────────────────────────────────────── */
  .katex-display { text-align: left !important; margin: 0.4em 0 !important; }
  .katex-mathml  { display: none !important; }
  .katex svg        { fill: currentColor; stroke: currentColor; }
  .katex svg path   { stroke: none; }

  /* ── Base ─────────────────────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-panel-background, var(--vscode-editor-background)));
    padding: 8px 10px;
    margin: 0;
  }

  /* ── Standby ──────────────────────────────────────────────────────── */
  #standby {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 0.88em;
    padding: 6px 0;
  }

  /* ── Question area ────────────────────────────────────────────────── */
  #question-area { display: none; }

  /* Blink wrapper — JS toggles .blink-on class every 600ms */
  #blink-wrapper {
    padding: 8px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-contrastBorder, transparent);
    background: var(--vscode-sideBar-background, transparent);
    transition: background 0.2s ease;
    margin-bottom: 10px;
  }
  #blink-wrapper.blink-on {
    background: color-mix(in srgb,
      var(--vscode-notificationsWarningIcon-foreground, #f5a623) 18%,
      var(--vscode-sideBar-background, transparent));
    border-color: var(--vscode-notificationsWarningIcon-foreground, #f5a623);
  }

  /* Section label */
  .section-label {
    font-size: 0.78em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--vscode-notificationsWarningIcon-foreground, #e8a34a);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .section-label::before {
    content: '🔔';
    font-style: normal;
    font-size: 1.1em;
  }

  /* Question content */
  #question-html {
    line-height: 1.55;
  }
  #question-html p         { margin: 0.3em 0; }
  #question-html h1,
  #question-html h2,
  #question-html h3        { margin: 0.5em 0 0.3em; }
  #question-html code      { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.93em; background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.12)); padding: 0 3px; border-radius: 2px; }
  #question-html pre       { background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.12)); padding: 6px 8px; border-radius: 3px; overflow: auto; }
  #question-html hr        { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
  #question-html strong    { font-weight: 600; }
  #question-html ul,
  #question-html ol        { padding-left: 1.4em; margin: 0.3em 0; }
  .math-error              { color: var(--vscode-errorForeground, #cc0000); font-size: 0.88em; }
  .math-raw                { font-family: monospace; font-size: 0.88em; color: var(--vscode-descriptionForeground); }

  /* ── Reply textarea ──────────────────────────────────────────────── */
  #reply-label {
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  #reply-input {
    width: 100%;
    min-height: 80px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
    padding: 5px 7px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    resize: vertical;
    border-radius: 2px;
    display: block;
    margin-bottom: 8px;
  }
  #reply-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }

  /* ── Buttons ─────────────────────────────────────────────────────── */
  #buttons { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    border: none;
    padding: 4px 12px;
    cursor: pointer;
    font-size: 0.92em;
    border-radius: 2px;
    font-family: var(--vscode-font-family);
  }
  #submit-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-weight: 600;
  }
  #submit-btn:hover { background: var(--vscode-button-hoverBackground); }
  #dismiss-btn {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-descriptionForeground));
  }
  #dismiss-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }

  .hint {
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    margin-top: 5px;
  }
</style>
</head>
<body>
  <div id="standby">Agent will post a question here when specialist input is needed.</div>

  <div id="question-area">
    <div class="section-label">Agent needs your input</div>
    <div id="blink-wrapper">
      <div id="question-html"></div>
    </div>
    <div id="reply-label">Your reply:</div>
    <textarea id="reply-input" placeholder="Type your answer here…" rows="4"></textarea>
    <div id="buttons">
      <button id="submit-btn">Send Reply</button>
      <button id="dismiss-btn">Dismiss</button>
    </div>
    <div class="hint">Ctrl+Enter (or Cmd+Enter) to submit quickly.</div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}

module.exports = { AskSpecialistPanel, VIEW_ID };
