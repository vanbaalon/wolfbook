'use strict';

/**
 * Wolfbook — What's New panel
 *
 * Shows a rich HTML panel once after each version upgrade.
 * The last-shown version is stored in `context.globalState` under
 * `wolfbook.whatsNewShownVersion`.  The panel is never shown on a clean
 * first-install (version key absent), only on upgrades.
 *
 * Call `maybeShowWhatsNew(context, version)` from `activate()`.
 */

const vscode = require('vscode');
const path = require('path');

// ---------------------------------------------------------------------------
// Content — edit this when releasing a new version.
// ---------------------------------------------------------------------------

const VERSION = '2.7.0';

// Each entry: { icon, title, body (HTML) }
const HIGHLIGHTS = [
    {
        icon: '🔴',
        title: 'Live-updating <code>WBPrint</code>',
        body: `
            <code>WBPrint[expr]</code> replaces its previous output on every call —
            perfect for watching loops and iterations in real time without flooding
            the notebook with hundreds of lines.
            <pre>Do[WBPrint["Step ", k, " → ", k^2], {k, 100}]</pre>
            <code>Print[]</code> still accumulates as before.
        `,
    },
    {
        icon: '📐',
        title: '<code>[[</code> → <code>〚〛</code> and <code>==</code> → <code>⩵</code> in UTF mode',
        body: `
            <strong>Format with UTF</strong> (<kbd>⌥⇧F</kbd>) now also renders Part brackets
            as <code>〚…〛</code> and Equal as <code>⩵</code>.
            <code>〚〛</code> are now full bracket citizens: colouring,
            matching, smart selection, folding, and surrounding-pair support all work.
        `,
    },
    {
        icon: '🔀',
        title: 'Chunk folding for multi-line expressions',
        body: `
            Top-level multi-line expressions can now be collapsed to their first line.
            The folder uses a bracket-depth–aware algorithm that respects continuation
            operators, so it never incorrectly splits a single expression across chunks.
        `,
    },
    {
        icon: '📍',
        title: 'Double-click output header → jump to source',
        body: `
            Double-click the thin header bar above any cell output to scroll the editor
            to the corresponding source line inside the cell.
        `,
    },
    {
        icon: '📱',
        title: 'Remote bridge (iOS companion)',
        body: `
            The new <code>wolfbook.remote.*</code> command surface lets the
            <strong>Wolfbook Remote Host</strong> (to be released soon) companion extension drive this window
            from a paired iOS device over WebRTC — eval cells, view outputs, and trigger
            Copilot remotely.  Connection status appears as a dot in the sidebar panel.
        `,
    },
    {
        icon: '🧠',
        title: 'Agent checkpoint tool — durable working memory',
        body: `
            New MCP tool <code>wolfbook_remote_checkpoint</code> persists a Markdown plan
            file alongside the notebook.  Agents can save their working state and resume
            across sessions without losing context.
        `,
    },
    {
        icon: '🔇',
        title: 'Fewer spurious Problems panel warnings',
        body: `
            Three more noisy Wolfram LSP warning classes are now suppressed:
            <em>"Unexpected prefix +"</em>, <em>"Suspicious use of session token"</em>,
            and <em>"Unexpected letterlike character"</em>.
        `,
    },
    {
        icon: '🔧',
        title: 'Bug fixes',
        body: `
            <ul>
                <li>Formatter no longer drops trailing <code>;</code> inside brackets
                    (<code>Do[Print[k];, {k,4}]</code> was broken).</li>
                <li>Horizontal scrollbar no longer causes a scroll-jump when cells
                    leave the viewport.</li>
                <li><code>WBDirectory[]</code> is now always defined at kernel startup,
                    even when no notebook is open.</li>
                <li><code>?Symbol</code> information output renders cleanly instead of
                    producing garbled LaTeX.</li>
            </ul>
        `,
    },
];

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function _buildHtml(webview, extensionUri) {
    // Colour tokens that adapt to VS Code theme
    const html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>What's New in Wolfbook ${VERSION}</title>
<style>
  :root {
    --bg:        var(--vscode-editor-background, #1e1e1e);
    --fg:        var(--vscode-editor-foreground, #d4d4d4);
    --accent:    var(--vscode-textLink-foreground, #4da6ff);
    --card-bg:   var(--vscode-editorWidget-background, #252526);
    --border:    var(--vscode-editorWidget-border, #454545);
    --code-bg:   var(--vscode-textCodeBlock-background, #1a1a2e);
    --muted:     var(--vscode-descriptionForeground, #9d9d9d);
    --kbd-bg:    var(--vscode-keybindingLabel-background, #3a3d41);
    --kbd-fg:    var(--vscode-keybindingLabel-foreground, #cccccc);
    --kbd-bdr:   var(--vscode-keybindingLabel-border, #5a5d63);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.6;
    padding: 32px 40px 56px;
    max-width: 820px;
    margin: 0 auto;
  }

  /* ── Header ── */
  .hero { display:flex; align-items:center; gap:16px; margin-bottom:32px; border-bottom:1px solid var(--border); padding-bottom:24px; }
  .hero-icon { font-size:48px; line-height:1; }
  .hero h1 { font-size:22px; font-weight:700; margin-bottom:4px; }
  .hero .version-badge {
    display:inline-block; padding:2px 10px; border-radius:12px;
    background: var(--accent); color: var(--bg);
    font-size:11px; font-weight:700; letter-spacing:0.04em;
  }

  /* ── Feature cards ── */
  .features { display:grid; gap:14px; }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .card-header { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
  .card-icon { font-size:18px; line-height:1; flex-shrink:0; }
  .card h2 { font-size:13px; font-weight:600; }
  .card p, .card ul, .card pre { font-size:12.5px; color: var(--fg); opacity:0.9; }
  .card ul { padding-left:18px; }
  .card li { margin-bottom:4px; }

  code {
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Courier New', monospace);
    font-size:12px;
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--accent);
  }
  pre {
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Courier New', monospace);
    font-size: 11.5px;
    background: var(--code-bg);
    padding: 10px 14px;
    border-radius: 5px;
    margin-top: 8px;
    overflow-x: auto;
    color: var(--fg);
    border: 1px solid var(--border);
  }
  kbd {
    display:inline-block;
    background: var(--kbd-bg);
    color: var(--kbd-fg);
    border: 1px solid var(--kbd-bdr);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
    font-family: var(--vscode-font-family, sans-serif);
  }

  /* ── Footer ── */
  .footer {
    margin-top: 36px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .footer p { font-size:12px; color: var(--muted); }
  .footer a { color: var(--accent); text-decoration: none; }
  .footer a:hover { text-decoration: underline; }
  .btn {
    display: inline-block;
    padding: 6px 16px;
    background: var(--accent);
    color: var(--bg);
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    text-decoration: none;
  }
  .btn:hover { opacity: 0.85; }
</style>
</head>
<body>

<div class="hero">
  <div class="hero-icon">📓</div>
  <div>
    <h1>What's New in Wolfbook</h1>
    <span class="version-badge">v${VERSION}</span>
  </div>
</div>

<div class="features">
  ${HIGHLIGHTS.map(h => `
  <div class="card">
    <div class="card-header">
      <span class="card-icon">${h.icon}</span>
      <h2>${h.title}</h2>
    </div>
    ${h.body}
  </div>`).join('\n')}
</div>

<div class="footer">
  <p>
    Found a bug or have a suggestion?<br>
    <a href="https://github.com/vanbaalon/wolfbook/issues" id="issues-link">Report an issue on GitHub →</a>
  </p>
  <button class="btn" id="close-btn">Close</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('close-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'close' });
  });
  document.getElementById('issues-link').addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ command: 'openUrl', url: 'https://github.com/vanbaalon/wolfbook/issues' });
  });
</script>
</body>
</html>`;
    return html;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Show the What's New panel if the extension was just upgraded.
 *
 * Logic:
 *  - On a CLEAN first install: `wolfbook.whatsNewShownVersion` is absent from
 *    globalState.  We store the current version but do NOT show the panel —
 *    new users should start with the README, not a "what changed" list.
 *  - On an UPGRADE: stored version differs from current → show the panel and
 *    update the stored version.
 *  - On a RELOAD of the same version: stored version matches → do nothing.
 *
 * @param {vscode.ExtensionContext} context
 */
function maybeShowWhatsNew(context) {
    const KEY = 'wolfbook.whatsNewShownVersion';
    const stored = context.globalState.get(KEY);

    if (stored === undefined) {
        // First install — just record the version, don't show.
        context.globalState.update(KEY, VERSION);
        return;
    }

    if (stored === VERSION) {
        // Same version (reload / re-open) — nothing to show.
        return;
    }

    // Version changed since last time — show the panel and record it.
    context.globalState.update(KEY, VERSION);
    _showPanel(context);
}

/** Force-show the panel (e.g. from a command). */
function showWhatsNew(context) {
    _showPanel(context);
}

function _showPanel(context) {
    const panel = vscode.window.createWebviewPanel(
        'wolfbook.whatsNew',
        `What's New — Wolfbook ${VERSION}`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [],
        }
    );

    panel.webview.html = _buildHtml(panel.webview, context.extensionUri);

    panel.webview.onDidReceiveMessage((msg) => {
        if (msg.command === 'close') {
            panel.dispose();
        } else if (msg.command === 'openUrl') {
            vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
    }, undefined, context.subscriptions);
}

module.exports = { maybeShowWhatsNew, showWhatsNew };
