'use strict';
/**
 * Oberon — public activation surface.
 *
 * This is the ONLY module `extension.js` should import. It is responsible for:
 *   - constructing the singletons (TelemetryBus, RunManager, UI providers)
 *   - registering the sidebar WebviewViewProvider
 *   - registering all `wolfbook.oberon.*` commands
 *   - the first-run .gitignore prompt
 *   - the mock-event demo wiring (MVP-0)
 *
 * Returns a small handle so the rest of the extension can call back into
 * Oberon (e.g. future Wolfbook → Oberon `correlationId` plumbing).
 */

const vscode = require('vscode');

const project        = require('./memory/project');
const settings       = require('./config/settings');
const roles          = require('./config/roles');
const { TelemetryBus, makeSpanId } = require('./telemetry/bus');
const { RunManager }               = require('./core/runManager');
const { ControlRoomProvider, VIEW_ID: SIDEBAR_VIEW_ID } = require('./ui/controlRoom');
const { RunInspectorManager }                            = require('./ui/runInspector');
const { CharmDebuggerManager }                           = require('./ui/charmDebugger');
const { runPlanner }                                     = require('./core/planner');
const { dispatchCharm, dispatchCharms, buildCharms }     = require('./core/dispatcher');
const { runFairy }                                       = require('./core/fairy');
const { clarifyQuestGate, applyDeclaredAssumptions }     = require('./core/research');
const { runExecutiveAnalysis }                           = require('./core/executive');
const establishedFacts                                   = require('./memory/establishedFacts');
const wolframShim                                        = require('./core/wolframShim');
const { TestSuiteRunner }                                = require('./tests/runner');
const { TestResultsPanel }                               = require('./ui/testResultsPanel');
const { prepareCharmNotebook }                           = require('./memory/charmNotebook');
const { prepareSummaryNotebook }                         = require('./memory/summaryNotebook');
const { populateResearchNotebooks }                      = require('./memory/populateNotebooks');
const { runScribe }                                      = require('./core/scribe');
const analyst                                            = require('./director/analyst');
const { writePostmortem, writeErrorPostmortem }          = require('./memory/postmortem');
const toolRegistry                                       = require('./core/toolRegistry');

/**
 * Activate Oberon. Idempotent: safe to call once per extension activation.
 *
 * @param {import('vscode').ExtensionContext} context
 * @returns {{
 *   bus: TelemetryBus,
 *   runManager: RunManager,
 *   inspector: RunInspectorManager,
 *   sidebar:   ControlRoomProvider,
 *   correlate: (correlationId: string|null, fn: Function) => any
 * }}
 */
function activate(context, opts = {}) {
    require('./fairy/skilxivCredentials').configure(context);

    // Drop stale run logs before anything writes a new one. Telemetry had no retention
    // policy and had grown to 284 MB across 122 runs. Fire-and-forget: a failed prune
    // must never block activation.
    project.pruneTelemetry()
        .then(n => { if (n > 0) console.log(`[oberon] pruned ${n} stale telemetry run log(s)`); })
        .catch(() => {});

    const bus             = new TelemetryBus();
    // Telemetry drops were previously invisible: a Dropbox sync lock could hang
    // the JSONL append chain and silently lose a whole run's events. Surface the
    // first drop of each run to the user; log every one to the console.
    let _telemetryDropWarned = false;
    bus.on('writeError', ({ error, dropped }) => {
        try { console.warn(`[oberon] telemetry write failed (${dropped} dropped so far): ${error}`); } catch (_) {}
        if (!_telemetryDropWarned) {
            _telemetryDropWarned = true;
            try {
                vscode.window.showWarningMessage(
                    `Oberon: telemetry events are failing to persist (${error}). ` +
                    'The run continues, but the JSONL log will be incomplete.');
            } catch (_) {}
        }
    });
    bus.on('runBegin', () => { _telemetryDropWarned = false; });
    const runManager      = new RunManager(bus);
    const inspector       = new RunInspectorManager({ context, runManager, bus, onCommand: dispatch });
    const charmDebugger   = new CharmDebuggerManager({ context, bus, onCommand: dispatch });
    const sidebar         = new ControlRoomProvider({ runManager, bus, onCommand: dispatch });
    const testRunner      = new TestSuiteRunner({
        bus, runManager,
        // Same live quick-compute path as wolfbook_fairy_dispatch; `dispatch`
        // is resolved at call time (suite runs long after activation).
        dispatchBrief: (payload) => dispatch('startFairy', payload),
        // Run reports land in workspace state; a blessed report is copied to
        // <repo>/oberon/tests/baselines/ by hand when promoting a baseline.
        outDir: (() => { try { const o = project.oberonDir(); return o ? require('path').join(o, 'gold') : null; } catch (_) { return null; } })(),
    });
    const testResultsPanel = new TestResultsPanel({ context, runner: testRunner, runManager });
    const { ContributionReviewPanel } = require('./ui/contributionReview');
    const contributionReviewPanel = new ContributionReviewPanel(context);
    const { SkilXivExplorerPanel } = require('./ui/skilxivExplorer');
    const skilxivExplorer = new SkilXivExplorerPanel(context);
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri(uri) {
            if (uri.path === '/skilxiv/open') skilxivExplorer.open(new URLSearchParams(uri.query).get('ref') || '');
        },
    }));

    // Wire the Wolfram kernel shim. The controller is created LATER in
    // extension.js, so callers may also use `setKernelController()` on the
    // returned handle for late binding.
    if (typeof opts.getController === 'function') {
        wolframShim.setControllerProvider(opts.getController);
    }

    // Wire notebook read/edit tools for the Fairy.
    // These require access to VS Code's notebook editor, provided via opts.
    if (typeof opts.getNotebookContext === 'function' || typeof opts.editNotebookCell === 'function') {
        toolRegistry.setNotebookToolProvider({
            getNotebookContext: opts.getNotebookContext || (() => Promise.resolve('(not available)')),
            editCell:           opts.editNotebookCell  || (() => Promise.resolve('(not available)')),
        });
    }

    // Sidebar registration.
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SIDEBAR_VIEW_ID,
            sidebar,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    // Commands.
    const cmds = [
        ['wolfbook.oberon.openRunInspector',   () => inspector.show()],
        ['wolfbook.oberon.openCharmDebugger',  () => charmDebugger.show()],
        ['wolfbook.oberon.startResearch',    async () => {
            const brief = await vscode.window.showInputBox({
                prompt: 'Describe a research task for Oberon',
                placeHolder: 'Investigate convergence of the series …',
                ignoreFocusOut: true,
            });
            if (brief && brief.trim()) await dispatch('startResearch', { brief: brief.trim() });
        }],
        // Minimal Fairy run — no Planner, no Skeptic critic, no Oberon report. The default
        // quick-compute path. Routes to the full pipeline only when the experimental
        // Oberon mode is enabled (wolfbook.oberon.experimentalPipeline).
        ['wolfbook.oberon.startFairy',    async (arg) => {
            // The Agents panel passes the prompt directly ({ brief } or a raw string);
            // the command-palette invocation (no arg) falls back to an input box.
            let brief = (typeof arg === 'string') ? arg
                      : (arg && typeof arg.brief === 'string') ? arg.brief : '';
            if (!brief.trim()) {
                brief = await vscode.window.showInputBox({
                    prompt: 'Fairy quick compute — what should it compute?',
                    placeHolder: 'Eigenvalues of the L=4 Heisenberg Hamiltonian …',
                    ignoreFocusOut: true,
                }) || '';
            }
            if (!(brief && brief.trim())) return;
            const fullPipeline = !!vscode.workspace.getConfiguration('wolfbook').get('oberon.experimentalPipeline');
            await dispatch(fullPipeline ? 'startResearch' : 'startFairy', { brief: brief.trim() });
        }],
        ['wolfbook.oberon.abortRun',           () => dispatch('abortRun')],
        ['wolfbook.oberon.openSettings',       () => settings.openSettingsUI()],
        ['wolfbook.oberon.configureProviders', () => settings.openProviderSettingsUI()],
        ['wolfbook.oberon.emitMockEvents',     () => emitMockEvents({ bus, runManager })],
        ['wolfbook.oberon.runTestSuite', () => testResultsPanel.show()],
        ['wolfbook.oberon.openRunLog', async () => {
            const fp = bus.filePath;
            if (fp) {
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fp));
            } else {
                // No active run — try to find the latest JSONL in the runs dir
                const runsDir = project.telemetryRunsDir();
                if (!runsDir) { vscode.window.showWarningMessage('Oberon: no telemetry log found.'); return; }
                const fs = require('fs');
                let files;
                try { files = fs.readdirSync(runsDir).filter(f => f.endsWith('.jsonl')); } catch (_) { files = []; }
                if (!files.length) { vscode.window.showWarningMessage('Oberon: no run logs found yet.'); return; }
                files.sort();
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(require('path').join(runsDir, files[files.length - 1])));
            }
        }],
        ['wolfbook.oberon.bumpAndDeploy', () => dispatch('bumpAndDeploy')],
        ['wolfbook.oberon.reviewContributions', () => contributionReviewPanel.open()],
        ['wolfbook.skilxiv.openExplorer', (arg) => skilxivExplorer.open(typeof arg === 'string' ? arg : '')],
        // Stage A3: claims the kernel disproved in skills we recalled — the
        // author's revision queue. A wrong claim in a trusted skill misleads
        // every later run, so this must be visible, not buried in telemetry.
        ['wolfbook.skilxiv.reviewSkillCorrections', async () => {
            const sc = require('./memory/skillCorrections');
            const queue = await sc.correctionQueue();
            if (!queue.length) {
                vscode.window.showInformationMessage('No skill contradictions recorded — every cited skill has held up in the kernel.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument({
                content: sc.renderCorrectionQueue(queue), language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: false });
        }],
        ['wolfbook.skilxiv.reviewSkillGaps', async () => {
            // Stage A1 (2026-08-04): the raw ledger had grown to 78 entries and was
            // unusable as a list — near-duplicate topics recur across months. Show
            // the RANKED authoring queue (clustered, by distinct-run demand) and
            // offer the full queue as a document.
            const sg = require('./memory/skillGaps');
            const ranked = await sg.rankSkillGaps({ limit: 25 });
            if (!ranked.length) { vscode.window.showInformationMessage('No local SkilXiv skill gaps recorded.'); return; }
            const OPEN_QUEUE = '$(list-ordered) Open the full authoring queue…';
            const choice = await vscode.window.showQuickPick(
                [{ label: OPEN_QUEUE, description: `${ranked.length} clustered capabilities` },
                 ...ranked.map(c => ({
                     label: c.topic,
                     description: `${c.runs} run(s) wanted this`,
                     detail: c.tasks[0] ? `e.g. ${String(c.tasks[0]).slice(0, 100)}` : undefined,
                     cluster: c,
                 }))],
                { placeHolder: 'Skill-gap queue — most-demanded capability first' });
            if (!choice) return;
            if (choice.label === OPEN_QUEUE) {
                const doc = await vscode.workspace.openTextDocument({
                    content: sg.renderGapQueue(ranked), language: 'markdown' });
                await vscode.window.showTextDocument(doc, { preview: false });
                return;
            }
            // Submitting a public request needs one concrete ledger entry.
            const all = await sg.loadSkillGaps();
            const gap = all.slice().reverse().find(g => g.topic === choice.cluster.topic) || all[all.length - 1];
            const picked = { gap };
            if (!picked) return;
            const yes = await vscode.window.showWarningMessage(`Submit this public skill request to SkilXiv?\n\n${picked.gap.topic}\n\nOnly the displayed topic and short reason will be sent.`, { modal: true }, 'Submit request');
            if (yes !== 'Submit request') return;
            const cfg = require('./config/settings').recall();
            const client = await require('./fairy/skilxivCredentials').createClient({ baseUrl: cfg.skilxivBaseUrl });
            await require('./memory/skillGaps').submitSkillGap(picked.gap, client);
            vscode.window.showInformationMessage('Skill request submitted with your consent.');
        }],

        // ── Headless agent API (MCP: wolfbook_fairy_dispatch / wolfbook_fairy_status) ──
        // No dialogs, structured returns — an outside agent (Claude/Codex/…) uses the
        // Fairy as a cheap, kernel-verified computation sub-agent.
        ['wolfbook.oberon.fairyDispatch', async (args) => {
            const brief = String((args && args.task) || '').trim();
            if (!brief) return { ok: false, error: 'task is required (a complete, self-contained computation spec).' };
            if (!roles.minimallyConfigured()) {
                return { ok: false, error: 'Oberon LLM roles are not configured — set a provider API key + model under wolfbook.oberon settings.' };
            }
            if (runManager.isActive) {
                return { ok: false, error: `A run is already active (${(runManager.summary && runManager.summary.runId) || 'unknown'}). Poll wolfbook_fairy_status or abort it (command: Oberon: Abort Run).` };
            }
            // Numbered, descriptive folder name (short LLM slug + heuristic fallback):
            // quests/Q05_heisenberg_l4_spectrum/. Derived up front so the charmDir we
            // return matches the folder the run actually creates.
            let naming = { id: null, shortName: null };
            try { naming = await require('./core/questNaming').deriveQuestNaming(brief); } catch (_) {}
            const questId   = naming.id || ('Q_' + Date.now().toString(36).slice(-6).toUpperCase());
            const shortName = naming.shortName || questId;
            const validationChecks = Array.isArray(args && args.validationChecks)
                ? args.validationChecks.map(String).filter(s => s.trim()).slice(0, 8) : [];
            // Fire-and-forget: the run takes minutes; the caller polls fairyStatus.
            dispatch('startFairy', { brief, questId, shortName, validationChecks }).catch(() => {});
            // Wait briefly for the run to register so the caller gets a runId.
            let runId = null;
            for (let i = 0; i < 30 && !runId; i++) {
                await new Promise(r => setTimeout(r, 100));
                runId = bus.runId || null;
            }
            const qDir = project.questsDir();
            const pth = require('path');
            const charmDir = qDir ? pth.join(qDir, `${questId}_${shortName}`, 'charms', 'C01') : null;
            return {
                ok: true, runId, questId, charmDir,
                artifacts: charmDir ? {
                    workingNb: pth.join(charmDir, 'working.wb'),
                    cleanNb:   pth.join(charmDir, 'clean.wb'),
                    partialNb: pth.join(charmDir, 'clean_partial.wb'),
                } : null,
                note: 'Run started in the background (typical duration 5–30 min). Poll wolfbook_fairy_status. ' +
                      'The run RESTARTS the shared Wolfram kernel — interactive kernel state is lost while it works.',
            };
        }],
        ['wolfbook.oberon.fairyStatus', async (args) => {
            const fs  = require('fs');
            const pth = require('path');
            const runsDir = project.telemetryRunsDir();
            if (!runsDir) return { ok: false, error: 'No telemetry directory (no workspace open?).' };
            let runId = String((args && args.runId) || '').replace(/\.jsonl$/, '');
            if (!runId) {
                let files = [];
                try { files = fs.readdirSync(runsDir).filter(f => f.endsWith('.jsonl')).sort(); } catch (_) {}
                if (!files.length) return { ok: false, error: 'No runs found.' };
                runId = files[files.length - 1].replace(/\.jsonl$/, '');
            }
            const file = pth.join(runsDir, runId + '.jsonl');
            let lines;
            try { lines = fs.readFileSync(file, 'utf8').trim().split('\n'); }
            catch (_) { return { ok: false, error: `Run '${runId}' not found.` }; }
            const events = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

            const started  = events.find(e => e.type === 'fairy.started');
            const phases   = events.filter(e => e.type === 'fairy.phase');
            const scroll   = events.find(e => e.type === 'scroll.submitted');
            const metricsEv = events.find(e => e.type === 'fairy.run_metrics');
            const statusEvs = events.filter(e => e.type === 'fairy.status');
            const probeEvs  = events.filter(e => e.type === 'probe.appended');
            const p = (e) => (e && e.payload) || {};

            const charmDir = p(started).charmDir || null;
            const artifacts = {};
            if (charmDir) {
                for (const [k, f] of [['workingNb', 'working.wb'], ['cleanNb', 'clean.wb'], ['partialNb', 'clean_partial.wb'], ['checkpointNb', 'clean_in_progress.wb']]) {
                    const fp = pth.join(charmDir, f);
                    if (fs.existsSync(fp)) artifacts[k] = fp;
                }
            }
            let facts = [];
            try { facts = JSON.parse(fs.readFileSync(pth.join(charmDir, 'facts.json'), 'utf8')); } catch (_) {}

            const lastStatus = statusEvs.length ? p(statusEvs[statusEvs.length - 1]) : {};
            const done = !!scroll || !!lastStatus.done;
            return {
                ok: true, runId,
                active: !done && runManager.isActive,
                phase: phases.length ? p(phases[phases.length - 1]).phase : (started ? 'starting' : 'unknown'),
                status: scroll ? p(scroll).status : (done ? (lastStatus.status || 'unknown') : 'running'),
                build: p(started).build || null,
                progress: {
                    probesUsed: lastStatus.probesUsed ?? null,
                    turnsUsed:  lastStatus.turnsUsed ?? null,
                    costUSD:    lastStatus.costUSD ?? null,
                },
                metrics: metricsEv ? p(metricsEv) : null,
                artifacts,
                facts: facts.slice(0, 10).map(f => ({ key: f.key, value: String(f.value).slice(0, 300), confidence: f.confidence })),
                recentActivity: probeEvs.slice(-3).map(e => ({ probeId: p(e).probeId, note: String(p(e).note || '').slice(0, 160) })),
                note: done
                    ? (scroll && p(scroll).status === 'delivered'
                        ? 'Delivered: clean.wb is the verified notebook; facts carry the headline results.'
                        : 'Run ended — inspect artifacts and metrics; a partial run still leaves clean_partial.wb / checkpoints.')
                    : 'Still running — poll again in ~60s.',
            };
        }],

        // ── Headless gold-suite API (MCP: wolfbook_gold_run / wolfbook_gold_status) ──
        // Kernel-verified benchmark of the live pipeline (Stage 0 of the agent
        // upgrade plan). Fire-and-forget; poll goldStatus. Grading is machine-
        // only: fresh kernel → replay clean.wb → task verifier.
        ['wolfbook.oberon.goldRun', async (args) => {
            if (!roles.minimallyConfigured()) {
                return { ok: false, error: 'Oberon LLM roles are not configured.' };
            }
            if (testRunner.isRunning) return { ok: false, error: 'Gold suite already running — poll wolfbook.oberon.goldStatus.' };
            if (runManager.isActive) {
                return { ok: false, error: `A run is already active (${(runManager.summary && runManager.summary.runId) || 'unknown'}).` };
            }
            let tasks;
            try { tasks = require('./tests/goldRunner').resolveTasks(args && args.tasks); }
            catch (e) { return { ok: false, error: e.message }; }
            const label = String((args && args.label) || 'gold');
            // Fire-and-forget: a full suite takes hours; subsets are the day-to-day tool.
            testRunner.run({ taskIds: tasks.map(t => t.id), label }).catch(() => {});
            return {
                ok: true, started: true, label,
                tasks: tasks.map(t => ({ id: t.id, title: t.title, verify: t.verify })),
                note: `Dispatching ${tasks.length} task(s) sequentially through the live fairy pipeline ` +
                      '(each 5–30 min + fresh-kernel verification). Poll wolfbook.oberon.goldStatus; ' +
                      'reports are written under .oberon/gold/.',
            };
        }],
        ['wolfbook.oberon.goldStatus', async () => {
            const rep = testRunner.lastReport;
            return {
                ok: true,
                running: testRunner.isRunning,
                lastReport: rep ? {
                    reportPath: rep.reportPath || null,
                    label: rep.label, build: rep.build,
                    generatedAt: rep.generatedAt, durationMs: rep.durationMs,
                    summary: rep.summary,
                    tasks: (rep.tasks || []).map(t => ({
                        id: t.id, verdict: t.verdict, status: t.status,
                        detail: t.verifier ? String(t.verifier.detail).slice(0, 200) : (t.verifyError || null),
                        costUSD: t.economics && t.economics.costUSD,
                        llmCalls: t.economics && t.economics.llmCalls,
                    })),
                } : null,
                note: testRunner.isRunning
                    ? 'Suite in progress — tasks land in the report as they finish; poll again in ~2 min.'
                    : (rep ? 'Suite idle; lastReport is the most recent completed (or aborted) run.'
                           : 'Suite idle; no report yet this session. Start one with wolfbook.oberon.goldRun.'),
            };
        }],

        // ── Oberon Director: multi-stage research programmes (LLM above the Fairy) ──
        ['wolfbook.oberon.startDirector', async (arg) => {
            let brief = (typeof arg === 'string') ? arg
                      : (arg && typeof arg.brief === 'string') ? arg.brief : '';
            if (!brief.trim()) {
                brief = await vscode.window.showInputBox({
                    prompt: 'Oberon Director — describe the research programme goal',
                    placeHolder: 'Compute the SU(3) spin-chain spectrum via the QQ-system, verify against exact diagonalization, extend to L=8 …',
                    ignoreFocusOut: true,
                }) || '';
            }
            if (brief && brief.trim()) await dispatch('startDirector', { brief: brief.trim() });
        }],
        ['wolfbook.oberon.resumeDirector', async () => {
            const dstate = require('./director/state');
            const root = project.getWorkspaceRoot();
            if (!root) { vscode.window.showWarningMessage('Oberon: no workspace open.'); return; }
            const progs = (await dstate.listProgrammes(root)).filter(p => p.status !== 'done');
            if (!progs.length) { vscode.window.showInformationMessage('Oberon: no resumable Director programmes.'); return; }
            const pick = await vscode.window.showQuickPick(progs.map(p => ({
                label: `${p.id} — ${p.title}`.slice(0, 80),
                description: `${p.status} · ${p.stages} stage(s) · updated ${String(p.updatedAt || '').slice(0, 16)}`,
                dir: p.dir,
            })), { placeHolder: 'Resume which Director programme?' });
            if (pick) await dispatch('startDirector', { resumeDir: pick.dir });
        }],
        // Headless status (MCP-ready): structured snapshot from programme.json.
        ['wolfbook.oberon.directorStatus', async (args) => {
            const dstate = require('./director/state');
            const root = project.getWorkspaceRoot();
            if (!root) return { ok: false, error: 'No workspace open.' };
            let dir = args && args.programmeDir;
            if (!dir) {
                const progs = await dstate.listProgrammes(root);
                if (!progs.length) return { ok: false, error: 'No Director programmes found.' };
                dir = progs[0].dir;
            }
            try {
                const p = await dstate.loadProgramme(dir);
                return {
                    ok: true, programmeId: p.id, title: p.title, status: p.status,
                    outcome: p.outcome, dir: p.dir, active: runManager.isActive,
                    stages: ((p.plan && p.plan.stages) || []).map(s => ({
                        id: s.id, title: s.title, status: s.status,
                        questId: s.questId, cleanNbPath: s.cleanNbPath,
                        verdict: s.assessment && s.assessment.verdict || null,
                    })),
                    keyResults: (p.keyResults || []).slice(0, 12).map(k => ({
                        statement: String(k.statement).slice(0, 300), confidence: k.confidence,
                    })),
                    report: p.report || null,
                    contribution: p.contribution || null,
                    note: p.status === 'done'
                        ? 'Programme finished — report.tex is the deliverable; per-stage clean.wb notebooks re-execute in a fresh kernel.'
                        : (runManager.isActive ? 'Programme running — poll again in ~120s.' : 'Programme is not running (resumable via Oberon: Resume Director Programme).'),
                };
            } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
        }],
        // Headless dispatch (MCP-ready): fire-and-forget, poll directorStatus.
        ['wolfbook.oberon.directorDispatch', async (args) => {
            const brief = String((args && args.goal) || (args && args.task) || '').trim();
            if (!brief) return { ok: false, error: 'goal is required (the research programme brief).' };
            if (!roles.minimallyConfigured()) {
                return { ok: false, error: 'Oberon LLM roles are not configured — set a provider API key + model under wolfbook.oberon settings.' };
            }
            if (runManager.isActive) {
                return { ok: false, error: `A run is already active (${(runManager.summary && runManager.summary.runId) || 'unknown'}).` };
            }
            dispatch('startDirector', { brief }).catch(() => {});
            let runId = null;
            for (let i = 0; i < 30 && !runId; i++) {
                await new Promise(r => setTimeout(r, 100));
                runId = bus.runId || null;
            }
            return {
                ok: true, runId,
                note: 'Director programme started in the background (typical duration 30–120 min; it runs several ' +
                      'fairy stages and RESTARTS the shared Wolfram kernel repeatedly). Poll wolfbook.oberon.directorStatus.',
            };
        }],
    ];
    for (const [id, handler] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    // React to settings changes — push new role list to the UI.
    context.subscriptions.push(settings.onDidChange(() => {
        sidebar._postSnapshot();
        inspector._postSnapshot();
    }));

    // Stage 2: when a delivered run raises a contribution candidate, surface a
    // non-blocking notification with a Review action (never auto-submits).
    bus.on('event', (ev) => {
        if (ev && ev.type === 'contribution.candidate') {
            vscode.window.showInformationMessage(
                'A contribution candidate is ready for review.', 'Review'
            ).then(choice => { if (choice === 'Review') contributionReviewPanel.open(); });
        }
    });

    // First-run .gitignore prompt (deferred until idle so it doesn't block activation).
    setTimeout(() => { project.maybePromptGitignore(context).catch(() => {}); }, 1500);

    // Try to restore a prior RunSummary so the sidebar shows the last run on reload.
    runManager.restoreLastSummary().catch(() => {});

    // Cleanup
    context.subscriptions.push({ dispose() {
        try { sidebar.dispose(); } catch (_) {}
        try { inspector.dispose(); } catch (_) {}
        try { charmDebugger.dispose(); } catch (_) {}
        try { testResultsPanel.dispose(); } catch (_) {}
        bus.endRun().catch(() => {});
    }});

    // Bind a correlationId to async work for D11 (correlated event ingestion).
    // For MVP-0 this is a placeholder: it just runs `fn`. Future implementation
    // will store `correlationId` in AsyncLocalStorage so wrapped tool callers
    // can stamp it on the eventBus events they emit.
    function correlate(correlationId, fn) { return fn(); }

    return {
        bus, runManager, inspector, sidebar, correlate,
        setKernelController: (fn) => wolframShim.setControllerProvider(fn),
    };

    // ── command dispatch from BOTH UI surfaces and external command palette ──
    async function dispatch(cmd, payload) {
        try {
            if (cmd === 'openRunInspector')  return inspector.show();
            if (cmd === 'openCharmDebugger') return charmDebugger.show(payload);
            if (cmd === 'openSettings')     return settings.openSettingsUI();
            if (cmd === 'configureProviders') return settings.openProviderSettingsUI();
            if (cmd === 'abortRun')         return runManager.abortRun('user');
            if (cmd === 'emitMockEvents')   return emitMockEvents({ bus, runManager });
            if (cmd === 'bumpAndDeploy')    return bumpAndDeploy(context);

            if (cmd === 'startFairy') {
                if (!roles.minimallyConfigured()) {
                    const choice = await vscode.window.showWarningMessage(
                        'Oberon: Configure a provider and the Fairy role binding before starting.',
                        'Configure',
                    );
                    if (choice === 'Configure') await settings.openProviderSettingsUI();
                    return;
                }
                if (runManager.isActive) {
                    vscode.window.showWarningMessage('Oberon: a run is already active. Abort it first.');
                    return;
                }
                const brief = (payload && payload.brief) || '';
                if (!brief.trim()) return;

                // Build minimal quest + charm directly from the brief (no Planner/Dispatcher).
                // fairyDispatch (headless agent API) may pre-assign questId + shortName (so
                // it can return the charmDir before the run registers) and supply
                // validationChecks — the dispatching agent's quality contract, executed
                // by run_clean and the delivered-run self-verify.
                //
                // Folder name = `<id>_<shortName>` → e.g. Q05_heisenberg_l4_spectrum.
                // Derive a numbered, descriptive name (short LLM slug + heuristic fallback)
                // unless the caller already supplied one.
                let _qId   = payload && payload.questId;
                let _short = payload && payload.shortName;
                if (!_qId || !_short) {
                    let naming = { id: null, shortName: null };
                    try { naming = await require('./core/questNaming').deriveQuestNaming(brief); } catch (_) {}
                    _qId   = _qId   || naming.id       || ('Q_' + Date.now().toString(36).slice(-6).toUpperCase());
                    _short = _short || naming.shortName || _qId;
                }
                const quest = {
                    id: _qId, shortName: _short, title: brief.slice(0, 60), objective: brief,
                    successCriteria: [], subtasks: [],
                };
                const charm = {
                    id: 'C01', title: brief.slice(0, 60), task: brief,
                    deliverables: [], constraints: [],
                    validationChecks: Array.isArray(payload && payload.validationChecks) ? payload.validationChecks : [],
                };

                inspector.show();
                await runManager.beginRun({ brief });
                const ctrl = runManager.newAbortController();
                try {
                    await runManager.transition('QUEST_DEFINED',    { questId: quest.id });
                    await runManager.transition('CHARM_DISPATCHED', { questId: quest.id, charmId: charm.id });
                    await runManager.transition('FAIRY_WORKING',    { questId: quest.id, charmId: charm.id });

                    let _probeNbDoc = null;
                    const _onFairyStarted = async (ev) => {
                        if (ev.type === 'fairy.started' && !_probeNbDoc) {
                            const nbPath = ev.payload && ev.payload.workingNbPath;
                            if (!nbPath) return;
                            try {
                                const fsp = require('fs/promises');
                                const nbUri = vscode.Uri.file(nbPath);
                                // Subtle distinct tint so the agent's scratchpad reads as
                                // "not your work" (Powder Blue; auto-inverts to dark blue).
                                await fsp.writeFile(nbPath, JSON.stringify({ cells: [], metadata: {} }, null, 2), 'utf8');
                                for (const tabGroup of vscode.window.tabGroups.all) {
                                    for (const tab of tabGroup.tabs) {
                                        if (tab.input instanceof vscode.TabInputNotebook &&
                                            tab.input.uri.fsPath === nbPath) {
                                            await vscode.window.tabGroups.close(tab, true).catch(() => {});
                                        }
                                    }
                                }
                                _probeNbDoc = await vscode.workspace.openNotebookDocument(nbUri);
                                // Open in the SAME column as the run inspector (Active), matching
                                // associateNotebook below — using Beside here while associate uses
                                // Active opened working.wb in TWO editor groups.
                                await vscode.window.showNotebookDocument(_probeNbDoc, {
                                    viewColumn: vscode.ViewColumn.Active, preserveFocus: true,
                                });
                                // Force controller association so evalInNotebook can use
                                // createNotebookCellExecution without "not associated" errors.
                                // onDidOpenNotebookDocument does not re-fire for cached docs.
                                await wolframShim.associateNotebook(_probeNbDoc).catch(() => {});
                                // Transparent suppression cell at the top of working.wb: the
                                // non-critical solver warnings the agent silences, shown + run.
                                try {
                                    const supp = wolframShim.buildSuppressionCode && wolframShim.buildSuppressionCode();
                                    if (supp) await wolframShim.evalInNotebook(_probeNbDoc, supp, { note: 'Suppress non-critical solver warnings (Off[…])' }).catch(() => {});
                                } catch (_) {}
                            } catch (_) {}
                        } else if (ev.type === 'plan.created' && _probeNbDoc) {
                            _insertPlanRoadmap(_probeNbDoc, ev.payload).catch(() => {});
                        } else if (ev.type === 'checkpoint.recorded' && _probeNbDoc) {
                            _insertCheckpointBanner(_probeNbDoc, ev.payload).catch(() => {});
                        } else if (ev.type === 'skills.used' && _probeNbDoc) {
                            _insertSkillsUsed(_probeNbDoc, ev.payload).catch(() => {});
                        } else if (ev.type === 'fairy.self_postmortem' && _probeNbDoc) {
                            _insertSelfPostmortem(_probeNbDoc, ev.payload).catch(() => {});
                        } else if (ev.type === 'util.registered' && _probeNbDoc) {
                            _insertUtilBanner(_probeNbDoc, ev.payload).catch(() => {});
                        } else if (ev.type === 'literature.brief' && _probeNbDoc) {
                            _insertLiteratureBrief(_probeNbDoc, ev.payload).catch(() => {});
                        } else if (ev.type === 'literature.progress' && _probeNbDoc) {
                            _appendLiteratureProgress(_probeNbDoc, ev.payload).catch(() => {});
                        } else if (ev.type === 'fairy.status' && _probeNbDoc) {
                            if (!ev.payload || !ev.payload.done) {
                                const p = ev.payload || {};
                                _lastStatusMeta = { phase: p.phase, budgetLeft: p.budgetLeft, probesUsed: p.probesUsed, turnsUsed: p.turnsUsed, costUSD: p.costUSD };
                            }
                            _updateStatusCell(_probeNbDoc, ev.payload).catch(() => {});
                        } else if ((ev.type === 'llm.reasoning_progress' || ev.type === 'llm.response_progress') && _probeNbDoc) {
                            _streamStatusReasoning(_probeNbDoc, ev.payload).catch(() => {});
                        }
                    };
                    bus.on('event', _onFairyStarted);

                    const fairyOut = await runFairy({
                        quest, charm, bus,
                        signal: ctrl.signal,
                        getWorkingNbDoc: () => _probeNbDoc,
                        writeNotebook: async (_cells, destPath) => destPath,
                        onSteerQueueReady: (q) => { sidebar.setSteerQueue(q); inspector.setSteerQueue(q); },
                        askContinue: _askFairyContinue,
                    });

                    sidebar.setSteerQueue(null);
                    inspector.setSteerQueue(null);
                    bus.removeListener('event', _onFairyStarted);

                    await runManager.transition('SCROLL_SUBMITTED', {
                        questId: quest.id, charmId: charm.id, scrollId: fairyOut.scroll && fairyOut.scroll.id,
                    });

                    if (fairyOut.cleanNbPath) {
                        try {
                            await wolframShim.restartKernel().catch(() => {});
                            const _cleanUri = vscode.Uri.file(fairyOut.cleanNbPath);
                            const _cleanDoc = await vscode.workspace.openNotebookDocument(_cleanUri);
                            await vscode.window.showNotebookDocument(_cleanDoc, {
                                viewColumn: vscode.ViewColumn.Active, preserveFocus: false,
                            });
                            await new Promise(r => setTimeout(r, 1200));
                            await vscode.commands.executeCommand('notebook.executeAll');
                        } catch (_) {}
                    }

                    // On a clean delivery, tidy up: the agent's scratchpad (working.wb)
                    // and the Run Inspector have served their purpose — close both so the
                    // user is left with just the delivered clean.wb. Only on 'delivered':
                    // partial/escalate/failed runs keep them open for debugging.
                    const _finalStatus = fairyOut && fairyOut.scroll && fairyOut.scroll.fairyArtifact
                        && fairyOut.scroll.fairyArtifact.status;
                    if (_finalStatus === 'delivered') {
                        try {
                            // Save first so closing a dirty scratchpad tab never prompts.
                            if (_probeNbDoc && typeof _probeNbDoc.save === 'function') {
                                await _probeNbDoc.save().then(undefined, () => {});
                            }
                            const _wpath = _probeNbDoc && _probeNbDoc.uri && _probeNbDoc.uri.fsPath;
                            if (_wpath) {
                                for (const tabGroup of vscode.window.tabGroups.all) {
                                    for (const tab of tabGroup.tabs) {
                                        if (tab.input instanceof vscode.TabInputNotebook &&
                                            tab.input.uri.fsPath === _wpath) {
                                            await vscode.window.tabGroups.close(tab, true).catch(() => {});
                                        }
                                    }
                                }
                            }
                        } catch (_) {}
                        // The Inspector intentionally stays open: after a run it
                        // shows the finished timeline + recent-runs dashboard.
                    }

                    await runManager.endRun({ state: 'IDLE' });
                    vscode.window.showInformationMessage('Quick Compute: done.');
                } catch (e) {
                    const aborted = runManager.isAborting || /abort/i.test(String(e && e.message));
                    if (runManager.isActive) {
                        await runManager.endRun({ state: aborted ? 'ABORTED' : 'ERROR' });
                    }
                    if (!aborted) vscode.window.showErrorMessage(`Quick Compute failed: ${e && e.message || String(e)}`);
                }
                return;
            }

            // ── Oberon Director: plan → [fairy stage → analyse clean.wb → adjust
            //    plan]* → synthesis → skill candidate → concise LaTeX report ──
            if (cmd === 'startDirector') {
                if (!roles.minimallyConfigured()) {
                    const choice = await vscode.window.showWarningMessage(
                        'Oberon: Configure a provider and the Oberon/Fairy role bindings before starting.',
                        'Configure',
                    );
                    if (choice === 'Configure') await settings.openProviderSettingsUI();
                    return;
                }
                if (runManager.isActive) {
                    vscode.window.showWarningMessage('Oberon: a run is already active. Abort it first.');
                    return;
                }
                const brief     = (payload && payload.brief)     || '';
                const resumeDir = (payload && payload.resumeDir) || null;
                if (!brief.trim() && !resumeDir) return;
                const root = project.getWorkspaceRoot();
                if (!root) { vscode.window.showWarningMessage('Oberon: no workspace open.'); return; }

                const { runDirector } = require('./director/director');
                const questNaming     = require('./core/questNaming');
                const dirCfg = settings.director();

                inspector.show();
                await runManager.beginRun({
                    brief: brief.trim() || `[resume Director programme] ${resumeDir}`,
                    budgetOverride: { runUSD: dirCfg.maxUSD, runLlmCalls: dirCfg.maxLlmCalls },
                });
                const ctrl = runManager.newAbortController();

                // One fairy stage = one quest+charm run inside THIS run, with the
                // same live working.wb / clean.wb UX as the quick-compute path.
                const runStage = async ({ stage, task, handoff, signal }) => {
                    let naming = { id: null, shortName: null };
                    try { naming = await questNaming.deriveQuestNaming(task); } catch (_) {}
                    const questId   = naming.id || ('Q_' + Date.now().toString(36).slice(-6).toUpperCase());
                    const shortName = naming.shortName || questId;
                    const quest = {
                        id: questId, shortName, title: String(stage.title || task).slice(0, 60),
                        objective: task, successCriteria: stage.successCriteria || [], subtasks: [],
                    };
                    const charm = {
                        id: 'C01', title: String(stage.title || task).slice(0, 60), task,
                        deliverables: (stage.successCriteria || []).slice(0, 12), constraints: [],
                        validationChecks: (stage.validationChecks || []).slice(0, 8),
                    };
                    await runManager.transition('QUEST_DEFINED',    { questId: quest.id, directorStage: stage.id });
                    await runManager.transition('CHARM_DISPATCHED', { questId: quest.id, charmId: charm.id });
                    await runManager.transition('FAIRY_WORKING',    { questId: quest.id, charmId: charm.id });

                    const live = _makeFairyLiveView(bus);
                    try {
                        const fairyOut = await runFairy({
                            quest, charm, bus,
                            signal: signal || ctrl.signal,
                            handoff: handoff || null,
                            // Stage B3 escalation: a stage the Director escalated
                            // runs on the stronger judgment binding (set by the
                            // assess loop after ESCALATE_AFTER failed attempts).
                            bindingRole: stage.bindingRole || undefined,
                            getWorkingNbDoc: () => live.getDoc(),
                            writeNotebook: async (_cells, destPath) => destPath,
                            onSteerQueueReady: (q) => { sidebar.setSteerQueue(q); inspector.setSteerQueue(q); },
                            // Autonomous: auto-grant a bounded number of fairy budget
                            // continuations per stage; never pop a modal mid-programme.
                            askContinue: async (info) =>
                                ((info && info.continuation) || 1) <= dirCfg.stageContinuations,
                        });
                        await runManager.transition('SCROLL_SUBMITTED', {
                            questId: quest.id, charmId: charm.id,
                            scrollId: fairyOut.scroll && fairyOut.scroll.id,
                        });
                        await runManager.transition('REVIEWING', { questId: quest.id, charmId: charm.id });

                        // Delivery UX: fresh kernel + open clean.wb + run all cells.
                        if (fairyOut.cleanNbPath) {
                            try {
                                await wolframShim.restartKernel().catch(() => {});
                                const _cleanUri = vscode.Uri.file(fairyOut.cleanNbPath);
                                const _cleanDoc = await vscode.workspace.openNotebookDocument(_cleanUri);
                                await vscode.window.showNotebookDocument(_cleanDoc, {
                                    viewColumn: vscode.ViewColumn.Active, preserveFocus: false,
                                });
                                await new Promise(r => setTimeout(r, 1200));
                                await vscode.commands.executeCommand('notebook.executeAll');
                                // Persist outputs to disk so the Director's clean.wb
                                // digest sees them (best-effort; digest also reads facts).
                                await new Promise(r => setTimeout(r, 800));
                                await _cleanDoc.save().then(undefined, () => {});
                            } catch (_) {}
                            // Tidy: a delivered stage's scratchpad has served its
                            // purpose — close it so tabs don't pile up stage after stage.
                            try {
                                const wdoc = live.getDoc();
                                if (wdoc) {
                                    await wdoc.save().then(undefined, () => {});
                                    const wpath = wdoc.uri && wdoc.uri.fsPath;
                                    for (const tabGroup of vscode.window.tabGroups.all) {
                                        for (const tab of tabGroup.tabs) {
                                            if (tab.input instanceof vscode.TabInputNotebook &&
                                                tab.input.uri.fsPath === wpath) {
                                                await vscode.window.tabGroups.close(tab, true).catch(() => {});
                                            }
                                        }
                                    }
                                }
                            } catch (_) {}
                        }
                        return {
                            questId: quest.id,
                            charmDir: (fairyOut.scroll && fairyOut.scroll.fairyArtifact
                                       && fairyOut.scroll.fairyArtifact.charmDir) || null,
                            scroll:        fairyOut.scroll,
                            cleanNbPath:   fairyOut.cleanNbPath,
                            partialNbPath: fairyOut.partialNbPath,
                            handoff:       fairyOut.handoff,
                        };
                    } catch (e) {
                        // Unwedge the FSM so the next stage's transitions stay legal.
                        await runManager.transition('SCROLL_SUBMITTED', { questId: quest.id, charmId: charm.id }).catch(() => {});
                        await runManager.transition('REVIEWING',        { questId: quest.id, charmId: charm.id }).catch(() => {});
                        throw e;
                    } finally {
                        sidebar.setSteerQueue(null);
                        inspector.setSteerQueue(null);
                        live.dispose();
                    }
                };

                try {
                    const { programme } = await runDirector({
                        brief: brief.trim() || null,
                        resumeDir, root, bus,
                        signal: ctrl.signal,
                        deps: {
                            runStage,
                            // Stage B3 session canary: one trivial kernel computation
                            // before the programme spends its budget (a wedged or
                            // unlicensed kernel should cost seconds, not dollars).
                            canaryEval: (a) => require('./core/wolframShim').evalOnce(a),
                            literature:    _makeDirectorLiterature({ bus, signal: ctrl.signal }),
                            skilxivSearch: _directorSkillSearch,
                            askUser: async ({ question }) => vscode.window.showInputBox({
                                title: 'Oberon Director asks',
                                prompt: String(question || '').slice(0, 500),
                                placeHolder: 'Answer here — or press Esc to let the Director proceed on its own judgment',
                                ignoreFocusOut: true,
                            }),
                            submitSkill: async ({ candidateId }) => {
                                const contributionSubmit = require('./memory/contributionSubmit');
                                return contributionSubmit.submitCandidate({
                                    id: candidateId, secrets: context.secrets, agentModel: 'wolfbook-director',
                                });
                            },
                            onTransition: async (phase) => {
                                try {
                                    if (phase === 'stage_assessed') await runManager.transition('DECISION', {});
                                    else if (phase === 'synthesis') await runManager.transition('GRIMOIRE_UPDATED', {});
                                } catch (_) {}
                            },
                            shouldAbort: () => runManager.isAborting,
                            budgetStatus: () => ({
                                exhausted: runManager.isBudgetExhausted,
                                costUSD: (runManager.summary && runManager.summary.totalCostUSD) || 0,
                            }),
                            openArtifact: async (p, kind) => {
                                if (kind !== 'report') return;
                                try {
                                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
                                    await vscode.window.showTextDocument(doc, { preserveFocus: false });
                                } catch (_) {}
                            },
                        },
                    });

                    await runManager.endRun({ state: 'IDLE' });

                    const outcome = (programme && programme.outcome) || {};
                    const head = `Oberon Director: ${String(outcome.status || 'done').toUpperCase()} — ` +
                        `${programme.title}`.slice(0, 160) +
                        ` (${(programme.keyResults || []).length} key results, ${programme.stagesRun} stages)`;
                    const actions = [];
                    if (programme.report && programme.report.pdfPath) actions.push('Open PDF');
                    if (programme.report && programme.report.texPath) actions.push('Open Report');
                    if (programme.contribution && programme.contribution.candidateId) actions.push('Review Skill Draft');
                    vscode.window.showInformationMessage(head, ...actions).then(async choice => {
                        if (choice === 'Open Report' && programme.report && programme.report.texPath) {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(programme.report.texPath));
                            await vscode.window.showTextDocument(doc);
                        }
                        if (choice === 'Open PDF' && programme.report && programme.report.pdfPath) {
                            vscode.env.openExternal(vscode.Uri.file(programme.report.pdfPath));
                        }
                        if (choice === 'Review Skill Draft') contributionReviewPanel.open();
                    });
                } catch (e) {
                    const aborted = runManager.isAborting || (e && e.kind === 'aborted') || /abort/i.test(String(e && e.message));
                    if (runManager.isActive) {
                        if (!aborted) {
                            await bus.appendEvent('omen', {
                                kind:    (e && e.kind) || 'director_failed',
                                message: e && e.message || String(e),
                            }).catch(() => {});
                        }
                        await runManager.endRun({ state: aborted ? 'ABORTED' : 'ERROR' });
                    }
                    if (!aborted) vscode.window.showErrorMessage(`Oberon Director failed: ${e && e.message || String(e)}`);
                } finally {
                    runManager.clearAbortController();
                }
                return;
            }

            if (cmd === 'startResearch') {
                if (!roles.minimallyConfigured()) {
                    const choice = await vscode.window.showWarningMessage(
                        'Oberon: Configure a provider and the Oberon/Fairy role bindings before starting.',
                        'Configure',
                    );
                    if (choice === 'Configure') await settings.openProviderSettingsUI();
                    return;
                }
                if (runManager.isActive) {
                    vscode.window.showWarningMessage('Oberon: a run is already active. Abort it first.');
                    return;
                }
                const brief = (payload && payload.brief) || '';
                if (!brief.trim()) return;
                // Track depth of auto-dispatched executive follow-ups so we
                // can bound the recursion (settings.executive().maxAutoFollowups).
                // Stage B3 (classic path): the Executive's 'escalate' action asks
                // for a STRONGER model, not merely another attempt. The follow-up
                // dispatch carries the role here and it is bound in runFairy below.
                const escalateRole = (payload && typeof payload.__escalateRole === 'string')
                    ? payload.__escalateRole : null;
                const autoFollowupDepth = (payload && Number.isFinite(payload.__autoFollowupDepth))
                    ? Math.max(0, Math.floor(payload.__autoFollowupDepth))
                    : 0;

                // Surface the Inspector so the user can watch the Planner work.
                inspector.show();

                await runManager.beginRun({ brief });
                const ctrl = runManager.newAbortController();
                try {
                    // ── Phase 1: Planner — brief → Quest ─────────────────────
                    let { quest, fileRef } = await runPlanner({
                        brief,
                        bus: bus,
                        signal: ctrl.signal,
                    });

                    // O2: clarification gate — ask the user for missing parameters
                    // (one round), or declare the Planner's defaults as explicit
                    // assumptions instead of running on silent guesses.
                    const clarifyGate = await clarifyQuestGate({
                        quest, questFileRef: fileRef, brief, bus, signal: ctrl.signal,
                        askClarify: async ({ missingInfo }) => vscode.window.showInputBox({
                            title:          'Oberon needs clarification',
                            prompt:         `Missing: ${missingInfo.join(' · ')}`.slice(0, 500),
                            placeHolder:    'Answer here — or press Enter/Esc to accept the shown defaults',
                            ignoreFocusOut: true,
                        }),
                    });
                    quest = clarifyGate.quest;
                    fileRef = clarifyGate.questFileRef;
                    const declaredAssumptions = clarifyGate.declaredAssumptions;

                    await runManager.transition('QUEST_DEFINED', { questId: quest.id, file: fileRef });

                    // Open the quest notebook immediately so the user can watch.
                    // NOTE: .wb files are notebook documents — must use the notebook API,
                    // not 'vscode.openWith' (which is for custom text editors like .wslide).
                    if (fileRef.notebookPath) {
                        try {
                            const nbUri = vscode.Uri.file(fileRef.notebookPath);
                            const doc   = await vscode.workspace.openNotebookDocument(nbUri);
                            await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
                        } catch (_) {}
                    }

                    // ── Phase 2: Dispatcher — Quest → Charm(s) ───────────────
                    // P-10: multi-charm decomposition. The dispatcher builds
                    // one Charm per `quest.subtasks[]` entry (or a single
                    // Charm when subtasks is empty). Each Charm is executed
                    // sequentially; verified findings of earlier Charms are
                    // banked as established facts and threaded as context
                    // into the next Charm.
                    let dispatched;
                    try {
                        // O2: declared assumptions ride into every charm (banner + array).
                        const charms = applyDeclaredAssumptions(buildCharms(quest), declaredAssumptions);
                        dispatched = await dispatchCharms({ quest, bus, charms });
                    } catch (e) {
                        await bus.appendEvent('omen', {
                            kind: (e && e.kind) || 'dispatcher_failed',
                            message: e && e.message || String(e),
                            detail:  e && e.detail || null,
                        });
                        throw e;
                    }
                    if (!dispatched.length) {
                        throw Object.assign(new Error('Dispatcher produced zero Charms.'),
                            { kind: 'dispatcher_empty' });
                    }

                    // Per-charm execution state (captured for postmortem + toast).
                    let lastCharm = null, lastCharmFileRef = null;
                    let lastScroll = null, lastScrollFileRef = null;
                    let lastFairyOut = null, lastReviewOut = null;
                    let lastWardOut = null, lastGrimoireResult = null;
                    let lastCharmNotebookPath = null, lastSummaryNotebookPath = null;
                    let executiveOut = null;
                    let executiveRunCount = 0;
                    let charmsSkippedOnBudget = 0;   // charms never attempted (cap hit)
                    let charmsCompleted = 0;
                    const charmOutcomes = [];        // per-charm rows for the postmortem
                    const execCfg = settings.executive();
                    const memCfg  = settings.memory();

                    const totalCharms = dispatched.length;

                    // Budget planning check (run Q25): a 120-call run cap split over
                    // 4 charms leaves ~30 calls each INCLUDING review/executive —
                    // charm 1 alone used 36 and charm 3 died mid-derivation. Warn up
                    // front so the user can raise the cap or narrow the brief instead
                    // of discovering the shortfall three charms in.
                    try {
                        const capInfo = settings.runBudget() || {};
                        const callCap = Number(capInfo.runLlmCalls) || 0;
                        const usedSoFar = (runManager.summary && runManager.summary.llmCallCount) || 0;
                        // Reserve planner/review/postmortem overhead before judging whether
                        // every dispatched charm can receive a viable Fairy allowance.
                        const RUN_OVERHEAD_CALLS = 8;
                        const MIN_CALLS_PER_CHARM = 30;
                        if (callCap > 0 && totalCharms > 0) {
                            const available = Math.max(0, callCap - usedSoFar - RUN_OVERHEAD_CALLS);
                            const perCharm = Math.floor(available / totalCharms);
                            await bus.appendEvent('budget.plan', {
                                questId: quest.id, charms: totalCharms,
                                callCap, usedSoFar, overheadReserve: RUN_OVERHEAD_CALLS,
                                availableForCharms: available, perCharmAllowance: perCharm,
                                tight: perCharm < MIN_CALLS_PER_CHARM,
                            }, { questId: quest.id });
                            if (perCharm < MIN_CALLS_PER_CHARM) {
                                await bus.appendEvent('omen', {
                                    kind: 'budget_plan_tight',
                                    message: `Run cap of ${callCap} LLM calls across ${totalCharms} charms leaves ~${perCharm} calls per charm (recommended ≥${MIN_CALLS_PER_CHARM}). Later charms may be cut short — consider raising the wolfbook.oberon.budgets.run setting (runLlmCalls) or narrowing the brief.`,
                                }, { questId: quest.id });
                            }
                        }
                    } catch (_) { /* planning check is advisory */ }

                    let charmHandoff = null;   // O6: verified utils+facts carried between charms
                    for (let charmIdx = 0; charmIdx < totalCharms; charmIdx++) {
                        const { charm: rawCharm, fileRef: charmFileRef } = dispatched[charmIdx];

                        // Inject established facts from earlier charms into the
                        // task description so the Fairy can build on, not redo,
                        // prior verified work.
                        const priorFacts = await establishedFacts.readFacts({ quest });
                        const factsBlock = establishedFacts.renderFactsBlock(priorFacts);
                        const charm = factsBlock
                            ? { ...rawCharm, task: `${factsBlock}\n\n---\nYOUR TASK:\n${rawCharm.task}` }
                            : rawCharm;
                        lastCharm        = charm;
                        lastCharmFileRef = charmFileRef;

                        if (totalCharms > 1) {
                            await bus.appendEvent('charm.started', {
                                questId: quest.id, charmId: charm.id,
                                index: charmIdx + 1, total: totalCharms,
                                priorFactsCount: priorFacts.length,
                            }, { questId: quest.id, charmId: charm.id });
                        }

                        // Between charms: bring the FSM back to CHARM_DISPATCHED.
                        // First charm path: QUEST_DEFINED → CHARM_DISPATCHED (direct).
                        // Subsequent: REVIEWING → DECISION → QUEST_DEFINED → CHARM_DISPATCHED.
                        if (charmIdx > 0) {
                            await runManager.transition('DECISION',      { questId: quest.id });
                            await runManager.transition('QUEST_DEFINED', { questId: quest.id });
                        }
                        await runManager.transition('CHARM_DISPATCHED', { questId: quest.id, charmId: charm.id });

                        // ── Phase 3: Fairy — Charm → Scroll ──────────────────────
                        await runManager.transition('FAIRY_WORKING', { questId: quest.id, charmId: charm.id });

                        // Open working.wb in a side column as soon as the Fairy starts, then
                        // push each probe cell into the live document so the user can watch
                        // the scratchpad grow without manually refreshing.
                        let _probeNbDoc = null;
                        const _onFairyStarted = async (ev) => {
                            if (ev.type === 'fairy.started' && !_probeNbDoc) {
                                const nbPath = ev.payload && ev.payload.workingNbPath;
                                if (!nbPath) return;
                                try {
                                    const fsp = require('fs/promises');
                                    const nbUri = vscode.Uri.file(nbPath);

                                    // Recreate working.wb as empty on disk before opening.
                                    // This ensures VS Code reads fresh content rather than
                                    // returning a cached in-memory document with stale cells.
                                    // Subtle distinct tint so the agent's scratchpad reads as
                                // "not your work" (Powder Blue; auto-inverts to dark blue).
                                await fsp.writeFile(nbPath, JSON.stringify({ cells: [], metadata: {} }, null, 2), 'utf8');

                                    // Close any existing editor tab showing working.wb so VS Code
                                    // is forced to re-read from disk when openNotebookDocument runs.
                                    for (const tabGroup of vscode.window.tabGroups.all) {
                                        for (const tab of tabGroup.tabs) {
                                            if (tab.input instanceof vscode.TabInputNotebook &&
                                                tab.input.uri.fsPath === nbPath) {
                                                await vscode.window.tabGroups.close(tab, true).catch(() => {});
                                            }
                                        }
                                    }

                                    _probeNbDoc = await vscode.workspace.openNotebookDocument(nbUri);
                                    // Open in the SAME column as the run inspector (Active), matching
                                    // associateNotebook below — using Beside here while associate uses
                                    // Active opened working.wb in TWO editor groups.
                                    await vscode.window.showNotebookDocument(_probeNbDoc, {
                                        viewColumn:    vscode.ViewColumn.Active,
                                        preserveFocus: true,
                                    });
                                    // Force controller association so evalInNotebook can use
                                    // createNotebookCellExecution without "not associated" errors.
                                    // onDidOpenNotebookDocument does not re-fire for cached docs.
                                    await wolframShim.associateNotebook(_probeNbDoc).catch(() => {});
                                } catch (_) {}
                            } else if (ev.type === 'plan.created' && _probeNbDoc) {
                                _insertPlanRoadmap(_probeNbDoc, ev.payload).catch(() => {});
                            } else if (ev.type === 'checkpoint.recorded' && _probeNbDoc) {
                                _insertCheckpointBanner(_probeNbDoc, ev.payload).catch(() => {});
                            } else if (ev.type === 'skills.used' && _probeNbDoc) {
                                _insertSkillsUsed(_probeNbDoc, ev.payload).catch(() => {});
                            } else if (ev.type === 'fairy.self_postmortem' && _probeNbDoc) {
                                _insertSelfPostmortem(_probeNbDoc, ev.payload).catch(() => {});
                            } else if (ev.type === 'util.registered' && _probeNbDoc) {
                                _insertUtilBanner(_probeNbDoc, ev.payload).catch(() => {});
                            } else if (ev.type === 'literature.brief' && _probeNbDoc) {
                                _insertLiteratureBrief(_probeNbDoc, ev.payload).catch(() => {});
                            } else if (ev.type === 'literature.progress' && _probeNbDoc) {
                                _appendLiteratureProgress(_probeNbDoc, ev.payload).catch(() => {});
                            } else if (ev.type === 'fairy.status' && _probeNbDoc) {
                                if (!ev.payload || !ev.payload.done) {
                                    _lastStatusMeta = { phase: ev.payload && ev.payload.phase, budgetLeft: ev.payload && ev.payload.budgetLeft };
                                }
                                _updateStatusCell(_probeNbDoc, ev.payload).catch(() => {});
                            } else if ((ev.type === 'llm.reasoning_progress' || ev.type === 'llm.response_progress') && _probeNbDoc) {
                                _streamStatusReasoning(_probeNbDoc, ev.payload).catch(() => {});
                            }
                        };
                        bus.on('event', _onFairyStarted);

                        const fairyOut = await runFairy({
                            quest, charm, bus,
                            signal: ctrl.signal,
                            handoff: charmHandoff,   // O6: prior charm's utils+facts
                            bindingRole: escalateRole || undefined,   // Executive 'escalate'
                            getWorkingNbDoc: () => _probeNbDoc,
                            writeNotebook: async (_cells, destPath) => {
                                // Harness already wrote the JSON to disk. Do not open/show
                                // here — the caller (index.js) will open it in the correct
                                // column after runFairy() returns.
                                return destPath;
                            },
                            onSteerQueueReady: (q) => { sidebar.setSteerQueue(q); inspector.setSteerQueue(q); },
                            askContinue: _askFairyContinue,
                        });
                        if (fairyOut && fairyOut.handoff) charmHandoff = fairyOut.handoff;

                        sidebar.setSteerQueue(null);
                        inspector.setSteerQueue(null);
                        bus.removeListener('event', _onFairyStarted);

                        if (runManager.isAborting) return;
                        lastFairyOut      = fairyOut;
                        let scroll        = fairyOut.scroll;
                        let scrollFileRef = fairyOut.fileRef;
                        await runManager.transition('SCROLL_SUBMITTED', {
                            questId: quest.id, charmId: charm.id, scrollId: scroll.id,
                        });

                        // ── Open + run clean.wb on delivery ──────────────────────
                        // Restart the kernel so clean.wb executes in a truly fresh
                        // session (no probe definitions bleeding in), then open and
                        // run all cells via the wolfbook notebook controller.
                        if (fairyOut.cleanNbPath) {
                            try {
                                await wolframShim.restartKernel().catch(() => {});
                                const _cleanUri = vscode.Uri.file(fairyOut.cleanNbPath);
                                const _cleanDoc = await vscode.workspace.openNotebookDocument(_cleanUri);
                                await vscode.window.showNotebookDocument(_cleanDoc, {
                                    viewColumn:    vscode.ViewColumn.Active,
                                    preserveFocus: false,
                                });
                                // Wait for VS Code to fully render the editor, then execute.
                                await new Promise(r => setTimeout(r, 1200));
                                await vscode.commands.executeCommand('notebook.executeAll');
                            } catch (_) {}
                        }

                        // ── Phase 4: Oberon verdict from the Fairy's clean.wb run ──
                        // The Fairy already restarted a fresh kernel and re-ran the
                        // whole clean.wb (run_clean); `fairyOut.status === 'delivered'`
                        // means that replay was clean. That IS the verification — the
                        // Skeptic/Wards critic layer was removed (it only re-ran clean.wb
                        // and counted warnings). The verdict is derived from the terminal
                        // status; a small shim keeps the Scribe / facts / telemetry
                        // consumers (which read `reviewOut.oberonVerdict.verdict` and
                        // `skResult.verdict`) working unchanged.
                        const verdict =
                            fairyOut.status === 'delivered'         ? 'success'
                            : fairyOut.status === 'partial_delivered' ? 'partial_success'
                            :                                           'failed';
                        let reviewOut = { oberonVerdict: { verdict }, skeptic: { verdict }, revisionsUsed: 0 };

                        // Oberon ingests the full clean.wb (per-cell code + actual
                        // output) so the executive follow-up reasons from what really
                        // ran, not a summary. Reuses the Director's deterministic reader.
                        let cleanDigest = '';
                        try {
                            cleanDigest = await analyst.digestCleanNotebook(
                                fairyOut.cleanNbPath || fairyOut.partialNbPath || null);
                        } catch (_) { cleanDigest = ''; }

                        await bus.appendEvent('research.verified', {
                            questId: quest.id, charmId: charm.id,
                            status:  fairyOut.status, verdict,
                            cleanRan: !!fairyOut.cleanNbPath,
                        }, { questId: quest.id, charmId: charm.id }).catch(() => {});

                        if (runManager.isAborting) return;
                        lastScroll        = scroll;
                        lastScrollFileRef = scrollFileRef;
                        lastReviewOut     = reviewOut;

                        // Wards removed with the Skeptic layer — nothing to synthesise.
                        let wardOut = null;
                        lastWardOut = wardOut;

                        // ── Phase 4c: Scribe — Grimoire entry ───────────────────
                        let grimoireResult = null;
                        try {
                            grimoireResult = await runScribe({
                                quest, charm, scroll, reviewOut, wardOut,
                                runId: bus && bus.runId,
                                bus,
                                scrollFileRef,
                            });
                        } catch (e) {
                            try {
                                await bus.appendEvent('omen', {
                                    kind:    'scribe_failed',
                                    message: e && e.message || String(e),
                                }, { questId: quest.id, charmId: charm.id });
                            } catch (_) {}
                        }
                        lastGrimoireResult = grimoireResult;

                        await bus.appendEvent('research.conclusion', {
                            questId:            quest.id,
                            scrollId:           scroll.id,
                            charmIndex:         charmIdx + 1,
                            charmTotal:         totalCharms,
                            summary:            scroll.summary   || '',
                            confidence:         scroll.confidence,
                            findingsCount:      Array.isArray(scroll.findings)      ? scroll.findings.length      : 0,
                            evidenceCount:      Array.isArray(scroll.evidence)      ? scroll.evidence.length      : 0,
                            openQuestionsCount: Array.isArray(scroll.openQuestions) ? scroll.openQuestions.length : 0,
                            findings:           Array.isArray(scroll.findings)
                                ? scroll.findings.map(f => ({ claim: typeof f === 'string' ? f : (f.claim || ''), confidence: typeof f === 'string' ? scroll.confidence : (f.confidence || 0) }))
                                : [],
                            openQuestions:      scroll.openQuestions || [],
                            oberonVerdict:      reviewOut && reviewOut.oberonVerdict && reviewOut.oberonVerdict.verdict || null,
                            cleanRan:           !!fairyOut.cleanNbPath,
                            cleanCellCount:     (scroll.fairyArtifact && Array.isArray(scroll.fairyArtifact.steps)) ? scroll.fairyArtifact.steps.length : 0,
                            grimoire:           grimoireResult
                                ? { wrote: !!grimoireResult.wrote, kind: grimoireResult.kind,
                                    findingsWritten: grimoireResult.findingsWritten || 0,
                                    findingsExcluded: grimoireResult.findingsExcluded || 0 }
                                : null,
                        });

                        // ── Bank verified facts so the next Charm can build on them ─
                        try {
                            const factsWritten = await establishedFacts.extractFactsFromScroll({
                                quest, charm, scroll,
                                skResult: reviewOut && reviewOut.skeptic,
                                bus,
                            });
                            if (factsWritten > 0) {
                                await bus.appendEvent('facts.extracted', {
                                    questId: quest.id, charmId: charm.id,
                                    count: factsWritten,
                                }, { questId: quest.id, charmId: charm.id });
                            }
                            // P-7 (user note): salvage WORKING facts from
                            // partial / failed scrolls so future Charms do
                            // not re-derive the same intermediate results.
                            if (memCfg.extractPartialFacts) {
                                const partialWritten = await establishedFacts.extractFactsFromPartialScroll({
                                    quest, charm, scroll,
                                    skResult: reviewOut && reviewOut.skeptic,
                                    bus,
                                });
                                if (partialWritten > 0) {
                                    await bus.appendEvent('facts.extracted', {
                                        questId: quest.id, charmId: charm.id,
                                        count: partialWritten, kind: 'partial',
                                    }, { questId: quest.id, charmId: charm.id });
                                }
                            }
                        } catch (_) {}

                        // ── Per-charm notebooks (charm findings; summary cumulative) ─
                        try {
                            const nbResult = await populateResearchNotebooks({
                                quest, charm, scroll, reviewOut,
                                bus,
                                show: charmIdx === totalCharms - 1,
                                closeCharm: charmIdx === totalCharms - 1,
                                existingCharmNotebookPath: fairyOut.cleanNbPath || fairyOut.partialNbPath || fairyOut.workingNbPath || null,
                            });
                            lastCharmNotebookPath   = nbResult.charmNotebookPath;
                            lastSummaryNotebookPath = nbResult.summaryNotebookPath;
                        } catch (_) {}

                        // ── P-9: Oberon executive analysis on non-success outcomes ──
                        // Trigger if Skeptic verdict ≠ 'success', or fallback scroll,
                        // or budget exhausted. Bounded by settings.executive().maxPerQuest
                        // so a long-running Quest with several failing Charms can still
                        // get diagnoses, without blowing the LLM bill.
                        const skepticV = reviewOut && reviewOut.skeptic && reviewOut.skeptic.verdict;
                        const isFailure = (skepticV && skepticV !== 'success')
                            || runManager.isBudgetExhausted
                            || (scroll && scroll.fallback);
                        const isLastCharm = (charmIdx === totalCharms - 1);
                        charmsCompleted = charmIdx + 1;   // pipeline for this charm is done
                        charmOutcomes.push({
                            id:             charm.id,
                            title:          charm.title || '',
                            status:         (scroll && scroll.fairyArtifact && scroll.fairyArtifact.status) || 'unknown',
                            skepticVerdict: skepticV || null,
                            verdict:        (reviewOut && reviewOut.oberonVerdict && reviewOut.oberonVerdict.verdict) || null,
                            confidence:     scroll ? scroll.confidence : null,
                        });
                        if (isFailure && executiveRunCount < execCfg.maxPerQuest) {
                            try {
                                executiveOut = await runExecutiveAnalysis({
                                    quest, charm, scroll, reviewOut,
                                    cleanNotebook: cleanDigest,
                                    budgetInfo: {
                                        budgetExhausted: !!runManager.isBudgetExhausted,
                                    },
                                    bus,
                                    signal: ctrl.signal,
                                });
                                executiveRunCount++;
                            } catch (e) {
                                try {
                                    await bus.appendEvent('omen', {
                                        kind: 'executive_failed',
                                        message: e && e.message || String(e),
                                    }, { questId: quest.id, charmId: charm.id });
                                } catch (_) {}
                            }
                            // Break out of the charm loop when the executive
                            // recommends a fundamentally different plan:
                            //   decompose_further   → create sub-charms
                            //   retry_subset        → rerun part of the plan
                            //   reformulate_brief   → rethink the approach
                            // BUT: 'extract_and_continue' on a non-last charm
                            // means "bank the facts and carry on with the next
                            // planned charm" — so we only break on it when this
                            // IS the last charm (no charms left to continue to).
                            const _execAction = executiveOut && executiveOut.action;
                            const _forceBreak = _execAction === 'decompose_further'
                                             || _execAction === 'retry_subset'
                                             || _execAction === 'reformulate_brief';
                            if (_forceBreak || (_execAction === 'extract_and_continue' && isLastCharm)) {
                                // Transparency (run Q29): a force-break on charm 1 of 4
                                // abandoned three planned charms without a trace.
                                if (_forceBreak && !isLastCharm) {
                                    const skippedIds = dispatched.slice(charmIdx + 1)
                                        .map(d => d.charm && d.charm.id).filter(Boolean);
                                    await bus.appendEvent('omen', {
                                        kind:    'charms_skipped_executive',
                                        message: `Executive action '${_execAction}' after charm ${charmIdx + 1}/${totalCharms} — ` +
                                                 `${skippedIds.length} planned charm(s) abandoned (${skippedIds.join(', ')}). ` +
                                                 'The follow-up brief replaces them.',
                                        detail:  { action: _execAction, skippedCharmIds: skippedIds },
                                    }, { questId: quest.id }).catch(() => {});
                                }
                                break;
                            }
                        }
                        if (!isLastCharm && runManager.isBudgetExhausted) {
                            // Never skip silently (run Q25: charm 4 of 4 vanished and the
                            // postmortem suggested "re-run with a sharper brief" — wrong
                            // remedy). Name the skipped charms and the actual cause.
                            charmsSkippedOnBudget = totalCharms - charmsCompleted;
                            const skippedIds = dispatched.slice(charmIdx + 1)
                                .map(d => d.charm && d.charm.id).filter(Boolean);
                            await bus.appendEvent('omen', {
                                kind:    'charms_skipped_budget',
                                message: `Per-run budget exhausted after charm ${charmsCompleted}/${totalCharms} — ` +
                                         `${charmsSkippedOnBudget} planned charm(s) never ran (${skippedIds.join(', ')}). ` +
                                         `Raise the wolfbook.oberon.budgets.run setting or re-run to continue; banked facts will carry over.`,
                                detail:  { skippedCharmIds: skippedIds, charmsCompleted, totalCharms },
                            }, { questId: quest.id });
                            break;
                        }
                    } // end per-charm loop

                    // Aliases used by remaining code (postmortem, toast, follow-up).
                    const charm         = lastCharm;
                    const charmFileRef  = lastCharmFileRef;
                    const fairyOut      = lastFairyOut;
                    const scroll        = lastScroll;
                    const scrollFileRef = lastScrollFileRef;
                    const reviewOut     = lastReviewOut;
                    const wardOut       = lastWardOut;
                    const grimoireResult = lastGrimoireResult;
                    const charmNotebookPath   = lastCharmNotebookPath;
                    const summaryNotebookPath = lastSummaryNotebookPath;

                    // Capture run identifiers/timings BEFORE endRun so the postmortem
                    // and other follow-ups still see them.
                    const _capturedRunId      = bus && bus.runId;
                    const _capturedRunSummary = runManager && runManager.summary
                        ? { ...runManager.summary } : null;
                    const _capturedRunEvents = bus && typeof bus.recent === 'function'
                        ? bus.recent(50000).slice() : [];
                    await runManager.endRun({ state: 'IDLE' });

                    // ── Step 3: Postmortem (deterministic, opt-in) ───────────────────────
                    // Failures never break the run — degrade silently to an omen.
                    try {
                        const pmCfg = settings.postmortem();
                        if (pmCfg && pmCfg.narrativeEnabled && _capturedRunId) {
                            const pmRef = await writePostmortem({
                                runId: _capturedRunId, brief,
                                quest, charm, scroll, reviewOut, wardOut,
                                grimoireResult,
                                summaryNotebookPath,
                                charmNotebookPath,
                                scrollFileRef,
                                runSummary: _capturedRunSummary,
                                runEvents: _capturedRunEvents,
                                charmOutcomes,
                                budgetInfo: {
                                    exhausted: !!runManager.isBudgetExhausted,
                                    charmsCompleted,
                                    totalCharms,
                                    charmsSkippedOnBudget,
                                },
                            });
                            if (pmRef && pmRef.path) {
                                try {
                                    await bus.appendEvent('postmortem.written', {
                                        runId: _capturedRunId, path: pmRef.path,
                                        questId: quest.id, charmId: charm.id,
                                    }, { questId: quest.id, charmId: charm.id });
                                } catch (_) {}
                            }
                        }
                    } catch (e) {
                        try {
                            await bus.appendEvent('omen', {
                                kind: 'postmortem_failed',
                                message: e && e.message || String(e),
                            }, { questId: quest.id, charmId: charm.id });
                        } catch (_) {}
                    }

                    // ── P-9: Auto-dispatch executive follow-up briefs ──────
                    // If the Oberon executive recommended a concrete next step,
                    // honour it by starting a new research run with the
                    // first follow-up brief. Remaining briefs are surfaced
                    // in the toast as additional "Continue with …" actions.
                    let executiveAutoBrief = null;
                    let executiveExtraBriefs = [];
                    if (executiveOut && Array.isArray(executiveOut.followUpBriefs) && executiveOut.followUpBriefs.length) {
                        const tag = ({
                            decompose_further:   '[Auto-decompose]',
                            retry_subset:        '[Auto-retry-subset]',
                            extract_and_continue:'[Auto-continue]',
                            reformulate_brief:   '[Auto-reformulated]',
                            escalate:            '[Auto-escalated to the stronger model]',
                        })[executiveOut.action] || '[Auto-followup]';
                        const factsPreview = executiveOut.factsWritten
                            ? `\n(${executiveOut.factsWritten} fact(s) banked to project memory.)`
                            : '';
                        executiveAutoBrief = [
                            `${tag} Continuing from ${quest.id}: ${quest.title || quest.shortName}`,
                            '',
                            `OBERON DIAGNOSIS: ${executiveOut.diagnosis}`,
                            factsPreview,
                            '',
                            'FOLLOW-UP TASK:',
                            executiveOut.followUpBriefs[0],
                        ].filter(Boolean).join('\n');
                        executiveExtraBriefs = executiveOut.followUpBriefs.slice(1);
                    }

                    // Toast — use Oberon verdict when available; fall back to confidence/summary.
                    const ov = reviewOut && reviewOut.oberonVerdict;
                    const charmCountSuffix = totalCharms > 1 ? ` (${totalCharms} charms)` : '';
                    const head = ov
                        ? `Oberon: ${ov.verdict.toUpperCase().replace('_', ' ')}${charmCountSuffix} — ${(ov.narrative || '').slice(0, 200)}`
                        : `Oberon: ${(scroll && scroll.summary || 'Research complete').slice(0, 200)}${charmCountSuffix}` +
                          (scroll ? ` (conf ${scroll.confidence.toFixed(2)})` : '');

                    const isSuccess = ov && ov.verdict === 'success';
                    const openQs    = Array.isArray(scroll && scroll.openQuestions) ? scroll.openQuestions : [];

                    // ── Auto-dispatch executive follow-up (FM-6 — Oberon must
                    //    not give up). Gated by settings + recursion-depth cap.
                    if (executiveAutoBrief
                        && execCfg.autoDispatch
                        && execCfg.maxAutoFollowups > 0
                        && autoFollowupDepth < execCfg.maxAutoFollowups
                        && !runManager.isAborting) {
                        const extraNote = executiveExtraBriefs.length
                            ? '\n\nADDITIONAL FOLLOW-UP TASKS (decompose into subtasks):\n' +
                              executiveExtraBriefs.map((b, i) => `${i + 1}. ${b}`).join('\n')
                            : '';
                        const nextDepth = autoFollowupDepth + 1;
                        try {
                            await bus.appendEvent('executive.auto_dispatched', {
                                questId: quest.id,
                                action: executiveOut.action,
                                depth: nextDepth,
                                maxDepth: execCfg.maxAutoFollowups,
                            });
                        } catch (_) {}
                        vscode.window.showInformationMessage(
                            `${head}\n\n→ Auto-dispatching Oberon follow-up (${nextDepth}/${execCfg.maxAutoFollowups}).`
                        );
                        setImmediate(() => dispatch('startResearch', {
                            brief: executiveAutoBrief + extraNote,
                            __autoFollowupDepth: nextDepth,
                            // 'escalate' means the cheap model is out of its depth:
                            // rebind the retry to the stronger judgment role. One
                            // level only — the depth cap still bounds the recursion.
                            __escalateRole: executiveOut.action === 'escalate' ? 'oberon' : undefined,
                        }));
                        return; // skip the manual toast — auto-dispatch supersedes it
                    }

                    const actions   = ['Open Scroll'];
                    if (executiveAutoBrief) actions.push('Run Oberon Follow-up');
                    // Always offer steering unless it was a clean success with no open questions.
                    if (!isSuccess || openQs.length > 0) actions.push('Steer & Continue');

                    vscode.window.showInformationMessage(head, ...actions).then(async choice => {
                        if (choice === 'Open Scroll' && scrollFileRef && scrollFileRef.path) {
                            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(scrollFileRef.path));
                        }
                        if (choice === 'Run Oberon Follow-up' && executiveAutoBrief) {
                            // If there are extra briefs, surface them in the
                            // first follow-up brief so the next Planner can
                            // decompose them as further subtasks.
                            const extraNote = executiveExtraBriefs.length
                                ? '\n\nADDITIONAL FOLLOW-UP TASKS (decompose into subtasks):\n' +
                                  executiveExtraBriefs.map((b, i) => `${i + 1}. ${b}`).join('\n')
                                : '';
                            setImmediate(() => dispatch('startResearch', { brief: executiveAutoBrief + extraNote }));
                        }
                        if (choice === 'Steer & Continue') {
                            const steeringText = await vscode.window.showInputBox({
                                prompt: 'Add steering instructions for Oberon (leave blank to auto-continue)',
                                placeHolder: 'Focus on the BAE solutions, verify the boundary conditions...',
                                ignoreFocusOut: true,
                            });
                            const established = Array.isArray(scroll && scroll.findings)
                                ? scroll.findings.slice(0, 4).map((f, i) => {
                                    const c = typeof f === 'string' ? f : (f.claim || '');
                                    return `${i + 1}. ${c.slice(0, 300)}`;
                                  }).join('\n')
                                : '';
                            const followUpBrief = [
                                `Continuing research from ${quest.id}: ${quest.title || quest.shortName}`,
                                '',
                                steeringText && steeringText.trim()
                                    ? `STEERING INSTRUCTIONS:\n${steeringText.trim()}`
                                    : '',
                                '',
                                openQs.length > 0
                                    ? `OPEN QUESTIONS to resolve:\n${openQs.slice(0, 6).map((q, i) => `${i + 1}. ${q}`).join('\n')}`
                                    : '',
                                '',
                                established
                                    ? `ESTABLISHED FACTS (do not re-derive):\n${established}`
                                    : '',
                            ].filter(Boolean).join('\n');
                            setImmediate(() => dispatch('startResearch', { brief: followUpBrief }));
                        }
                    });
                } catch (e) {
                    const aborted = runManager.isAborting || (e && (e.kind === 'provider_error') && /abort/i.test(String(e.message)));
                    // If the user abort handler already ended the run, do not re-end it.
                    if (runManager.isActive) {
                        const targetState = aborted ? 'ABORTED' : 'ERROR';
                        // Skip the omen when the failing layer already reported it
                        // (planner marks e._omened) — one failure, one omen.
                        if (!aborted && !(e && e._omened)) {
                            await bus.appendEvent('omen', {
                                kind:    (e && e.kind) || 'planner_failed',
                                message: e && e.message || String(e),
                                detail:  e && e.detail || null,
                            });
                        }
                        try { await runManager.transition(targetState); } catch (_) {}
                        await runManager.endRun({ state: targetState });
                    }
                    if (!aborted) {
                        // A failed run must not vanish: leave a postmortem stub and
                        // offer a retry (auto-dispatched follow-up chains previously
                        // died silently here — run_2026-07-03T23-38).
                        try {
                            await writeErrorPostmortem({
                                runSummary: runManager.summary, brief,
                                error: e, bus,
                            });
                        } catch (_) {}
                        const msg = `Oberon run failed: ${String(e && e.message || e).slice(0, 300)}`;
                        vscode.window.showErrorMessage(msg, 'Retry brief').then(choice => {
                            if (choice === 'Retry brief') {
                                setImmediate(() => dispatch('startResearch', { brief, __autoFollowupDepth: autoFollowupDepth }));
                            }
                        });
                    }
                } finally {
                    runManager.clearAbortController();
                }
                return;
            }
        } catch (e) {
            const msg = `Oberon command '${cmd}' failed: ${e && e.message || e}`;
            try { await bus.appendEvent('omen', { kind: 'dispatch_error', message: msg }); } catch (_) {}
            vscode.window.showErrorMessage(msg);
        }
    }
}

/**
 * Drive a deterministic fake run through every event type so the two UI
 * surfaces can be visually verified end-to-end without LLM/kernel deps.
 *
 * @param {{ bus: TelemetryBus, runManager: RunManager }} deps
 */
async function emitMockEvents({ bus, runManager }) {
    if (runManager.isActive) {
        vscode.window.showWarningMessage('Oberon: cannot emit mock events while a real run is active.');
        return;
    }
    await runManager.beginRun({ brief: 'MOCK: validate the UI plumbing' });
    const questId = 'Q00_mock';
    const charmId = 'C00_mock';
    const span    = makeSpanId();

    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const ev   = (type, payload, opts) => bus.appendEvent(type, payload, { questId, charmId, spanId: span, ...(opts || {}) });

    await ev('circle.transition', { from: 'BRIEFING', to: 'QUEST_DEFINED' });
    await wait(150);
    await ev('llm.call', {
        role: 'oberon', provider: 'deepseek', model: 'deepseek-reasoner',
        usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 480, cacheWriteTokens: null },
        costUSD: 0.0023, latencyMs: 4200, cacheBreakpoints: 2, stopReason: 'end',
        promptBlob: null, responseBlob: null,
    });
    await ev('quest.accepted', { questId, title: 'Mock quest for UI validation' });
    await wait(200);
    await ev('charm.dispatched', { questId, charmId, title: 'Mock charm', taskPreview: 'Validate the activity-feed plumbing end-to-end.' });
    await ev('circle.transition', { from: 'QUEST_DEFINED', to: 'CHARM_DISPATCHED' });
    await wait(120);
    await ev('circle.transition', { from: 'CHARM_DISPATCHED', to: 'FAIRY_WORKING' });
    await ev('fairy.started', { questId, charmId, provider: 'deepseek', model: 'deepseek-chat' });
    await wait(150);
    await ev('llm.call', {
        role: 'fairy', provider: 'deepseek', model: 'deepseek-chat',
        usage: { inputTokens: 800, outputTokens: 420, cacheReadTokens: null, cacheWriteTokens: null },
        costUSD: 0.0011, latencyMs: 2600, stopReason: 'end',
    });
    await wait(150);
    await ev('tool.call', { name: 'wolframEval', args: { code: 'Simplify[…]' }, ok: true, durationMs: 320 });
    await wait(150);
    await ev('spell.exec', { summary: 'Simplify[Sin[x]^2 + Cos[x]^2]', timingMs: 120, messages: [] });
    await ev('ward.result', {
        wardType: 'numeric_random', passed: true,
        detail: '20/20 samples agreed within 1e-10',
        evidence: [{ path: 'quests/Q00_mock/artefacts/ward.json', sha256: 'sha256:demo' }],
    });
    await wait(150);
    await ev('circle.transition', { from: 'FAIRY_WORKING', to: 'SCROLL_SUBMITTED' });
    await ev('scroll.submitted', {
        questId, charmId, scrollId: 'S01',
        confidence: 0.85, findingsCount: 3, openQuestionsCount: 1,
        selfCheckSummary: { passed: 1, total: 1 },
        file: { path: 'quests/Q00_mock/scrolls/S01.json', sha256: 'sha256:demo' },
    });
    await wait(100);
    await ev('circle.transition', { from: 'SCROLL_SUBMITTED', to: 'REVIEWING' });
    await ev('llm.call', {
        role: 'oberon', provider: 'deepseek', model: 'deepseek-reasoner',
        usage: { inputTokens: 1800, outputTokens: 220, cacheReadTokens: 1100, cacheWriteTokens: null },
        costUSD: 0.0019, latencyMs: 3100,
    });
    await wait(120);
    await ev('oberon.decision', { verdict: 'accept', rationale: 'Ward passed; Grimoire updated.' });
    await ev('grimoire.write', { added: 1, narrativePatchBytes: 240 });
    await ev('omen', { kind: 'note', message: 'Mock complete.' });
    await ev('circle.transition', { from: 'REVIEWING', to: 'GRIMOIRE_UPDATED' });
    await wait(100);
    await runManager.endRun({ state: 'IDLE' });
}

function deactivate() { /* nothing extra — registrations live in subscriptions */ }

/**
 * Bump the patch version in package.json, quick-deploy the oberon folder to the
 * running extension installation, and offer a window reload.
 *
 * Source directory is discovered by searching workspace folders for a package.json
 * with `"name": "wolfbook"`.  The destination is derived from context.extensionPath.
 */
async function bumpAndDeploy(context) {
    const path   = require('path');
    const fs     = require('fs');
    const { execSync } = require('child_process');

    // 1. Find the source (dev) directory.
    let devDir = null;
    const wsf = vscode.workspace.workspaceFolders || [];
    for (const f of wsf) {
        const candidate = f.uri.fsPath;
        const pkgFile = path.join(candidate, 'package.json');
        try {
            const p = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
            if (p.name === 'wolfbook') { devDir = candidate; break; }
        } catch (_) {}
    }
    if (!devDir) {
        vscode.window.showErrorMessage('Oberon Bump & Deploy: could not find "Extension Development" workspace folder. Open it in VS Code first.');
        return;
    }

    // 2. Bump patch version.
    const pkgFile = path.join(devDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const [major, minor, patch] = pkg.version.split('.').map(Number);
    const newVersion = `${major}.${minor}.${patch + 1}`;
    pkg.version = newVersion;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

    // 3. Quick-deploy: rsync oberon folder from dev dir to running extension install.
    const srcOberon = path.join(devDir, 'out', 'extension', 'oberon') + '/';
    const dstOberon = path.join(context.extensionPath, 'out', 'extension', 'oberon') + '/';
    try {
        execSync(`rsync -a --delete "${srcOberon}" "${dstOberon}"`, { stdio: 'pipe' });
    } catch (err) {
        vscode.window.showErrorMessage(`Oberon Bump & Deploy: rsync failed — ${err.stderr || err.message}`);
        return;
    }

    // 4. Notify and offer reload.
    const answer = await vscode.window.showInformationMessage(
        `Oberon bumped to v${newVersion} and deployed. Reload window to apply?`,
        'Reload Now', 'Later',
    );
    if (answer === 'Reload Now') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/**
/**
 * Index to append a cell at the END of working.wb WITHOUT landing after the pinned
 * status box. If the last cell is the status cell, insert just before it so the
 * status stays last (util banners, checkpoints, skills all use this).
 */
function _endInsertIndex(nbDoc) {
    const n = nbDoc.cellCount;
    if (n > 0) {
        try {
            const last = nbDoc.cellAt(n - 1);
            if (last && last.metadata && last.metadata.oberon === 'status') return n - 1;
        } catch (_) {}
    }
    return n;
}

/**
 * Insert the fairy's plan as a numbered roadmap at the top of working.wb.
 *
 * @param {vscode.NotebookDocument} nbDoc
 * @param {{ steps: string[], note?: string }} payload
 */
async function _insertPlanRoadmap(nbDoc, payload) {
    const vscode = require('vscode');
    const steps  = (payload && payload.steps) || [];
    const note   = (payload && payload.note)  || '';

    const lines = ['## 📋 Plan'];
    if (note) lines.push('', `*${note}*`);
    lines.push('');
    // Defense in depth: steps should be normalized strings (handlePlan), but an
    // object slipping through must never render as "[object Object]".
    const stepText = (s) => typeof s === 'string' ? s
        : (s && typeof s === 'object' && (s.step || s.title || s.text || s.description))
            ? String(s.step || s.title || s.text || s.description)
            : JSON.stringify(s);
    steps.forEach((s, i) => lines.push(`${i + 1}. ${stepText(s)}`));

    const md   = lines.join('\n');
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown');
    cell.metadata = { oberon: 'plan-roadmap' };

    const edit = new vscode.WorkspaceEdit();
    edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(0, [cell])]);
    await vscode.workspace.applyEdit(edit);
}

/**
 * Insert a visual checkpoint banner into the live working.wb tab.
 *
 * @param {vscode.NotebookDocument} nbDoc
 * @param {{ sectionTitle: string, stepsIncluded: string[], note?: string }} payload
 */
async function _insertCheckpointBanner(nbDoc, payload) {
    const vscode = require('vscode');
    const title   = (payload && payload.sectionTitle)  || 'Checkpoint';
    const steps   = (payload && payload.stepsIncluded) || [];
    const note    = (payload && payload.note)          || '';

    // Short context: first ~80 chars of title + step count
    const titleShort = title.length > 80 ? title.slice(0, 77) + '…' : title;
    const stepList   = steps.length ? steps.slice(0, 6).join(', ') + (steps.length > 6 ? ` …+${steps.length - 6}` : '') : '';

    const lines = [
        `## 🏁 Checkpoint — ${titleShort}`,
        '',
        `**Steps committed:** ${stepList || '(none)'}`,
    ];
    if (note) lines.push('', `*${note}*`);

    const md = lines.join('\n');
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown');
    cell.metadata = { oberon: 'checkpoint-banner' };

    const edit = new vscode.WorkspaceEdit();
    edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(_endInsertIndex(nbDoc), [cell])]);
    await vscode.workspace.applyEdit(edit);

    // O7: refresh the pinned "Run ledger" cell at the top of the notebook.
    await _updateRunLedger(nbDoc, payload).catch(() => {});
}

/**
 * Insert (or replace) the "Skills used" + citation markdown cell near the end of
 * working.wb, so the live notebook lists the SkilXiv skills used, the skill-page
 * link, the usefulness conclusion, and a suggested citation.
 */
async function _insertSkillsUsed(nbDoc, payload) {
    const vscode = require('vscode');
    const md = payload && payload.markdown;
    if (!md) return;
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, String(md), 'markdown');
    cell.metadata = { oberon: 'skills-used' };

    let existingIdx = -1;
    for (let i = 0; i < nbDoc.cellCount; i++) {
        const c = nbDoc.cellAt(i);
        if (c.metadata && c.metadata.oberon === 'skills-used') { existingIdx = i; break; }
    }
    const edit = new vscode.WorkspaceEdit();
    if (existingIdx >= 0) {
        edit.set(nbDoc.uri, [
            vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(existingIdx, existingIdx + 1)),
            vscode.NotebookEdit.insertCells(_endInsertIndex(nbDoc), [cell]),
        ]);
    } else {
        edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(_endInsertIndex(nbDoc), [cell])]);
    }
    await vscode.workspace.applyEdit(edit);
}

/**
 * Dev self-postmortem cell: the agent's own structured account of the session
 * (fired right before compile / at explore exhaustion). Replaces any previous
 * self-postmortem cell so continuation runs show only the latest.
 */
async function _insertSelfPostmortem(nbDoc, payload) {
    const vscode = require('vscode');
    const md = payload && payload.markdown;
    if (!md) return;
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, String(md), 'markdown');
    cell.metadata = { oberon: 'self-postmortem' };

    let existingIdx = -1;
    for (let i = 0; i < nbDoc.cellCount; i++) {
        const c = nbDoc.cellAt(i);
        if (c.metadata && c.metadata.oberon === 'self-postmortem') { existingIdx = i; break; }
    }
    const edit = new vscode.WorkspaceEdit();
    if (existingIdx >= 0) {
        edit.set(nbDoc.uri, [
            vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(existingIdx, existingIdx + 1)),
            vscode.NotebookEdit.insertCells(_endInsertIndex(nbDoc), [cell]),
        ]);
    } else {
        edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(_endInsertIndex(nbDoc), [cell])]);
    }
    await vscode.workspace.applyEdit(edit);
}

/**
 * P6: trace a registered util into working.wb — a small header + the definition code,
 * so the user can see the reusable building blocks as they're created.
 */
async function _insertUtilBanner(nbDoc, payload) {
    const vscode = require('vscode');
    const { buildUtilBanner } = require('./fairy/notebookBanners');
    const md = buildUtilBanner(payload || {});
    const cells = [new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown')];
    cells[0].metadata = { oberon: 'util-banner' };
    if (payload && payload.code) {
        const codeCell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, String(payload.code), 'wolfram');
        codeCell.metadata = { oberon: 'util-def' };
        cells.push(codeCell);
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(_endInsertIndex(nbDoc), cells)]);
    await vscode.workspace.applyEdit(edit);
}

/**
 * Insert a live "Literature" summary cell into working.wb when a research_literature
 * search completes — relevant papers (+ why), extracted relations/observations, and
 * what was read-and-rejected. Inserted before the pinned status cell.
 */
async function _insertLiteratureBrief(nbDoc, payload) {
    const vscode = require('vscode');
    const md = payload && payload.markdown;
    if (!md) return;
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, String(md), 'markdown');
    cell.metadata = { oberon: 'literature-brief' };
    const edit = new vscode.WorkspaceEdit();
    edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(_endInsertIndex(nbDoc), [cell])]);
    await vscode.workspace.applyEdit(edit);
}

/**
 * Modal prompt shown when a fairy run would stop (budget exhausted or the model wants
 * to escalate). On "Continue" the run extends its budget and resumes from where it was.
 * @param {{kind,reason,records,noteFacts,probesUsed,turnsUsed,continuation}} info
 * @returns {Promise<boolean>}
 */
async function _askFairyContinue(info) {
    const vscode = require('vscode');
    const { kind, reason, records = 0, noteFacts = 0, probesUsed = 0, turnsUsed = 0, continuation = 1 } = info || {};
    const found = `${records} recorded step(s) + ${noteFacts} fact(s)`;
    let msg, grant;
    if (kind === 'polish') {
        msg = `The clean notebook still has warnings/errors (${reason || 'not yet clean'}). Fairy has ${found}.`;
        grant = 'more polish budget to finish fixing every warning';
    } else if (kind === 'budget') {
        msg = `Fairy ran out of budget (${probesUsed} probes, ${turnsUsed} turns) with ${found} so far.`;
        grant = 'a fresh budget (+15 probes, +25 turns)';
    } else {
        msg = `Fairy is about to stop (${reason || 'escalate'}) with ${found} so far.`;
        grant = 'a fresh budget (+15 probes, +25 turns)';
    }
    const detail = `Continue with ${grant} and resume?` + (continuation > 1 ? `  (continuation #${continuation})` : '');
    try {
        const pick = await vscode.window.showInformationMessage(msg, { modal: true, detail }, 'Continue', 'Stop');
        return pick === 'Continue';
    } catch (_) { return false; }
}

/**
 * P7: maintain a single pinned status cell at the TOP of working.wb — phase, remaining
 * budget, and the last few lines of the model's reasoning ("thinking…"), swapping to a
 * final ✅/▢ on completion. Throttled (≤1 update / 800 ms) and never throws.
 */
let _lastStatusWrite = 0;
// Carry phase/budget from the per-turn fairy.status event so the live reasoning
// stream (llm.reasoning_progress / response_progress) can render a full status line.
let _lastStatusMeta = { phase: 'explore', budgetLeft: undefined };
// SERIALIZE status edits. applyEdit is async; rapid streaming updates fired faster than
// edits commit caused the find-by-metadata to read pre-edit state (no status cell yet)
// and INSERT a new cell each time → a pile of stale "thinking…" cells. Only one edit is
// in flight at a time; intermediate updates coalesce to the latest.
let _statusBusy = false;
let _statusQueued = null;

async function _updateStatusCell(nbDoc, payload) {
    const now = Date.now();
    if (!(payload && payload.done) && now - _lastStatusWrite < 600) return;  // throttle
    if (_statusBusy) { _statusQueued = { nbDoc, payload }; return; }          // coalesce
    _statusBusy = true;
    _lastStatusWrite = now;
    try { await _applyStatusEdit(nbDoc, payload); } catch (_) {}
    _statusBusy = false;
    if (_statusQueued) {
        const q = _statusQueued; _statusQueued = null;
        setImmediate(() => { _lastStatusWrite = 0; _updateStatusCell(q.nbDoc, q.payload).catch(() => {}); });
    }
}

async function _applyStatusEdit(nbDoc, payload) {
    const vscode = require('vscode');
    const { buildStatusHtml } = require('./fairy/notebookBanners');
    const md = buildStatusHtml(payload || {});
    // Find ALL status cells (so any duplicates left by an earlier race are cleaned up).
    const idxs = [];
    for (let i = 0; i < nbDoc.cellCount; i++) {
        const c = nbDoc.cellAt(i);
        if (c.metadata && c.metadata.oberon === 'status') idxs.push(i);
    }
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown');
    cell.metadata = { oberon: 'status' };
    const edit = new vscode.WorkspaceEdit();
    if (idxs.length === 0) {
        edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(nbDoc.cellCount, [cell])]);
    } else if (idxs.length === 1) {
        // Update in place — no move, no jump.
        edit.set(nbDoc.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(idxs[0], idxs[0] + 1), [cell])]);
    } else {
        // Self-heal: keep the first, replace it, delete the rest (higher indices first).
        const ops = [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(idxs[0], idxs[0] + 1), [cell])];
        for (const i of idxs.slice(1).reverse()) ops.push(vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(i, i + 1)));
        edit.set(nbDoc.uri, ops);
    }
    await vscode.workspace.applyEdit(edit);
}

// Live literature-discovery stream → status cell. The literature sub-agent blocks in
// one tool call for a long time (search rounds + full-text reads); without this the
// status cell freezes and the run looks broken. We accumulate the sub-agent's stage
// progress into a scrolling log and render it through the same status cell.
let _litLog = [];
function _formatLitLine(payload) {
    const stage  = String((payload && payload.stage) || '');
    const detail = String((payload && payload.detail) || '').trim();
    const glyph = {
        start:     '🔎', plan: '🧭', search: '🔎', graph: '🕸️',
        preselect: '📑', read: '📖', judge: '⚖️', done: '✅',
    }[stage] || '•';
    const label = {
        start: 'Literature search', plan: 'Query plan', search: 'Searching',
        graph: 'Citation graph', preselect: 'Preselect', read: 'Reading',
        judge: 'Judging', done: 'Literature done',
    }[stage] || stage;
    return `${glyph} ${label}${detail ? ': ' + detail : ''}`;
}
async function _appendLiteratureProgress(nbDoc, payload) {
    const line = _formatLitLine(payload);
    if (!line) return;
    // A new search restarts the log so stages from a prior call don't pile up.
    if (payload && payload.stage === 'start') _litLog = [];
    _litLog.push(line);
    if (_litLog.length > 60) _litLog = _litLog.slice(-60);
    await _updateStatusCell(nbDoc, {
        phase:       'literature',
        budgetLeft:  _lastStatusMeta.budgetLeft,
        probesUsed:  _lastStatusMeta.probesUsed,
        turnsUsed:   _lastStatusMeta.turnsUsed,
        costUSD:     _lastStatusMeta.costUSD,
        thinkingTail: _litLog.join('\n'),
    });
}

// Live reasoning stream → status cell. Merges the streaming preview with the last
// known phase/budget so the user watches the model think between turns, not just at
// the end of each turn.
async function _streamStatusReasoning(nbDoc, payload) {
    // Pass the full streamed preview (buildStatusHtml caps + wraps it in the scroll box).
    await _updateStatusCell(nbDoc, {
        phase:       _lastStatusMeta.phase,
        budgetLeft:  _lastStatusMeta.budgetLeft,
        probesUsed:  _lastStatusMeta.probesUsed,
        turnsUsed:   _lastStatusMeta.turnsUsed,
        costUSD:     _lastStatusMeta.costUSD,
        thinkingTail: (payload && payload.preview) || '',
    });
}

/**
 * Director stage live view: replicate the quick-compute working.wb wiring for
 * ONE fairy stage — recreate + open the scratchpad on fairy.started, stream
 * plan/checkpoint/skills/util/literature/status events into it. Returns
 * { getDoc, dispose }; create one per stage and dispose when the stage ends.
 */
function _makeFairyLiveView(bus) {
    let _doc = null;
    const handler = async (ev) => {
        if (ev.type === 'fairy.started' && !_doc) {
            const nbPath = ev.payload && ev.payload.workingNbPath;
            if (!nbPath) return;
            try {
                const fsp = require('fs/promises');
                const nbUri = vscode.Uri.file(nbPath);
                await fsp.writeFile(nbPath, JSON.stringify({ cells: [], metadata: {} }, null, 2), 'utf8');
                for (const tabGroup of vscode.window.tabGroups.all) {
                    for (const tab of tabGroup.tabs) {
                        if (tab.input instanceof vscode.TabInputNotebook &&
                            tab.input.uri.fsPath === nbPath) {
                            await vscode.window.tabGroups.close(tab, true).catch(() => {});
                        }
                    }
                }
                _doc = await vscode.workspace.openNotebookDocument(nbUri);
                await vscode.window.showNotebookDocument(_doc, {
                    viewColumn: vscode.ViewColumn.Active, preserveFocus: true,
                });
                await wolframShim.associateNotebook(_doc).catch(() => {});
                try {
                    const supp = wolframShim.buildSuppressionCode && wolframShim.buildSuppressionCode();
                    if (supp) await wolframShim.evalInNotebook(_doc, supp, { note: 'Suppress non-critical solver warnings (Off[…])' }).catch(() => {});
                } catch (_) {}
            } catch (_) {}
        } else if (ev.type === 'plan.created' && _doc) {
            _insertPlanRoadmap(_doc, ev.payload).catch(() => {});
        } else if (ev.type === 'checkpoint.recorded' && _doc) {
            _insertCheckpointBanner(_doc, ev.payload).catch(() => {});
        } else if (ev.type === 'skills.used' && _doc) {
            _insertSkillsUsed(_doc, ev.payload).catch(() => {});
        } else if (ev.type === 'fairy.self_postmortem' && _doc) {
            _insertSelfPostmortem(_doc, ev.payload).catch(() => {});
        } else if (ev.type === 'util.registered' && _doc) {
            _insertUtilBanner(_doc, ev.payload).catch(() => {});
        } else if (ev.type === 'literature.brief' && _doc) {
            _insertLiteratureBrief(_doc, ev.payload).catch(() => {});
        } else if (ev.type === 'literature.progress' && _doc) {
            _appendLiteratureProgress(_doc, ev.payload).catch(() => {});
        } else if (ev.type === 'fairy.status' && _doc) {
            if (!ev.payload || !ev.payload.done) {
                const p = ev.payload || {};
                _lastStatusMeta = { phase: p.phase, budgetLeft: p.budgetLeft, probesUsed: p.probesUsed, turnsUsed: p.turnsUsed, costUSD: p.costUSD };
            }
            _updateStatusCell(_doc, ev.payload).catch(() => {});
        } else if ((ev.type === 'llm.reasoning_progress' || ev.type === 'llm.response_progress') && _doc) {
            _streamStatusReasoning(_doc, ev.payload).catch(() => {});
        }
    };
    bus.on('event', handler);
    return {
        getDoc: () => _doc,
        dispose: () => { try { bus.removeListener('event', handler); } catch (_) {} },
    };
}

/**
 * Director-level literature consult: same bounded sub-agent the fairy uses
 * (arXiv + Semantic Scholar + INSPIRE, read-then-judge, citation graph), wired
 * with the `literature` role LLM. Returns an async ({question}) → brief, or a
 * fn that resolves null when the paper tools are unavailable.
 */
function _makeDirectorLiterature({ bus, signal }) {
    let paperSearch;
    try { paperSearch = require('../tools/paperSearch'); } catch (_) { return async () => null; }
    const paperTools = {
        searchPapers: (params, max, opts) =>
            paperSearch.searchPapers({ ...params, query: (params && (params.q || params.query)) || '' }, max, opts),
        searchArxiv:     (params, max, opts) => paperSearch.searchArxiv(params, max, opts),
        searchInspire:   (params, max, opts) => paperSearch.searchInspire(params, max, opts),
        searchSemanticScholar: (params, max) => paperSearch.searchSemanticScholar(params, max),
        fetchPaperHtml:  paperSearch.fetchPaperHtml,
        extractSections: paperSearch.extractSections,
        getInspireBibtex: paperSearch.getInspireBibtex,
        getInspireReferences: paperSearch.getInspireReferences,
        getCitationContexts:  paperSearch.getCitationContexts,
    };
    const roles = require('./config/roles');
    const { getAdapter } = require('./providers');
    const litBinding = roles.resolveRole('literature');
    const litAdapter = litBinding.configured ? getAdapter(litBinding.provider) : null;
    const litLlm = litAdapter
        ? async (prompt) => {
            try {
                const res = await litAdapter.chatComplete({
                    messages: [
                        { role: 'system', content: 'You are a precise literature-extraction assistant for physics/math papers. Answer tersely and exactly as instructed.' },
                        { role: 'user',   content: String(prompt) },
                    ],
                    model:       litBinding.model,
                    temperature: 0.1,
                    maxTokens:   litBinding.maxTokens || 2000,
                    signal,
                }, { pricing: litBinding.pricing });
                bus.appendEvent('llm.call', {
                    role: 'literature', model: litBinding.model,
                    usage: res.usage || {}, costUSD: res.costUSD || null,
                }).catch(() => {});
                return res.content || '';
            } catch (_) { return ''; }
        }
        : null;
    return async ({ question }) => {
        const { runResearch, extractArxivIds } = require('./fairy/literature');
        return runResearch({
            question: String(question || ''),
            seedIds: extractArxivIds(String(question || '')),
            paperTools, llm: litLlm, signal,
            onProgress: (p) => bus.appendEvent('literature.progress', p).catch(() => {}),
        });
    };
}

/** Director-level SkilXiv recon for the plan step (fail-open, ≤5 hits). */
async function _directorSkillSearch(query) {
    try {
        const settings = require('./config/settings');
        const cfg = settings.recall();
        if (!cfg.enabled) return '';
        const client = await require('./fairy/skilxivCredentials').createClient({ baseUrl: cfg.skilxivBaseUrl });
        const res = await client.search(String(query || ''), { limit: 5, minTier: 0 });
        const results = (res && res.results) || [];
        if (!results.length) return '';
        return results.map(r =>
            `- @${r.namespace}/${r.name}${r.version ? ' v' + r.version : ''} — ${String(r.summary || '').slice(0, 200)}`
        ).join('\n');
    } catch (_) { return ''; }
}

/**
 * O7: maintain a single pinned "Run ledger" markdown cell at the top of working.wb
 * summarising the run spine — registered utils, recorded steps, and established facts —
 * so the user can see the durable result amid the probe scratch. Replaces the existing
 * ledger cell if present, else inserts one at index 0.
 */
async function _updateRunLedger(nbDoc, payload) {
    const vscode = require('vscode');
    const charmDir = payload && payload.charmDir;
    if (!charmDir) return;
    let wd;
    try { wd = require('./fairy/workDir').openWorkDir(charmDir); } catch (_) { return; }

    const data = await wd.buildLedgerData().catch(() => ({ symbols: [], facts: [] }));
    const symbols = data.symbols || [];
    const facts   = data.facts   || [];
    if (!symbols.length && !facts.length) return;

    // Render readable markdown tables (no run-on code blocks).
    const td = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
    const trunc = (s, n) => { s = td(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const lines = ['# 📒 Run ledger', ''];
    if (symbols.length) {
        lines.push('### Defined — call by name', '',
            '| Symbol(s) | Source | Description |', '|---|---|---|');
        for (const s of symbols) lines.push(`| \`${trunc(s.name, 40)}\` | ${trunc(s.kind, 28)} | ${trunc(s.note, 80)} |`);
        lines.push('');
    }
    if (facts.length) {
        lines.push('### Established results', '',
            '| Result | Conf. | Value |', '|---|---|---|');
        for (const f of facts) lines.push(`| ${trunc(f.key, 36)} | ${td(f.confidence)} | ${trunc(f.value, 80)} |`);
    }
    const md = lines.join('\n');

    // Find an existing ledger cell by metadata.
    let existingIdx = -1;
    for (let i = 0; i < nbDoc.cellCount; i++) {
        const c = nbDoc.cellAt(i);
        if (c.metadata && c.metadata.oberon === 'run-ledger') { existingIdx = i; break; }
    }
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown');
    cell.metadata = { oberon: 'run-ledger' };
    const edit = new vscode.WorkspaceEdit();
    if (existingIdx >= 0) {
        edit.set(nbDoc.uri, [
            vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(existingIdx, existingIdx + 1)),
            vscode.NotebookEdit.insertCells(0, [cell]),
        ]);
    } else {
        edit.set(nbDoc.uri, [vscode.NotebookEdit.insertCells(0, [cell])]);
    }
    await vscode.workspace.applyEdit(edit);
}

module.exports = { activate, deactivate };
