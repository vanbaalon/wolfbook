/* Oberon — Control Room webview renderer.
 *
 * Browser context (no Node access). Talks to controlRoom.js extension side via
 * acquireVsCodeApi(). Posts `scriptLoaded` on attach to trigger the snapshot
 * replay (race-fix pattern from watchPanel).
 */

(function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    const TO   = {
        SNAPSHOT_FULL:     'snapshot.full',
        EVENT_APPEND:      'event.append',
        EVENT_BATCH:       'event.batch',
        METRICS_UPDATE:    'metrics.update',
        SETTINGS_SNAPSHOT: 'settings.snapshot',
        OMEN:              'omen',
    };
    const FROM = {
        SCRIPT_LOADED:        'scriptLoaded',
        ABORT_RUN:            'abortRun',
        START_RESEARCH:       'startResearch',
        START_FAIRY:          'startFairy',
        START_DIRECTOR:       'startDirector',
        OPEN_RUN_INSPECTOR:   'openRunInspector',
        OPEN_CHARM_DEBUGGER:  'openCharmDebugger',
        OPEN_SETTINGS:        'openSettings',
        CONFIGURE_PROVIDERS:  'configureProviders',
        EMIT_MOCK_EVENTS:     'emitMockEvents',
        RUN_VSCODE_COMMAND:   'runVSCodeCommand',
        UPDATE_SETTING:       'updateSetting',
    };

    const $ = (id) => document.getElementById(id);

    const els = {
        statePill:     $('statePill'),
        runId:         $('runId'),
        costChip:      $('costChip'),
        questCell:     $('questCell'),
        latestEvent:   $('latestEvent'),
        activityFeed:  $('activityFeed'),
        rolesList:     $('rolesList'),
        startBtn:      $('startBtn'),
        abortBtn:      $('abortBtn'),
        briefInput:    $('briefInput'),
        modeBtnResearch: $('modeBtnResearch'),
        modeBtnFairy:    $('modeBtnFairy'),
        modeBtnDirector: $('modeBtnDirector'),
        modeHintText:    $('modeHintText'),
        configBanner:  $('configBanner'),
        warningBanner: $('warningBanner'),
        steerInput:    $('steerInput'),
        steerBtn:      $('steerBtn'),
    };

    let state = {
        run: null,
        settings: null,
        roles: [],
        recentEvents: [],
        iconBase: '',
    };

    // ── Mode toggle (Research / Quick Compute) ────────────────────────────
    let _mode = 'research';  // 'research' | 'fairy' | 'director'
    const MODE_HINTS = {
        research: 'Full Oberon pipeline: Planner scopes the task, Fairy computes, Skeptic reviews. Best for open-ended research questions.',
        fairy:    'Direct computation only: Fairy runs a single focused task and delivers a clean verified notebook. No planning or critique — fastest path for well-defined calculations.',
        director: 'Multi-stage programme: the Director plans stages, runs the research agent per stage, assesses the evidence between stages, and ALWAYS finishes with a LaTeX report (+ PDF when pdflatex is available).',
    };
    function setMode(m) {
        _mode = m;
        els.modeBtnResearch.classList.toggle('briefBox__mode-btn--active', m === 'research');
        els.modeBtnFairy.classList.toggle('briefBox__mode-btn--active', m === 'fairy');
        if (els.modeBtnDirector) els.modeBtnDirector.classList.toggle('briefBox__mode-btn--active', m === 'director');
        if (els.modeHintText) els.modeHintText.textContent = MODE_HINTS[m] || '';
        els.briefInput.placeholder = m === 'fairy'
            ? 'Describe a self-contained computation… (Cmd+Enter to run)'
            : m === 'director'
                ? 'Describe a multi-stage research programme… (Cmd+Enter to start)'
                : 'Describe a research task… (Cmd+Enter to start)';
    }
    if (els.modeBtnResearch) els.modeBtnResearch.addEventListener('click', () => setMode('research'));
    if (els.modeBtnFairy)    els.modeBtnFairy.addEventListener('click',    () => setMode('fairy'));
    if (els.modeBtnDirector) els.modeBtnDirector.addEventListener('click', () => setMode('director'));

    // ── Fairy FSM strip state ──────────────────────────────────────────────
    // Derived incrementally from incoming events; fully rebuilt on snapshot.full.
    let fairyState = {
        active:       false,    // true while a run is in progress
        phase:        null,     // current FSM phase string
        phaseHistory: [],       // ordered list of visited phases
        budget:       null,     // latest getBudgetStatus() snapshot
        status:       null,     // terminal: 'delivered' | 'failed' | 'escalate' | null
    };

    function resetFairyState() {
        fairyState = { active: false, phase: null, phaseHistory: [], budget: null, status: null };
    }

    // Derive fairyState by scanning a full event list (used on snapshot replay).
    function deriveFairyStateFromEvents(events) {
        const fs = { active: false, phase: null, phaseHistory: [], budget: null, status: null };
        for (const ev of (events || [])) {
            if (!ev) continue;
            const p = ev.payload || {};
            if (ev.type === 'fairy.started') {
                // New fairy run resets strip state
                Object.assign(fs, { active: true, phase: 'explore', phaseHistory: ['intake', 'explore'], budget: null, status: null });
            } else if (ev.type === 'fairy.phase') {
                fs.phase = p.phase;
                if (p.phaseHistory) fs.phaseHistory = p.phaseHistory;
                if (p.budget) fs.budget = p.budget;
                if (p.phase === 'delivered' || p.phase === 'failed' || p.phase === 'escalate') {
                    fs.status = p.phase; fs.active = false;
                }
            } else if (ev.type === 'fairy.budget') {
                if (p.budget) fs.budget = p.budget;
            } else if (ev.type === 'scroll.submitted') {
                if (p.status) fs.status = p.status;
                if (p.phaseHistory) fs.phaseHistory = p.phaseHistory;
                if (p.budget) fs.budget = p.budget;
                fs.active = false;
            }
        }
        return fs;
    }

    const PHASE_TRACK      = ['explore', 'compile', 'verify'];
    const TERMINAL_LABELS  = { delivered: '✓ Done', failed: '✗ Failed', escalate: '↑ Escalated' };

    function updateFairyStrip() {
        const strip = document.getElementById('fairyStrip');
        if (!strip) return;
        const hasData = fairyState.active || !!fairyState.status;
        strip.hidden = !hasData;
        if (!hasData) return;

        const phase  = fairyState.phase || 'explore';
        const status = fairyState.status;
        const budget = fairyState.budget;
        const visited = new Set(fairyState.phaseHistory || []);

        strip.dataset.status = status || '';

        // Phase pill
        const pill = document.getElementById('fairyPhasePill');
        if (pill) {
            const displayPhase = status || phase;
            pill.textContent   = status ? (TERMINAL_LABELS[status] || status) : phase;
            pill.dataset.phase = displayPhase;
        }

        // Phase track nodes
        for (const tp of PHASE_TRACK) {
            const node = document.getElementById('fpn-' + tp);
            if (!node) continue;
            const isActive  = !status && tp === phase;
            const isDone    = visited.has(tp) && !isActive;
            node.className  = 'fairy-phase-node' + (isActive ? ' active' : isDone ? ' done' : '');

            const conn = document.getElementById('fpc-' + tp);
            if (conn) {
                const nextIdx  = PHASE_TRACK.indexOf(tp) + 1;
                const nextPhase = PHASE_TRACK[nextIdx];
                const connDone = visited.has(tp) && (!nextPhase || visited.has(nextPhase) || !!status);
                conn.className = 'fairy-phase-connector' + (connDone ? ' done' : '');
            }
        }

        // Terminal node
        const termNode = document.getElementById('fpn-terminal');
        if (termNode) {
            if (status) {
                termNode.textContent = TERMINAL_LABELS[status] || status;
                termNode.className   = 'fairy-phase-node ' + (status === 'delivered' ? 'done' : 'done-fail') + ' active';
            } else {
                termNode.textContent = '—';
                termNode.className   = 'fairy-phase-node';
            }
        }

        // Budget bars
        if (budget) {
            const probeMax  = (budget.probesUsed || 0) + (budget.probesRemaining || 40);
            const turnMax   = (budget.turnsUsed  || 0) + (budget.turnsRemaining  || 80);
            _setBar('fbProbesFill', 'fbProbesCount', budget.probesUsed || 0, probeMax);
            _setBar('fbTurnsFill',  'fbTurnsCount',  budget.turnsUsed  || 0, turnMax);
        }
    }

    function _setBar(fillId, countId, used, total) {
        const fill  = document.getElementById(fillId);
        const count = document.getElementById(countId);
        if (!fill || !count) return;
        const frac = total > 0 ? used / total : 0;
        fill.style.width = (frac * 100).toFixed(1) + '%';
        count.textContent = used + '/' + total;
        const remaining = 1 - frac;
        fill.dataset.level = remaining < 0.1 ? 'critical' : remaining < 0.3 ? 'low' : '';
    }

    // S2.5 Live-cost accumulator. The cost chip in the run card normally
    // refreshes only when the extension pushes a fresh `snapshot.full` /
    // `metrics.update`, which happens at state transitions — typically
    // every 5-15 s in a long run. The accumulator below ticks the chip on
    // every `llm.call` event so the user sees cost climb in real time
    // (sub-second latency). Reset on new run / IDLE state.
    let liveCost = { usd: 0, inTok: 0, outTok: 0, cacheTok: 0, calls: 0 };
    function resetLiveCost() { liveCost = { usd: 0, inTok: 0, outTok: 0, cacheTok: 0, calls: 0 }; }
    function tickLiveCost(ev) {
        const p = ev && ev.payload || {};
        if (typeof p.costUSD === 'number') liveCost.usd += p.costUSD;
        const u = p.usage || {};
        if (typeof u.inputTokens === 'number')     liveCost.inTok    += u.inputTokens;
        if (typeof u.outputTokens === 'number')    liveCost.outTok   += u.outputTokens;
        if (typeof u.cacheReadTokens === 'number') liveCost.cacheTok += u.cacheReadTokens;
        liveCost.calls += 1;
        if (els.costChip) {
            els.costChip.textContent =
                `in ${human(liveCost.inTok)} · out ${human(liveCost.outTok)} · ` +
                `cache ${human(liveCost.cacheTok)} · $${liveCost.usd.toFixed(4)} · ` +
                `${liveCost.calls} call${liveCost.calls !== 1 ? 's' : ''}`;
            els.costChip.classList.add('costChip--live');
            // Brief flash so the user notices the update.
            els.costChip.classList.remove('costChip--flash');
            void els.costChip.offsetWidth; // restart animation
            els.costChip.classList.add('costChip--flash');
        }
    }

    const ICON_MAP = {
        'circle.transition': 'Circle.svg',
        'llm.call':          'Cost.svg',
        'tool.call':         'Spell.svg',
        'spell.exec':        'Spell.svg',
        'ward.requested':    'Ward.svg',
        'ward.result':       'Ward.svg',
        'scroll.submitted':  'Scroll.svg',
        'oberon.decision':   'Oberon.svg',
        'oberon.verdict':    'Oberon.svg',
        'skeptic.verdict':   'Ward.svg',
        'grimoire.write':    'Grimoire.svg',
        'grimoire.updated':  'Grimoire.svg',
        'postmortem.written': 'Scroll.svg',
        'omen':              'Omen.svg',
        'budget.exhausted':  'Omen.svg',
        'correlated.tool':     'Spell.svg',
        'quest.accepted':      'Quest.svg',
        'charm.dispatched':    'Charm.svg',
        'fairy.started':       'Fairy.svg',
        'provider.error':      'Omen.svg',
        'research.conclusion': 'Scroll.svg',
    };

    // Plain-language tooltips for Oberon-specific terms — applied to any
    // element with `data-tip="<term>"` via wireTooltips() after each render.
    const TIPS = {
        Oberon:    'Oberon — the top-level controller that orchestrates a single research run.',
        Fairy:     'Fairy — the LLM worker that performs the research, using tools (Wolfram kernel) and producing a Scroll.',
        Quest:     'Quest — the structured task definition produced from your brief by the Planner.',
        Charm:     'Charm — a single scoped work unit derived from a Quest and handed to the Fairy.',
        Scroll:    'Scroll — the Fairy\u2019s structured output: summary, findings, confidence, cited evidence.',
        Skeptic:   'Skeptic / Critic — the independent reviewer. It studies the Fairy artefacts, clean-runs notebooks where appropriate, and adds targeted checks. Results may support, challenge, or leave a claim inconclusive; Mathematica is not treated as an oracle.',
        Verdict:   'Oberon verdict — the final user-facing outcome (success, partial_success, failed, needs_review) plus a verification level (verified, heuristic, partial, disputed, none) and a short narrated explanation.',
        Ward:      'Ward — a single independent verification check requested by the Critic (boolean re-eval, numeric probe, symbolic identity, or random sampling).  Wards run inside the Critic and feed the verification level.',
        Omen:      'Omen — a non-fatal warning emitted during a run (budget hit, transient error, etc.).',
        Grimoire:  'Grimoire — a single committed markdown file at grimoire/canonical_state.md; the Scribe appends one entry per accepted run.',
        Spell:     'Spell — a single tool invocation (e.g. one Wolfram kernel evaluation).',
    };
    function wireTooltips(root) {
        const els2 = (root || document).querySelectorAll('[data-tip]');
        for (const el of els2) {
            const term = el.getAttribute('data-tip');
            if (term && TIPS[term]) el.setAttribute('title', TIPS[term]);
        }
    }
    function iconHtmlFor(type) {
        const file = ICON_MAP[type];
        if (!file || !state.iconBase) return '';
        return `<img class="t-icon" src="${state.iconBase}/${file}" alt="" />`;
    }

    function render() {
        const run = state.run;
        // State pill
        const s = run ? run.state : 'IDLE';
        els.statePill.dataset.state = s;
        els.statePill.textContent = String(s).toLowerCase();

        // Run header
        els.runId.textContent = run ? run.runId : '—';
        els.costChip.textContent = run ? formatCost(run) : '—';
        els.questCell.textContent = run && run.questId ? run.questId : '—';

        // Latest event
        const last = state.recentEvents[state.recentEvents.length - 1];
        els.latestEvent.textContent = last ? oneLineSummary(last) : '—';

        // Roles
        renderRoles(state.roles);

        // Parameters
        renderParameters(state.settings);

        // Banners + button enablement
        const cfg = state.settings || {};
        const ready = !!cfg.minimallyConfigured;
        els.configBanner.hidden = ready;
        els.warningBanner.hidden = !cfg.enabled;
        els.startBtn.disabled = !ready || !!isActiveState(s);
        els.abortBtn.disabled = !isActiveState(s);
        // Steer field: always visible, disabled when no run is active
        const steerActive = !!isActiveState(s) && fairyState.active;
        if (els.steerInput)  els.steerInput.disabled  = !steerActive;
        if (els.steerBtn)    els.steerBtn.disabled     = !steerActive;
        if (els.steerInput)  els.steerInput.placeholder = steerActive
            ? 'Type a hint to guide the fairy…'
            : '(no active run)';
    }

    function isActiveState(s) {
        return s && s !== 'IDLE' && s !== 'ABORTED' && s !== 'ERROR';
    }

    function formatCost(run) {
        const u = run.totalUsage || {};
        const cost = (typeof run.totalCostUSD === 'number') ? run.totalCostUSD : 0;
        return `in ${human(u.inputTokens)} · out ${human(u.outputTokens)} · cache ${human(u.cacheReadTokens)} · $${cost.toFixed(4)}`;
    }

    function human(n) {
        const v = Number(n || 0);
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
        return String(v);
    }

    function fmtTs(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (_) { return ''; }
    }

    function oneLineSummary(ev) {
        const p = ev.payload || {};
        switch (ev.type) {
            case 'circle.transition': return `${p.from || ''} → ${p.to || ''}`;
            case 'llm.call':          return `${p.role || ''} · ${p.model || ''} · $${(p.costUSD || 0).toFixed(4)}`;
            case 'tool.call':         return `${p.name || ''}`;
            case 'correlated.tool':   return `${p.name || 'tool'} ${p.ok ? '✓' : '✗'} · ${p.durationMs || 0}ms`;
            case 'spell.exec':        return p.summary || 'spell';
            case 'ward.requested':    return `${p.method || p.wardType || ''} · ${(p.expression || '').slice(0, 60)}`;
            case 'ward.result':       return `${p.wardType || ''} → ${p.passed ? 'pass' : 'fail'}`;
            case 'quest.accepted':    return `${p.questId || ''} · ${p.title || ''}`;
            case 'charm.dispatched':  return `${p.charmId || ''} · ${p.title || ''}`;
            case 'fairy.started':     return `${p.charmId || ''} · ${p.model || ''}`;
            case 'scroll.submitted':  return `${p.scrollId || ''} · conf ${typeof p.confidence === 'number' ? p.confidence.toFixed(2) : '?'}`;
            case 'skeptic.verdict':   return `${p.verdict || ''}${p.verificationLevel ? ` (${p.verificationLevel})` : ''} · ${(p.summary && p.summary.matched) || 0}/${(p.summary && p.summary.total) || 0}`;
            case 'oberon.verdict':    return `${(p.verdict || '').replace('_', ' ')}${p.verificationLevel ? ` — ${p.verificationLevel}` : ''}`;
            case 'grimoire.updated':  return `${p.kind || ''} · ${p.findingsWritten || 0} written${p.findingsExcluded ? ` · ${p.findingsExcluded} excluded` : ''}`;
            case 'postmortem.written': return 'postmortem written';
            case 'omen':              return `${p.kind || ''}: ${p.message || ''}`;
            default:                  return JSON.stringify(p).slice(0, 80);
        }
    }

    // ── Activity Feed ──────────────────────────────────────────────────────
    //
    // The activity feed is now rendered by the OberonActivityView module
    // (controlRoom.activityView.js) from a view-model derived from the full
    // event buffer. We re-render on every snapshot / event-append / batch.
    // Rebuild is cheap (events are O(hundreds) per run) and yields a clean,
    // reconciled, GitHub-Copilot-style phase-based stepper rather than a flat
    // stream of raw LLM/tool rows.

    let _rebuildTimer = null;
    let _lastRebuildAt = 0;
    function scheduleRebuild() {
        // Throttle: at most one rebuild per 800 ms. Combined with the HTML
        // equality check inside the activity-view renderer, this keeps the
        // panel still during streaming bursts even when many events arrive
        // in quick succession.
        const MIN_MS = 800;
        const now = Date.now();
        const wait = Math.max(0, MIN_MS - (now - _lastRebuildAt));
        if (_rebuildTimer) return;
        _rebuildTimer = setTimeout(() => {
            _rebuildTimer = null;
            _lastRebuildAt = Date.now();
            rebuildActivityView();
        }, wait);
    }
    function rebuildActivityView() {
        if (!els.activityFeed) return;
        const AV = (typeof window !== 'undefined') ? window.OberonActivityView : null;
        if (!AV || typeof AV.build !== 'function' || typeof AV.render !== 'function') {
            // module missing — fall back to a plain placeholder so the user knows
            els.activityFeed.innerHTML = '<div class="act-line act-line--muted">Activity view module failed to load.</div>';
            return;
        }
        try {
            const vm = AV.build(state.recentEvents || []);
            AV.render(els.activityFeed, vm, {
                iconBase: state.iconBase,
                escapeHtml,
                human,
                wireTooltips,
            });
        } catch (err) {
            // Do NOT wipe activityFeed.innerHTML here — that would destroy the
            // skeleton and make every subsequent render also crash.
            // Show the error in a floating overlay inside the feed instead.
            console.error('[Oberon] Activity render error:', err);
            let errBanner = els.activityFeed.querySelector('.act-render-error');
            if (!errBanner) {
                errBanner = document.createElement('div');
                errBanner.className = 'act-line act-line--muted act-render-error';
                els.activityFeed.prepend(errBanner);
            }
            errBanner.textContent = 'Activity render error: ' + String(err && err.message || err);
        }
    }

    // feedClear() used to be called before full rebuilds, but the keyed
    // reconciliation in OberonActivityView.render() handles its own diffing.
    // Calling feedClear() destroys the persistent skeleton (.act-header-slot +
    // .act-stepper) and causes a "Cannot set properties of null" crash on the
    // next render, so it is now a no-op here.
    function feedClear()        { /* no-op — skeleton owned by OberonActivityView */ }
    function feedAppendEvent(ev) {
        // Keep the live-cost chip ticking for streaming llm.call events.
        if (ev && ev.type === 'llm.call') tickLiveCost(ev);

        // Incrementally update fairy strip for fairy-specific events.
        if (ev) {
            const p = ev.payload || {};
            if (ev.type === 'fairy.started') {
                Object.assign(fairyState, { active: true, phase: 'explore', phaseHistory: ['intake', 'explore'], budget: null, status: null });
                updateFairyStrip();
            } else if (ev.type === 'fairy.phase') {
                fairyState.phase = p.phase;
                if (p.phaseHistory) fairyState.phaseHistory = p.phaseHistory;
                if (p.budget)  fairyState.budget = p.budget;
                if (p.phase === 'delivered' || p.phase === 'failed' || p.phase === 'escalate') {
                    fairyState.status = p.phase; fairyState.active = false;
                }
                updateFairyStrip();
            } else if (ev.type === 'fairy.budget') {
                if (p.budget) { fairyState.budget = p.budget; updateFairyStrip(); }
            } else if (ev.type === 'scroll.submitted') {
                if (p.status) fairyState.status = p.status;
                if (p.phaseHistory) fairyState.phaseHistory = p.phaseHistory;
                if (p.budget) fairyState.budget = p.budget;
                fairyState.active = false;
                updateFairyStrip();
            }
        }

        scheduleRebuild();
    }

    /**
     * Patch the live-preview text in-place when a streaming progress event
     * arrives, avoiding a full DOM rebuild that would blink the entire panel.
     * Falls back to scheduleRebuild() when the target element isn't in the DOM
     * yet (first chunk of a new turn — the rebuild will create the block).
     */
    function _patchLivePreview(ev) {
        const p = ev && ev.payload || {};
        const role = p.role || '';
        const text = p.preview || '';
        if (!els.activityFeed || !role) { scheduleRebuild(); return; }
        // Try to find the matching .act-live block by data-role.
        const block = els.activityFeed.querySelector(`.act-live[data-role="${role}"]`);
        if (!block) {
            // Block not yet rendered (first chunk of new turn) — schedule a
            // single rebuild so the block gets created, then further patches
            // can update it in place without another full rebuild.
            scheduleRebuild();
            return;
        }
        const textEl = block.querySelector('.act-live__text');
        if (textEl) textEl.textContent = '…' + text.slice(-400);
    }


    // ── Hierarchical step-tree state ──────────────────────────────────────
    // (Removed in v2.7.15 — replaced by OberonActivityView re-render pipeline.
    //  The activity feed is now built from a view-model derived from the full
    //  event buffer on every snapshot / append / batch. See
    //  controlRoom.activityView.js.)

    function renderRoles(roles) {
        if (!els.rolesList) return;  // element not present — skip gracefully
        els.rolesList.innerHTML = '';
        for (const r of roles) {
            const row = document.createElement('div');
            row.className = 'role-row';
            row.innerHTML =
                `<span class="role-dot" data-ok="${r.configured ? 'true' : 'false'}"></span>` +
                `<span class="role-name">${escapeHtml(r.role)}</span>` +
                `<span class="role-model" title="${escapeHtml(r.provider + '/' + (r.model || ''))}">${escapeHtml(r.model || '—')}</span>`;
            els.rolesList.appendChild(row);
        }
    }

    function renderParameters(settings) {
        const budget = (settings && settings.budgets && settings.budgets.fairyDefault) || {};
        const maxLlmCalls = budget.maxLlmCalls || 12;
        const maxToolCalls = budget.maxToolCalls || 24;
        const maxOutputTokens = budget.maxOutputTokens || 8000;
        const maxWallClockMs = budget.maxWallClockMs || 360000;

        const fields = {
            'param-maxLlmCalls': String(maxLlmCalls),
            'param-maxToolCalls': String(maxToolCalls),
            'param-maxOutputTokens': String(maxOutputTokens),
            'param-maxWallClockMs': String(maxWallClockMs),
        };
        
        for (const [id, value] of Object.entries(fields)) {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ── inbound ────────────────────────────────────────────────────────────
    window.addEventListener('message', (e) => {
        const msg = e.data || {};
        switch (msg.command) {
            case TO.SNAPSHOT_FULL:
                state.run          = msg.run || null;
                state.settings     = msg.settings || null;
                state.roles        = Array.isArray(msg.roles) ? msg.roles : [];
                state.recentEvents = Array.isArray(msg.recentEvents) ? msg.recentEvents.slice() : [];
                if (msg.iconBase) state.iconBase = String(msg.iconBase);
                // Rebuild fairy strip from the full event list on every snapshot.
                fairyState = deriveFairyStateFromEvents(state.recentEvents);
                feedClear();
                // S2.5 — reset live cost when a fresh snapshot lands. If the
                // extension included an authoritative totalCostUSD on the
                // run object, seed the accumulator from it so the chip
                // reflects already-spent cost across webview reloads.
                resetLiveCost();
                if (state.run && state.run.totalUsage) {
                    const u = state.run.totalUsage;
                    liveCost.inTok    = Number(u.inputTokens     || 0);
                    liveCost.outTok   = Number(u.outputTokens    || 0);
                    liveCost.cacheTok = Number(u.cacheReadTokens || 0);
                }
                if (state.run && typeof state.run.totalCostUSD === 'number') {
                    liveCost.usd = state.run.totalCostUSD;
                }
                // Replay live cost from the recent-events tail so calls
                // that happened between snapshot generation and webview
                // attach are not missed. Only ticks the chip — does not
                // double-feed.
                for (const ev of state.recentEvents) {
                    if (ev && ev.type === 'llm.call') {
                        const p = ev.payload || {};
                        if (typeof p.costUSD === 'number') {
                            // skip the chip flash for replayed historicals
                            liveCost.calls += 1;
                        }
                    }
                    feedAppendEvent(ev);
                }
                render();
                updateFairyStrip();
                break;
            case TO.EVENT_APPEND:
                if (msg.event) {
                    state.recentEvents.push(msg.event);
                    if (state.recentEvents.length > 1000) state.recentEvents.splice(0, state.recentEvents.length - 1000);
                    if (state.run) state.run.eventCount = (state.run.eventCount || 0) + 1;
                    const _evType = msg.event.type;
                    if (_evType === 'llm.reasoning_progress' || _evType === 'llm.response_progress') {
                        // Streaming chunk: do NOT trigger a full DOM rebuild or header
                        // re-render — that causes the entire activity panel to blink at
                        // the chunk rate (up to 5 Hz). Instead, patch just the live-preview
                        // text element in place. If the block doesn't exist yet (first
                        // chunk), fall through to a single deferred rebuild.
                        _patchLivePreview(msg.event);
                    } else {
                        feedAppendEvent(msg.event);
                        // Only refresh the header for events that actually change
                        // anything the header displays (state pill, run cost,
                        // latest-event summary). Tool/correlated/omen events do
                        // not need to redraw the header — that just adds flicker.
                        if (_evType === 'llm.call' || _evType === 'circle.transition'
                            || _evType === 'quest.accepted' || _evType === 'oberon.verdict'
                            || _evType === 'budget.exhausted') {
                            render();
                        }
                    }
                }
                break;
            case TO.EVENT_BATCH:
                if (Array.isArray(msg.events)) {
                    state.recentEvents.push(...msg.events);
                    if (state.recentEvents.length > 1000) state.recentEvents.splice(0, state.recentEvents.length - 1000);
                    for (const ev of msg.events) feedAppendEvent(ev);
                    render();
                }
                break;
            case TO.SETTINGS_SNAPSHOT:
                state.settings = msg.settings || state.settings;
                state.roles    = Array.isArray(msg.roles) ? msg.roles : state.roles;
                render();
                break;
            case TO.OMEN:
                // Omens land in the timeline naturally; nothing extra here for v1.
                break;
        }
    });

    // ── Inline parameter editing ───────────────────────────────────────────
    // Clicking a [data-settable] span opens a small inline <input>.
    // Enter or blur saves the value via UPDATE_SETTING.

    function activateParamEdit(span) {
        if (span.querySelector('input')) return;  // already editing
        const field    = span.dataset.settable;
        const current  = span.textContent.trim();
        span.textContent = '';
        const input = document.createElement('input');
        input.type      = 'number';
        input.min       = '1';
        input.className = 'param-input';
        input.value     = current;
        span.appendChild(input);
        input.focus();
        input.select();

        function commit() {
            const raw = input.value.trim();
            const n   = parseInt(raw, 10);
            if (isFinite(n) && n > 0) {
                vscode.postMessage({ command: FROM.UPDATE_SETTING, field, value: n });
                span.textContent = String(n);  // optimistic
            } else {
                span.textContent = current;  // revert
            }
        }
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { span.textContent = current; }
        });
        input.addEventListener('blur', commit);
    }

    document.addEventListener('click', (e) => {
        // Close gear panel on outside click
        const gp = $('gearPanel');
        if (gp && !gp.hidden) {
            if (!e.target.closest('#gearPanel') && !e.target.closest('[data-cmd="toggleGear"]')) {
                gp.hidden = true;
                const gearBtn = document.querySelector('[data-cmd="toggleGear"]');
                if (gearBtn) gearBtn.dataset.open = 'false';
            }
        }
        const span = e.target instanceof Element && e.target.closest('[data-settable]');
        if (span) activateParamEdit(span);
    });

    // ── outbound ───────────────────────────────────────────────────────────
    document.body.addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        const btn = t.closest('button[data-cmd]');
        if (!btn) return;
        const cmd = btn.dataset.cmd;
        if (cmd === 'startResearch') {
            const brief = (els.briefInput.value || '').trim();
            if (!brief) return;
            if (_mode === 'fairy') {
                vscode.postMessage({ command: FROM.START_FAIRY, brief });
            } else if (_mode === 'director') {
                vscode.postMessage({ command: FROM.START_DIRECTOR, brief });
            } else {
                vscode.postMessage({ command: FROM.START_RESEARCH, brief });
            }
            els.briefInput.value = '';
            return;
        }
        if (cmd === 'submitSteer') {
            const text = (els.steerInput && els.steerInput.value || '').trim();
            if (text) {
                vscode.postMessage({ command: FROM.SUBMIT_STEER, text });
                if (els.steerInput) els.steerInput.value = '';
            }
            return;
        }
        if (cmd === 'abortRun')           return vscode.postMessage({ command: FROM.ABORT_RUN });
        if (cmd === 'openRunInspector')   return vscode.postMessage({ command: FROM.OPEN_RUN_INSPECTOR });
        if (cmd === 'openCharmDebugger')  return vscode.postMessage({ command: FROM.OPEN_CHARM_DEBUGGER });
        if (cmd === 'openSettings')       return vscode.postMessage({ command: FROM.OPEN_SETTINGS });
        if (cmd === 'configureProviders') return vscode.postMessage({ command: FROM.CONFIGURE_PROVIDERS });
        if (cmd === 'toggleGear') {
            const gp = $('gearPanel');
            if (gp) {
                gp.hidden = !gp.hidden;
                e.currentTarget.closest('button') && (e.currentTarget.dataset.open = gp.hidden ? 'false' : 'true');
                const gearBtn = document.querySelector('[data-cmd="toggleGear"]');
                if (gearBtn) gearBtn.dataset.open = gp.hidden ? 'false' : 'true';
            }
            return;
        }
        if (cmd === 'emitMockEvents')     return vscode.postMessage({ command: FROM.EMIT_MOCK_EVENTS });
        if (cmd === 'openRunLog')         return vscode.postMessage({ command: FROM.RUN_VSCODE_COMMAND, id: 'wolfbook.oberon.openRunLog' });
        if (cmd === 'runTestSuite')        return vscode.postMessage({ command: FROM.RUN_VSCODE_COMMAND, id: 'wolfbook.oberon.runTestSuite' });
        if (cmd === 'bumpAndDeploy')       return vscode.postMessage({ command: 'bumpAndDeploy' });
        if (cmd === 'showHelp')  { $('helpOverlay').hidden = false; return; }
        if (cmd === 'closeHelp') { $('helpOverlay').hidden = true;  return; }
    });

    // Close help overlay when clicking outside the panel.
    $('helpOverlay').addEventListener('click', (e) => {
        if (e.target === $('helpOverlay')) $('helpOverlay').hidden = true;
    });
    // Close with Escape key.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!$('helpOverlay').hidden) { e.stopPropagation(); $('helpOverlay').hidden = true; }
            const gp = $('gearPanel');
            if (gp && !gp.hidden) {
                e.stopPropagation();
                gp.hidden = true;
                const gearBtn = document.querySelector('[data-cmd="toggleGear"]');
                if (gearBtn) gearBtn.dataset.open = 'false';
            }
        }
    });

    els.briefInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            const brief = (els.briefInput.value || '').trim();
            if (brief && !els.startBtn.disabled) {
                if (_mode === 'fairy') {
                    vscode.postMessage({ command: FROM.START_FAIRY, brief });
                } else if (_mode === 'director') {
                    vscode.postMessage({ command: FROM.START_DIRECTOR, brief });
                } else {
                    vscode.postMessage({ command: FROM.START_RESEARCH, brief });
                }
                els.briefInput.value = '';
            }
        }
    });

    // Race-fix handshake: tell the provider we're ready, get the snapshot back.
    vscode.postMessage({ command: FROM.SCRIPT_LOADED });
})();
