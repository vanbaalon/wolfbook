'use strict';
/**
 * Oberon — Charm Debugger (WebviewPanel).
 *
 * Core feature: run a Charm in complete isolation — bypassing Planner,
 * Dispatcher, and RunManager — with editable system prompt and tool specs.
 * Streams live events back to the webview as the Fairy runs.
 *
 * Pattern mirrors runInspector.js (singleton WebviewPanel).
 */

const vscode  = require('vscode');
const path    = require('path');
const fs      = require('fs');
const EventEmitter = require('events');

const { TO_WEBVIEW, FROM_WEBVIEW } = require('./stateProtocol');
const project      = require('../memory/project');
const { extractExamples } = require('../memory/exampleExtractor');
const wolframShim  = require('../core/wolframShim');

const VIEW_TYPE = 'wolfbook.oberon.charmDebugger';

class CharmDebuggerManager {
    /**
     * @param {{
     *   context:   import('vscode').ExtensionContext,
     *   bus:       import('../telemetry/bus').TelemetryBus,
     *   onCommand: (cmd: string, payload?: any) => void
     * }} deps
     */
    constructor(deps) {
        this._context    = deps.context;
        this._mainBus    = deps.bus;
        this._onCommand  = deps.onCommand;
        /** @type {vscode.WebviewPanel | null} */
        this._panel = null;
        /** @type {AbortController | null} */
        this._abortController = null;
    }

    show(opts) {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Active, false);
            // If a prefill task was provided, forward it to the open webview.
            if (opts && opts.prefillTask) {
                this._panel.webview.postMessage({
                    command: TO_WEBVIEW.ISOLATED_RUN_EVENT,
                    event: { type: 'prefill.task', task: opts.prefillTask },
                });
            }
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            'Oberon: Charm Debugger',
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
        this._panel      = panel;
        this._prefillTask = (opts && opts.prefillTask) || null;
        panel.iconPath = vscode.Uri.file(
            path.join(this._context.extensionPath, 'media', 'oberon.svg')
        );
        panel.webview.html = this._buildHtml(panel.webview);
        panel.webview.onDidReceiveMessage((msg) => this._onMessage(msg || {}));
        panel.onDidDispose(() => {
            this._abortController && this._abortController.abort();
            this._panel = null;
            this._prefillTask = null;
        });
    }

    dispose() {
        this._abortController && this._abortController.abort();
        if (this._panel) { try { this._panel.dispose(); } catch (_) {} }
        this._panel = null;
    }

    // ── inbound ──────────────────────────────────────────────────────────────

    _onMessage(msg) {
        const c = msg.command;
        if (c === FROM_WEBVIEW.SCRIPT_LOADED)       return this._onReady();
        if (c === FROM_WEBVIEW.LIST_CHARM_EXAMPLES)  return this._sendExamples();
        if (c === FROM_WEBVIEW.GET_PROMPTS)          return this._sendPrompts();
        if (c === FROM_WEBVIEW.RERUN_CHARM)          return this._rerunCharm(msg.example || {}, msg.overrides || {});
        if (c === FROM_WEBVIEW.ABORT_ISOLATED_RUN)   return this._abortRun();
        if (c === FROM_WEBVIEW.OPEN_SETTINGS)        return this._onCommand('openSettings');
        if (c === FROM_WEBVIEW.RUN_VSCODE_COMMAND && typeof msg.id === 'string') {
            vscode.commands.executeCommand(msg.id, ...(Array.isArray(msg.args) ? msg.args : []));
        }
        if (c === 'openFile' && typeof msg.path === 'string' && msg.path) {
            try { vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path)); } catch (_) {}
        }
    }

    _onReady() {
        this._sendExamples();
        this._sendPrompts();
        if (this._prefillTask) {
            this._panel && this._panel.webview.postMessage({
                command: TO_WEBVIEW.ISOLATED_RUN_EVENT,
                event: { type: 'prefill.task', task: this._prefillTask },
            });
            this._prefillTask = null;
        }
    }

    // ── examples ─────────────────────────────────────────────────────────────

    async _sendExamples() {
        const panel = this._panel;
        if (!panel) return;
        try {
            const runsDir = project.telemetryRunsDir();
            const examples = runsDir ? await extractExamples(runsDir) : [];
            panel.webview.postMessage({ command: TO_WEBVIEW.CHARM_EXAMPLES, examples });
        } catch (e) {
            panel.webview.postMessage({ command: TO_WEBVIEW.CHARM_EXAMPLES, examples: [], error: String(e) });
        }
    }

    // ── prompts snapshot ─────────────────────────────────────────────────────

    _sendPrompts() {
        const panel = this._panel;
        if (!panel) return;
        try {
            const { FAIRY_SYSTEM_PROMPT } = require('../fairy/prompts');
            const { FAIRY_TOOL_SPECS } = require('../fairy/toolSpecs');
            const toolSpecs = FAIRY_TOOL_SPECS.map(s => ({
                name:        s.function.name,
                description: s.function.description,
                fullSpec:    s,
            }));
            panel.webview.postMessage({
                command: TO_WEBVIEW.PROMPTS_SNAPSHOT,
                systemPrompt: FAIRY_SYSTEM_PROMPT,
                toolSpecs,
            });
        } catch (e) {
            panel.webview.postMessage({
                command: TO_WEBVIEW.PROMPTS_SNAPSHOT,
                systemPrompt: '',
                toolSpecs: [],
                error: String(e),
            });
        }
    }

    // ── isolation runner ─────────────────────────────────────────────────────

    _abortRun() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    async _rerunCharm(example, overrides) {
        const panel = this._panel;
        if (!panel) return;

        // Abort any previous run.
        if (this._abortController) this._abortController.abort();
        this._abortController = new AbortController();
        const signal = this._abortController.signal;

        // Build quest and charm from example + any user edits.
        const quest = overrides.quest || example.quest;
        const charm = overrides.charm || example.charm;

        if (!quest || !quest.id) {
            panel.webview.postMessage({
                command: TO_WEBVIEW.ISOLATED_RUN_DONE,
                scroll: null,
                error: 'Example has no quest data. Cannot re-run.',
            });
            return;
        }
        if (!charm || !charm.id) {
            panel.webview.postMessage({
                command: TO_WEBVIEW.ISOLATED_RUN_DONE,
                scroll: null,
                error: 'Example has no charm data. Cannot re-run.',
            });
            return;
        }

        // Reconstruct full OpenAI tool specs from edited descriptions.
        let toolSpecsOverride;
        if (overrides.toolDescriptions && typeof overrides.toolDescriptions === 'object') {
            const { FAIRY_TOOL_SPECS } = require('../fairy/toolSpecs');
            toolSpecsOverride = FAIRY_TOOL_SPECS.map(s => {
                const desc = overrides.toolDescriptions[s.function.name];
                if (typeof desc === 'string' && desc.trim()) {
                    return { ...s, function: { ...s.function, description: desc } };
                }
                return s;
            });
        }

        // Create a proxy bus that streams events to the webview and handles
        // live notebook updates: opens working.wb on fairy.started, inserts
        // probe cells live, and opens/runs clean.wb on delivery.
        let _probeNbDoc = null;
        const proxyBus = makeProxyBus(panel, TO_WEBVIEW.ISOLATED_RUN_EVENT, async (ev) => {
            // fairy.started → open working.wb beside the Charm Debugger panel
            if (ev.type === 'fairy.started') {
                const nbPath = ev.payload && ev.payload.workingNbPath;
                if (nbPath && !_probeNbDoc) {
                    try {
                        _probeNbDoc = await vscode.workspace.openNotebookDocument(
                            vscode.Uri.file(nbPath));
                        // Clear stale cells from the previous run (in-memory doc persists).
                        if (_probeNbDoc.cellCount > 0) {
                            const clearEdit = new vscode.WorkspaceEdit();
                            clearEdit.set(_probeNbDoc.uri, [
                                vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(0, _probeNbDoc.cellCount)),
                            ]);
                            await vscode.workspace.applyEdit(clearEdit);
                        }
                        await vscode.window.showNotebookDocument(_probeNbDoc, {
                            viewColumn:    vscode.ViewColumn.Beside,
                            preserveFocus: true,
                        });
                        // Force controller association so evalInNotebook can use
                        // createNotebookCellExecution without "not associated" errors.
                        // onDidOpenNotebookDocument does not re-fire for cached docs.
                        await wolframShim.associateNotebook(_probeNbDoc).catch(() => {});
                    } catch (_) {}
                }
                return;
            }
            // probe.appended — cells are inserted live by evalInNotebook; nothing to do here.
        });

        try {
            const { runFairy } = require('../core/fairy');
            const result = await runFairy({
                quest,
                charm,
                bus:    proxyBus,
                signal,
                getWorkingNbDoc: () => _probeNbDoc,
                systemPromptOverride: overrides.systemPrompt || undefined,
                toolSpecsOverride,
                writeNotebook: async (_cells, destPath) => {
                    // harness already wrote correct JSON to disk; just open the tab
                    const nbUri = vscode.Uri.file(destPath);
                    const nbDoc = await vscode.workspace.openNotebookDocument(nbUri);
                    await vscode.window.showNotebookDocument(nbDoc, {
                        viewColumn:    vscode.ViewColumn.Beside,
                        preserveFocus: true,
                    });
                    return destPath;
                },
            });
            if (!panel) return;
            // If delivery produced clean.wb, restart kernel then open and run it.
            if (result && result.cleanNbPath) {
                try {
                    await wolframShim.restartKernel().catch(() => {});
                    const cleanDoc = await vscode.workspace.openNotebookDocument(
                        vscode.Uri.file(result.cleanNbPath));
                    await vscode.window.showNotebookDocument(cleanDoc, {
                        viewColumn:    vscode.ViewColumn.Active,
                        preserveFocus: false,
                    });
                    await new Promise(r => setTimeout(r, 1200));
                    await vscode.commands.executeCommand('notebook.executeAll');
                } catch (_) {}
            }
            panel.webview.postMessage({
                command: TO_WEBVIEW.ISOLATED_RUN_DONE,
                scroll: result.scroll,
                error:  null,
            });
        } catch (e) {
            if (!panel) return;
            // Suppress abort errors — user clicked Abort intentionally.
            if (signal.aborted || (e && e.name === 'AbortError')) {
                panel.webview.postMessage({
                    command: TO_WEBVIEW.ISOLATED_RUN_DONE,
                    scroll: null,
                    error:  'Run aborted by user.',
                });
                return;
            }
            panel.webview.postMessage({
                command: TO_WEBVIEW.ISOLATED_RUN_DONE,
                scroll: null,
                error:  String(e && e.message || e),
            });
        }
    }

    // ── html ─────────────────────────────────────────────────────────────────

    _buildHtml(webview) {
        const nonce = makeNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(__dirname, 'charmDebugger.webview.js'))
        );
        const css = readSync(path.join(__dirname, 'charmDebugger.webview.css'));
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Oberon — Charm Debugger</title>
<style>${css}</style>
</head>
<body>
  <div id="root">
    <header class="cd-header">
      <div class="cd-title">Oberon <span class="cd-sub">Charm Debugger</span></div>
      <div class="cd-header-actions">
        <button id="newTaskBtn" class="cd-btn cd-btn--accent" title="Run a new task directly without going through the Planner">+ New Task</button>
        <input id="filterInput" type="text" placeholder="Filter…" autocomplete="off">
        <button id="refreshBtn" title="Reload from telemetry">↺</button>
      </div>
    </header>
    <div class="cd-body">
      <div id="leftPanel" class="cd-left">
        <div id="exampleStatus" class="cd-list-status">Loading…</div>
        <div id="exampleList" class="cd-list"></div>
      </div>
      <div id="rightPanel" class="cd-right">
        <div id="noSelection" class="cd-no-selection">
          ← Select a charm run from the list to debug it
        </div>
        <div id="debugPanel" class="cd-debug-panel" hidden>
          <div class="cd-charm-header">
            <div class="cd-charm-title" id="selectedCharmTitle"></div>
            <div class="cd-run-controls">
              <button id="runBtn" class="cd-btn cd-btn--primary">⚡ Run Isolated</button>
              <button id="abortBtn" class="cd-btn" disabled>⬛ Abort</button>
              <span id="runStatus" class="cd-run-status"></span>
            </div>
          </div>
          <div class="cd-tabs">
            <button class="cd-tab active" data-tab="run">Live Run</button>
            <button class="cd-tab" data-tab="prompt">System Prompt</button>
            <button class="cd-tab" data-tab="tools">Tools</button>
            <button class="cd-tab" data-tab="charm">Charm / Quest</button>
          </div>
          <div class="cd-tab-body">
            <div id="tab-run" class="cd-tab-pane active">
              <div id="runFeed" class="cd-run-feed"></div>
              <div id="runCostBar" class="cd-cost-bar" hidden></div>
              <div id="runResult" class="cd-run-result" hidden></div>
            </div>
            <div id="tab-prompt" class="cd-tab-pane" hidden>
              <div class="cd-editor-label">
                System Prompt
                <button class="cd-btn cd-btn--sm" id="resetPromptBtn">Reset to default</button>
                <span class="cd-char-count" id="promptCharCount"></span>
              </div>
              <textarea id="promptEditor" class="cd-editor" spellcheck="false"></textarea>
            </div>
            <div id="tab-tools" class="cd-tab-pane" hidden>
              <div class="cd-editor-label">
                Tool Descriptions
                <button class="cd-btn cd-btn--sm" id="resetToolsBtn">Reset all</button>
              </div>
              <div id="toolEditors"></div>
            </div>
            <div id="tab-charm" class="cd-tab-pane" hidden>
              <div id="taskTemplateSection" class="cd-template-section" hidden>
                <div class="cd-template-label">
                  Pick a starting point:
                  <button id="dismissTemplatesBtn" class="cd-btn cd-btn--sm">hide</button>
                </div>
                <div id="templateGrid" class="cd-template-grid"></div>
              </div>
              <div class="cd-charm-editors">
                <div class="cd-editor-label">Quest</div>
                <textarea id="questEditor" class="cd-editor cd-editor--sm" spellcheck="false"></textarea>
                <div class="cd-editor-label" style="margin-top:8px">Charm</div>
                <textarea id="charmEditor" class="cd-editor cd-editor--sm" spellcheck="false"></textarea>
                <div class="cd-editor-label" style="margin-top:8px">Validation Checks (one per line)</div>
                <textarea id="validationEditor" class="cd-editor cd-editor--xs" spellcheck="false" placeholder="e.g. Eigenvalues[hMatrix] // Min > -4.0"></textarea>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

// ── proxy bus ─────────────────────────────────────────────────────────────────

// onEvent(ev) — called for every event. ev has {type, payload} matching
// the real TelemetryBus shape so callers can use the same field names.
function makeProxyBus(panel, eventCommand, onEvent) {
    const ee = new EventEmitter();
    ee.setMaxListeners(50);
    return {
        appendEvent: async (kind, data, spanCtx) => {
            // Proxy-bus shape (for webview / EventEmitter consumers)
            const ev = {
                kind,
                data:      data || {},
                timestamp: new Date().toISOString(),
                ...(spanCtx || {}),
            };
            // Normalised shape (matching TelemetryBus) for the onEvent callback
            const evNorm = { type: kind, payload: data || {}, ts: ev.timestamp, ...(spanCtx || {}) };
            if (typeof onEvent === 'function') {
                try { onEvent(evNorm); } catch (_) {}
            }
            if (panel && panel.webview) {
                try { panel.webview.postMessage({ command: eventCommand, event: ev }); } catch (_) {}
            }
            ee.emit('event', ev);
        },
        on:             (ev, fn) => ee.on(ev, fn),
        removeListener: (ev, fn) => ee.removeListener(ev, fn),
        filePath: null,
        recent:   () => [],
    };
}

// ── utils ─────────────────────────────────────────────────────────────────────

function readSync(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

module.exports = { CharmDebuggerManager };
