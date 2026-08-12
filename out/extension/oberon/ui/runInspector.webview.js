/* Oberon — Run Inspector webview renderer. */

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
        OPEN_SETTINGS:        'openSettings',
        CONFIGURE_PROVIDERS:  'configureProviders',
        EMIT_MOCK_EVENTS:     'emitMockEvents',
        LIST_HISTORICAL_RUNS: 'listHistoricalRuns',
        LOAD_HISTORICAL_RUN:  'loadHistoricalRun',
    };

    const $  = (id) => document.getElementById(id);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const els = {
        statePill:    $('statePill'),
        abortBtn:     $('abortBtn'),
        runPicker:    $('runPicker'),
        filterText:   $('filterText'),
        filterType:   $('filterType'),
        eventCount:   $('eventCount'),
        eventsWrap:   $('eventsWrap'),
        eventsTable:  $('eventsTable'),
        eventsHead:   $('eventsHead'),
        eventsBody:   $('eventsBody'),
        structuredBody: $('structuredBody'),
        ovRunId:      $('ovRunId'),
        ovStarted:    $('ovStarted'),
        ovState:      $('ovState'),
        ovQuest:      $('ovQuest'),
        ovCharm:      $('ovCharm'),
        ovEvents:     $('ovEvents'),
        ovLlmCalls:   $('ovLlmCalls'),
        ovCost:       $('ovCost'),
        costBody:     $('costBody'),
        rolesBody:    $('rolesBody'),
        wardsBody:    $('wardsBody'),
        wardsSummary: $('wardsSummary'),
        pmStatus:     $('pmStatus'),
        pmPath:       $('pmPath'),
        pmGrimoire:   $('pmGrimoire'),
        pmWards:      $('pmWards'),
        pmOpenBtn:    $('pmOpenBtn'),
        detailDrawer: $('detailDrawer'),
        detailTitle:  $('detailTitle'),
        detailBody:   $('detailBody'),
        detailClose:  $('detailClose'),
        // dashboard hero
        topbarMeta:   $('topbarMeta'),
        topbarCost:   $('topbarCost'),
        idleHero:     $('idleHero'),
        liveHero:     $('liveHero'),
        launchBrief:  $('launchBrief'),
        recentRuns:   $('recentRuns'),
        nowPhase:     $('nowPhase'),
        nowMeta:      $('nowMeta'),
        nowActivity:  $('nowActivity'),
        nowToggle:    $('nowToggle'),
        nowStream:    $('nowStream'),
        nowStreamLabel: $('nowStreamLabel'),
        nowStreamBody:  $('nowStreamBody'),
        steerInput:   $('steerInput'),
        steerBtn:     $('steerBtn'),
        steerAck:     $('steerAck'),
    };

    /** @type {{run:any, settings:any, roles:any[], events:any[], filter:{text:string,type:string}, viewMode:string, iconBase:string, prompts:any, openSteps:Set<string>}} */
    let state = {
        run: null, settings: null, roles: [], events: [],
        filter: { text: '', type: '' },
        viewMode: 'structured',
        iconBase: '', prompts: null,
        openSteps: new Set(),   // persistent open/close memory for structured nodes
        steerActive: false,
        recentRuns: [],         // enriched { runId, brief, status, costUSD }
        lastStatus: null,       // last fairy.status payload (phase/budget for the Now strip)
    };
    /** True when viewing a past run (live updates suppressed). */
    let isHistorical = false;
    /** Auto-load the latest historical run once when the panel opens idle. */
    let autoLoadedLatest = false;

    const ICON_MAP = {
        'circle.transition': 'Circle.svg',
        'llm.call':              'Cost.svg',
        'llm.reasoning_progress': 'Cost.svg',
        'llm.response_progress':  'Cost.svg',
        'tool.call':              'Spell.svg',
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
        'charm.started':       'Charm.svg',
        'fairy.started':       'Fairy.svg',
        'provider.error':      'Omen.svg',
        'research.conclusion': 'Scroll.svg',
    };
    // Family fallbacks so new event types get a sensible icon without a map entry.
    const ICON_PREFIX = [
        ['director.',     'Oberon.svg'],
        ['executive.',    'Oberon.svg'],
        ['fact',          'Grimoire.svg'],
        ['facts',         'Grimoire.svg'],
        ['skill',         'Grimoire.svg'],
        ['literature.',   'Scroll.svg'],
        ['recall.',       'Grimoire.svg'],
        ['contribution.', 'Grimoire.svg'],
        ['fairy.',        'Fairy.svg'],
        ['quest.',        'Quest.svg'],
        ['notebook.',     'Scroll.svg'],
        ['plan.',         'Quest.svg'],
        ['checkpoint.',   'Charm.svg'],
        ['util.',         'Spell.svg'],
        ['probe.',        'Spell.svg'],
        ['critic.',       'Ward.svg'],
        ['skeptic.',      'Ward.svg'],
    ];
    function iconFor(type) {
        let file = ICON_MAP[type];
        if (!file) {
            const hit = ICON_PREFIX.find(([pre]) => type.startsWith(pre));
            if (hit) file = hit[1];
        }
        if (!file || !state.iconBase) return '';
        return `<img class="ev-icon" src="${state.iconBase}/${file}" alt="" />`;
    }

    // ── tabs ───────────────────────────────────────────────────────────────
    document.querySelector('.tabs').addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target.closest('.tab') : null;
        if (!t || t.disabled) return;
        const id = t.dataset.tab;
        $$('.tab').forEach(el => el.classList.toggle('active', el === t));
        $$('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === id));
    });

    // ── render ─────────────────────────────────────────────────────────────
    // Full render is coalesced: rapid event streams schedule ONE render per
    // ~250 ms instead of re-rendering the whole timeline per event.
    let _renderTimer = null;
    function scheduleRender() {
        if (_renderTimer) return;
        _renderTimer = setTimeout(() => { _renderTimer = null; render(); }, 250);
    }

    function render() {
        const run = state.run;

        // state pill
        const s = run ? run.state : (isHistorical ? 'HISTORICAL' : 'IDLE');
        els.statePill.dataset.state = isHistorical ? 'HISTORICAL' : s;
        els.statePill.textContent = isHistorical ? 'historical' : String(s).toLowerCase();
        els.abortBtn.disabled = isHistorical || !isActiveState(s);

        // topbar meta + cost ticker
        const live = !isHistorical && run && isActiveState(s);
        if (els.topbarMeta) {
            const bits = [];
            if (run && run.questId) bits.push(run.questId);
            if (run && run.charmId) bits.push(run.charmId);
            els.topbarMeta.textContent = bits.join(' · ');
        }
        if (els.topbarCost) {
            els.topbarCost.textContent = run && run.totalCostUSD
                ? `$${Number(run.totalCostUSD).toFixed(3)}` : '';
        }

        // hero visibility: live Now strip during a run, launcher otherwise
        if (els.liveHero) els.liveHero.hidden = !live;
        if (els.idleHero) els.idleHero.hidden = !!live;
        if (live) renderNowStrip();
        else renderRecentRuns();

        // overview
        els.ovRunId.textContent    = run ? run.runId : '—';
        els.ovStarted.textContent  = run ? fmtTime(run.startedAt) : '—';
        els.ovState.textContent    = s;
        els.ovQuest.textContent    = run && run.questId ? run.questId : '—';
        els.ovCharm.textContent    = run && run.charmId ? run.charmId : '—';
        els.ovEvents.textContent   = run ? String(run.eventCount || 0) : '0';
        els.ovLlmCalls.textContent = run ? String(run.llmCallCount || 0) : '0';
        els.ovCost.textContent     = run ? `$${Number(run.totalCostUSD || 0).toFixed(4)}` : '$0.0000';

        // cost panel
        const u = (run && run.totalUsage) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        const rows = [
            ['Input tokens',       human(u.inputTokens)],
            ['Output tokens',      human(u.outputTokens)],
            ['Cache read tokens',  human(u.cacheReadTokens)],
            ['Cache write tokens', human(u.cacheWriteTokens)],
            ['Cost (USD)',         run ? `$${Number(run.totalCostUSD || 0).toFixed(4)}` : '$0.0000'],
        ];
        els.costBody.innerHTML = rows.map(([k, v]) =>
            `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('');

        // roles panel
        els.rolesBody.innerHTML = state.roles.map(r => {
            const p = r.pricing || {};
            return `<tr>
                <td>${escapeHtml(r.role)}</td>
                <td>${escapeHtml(r.provider)}</td>
                <td>${escapeHtml(r.model || '—')}</td>
                <td>${fmtPrice(p.inputUSDPerMTok)}</td>
                <td>${fmtPrice(p.cacheReadUSDPerMTok)}</td>
                <td>${fmtPrice(p.cacheWriteUSDPerMTok)}</td>
                <td>${fmtPrice(p.outputUSDPerMTok)}</td>
                <td>${r.configured ? '<span style="color:var(--acc-green)">ready</span>' : '<span style="color:var(--acc-red)">missing</span>'}</td>
            </tr>`;
        }).join('');

        // events table
        renderEvents();
        renderWards();
        renderPostmortem();
        renderPrompts();
        renderFairy();
    }

    function renderPostmortem() {
        if (!els.pmStatus) return;
        const pm = [...state.events].reverse().find(e => e.type === 'postmortem.written');
        const gr = [...state.events].reverse().find(e => e.type === 'grimoire.updated');
        const ws = [...state.events].reverse().find(e => e.type === 'research.conclusion');
        if (!pm) {
            els.pmStatus.textContent = 'no postmortem yet';
            if (els.pmPath)  els.pmPath.textContent = '—';
            if (els.pmOpenBtn) { els.pmOpenBtn.disabled = true; els.pmOpenBtn.dataset.target = ''; }
        } else {
            els.pmStatus.textContent = 'postmortem generated';
            const pmp = (pm.payload && pm.payload.path) || '';
            if (els.pmPath)  els.pmPath.textContent = pmp || '—';
            if (els.pmOpenBtn) { els.pmOpenBtn.disabled = !pmp; els.pmOpenBtn.dataset.target = pmp; }
        }
        if (els.pmGrimoire) {
            if (gr) {
                const p = gr.payload || {};
                const parts = [(p.kind || '').toUpperCase(),
                               `${p.findingsWritten || 0} written`];
                if (p.findingsExcluded) parts.push(`${p.findingsExcluded} excluded`);
                if (p.path) parts.push(shortPath(p.path));
                els.pmGrimoire.textContent = parts.join(' · ');
            } else {
                els.pmGrimoire.textContent = '—';
            }
        }
        if (els.pmWards) {
            const ws2 = ws && ws.payload && ws.payload.wardSummary;
            if (ws2) {
                const parts = [`total ${ws2.total || 0}`];
                for (const k of ['passed', 'failed', 'skipped', 'errored']) {
                    if (ws2[k]) parts.push(`${k} ${ws2[k]}`);
                }
                els.pmWards.textContent = parts.join(' · ');
            } else {
                els.pmWards.textContent = '—';
            }
        }
    }

    function shortPath(p) {
        const s = String(p || '');
        if (s.length <= 60) return s;
        return '…' + s.slice(-58);
    }

    function renderPrompts() {
        const pb = document.getElementById('promptsBody');
        if (!pb) return;
        const prompts = state.prompts;
        if (!prompts || !Object.keys(prompts).length) {
            pb.innerHTML = '<p class="muted" style="padding:8px">No prompts available.</p>';
            return;
        }
        const ROLE_LABEL = { fairy: 'Fairy (worker)', planner: 'Planner (Oberon)', postmortem: 'Postmortem narrative' };
        pb.innerHTML = Object.entries(prompts).map(([role, text]) => `
            <details style="margin-bottom:8px;border:1px solid var(--vscode-widget-border,#444);border-radius:4px">
              <summary style="cursor:pointer;padding:6px 10px;font-weight:600;user-select:none;font-size:12px">
                ${escapeHtml(ROLE_LABEL[role] || role)}
                <span style="opacity:.5;font-weight:400;font-size:10px;margin-left:8px">${String(text || '').length} chars</span>
              </summary>
              <pre class="detail-pre" style="margin:0;max-height:500px;overflow:auto;border-top:1px solid var(--vscode-widget-border,#444);border-radius:0 0 4px 4px;font-size:11px;padding:10px;white-space:pre-wrap">${escapeHtml(String(text || ''))}</pre>
            </details>`).join('');
    }

    function renderWards() {
        if (!els.wardsBody) return;
        const wards = state.events.filter(e => e.type === 'ward.result');
        if (!wards.length) {
            els.wardsBody.innerHTML = '<tr><td colspan="6" class="muted">No ward results yet.</td></tr>';
            if (els.wardsSummary) els.wardsSummary.textContent = 'no wards yet';
            return;
        }
        const summary = wards.reduce((a, e) => {
            const s = (e.payload && e.payload.status) || 'skipped';
            a[s] = (a[s] || 0) + 1; return a;
        }, {});
        if (els.wardsSummary) {
            const parts = ['total ' + wards.length];
            for (const k of ['passed', 'failed', 'skipped', 'errored']) {
                if (summary[k]) parts.push(k + ' ' + summary[k]);
            }
            els.wardsSummary.textContent = parts.join(' · ');
        }
        const statusColor = { passed: 'var(--acc-green)', failed: 'var(--acc-red)', skipped: 'var(--vscode-descriptionForeground)', errored: 'var(--acc-yellow)' };
        els.wardsBody.innerHTML = wards.map(e => {
            const p = e.payload || {};
            const col = statusColor[p.status] || 'var(--vscode-descriptionForeground)';
            return '<tr>' +
                '<td>' + escapeHtml(p.wardId || '') + '</td>' +
                '<td>' + escapeHtml(p.method || '') + '</td>' +
                '<td><span style="color:' + col + '">' + escapeHtml(p.status || '') + '</span></td>' +
                '<td>' + escapeHtml(String(p.detail || '').slice(0, 200)) + '</td>' +
                '<td><code>' + escapeHtml(String(p.expression || '').slice(0, 120)) + '</code></td>' +
                '<td>' + (typeof p.durationMs === 'number' ? (p.durationMs + ' ms') : '—') + '</td>' +
                '</tr>';
        }).join('');
    }

    // ── Fairy FSM pane ─────────────────────────────────────────────────────────

    // Live FSM track (fsm.js): intake → explore → compile → polish. 'verify' is
    // the legacy name of polish — old logs are aliased so their stepper still fills.
    const FAIRY_PHASE_TRACK  = ['intake', 'explore', 'compile', 'polish'];
    const FAIRY_STATUS_COLOR = {
        delivered: 'var(--acc-green)', failed: 'var(--acc-red)', escalate: 'var(--acc-yellow)',
        partial_delivered: 'var(--acc-yellow)',
    };
    const FAIRY_PHASE_COLOR  = {
        intake: 'var(--acc-blue)', explore: 'var(--acc-blue)', compile: 'var(--acc-purple)',
        polish: 'var(--acc-green)', verify: 'var(--acc-green)',
        diagnose: 'var(--acc-yellow)', delivered: 'var(--acc-green)', failed: 'var(--acc-red)',
        escalate: 'var(--acc-yellow)', partial_delivered: 'var(--acc-yellow)',
    };
    const _normPhase = (ph) => ph === 'verify' ? 'polish' : ph;
    const _clipText  = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n || 110);

    /**
     * Quest → charms board: every charm the planner dispatched, its live status,
     * verdict, confidence and self-verify health, plus the fairy's latest plan
     * per charm. This is the "what is the plan / which fairies completed" view.
     */
    function buildCharmsVM(events) {
        const quests = new Map();   // questId → { id, title, charms: Map<charmId, charm> }
        const questOrder = [];
        let lastQuestId = null;
        const q = (id) => {
            const qid = id || lastQuestId || '?';
            if (!quests.has(qid)) { quests.set(qid, { id: qid, title: '', charms: new Map(), charmOrder: [] }); questOrder.push(qid); }
            lastQuestId = qid;
            return quests.get(qid);
        };
        const charm = (questId, charmId) => {
            if (!charmId) return null;
            const qq = q(questId);
            if (!qq.charms.has(charmId)) {
                qq.charms.set(charmId, {
                    id: charmId, title: '', status: 'planned', phase: null,
                    verdict: null, skeptic: null, confidence: null,
                    selfVerify: null, plan: null, index: null, total: null,
                });
                qq.charmOrder.push(charmId);
            }
            return qq.charms.get(charmId);
        };
        for (const ev of events) {
            if (!ev) continue;
            const t = ev.type, p = ev.payload || {};
            const qid = p.questId || ev.questId || null;
            const cid = p.charmId || ev.charmId || null;
            if (t === 'quest.accepted') {
                const qq = q(qid);
                if (p.title || p.shortName) qq.title = p.title || p.shortName;
            } else if (t === 'circle.transition' && p.questId && p.to === 'QUEST_DEFINED') {
                q(p.questId);
            } else if (t === 'charm.dispatched') {
                const c = charm(qid, cid);
                if (c && p.title) c.title = p.title;
            } else if (t === 'charm.started') {
                const c = charm(qid, cid);
                if (c) { c.status = 'running'; c.index = p.index || null; c.total = p.total || null; }
            } else if (t === 'fairy.phase') {
                const c = charm(qid, cid);
                if (c && c.status === 'running') c.phase = _normPhase(p.phase || null);
            } else if (t === 'plan.created') {
                const c = charm(qid, cid);
                if (c) c.plan = { steps: Array.isArray(p.steps) ? p.steps : [], note: p.note || '', revision: p.revision || 0 };
            } else if (t === 'fairy.self_verify') {
                const c = charm(qid, cid);
                if (c) c.selfVerify = { checked: p.checked || 0, matched: p.matched || 0, mismatched: (p.mismatched || []).length };
            } else if (t === 'scroll.submitted') {
                const c = charm(qid, cid);
                if (c) {
                    c.status = p.status || 'delivered';
                    if (typeof p.confidence === 'number') c.confidence = p.confidence;
                    c.phase = null;
                }
            } else if (t === 'skeptic.verdict') {
                const c = charm(qid, cid);
                if (c) c.skeptic = p.verdict || null;
            } else if (t === 'oberon.verdict') {
                const c = charm(qid, cid);
                if (c) c.verdict = p.verdict || null;
            } else if (t === 'omen' && p.kind === 'charms_skipped_executive') {
                const ids = (p.detail && p.detail.skippedCharmIds) || [];
                for (const sid of ids) {
                    const c = charm(qid, sid);
                    if (c && c.status === 'planned') c.status = 'skipped';
                }
            }
        }
        if (!questOrder.length) return null;
        return questOrder.map(id => quests.get(id));
    }

    const CHARM_STATUS_META = {
        planned:           { icon: '○', color: 'var(--vscode-descriptionForeground)', label: 'planned' },
        running:           { icon: '▶', color: 'var(--acc-blue)',   label: 'running' },
        delivered:         { icon: '✓', color: 'var(--acc-green)',  label: 'delivered' },
        partial_delivered: { icon: '◑', color: 'var(--acc-yellow)', label: 'partial' },
        failed:            { icon: '✗', color: 'var(--acc-red)',    label: 'failed' },
        escalate:          { icon: '↑', color: 'var(--acc-yellow)', label: 'escalated' },
        skipped:           { icon: '⏭', color: 'var(--vscode-descriptionForeground)', label: 'skipped' },
    };

    function renderCharmsBoard(questsVM) {
        if (!questsVM || !questsVM.length) return '';
        const blocks = questsVM.map(qq => {
            const rows = qq.charmOrder.map(cid => {
                const c = qq.charms.get(cid);
                const meta = CHARM_STATUS_META[c.status] || CHARM_STATUS_META.planned;
                const statusBits = [meta.label];
                if (c.status === 'running' && c.phase) statusBits.push(c.phase);
                if (c.verdict) statusBits.push(c.verdict.replace(/_/g, ' '));
                else if (c.skeptic) statusBits.push('skeptic: ' + c.skeptic);
                const conf = typeof c.confidence === 'number' ? c.confidence.toFixed(2) : '';
                const sv = c.selfVerify
                    ? (c.selfVerify.mismatched > 0
                        ? `<span style="color:var(--acc-red)" title="self-verify: ${c.selfVerify.mismatched} of ${c.selfVerify.checked} evidence re-evaluations mismatched">⚠ ${c.selfVerify.mismatched}/${c.selfVerify.checked}</span>`
                        : `<span style="color:var(--acc-green)" title="self-verify: all ${c.selfVerify.checked} evidence re-evaluations matched">✓ ${c.selfVerify.checked}/${c.selfVerify.checked}</span>`)
                    : '';
                return `<div class="fairy-pi-charm-row ${c.status === 'running' ? 'is-running' : ''}">
                    <span class="fairy-pi-charm-icon" style="color:${meta.color}">${meta.icon}</span>
                    <code class="fairy-pi-charm-id">${escapeHtml(c.id)}</code>
                    <span class="fairy-pi-charm-title" title="${escapeHtml(c.title)}">${escapeHtml(_clipText(c.title, 90))}</span>
                    <span class="fairy-pi-charm-status" style="color:${meta.color}">${escapeHtml(statusBits.join(' · '))}</span>
                    <span class="fairy-pi-charm-conf" title="confidence">${conf}</span>
                    <span class="fairy-pi-charm-sv">${sv}</span>
                </div>`;
            }).join('');
            const done  = qq.charmOrder.filter(cid => ['delivered', 'partial_delivered', 'failed', 'escalate'].includes(qq.charms.get(cid).status)).length;
            const title = qq.title ? ` — ${escapeHtml(_clipText(qq.title, 90))}` : '';
            return `<div class="fairy-pi-quest-block">
                <div class="fairy-pi-quest-head"><code>${escapeHtml(qq.id)}</code>${title}
                    <span class="muted small" style="margin-left:8px">${done}/${qq.charmOrder.length} charm(s) finished</span></div>
                ${rows}
            </div>`;
        }).join('');
        return `<div class="fairy-pi-section">
            <div class="fairy-pi-section-title">Plan &amp; Charms</div>
            ${blocks}
        </div>`;
    }

    function renderCharmPlan(questsVM, charmId) {
        if (!questsVM || !charmId) return '';
        let c = null;
        for (const qq of questsVM) if (qq.charms.has(charmId)) c = qq.charms.get(charmId);
        if (!c || !c.plan || !c.plan.steps.length) return '';
        const items = c.plan.steps.map(s => `<li>${escapeHtml(String(s))}</li>`).join('');
        const rev  = c.plan.revision ? ` <span class="muted small">(revision ${c.plan.revision})</span>` : '';
        const note = c.plan.note ? `<div class="muted small" style="margin-top:4px">${escapeHtml(_clipText(c.plan.note, 200))}</div>` : '';
        return `<div class="fairy-pi-section">
            <div class="fairy-pi-section-title">Fairy plan — ${escapeHtml(charmId)}${rev}</div>
            <ol class="fairy-pi-plan">${items}</ol>
            ${note}
        </div>`;
    }

    function buildFairyVM(events) {
        // Derive state from events (left-to-right scan; last fairy.started wins)
        let started    = null;   // fairy.started payload
        let phaseEvs   = [];     // all fairy.phase events since last fairy.started
        let lastBudget = null;   // latest budget snapshot
        let scrollEv   = null;   // last scroll.submitted for this fairy run

        for (const ev of events) {
            if (!ev) continue;
            if (ev.type === 'fairy.started') {
                started = ev.payload || {};
                phaseEvs = [];
                lastBudget = null;
                scrollEv = null;
            } else if (started) {
                if (ev.type === 'fairy.phase') {
                    phaseEvs.push(ev);
                    if ((ev.payload || {}).budget) lastBudget = ev.payload.budget;
                } else if (ev.type === 'fairy.budget') {
                    if ((ev.payload || {}).budget) lastBudget = ev.payload.budget;
                } else if (ev.type === 'scroll.submitted') {
                    scrollEv = ev;
                    if ((ev.payload || {}).budget) lastBudget = ev.payload.budget;
                }
            }
        }

        if (!started) return null;

        // Latest phase from the last fairy.phase event ('verify' aliased → 'polish')
        const lastPhaseEv = phaseEvs[phaseEvs.length - 1];
        const currentPhase = _normPhase((lastPhaseEv && lastPhaseEv.payload && lastPhaseEv.payload.phase) || 'explore');
        const phaseHistory  = ((lastPhaseEv && lastPhaseEv.payload && lastPhaseEv.payload.phaseHistory) ||
                              (scrollEv && scrollEv.payload && scrollEv.payload.phaseHistory) || []).map(_normPhase);
        const status  = (scrollEv && scrollEv.payload && scrollEv.payload.status) || null;
        const steps   = (scrollEv && scrollEv.payload && scrollEv.payload.steps) || [];
        const cleanNbPath = (scrollEv && scrollEv.payload && scrollEv.payload.cleanNbPath) || null;
        const budget  = lastBudget;

        // Phase events with timestamps (for stepper with timestamps)
        const phaseTimestamps = {};
        for (const pev of phaseEvs) {
            const ph = _normPhase((pev.payload || {}).phase);
            if (ph && !phaseTimestamps[ph]) phaseTimestamps[ph] = pev.ts || '';
        }

        return { started, currentPhase, phaseHistory, phaseTimestamps, status, steps, cleanNbPath, budget };
    }

    /** Summarise observable progress since the latest fairy.started event. */
    function buildProgressVM(events) {
        let start = -1;
        for (let i = events.length - 1; i >= 0; i--) {
            if (events[i] && events[i].type === 'fairy.started') { start = i; break; }
        }
        if (start < 0) return null;
        const xs = events.slice(start);
        const facts = [], successes = [], failures = [], checkpoints = [];
        let activity = null, lastTs = (xs[0] && xs[0].ts) || null;
        const failureTypes = new Set([
            'fairy.consecutive_failures', 'fairy.near_duplicate', 'fairy.repeat_abandon',
            'fairy.error', 'budget.exhausted', 'provider.error',
        ]);
        for (const ev of xs) {
            if (!ev) continue;
            const p = ev.payload || {};
            if (ev.ts) lastTs = ev.ts;
            if (ev.type === 'fact.recorded') {
                facts.push({ key: p.key || 'fact', value: p.value || '', confidence: p.confidence || '' });
            } else if (ev.type === 'tool.call' && p.name === 'note_fact') {
                const a = p.args || {};
                facts.push({ key: a.key || 'fact', value: a.value || '', confidence: a.confidence || '' });
            } else if (ev.type === 'facts.extracted') {
                const list = Array.isArray(p.facts) ? p.facts : [];
                if (list.length) list.forEach(f => facts.push({ key: f.key || 'fact', value: f.value || f.statement || '', confidence: f.confidence || '' }));
                else if (p.count) facts.push({ key: 'banked facts', value: `${p.count} fact(s) extracted`, confidence: '' });
            }
            if (ev.type === 'probe.appended') {
                successes.push({ id: p.probeId || 'probe', text: p.note || clip(p.code || '', 150) || 'successful probe' });
            }
            if (ev.type === 'checkpoint.recorded') {
                checkpoints.push({ id: p.sectionTitle || 'checkpoint', text: `${(p.stepsIncluded || []).length} step(s) preserved` });
            }
            if (ev.type === 'correlated.tool' && p.ok === false) {
                failures.push({ id: p.name || 'tool', text: p.error || p.kind || p.summary || 'failed' });
            } else if (failureTypes.has(ev.type)) {
                failures.push({ id: ev.type.replace(/^fairy\./, ''), text: p.message || p.reason || p.error || oneLineSummary(ev) });
            }
            if (ev.type === 'literature.progress' || ev.type === 'tool.call'
                || ev.type === 'fairy.status' || ev.type === 'llm.call') activity = ev;
        }
        // Amendments can emit probe.appended for the same probe; keep the latest card.
        const uniq = (arr) => [...new Map(arr.map(x => [x.id, x])).values()];
        return {
            facts: uniq(facts), successes: uniq(successes), failures: failures.slice(-8),
            checkpoints: uniq(checkpoints), activity, lastTs,
        };
    }

    function _ageInfo(ts) {
        const ms = ts ? Math.max(0, Date.now() - new Date(ts).getTime()) : Infinity;
        const sec = Math.floor(ms / 1000);
        const text = sec < 60 ? `${sec}s ago` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s ago` : `${Math.floor(sec / 3600)}h ago`;
        const level = ms >= 10 * 60e3 ? 'stalled' : ms >= 3 * 60e3 ? 'quiet' : 'moving';
        return { text, level };
    }

    function _progressList(title, cls, items, empty) {
        const body = items.length
            ? items.slice(-6).reverse().map(x => `<div class="fairy-progress-item"><code>${escapeHtml(x.id)}</code><span>${escapeHtml(x.text || x.value || '')}</span>${x.confidence ? `<small>${escapeHtml(x.confidence)}</small>` : ''}</div>`).join('')
            : `<div class="muted small">${escapeHtml(empty)}</div>`;
        return `<div class="fairy-progress-card ${cls}"><div class="fairy-progress-title">${title} <span>${items.length}</span></div>${body}</div>`;
    }

    function renderFairy() {
        const pane = document.getElementById('fairyPaneContent');
        if (!pane) return;

        const questsVM = buildCharmsVM(state.events);
        const charmsBoardHtml = renderCharmsBoard(questsVM);

        const vm = buildFairyVM(state.events);
        if (!vm) {
            pane.innerHTML = charmsBoardHtml
                ? `<div class="fairy-pi-wrap">${charmsBoardHtml}</div>`
                : '<p class="muted small" style="padding:12px">No Fairy run yet — start a quest to see FSM activity here.</p>';
            return;
        }

        const { started, currentPhase, phaseHistory, phaseTimestamps, status, steps, cleanNbPath, budget } = vm;
        const visited = new Set(phaseHistory);
        const isTerminal = !!status;
        const statusColor = FAIRY_STATUS_COLOR[status] || 'inherit';

        // ── Phase stepper ──
        let stepperHtml = '<div class="fairy-pi-stepper">';
        for (let i = 0; i < FAIRY_PHASE_TRACK.length; i++) {
            const ph      = FAIRY_PHASE_TRACK[i];
            const isActive  = !isTerminal && ph === currentPhase;
            const isDone    = visited.has(ph);
            const dotClass  = isActive ? 'active' : isDone ? 'done' : '';
            const color     = isActive || isDone ? (FAIRY_PHASE_COLOR[ph] || 'inherit') : 'inherit';
            const ts        = phaseTimestamps[ph] ? (' <span class="fairy-pi-ts">' + fmtTime(phaseTimestamps[ph]) + '</span>') : '';
            stepperHtml += `<div class="fairy-pi-node ${dotClass}" style="color:${color}">
                <div class="fairy-pi-dot"></div>
                <div class="fairy-pi-label">${escapeHtml(ph)}${ts}</div>
            </div>`;
            if (i < FAIRY_PHASE_TRACK.length - 1) {
                const connDone = visited.has(ph) && visited.has(FAIRY_PHASE_TRACK[i + 1]);
                stepperHtml += `<div class="fairy-pi-connector ${connDone ? 'done' : ''}"></div>`;
            }
        }
        // Terminal node
        const termLabel  = status ? ({ delivered: '✓ Delivered', failed: '✗ Failed', escalate: '↑ Escalated', partial_delivered: '◑ Partial' }[status] || status) : '—';
        const termClass  = status ? (status === 'delivered' ? 'done' : 'done-fail') : '';
        stepperHtml += `<div class="fairy-pi-connector ${status ? 'done' : ''}"></div>`;
        stepperHtml += `<div class="fairy-pi-node ${termClass}" style="color:${statusColor}">
            <div class="fairy-pi-dot"></div>
            <div class="fairy-pi-label">${escapeHtml(termLabel)}</div>
        </div>`;
        stepperHtml += '</div>';

        // ── Diagnose detour indicator ──
        let diagnoseHtml = '';
        const diagCount = phaseHistory.filter(p => p === 'diagnose').length;
        if (diagCount > 0) {
            diagnoseHtml = `<div class="fairy-pi-diag-note muted small">${diagCount} diagnose cycle${diagCount > 1 ? 's' : ''} during verify</div>`;
        }

        // ── Budget bars ──
        let budgetHtml = '';
        if (budget) {
            const probeMax = (budget.probesUsed || 0) + (budget.probesRemaining || 40);
            const turnMax  = (budget.turnsUsed  || 0) + (budget.turnsRemaining  || 80);
            const btMax    = (budget.backtracksUsed || 0) + (budget.backtracksRemaining || 3);
            budgetHtml = `
            <div class="fairy-pi-section">
                <div class="fairy-pi-section-title">Budget</div>
                ${_budgetRow('Probes', budget.probesUsed || 0, probeMax)}
                ${_budgetRow('Turns', budget.turnsUsed || 0, turnMax)}
                ${_budgetRow('Backtracks', budget.backtracksUsed || 0, btMax)}
            </div>`;
        }

        // ── Step chain ──
        let stepsHtml = '';
        if (steps.length > 0) {
            const cards = steps.map(s => {
                const syms   = (s.definesSymbols || []).map(sym =>
                    `<span class="fairy-pi-sym">${escapeHtml(sym)}</span>`).join('');
                const deps   = (s.dependsOn || []).length > 0
                    ? `<span class="fairy-pi-dep-note muted">deps: ${escapeHtml(s.dependsOn.join(', '))}</span>` : '';
                const code   = escapeHtml((s.code || '').trim().slice(0, 240));
                const note   = s.note ? `<div class="fairy-pi-note muted">${escapeHtml(s.note)}</div>` : '';
                return `<div class="fairy-pi-step-card">
                    <div class="fairy-pi-step-header">
                        <span class="fairy-pi-step-id">${escapeHtml(s.id)}</span>
                        <span class="fairy-pi-step-syms">${syms}</span>
                        ${deps}
                    </div>
                    ${note}
                    <pre class="fairy-pi-code">${code}</pre>
                </div>`;
            }).join('');
            stepsHtml = `<div class="fairy-pi-section">
                <div class="fairy-pi-section-title">Step Chain (${steps.length})</div>
                ${cards}
            </div>`;
        }

        // ── Verify result / clean notebook link ──
        let verifyHtml = '';
        if (status) {
            const label = status === 'delivered'
                ? `<span style="color:var(--acc-green);font-weight:700">✓ Verification passed</span>`
                : status === 'failed'
                    ? `<span style="color:var(--acc-red);font-weight:700">✗ Failed to verify</span>`
                    : status === 'partial_delivered'
                        ? `<span style="color:var(--acc-yellow);font-weight:700">◑ Partial — unverified clean.wb attached</span>`
                        : `<span style="color:var(--acc-yellow);font-weight:700">↑ Escalated (no clean notebook)</span>`;
            const nbBtn = cleanNbPath
                ? `<button class="fairy-pi-btn" data-cmd="openFile" data-target="${escapeHtml(cleanNbPath)}" title="${escapeHtml(cleanNbPath)}">Open clean.wb ↗</button>`
                : '';
            verifyHtml = `<div class="fairy-pi-section fairy-pi-result">
                <div class="fairy-pi-section-title">Result</div>
                <div style="margin-bottom:6px">${label}</div>
                ${nbBtn}
            </div>`;
        }

        // ── Run metadata ──
        const metaHtml = `<div class="fairy-pi-meta muted small">
            Charm <code>${escapeHtml(started.charmId || '—')}</code>
            &nbsp;·&nbsp;${escapeHtml(started.model || '—')}
            &nbsp;·&nbsp;${escapeHtml(started.provider || '—')}
        </div>`;

        const planHtml = renderCharmPlan(questsVM, started.charmId);
        const progress = buildProgressVM(state.events);
        let progressHtml = '';
        if (progress) {
            const age = _ageInfo(progress.lastTs);
            const act = progress.activity ? oneLineSummary(progress.activity) : 'waiting for first operation';
            progressHtml = `<div class="fairy-progress-summary">
                <div class="fairy-progress-now" data-level="${age.level}">
                    <span class="fairy-progress-pulse"></span>
                    <strong>${age.level === 'stalled' ? 'Possibly stalled' : age.level === 'quiet' ? 'No recent telemetry' : 'Advancing'}</strong>
                    <span>${escapeHtml(act)}</span><small>last event ${age.text}</small>
                </div>
                <div class="fairy-progress-grid">
                    ${_progressList('Established facts', 'facts', progress.facts, 'No facts established yet.')}
                    ${_progressList('Worked', 'worked', progress.successes, 'No successful probes yet.')}
                    ${_progressList('Failed / blocked', 'failed', progress.failures, 'No failures recorded.')}
                    ${_progressList('Saved progress', 'saved', progress.checkpoints, 'No checkpoints yet.')}
                </div>
            </div>`;
        }

        pane.innerHTML = `
            <div class="fairy-pi-wrap">
                ${charmsBoardHtml}
                ${metaHtml}
                ${progressHtml}
                ${stepperHtml}
                ${diagnoseHtml}
                ${planHtml}
                ${budgetHtml}
                ${stepsHtml}
                ${verifyHtml}
            </div>`;
    }

    // Keep stall age readable even when no new telemetry arrives.
    setInterval(() => {
        if (!isHistorical && state.run && isActiveState(state.run.state)) renderFairy();
    }, 5000);

    function _budgetRow(label, used, total) {
        const frac = total > 0 ? used / total : 0;
        const pct  = (frac * 100).toFixed(1);
        const remaining = 1 - frac;
        const barColor = remaining < 0.1 ? 'var(--acc-red)' : remaining < 0.3 ? 'var(--acc-yellow)' : 'var(--vscode-progressBar-background, #007acc)';
        return `<div class="fairy-pi-budget-row">
            <span class="fairy-pi-budget-label">${escapeHtml(label)}</span>
            <div class="fairy-pi-budget-bar">
                <div class="fairy-pi-budget-fill" style="width:${pct}%;background:${barColor}"></div>
            </div>
            <span class="fairy-pi-budget-count">${used}/${total}</span>
        </div>`;
    }

    // ── Live "Now" strip ───────────────────────────────────────────────────
    // What the agent is doing right now: phase + budget + last activity + the
    // model's streaming reasoning/response (delta-accumulated, scrollable).

    const _stream = { key: '', text: '', done: false };   // key = role|kind

    function _feedStream(ev) {
        const p = ev.payload || {};
        const kind = ev.type === 'llm.reasoning_progress' ? 'thinking' : 'responding';
        const key  = `${p.role || ''}|${kind}`;
        const hasDelta = typeof p.delta === 'string';
        if (key !== _stream.key || (hasDelta && p.seq === 0) || _stream.done) {
            _stream.key = key; _stream.text = ''; _stream.done = false;
        }
        if (hasDelta) _stream.text += p.delta;
        else _stream.text = String(p.preview || '');      // old logs: preview fallback
        if (_stream.text.length > 60000) _stream.text = _stream.text.slice(-60000);
        if (els.nowStreamLabel) els.nowStreamLabel.textContent = `${p.role || 'model'} · ${kind}…`;
        if (els.nowStreamBody) {
            const b = els.nowStreamBody;
            // Follow the stream only while the user is at the bottom — a manual
            // scroll-up to read is never yanked back down.
            const follow = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
            b.textContent = _stream.text;
            if (follow) b.scrollTop = b.scrollHeight;
        }
    }

    function _endStream() {
        _stream.done = true;
        if (els.nowStreamLabel && _stream.key) {
            els.nowStreamLabel.textContent = _stream.key.replace('|', ' · ') + ' — turn complete';
        }
    }

    function _setActivity(text) {
        if (els.nowActivity) els.nowActivity.textContent = String(text || '').slice(0, 120);
    }

    function renderNowStrip() {
        const st = state.lastStatus || {};
        if (els.nowPhase) {
            els.nowPhase.textContent = st.phase ? st.phase : (state.run ? String(state.run.state).toLowerCase() : '—');
            els.nowPhase.dataset.phase = st.phase || '';
        }
        if (els.nowMeta) {
            const bits = [];
            if (st.probesUsed != null) bits.push(`probes ${st.probesUsed}`);
            if (st.turnsUsed  != null) bits.push(`turns ${st.turnsUsed}`);
            if (typeof st.costUSD === 'number') bits.push(`$${st.costUSD.toFixed(2)}`);
            els.nowMeta.textContent = bits.join(' · ');
        }
        // steering availability
        if (els.steerInput) {
            els.steerInput.disabled = !state.steerActive;
            els.steerInput.placeholder = state.steerActive
                ? 'Steer the agent — your note reaches it at its next turn…'
                : 'Steering opens while the fairy explores…';
        }
        if (els.steerBtn) els.steerBtn.disabled = !state.steerActive;
    }

    // ── Idle dashboard: recent runs list ───────────────────────────────────
    function renderRecentRuns() {
        if (!els.recentRuns) return;
        const runs = state.recentRuns || [];
        if (!runs.length) {
            els.recentRuns.innerHTML = '<span class="muted small">No runs recorded yet — start one above.</span>';
            return;
        }
        const STATUS_CLS = (s) => /deliver|success|done/.test(s) ? 'ok' : (/partial/.test(s) ? 'warn' : (s ? 'bad' : ''));
        els.recentRuns.innerHTML = runs.slice(0, 8).map(r => {
            const label = String(r.runId).replace(/^run_/, '').replace('T', ' ').replace(/-\d{3}Z$/, '').replace(/-/g, (m, off) => off > 9 ? ':' : '-');
            const brief = r.brief ? escapeHtml(r.brief) : '<span class="muted">(no brief captured)</span>';
            const chips = [];
            if (r.status)  chips.push(`<span class="rr-chip rr-chip--${STATUS_CLS(r.status)}">${escapeHtml(r.status)}</span>`);
            if (typeof r.costUSD === 'number') chips.push(`<span class="rr-chip">$${r.costUSD.toFixed(2)}</span>`);
            return `<div class="rr-card" data-run="${escapeHtml(r.runId)}" title="Open this run in the Inspector">
                <div class="rr-card__top"><span class="rr-card__time">${escapeHtml(label)}</span>${chips.join('')}</div>
                <div class="rr-card__brief">${brief}</div>
            </div>`;
        }).join('');
        els.recentRuns.querySelectorAll('.rr-card[data-run]').forEach(card => {
            card.addEventListener('click', () => _openHistorical(card.dataset.run));
        });
    }

    function _openHistorical(runId) {
        if (!runId) return;
        if (els.runPicker && Array.from(els.runPicker.options).some(o => o.value === runId)) {
            els.runPicker.value = runId;
        }
        state.events = [];
        render();
        vscode.postMessage({ command: FROM.LOAD_HISTORICAL_RUN, runId });
    }

    // ── dynamic type filter options ────────────────────────────────────────
    let _knownTypes = new Set();
    function refreshTypeOptions() {
        if (!els.filterType) return;
        const types = new Set(state.events.map(e => e.type));
        if (types.size === _knownTypes.size) return;
        _knownTypes = types;
        const current = els.filterType.value;
        els.filterType.innerHTML = '<option value="">All types</option>' +
            [...types].sort().map(t => `<option${t === current ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
    }

    /**
     * Collapse llm.reasoning_progress / llm.response_progress runs into the
     * following llm.call.  Dangling events at end (still streaming) → keep
     * last one only as a live preview row.
     */
    function _mergeReasoningEvents(evs) {
        const out = [];
        let pendingReasoning = 0;
        let pendingResponse  = 0;
        for (let i = 0; i < evs.length; i++) {
            const ev = evs[i];
            if (ev.type === 'llm.reasoning_progress') {
                pendingReasoning++;
            } else if (ev.type === 'llm.response_progress') {
                pendingResponse++;
            } else if (ev.type === 'llm.call' && (pendingReasoning > 0 || pendingResponse > 0)) {
                // Shallow-clone so we don't mutate state.events
                out.push(Object.assign({}, ev, {
                    _reasoningChunks: pendingReasoning,
                    _responseChunks:  pendingResponse,
                }));
                pendingReasoning = 0;
                pendingResponse  = 0;
            } else {
                if (pendingReasoning > 0 || pendingResponse > 0) {
                    // Progress not followed by llm.call — keep last progress row
                    out.push(evs[i - 1]);
                    pendingReasoning = 0;
                    pendingResponse  = 0;
                }
                out.push(ev);
            }
        }
        // Dangling at end (streaming in progress)
        if (pendingReasoning > 0 || pendingResponse > 0) out.push(evs[evs.length - 1]);
        return out;
    }

    function renderEvents() {
        refreshTypeOptions();
        const f = state.filter;
        const filtered = state.events.filter(ev => {
            if (f.type && ev.type !== f.type) return false;
            if (f.text) {
                const hay = (ev.type + ' ' + JSON.stringify(ev.payload || {})).toLowerCase();
                if (!hay.includes(f.text.toLowerCase())) return false;
            }
            return true;
        });
        els.eventCount.textContent =
            filtered.length === state.events.length
                ? `${filtered.length} events`
                : `${filtered.length} of ${state.events.length} events`;

        // Cap rendered events at 5000 rows for raw mode; structured is fine at any size.
        const isFiltering = !!(f.type || f.text);

        if (state.viewMode === 'structured' && !isFiltering) {
            els.eventsTable.hidden = true;
            els.structuredBody.hidden = false;
            _renderStructured(filtered);
            state._viewedEvents = filtered;
            _stickyScrollBottom();
            return;
        }

        // Raw events mode (or structured + filtered → fall back to flat rows)
        els.structuredBody.hidden = true;
        els.eventsTable.hidden = false;

        // Merge consecutive llm.reasoning_progress runs into the adjacent llm.call row.
        const merged = _mergeReasoningEvents(filtered);
        // For very large runs, cap raw rendering to last 5000 to keep DOM responsive.
        const view = merged.length > 5000 ? merged.slice(-5000) : merged;
        state._viewedEvents = view;

        // Always render as a flat enriched table now (no nested phase grouping).
        // The Structured view above handles aggregation; Raw stays flat per spec.
        els.eventsBody.innerHTML = view.map((ev, i) => _eventRowHtml(ev, i)).join('');

        _stickyScrollBottom();
    }

    function _stickyScrollBottom() {
        if (els.detailDrawer && !els.detailDrawer.hidden) return;
        if (els.eventsWrap) els.eventsWrap.scrollTop = els.eventsWrap.scrollHeight;
    }

    // ── structured trace ───────────────────────────────────────────────────
    //
    // Hierarchy:
    //   Quest (or "Pre-quest")
    //     ├─ Planner step           (llm.call · role=oberon)
    //     ├─ Charm 1                (charm.dispatched)
    //     │    ├─ Step 1 (turn)     (llm.call · role=fairy + its tool.call/correlated.tool/etc.)
    //     │    ├─ Step 2 (turn)
    //     │    ├─ Scroll
    //     │    └─ Skeptic verdict   (llm.call · role=skeptic)
    //     └─ Charm 2 …
    //   Conclusion / Postmortem
    //
    // A "step" inside a charm = the events between one fairy llm.call and the
    // next (i.e. one LLM turn + the tool.calls it spawned).  We aggregate
    // token / cost chips per step and expose every member as a clickable row.

    function _renderStructured(filtered) {
        const tree = _buildStructuredTree(filtered);
        const sb   = els.structuredBody;

        sb.innerHTML = tree.map(node => _renderNode(node, 0)).join('');

        // Wire up node toggles
        sb.querySelectorAll('.sn-hdr[data-snid]').forEach(hdr => {
            hdr.addEventListener('click', (e) => {
                if (e.target instanceof Element && e.target.closest('button,a')) return;
                const id = hdr.dataset.snid;
                const det = hdr.parentElement;
                const willOpen = !det.classList.contains('open');
                det.classList.toggle('open', willOpen);
                if (willOpen) state.openSteps.add(id); else state.openSteps.delete(id);
            });
        });

        // Wire up event-row click → detail drawer
        sb.querySelectorAll('.sn-event[data-eid]').forEach(row => {
            row.addEventListener('click', () => {
                const eid = row.dataset.eid;
                const ev  = state.events.find(e => e.eventId === eid);
                if (ev) openDetail(ev);
            });
        });
    }

    function _buildStructuredTree(events) {
        /** @type {Array<{kind:string,id:string,label:string,sublabel?:string,chips?:any,children?:any[],events?:any[],ev?:any}>} */
        const root = [];
        let curQuest   = null;   // top-level quest node
        let curCharm   = null;   // current charm node inside quest
        let curAttempt = null;   // current attempt subnode inside charm
        let curStep    = null;   // current turn step inside attempt
        let attemptCounter = new Map();  // charmId → next attempt number

        const _ensureRoot = (root) => {
            if (root.length === 0 || root[root.length - 1].kind !== 'pre') {
                const n = { kind: 'pre', id: 'pre', label: 'Pre-quest', children: [], events: [] };
                root.push(n);
            }
            return root[root.length - 1];
        };

        // Innermost container for transient events (transitions, omens, etc.):
        // attempt > charm > quest > pre.
        const innerContainer = () => curAttempt || curCharm || curQuest || _ensureRoot(root);
        // Container for fairy steps (llm.call, tool.call) — same as innerContainer
        // but creates an implicit attempt if a charm is active without one (e.g.,
        // a stream that skipped fairy.started).
        const stepContainer = () => {
            if (curAttempt) return curAttempt;
            if (curCharm) {
                // Synthesise attempt #1 lazily for charms missing a fairy.started event.
                _openAttempt({ payload: { charmId: curCharm.sublabel || curCharm.id, model: '' } }, /*synthetic*/ true);
                return curAttempt;
            }
            return curQuest || _ensureRoot(root);
        };

        const flushStep = () => {
            if (curStep) {
                _summariseStep(curStep);
                curStep = null;
            }
        };
        const _openAttempt = (ev, synthetic) => {
            flushStep();
            if (!curCharm) return;
            const cid = curCharm.sublabel || curCharm.id;
            const n = (attemptCounter.get(cid) || 0) + 1;
            attemptCounter.set(cid, n);
            curAttempt = {
                kind: 'attempt',
                id: 'attempt:' + cid + ':' + n,
                label: n === 1 ? 'Attempt 1 — first pass' : `Attempt ${n} — revision`,
                sublabel: (ev && ev.payload && ev.payload.model) || '',
                chips: [], children: [], events: ev ? [ev] : [],
            };
            curCharm.children.push(curAttempt);
        };
        const _closeAttempt = () => { flushStep(); curAttempt = null; };

        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const t  = ev.type;
            const p  = ev.payload || {};

            if (t === 'quest.accepted') {
                flushStep(); curCharm = null; curAttempt = null;
                curQuest = {
                    kind: 'quest', id: 'quest:' + (p.questId || i),
                    label: p.title || p.questId || 'Quest',
                    sublabel: p.questId || '',
                    children: [], events: [ev],
                };
                root.push(curQuest);
                continue;
            }
            if (t === 'charm.dispatched') {
                flushStep(); curAttempt = null;
                curCharm = {
                    kind: 'charm', id: 'charm:' + (p.charmId || i),
                    label: p.title || p.charmId || 'Charm',
                    sublabel: p.charmId || '',
                    children: [], events: [ev],
                };
                attemptCounter.set(p.charmId || '', 0);
                (curQuest || _ensureRoot(root)).children.push(curCharm);
                continue;
            }
            if (t === 'fairy.started') {
                // Open a new attempt (first pass or revision). Each fairy.started
                // begins its own grouped block of LLM turns + tools.
                _openAttempt(ev, false);
                continue;
            }
            if (t === 'scroll.submitted') {
                flushStep();
                const node = {
                    kind: 'scroll', id: 'scroll:' + (ev.eventId || i),
                    label: _summaryFor(ev), sublabel: t,
                    children: [], events: [ev], ev,
                };
                (curAttempt || curCharm || curQuest || _ensureRoot(root)).children.push(node);
                // Scroll closes the current attempt; the next fairy.started
                // (if any) will open the revision attempt.
                _closeAttempt();
                continue;
            }
            if (t === 'skeptic.verdict') {
                _closeAttempt();
                const node = {
                    kind: 'skeptic', id: 'skeptic:' + (ev.eventId || i),
                    label: _summaryFor(ev), sublabel: t,
                    children: [], events: [ev], ev,
                };
                (curCharm || curQuest || _ensureRoot(root)).children.push(node);
                continue;
            }
            if (t === 'oberon.verdict') {
                _closeAttempt();
                const node = {
                    kind: 'verdict', id: 'verdict:' + (ev.eventId || i),
                    label: _summaryFor(ev), sublabel: t,
                    children: [], events: [ev], ev,
                };
                (curQuest || _ensureRoot(root)).children.push(node);
                continue;
            }
            if (t === 'research.conclusion' || t === 'postmortem.written' || t === 'grimoire.updated') {
                flushStep(); curAttempt = null; curCharm = null;
                const node = {
                    kind: 'top', id: t + ':' + (ev.eventId || i),
                    label: _summaryFor(ev), sublabel: t,
                    children: [], events: [ev], ev,
                };
                root.push(node);
                continue;
            }
            if (t === 'circle.transition') {
                // Quiet badge inside the innermost active container so transitions
                // appear next to the events they bracket.
                const c = innerContainer();
                if (c.events) c.events.push(ev);
                continue;
            }

            if (t === 'llm.call') {
                flushStep();
                const role = p.role || '';
                if (role === 'oberon') {
                    // Planner / executive — surface as its own step at quest level
                    const node = {
                        kind: 'plannerStep',
                        id: 'plannerStep:' + (ev.eventId || i),
                        label: 'Planner · ' + (p.model || ''),
                        sublabel: '',
                        chips: _stepChipsFromLlm(ev),
                        children: [], events: [ev], ev,
                    };
                    (curQuest || _ensureRoot(root)).children.push(node);
                    continue;
                }
                if (role === 'skeptic') {
                    // Skeptic LLM call belongs to the skeptic-review block
                    // between attempts → attach directly to charm (not attempt).
                    const node = {
                        kind: 'skepticStep',
                        id: 'skStep:' + (ev.eventId || i),
                        label: 'Skeptic · ' + (p.model || ''),
                        sublabel: '', chips: _stepChipsFromLlm(ev),
                        children: [], events: [ev], ev,
                    };
                    (curCharm || curQuest || _ensureRoot(root)).children.push(node);
                    continue;
                }
                if (role === 'cellCritic') {
                    const node = {
                        kind: 'criticStep',
                        id: 'critStep:' + (ev.eventId || i),
                        label: 'Cell Critic · ' + (p.model || ''),
                        sublabel: '', chips: _stepChipsFromLlm(ev),
                        children: [], events: [ev], ev,
                    };
                    (curAttempt || curCharm || curQuest || _ensureRoot(root)).children.push(node);
                    continue;
                }
                // Default: fairy turn — goes into the current attempt.
                curStep = {
                    kind: 'step',
                    id: 'step:' + (ev.eventId || i),
                    label: '',  // filled by _summariseStep
                    sublabel: '',
                    chips: null,
                    children: [], events: [ev], ev, llmCalls: [ev], tools: [],
                };
                stepContainer().children.push(curStep);
                continue;
            }

            if (t === 'tool.call' || t === 'correlated.tool' || t === 'spell.exec') {
                if (curStep) {
                    curStep.events.push(ev);
                    curStep.tools.push(ev);
                } else {
                    const c = innerContainer();
                    c.events = c.events || []; c.events.push(ev);
                }
                continue;
            }

            if (t === 'llm.reasoning_progress' || t === 'llm.response_progress') {
                if (curStep) {
                    if (t === 'llm.reasoning_progress') curStep._reasoningChunks = (curStep._reasoningChunks || 0) + 1;
                    else                                 curStep._responseChunks  = (curStep._responseChunks  || 0) + 1;
                }
                continue;
            }

            // Default: attach to current step or innermost container.
            if (curStep) {
                curStep.events.push(ev);
            } else {
                const c = innerContainer();
                c.events = c.events || []; c.events.push(ev);
            }
        }
        flushStep();

        // Final pass: roll up chips for attempts / charms / quests
        for (const node of root) _rollupChips(node);

        return root;
    }

    function _summariseStep(step) {
        const ev = step.ev;
        const p  = ev.payload || {};
        const toolCount = step.tools.length;
        const lastTool = toolCount > 0 ? step.tools[step.tools.length - 1] : null;
        let lbl = `Turn · ${p.role || 'fairy'}`;
        if (lastTool) {
            const tp = lastTool.payload || {};
            lbl += ' → ' + (tp.name || lastTool.type);
        }
        step.label = lbl;
        step.chips = _stepChipsFromLlm(ev, { tools: toolCount });
    }

    function _stepChipsFromLlm(ev, extra) {
        const p = ev.payload || {};
        const u = p.usage || {};
        const chips = [];
        chips.push({ k: 'llm', v: '1 LLM' });
        if (extra && extra.tools) chips.push({ k: 'tools', v: extra.tools + ' tool' + (extra.tools === 1 ? '' : 's') });
        if (u.inputTokens)  chips.push({ k: 'in',  v: human(u.inputTokens) + ' in' });
        if (u.outputTokens) chips.push({ k: 'out', v: human(u.outputTokens) + ' out' });
        if (u.cacheReadTokens) chips.push({ k: 'cache', v: human(u.cacheReadTokens) + ' cache' });
        if (typeof p.costUSD === 'number') chips.push({ k: 'cost', v: '$' + p.costUSD.toFixed(4) });
        if (typeof p.latencyMs === 'number') chips.push({ k: 'lat', v: (p.latencyMs/1000).toFixed(2) + 's' });
        return chips;
    }

    function _rollupChips(node) {
        if (!node.children || node.children.length === 0) return;
        let llm = 0, tools = 0, inTok = 0, outTok = 0, cacheTok = 0, cost = 0;
        for (const c of node.children) {
            _rollupChips(c);
            // Sum from the leaf step (ev) and any nested rollups
            const ce = c.ev;
            if (ce && ce.type === 'llm.call') {
                llm += 1;
                const cp = ce.payload || {};
                const cu = cp.usage || {};
                inTok    += cu.inputTokens    || 0;
                outTok   += cu.outputTokens   || 0;
                cacheTok += cu.cacheReadTokens || 0;
                cost     += cp.costUSD || 0;
            }
            if (c.tools) tools += c.tools.length;
            // Sum any chips recorded on charm-like children
            if (c._sum) {
                llm += c._sum.llm; tools += c._sum.tools;
                inTok += c._sum.inTok; outTok += c._sum.outTok;
                cacheTok += c._sum.cacheTok; cost += c._sum.cost;
            }
        }
        node._sum = { llm, tools, inTok, outTok, cacheTok, cost };
        if (node.kind === 'quest' || node.kind === 'charm') {
            const chips = [];
            if (llm)    chips.push({ k: 'llm',  v: llm + ' LLM' });
            if (tools)  chips.push({ k: 'tools', v: tools + ' tool' + (tools === 1 ? '' : 's') });
            if (inTok)  chips.push({ k: 'in',   v: human(inTok) + ' in' });
            if (outTok) chips.push({ k: 'out',  v: human(outTok) + ' out' });
            if (cacheTok) chips.push({ k: 'cache', v: human(cacheTok) + ' cache' });
            if (cost)   chips.push({ k: 'cost', v: '$' + cost.toFixed(4) });
            node.chips = chips;
        }
    }

    function _renderNode(node, depth) {
        const open = state.openSteps.has(node.id) || _autoOpen(node);
        const chipsHtml = (node.chips || []).map(c =>
            `<span class="sn-chip sn-chip--${escapeHtml(c.k)}">${escapeHtml(c.v)}</span>`
        ).join('');
        const sub = node.sublabel ? `<span class="sn-sub">${escapeHtml(node.sublabel)}</span>` : '';
        const icon = _iconForNode(node);
        const children = (node.children || []).map(c => _renderNode(c, depth + 1)).join('');
        // For a step, also list its event members (tool calls + the llm.call)
        const memberRows = _renderNodeMembers(node);
        const cls = ['sn', 'sn--' + node.kind, open ? 'open' : ''].join(' ');
        return `<div class="${cls}" style="--sn-depth:${depth}">
            <div class="sn-hdr" data-snid="${escapeHtml(node.id)}">
                <span class="sn-arrow">▸</span>
                <span class="sn-icon">${icon}</span>
                <span class="sn-label">${escapeHtml(node.label || '')}</span>
                ${sub}
                <span class="sn-spacer"></span>
                <span class="sn-chips">${chipsHtml}</span>
            </div>
            <div class="sn-body">${memberRows}${children}</div>
        </div>`;
    }

    function _autoOpen(node) {
        // Keep top-level (pre / quest / top) open by default. Charms also open.
        if (node.kind === 'pre' || node.kind === 'quest' || node.kind === 'top') return true;
        if (node.kind === 'charm') return true;
        if (node.kind === 'attempt') return true;
        return false;
    }

    function _iconForNode(node) {
        switch (node.kind) {
            case 'quest':       return '◆';
            case 'charm':       return '✦';
            case 'attempt':     return '◭';
            case 'step':        return '▸';
            case 'plannerStep': return '✧';
            case 'skepticStep': return '⚖';
            case 'criticStep':  return '⚙';
            case 'scroll':      return '📜';
            case 'skeptic':     return '⚖';
            case 'verdict':     return '⚖';
            case 'top':         return '·';
            default:            return '·';
        }
    }

    function _renderNodeMembers(node) {
        const evs = node.events || [];
        if (evs.length === 0) return '';
        const rows = evs.map(ev => {
            const p = ev.payload || {};
            const cost = (typeof p.costUSD === 'number') ? `$${p.costUSD.toFixed(4)}` : '';
            const role = p.role || p.name || '';
            const sum  = _summaryFor(ev);
            return `<div class="sn-event" data-eid="${escapeHtml(ev.eventId || '')}" title="Click for full detail">
                <span class="sn-event__time">${escapeHtml(fmtTime(ev.ts))}</span>
                <span class="sn-event__type">${iconFor(ev.type)}${escapeHtml(ev.type)}</span>
                <span class="sn-event__role">${escapeHtml(role)}</span>
                <span class="sn-event__sum">${escapeHtml(sum)}</span>
                <span class="sn-event__cost">${escapeHtml(cost)}</span>
            </div>`;
        }).join('');
        return `<div class="sn-events">${rows}</div>`;
    }

    function _summaryFor(ev) { return oneLineSummary(ev); }

    function _eventRowHtml(ev, idx) {
        const p = ev.payload || {};
        const role = p.role || p.name || p.wardType || '';
        const cost = (typeof p.costUSD === 'number') ? `$${p.costUSD.toFixed(4)}` : '';
        const hasDetail = p.promptMessages || p.responseText || p.reasoning
            || ev.type === 'tool.call' || ev.type === 'correlated.tool'
            || ev.type === 'research.conclusion';
        const cls = hasDetail ? 'clickable has-detail' : 'clickable';
        return `<tr data-type="${escapeHtml(ev.type)}" data-idx="${idx}" data-eid="${escapeHtml(ev.eventId || '')}" class="${cls}">` +
            `<td>${escapeHtml(fmtTime(ev.ts))}</td>` +
            `<td>${iconFor(ev.type)}${escapeHtml(ev.type)}</td>` +
            `<td>${escapeHtml(role)}</td>` +
            `<td>${escapeHtml(oneLineSummary(ev))}</td>` +
            `<td>${escapeHtml(cost)}</td>` +
            `</tr>`;
    }


    // ── helpers ────────────────────────────────────────────────────────────
    function isActiveState(s) { return s && s !== 'IDLE' && s !== 'ABORTED' && s !== 'ERROR'; }

    function fmtPrice(v) {
        if (v == null) return '<span class="muted">n/a</span>';
        return `$${Number(v).toFixed(3)}`;
    }
    function fmtTime(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (_) { return ''; }
    }
    function human(n) {
        if (n == null) return 'n/a';
        const v = Number(n);
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
        return String(v);
    }
    function oneLineSummary(ev) {
        const p = ev.payload || {};
        const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n || 110);
        switch (ev.type) {
            case 'circle.transition': return `${p.from || ''} → ${p.to || ''}`;
            case 'llm.call': {
                const u = p.usage || {};
                const thinkingNote = ev._reasoningChunks > 0
                    ? ` · think×${ev._reasoningChunks}`
                    : (p.reasoning ? ` · think ${human(p.reasoning.length)}c` : '');
                const streamNote = ev._responseChunks > 0 ? ` · stream×${ev._responseChunks}` : '';
                const lat        = (typeof p.latencyMs === 'number') ? ` · ${(p.latencyMs/1000).toFixed(2)}s` : '';
                const cache      = u.cacheReadTokens ? ` · cache ${human(u.cacheReadTokens)}` : '';
                return `${p.role || ''} · ${p.model || ''} · in ${human(u.inputTokens || 0)} · out ${human(u.outputTokens || 0)}${cache}${thinkingNote}${streamNote}${lat}`;
            }
            case 'tool.call':         return p.name ? `${p.name}(${summariseArgs(p.args)})` : 'tool';
            case 'correlated.tool':   return `${p.name || 'tool'} ${p.ok ? '✓' : '✗'} ${p.durationMs || 0}ms${p.kind && p.kind !== 'ok' ? ` · ${p.kind}` : ''}${p.error ? ` · ${clip(p.error, 80)}` : ''}`;
            case 'spell.exec':        return p.summary || 'spell';
            case 'ward.requested':    return `${p.method || p.wardType || ''} · ${clip(p.expression, 80)}`;
            case 'ward.result':       return `${p.wardType || ''} → ${p.passed ? 'pass' : 'fail'} · ${p.detail || ''}`;
            case 'quest.accepted':    return `${p.questId || ''} · ${p.title || ''}`;
            case 'quest.clarify':     return p.answered ? 'user answered the clarification' : `needs: ${clip((p.missingInfo || []).join(' · '), 110)}`;
            case 'quest.assumed_parameters': return `assumed: ${clip((p.assumptions || []).join(' · ').replace(/ASSUMED:\s*/g, ''), 120)}`;
            case 'charm.dispatched':  return `${p.charmId || ''} · ${p.title || ''}`;
            case 'charm.started':     return `charm ${p.index || '?'} of ${p.total || '?'}${p.priorFactsCount ? ` · builds on ${p.priorFactsCount} prior facts` : ''}`;
            case 'fairy.started':     return `${p.charmId || ''} · ${p.model || ''}${p.build && p.build.version ? ` · v${p.build.version}` : ''}`;
            case 'fairy.status':      return p.done ? `finished: ${p.status || ''}` : `${p.phase || ''} · probes ${p.probesUsed ?? '?'} · turns ${p.turnsUsed ?? '?'}${typeof p.costUSD === 'number' ? ` · $${p.costUSD.toFixed(2)}` : ''}`;
            case 'fairy.phase':       return `phase → ${p.phase || ''}`;
            case 'fairy.steer':       return `user steering picked up: “${clip(p.text, 100)}”`;
            case 'fairy.self_verify': return `evidence re-check: ${p.matched ?? '?'} of ${p.checked ?? '?'} matched${(p.mismatched && p.mismatched.length) ? ' — MISMATCHES!' : ''}`;
            case 'fairy.run_metrics': return `probes ${p.probes ?? p.probesUsed ?? '?'} · turns ${p.turns ?? p.turnsUsed ?? '?'}${typeof p.costUSD === 'number' ? ` · $${p.costUSD.toFixed(2)}` : ''}`;
            case 'fairy.continued':   return `budget extended (continuation #${p.continuation || 1})`;
            case 'fairy.error':       return clip(p.message || p.error, 140);
            case 'fairy.handoff_seeded': return `${p.utils ?? p.utilCount ?? 0} utils + ${p.facts ?? p.factCount ?? 0} facts from the previous stage loaded into the kernel`;
            case 'fairy.history_compacted': return 'conversation compacted to fit the context window';
            case 'probe.appended':    return `${p.probeId || 'probe'}${p.note ? ` · ${clip(p.note, 100)}` : ''}`;
            case 'plan.created':      return `plan: ${clip((p.steps || []).join(' → '), 130)}`;
            case 'checkpoint.recorded': return `checkpoint: ${clip(p.sectionTitle, 90)} (${(p.stepsIncluded || []).length} steps)`;
            case 'util.registered':   return `defined ${p.name || 'utility'}${p.note ? ` — ${clip(p.note, 80)}` : ''}`;
            case 'scroll.submitted':  return `${p.status ? p.status + ' · ' : ''}${p.scrollId || ''} · conf ${typeof p.confidence === 'number' ? p.confidence.toFixed(2) : '?'}${typeof p.evidenceCount === 'number' ? ` · ${p.evidenceCount} evidence` : ''}`;
            case 'skeptic.verdict':   return `${p.verdict || ''}${p.verificationLevel ? ` (${p.verificationLevel})` : ''} · matched ${(p.summary && p.summary.matched) || 0}/${(p.summary && p.summary.total) || 0}${p.summary && p.summary.failed ? ` · failed ${p.summary.failed}` : ''}${p.wardSummary && p.wardSummary.total ? ` · wards ${p.wardSummary.passed}/${p.wardSummary.total}` : ''}`;
            case 'oberon.verdict':    return `${String(p.verdict || '').replace(/_/g, ' ').toUpperCase()}${p.verificationLevel ? ` [${p.verificationLevel}]` : ''} · ${clip(p.narrative, 100)}`;
            case 'research.conclusion': return `conf ${typeof p.confidence === 'number' ? p.confidence.toFixed(2) : '?'} · ${typeof p.findingsCount === 'number' ? p.findingsCount : '?'} findings · ${clip(p.summary, 80)}`;
            case 'oberon.decision':   return `${p.verdict || ''}: ${p.rationale || ''}`;
            case 'grimoire.write':    return `+${p.added || 0} facts (${p.narrativePatchBytes || 0} bytes)`;
            case 'grimoire.updated':  return `${p.kind || ''} · ${p.findingsWritten || 0} written${p.findingsExcluded ? ` · ${p.findingsExcluded} excluded` : ''}${p.path ? ` · ${shortPath(p.path)}` : ''}`;
            case 'postmortem.written': return p.path ? shortPath(p.path) : 'postmortem written';
            case 'omen':              return `${p.kind || ''}: ${p.message || ''}`;
            case 'budget.exhausted':  return clip(p.message || `budget cap hit (${p.kind || ''})`, 140);
            case 'llm.reasoning_progress': return `thinking… ${clip(p.preview, 90)}`;
            case 'llm.response_progress':  return `responding… ${clip(p.preview, 90)}`;
            // ── facts & memory ──
            case 'fact.established': {
                const claim = clip(String(p.claim || '').replace(/\*\*/g, ''), 120);
                return `${p.factId || 'fact'}${p.verified === false ? ' (unverified)' : ''}: ${claim}`;
            }
            case 'facts.extracted':   return `${p.count || 0} ${p.kind === 'partial' ? 'working ' : ''}fact(s) banked for the next charm`;
            // ── executive (P-9) ──
            case 'executive.requested': return `Oberon reviews the outcome (reason: ${p.reason || '?'})`;
            case 'executive.decided': return `decision: ${String(p.action || '').replace(/_/g, ' ')}${p.factsWritten ? ` · ${p.factsWritten} facts banked` : ''}${p.diagnosisPreview ? ` — ${clip(p.diagnosisPreview, 90)}` : ''}`;
            case 'executive.auto_dispatched': return `auto follow-up ${p.depth || 1}/${p.maxDepth || '?'} (${String(p.action || '').replace(/_/g, ' ')})`;
            // ── literature ──
            case 'literature.brief':  return 'literature brief added to the notebook';
            case 'literature.progress': return `${p.stage || ''}${p.detail ? ` · ${clip(p.detail, 100)}` : ''}`;
            case 'literature.searched': return `searched: ${clip(p.query || p.question, 100)}`;
            case 'literature.cited':  return `${p.count || ''} paper(s) cited in the deliverable`;
            // ── recall / skills ──
            case 'recall.completed':  return p.mode === 'consult' ? `skill recalled: ${p.skillRef || ''}` : `no matching skill (${p.mode || 'none'})`;
            case 'skill.cited':       return `cited ${p.skillRef || p.ref || 'skill'}`;
            case 'skill.gap_recorded': return `skill gap filed: ${clip(p.topic || p.title, 100)}`;
            case 'skills.used':       return 'skills-used summary written to the notebook';
            case 'skill.usage_reported': return `usage reported: ${p.outcome || ''} (${p.skillRef || ''})`;
            case 'contribution.candidate': return `new skill candidate raised${p.isNewSkill === false ? ' (derived)' : ''} — review before submitting`;
            case 'contribution.draft': return `SKILL.draft.md ${p.draftAuthored ? 'authored' : 'not authored'} · novelty: ${clip(p.novelty, 80)}`;
            case 'contribution.skipped': return `no skill candidate: ${clip((p.reasons || []).join('; '), 110)}`;
            // ── director (the layer above the fairy) ──
            case 'director.started':  return `${p.programmeId || ''}${p.resumed ? ' (resumed)' : ''} · ${clip(p.goalPreview, 100)}`;
            case 'director.plan':     return `${(p.stages || []).length} stages: ${clip((p.stages || []).map(s => s.title).join(' → '), 120)}`;
            case 'director.assumed_parameters': return `assumed: ${clip((p.assumptions || []).join(' · ').replace(/ASSUMED:\s*/g, ''), 120)}`;
            case 'director.stage_started':  return `${p.stageId || ''} “${clip(p.title, 80)}”${p.attempt > 1 ? ` (attempt ${p.attempt})` : ''}`;
            case 'director.stage_finished': return `${p.stageId || ''} → ${p.status || ''}${p.questId ? ` · ${p.questId}` : ''}`;
            case 'director.stage_assessed': return `${p.stageId || ''}: ${p.verdict || ''}${p.surprise && p.surprise !== 'none' ? ` (${p.surprise} surprise)` : ''} → ${String(p.action || '').replace(/_/g, ' ')}${p.reason ? ` — ${clip(p.reason, 80)}` : ''}`;
            case 'director.replan':   return `${String(p.kind || '').replace(/_/g, ' ')} ${p.stageId || ''}${p.reason ? ` — ${clip(p.reason, 90)}` : ''}`;
            case 'director.literature_started': return `consulting literature: ${clip(p.question, 110)}`;
            case 'director.literature_done':    return `literature brief ${p.briefId || ''} · ${p.papers || 0} relevant paper(s)`;
            case 'director.asked_user': return `asked you: ${clip(p.question, 100)} — ${p.answered ? 'answered' : 'no answer'}`;
            case 'director.synthesis_started': return 'synthesising programme findings…';
            case 'director.synthesised': return `outcome: ${(p.outcome && p.outcome.status) || '?'} · ${p.conclusionsCount || 0} conclusions${p.novelty && p.novelty.considerable ? ' · NOVEL result' : ''}`;
            case 'director.finished': return `${(p.outcome && p.outcome.status) || 'done'} · ${p.keyResults || 0} key results · report ${p.report && p.report.pdfPath ? 'PDF ready' : 'written'}`;
            case 'director.aborted':  return 'programme aborted';
            case 'director.failed':   return clip(p.message, 140);
            // ── notebooks / misc ──
            case 'notebook.created':  return shortPath(p.path || '');
            case 'notebook.replayed': return `replayed ${p.cellCount ?? '?'} cells${p.failures ? ` · ${p.failures} failed` : ' · clean'}`;
            case 'notebook.checkpoint': return `checkpoint saved${p.path ? ` · ${shortPath(p.path)}` : ''}`;
            case 'critic.replay_summary': return clip(p.summary || JSON.stringify(p), 130);
            default: {
                // Prefer obvious human fields before falling back to raw JSON.
                for (const k of ['message', 'summary', 'note', 'title', 'detail', 'reason']) {
                    if (typeof p[k] === 'string' && p[k]) return clip(p[k], 140);
                }
                return clip(JSON.stringify(p), 140);
            }
        }
    }
    function summariseArgs(a) {
        if (a == null) return '';
        const s = (typeof a === 'string') ? a : JSON.stringify(a);
        return s.length > 60 ? (s.slice(0, 57) + '…') : s;
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
                isHistorical = false;
                state.run      = msg.run || null;
                state.settings = msg.settings || null;
                state.roles    = Array.isArray(msg.roles) ? msg.roles : [];
                state.events   = Array.isArray(msg.recentEvents) ? msg.recentEvents.slice() : [];
                if (msg.iconBase) state.iconBase = String(msg.iconBase);
                if (msg.prompts)  state.prompts  = msg.prompts;
                // Seed the Now strip from the last known status.
                for (let i = state.events.length - 1; i >= 0; i--) {
                    if (state.events[i].type === 'fairy.status') { state.lastStatus = state.events[i].payload || null; break; }
                }
                render();
                // Run just ended (or none active): refresh the recent-runs list
                // so the finished run shows up on the idle dashboard.
                if (!(state.run && isActiveState(state.run.state))) {
                    vscode.postMessage({ command: FROM.LIST_HISTORICAL_RUNS });
                }
                // Panel opened with nothing live to show → bring up the most
                // recent past run so the Inspector is useful between runs.
                if (!autoLoadedLatest && !state.events.length
                    && !(state.run && isActiveState(state.run.state))) {
                    autoLoadedLatest = true;
                    const latest = (state.recentRuns || [])[0];
                    if (latest) _openHistorical(latest.runId);
                }
                break;
            case TO.EVENT_APPEND:
                if (!isHistorical && msg.event) {
                    const ev = msg.event;
                    // Guard against snapshot/append race: SNAPSHOT_FULL may already contain this event
                    if (ev.eventId && state.events.some(e => e.eventId === ev.eventId)) break;
                    // Keep chronological order even when producers flush late.
                    let at = state.events.length;
                    const ts = ev.ts || '';
                    while (at > 0 && ts && (state.events[at - 1].ts || '') > ts) at--;
                    state.events.splice(at, 0, ev);
                    if (state.events.length > 50000) state.events.splice(0, state.events.length - 50000);
                    if (state.run) {
                        state.run.eventCount = (state.run.eventCount || 0) + 1;
                        if (ev.type === 'llm.call' && ev.payload) {
                            state.run.llmCallCount = (state.run.llmCallCount || 0) + 1;
                            if (typeof ev.payload.costUSD === 'number') {
                                state.run.totalCostUSD = (state.run.totalCostUSD || 0) + ev.payload.costUSD;
                                if (els.topbarCost) els.topbarCost.textContent = `$${state.run.totalCostUSD.toFixed(3)}`;
                            }
                        }
                    }
                    // High-frequency stream events feed the Now strip directly and
                    // never trigger a full timeline re-render.
                    if (ev.type === 'llm.reasoning_progress' || ev.type === 'llm.response_progress') {
                        _feedStream(ev);
                        break;
                    }
                    if (ev.type === 'fairy.status') {
                        state.lastStatus = ev.payload || null;
                        renderNowStrip();
                        scheduleRender();
                        break;
                    }
                    if (ev.type === 'llm.call') _endStream();
                    if (ev.type === 'tool.call' || ev.type === 'correlated.tool'
                        || ev.type === 'probe.appended' || ev.type === 'director.stage_started'
                        || ev.type === 'literature.progress' || ev.type === 'fairy.steer') {
                        _setActivity(oneLineSummary(ev));
                    }
                    scheduleRender();
                }
                break;
            case TO.EVENT_BATCH:
                if (Array.isArray(msg.events)) {
                    // Deduplicate against already-stored events (snapshot/batch race)
                    const existingIds = new Set(state.events.map(e => e.eventId).filter(Boolean));
                    const newEvs = msg.events.filter(e => !e.eventId || !existingIds.has(e.eventId));
                    if (newEvs.length > 0) {
                        state.events.push(...newEvs);
                        if (state.events.length > 50000) state.events.splice(0, state.events.length - 50000);
                        render();
                    }
                }
                break;
            case TO.SETTINGS_SNAPSHOT:
                state.settings = msg.settings || state.settings;
                state.roles    = Array.isArray(msg.roles) ? msg.roles : state.roles;
                render();
                break;
            case 'historicalRun.list': {
                // runs: enriched [{ runId, brief, status, costUSD }] (older builds sent bare ids)
                state.recentRuns = (msg.runs || []).map(r =>
                    typeof r === 'string' ? { runId: r, brief: '', status: '', costUSD: null } : r);
                if (els.runPicker) {
                    const current = els.runPicker.value;
                    Array.from(els.runPicker.options).forEach(o => { if (o.value !== 'live') o.remove(); });
                    state.recentRuns.forEach(r => {
                        const opt = document.createElement('option');
                        // runId looks like "run_2026-05-30T18-15-54-251Z" — pretty-print the date
                        const label = r.runId.replace(/^run_/, '').replace('T', ' ').replace(/-(?=\d{3}Z$)/, '.');
                        opt.value = r.runId;
                        opt.textContent = r.brief ? `${label} — ${r.brief.slice(0, 40)}` : label;
                        els.runPicker.appendChild(opt);
                    });
                    if (current !== 'live' && Array.from(els.runPicker.options).some(o => o.value === current)) {
                        els.runPicker.value = current;
                    }
                }
                renderRecentRuns();
                // If the panel is idle and we haven't shown anything yet, surface
                // the latest run now that we know it exists.
                if (!autoLoadedLatest && !state.events.length
                    && !(state.run && isActiveState(state.run.state)) && state.recentRuns.length) {
                    autoLoadedLatest = true;
                    _openHistorical(state.recentRuns[0].runId);
                }
                break;
            }
            case 'steer.state': {
                state.steerActive = !!msg.active;
                renderNowStrip();
                break;
            }
            case 'steer.queued': {
                if (els.steerAck) {
                    els.steerAck.textContent = 'queued — the agent sees it at its next turn';
                    setTimeout(() => { if (els.steerAck) els.steerAck.textContent = ''; }, 6000);
                }
                break;
            }
            case 'historicalRun.loaded': {
                isHistorical = true;
                state.events = Array.isArray(msg.events) ? msg.events.slice() : [];
                // Synthesise a minimal run summary from events for the overview panel
                const lastConclusion = state.events.slice().reverse().find(e => e.type === 'research.conclusion');
                const lastCircle     = state.events.slice().reverse().find(e => e.type === 'circle.transition');
                const llmEvents      = state.events.filter(e => e.type === 'llm.call');
                const totalCost      = llmEvents.reduce((s, e) => s + ((e.payload && e.payload.costUSD) || 0), 0);
                const totalIn        = llmEvents.reduce((s, e) => s + ((e.payload && e.payload.usage && e.payload.usage.inputTokens) || 0), 0);
                const totalOut       = llmEvents.reduce((s, e) => s + ((e.payload && e.payload.usage && e.payload.usage.outputTokens) || 0), 0);
                state.run = {
                    runId:       msg.runId,
                    state:       lastCircle ? (lastCircle.payload && lastCircle.payload.to) : 'IDLE',
                    startedAt:   state.events.length ? state.events[0].ts : null,
                    questId:     lastConclusion ? (lastConclusion.payload && lastConclusion.payload.questId) : null,
                    eventCount:  state.events.length,
                    llmCallCount: llmEvents.length,
                    totalCostUSD: totalCost,
                    totalUsage:  { inputTokens: totalIn, outputTokens: totalOut, cacheReadTokens: 0, cacheWriteTokens: 0 },
                };
                render();
                break;
            }
        }
    });

    // ── detail drawer ──────────────────────────────────────────────────────
    function openDetail(ev) {
        const p = ev.payload || {};
        els.detailTitle.textContent = `${ev.type}  ·  ${fmtTime(ev.ts)}`;
        els.detailBody.innerHTML = renderDetail(ev);
        els.detailDrawer.hidden = false;
        // highlight selected row
        $$('#eventsBody tr.selected').forEach(r => r.classList.remove('selected'));
        const rows = $$('#eventsBody tr');
        rows.forEach(r => { if (r.dataset.type === ev.type && r.querySelector('td') && r.querySelector('td').textContent === fmtTime(ev.ts)) r.classList.add('selected'); });
    }
    function closeDetail() {
        els.detailDrawer.hidden = true;
        $$('#eventsBody tr.selected').forEach(r => r.classList.remove('selected'));
    }
    function renderDetail(ev) {
        const p = ev.payload || {};
        const parts = [];
        if (ev.type === 'tool.call') {
            parts.push(`<div class="detail-meta">
                <span class="meta-chip">${escapeHtml(p.name || 'tool')}</span>
                <span class="meta-chip">${escapeHtml(p.correlationId || '')}</span>
            </div>`);
            if (p.args != null) {
                const argsStr = typeof p.args === 'string' ? p.args : JSON.stringify(p.args, null, 2);
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">\uD83D\uDCE4 Arguments</div>
                    <pre class="detail-pre">${escapeHtml(argsStr)}</pre>
                </div>`);
            }
        } else if (ev.type === 'correlated.tool') {
            parts.push(`<div class="detail-meta">
                <span class="meta-chip">${escapeHtml(p.name || 'tool')}</span>
                <span class="meta-chip">${p.ok ? '\u2713 ok' : '\u2717 ' + escapeHtml(p.kind || 'error')}</span>
                ${typeof p.durationMs === 'number' ? `<span class="meta-chip">${p.durationMs}ms</span>` : ''}
                ${p.error ? `<span class="meta-chip" style="color:var(--acc-red)">${escapeHtml(String(p.error).slice(0, 120))}</span>` : ''}
            </div>`);
            if (p.value != null) {
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">\uD83D\uDCCB Mathematica Result${p.truncated ? ' <span style="opacity:.5;font-size:10px">(truncated)</span>' : ''}</div>
                    <pre class="detail-pre response-pre">${escapeHtml(String(p.value))}</pre>
                </div>`);
            } else if (!p.ok) {
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">\u26A0\uFE0F Error</div>
                    <pre class="detail-pre">${escapeHtml(p.summary || p.error || String(p.kind || ''))}</pre>
                </div>`);
            }
            if (p.prints) {
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">\uD83D\uDDA8 Print Output</div>
                    <pre class="detail-pre">${escapeHtml(String(p.prints))}</pre>
                </div>`);
            }
            if (p.messages) {
                const msgStr = Array.isArray(p.messages) ? p.messages.join('\n') : String(p.messages);
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">\u2139\uFE0F WL Messages</div>
                    <pre class="detail-pre">${escapeHtml(msgStr)}</pre>
                </div>`);
            }
        } else if (ev.type === 'research.conclusion') {
            const conf = typeof p.confidence === 'number' ? p.confidence.toFixed(2) : '?';
            parts.push(`<div class="detail-meta">
                <span class="meta-chip">conf ${conf}</span>
                <span class="meta-chip">${typeof p.findingsCount === 'number' ? p.findingsCount : '?'} findings</span>
                ${typeof p.evidenceCount === 'number' ? `<span class="meta-chip">${p.evidenceCount} evidence</span>` : ''}
            </div>`);
            if (p.summary) {
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">Summary</div>
                    <pre class="detail-pre response-pre">${escapeHtml(p.summary)}</pre>
                </div>`);
            }
            if (Array.isArray(p.findings) && p.findings.length > 0) {
                const fRows = p.findings.map(f =>
                    `<tr><td style="opacity:.5;font-size:10px;white-space:nowrap">${typeof f.confidence === 'number' ? f.confidence.toFixed(2) : ''}</td><td>${escapeHtml(f.claim || '')}</td></tr>`
                ).join('');
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">Findings</div>
                    <table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>${fRows}</tbody></table>
                </div>`);
            }
            if (Array.isArray(p.openQuestions) && p.openQuestions.length > 0) {
                const qHtml = p.openQuestions.map(q => `<div style="padding:2px 0">${escapeHtml(String(q))}</div>`).join('');
                parts.push(`<div class="detail-section">
                    <div class="detail-section-title">Open Questions</div>
                    <div style="font-size:12px">${qHtml}</div>
                </div>`);
            }
        } else if (ev.type === 'llm.call') {
            return _renderLlmCallDetail(ev);
        } else {
            // Generic: pretty JSON of payload
            parts.push(`<div class="detail-section">
                <div class="detail-section-title">Payload</div>
                <pre class="detail-pre">${escapeHtml(JSON.stringify(p, null, 2))}</pre>
            </div>`);
        }
        return parts.join('');
    }

    /**
     * Typed detail for `llm.call`: tabs for Prompt, Response, Reasoning,
     * Usage & Cost, Raw JSON.  All sections are individually copyable.
     */
    function _renderLlmCallDetail(ev) {
        const p = ev.payload || {};
        const u = p.usage || {};
        const meta = `<div class="detail-meta">
            <span class="meta-chip">${escapeHtml(p.provider || '')} · ${escapeHtml(p.model || '')}</span>
            <span class="meta-chip">${escapeHtml(p.role || '')}</span>
            ${typeof p.latencyMs === 'number' ? `<span class="meta-chip">${(p.latencyMs/1000).toFixed(2)}s</span>` : ''}
            ${typeof p.costUSD   === 'number' ? `<span class="meta-chip cost">$${p.costUSD.toFixed(4)}</span>` : ''}
            ${u.inputTokens  != null ? `<span class="meta-chip">in ${human(u.inputTokens)}</span>` : ''}
            ${u.outputTokens != null ? `<span class="meta-chip">out ${human(u.outputTokens)}</span>` : ''}
            ${u.cacheReadTokens  ? `<span class="meta-chip">cache R ${human(u.cacheReadTokens)}</span>` : ''}
            ${u.cacheWriteTokens ? `<span class="meta-chip">cache W ${human(u.cacheWriteTokens)}</span>` : ''}
            ${p.stopReason ? `<span class="meta-chip">stop: ${escapeHtml(p.stopReason)}</span>` : ''}
        </div>`;

        const hasPrompt    = Array.isArray(p.promptMessages) && p.promptMessages.length;
        const hasResponse  = p.responseText != null && String(p.responseText).length > 0;
        const hasReasoning = !!p.reasoning;

        const tabs = [
            { id: 'prompt',    label: 'Prompt',       enabled: !!hasPrompt },
            { id: 'response',  label: 'Response',     enabled: !!hasResponse },
            { id: 'reasoning', label: 'Reasoning',    enabled: !!hasReasoning },
            { id: 'usage',     label: 'Usage & Cost', enabled: true },
            { id: 'raw',       label: 'Raw JSON',     enabled: true },
        ];
        const firstEnabled = (tabs.find(t => t.enabled) || { id: 'usage' }).id;

        const tabBar = `<div class="llm-tabs" role="tablist">
            ${tabs.map(t => `<button class="llm-tab${t.id === firstEnabled ? ' active' : ''}" data-tab="${t.id}" ${t.enabled ? '' : 'disabled'}>${escapeHtml(t.label)}</button>`).join('')}
        </div>`;

        const promptText = hasPrompt
            ? p.promptMessages.map(m => `[${m.role}]\n${m.content || ''}`).join('\n\n────────\n\n')
            : '';
        const promptPane = `<div class="llm-pane${firstEnabled === 'prompt' ? ' active' : ''}" data-pane="prompt">
            ${hasPrompt ? `<div class="copy-row">
                <button class="copy-btn" data-copy-text="${escapeAttr(promptText)}" title="Copy full prompt to clipboard">⧉ Copy prompt</button>
            </div>
            ${p.promptMessages.map(m => `<div class="chat-msg chat-msg--${escapeHtml(m.role)}">
                <div class="chat-msg__role">${escapeHtml(m.role)} <button class="copy-btn copy-btn--mini" data-copy-text="${escapeAttr(String(m.content || ''))}">⧉</button></div>
                <pre class="chat-msg__body">${escapeHtml(String(m.content || ''))}</pre>
            </div>`).join('')}` : `<p class="muted small">No prompt messages were captured for this call. Enable <code>wolfbook.oberon.telemetry.saveRawPrompts</code> in settings.</p>`}
        </div>`;

        const responsePane = `<div class="llm-pane${firstEnabled === 'response' ? ' active' : ''}" data-pane="response">
            ${hasResponse ? `<div class="copy-row">
                <button class="copy-btn" data-copy-text="${escapeAttr(String(p.responseText))}">⧉ Copy response</button>
            </div>
            <pre class="detail-pre response-pre">${escapeHtml(String(p.responseText))}</pre>` : `<p class="muted small">No response text captured. Enable <code>wolfbook.oberon.telemetry.saveRawResponses</code> in settings.</p>`}
        </div>`;

        const reasoningPane = `<div class="llm-pane${firstEnabled === 'reasoning' ? ' active' : ''}" data-pane="reasoning">
            ${hasReasoning ? `<div class="copy-row">
                <button class="copy-btn" data-copy-text="${escapeAttr(String(p.reasoning))}">⧉ Copy reasoning</button>
            </div>
            <pre class="detail-pre reasoning-pre">${escapeHtml(String(p.reasoning))}</pre>` : `<p class="muted small">No reasoning trace recorded for this call (model did not emit reasoning chunks).</p>`}
        </div>`;

        const usagePane = `<div class="llm-pane${firstEnabled === 'usage' ? ' active' : ''}" data-pane="usage">
            <table class="usage-table">
                <tbody>
                    <tr><th>Provider</th><td>${escapeHtml(p.provider || '—')}</td></tr>
                    <tr><th>Model</th><td>${escapeHtml(p.model || '—')}</td></tr>
                    <tr><th>Role</th><td>${escapeHtml(p.role || '—')}</td></tr>
                    <tr><th>Latency</th><td>${typeof p.latencyMs === 'number' ? (p.latencyMs/1000).toFixed(3) + ' s' : '—'}</td></tr>
                    <tr><th>Cost (USD)</th><td>${typeof p.costUSD === 'number' ? '$' + p.costUSD.toFixed(6) : '—'}</td></tr>
                    <tr><th>Input tokens</th><td>${u.inputTokens != null ? human(u.inputTokens) + ' (' + u.inputTokens + ')' : '—'}</td></tr>
                    <tr><th>Output tokens</th><td>${u.outputTokens != null ? human(u.outputTokens) + ' (' + u.outputTokens + ')' : '—'}</td></tr>
                    <tr><th>Cache read</th><td>${u.cacheReadTokens != null ? human(u.cacheReadTokens) + ' (' + u.cacheReadTokens + ')' : '<span class="muted">n/a</span>'}</td></tr>
                    <tr><th>Cache write</th><td>${u.cacheWriteTokens != null ? human(u.cacheWriteTokens) + ' (' + u.cacheWriteTokens + ')' : '<span class="muted">n/a</span>'}</td></tr>
                    <tr><th>Stop reason</th><td>${escapeHtml(p.stopReason || '—')}</td></tr>
                    <tr><th>Span</th><td><code>${escapeHtml(ev.spanId || '—')}</code></td></tr>
                    <tr><th>Charm</th><td><code>${escapeHtml(ev.charmId || '—')}</code></td></tr>
                    <tr><th>Quest</th><td><code>${escapeHtml(ev.questId || '—')}</code></td></tr>
                </tbody>
            </table>
        </div>`;

        const rawJson = JSON.stringify(ev, null, 2);
        const rawPane = `<div class="llm-pane${firstEnabled === 'raw' ? ' active' : ''}" data-pane="raw">
            <div class="copy-row">
                <button class="copy-btn" data-copy-text="${escapeAttr(rawJson)}">⧉ Copy raw event JSON</button>
            </div>
            <pre class="detail-pre">${escapeHtml(rawJson)}</pre>
        </div>`;

        return meta + tabBar + promptPane + responsePane + reasoningPane + usagePane + rawPane;
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Tab + copy delegation inside the drawer
    els.detailBody.addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        const tab = t.closest('.llm-tab');
        if (tab && !tab.disabled) {
            const id = tab.dataset.tab;
            $$('#detailBody .llm-tab').forEach(b => b.classList.toggle('active', b === tab));
            $$('#detailBody .llm-pane').forEach(pn => pn.classList.toggle('active', pn.dataset.pane === id));
            return;
        }
        const cp = t.closest('.copy-btn');
        if (cp) {
            const text = cp.getAttribute('data-copy-text') || '';
            try {
                navigator.clipboard.writeText(text);
                const orig = cp.textContent;
                cp.textContent = '✓ copied';
                setTimeout(() => { cp.textContent = orig; }, 1100);
            } catch (_) {}
        }
    });

    els.detailClose.addEventListener('click', closeDetail);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

    // Table row click → open detail
    els.eventsBody.addEventListener('click', (e) => {
        const row = e.target instanceof Element ? e.target.closest('tr[data-idx]') : null;
        if (!row) return;
        const idx = parseInt(row.dataset.idx, 10);
        const viewedEvents = state._viewedEvents || [];
        const ev = viewedEvents[idx];
        if (ev) openDetail(ev);
    });

    // ── outbound ───────────────────────────────────────────────────────────
    document.body.addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        const btn = t.closest('button[data-cmd]');
        if (!btn) return;
        const cmd = btn.dataset.cmd;
        if (cmd === 'abortRun')           return vscode.postMessage({ command: FROM.ABORT_RUN });
        if (cmd === 'openSettings')       return vscode.postMessage({ command: FROM.OPEN_SETTINGS });
        if (cmd === 'configureProviders') return vscode.postMessage({ command: FROM.CONFIGURE_PROVIDERS });
        if (cmd === 'emitMockEvents')     return vscode.postMessage({ command: FROM.EMIT_MOCK_EVENTS });
        if (cmd === 'openFile') {
            const target = btn.dataset.target || '';
            if (target) {
                vscode.postMessage({ command: 'openFile', path: target });
            }
            return;
        }
    });

    if (els.runPicker) {
        els.runPicker.addEventListener('change', () => {
            const v = els.runPicker.value;
            if (v === 'live') {
                isHistorical = false;
                state.events = [];
                vscode.postMessage({ command: FROM.SCRIPT_LOADED }); // request fresh live snapshot
            } else {
                state.events = [];
                render();
                vscode.postMessage({ command: FROM.LOAD_HISTORICAL_RUN, runId: v });
            }
        });
    }

    els.filterText.addEventListener('input',  () => { state.filter.text = els.filterText.value; renderEvents(); });
    els.filterType.addEventListener('change', () => { state.filter.type = els.filterType.value; renderEvents(); });

    // View-mode toggle (Structured / Raw)
    document.querySelectorAll('.view-toggle__btn').forEach(b => {
        b.addEventListener('click', () => {
            const v = b.dataset.view;
            if (state.viewMode === v) return;
            state.viewMode = v;
            document.querySelectorAll('.view-toggle__btn').forEach(x => x.classList.toggle('active', x === b));
            renderEvents();
        });
    });

    // ── launcher (idle dashboard) ──────────────────────────────────────────
    function _launch(command) {
        const brief = els.launchBrief ? els.launchBrief.value.trim() : '';
        if (!brief) { if (els.launchBrief) els.launchBrief.focus(); return; }
        vscode.postMessage({ command, brief });
        if (els.launchBrief) els.launchBrief.value = '';
    }
    const _lf = $('launchFairy'), _ld = $('launchDirector'), _lr = $('launchResearch');
    if (_lf) _lf.addEventListener('click', () => _launch('startFairy'));
    if (_ld) _ld.addEventListener('click', () => _launch('startDirector'));
    if (_lr) _lr.addEventListener('click', () => _launch(FROM.START_RESEARCH));
    if (els.launchBrief) els.launchBrief.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) _launch('startFairy');
    });

    // ── steering ───────────────────────────────────────────────────────────
    function _sendSteer() {
        if (!els.steerInput) return;
        const text = els.steerInput.value.trim();
        if (!text || !state.steerActive) return;
        vscode.postMessage({ command: 'submitSteer', text });
        els.steerInput.value = '';
    }
    if (els.steerBtn)   els.steerBtn.addEventListener('click', _sendSteer);
    if (els.steerInput) els.steerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendSteer(); }
    });

    // ── live stream expand/collapse ────────────────────────────────────────
    if (els.nowToggle) els.nowToggle.addEventListener('click', () => {
        const collapsed = els.nowStream.classList.toggle('collapsed');
        els.nowToggle.textContent = collapsed ? '▸' : '▾';
    });

    vscode.postMessage({ command: FROM.SCRIPT_LOADED });
    vscode.postMessage({ command: FROM.LIST_HISTORICAL_RUNS });
})();
