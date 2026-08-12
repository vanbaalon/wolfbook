'use strict';
/**
 * Oberon — Gold Suite Panel (WebviewPanel backend).
 *
 * Singleton panel.  Opened by 'wolfbook.oberon.runTestSuite'.  Since the
 * Stage-0 rebuild the suite is the 25-task kernel-verified gold benchmark:
 * every task is a REAL fairy run (5–30 min, real LLM cost), so the panel
 * never auto-starts — it opens a picker (starter subset / pick tasks /
 * full suite) and streams progress to the webview.
 */

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const gold        = require('../tests/goldRunner');
const wolframShim = require('../core/wolframShim');

/** Cheap end-to-end starter — the recommended first baseline (see GOLD_SUITE.md). */
const STARTER_TASKS = ['GT14', 'GT15', 'GT01', 'GT05', 'TS04'];

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
        this._lastRunOpts  = null; // { taskIds, label } of the last started run
        this._total        = 0;

        // Wire runner events
        runner.on('started', () => {
            console.log('[testResultsPanel] runner emitted started')
            this._inProgress   = [];
            this._currentIndex = -1;
            this._lastResults  = null;
            this._lastAnalytics = null;
            this._post({ command: TO.SUITE_STARTED, total: this._total || 0 });
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

    /** Open or reveal the panel, then offer the task picker (never auto-runs). */
    async show() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Active, false);
        } else {
            this._createPanel();
        }
        if (!this._runner.isRunning) {
            // Small delay so the webview script has time to load before any state post
            setTimeout(() => this._pickAndRun().catch(() => {}), 300);
        }
    }

    /**
     * Interactive flow: mode (starter / pick / full) → optional multi-pick →
     * report label → run. Cancelling anywhere leaves the panel idle showing
     * the previous results (if any).
     */
    async _pickAndRun() {
        if (this._runner.isRunning) return;
        if (this._runManager.isActive) {
            vscode.window.showWarningMessage(
                'Oberon: a run is already active — abort it before starting the gold suite.');
            this._replayIdle();
            return;
        }
        try {
            const k = wolframShim.kernelStatus();
            if (!k.available) {
                vscode.window.showWarningMessage(
                    `Oberon Gold Suite: Wolfram kernel is not available (${k.reason || 'unknown'}). ` +
                    'Open any .wb notebook to start a kernel, then run the suite again.');
                this._replayIdle();
                return;
            }
        } catch (_) {}

        const mode = await vscode.window.showQuickPick([
            {
                id: 'starter', label: '$(beaker) Starter subset  (recommended first)',
                description: STARTER_TASKS.join(', '),
                detail: '5 cheap tasks — smokes the whole loop: fairy run → fresh-kernel verify → report.',
            },
            {
                id: 'pick', label: '$(checklist) Pick tasks…',
                description: 'choose from all 25',
                detail: 'Each task is one real fairy run (5–30 min). Day-to-day: re-run the subset you are working on.',
            },
            {
                id: 'full', label: '$(flame) Full suite',
                description: 'all 25 tasks',
                detail: 'HOURS of wall-clock and real LLM cost — for recording a full baseline, prefer off-peak.',
            },
        ], {
            title: 'Oberon Gold Suite — kernel-verified benchmark',
            placeHolder: 'What should run? (Esc to just view previous results)',
        });
        if (!mode) { this._replayIdle(); return; }

        let taskIds = null;
        if (mode.id === 'starter') {
            taskIds = STARTER_TASKS.slice();
        } else if (mode.id === 'pick') {
            const prev = new Set((this._lastRunOpts && this._lastRunOpts.taskIds) || STARTER_TASKS);
            const items = gold.allTasks().map(t => ({
                label: t.id,
                description: t.title,
                detail: `${t.verify} · ${t.category}`,
                picked: prev.has(t.id),
            }));
            const sel = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                title: 'Gold tasks to run',
                placeHolder: 'Each selected task = one real fairy run (5–30 min, ~$0.05–0.2)',
            });
            if (!sel || !sel.length) { this._replayIdle(); return; }
            taskIds = sel.map(s => s.label);
        } else {
            const go = await vscode.window.showWarningMessage(
                'Run the FULL gold suite? 25 sequential fairy runs — several hours of wall-clock ' +
                'and real LLM cost. The kernel is restarted repeatedly throughout.',
                { modal: true }, 'Run full suite');
            if (go !== 'Run full suite') { this._replayIdle(); return; }
        }

        const label = await vscode.window.showInputBox({
            title: 'Report label',
            value: (this._lastRunOpts && this._lastRunOpts.label) || 'baseline',
            prompt: 'Stamped into the report filename (.oberon/gold/gold-<time>-<label>.json)',
        });
        if (label === undefined) { this._replayIdle(); return; }

        this._lastRunOpts = { taskIds, label: label || 'gold' };
        try { this._total = gold.resolveTasks(taskIds).length; } catch (_) { this._total = 0; }
        this._runner.run(this._lastRunOpts).catch(() => {});
    }

    /** Repaint the webview's idle state after a cancelled/blocked picker. */
    _replayIdle() {
        if (this._runner.isRunning) return;
        if (this._lastResults) {
            this._post({ command: TO.SUITE_COMPLETE, results: this._lastResults, analytics: this._lastAnalytics });
        } else {
            this._post({ command: TO.SUITE_ERROR, message: 'No run started — reopen the command (Oberon: Run Test Suite) or press Run Again to pick tasks.' });
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
            // Re-opens the picker (pre-filled with the last selection) rather
            // than blindly re-running — every task costs real money.
            this._pickAndRun().catch(() => {});
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
    <div class="topbar__title"><span title="Oberon: the supervisor/planner/reviewer agent that orchestrates research">Oberon</span> · Gold Suite</div>
    <div id="statusPill" class="topbar__pill" data-state="idle">idle</div>
    <div class="topbar__spacer"></div>
    <button id="abortBtn"   class="btn btn--danger"   style="display:none">Abort</button>
    <button id="runAgainBtn" class="btn btn--secondary" style="display:none">Run…</button>
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
          <th title="Kernel-verified verdict: a fresh kernel replays the delivered clean.wb and runs the task's machine verifier — no LLM judging. A DONE run may still be PARTIAL or FAILED (FAILED with a delivered run = false_delivered: the kernel refuted the claim).">Verdict</th>
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
        <span title="Verdicts come from fresh-kernel replay + per-task machine verifiers (goldRunner.js) — deterministic, no LLM judge, no extra cost.">Kernel-verified assessment</span>
        (deterministic)
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
      Choose tasks in the picker to start a run…
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
