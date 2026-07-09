'use strict';
/**
 * Oberon — Run Inspector (WebviewPanel).
 *
 * Deep-analysis surface, opened on demand. Singleton: at most one Inspector
 * panel exists at a time. Receives the same snapshot/event protocol as the
 * sidebar; renders timeline + summary table + (future) tabs for span tree,
 * cost diagnostics, Scroll inspector, postmortem viewer.
 */

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const fsp    = require('fs/promises');

const { TO_WEBVIEW, FROM_WEBVIEW } = require('./stateProtocol');
const roles    = require('../config/roles');
const settings = require('../config/settings');
const project  = require('../memory/project');
const { FAIRY_SYSTEM_PROMPT }    = require('../fairy/prompts');
const { buildPlannerSystemPrompt } = require('../agents/oberonPlanner.prompt');
const { POSTMORTEM_SYSTEM_PROMPT } = require('../memory/postmortem');

const VIEW_TYPE = 'wolfbook.oberon.runInspector';

class RunInspectorManager {
    /**
     * @param {{
     *   context:    import('vscode').ExtensionContext,
     *   runManager: import('../core/runManager').RunManager,
     *   bus:        import('../telemetry/bus').TelemetryBus,
     *   onCommand:  (cmd: string, payload?: any) => void
     * }} deps
     */
    constructor(deps) {
        this._context    = deps.context;
        this._runManager = deps.runManager;
        this._bus        = deps.bus;
        this._onCommand  = deps.onCommand;
        /** @type {vscode.WebviewPanel | null} */
        this._panel = null;
        /** @type {import('../core/fairy').SteerQueue | null} live steering queue */
        this._steerQueue = null;

        this._runManager.on('summary', () => this._postSnapshot());
        this._bus.on('event', (ev) => this._postEvent(ev));
    }

    /**
     * Set the active steer queue for the current fairy run (null when none).
     * Mirrors the Control Room sidebar; the Inspector's steer bar enables when
     * a queue is present.
     */
    setSteerQueue(queue) {
        this._steerQueue = queue;
        if (this._panel) {
            this._panel.webview.postMessage({ command: 'steer.state', active: !!queue });
        }
    }

    /** Reveal an existing panel or create a new one. */
    show() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            'Oberon: Run Inspector',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(__dirname),
                    vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
                    vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'oberon-icons')),
                ],
            },
        );
        this._panel = panel;
        panel.iconPath = vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'oberon.svg'));
        panel.webview.html = this._buildHtml(panel.webview);

        panel.webview.onDidReceiveMessage((msg) => this._onMessage(msg || {}));
        panel.onDidDispose(() => { this._panel = null; });

        setImmediate(() => this._postSnapshot());
    }

    dispose() {
        if (this._panel) { try { this._panel.dispose(); } catch (_) {} }
        this._panel = null;
    }

    // ── outbound ────────────────────────────────────────────────────────────

    _postSnapshot() {
        const panel = this._panel;
        if (!panel) return;
        // Prefer reading the full JSONL for the active run so the Inspector
        // never silently truncates: in-memory tail caps at RECENT_BUFFER_SIZE
        // but the disk log is the ground truth.
        Promise.resolve(this._readFullRunEvents()).then((events) => {
            if (!this._panel) return;
            this._panel.webview.postMessage({
                command: TO_WEBVIEW.SNAPSHOT_FULL,
                run: this._runManager.summary,
                settings: this._uiSettings(),
                roles: roles.resolveAllRoles(),
                recentEvents: events,
                iconBase: panel.webview.asWebviewUri(
                    vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'oberon-icons'))
                ).toString(),
                prompts: {
                    fairy:      FAIRY_SYSTEM_PROMPT,
                    planner:    buildPlannerSystemPrompt(),
                    postmortem: POSTMORTEM_SYSTEM_PROMPT,
                },
            });
        }).catch(() => {});
    }

    /**
     * Return every event for the live run.  Reads the active JSONL log when
     * available (ground truth), else falls back to the in-memory ring buffer.
     * Deduplicates by eventId in case both sources overlap.
     */
    async _readFullRunEvents() {
        const tail = this._bus.recent(10000);
        const fp   = this._bus.filePath;
        if (!fp) return tail;
        try {
            const content = await fsp.readFile(fp, 'utf8');
            const lines   = content.split('\n');
            const out     = [];
            const seen    = new Set();
            for (const line of lines) {
                if (!line) continue;
                try {
                    const ev = JSON.parse(line);
                    if (ev && ev.eventId && !seen.has(ev.eventId)) {
                        seen.add(ev.eventId);
                        out.push(ev);
                    }
                } catch (_) { /* skip malformed */ }
            }
            // Append any tail events not yet persisted
            for (const ev of tail) {
                if (ev && ev.eventId && !seen.has(ev.eventId)) {
                    seen.add(ev.eventId);
                    out.push(ev);
                }
            }
            // Disk flush order and the in-memory tail can interleave — the UI
            // must always see chronological order (ISO ts sorts lexically).
            return stableSortByTs(out);
        } catch (_) {
            return stableSortByTs(tail.slice());
        }
    }

    _postEvent(ev) {
        const panel = this._panel;
        if (!panel) return;
        panel.webview.postMessage({ command: TO_WEBVIEW.EVENT_APPEND, event: ev });
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
            this._postSnapshot();
            // Late-arriving webview must learn whether steering is live.
            if (this._panel) this._panel.webview.postMessage({ command: 'steer.state', active: !!this._steerQueue });
            return;
        }
        if (c === FROM_WEBVIEW.ABORT_RUN)            return this._onCommand('abortRun');
        if (c === FROM_WEBVIEW.START_RESEARCH)       return this._onCommand('startResearch', { brief: String(msg.brief || '').trim() });
        if (c === 'startFairy')                      return this._onCommand('startFairy',    { brief: String(msg.brief || '').trim() });
        if (c === 'startDirector')                   return this._onCommand('startDirector', { brief: String(msg.brief || '').trim() });
        if (c === 'submitSteer' && typeof msg.text === 'string') {
            const text = msg.text.trim().slice(0, 500);
            if (text && this._steerQueue) {
                this._steerQueue.push(text);
                if (this._panel) this._panel.webview.postMessage({ command: 'steer.queued', text });
            }
            return;
        }
        if (c === FROM_WEBVIEW.OPEN_SETTINGS)        return this._onCommand('openSettings');
        if (c === FROM_WEBVIEW.CONFIGURE_PROVIDERS)  return this._onCommand('configureProviders');
        if (c === FROM_WEBVIEW.EMIT_MOCK_EVENTS)     return this._onCommand('emitMockEvents');
        if (c === FROM_WEBVIEW.LIST_HISTORICAL_RUNS) {
            this._listHistoricalRuns().then(runs => {
                if (this._panel) {
                    this._panel.webview.postMessage({ command: TO_WEBVIEW.HISTORICAL_RUN_LIST, runs });
                }
            });
            return;
        }
        if (c === FROM_WEBVIEW.LOAD_HISTORICAL_RUN && typeof msg.runId === 'string') {
            this._loadHistoricalRun(msg.runId).then(events => {
                if (this._panel) {
                    this._panel.webview.postMessage({ command: TO_WEBVIEW.HISTORICAL_RUN_LOADED, runId: msg.runId, events });
                }
            });
            return;
        }
        if (c === FROM_WEBVIEW.RUN_VSCODE_COMMAND && typeof msg.id === 'string') {
            vscode.commands.executeCommand(msg.id, ...(Array.isArray(msg.args) ? msg.args : []));
        }
        if (c === 'openFile' && typeof msg.path === 'string' && msg.path) {
            try { vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path)); } catch (_) {}
        }
    }

    // ── html ────────────────────────────────────────────────────────────────

    async _listHistoricalRuns() {
        const runsDir = project.telemetryRunsDir();
        if (!runsDir) return [];
        let ids;
        try {
            const files = await fsp.readdir(runsDir);
            ids = files
                .filter(f => f.endsWith('.jsonl'))
                .map(f => f.replace('.jsonl', ''))
                .sort()
                .reverse()
                .slice(0, 50);
        } catch (_) { return []; }
        // Enrich the newest runs with a cheap outcome summary: read head + tail
        // slices of each JSONL (not the whole file) and pull the brief + the
        // final status out of them. Older entries stay id-only.
        const out = [];
        for (let i = 0; i < ids.length; i++) {
            const rec = { runId: ids[i], brief: '', status: '', costUSD: null };
            if (i < 10) {
                try {
                    Object.assign(rec, await this._runOutcomeSummary(path.join(runsDir, ids[i] + '.jsonl')));
                } catch (_) {}
            }
            out.push(rec);
        }
        return out;
    }

    /** Head+tail scan of one run log → { brief, status, costUSD, questId }. */
    async _runOutcomeSummary(filePath) {
        const fh = await fsp.open(filePath, 'r');
        try {
            const { size } = await fh.stat();
            const headBuf = Buffer.alloc(Math.min(16384, size));
            await fh.read(headBuf, 0, headBuf.length, 0);
            let tailStr = '';
            if (size > headBuf.length) {
                const tailBuf = Buffer.alloc(Math.min(32768, size - headBuf.length));
                await fh.read(tailBuf, 0, tailBuf.length, size - tailBuf.length);
                tailStr = tailBuf.toString('utf8');
            }
            const parse = (str, fromPartial) => {
                const lines = str.split('\n');
                if (fromPartial) lines.shift();   // first tail line may be cut mid-JSON
                return lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
            };
            const head = parse(headBuf.toString('utf8'), false);
            const tail = tailStr ? parse(tailStr, true) : [];
            const res = { brief: '', status: '', costUSD: null, questId: null };
            for (const ev of head) {
                if (ev.type === 'circle.transition' && ev.payload && ev.payload.brief) { res.brief = String(ev.payload.brief).slice(0, 160); }
                if (ev.type === 'quest.accepted' && ev.payload) { res.questId = ev.payload.questId || null; if (!res.brief) res.brief = String(ev.payload.title || '').slice(0, 160); }
                if (res.brief && res.questId) break;
            }
            for (let i = tail.length - 1; i >= 0; i--) {
                const ev = tail[i]; const p = ev.payload || {};
                // A run whose final transition is ERROR/ABORTED must say so —
                // failed-in-BRIEFING runs used to show a blank status here.
                if (!res.status && ev.type === 'circle.transition' && (p.to === 'ERROR' || p.to === 'ABORTED')) res.status = p.to === 'ERROR' ? '⚠ error' : 'aborted';
                if (!res.status && ev.type === 'director.finished') res.status = 'director ' + ((p.outcome && p.outcome.status) || 'done');
                if (!res.status && ev.type === 'scroll.submitted')  res.status = p.status || '';
                if (res.costUSD == null && ev.type === 'fairy.run_metrics' && typeof p.costUSD === 'number') res.costUSD = p.costUSD;
                if (res.status && res.costUSD != null) break;
            }
            return res;
        } finally { await fh.close().catch(() => {}); }
    }

    async _loadHistoricalRun(runId) {
        const runsDir = project.telemetryRunsDir();
        if (!runsDir) return [];
        const filePath = path.join(runsDir, `${runId}.jsonl`);
        try {
            const content = await fsp.readFile(filePath, 'utf8');
            return stableSortByTs(content.trim().split('\n')
                .filter(l => l.trim())
                .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
                .filter(Boolean));
        } catch (_) { return []; }
    }

    _buildHtml(webview) {
        const nonce = makeNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'runInspector.webview.js'))
        );
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src  ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}' ${webview.cspSource}`,
        ].join('; ');

        const css = readSync(path.join(__dirname, 'runInspector.webview.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Oberon — Run Inspector</title>
<style>${css}</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar__title">Oberon</div>
    <div class="topbar__pill" id="statePill" data-state="IDLE">idle</div>
    <span class="topbar__meta" id="topbarMeta"></span>
    <select id="runPicker" title="Switch run view" style="font-size:11px;max-width:220px">
      <option value="live">⬤ Live</option>
    </select>
    <div class="topbar__spacer"></div>
    <span class="topbar__cost" id="topbarCost" title="Run cost so far"></span>
    <button data-cmd="abortRun" id="abortBtn" data-variant="danger" disabled>Abort</button>
    <button data-cmd="openSettings" data-variant="secondary">Settings</button>
  </header>

  <!-- Idle dashboard: launcher + recent runs. Shown when no run is active. -->
  <section class="hero hero--idle" id="idleHero" hidden>
    <div class="idle-launch">
      <div class="hero-title">Start a run</div>
      <textarea id="launchBrief" rows="2"
        placeholder="Describe a computation or research goal for the agent…"></textarea>
      <div class="idle-launch__row">
        <button id="launchFairy"    title="One fairy run: explore → verified clean.wb (5–30 min)">✦ Quick Compute</button>
        <button id="launchDirector" title="Multi-stage Director programme: plan → fairy stages → LaTeX report">◆ Director Research</button>
        <button id="launchResearch" data-variant="secondary" title="Single-quest pipeline with planner + skeptic">Research</button>
      </div>
    </div>
    <div class="idle-recent">
      <div class="hero-title">Recent runs</div>
      <div id="recentRuns" class="recent-runs"><span class="muted small">loading…</span></div>
    </div>
  </section>

  <!-- Live strip: what the agent is doing right now + steering. -->
  <section class="hero hero--live" id="liveHero" hidden>
    <div class="now-strip">
      <div class="now-head">
        <span class="now-phase" id="nowPhase">—</span>
        <span class="now-meta" id="nowMeta"></span>
        <span class="now-spacer"></span>
        <span class="now-activity" id="nowActivity"></span>
        <button class="now-toggle" id="nowToggle" title="Expand/collapse the live model stream">▾</button>
      </div>
      <div class="now-stream" id="nowStream">
        <div class="now-stream__label" id="nowStreamLabel">model stream</div>
        <pre class="now-stream__body" id="nowStreamBody"></pre>
      </div>
    </div>
    <div class="steer-bar">
      <textarea id="steerInput" rows="1" placeholder="Steer the agent — your note reaches it at its next turn…" disabled></textarea>
      <button id="steerBtn" disabled title="Queue a steering note for the fairy">Send</button>
      <span class="steer-ack muted small" id="steerAck"></span>
    </div>
  </section>

  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="timeline">Timeline</button>
    <button class="tab"        data-tab="fairy"    title="Fairy FSM phase stepper, step chain &amp; verification result">Fairy</button>
    <button class="tab"        data-tab="overview">Overview</button>
    <button class="tab"        data-tab="cost">Cost &amp; Tokens</button>
    <button class="tab"        data-tab="roles">Roles</button>
    <button class="tab"        data-tab="spans" disabled title="MVP-3">Span tree</button>
    <button class="tab"        data-tab="scrolls" disabled title="MVP-3">Scrolls</button>
    <button class="tab"        data-tab="wards" title="Independent verification results">Wards</button>
    <button class="tab"        data-tab="postmortem" title="Deterministic per-run postmortem">Postmortem</button>
    <button class="tab"        data-tab="prompts" title="System prompts used by each agent role">Prompts</button>
  </nav>

  <main class="panes">
    <section class="pane active" data-pane="timeline">
      <div class="filters">
        <div class="view-toggle" role="tablist" aria-label="Timeline view mode">
          <button class="view-toggle__btn active" data-view="structured" title="Aggregated by phase / charm / step — LLM calls grouped under their step">Structured</button>
          <button class="view-toggle__btn"        data-view="raw"        title="Every event as a single row">Raw events</button>
        </div>
        <input id="filterText"  placeholder="Filter (substring)" />
        <select id="filterType" title="Filter by event type — populated from this run's events">
          <option value="">All types</option>
        </select>
        <div class="filters__spacer"></div>
        <span class="muted" id="eventCount">0 events</span>
      </div>
      <div class="events-wrap" id="eventsWrap">
        <table class="events" id="eventsTable">
          <thead id="eventsHead">
            <tr><th>Time</th><th>Type</th><th>Role/Tool</th><th>Summary</th><th>Cost</th></tr>
          </thead>
          <tbody id="eventsBody"></tbody>
        </table>
        <div id="structuredBody" hidden></div>
      </div>
      <div class="detail-drawer" id="detailDrawer" hidden>
        <div class="detail-header">
          <span class="detail-title" id="detailTitle"></span>
          <button class="detail-close" id="detailClose" title="Close">✕</button>
        </div>
        <div class="detail-body" id="detailBody"></div>
      </div>
    </section>

    <!-- ── Fairy pane ─────────────────────────────────────────────────── -->
    <section class="pane" data-pane="fairy">
      <div id="fairyPaneContent" class="fairy-pane">
        <p class="muted small">No Fairy run yet — start a quest to see FSM activity here.</p>
      </div>
    </section>

    <section class="pane" data-pane="overview">
      <div class="grid">
        <div class="kv"><div class="kv__k">Run ID</div>     <div class="kv__v" id="ovRunId">—</div></div>
        <div class="kv"><div class="kv__k">Started</div>    <div class="kv__v" id="ovStarted">—</div></div>
        <div class="kv"><div class="kv__k">State</div>      <div class="kv__v" id="ovState">—</div></div>
        <div class="kv"><div class="kv__k">Quest</div>      <div class="kv__v" id="ovQuest">—</div></div>
        <div class="kv"><div class="kv__k">Charm</div>      <div class="kv__v" id="ovCharm">—</div></div>
        <div class="kv"><div class="kv__k">Events</div>     <div class="kv__v" id="ovEvents">0</div></div>
        <div class="kv"><div class="kv__k">LLM calls</div>  <div class="kv__v" id="ovLlmCalls">0</div></div>
        <div class="kv"><div class="kv__k">Total cost</div> <div class="kv__v" id="ovCost">$0.0000</div></div>
      </div>
    </section>

    <section class="pane" data-pane="cost">
      <table class="cost">
        <thead>
          <tr><th>Field</th><th>Total</th></tr>
        </thead>
        <tbody id="costBody"></tbody>
      </table>
      <p class="muted small">Cache fields show <code>n/a</code> when the provider does not report them — not zero.</p>
    </section>

    <section class="pane" data-pane="roles">
      <table class="roles">
        <thead>
          <tr><th>Role</th><th>Provider</th><th>Model</th><th>Input/M</th><th>Cache R/M</th><th>Cache W/M</th><th>Output/M</th><th>Status</th></tr>
        </thead>
        <tbody id="rolesBody"></tbody>
      </table>
      <div class="actions">
        <button data-cmd="configureProviders">Configure providers &amp; pricing</button>
        <button data-cmd="openSettings" data-variant="secondary">Open settings</button>
      </div>
    </section>

    <section class="pane" data-pane="wards">
      <div class="filters">
        <span class="muted" id="wardsSummary">no wards yet</span>
      </div>
      <table class="events">
        <thead>
          <tr><th>Ward</th><th>Method</th><th>Status</th><th>Detail</th><th>Expression</th><th>Duration</th></tr>
        </thead>
        <tbody id="wardsBody"></tbody>
      </table>
      <p class="muted small">Wards are <em>controlled automation for trusted local use</em>, not a sandbox. <code>skipped</code> means no verification method applied to that evidence shape — it is not a failure.</p>
    </section>

    <section class="pane" data-pane="postmortem">
      <div class="filters">
        <span class="muted" id="pmStatus">no postmortem yet</span>
        <div class="filters__spacer"></div>
        <button id="pmOpenBtn" data-cmd="openFile" data-target="" disabled>Open file</button>
      </div>
      <div class="kv"><div class="kv__k">Path</div><div class="kv__v"><code id="pmPath">—</code></div></div>
      <div class="kv"><div class="kv__k">Grimoire</div><div class="kv__v" id="pmGrimoire">—</div></div>
      <div class="kv"><div class="kv__k">Wards</div><div class="kv__v" id="pmWards">—</div></div>
      <p class="muted small">Postmortems are deterministic (no LLM).  Generated only when <code>wolfbook.oberon.postmortem.narrativeEnabled</code> is on.</p>
    </section>

    <section class="pane" data-pane="prompts">
      <div id="promptsBody"></div>
      <p class="muted small">These are the live system prompts sent to each LLM role.  They update whenever the extension reloads.</p>
    </section>
  </main>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function readSync(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}
/** Stable chronological sort (ISO ts strings compare lexically; missing ts keeps arrival order). */
function stableSortByTs(events) {
    return events
        .map((ev, i) => ({ ev, i }))
        .sort((a, b) => {
            const ta = (a.ev && a.ev.ts) || '';
            const tb = (b.ev && b.ev.ts) || '';
            if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
            return a.i - b.i;
        })
        .map(x => x.ev);
}
function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

module.exports = { RunInspectorManager, VIEW_TYPE };
