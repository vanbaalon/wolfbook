'use strict';
/**
 * Oberon — Test Results Panel (WebviewPanel backend).
 *
 * Singleton panel.  Opened by 'wolfbook.oberon.runTestSuite'.  Starts the
 * TestSuiteRunner when shown and streams progress to the webview.
 */

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

const VIEW_TYPE = 'wolfbook.oberon.testResults';

// Messages TO webview
const TO = {
    SCRIPT_LOADED_ACK: 'scriptLoadedAck',
    SUITE_STARTED:     'suiteStarted',
    TEST_STARTED:      'testStarted',
    TEST_DONE:         'testDone',
    SUITE_COMPLETE:    'suiteComplete',
    SUITE_ERROR:       'suiteError',
    SUITE_STATE:       'suiteState',   // re-sent on scriptLoaded when suite already running/done
};

// Messages FROM webview
const FROM = {
    SCRIPT_LOADED: 'scriptLoaded',
    ABORT:         'abort',
    RUN_AGAIN:     'runAgain',
};

class TestResultsPanel {
    /**
     * @param {{
     *   context:    import('vscode').ExtensionContext,
     *   runner:     import('../tests/runner').TestSuiteRunner,
     *   runManager: import('../core/runManager').RunManager,
     * }} opts
     */
    constructor({ context, runner, runManager }) {
        this._context    = context;
        this._runner     = runner;
        this._runManager = runManager;
        /** @type {vscode.WebviewPanel | null} */
        this._panel      = null;

        // Snapshot of last complete suite run (for re-display on panel reopen)
        this._lastResults  = null;
        this._lastAnalytics = null;
        this._inProgress   = [];   // live results so far
        this._currentIndex = -1;

        // Wire runner events
        runner.on('started', () => {
            console.log('[testResultsPanel] runner emitted started')
            this._inProgress   = [];
            this._currentIndex = -1;
            this._lastResults  = null;
            this._lastAnalytics = null;
            this._post({ command: TO.SUITE_STARTED, total: 10 });
        });
        runner.on('testStarted', ({ index, test }) => {
            this._currentIndex = index;
            this._post({ command: TO.TEST_STARTED, index, test });
        });
        runner.on('testDone', ({ result }) => {
            this._inProgress.push(result);
            this._post({ command: TO.TEST_DONE, result });
        });
        runner.on('suiteComplete', ({ results, analytics }) => {
            this._lastResults   = results;
            this._lastAnalytics = analytics;
            this._post({ command: TO.SUITE_COMPLETE, results, analytics });
        });
        runner.on('error', (e) => {
            this._post({ command: TO.SUITE_ERROR, message: e && e.message || String(e) });
        });
    }

    /** Open or reveal the panel.  Starts the suite if not already running. */
    async show() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Active, false);
        } else {
            this._createPanel();
        }

        if (!this._runner.isRunning) {
            // If there's an active research run, warn and bail
            if (this._runManager.isActive) {
                vscode.window.showWarningMessage(
                    'Oberon: a run is already active — abort it before starting the test suite.',
                );
                return;
            }
            // Small delay so the webview script has time to load
            setTimeout(() => this._runner.run().catch(() => {}), 300);
        }
    }

    dispose() {
        if (this._panel) { try { this._panel.dispose(); } catch (_) {} }
        this._panel = null;
    }

    // ── private ─────────────────────────────────────────────────────────────

    _createPanel() {
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            'Oberon: Test Suite',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(__dirname),
                    vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
                ],
            },
        );
        this._panel = panel;
        panel.iconPath = vscode.Uri.file(
            path.join(this._context.extensionPath, 'media', 'oberon.svg')
        );
        panel.webview.html = this._buildHtml(panel.webview);

        panel.webview.onDidReceiveMessage((msg) => this._onMessage(msg || {}));
        panel.onDidDispose(() => { this._panel = null; });
    }

    _post(msg) {
        if (this._panel) {
            try {
                console.log('[testResultsPanel] posting message:', msg.command);
                this._panel.webview.postMessage(msg);
            } catch (err) {
                console.error('[testResultsPanel] failed to post message:', msg.command, err);
            }
        } else {
            console.warn('[testResultsPanel] _post called but _panel is null:', msg.command);
        }
    }

    _onMessage(msg) {
        if (msg.command === FROM.SCRIPT_LOADED) {
            // Replay current state
            if (this._runner.isRunning) {
                this._post({
                    command: TO.SUITE_STATE,
                    running: true,
                    currentIndex: this._currentIndex,
                    results: this._inProgress,
                });
            } else if (this._lastResults) {
                this._post({
                    command: TO.SUITE_COMPLETE,
                    results: this._lastResults,
                    analytics: this._lastAnalytics,
                });
            }
            return;
        }
        if (msg.command === FROM.ABORT) {
            this._runner.abort();
            return;
        }
        if (msg.command === FROM.RUN_AGAIN) {
            if (this._runner.isRunning) return;
            if (this._runManager.isActive) {
                vscode.window.showWarningMessage(
                    'Oberon: abort the current run before running the test suite again.',
                );
                return;
            }
            this._runner.run().catch(() => {});
        }
    }

    _buildHtml(webview) {
        const nonce = makeNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'testResultsPanel.webview.js'))
        );
        const cssUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'testResultsPanel.webview.css'))
        );
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src  ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}' ${webview.cspSource}`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Oberon — Test Suite</title>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <header class="topbar">
    <div class="topbar__title"><span title="Oberon: the supervisor/planner/reviewer agent that orchestrates research">Oberon</span> · Test Suite</div>
    <div id="statusPill" class="topbar__pill" data-state="idle">idle</div>
    <div class="topbar__spacer"></div>
    <button id="abortBtn"   class="btn btn--danger"   style="display:none">Abort</button>
    <button id="runAgainBtn" class="btn btn--secondary" style="display:none">Run Again</button>
  </header>

  <div id="progressBar" class="progress-bar" style="display:none">
    <div id="progressFill" class="progress-bar__fill" style="width:0%"></div>
  </div>
  <div id="progressLabel" class="progress-label" style="display:none"></div>

  <div id="resultsWrap" class="results-wrap">
    <table id="resultsTable" class="results-table" style="display:none">
      <thead>
        <tr>
          <th>#</th>
          <th>Problem</th>
          <th title="Whether the pipeline run completed, errored, or was aborted — independent of correctness">Run Status</th>
          <th title="Analytic verdict assigned by the LLM after reviewing the Fairy's Scroll output. A DONE run may still be PARTIAL or FAILED.">Analysis Verdict</th>
          <th title="Total LLM API calls during this run (Planner + Fairy loop)">LLM calls</th>
          <th title="Tool invocations made by the Fairy agent while working on its Charm">Tool calls</th>
          <th>Cost</th>
          <th>Duration</th>
          <th title="Self-reported confidence (0–1) from the Fairy's Scroll output">Confidence</th>
        </tr>
      </thead>
      <tbody id="resultsBody"></tbody>
      <tfoot id="resultsFoot"></tfoot>
    </table>

    <div id="analyticsSection" class="analytics-section" style="display:none">
      <div class="analytics-section__title">
        Assessment by
        <span title="The Fairy role LLM is used for the analytics call. This call is not counted in run costs.">Fairy</span>
        (not counted in costs)
      </div>
      <div id="analyticsDistribution" class="analytics-distribution"></div>
      <div id="analyticsTotals"       class="analytics-totals"></div>
      <div id="analyticsNarrative"    class="analytics-narrative"></div>
      <details id="analyticsRaw" class="raw-json-toggle">
        <summary>Show raw analytics JSON</summary>
        <pre id="analyticsRawPre"></pre>
      </details>
    </div>

    <div id="emptyState" class="empty-state">
      Starting test suite…
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

module.exports = { TestResultsPanel };
