'use strict';
/**
 * Oberon — Control Room sidebar (WebviewViewProvider).
 *
 * Compact live-control surface. Companion deep-analysis surface is
 * `runInspector.js` (full WebviewPanel). Both speak the same protocol
 * defined in `stateProtocol.js`.
 *
 * Patterns: see AGENT_PANEL_GROUNDWORK.md
 *   - Cache state before any `if (!this._view) return` guard
 *   - Webview posts `scriptLoaded` after attaching its listener; provider
 *     replays full snapshot on receipt (race fix from watchPanel.js)
 *   - CSP: default-src 'none' + explicit allowances
 *   - retainContextWhenHidden: true (set by the caller in extension.js)
 */

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

const { TO_WEBVIEW, FROM_WEBVIEW } = require('./stateProtocol');
const roles    = require('../config/roles');
const settings = require('../config/settings');

const OBERON_VERSION = (() => {
    try { return require('../../../../package.json').version; } catch (_) { return '?'; }
})();

const VIEW_ID = 'wolfbook.oberon.controlRoom';

class ControlRoomProvider {
    /**
     * @param {{
     *   runManager: import('../core/runManager').RunManager,
     *   bus:        import('../telemetry/bus').TelemetryBus,
     *   onCommand:  (cmd: string, payload?: any) => void
     * }} deps
     */
    constructor(deps) {
        this._runManager = deps.runManager;
        this._bus        = deps.bus;
        this._onCommand  = deps.onCommand;
        /** @type {vscode.WebviewView | null} */
        this._view = null;
        this._disposables = [];
        /** @type {import('../core/fairy').SteerQueue | null} */
        this._steerQueue = null;

        // Subscribe to model changes — pushes to webview when visible.
        this._disposables.push(
            this._runManager.on('summary', () => this._postSnapshot()) && { dispose() {} },
        );
        this._bus.on('event', (ev) => {
            this._postEvent(ev);
            // Auto-open Run Inspector when a Fairy run begins so the user gets the
            // full-detail view without having to click through the sidebar.
            if (ev && ev.type === 'fairy.started') {
                setTimeout(() => this._onCommand('openRunInspector'), 500);
            }
        });
        this._runManager.on('summary', () => this._postSnapshot());
    }

    // VS Code calls this once per webview lifecycle.
    resolveWebviewView(webviewView /*, _ctx, _token */) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(__dirname),
                vscode.Uri.file(iconsDir()),
                vscode.Uri.file(katexDistDir()),
            ],
        };
        webviewView.webview.html = this._buildHtml(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) this._postSnapshot();
        });

        webviewView.webview.onDidReceiveMessage((msg) => this._onMessage(msg || {}));

        // Replay state shortly after attach in case the webview is already ready.
        // _postSnapshot no longer checks visibility — retainContextWhenHidden=true means
        // VS Code buffers postMessage for hidden but active webviews.
        // Fire at 200ms, 600ms, 2s as a belt-and-suspenders triple-tap.
        setImmediate(() => this._postSnapshot());
        setTimeout(() => this._postSnapshot(), 200);
        setTimeout(() => this._postSnapshot(), 600);
        setTimeout(() => this._postSnapshot(), 2000);
    }

    dispose() {
        for (const d of this._disposables) { try { d.dispose(); } catch (_) {} }
        this._disposables = [];
        this._view = null;
    }

    // ── outbound ────────────────────────────────────────────────────────────

    /** Send snapshot; obeys visibility guard (use _postSnapshotDirect for scriptLoaded). */
    _postSnapshot() {
        const view = this._view;
        if (!view) return;
        this._sendSnapshot(view);
    }

    /** Send snapshot unconditionally — used when the webview has just signalled readiness. */
    _postSnapshotDirect() {
        const view = this._view;
        if (!view) return;
        this._sendSnapshot(view);
    }

    _sendSnapshot(view) {
        const summary = this._runManager.summary;
        view.webview.postMessage({
            command: TO_WEBVIEW.SNAPSHOT_FULL,
            run: summary,
            settings: this._uiSettings(),
            roles: roles.resolveAllRoles(),
            recentEvents: this._bus.recent(500),
            iconBase: view.webview.asWebviewUri(vscode.Uri.file(iconsDir())).toString(),
        });
    }

    _postEvent(ev) {
        const view = this._view;
        if (!view) return;
        view.webview.postMessage({ command: TO_WEBVIEW.EVENT_APPEND, event: ev });
    }

    /** Push a one-off Omen card (also lands in the timeline naturally). */
    postOmen(omen) {
        const view = this._view;
        if (!view || !view.visible) return;
        view.webview.postMessage({ command: TO_WEBVIEW.OMEN, omen });
    }

    _uiSettings() {
        return {
            enabled: settings.isEnabled(),
            minimallyConfigured: roles.minimallyConfigured(),
            telemetry: settings.telemetry(),
            mathematica: settings.mathematica(),
            postmortem: settings.postmortem(),
            git: settings.git(),
            budgets: { fairyDefault: settings.fairyDefaultBudget() },
        };
    }

    // ── inbound ─────────────────────────────────────────────────────────────

    _onMessage(msg) {
        const c = msg.command;
        if (c === FROM_WEBVIEW.SCRIPT_LOADED) {
            // Webview just signalled readiness — send unconditionally, visibility may lag.
            this._postSnapshotDirect();
            return;
        }
        if (c === FROM_WEBVIEW.ABORT_RUN) {
            this._onCommand('abortRun');
            return;
        }
        if (c === FROM_WEBVIEW.START_RESEARCH) {
            this._onCommand('startResearch', { brief: String(msg.brief || '').trim() });
            return;
        }
        if (c === FROM_WEBVIEW.START_FAIRY) {
            this._onCommand('startFairy', { brief: String(msg.brief || '').trim() });
            return;
        }
        if (c === FROM_WEBVIEW.START_DIRECTOR) {
            this._onCommand('startDirector', { brief: String(msg.brief || '').trim() });
            return;
        }
        if (c === FROM_WEBVIEW.OPEN_RUN_INSPECTOR) {
            this._onCommand('openRunInspector');
            return;
        }
        if (c === FROM_WEBVIEW.OPEN_CHARM_DEBUGGER) {
            this._onCommand('openCharmDebugger');
            return;
        }
        if (c === FROM_WEBVIEW.OPEN_SETTINGS) {
            this._onCommand('openSettings');
            return;
        }
        if (c === FROM_WEBVIEW.CONFIGURE_PROVIDERS) {
            this._onCommand('configureProviders');
            return;
        }
        if (c === FROM_WEBVIEW.EMIT_MOCK_EVENTS) {
            this._onCommand('emitMockEvents');
            return;
        }
        if (c === FROM_WEBVIEW.RUN_VSCODE_COMMAND && typeof msg.id === 'string') {
            vscode.commands.executeCommand(msg.id, ...(Array.isArray(msg.args) ? msg.args : []));
            return;
        }
        if (c === FROM_WEBVIEW.UPDATE_SETTING && typeof msg.field === 'string') {
            this._applyBudgetUpdate(msg.field, msg.value);
            return;
        }
        if (c === FROM_WEBVIEW.SUBMIT_STEER && typeof msg.text === 'string') {
            if (this._steerQueue) {
                const text = msg.text.trim().slice(0, 500);
                if (text) this._steerQueue.push(text);
            }
            return;
        }
        if (c === 'bumpAndDeploy') {
            this._onCommand('bumpAndDeploy');
            return;
        }
    }

    /**
     * Set the active steer queue for the current run. Pass null when no run is active.
     * @param {import('../core/fairy').SteerQueue | null} queue
     */
    setSteerQueue(queue) {
        this._steerQueue = queue;
    }

    /** Apply a single budget field update from the webview inline editor. */
    _applyBudgetUpdate(field, rawValue) {
        const allowed = ['maxLlmCalls', 'maxToolCalls', 'maxOutputTokens', 'maxWallClockMs'];
        if (!allowed.includes(field)) return;
        const n = parseInt(rawValue, 10);
        if (!isFinite(n) || n <= 0) return;
        const current = settings.fairyDefaultBudget();
        const updated = Object.assign({}, current, { [field]: n });
        vscode.workspace.getConfiguration('wolfbook.oberon')
            .update('budgets.fairyDefault', updated, vscode.ConfigurationTarget.Global)
            .then(() => this._postSnapshotDirect(), () => {});
    }

    // ── html ────────────────────────────────────────────────────────────────

    _buildHtml(webview) {
        const nonce = makeNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'controlRoom.webview.js'))
        );
        const activityViewUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'controlRoom.activityView.js'))
        );
        const katexCssUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(katexDistDir(), 'katex.min.css'))
        );
        const katexJsUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(katexDistDir(), 'katex.min.js'))
        );
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src  ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}' ${webview.cspSource}`,
        ].join('; ');

        const css = readSync(path.join(__dirname, 'controlRoom.webview.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Oberon — Control Room</title>
<link rel="stylesheet" href="${katexCssUri}">
<style>${css}</style>
</head>
<body>
  <div id="root">
    <header class="oberon-header">
      <div class="oberon-title">Oberon <span class="oberon-ver">v${OBERON_VERSION}</span></div>
      <div class="oberon-state-pill" id="statePill" data-state="IDLE">idle</div>
      <div class="oberon-header-btns">
        <button class="oberon-gear-btn" data-cmd="toggleGear" title="Roles, budget &amp; tools">&#9881;</button>
        <button class="oberon-help-btn" data-cmd="showHelp" title="Terminology glossary">?</button>
      </div>
    </header>

    <div id="helpOverlay" class="help-overlay" hidden>
      <div class="help-panel">
        <div class="help-panel__header">
          <span>Oberon Glossary</span>
          <button class="help-panel__close" data-cmd="closeHelp" title="Close">&times;</button>
        </div>
        <dl class="help-panel__body">
          <dt>Quest</dt><dd>The structured task definition produced from your brief by the Planner. Contains a title, description, and one or more Charms.</dd>
          <dt>Charm</dt><dd>A single scoped work unit derived from a Quest and handed to the Fairy. A Quest may contain one or more Charms; today each Quest is dispatched as a single Charm (C01).</dd>
          <dt>Fairy</dt><dd>The LLM worker agent that performs the research: calls Wolfram tools, gathers evidence, and produces a Scroll.</dd>
          <dt>Scroll</dt><dd>The Fairy&rsquo;s structured output: summary, key findings with confidence scores, cited evidence expressions, and open questions.</dd>
          <dt>Skeptic</dt><dd>The independent Critic. It studies the Fairy&rsquo;s artefacts, clean-runs notebooks where appropriate, and adds targeted checks. Results may <em>support</em>, <em>challenge</em>, or leave a claim <em>inconclusive</em>; Mathematica is not treated as an oracle.</dd>
          <dt>Oberon</dt><dd>The top-level controller that orchestrates the run, reads the Scroll &amp; Skeptic verdict, and delivers the final verdict to the user.</dd>
          <dt>Verdict</dt><dd>Oberon&rsquo;s final outcome: <em>success</em>, <em>partial_success</em>, <em>failed</em>, or <em>needs_review</em>, plus a verification level (<em>verified</em>, <em>heuristic</em>, <em>partial</em>, <em>disputed</em>, <em>none</em>) and a short narrated explanation.</dd>
          <dt>Ward (check)</dt><dd>A single independent verification check requested by the Critic. The Critic chooses the appropriate ward method per evidence item; the ward&rsquo;s pass/fail result feeds the run&rsquo;s verification level.</dd>
          <dt>Grimoire</dt><dd>The Scribe&rsquo;s durable workspace memory at <code>grimoire/canonical_state.md</code>. One entry per accepted run; only sufficiently verified findings are written.</dd>
          <dt>Spell</dt><dd>A single tool invocation &mdash; e.g. one Wolfram kernel evaluation made by the Fairy or Skeptic.</dd>
          <dt>Omen</dt><dd>A non-fatal warning emitted during a run: budget ceiling hit, transient API error, etc.</dd>
          <dt>Budget</dt><dd>Per-Charm limits: max LLM calls, max tool calls, max output tokens, and max wall-clock time. Configurable via the gear icon.</dd>
        </dl>
      </div>
    </div>

    <!-- Gear panel: roles, budget parameters, action buttons -->
    <div id="gearPanel" class="gear-panel" hidden>
      <div class="gear-section">
        <div class="gear-section__title">Roles</div>
        <div id="rolesList"></div>
      </div>
      <div class="gear-section">
        <div class="gear-section__title">Fairy Budget <span class="param-hint">(click to edit)</span></div>
        <div id="paramsList" style="font-size: 12px; line-height: 1.7;">
          <div class="param-row">
            <span class="param-row__label">LLM Calls:</span>
            <span class="param-value" id="param-maxLlmCalls" data-settable="maxLlmCalls" title="Max tool-calling LLM rounds before Fairy is forced to finalise">—</span>
          </div>
          <div class="param-row">
            <span class="param-row__label">Tool Calls:</span>
            <span class="param-value" id="param-maxToolCalls" data-settable="maxToolCalls" title="Per-tool-call throttle">—</span>
          </div>
          <div class="param-row">
            <span class="param-row__label">Output Tokens:</span>
            <span class="param-value" id="param-maxOutputTokens" data-settable="maxOutputTokens" title="Max tokens in each LLM response">—</span>
          </div>
          <div class="param-row">
            <span class="param-row__label">Wall Clock (ms):</span>
            <span class="param-value" id="param-maxWallClockMs" data-settable="maxWallClockMs" title="Hard timeout for the whole Charm in milliseconds">—</span>
          </div>
        </div>
      </div>
      <div class="gear-actions">
        <button data-cmd="openSettings">Settings</button>
        <button data-cmd="openRunInspector">Run Inspector</button>
        <button data-cmd="openCharmDebugger">Charm Debugger</button>
        <button data-cmd="openRunLog" title="Open the telemetry log for the current run">View Log</button>
        <button data-cmd="runTestSuite" title="Run the standard test suite">Test Suite</button>
      </div>
    </div>

    <section id="warningBanner" class="banner banner--warn" hidden>
      Guarded execution — not a full security sandbox. Trusted local use only.
    </section>

    <section id="configBanner" class="banner banner--info" hidden>
      <div class="banner__title">Configure providers to start research</div>
      <div class="banner__body">Set a DeepSeek API key and verify the Oberon &amp; Fairy model bindings.</div>
      <div class="banner__actions">
        <button data-cmd="configureProviders">Configure providers &amp; pricing</button>
      </div>
    </section>

    <!-- Fairy FSM strip — visible during a run and persists after completion -->
    <section id="fairyStrip" class="fairy-strip" data-status="" hidden>
      <div class="fairy-strip__bar"></div>
      <div class="fairy-strip__inner">
        <div class="fairy-strip__header">
          <span class="fairy-strip__label">Fairy</span>
          <span class="fairy-phase-pill" id="fairyPhasePill" data-phase="">—</span>
        </div>
        <div class="fairy-phase-track">
          <span class="fairy-phase-node" id="fpn-explore">Explore</span>
          <span class="fairy-phase-connector" id="fpc-explore"></span>
          <span class="fairy-phase-node" id="fpn-compile">Compile</span>
          <span class="fairy-phase-connector" id="fpc-compile"></span>
          <span class="fairy-phase-node" id="fpn-verify">Verify</span>
          <span class="fairy-phase-connector" id="fpc-verify"></span>
          <span class="fairy-phase-node" id="fpn-terminal">—</span>
        </div>
        <div class="fairy-budgets">
          <div class="fairy-budget-row">
            <span class="fairy-budget-label">Probes</span>
            <div class="fairy-budget-bar"><div class="fairy-budget-fill" id="fbProbesFill"></div></div>
            <span class="fairy-budget-count" id="fbProbesCount">—</span>
          </div>
          <div class="fairy-budget-row">
            <span class="fairy-budget-label">Turns</span>
            <div class="fairy-budget-bar"><div class="fairy-budget-fill" id="fbTurnsFill"></div></div>
            <span class="fairy-budget-count" id="fbTurnsCount">—</span>
          </div>
        </div>
      </div>
    </section>

    <section class="card" id="runCard">
      <div class="card__row">
        <div class="card__label">Run</div>
        <div class="card__value" id="runId">—</div>
      </div>
      <div class="card__row">
        <div class="card__label">Cost</div>
        <div class="card__value" id="costChip">—</div>
      </div>
      <div class="card__row">
        <div class="card__label">Quest</div>
        <div class="card__value" id="questCell">—</div>
      </div>
      <div class="card__row">
        <div class="card__label">Latest</div>
        <div class="card__value" id="latestEvent">—</div>
      </div>
    </section>

    <section class="card" id="activityCard">
      <div class="card__title">Activity</div>
      <div id="activityFeed" class="activity-feed"></div>
    </section>

    <section class="briefBox">
      <div class="briefBox__mode-row">
        <button class="briefBox__mode-btn briefBox__mode-btn--active" id="modeBtnResearch" title="Full pipeline: Planner → Fairy → Skeptic → verified notebook">Research</button>
        <button class="briefBox__mode-btn" id="modeBtnFairy" title="Direct computation only: Fairy runs a single focused task and delivers a verified clean notebook — no planning or critique">Quick Compute</button>
        <button class="briefBox__mode-btn" id="modeBtnDirector" title="Multi-stage programme: Director plans stages, runs the Fairy per stage, assesses evidence, and always ends with a LaTeX report (+ PDF when pdflatex is available)">Director</button>
      </div>
      <div id="modeHint" class="briefBox__mode-hint">
        <span id="modeHintText">Full Oberon pipeline: Planner scopes the task, Fairy computes, Skeptic reviews. Best for open-ended research questions.</span>
      </div>
      <textarea id="briefInput" rows="3" placeholder="Describe a research task… (Cmd+Enter to start)"></textarea>
      <div class="briefBox__actions">
        <button id="startBtn" data-cmd="startResearch" disabled>Start</button>
        <button id="abortBtn" data-cmd="abortRun" disabled>Abort</button>
      </div>
    </section>
    <section class="steerBox">
      <div class="steerBox__label">Steer</div>
      <div class="steerBox__row">
        <textarea id="steerInput" rows="2" placeholder="(no active run)" disabled></textarea>
        <button id="steerBtn" class="steerBox__btn" data-cmd="submitSteer" disabled title="Send steering message to fairy">&#9654;</button>
      </div>
    </section>
  </div>

  <script nonce="${nonce}" src="${katexJsUri}"></script>
  <script nonce="${nonce}" src="${activityViewUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function readSync(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}
function iconsDir() {
    return path.resolve(__dirname, '..', '..', '..', '..', 'media', 'oberon-icons');
}
function katexDistDir() {
    // out/extension/oberon/ui → up 4 → Extension Development root → node_modules/katex/dist
    return path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'katex', 'dist');
}
function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

module.exports = { ControlRoomProvider, VIEW_ID };
