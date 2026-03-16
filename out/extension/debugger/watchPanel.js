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
        this._onDebugCommand = null;   // callback(action) — debug control button clicked
        this._onRemoveBp     = null;   // callback(uri, line)
        this._onClearAllBps  = null;   // callback()
        this._onOpenInEditor = null;   // callback(name, fullVal)
        this._debugActive    = false;  // tracks whether a debug session is active
        this._lastBpList     = [];     // cached breakpoint list for resend on visibility
        this._lastEvalSel    = null;   // cached eval-selection state {type,html,expr,format} for resend
        this._bgColor        = null;   // hex color, or null = use sidebar default
    }

    // Called by extension.js when registering:
    //   vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } })
    resolveWebviewView(webviewView /*, _context, _token */) {
        console.log('[wolfbook-watch] resolveWebviewView called');
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(__dirname),                                          // watchPanel.webview.js lives here
                vscode.Uri.file(require('os').tmpdir()),                             // eval-sel tmp images
                ...(vscode.workspace.workspaceFolders || []).map(f => f.uri),        // notebook images
            ],
        };
        webviewView.webview.html   = this._buildHtml(webviewView);
        console.log('[wolfbook-watch] HTML set, length=', webviewView.webview.html.length);

        // Re-send accumulated state whenever the panel becomes visible
        // (first open, or re-shown after being hidden). This fixes the race
        // where postMessage was called before the webview had loaded.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) this._sendCurrentState();
        });
        // Also send immediately — the panel may already be visible now.
        // Use setImmediate so the webview JS has time to load first.
        setImmediate(() => this._sendCurrentState());

        webviewView.webview.onDidReceiveMessage(msg => {
            console.log('[wolfbook-watch] received from webview:', msg.command, msg.name || msg.action || '');
            if (msg.command === 'addWatch' && msg.name) {
                const name = String(msg.name).trim();
                if (name && !this._watchList.includes(name)) {
                    this._watchList.push(name);
                    console.log('[wolfbook-watch] added to watchList:', name, '| total:', this._watchList.length, '| hasCallback:', !!this._onAddWatch);
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
            } else if (msg.command === 'scriptLoaded') {
                console.log('[wolfbook-watch] ✓ webview script loaded and running');
            } else {
                console.log('[wolfbook-watch] unhandled webview msg:', JSON.stringify(msg));
            }
        });
    }

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
        if (!this._view) { console.log('[wolfbook-watch] liveUpdate: no view'); return; }
        console.log('[wolfbook-watch] liveUpdate: posting', variables?.length, 'variables');
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
        if (!this._view) { console.log('[wolfbook-watch] setDebugActive: no view, saved state=', active); return; }
        console.log('[wolfbook-watch] setDebugActive: posting active=', active);
        this._view.webview.postMessage({ command: 'setDebugActive', active });
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

    /** Send a log line to the panel's log tail. */
    log(text) {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'log', text });
    }

    // ── Eval Selection ───────────────────────────────────────────────────

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
        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline'`,
            `script-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data: https:`,
        ].join('; ');
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
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
  #eval-sel-content img, #eval-sel-content svg {
    max-width: 100%;
    height: auto;
  }
  .eval-sel-error { color: var(--vscode-errorForeground, #f44); }
  .eval-sel-spinner {
    display: inline-block;
    animation: spin 1s linear infinite;
    color: var(--vscode-descriptionForeground);
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
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
<script src="${scriptUri}"></script>
</body>
</html>`;
    }
}

module.exports = { WatchPanelProvider, VIEW_ID };
