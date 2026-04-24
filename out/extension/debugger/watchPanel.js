'use strict';
/**
 * watchPanel.js  —  Stage 6
 *
 * WebviewViewProvider for the "Wolfbook Watch" panel in the Run & Debug sidebar.
 * Shows live debug state: current step header, iterator vars, and user watch list.
 *
 * Communication:
 *   Extension → Webview:  { command: 'update', stepInfo, variables, timing }
 *   Extension → Webview:  { command: 'clear' }
 *   Webview  → Extension: { command: 'addWatch',    name }
 *   Webview  → Extension: { command: 'removeWatch', name }
 */
const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const { scrollLog } = require('../utils/dev-logger');

const VIEW_ID = 'wolfbook.watchPanel';

class WatchPanelProvider {
    constructor() {
        this._view           = null;   // vscode.WebviewView | null
        this._watchList      = [];     // string[]  — user-added variable names
        this._onAddWatch     = null;   // callback(name)
        this._onRemoveWatch  = null;   // callback(name)
        this._onRefresh      = null;   // callback() — refresh button
        this._onBecomeVisible = null;   // callback() — panel expanded/shown
        this._onDebugCommand = null;   // callback(action) — debug control button clicked
        this._onRemoveBp     = null;   // callback(uri, line)
        this._onClearAllBps  = null;   // callback()
        this._onOpenInEditor = null;   // callback(name, fullVal)
        this._debugActive    = false;  // tracks whether a debug session is active
        this._lastBpList     = [];     // cached breakpoint list for resend on visibility
        this._lastEvalSel    = null;   // cached eval-selection state {type,html,expr,format} for resend
        this._bgColor        = null;   // hex color, or null = use sidebar default
        this._pendingHoverDoc = null;  // {html, symbol} — resent on next visibility
        this._widthPx        = 0;     // panel pixel width reported by webview ResizeObserver
        this._mcpInfo        = null;  // last setMcpInfo payload — resent on visibility change
    }

    // Called by extension.js when registering:
    //   vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } })
    resolveWebviewView(webviewView /*, _context, _token */) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(__dirname),                                          // watchPanel.webview.js lives here
                vscode.Uri.file(path.join(__dirname, '../../../wllatex-addon')),      // katex CSS + fonts
                vscode.Uri.file(require('os').tmpdir()),                             // eval-sel tmp images
                ...(vscode.workspace.workspaceFolders || []).map(f => f.uri),        // notebook images
            ],
        };
        webviewView.webview.html   = this._buildHtml(webviewView);

        // Re-send accumulated state whenever the panel becomes visible
        // (first open, or re-shown after being hidden). This fixes the race
        // where postMessage was called before the webview had loaded.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._sendCurrentState();
                if (this._pendingHoverDoc) {
                    webviewView.webview.postMessage({ command: 'hoverDoc', ...this._pendingHoverDoc });
                }
                if (this._onBecomeVisible) this._onBecomeVisible();
            }
        });
        // Also send immediately — the panel may already be visible now.
        // Use setImmediate so the webview JS has time to load first.
        setImmediate(() => this._sendCurrentState());

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'addWatch' && msg.name) {
                const name = String(msg.name).trim();
                if (name && !this._watchList.includes(name)) {
                    this._watchList.push(name);
                    if (this._onAddWatch) this._onAddWatch(name);
                }
            } else if (msg.command === 'removeWatch' && msg.name) {
                const idx = this._watchList.indexOf(msg.name);
                if (idx !== -1) {
                    this._watchList.splice(idx, 1);
                    if (this._onRemoveWatch) this._onRemoveWatch(msg.name);
                }
            } else if (msg.command === 'refresh') {
                if (this._onRefresh) this._onRefresh();
            } else if (msg.command === 'debugCommand' && msg.action) {
                if (this._onDebugCommand) this._onDebugCommand(msg.action);
            } else if (msg.command === 'removeBreakpoint' && msg.uri != null && msg.line != null) {
                if (this._onRemoveBp) this._onRemoveBp(msg.uri, msg.line);
            } else if (msg.command === 'clearBreakpoints') {
                if (this._onClearAllBps) this._onClearAllBps();
            } else if (msg.command === 'openInEditor' && msg.name) {
                if (this._onOpenInEditor) this._onOpenInEditor(msg.name, msg.fullVal ?? '');
            } else if (msg.command === 'evalSelClear') {
                this._lastEvalSel = null;
            } else if (msg.command === 'openEvalSelFull') {
                const fp = this._lastEvalSel?.openFilePath;
                if (fp) {
                    vscode.workspace.openTextDocument(vscode.Uri.file(fp))
                        .then(doc => vscode.window.showTextDocument(doc, { preview: false }));
                }
            } else if (msg.command === 'openFile' && msg.path) {
                vscode.workspace.openTextDocument(vscode.Uri.file(msg.path))
                    .then(doc => vscode.window.showTextDocument(doc, { preview: false }));
            } else if (msg.command === 'panelWidth' && msg.widthPx > 0) {
                this._widthPx = msg.widthPx;
            } else if (msg.command === 'scriptLoaded') {
                console.log('[wolfbook-watch] ✓ webview script loaded and running');
            } else if (msg.command === 'hoverDocReceived') {
                console.log('[wolfbook-watch] ✓ webview confirmed hoverDoc received for:', msg.symbol);
                this._pendingHoverDoc = null;
            } else if (msg.command === 'mcpToggle') {
                const configCompat = require('../config-compat');
                const newState = !!msg.enabled;
                vscode.workspace.getConfiguration('wolfbook').update('mcpEnabled', newState, vscode.ConfigurationTarget.Workspace).then(async () => {
                    const label = newState ? 'enabled' : 'disabled';
                    const action = await vscode.window.showWarningMessage(
                        `MCP Server ${label}. Reload the window to apply this change.`,
                        'Reload Now'
                    );
                    if (action === 'Reload Now') {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } else if (msg.command === 'collabToggle') {
                const newState = !!msg.enabled;
                console.log('[wolfbook-collab] received collabToggle, newState=' + newState);
                // Update config immediately (fire-and-forget — don't gate split on it)
                vscode.workspace.getConfiguration('wolfbook').update('collabMode', newState, vscode.ConfigurationTarget.Workspace);
                if (newState) {
                    // Open a right-column split.
                    (async () => {
                        try {
                            const visEds = vscode.window.visibleNotebookEditors;
                            console.log('[wolfbook-collab] visibleNotebookEditors count=' + visEds.length);
                            visEds.forEach((ed, i) => {
                                console.log('[wolfbook-collab]   editor[' + i + '] viewColumn=' + ed.viewColumn + ' uri=' + ed.notebook?.uri?.toString());
                            });
                            const sorted = [...visEds].sort((a, b) => (a.viewColumn || 99) - (b.viewColumn || 99));
                            let primaryNb = sorted[0]?.notebook;
                            if (!primaryNb) {
                                const nbDocs = vscode.workspace.notebookDocuments || [];
                                console.log('[wolfbook-collab] no visible notebook editors, notebookDocuments count=' + nbDocs.length);
                                primaryNb = nbDocs[0];
                            }
                            if (!primaryNb) {
                                console.log('[wolfbook-collab] ABORT: no notebook found at all');
                                vscode.window.showWarningMessage('Wolfbook Collab: no open notebook found — open a .wb notebook first.');
                                return;
                            }
                            console.log('[wolfbook-collab] primaryNb=' + primaryNb.uri?.toString());
                            // Already split?
                            const editorsForNb = visEds.filter(ed =>
                                ed.notebook.uri.toString() === primaryNb.uri.toString()
                            );
                            console.log('[wolfbook-collab] editorsForNb count=' + editorsForNb.length);
                            if (editorsForNb.length >= 2) {
                                console.log('[wolfbook-collab] already split, skipping');
                                return;
                            }
                            console.log('[wolfbook-collab] calling showNotebookDocument with ViewColumn.Two (' + vscode.ViewColumn.Two + ')');
                            const result = await vscode.window.showNotebookDocument(primaryNb, {
                                viewColumn: vscode.ViewColumn.Two,
                                preserveFocus: true,
                            });
                            console.log('[wolfbook-collab] showNotebookDocument returned, result viewColumn=' + result?.viewColumn);
                        } catch (e) {
                            console.error('[wolfbook-collab] ERROR in split opening:', e);
                            vscode.window.showWarningMessage(`Wolfbook Collab: could not open split — ${e?.message || e}`);
                        }
                    })();
                }
            } else if (msg.command === 'runVSCodeCommand' && msg.id) {
                vscode.commands.executeCommand(msg.id).then(undefined, e => {
                    vscode.window.showErrorMessage(`Command ${msg.id} failed: ${e?.message || e}`);
                });
            } else {
                console.log('[wolfbook-watch] unhandled webview msg:', JSON.stringify(msg));
            }
        });
    }

    /** Returns the panel width in raw pixels, or 0 if unknown. */
    getWidthPx() { return this._widthPx; }

    /** Post a state update to the webview. Called after each Dialog[] pause. */
    update(stepInfo, variables, timing) {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'update', stepInfo, variables, timing });
    }

    /** Clear the panel (debug session ended) — switches to live watch mode. */
    clear() {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'clear' });
    }

    /** Post a live (non-debug) variable update to the webview. */
    liveUpdate(variables) {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'liveUpdate', variables });
    }

    /** Get the current watch list (for use by DebugController). */
    getWatchList() { return [...this._watchList]; }

    /** Programmatically add a name from extension code (e.g. Cmd+Shift+W).
     *  Returns true if added, false if already in list or invalid. */
    addWatchExternal(name) {
        if (!name || this._watchList.includes(name)) return false;
        this._watchList.push(name);
        if (this._view) {
            this._view.webview.postMessage({ command: 'initWatchList', names: this._watchList });
        }
        if (this._onAddWatch) this._onAddWatch(name);
        return true;
    }

    /** Replace the watch list (e.g. restored from notebook metadata).
     *  Immediately sends names to webview as placeholders until liveUpdate arrives. */
    setWatchList(list) {
        this._watchList = Array.isArray(list) ? [...list] : [];
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'initWatchList', names: this._watchList });
    }

    setOnOpenInEditor(cb) { this._onOpenInEditor = cb || null; }
    setOnBecomeVisible(cb) { this._onBecomeVisible = cb || null; }

    setCallbacks(onAdd, onRemove, onRefresh, onDebugCommand, onRemoveBp, onClearAllBps) {
        this._onAddWatch     = onAdd;
        this._onRemoveWatch  = onRemove;
        this._onRefresh      = onRefresh || null;
        this._onDebugCommand = onDebugCommand || null;
        this._onRemoveBp     = onRemoveBp || null;
        this._onClearAllBps  = onClearAllBps || null;
    }

    /** Notify the webview whether a debug session is active (enables/disables buttons). */
    setDebugActive(active) {
        this._debugActive = active;
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'setDebugActive', active });
    }

    /** Push MCP server info to the sidebar info popup (called from extension.js after server starts). */
    setMcpInfo(info) {
        this._mcpInfo = info || null;
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'mcpInfo', ...this._mcpInfo });
    }

    /** Update the panel background to match the active notebook (or clear it). */
    setBackground(color) {
        this._bgColor = color || null;
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'setBackground', color: this._bgColor });
    }

    /** Re-send current accumulated state to the webview (called on visibility change). */
    _sendCurrentState() {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'setBackground', color: this._bgColor });
        this._view.webview.postMessage({ command: 'setDebugActive', active: this._debugActive });
        // Send MCP and Collab enabled state
        const configCompat = require('../config-compat');
        const mcpEnabled = configCompat.getSetting('mcpEnabled', true);
        this._view.webview.postMessage({ command: 'mcpState', enabled: mcpEnabled });
        if (this._mcpInfo) this._view.webview.postMessage({ command: 'mcpInfo', ...this._mcpInfo });
        const collabEnabled = vscode.workspace.getConfiguration('wolfbook').get('collabMode', false);
        this._view.webview.postMessage({ command: 'collabState', enabled: collabEnabled });
        // Show watch list placeholder names immediately (before kernel values arrive)
        if (this._watchList.length > 0) {
            this._view.webview.postMessage({ command: 'initWatchList', names: this._watchList });
        }
        // Trigger a live watch refresh so watch list variables appear
        if (!this._debugActive && this._onRefresh) this._onRefresh();
        // Re-send cached breakpoints list
        if (this._lastBpList.length > 0) {
            this._view.webview.postMessage({ command: 'updateBreakpoints', breakpoints: this._lastBpList });
        }
        // Re-send cached eval-selection state
        if (this._lastEvalSel) {
            const es = this._lastEvalSel;
            if (es.type === 'result') {
                // Re-apply URI conversion now that _view is available
                let html = es.rawHtml || '';
                if (es.notebookDir) {
                    const webview = this._view.webview;
                    html = html.replace(/src="((?!data:|https?:|vscode)[^"]+)"/g, (_m, relPath) => {
                        const absPath = path.join(es.notebookDir, relPath);
                        const uri = webview.asWebviewUri(vscode.Uri.file(absPath));
                        return 'src="' + uri + '"';
                    });
                }
                this._view.webview.postMessage({ command: 'evalSelUpdate', html, expr: es.expr, format: es.format, hasOpen: !!es.openFilePath });
            }
            if (es.type === 'spinner') this._view.webview.postMessage({ command: 'evalSelSpinner',  expr: es.expr });
            if (es.type === 'error')   this._view.webview.postMessage({ command: 'evalSelError',    msg: es.msg, expr: es.expr });
        }
    }

    /** Push breakpoints list to the webview panel. */
    updateBreakpoints(bpList) {
        this._lastBpList = bpList || [];
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'updateBreakpoints', breakpoints: this._lastBpList });
    }

    /** Returns true when the panel webview is currently visible (not collapsed). */
    get isVisible() { return !!(this._view && this._view.visible); }

    /** Send a log line to the panel's log tail. */
    log(text) {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'log', text });
    }

    // ── Eval Selection ───────────────────────────────────────────────────

    /** Convert Markdown (from LSP hover) to safe HTML for display in the webview. */
    static _mdToHtml(md) {
        // Unescape Markdown backslash-escapes (e.g. \[ → [, \_ → _)
        let s = md.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');
        // HTML-encode
        s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Fenced code blocks
        s = s.replace(/```\w*\n?([\s\S]*?)```/g, (_, code) =>
            `<pre>${code.trimEnd()}</pre>`);
        // Inline code
        s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        // Bold
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        // Italic *text* — use [A-Za-z0-9] boundary (not \w) so _ adjacent to * still matches
        s = s.replace(/(?<![A-Za-z0-9])\*([^*\n]+)\*(?![A-Za-z0-9])/g, '<em>$1</em>');
        // Italic _text_ — only at word boundaries so i_max stays plain
        s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
        // Links
        s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,
            '<a href="$2">$1</a>');
        // Horizontal rule
        s = s.replace(/^[ \t]*---+[ \t]*$/gm,
            '<hr>');
        // Paragraphs
        return s.split(/\n{2,}/).map(p => {
            p = p.trim();
            if (!p) return '';
            if (p.startsWith('<pre') || p.startsWith('<hr')) return p;
            return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
        }).filter(Boolean).join('');
    }

    /** Show hover documentation in the panel (Markdown converted to HTML here in Node.js). */
    showHoverDoc(markdown, symbol) {
        if (!this._view) return;
        const html = WatchPanelProvider._mdToHtml(markdown);
        this._pendingHoverDoc = { html, symbol: symbol || '' };
        this._view.webview.postMessage({ command: 'hoverDoc', html, symbol: symbol || '' });
    }

    /** Show eval-selection result HTML in the panel. */
    evalSelUpdate(html, expr, format, notebookDir, openFilePath) {
        // If no pre-made file path, write the HTML now so the Open button always works.
        let savedPath = openFilePath || null;
        if (!savedPath) {
            const tf = path.join(require('os').tmpdir(), 'wolfbook_evalsel_view_' + Date.now() + '.html');
            try {
                fs.writeFileSync(tf,
                    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
                    '<body style="padding:12px;font-family:sans-serif">' + html + '</body></html>');
                savedPath = tf;
            } catch(_) {}
        }
        // Cache BEFORE view check — so state is replayed when the panel opens
        this._lastEvalSel = { type: 'result', rawHtml: html, expr, format, notebookDir, openFilePath: savedPath };
        scrollLog('[watch] evalSelUpdate called | _view:', !!this._view, '| html len:', html?.length);
        if (!this._view) return;
        // Convert relative image paths to webview URIs
        if (notebookDir) {
            const webview = this._view.webview;
            html = html.replace(/src="((?!data:|https?:|vscode)[^"]+)"/g, (_m, relPath) => {
                const absPath = path.join(notebookDir, relPath);
                const uri = webview.asWebviewUri(vscode.Uri.file(absPath));
                return 'src="' + uri + '"';
            });
        }
        this._view.webview.postMessage({ command: 'evalSelUpdate', html, expr, format, hasOpen: !!savedPath });
    }

    /** Show eval-selection spinner. */
    evalSelSpinner(expr) {
        // Cache BEFORE view check — so spinner is shown when panel eventually opens
        this._lastEvalSel = { type: 'spinner', expr };
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'evalSelSpinner', expr });
    }

    /** Show eval-selection error. */
    evalSelError(msg, expr) {
        // Cache BEFORE view check — so error is shown when panel eventually opens
        this._lastEvalSel = { type: 'error', msg, expr };
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'evalSelError', msg, expr });
    }

    /** Clear eval-selection section. */
    evalSelClear() {
        this._lastEvalSel = null;
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'evalSelClear' });
    }

    _buildHtml(webviewView) {
        const webview    = webviewView.webview;
        const scriptUri  = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'watchPanel.webview.js'))
        );

        // Inline KaTeX CSS with font URLs replaced by base64 data URIs.
        // Same approach as wb-export.js — guarantees fonts load regardless of
        // webview CSP or relative-URL resolution issues.
        const _fs = require('fs');
        const _katexBase = (() => {
            const primary  = path.join(__dirname, '../../../node_modules/katex/dist');
            const fallback = path.join(__dirname, '../../../wllatex-addon/node_modules/katex/dist');
            return _fs.existsSync(path.join(primary, 'katex.min.css')) ? primary : fallback;
        })();
        const katexCssPath  = path.join(_katexBase, 'katex.min.css');
        const katexFontsDir = path.join(_katexBase, 'fonts');
        let katexCssInline = '';
        try {
            katexCssInline = _fs.readFileSync(katexCssPath, 'utf8')
                .replace(/url\(fonts\/([^)]+)\)/g, (match, fontFile) => {
                    try {
                        const buf = _fs.readFileSync(path.join(katexFontsDir, fontFile));
                        const ext = path.extname(fontFile).toLowerCase();
                        const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : 'font/ttf';
                        return `url(data:${mime};base64,${buf.toString('base64')})`;
                    } catch (_) { return match; }
                });
        } catch (_) { /* KaTeX CSS not available */ }

        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline' ${webview.cspSource}`,
            `font-src ${webview.cspSource} data:`,
            `script-src 'unsafe-inline' ${webview.cspSource}`,
            `img-src ${webview.cspSource} data: https:`,
        ].join('; ');
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${katexCssInline}</style>
<style>
  /* KaTeX overrides for the watch panel */
  .katex-display { text-align: left !important; margin: 0.2em 0 !important; }
  .katex-mathml  { display: none !important; }
  .katex svg        { fill: currentColor; stroke: currentColor; }
  .katex svg path   { stroke: none; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background-color: var(--vscode-sideBar-background, var(--vscode-panel-background, var(--vscode-editor-background)));
    padding: 6px 8px;
    margin: 0;
  }
  #step-header {
    font-weight: bold;
    margin-bottom: 6px;
    color: var(--vscode-editor-foreground);
    min-height: 1.2em;
  }
  #timing {
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    margin-bottom: 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92em;
  }
  th {
    text-align: left;
    padding: 2px 4px;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  td {
    padding: 2px 4px;
    vertical-align: top;
    border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground);
  }
  td.val {
    font-family: var(--vscode-editor-font-family, monospace);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td.remove {
    text-align: center;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    user-select: none;
    width: 18px;
  }
  td.remove:hover { color: var(--vscode-errorForeground); }
  #empty-msg {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 0.9em;
    margin-bottom: 8px;
  }
  #add-row {
    display: flex;
    gap: 4px;
    margin-top: 8px;
  }
  #add-input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 2px 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
  }
  #add-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 2px 8px;
    cursor: pointer;
  }
  #add-btn:hover { background: var(--vscode-button-hoverBackground); }
  #header-row { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
  #debug-controls { display: flex; gap: 2px; margin-bottom: 4px; flex-wrap: wrap; }
  .dbg-btn {
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: 1px solid var(--vscode-contrastBorder, transparent);
    padding: 2px 5px;
    cursor: pointer;
    font-size: 0.95em;
    border-radius: 2px;
    opacity: 0.35;
    pointer-events: none;
    min-width: 22px;
    text-align: center;
  }
  .dbg-btn.on { opacity: 1; pointer-events: auto; }
  .dbg-btn.on:hover { background: var(--vscode-button-hoverBackground); }
  .dbg-btn.stop-btn  { background: var(--vscode-statusBarItem-errorBackground, #a31515); color: #fff; }
  .dbg-btn.start-btn  { background: var(--vscode-debugIcon-startForeground, #4CAF50); color: #fff; border-color: transparent; }

  #refresh-btn {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 0 2px;
    font-size: 1em;
    line-height: 1;
    opacity: 0.7;
    flex-shrink: 0;
  }
  #refresh-btn:hover { opacity: 1; color: var(--vscode-foreground); }
  #bp-section {
    margin-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 4px;
  }
  #bp-header-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 3px;
  }
  #bp-header-label {
    font-size: 0.82em;
    font-weight: bold;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.05em;
  }
  #bp-clear-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 0.8em;
    padding: 0 2px;
    opacity: 0.7;
  }
  #bp-clear-btn:hover { opacity: 1; color: var(--vscode-errorForeground); }
  #bp-empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 0.82em;
  }
  .bp-row {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.85em;
    font-family: var(--vscode-editor-font-family, monospace);
    padding: 1px 0;
  }
  .bp-row-label { flex: 1; color: var(--vscode-foreground); }
  .bp-rm {
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    padding: 0 2px;
  }
  .bp-rm:hover { color: var(--vscode-errorForeground); }
  td.open-btn {
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    padding: 0 2px;
    width: 1.2em;
    text-align: center;
    user-select: none;
  }
  td.open-btn:hover { color: var(--vscode-foreground); }
  #eval-sel-section {
    margin-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 4px;
  }
  #eval-sel-header-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 3px;
  }
  #eval-sel-label {
    font-size: 0.82em;
    font-weight: bold;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.05em;
  }
  #eval-sel-format {
    font-size: 0.72em;
    color: #e8a020;
    background: rgba(232,160,32,0.12);
    border: 1px solid rgba(232,160,32,0.35);
    border-radius: 3px;
    padding: 1px 5px;
  }
  #eval-sel-clear {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 0.9em;
    padding: 0 2px;
    opacity: 0.7;
  }
  #eval-sel-clear:hover { opacity: 1; color: var(--vscode-errorForeground); }
  #eval-sel-open {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 0.9em;
    padding: 0 3px;
    opacity: 0.7;
  }
  #eval-sel-open:hover { opacity: 1; color: var(--vscode-textLink-foreground); }
  #eval-sel-expr {
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
    opacity: 0.7;
    margin-bottom: 4px;
  }
  #eval-sel-content {
    padding: 4px 0;
    overflow-x: auto;
  }
  #eval-sel-content img {
    max-width: 100%;
    height: auto;
  }
  /* max-width for svgs; do NOT add height:auto — KaTeX SVGs use height:inherit
     from .hide-tail (1.08em); height:auto with a 400000:1080 viewBox = ~0px height */
  #eval-sel-content svg {
    max-width: 100%;
  }
  /* Explicitly restore height:inherit for KaTeX SVGs so max-width doesn't reset it */
  #eval-sel-content .katex svg {
    height: inherit;
  }
  .eval-sel-error { color: var(--vscode-errorForeground, #f44); }
  .eval-sel-spinner {
    display: inline-block;
    animation: spin 1s linear infinite;
    color: var(--vscode-descriptionForeground);
  }
  #hover-doc-section {
    margin-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 6px;
    display: none;
  }
  #hover-doc-header-row {
    display: flex; align-items: center; gap: 4px; margin-bottom: 4px;
  }
  #hover-doc-label {
    font-size: 0.82em; font-weight: bold;
    color: var(--vscode-descriptionForeground); letter-spacing: 0.05em;
  }
  #hover-doc-clear {
    margin-left: auto; background: none; border: none;
    color: var(--vscode-descriptionForeground); cursor: pointer;
    font-size: 0.9em; padding: 0 2px; opacity: 0.7;
  }
  #hover-doc-clear:hover { opacity: 1; color: var(--vscode-errorForeground); }
  #hover-doc-symbol {
    font-size: 0.78em; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    opacity: 0.7; margin-bottom: 4px;
  }
  #hover-doc-content {
    padding: 2px 0; font-size: 0.9em; line-height: 1.5;
  }
  #hover-doc-content p { margin: 0 0 6px 0; }
  #hover-doc-content code {
    background: var(--vscode-textCodeBlock-background, #f0f4f0);
    padding: 1px 4px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
  }
  #hover-doc-content pre {
    background: var(--vscode-textCodeBlock-background, #f0f4f0);
    padding: 7px 10px; border-radius: 4px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em; margin: 6px 0;
  }
  #hover-doc-content pre code { background: none; padding: 0; }
  #hover-doc-content a { color: var(--vscode-textLink-foreground, #0066cc); }
  #hover-doc-content hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
  #hover-doc-content pre {
    background: var(--vscode-textCodeBlock-background, #f0f4f0);
    padding: 6px 10px; border-radius: 4px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em; margin: 4px 0;
  }
  #hover-doc-content code {
    background: var(--vscode-textCodeBlock-background, #f0f4f0);
    padding: 1px 4px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em;
  }
</style>
</head>
<body>
<div id="mcp-status-bar" style="display:flex; align-items:center; gap:6px; padding:4px 0 6px; border-bottom:1px solid var(--vscode-panel-border, #444); margin-bottom:6px; flex-wrap:wrap;">
  <span title="MCP Server: exposes Wolfbook tools over the Model Context Protocol so external AI agents (Claude Desktop, etc.) can connect to this window's Wolfram kernel. Requires window reload to take effect." style="font-size:11px; opacity:0.8; cursor:help; border-bottom:1px dotted currentColor;">MCP</span>
  <label class="mcp-switch" style="position:relative; display:inline-block; width:32px; height:18px; cursor:pointer; flex-shrink:0;">
    <input type="checkbox" id="mcp-toggle" style="opacity:0; width:0; height:0;">
    <span class="mcp-slider" style="position:absolute; inset:0; border-radius:9px; transition:background 0.2s;"></span>
  </label>
  <button id="mcp-info-btn" title="MCP configuration info" style="background:none; border:none; padding:0 2px; cursor:pointer; font-size:13px; line-height:1; opacity:0.65; color:inherit; flex-shrink:0; margin-right:4px;" aria-label="MCP configuration info">ⓘ</button>
  <span title="Collab mode: opens the notebook in a side-by-side split. The AI agent inserts, edits and runs cells in the right pane — your cursor and scroll position in the left pane are never disturbed." style="font-size:11px; opacity:0.8; cursor:help; border-bottom:1px dotted currentColor;">Collab</span>
  <label class="mcp-switch" style="position:relative; display:inline-block; width:32px; height:18px; cursor:pointer; flex-shrink:0;">
    <input type="checkbox" id="collab-toggle" style="opacity:0; width:0; height:0;">
    <span class="collab-slider" style="position:absolute; inset:0; border-radius:9px; transition:background 0.2s;"></span>
  </label>
</div>
<div id="mcp-info-panel" style="display:none; font-size:11px; line-height:1.7; padding:8px 10px; background:var(--vscode-editorWidget-background,#252526); border:1px solid var(--vscode-panel-border,#444); border-radius:4px; margin-bottom:6px; word-break:break-all;"></div>
<style>
  .mcp-slider { background: #6e7681 !important; }
  #mcp-toggle:checked + .mcp-slider { background: #2ea043 !important; }
  .mcp-slider::before {
    content:''; position:absolute; height:14px; width:14px; left:2px; bottom:2px;
    background: white; border-radius:50%; transition: transform 0.2s;
  }
  #mcp-toggle:checked + .mcp-slider::before { transform: translateX(14px); }
  .collab-slider { background: #6e7681 !important; }
  #collab-toggle:checked + .collab-slider { background: #2ea043 !important; }
  .collab-slider::before {
    content:''; position:absolute; height:14px; width:14px; left:2px; bottom:2px;
    background: white; border-radius:50%; transition: transform 0.2s;
  }
  #collab-toggle:checked + .collab-slider::before { transform: translateX(14px); }
</style>
<div id="header-row">
  <span id="step-header">Live watch</span>
  <button id="refresh-btn" title="Refresh values">⟳</button>
</div>
<div id="debug-controls">
  <button class="dbg-btn" id="btn-stepOver" title="Step Over (F10)">↷</button>
  <button class="dbg-btn" id="btn-stepInto" title="Step Into (F11)">↓</button>
  <button class="dbg-btn" id="btn-stepOut"  title="Step Out (⇧F11)">↑</button>
  <button class="dbg-btn" id="btn-continue" title="Continue to Breakpoint (F5)">▶</button>
  <button class="dbg-btn" id="btn-runToEnd" title="Run to End">⏭</button>
  <button class="dbg-btn start-btn on" id="btn-stop" data-mode="start" title="Debug Cell (Cmd+Shift+D)">▶ Debug</button>
</div>
<div id="timing"></div>
<div id="empty-msg">Add variables below to monitor them.</div>
<table id="var-table" style="display:none">
  <thead><tr><th>Name</th><th>Value</th><th></th><th></th></tr></thead>
  <tbody id="var-body"></tbody>
</table>
<div id="add-row">
  <input id="add-input" type="text" placeholder="Add watch…">
  <button id="add-btn">Add</button>
</div>
<div id="eval-sel-section" style="display:none">
  <div id="eval-sel-header-row">
    <span id="eval-sel-label">EVAL SELECTION</span>
    <span id="eval-sel-format"></span>
    <button id="eval-sel-open" title="Open value in editor" style="display:none">&#x29c9;</button>
    <button id="eval-sel-clear" title="Clear">×</button>
  </div>
  <div id="eval-sel-expr"></div>
  <div id="eval-sel-content"></div>
</div>
<div id="bp-section">
  <div id="bp-header-row">
    <span id="bp-header-label">BREAKPOINTS</span>
    <button id="bp-clear-btn" title="Remove all breakpoints">Clear all</button>
  </div>
  <div id="bp-empty">None. Use F9 in a cell to toggle.</div>
  <div id="bp-list"></div>
</div>
<div id="hover-doc-section" style="display:none">
  <div id="hover-doc-header-row">
    <span id="hover-doc-label">📖 DOCUMENTATION</span>
    <button id="hover-doc-clear" title="Clear">×</button>
  </div>
  <div id="hover-doc-symbol"></div>
  <div id="hover-doc-content"></div>
</div>
<script>
  // ── Hover tooltip for .wb-hint elements ───────────────────────────────────
  // Acquire VS Code API once — stored globally so the external script can reuse it
  // (acquireVsCodeApi() may only be called once per webview).
  window._vscode = acquireVsCodeApi();
  // MCP toggle refs
  window._mcpToggle    = document.getElementById('mcp-toggle');
  window._mcpInfoBtn   = document.getElementById('mcp-info-btn');
  window._mcpInfoPanel = document.getElementById('mcp-info-panel');
  // Clicking the ℹ button toggles the info panel visibility
  window._mcpUpdateLabel = function() {}; // kept for compat — no longer sets text
  if (window._mcpInfoBtn && window._mcpInfoPanel) {
    window._mcpInfoBtn.addEventListener('click', function() {
      var p = window._mcpInfoPanel;
      var isVisible = p.style.display !== 'none';
      p.style.display = isVisible ? 'none' : 'block';
      window._mcpInfoBtn.style.opacity = isVisible ? '0.65' : '1';
    });
  }
  // Collab toggle ref (used by collabState message handler in external script)
  window._collabToggle = document.getElementById('collab-toggle');
  console.log('[wb-inline] init: _collabToggle=' + (window._collabToggle ? 'found' : 'NULL'));
</script>
<script src="${scriptUri}" onerror="console.error('[wolfbook] FAILED to load watchPanel.webview.js');"></script>
</body>
</html>`;
    }
}

module.exports = { WatchPanelProvider, VIEW_ID };
