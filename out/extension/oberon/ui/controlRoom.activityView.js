/* Oberon — Control Room Activity view model & renderer.
 *
 * Replaces the legacy "append every raw event as a top-level row" UI with a
 * curated GitHub-Copilot-style phase-based activity log.
 *
 * Top-level structure produced by buildActivityViewModel(events):
 *
 *   Run summary (header)
 *     ↳ Phase: Planning
 *     ↳ Phase: Charm C01 (Fairy work) — one section per Charm
 *         ↳ Attempt 1
 *             ↳ Step cards (grouped LLM + tool runs)
 *         ↳ Attempt 2  (after schema_repair / rerun / dispute)
 *     ↳ Phase: Critic review (per Charm)
 *     ↳ Phase: Verdict — final reconciled outcome (older verdicts in history)
 *     ↳ Phase: Conclusion / Findings
 *     ↳ Phase: Artefacts
 *
 * Raw LLM/tool/omen events are *not* shown at the top level; they are bundled
 * inside expandable step details. Reasoning is collapsed by default.
 *
 * Exposes a global `OberonActivityView` with two entry points so the renderer
 * can be replaced or stubbed for tests:
 *   - build(events)      → view model object
 *   - render(root, vm, ctx) → mutates DOM under `root`
 *
 * ctx = { iconBase, escapeHtml, human, tips, onCommand }
 *   - escapeHtml / human are passed in by the host page so we don't duplicate.
 *   - tips is the TIPS lookup table; we apply tooltips after render.
 */
(function (global) {
    'use strict';

    // ── Event taxonomy ────────────────────────────────────────────────────
    // Events that end the current "step" — the next event starts a new step.
    const STEP_BOUNDARY = new Set([
        'scroll.submitted',
        'omen',                 // includes schema_repair
        'budget.exhausted',
        'skeptic.verdict',
        'oberon.verdict',
        'oberon.decision',
        'research.conclusion',
        'charm.dispatched',
        'fairy.started',
    ]);

    // Events that begin a new ATTEMPT for the current Charm.
    function isNewAttemptBoundary(ev) {
        if (!ev) return false;
        const p = ev.payload || {};
        if (ev.type === 'omen' && /schema[_ ]?repair|rerun|fixup|fix[-_ ]?up|revision/i.test(String(p.kind || p.message || ''))) return true;
        if (ev.type === 'skeptic.verdict' && p.verdict === 'dispute') return true;
        if (ev.type === 'revision.started') return true;
        if (ev.type === 'rerun.started')    return true;
        if (ev.type === 'agent.rerun.started') return true;
        return false;
    }

    // ── helpers ────────────────────────────────────────────────────────────
    // Telemetry bus stores questId / charmId at the TOP LEVEL of the event
    // (see telemetry/bus.js: ev.charmId, ev.questId). Older code paths used to
    // duplicate them into payload, so check all three locations.
    function getQid(ev) { const p = ev.payload || {}, m = ev.meta || {}; return ev.questId || p.questId || m.questId || null; }
    function getCid(ev) { const p = ev.payload || {}, m = ev.meta || {}; return ev.charmId || p.charmId || m.charmId || null; }
    function getRole(ev) { return (ev.payload && ev.payload.role) || ''; }

    function summariseTool(p) {
        const name = (p && p.name || 'tool').replace(/^wolfbook_/, '');
        const args = (p && p.args) || {};
        // Best-effort one-line summary per known tool.
        let detail = '';
        if (typeof args.expression === 'string') {
            detail = args.expression.replace(/\s+/g, ' ').slice(0, 80);
        } else if (typeof args.code === 'string') {
            detail = args.code.replace(/\s+/g, ' ').slice(0, 80);
        } else if (typeof args.cellId === 'string') {
            detail = `cell ${args.cellId.slice(0, 16)}`;
        } else if (typeof args.path === 'string') {
            detail = args.path;
        } else if (typeof args.query === 'string') {
            detail = args.query.slice(0, 80);
        } else if (typeof args.symbol === 'string') {
            detail = args.symbol;
        }
        // result preview if available
        let resultPreview = '';
        if (p && p.resultPreview) resultPreview = String(p.resultPreview).replace(/\s+/g, ' ').slice(0, 60);
        else if (p && p.value)    resultPreview = String(p.value).replace(/\s+/g, ' ').slice(0, 60);
        if (detail && resultPreview) return `${name}: ${detail} → ${resultPreview}`;
        if (detail)                 return `${name}: ${detail}`;
        if (resultPreview)          return `${name} → ${resultPreview}`;
        return name;
    }

    function summariseLlmReasoning(p) {
        const r = String((p && p.reasoning) || '').trim();
        if (!r) return '';
        // Take the first non-trivial sentence (up to 140 chars).
        const firstLine = r.split(/\n+/).map(s => s.trim()).find(s => s.length > 15) || r;
        return firstLine.replace(/\s+/g, ' ').slice(0, 140);
    }

    // ── Step inference ────────────────────────────────────────────────────
    function inferStepLabel(step) {
        // Prefer the first tool call's summary, else the LLM reasoning teaser,
        // else a generic action.
        const toolEvs = step.events.filter(e => e.type === 'tool.call' || e.type === 'correlated.tool' || e.type === 'spell.exec');
        if (toolEvs.length === 1) return summariseTool(toolEvs[0].payload || {});
        if (toolEvs.length > 1) {
            const names = [...new Set(toolEvs.map(e => (e.payload && e.payload.name || '').replace(/^wolfbook_/, '')))].filter(Boolean);
            const first = summariseTool(toolEvs[0].payload || {});
            return names.length === 1 ? first : `${names.join(', ')} (${toolEvs.length} calls)`;
        }
        const llm = step.events.find(e => e.type === 'llm.call' && e.payload && e.payload.reasoning);
        if (llm) {
            const r = summariseLlmReasoning(llm.payload);
            if (r) return r;
        }
        const boundary = step.events.find(e => STEP_BOUNDARY.has(e.type));
        if (boundary) {
            if (boundary.type === 'scroll.submitted') return 'Submitted Scroll ' + ((boundary.payload && boundary.payload.scrollId) || '');
            if (boundary.type === 'omen') {
                const k = (boundary.payload && boundary.payload.kind) || 'omen';
                return /schema/i.test(k) ? 'Schema repair (Fairy output rejected — retrying)' : `Omen: ${k}`;
            }
            return boundary.type;
        }
        return 'Working…';
    }

    function stepStatus(step) {
        // Determine status from contained events.
        const evs = step.events;
        if (evs.some(e => e.type === 'omen' && /schema/i.test(String((e.payload && e.payload.kind) || '')))) return 'warning';
        if (evs.some(e => e.type === 'budget.exhausted')) return 'warning';
        if (evs.some(e => e.type === 'correlated.tool' && e.payload && e.payload.ok === false)) return 'failed';
        if (evs.some(e => e.type === 'scroll.submitted')) return 'done';
        return 'done';  // default — caller may overwrite "current" to running
    }

    function stepChips(step) {
        let llmCount = 0, toolCount = 0, cost = 0;
        for (const e of step.events) {
            if (e.type === 'llm.call') {
                llmCount += 1;
                if (typeof e.payload.costUSD === 'number') cost += e.payload.costUSD;
            } else if (e.type === 'tool.call' || e.type === 'correlated.tool' || e.type === 'spell.exec') {
                toolCount += 1;
            }
        }
        return { llm: llmCount, tools: toolCount, cost };
    }

    // ── Build view-model ──────────────────────────────────────────────────
    function buildActivityViewModel(events) {
        events = Array.isArray(events) ? events : [];
        const vm = {
            phases: [],
            stats: { llmCalls: 0, toolCalls: 0, costUSD: 0, omens: 0, attempts: 0, charmCount: 0 },
            runFinal: null,
            runState: null,
        };

        // Tally global stats up-front.
        for (const e of events) {
            if (e.type === 'llm.call') {
                vm.stats.llmCalls += 1;
                const c = e.payload && e.payload.costUSD;
                if (typeof c === 'number') vm.stats.costUSD += c;
            } else if (e.type === 'tool.call' || e.type === 'correlated.tool' || e.type === 'spell.exec') {
                vm.stats.toolCalls += 1;
            } else if (e.type === 'omen' || e.type === 'budget.exhausted') {
                vm.stats.omens += 1;
            } else if (e.type === 'circle.transition') {
                if (e.payload && e.payload.to) vm.runState = e.payload.to;
            }
        }

        // Walk events; assign each to a phase bucket.
        const phasesByKey = new Map();
        function getPhase(key, init) {
            if (phasesByKey.has(key)) return phasesByKey.get(key);
            const ph = Object.assign({ key, events: [] }, init);
            phasesByKey.set(key, ph);
            vm.phases.push(ph);
            return ph;
        }

        // Per-Charm state: { phaseRef, attempts: [{events:[], steps:[], label, status}], currentAttempt, currentStep }
        const charmState = new Map();

        // Pre-pass: extract Charm titles from charm.dispatched events.
        const charmTitle = new Map();
        for (const e of events) {
            if (e.type === 'charm.dispatched') {
                const cid = e.payload && e.payload.charmId;
                if (cid) charmTitle.set(cid, e.payload.title || '');
            }
        }
        // Pre-pass: collect verdict history (chronological).
        const allVerdicts = events.filter(e => e.type === 'oberon.verdict').map(e => e.payload || {});
        const allConclusions = events.filter(e => e.type === 'research.conclusion').map(e => e.payload || {});

        // Pre-pass: latest in-flight LLM stream preview per role.
        // If a `llm.call` for a role appears AFTER the latest progress event,
        // the call has completed and we suppress the preview.
        const livePreview = {}; // role -> { kind:'reasoning'|'content', text, charmId, ts }
        const lastCallTsByRole = {};
        for (const e of events) {
            const role = (e.payload && e.payload.role) || '';
            if (e.type === 'llm.call' && role) {
                lastCallTsByRole[role] = e.ts || '';
            } else if ((e.type === 'llm.reasoning_progress' || e.type === 'llm.response_progress') && role) {
                livePreview[role] = {
                    kind: e.type === 'llm.reasoning_progress' ? 'reasoning' : 'content',
                    text: (e.payload && e.payload.preview) || '',
                    charmId: (e.payload && e.payload.charmId) || null,
                    ts: e.ts || '',
                    role,
                };
            }
        }
        // Drop previews whose call already completed.
        for (const role of Object.keys(livePreview)) {
            const lastCall = lastCallTsByRole[role];
            if (lastCall && lastCall >= livePreview[role].ts) delete livePreview[role];
        }
        vm.livePreview = livePreview;

        function ensureCharm(cid, qid) {
            if (charmState.has(cid)) return charmState.get(cid);
            const phase = getPhase(`charm:${cid}`, {
                kind: 'charm',
                charmId: cid,
                questId: qid,
                title: charmTitle.get(cid) || '',
                attempts: [],
                status: 'running',
            });
            const st = {
                phase,
                attempts: phase.attempts,
                currentAttempt: null,
                currentStep: null,
            };
            charmState.set(cid, st);
            vm.stats.charmCount += 1;
            startNewAttempt(st);
            return st;
        }

        function startNewAttempt(st) {
            const idx = st.attempts.length + 1;
            const att = {
                attemptId: `A${idx}`,
                label: idx === 1 ? 'Attempt 1' : `Attempt ${idx} (retry)`,
                status: 'running',
                steps: [],
                events: [],
            };
            st.attempts.push(att);
            st.currentAttempt = att;
            st.currentStep = null;
            vm.stats.attempts += 1;
            return att;
        }

        function startNewStep(st) {
            if (!st.currentAttempt) startNewAttempt(st);
            const step = { events: [] };
            st.currentAttempt.steps.push(step);
            st.currentStep = step;
            return step;
        }

        // Walk events.
        for (const e of events) {
            const qid = getQid(e);
            const cid = getCid(e);

            // ── Planning phase (until first charm.dispatched).
            if (e.type === 'circle.transition' && e.payload && e.payload.to === 'BRIEFING') {
                getPhase('planning', { kind: 'planning', status: 'running', label: 'Planning quest' }).events.push(e);
                continue;
            }
            if (e.type === 'quest.accepted') {
                const ph = getPhase('planning', { kind: 'planning', status: 'done', label: 'Quest planned' });
                ph.status = 'done';
                ph.questId = e.payload && e.payload.questId;
                ph.questTitle = e.payload && e.payload.title;
                ph.questObjective = (e.payload && (e.payload.description || e.payload.brief)) || '';
                ph.events.push(e);
                continue;
            }
            if (e.type === 'charm.dispatched' && cid) {
                ensureCharm(cid, qid);
                continue;
            }

            // ── Per-Charm event routing.
            if (cid) {
                const st = ensureCharm(cid, qid);
                const role = getRole(e);

                // Critic-level events live in a dedicated phase, but linked to the Charm.
                // This covers BOTH explicit skeptic/ward events AND any LLM/tool call
                // emitted by the critic or skeptic roles (their llm.call events would
                // otherwise sink into the active Fairy attempt and look like Fairy work).
                const isCriticRole = role === 'critic' || role === 'skeptic';
                const isCriticEvent =
                    e.type === 'skeptic.verdict' || e.type === 'ward.requested' || e.type === 'ward.result' ||
                    e.type === 'critic.kernel_restart' ||
                    (isCriticRole && (e.type === 'llm.call' || e.type === 'tool.call' ||
                                      e.type === 'correlated.tool' || e.type === 'llm.reasoning_progress' ||
                                      e.type === 'llm.response_progress'));
                if (isCriticEvent) {
                    const ph = getPhase(`critic:${cid}`, {
                        kind: 'critic',
                        charmId: cid,
                        questId: qid,
                        items: [],
                        status: 'running',
                    });
                    ph.events.push(e);
                    if (e.type === 'skeptic.verdict') {
                        ph.items.push({
                            verdict: e.payload.verdict,
                            matched: (e.payload.summary && e.payload.summary.matched) || 0,
                            total:   (e.payload.summary && e.payload.summary.total) || 0,
                            failed:  (e.payload.summary && e.payload.summary.failed) || 0,
                            skipped: (e.payload.summary && e.payload.summary.skipped) || 0,
                            objections: e.payload.objections || [],
                        });
                        ph.status = e.payload.verdict === 'accept' ? 'done'
                                  : e.payload.verdict === 'dispute' ? 'disputed'
                                  : 'inconclusive';
                    }
                    // A dispute opens a new attempt on this charm.
                    if (isNewAttemptBoundary(e)) startNewAttempt(st);
                    continue;
                }

                // Step-bounded routing for Fairy work.
                if (!st.currentStep) startNewStep(st);

                if (isNewAttemptBoundary(e)) {
                    // close current step, open a new attempt
                    if (st.currentStep && e.type === 'omen') {
                        // attach the omen to the *closing* step so it shows the trigger
                        st.currentStep.events.push(e);
                        st.currentAttempt.events.push(e);
                    }
                    startNewAttempt(st);
                    continue;
                }

                st.currentStep.events.push(e);
                st.currentAttempt.events.push(e);

                if (STEP_BOUNDARY.has(e.type)) {
                    // Close the step after a boundary; next event opens a new one.
                    st.currentStep = null;
                }
                continue;
            }

            // ── Run-level events (no charm context).
            if (e.type === 'oberon.verdict' || e.type === 'research.conclusion' ||
                e.type === 'grimoire.updated' || e.type === 'postmortem.written' ||
                e.type === 'oberon.decision') {
                // collected below from allVerdicts/allConclusions; skip here
                continue;
            }
            if (e.type === 'omen' || e.type === 'budget.exhausted') {
                // Orphan omen: attach to a generic "events" bucket.
                getPhase('omens', { kind: 'omens', label: 'Warnings', status: 'warning', items: [] })
                    .events.push(e);
                continue;
            }
            if (e.type === 'llm.call' || e.type === 'tool.call' || e.type === 'correlated.tool' || e.type === 'spell.exec') {
                // Orphan tool/LLM with no charm — usually the planner or executive call,
                // bucket them under planning.
                const role = getRole(e);
                const phKey = role === 'oberon' || role === 'executive' || role === 'planner' ? 'planning' : 'misc';
                const ph = getPhase(phKey, { kind: phKey === 'planning' ? 'planning' : 'misc', label: phKey === 'planning' ? 'Planning' : 'Other activity', status: 'done', events: [] });
                ph.events.push(e);
                continue;
            }
        }

        // Finalise per-step labels / status / chips.
        for (const ph of vm.phases) {
            if (ph.kind !== 'charm') continue;
            for (const att of ph.attempts) {
                for (const step of att.steps) {
                    step.label  = inferStepLabel(step);
                    step.status = stepStatus(step);
                    step.chips  = stepChips(step);
                }
                // attempt status = worst of its steps + closing boundary
                const last = att.events[att.events.length - 1];
                if (last && last.type === 'scroll.submitted') att.status = 'done';
                else if (att.steps.some(s => s.status === 'failed')) att.status = 'failed';
                else if (att.steps.some(s => s.status === 'warning')) att.status = 'warning';
                else if (att.events.length === 0) att.status = 'skipped';
                else att.status = 'done';
            }
            // charm status — from last attempt + downstream critic & verdict (resolved later)
            const lastAtt = ph.attempts[ph.attempts.length - 1];
            ph.status = lastAtt ? lastAtt.status : 'skipped';
        }

        // ── Verdict reconciliation.
        if (allVerdicts.length > 0) {
            const finalV = allVerdicts[allVerdicts.length - 1];
            const history = allVerdicts.slice(0, -1);
            getPhase('verdict', {
                kind: 'verdict',
                status: finalV.verdict === 'success' ? 'done'
                      : finalV.verdict === 'partial_success' ? 'warning'
                      : finalV.verdict === 'failed' ? 'failed'
                      : 'inconclusive',
                finalVerdict: finalV,
                history,
            });
        }
        if (allConclusions.length > 0) {
            const finalC = allConclusions[allConclusions.length - 1];
            getPhase('conclusion', { kind: 'conclusion', status: 'done', finalConclusion: finalC });
        }

        // Apply charm completion status from the matching verdict (so badge is reconciled).
        if (allVerdicts.length) {
            const lastV = allVerdicts[allVerdicts.length - 1];
            // best-effort: if verdict mentions charmId, propagate; else apply to all charms
            for (const ph of vm.phases) {
                if (ph.kind !== 'charm') continue;
                const verdict = lastV.verdict;
                ph.finalVerdict = verdict;
                if (verdict === 'success')             ph.status = 'done';
                else if (verdict === 'partial_success') ph.status = 'warning';
                else if (verdict === 'failed')          ph.status = 'failed';
                else                                    ph.status = 'inconclusive';
            }
        }

        // Attach live previews to their phases.
        const plannerPv = vm.livePreview.oberon || vm.livePreview.planner;
        if (plannerPv) {
            const ph = getPhase('planning', { kind: 'planning', status: 'running', label: 'Planning' });
            ph.livePreview = plannerPv;
            if (!ph.questId) ph.status = 'running';
        }
        for (const role of ['fairy', 'executive', 'critic', 'skeptic', 'postmortem']) {
            const pv = vm.livePreview[role];
            if (!pv) continue;
            if (pv.charmId && charmState.has(pv.charmId)) {
                charmState.get(pv.charmId).phase.livePreview = pv;
            }
        }

        // Sort phases into the desired order.
        const order = { planning: 1, charm: 2, critic: 3, omens: 4, verdict: 5, conclusion: 6, artefacts: 7, misc: 8 };
        vm.phases.sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9));

        return vm;
    }

    // ── Renderer ──────────────────────────────────────────────────────────

    const ICONS = {
        planning: 'Quest.svg',
        charm:    'Charm.svg',
        critic:   'Ward.svg',
        verdict:  'Oberon.svg',
        conclusion: 'Scroll.svg',
        omens:    'Omen.svg',
        misc:     'Circle.svg',
        scroll:   'Scroll.svg',
        tool:     'Spell.svg',
        llm:      'Cost.svg',
        fairy:    'Fairy.svg',
        omen:     'Omen.svg',
    };

    function statusEmoji(s) {
        return ({
            running: '◐',
            done:    '✓',
            warning: '!',
            failed:  '✗',
            disputed: '⚠',
            inconclusive: '?',
            skipped: '–',
            fixed:   '↻',
        })[s] || '•';
    }

    function statusClass(s) { return 'act-status--' + (s || 'done'); }

    // ── Persistent user-toggle state ───────────────────────────────────────────
    // Maps data-key → 'open' | 'closed'. Survives across re-renders. User
    // clicks WIN over auto-open defaults (so once the user collapses a noisy
    // phase it stays collapsed even when new events arrive).
    const _userToggle = new Map();
    function userPref(key) { return _userToggle.get(key); }
    function setUserPref(key, open) { _userToggle.set(key, open ? 'open' : 'closed'); }

    // ── Markdown + KaTeX renderer ──────────────────────────────────────────
    // Lightweight: handles **bold**, *italic*, `code`, paragraph breaks, and
    // $...$ / $$...$$ math via the global `katex` loaded by the host page.
    function renderMd(src) {
        if (src == null) return '';
        let s = String(src);
        // Extract math placeholders first so markdown escaping doesn't touch them.
        const math = [];
        s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
            math.push({ tex, display: true });
            return `\x00MATH${math.length - 1}\x00`;
        });
        s = s.replace(/\$([^\$\n]+?)\$/g, (_, tex) => {
            math.push({ tex, display: false });
            return `\x00MATH${math.length - 1}\x00`;
        });
        // HTML-escape the remainder.
        s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Inline code.
        s = s.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
        // Bold / italic.
        s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');
        // Paragraph breaks: double newlines → <br><br>; single → <br>.
        s = s.replace(/\n\n+/g, '<br><br>').replace(/\n/g, '<br>');
        // Reinsert math via KaTeX.
        s = s.replace(/\x00MATH(\d+)\x00/g, (_, idx) => {
            const m = math[Number(idx)];
            if (typeof globalThis !== 'undefined' && globalThis.katex) {
                try {
                    return globalThis.katex.renderToString(m.tex, {
                        displayMode: m.display,
                        throwOnError: false,
                        strict: 'ignore',
                    });
                } catch (_) { /* fall through */ }
            }
            // Fallback: show as escaped TeX so user can still read it.
            const esc = m.tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return m.display ? `<pre class="act-math-fallback">${esc}</pre>` : `<code>${esc}</code>`;
        });
        return s;
    }

    function render(root, vm, ctx) {
        ctx = ctx || {};
        const esc = ctx.escapeHtml || ((s) => String(s == null ? '' : s));
        const human = ctx.human || ((n) => String(n || 0));
        const iconBase = ctx.iconBase || '';
        const icon = (name) => iconBase && name ? `<img class="t-icon" src="${iconBase}/${name}" alt="" />` : '';

        // Cache scroll & open-state so re-renders preserve UX.
        const scrollEl = root.parentElement || root;
        const prevScroll = scrollEl.scrollTop;
        const wasNearBottom = (scrollEl.scrollHeight - scrollEl.clientHeight - prevScroll) < 80;
        // Snapshot every <details>-open state so it survives any subtree swap.
        root.querySelectorAll('details[data-key]').forEach(d => {
            setUserPref(d.dataset.key, !!d.open);
        });
        const openKeys = new Set();
        for (const [k, v] of _userToggle) if (v === 'open') openKeys.add(k);

        // ── Build header HTML ────────────────────────────────────────────
        let headerHtml = '';
        headerHtml += `<div class="act-run">`;
        headerHtml +=   `<div class="act-run__title">Run activity</div>`;
        headerHtml +=   `<div class="act-run__chips">`;
        headerHtml +=     `<span class="act-chip">${vm.stats.charmCount} charm${vm.stats.charmCount===1?'':'s'}</span>`;
        headerHtml +=     `<span class="act-chip">${vm.stats.llmCalls} LLM</span>`;
        headerHtml +=     `<span class="act-chip">${vm.stats.toolCalls} tools</span>`;
        if (vm.stats.omens) headerHtml += `<span class="act-chip act-chip--warn">${vm.stats.omens} omen${vm.stats.omens===1?'':'s'}</span>`;
        if (vm.stats.attempts > vm.stats.charmCount) headerHtml += `<span class="act-chip act-chip--warn">${vm.stats.attempts} attempts</span>`;
        if (vm.stats.costUSD) headerHtml += `<span class="act-chip act-chip--cost">$${vm.stats.costUSD.toFixed(4)}</span>`;
        headerHtml +=   `</div>`;
        headerHtml += `</div>`;

        // ── Build per-phase HTML (each is a top-level subtree, keyed by ph.key)
        const ctxH = { esc, human, icon, openKeys };
        const phaseHtmls = vm.phases.map(ph => ({
            key:  `ph:${ph.key}`,
            html: renderPhase(ph, ctxH),
        }));

        // ── First-time skeleton ──────────────────────────────────────────
        // Check DOM reality, not just the JS flag — the flag survives if the
        // host page wipes innerHTML (e.g. an error handler or navigation).
        const _headerOk = root.firstElementChild &&
                          root.firstElementChild.classList.contains('act-header-slot');
        const _stepperOk = root.lastElementChild &&
                           root.lastElementChild !== root.firstElementChild &&
                           root.lastElementChild.id === 'actStepper';
        if (!root.__skeletonReady || !_headerOk || !_stepperOk) {
            root.innerHTML = '<div class="act-header-slot"></div><div class="act-stepper" id="actStepper"></div>';
            root.__skeletonReady = true;
            root.__headerHtml    = '';
            root.__phaseHtml     = new Map();
        }
        const headerSlot = root.firstElementChild;
        const stepper    = root.lastElementChild;

        // ── Header diff ──────────────────────────────────────────────────
        if (root.__headerHtml !== headerHtml) {
            headerSlot.innerHTML = headerHtml;
            root.__headerHtml = headerHtml;
        }

        // ── Phase reconciliation (keyed, in-place) ───────────────────────
        // 1. Index existing direct children by data-key.
        const existing = new Map();
        for (const child of stepper.children) {
            const k = child.getAttribute('data-key');
            if (k) existing.set(k, child);
        }

        // 2. Walk the desired list in order; insert/move/replace as needed.
        let cursor = stepper.firstElementChild;
        const cache = root.__phaseHtml;
        const wireSubtree = (node) => {
            if (!node) return;
            node.querySelectorAll('[data-collapse-toggle]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const target = btn.closest('[data-key]');
                    if (!target) return;
                    const open = target.dataset.open !== 'true';
                    target.dataset.open = open ? 'true' : 'false';
                    if (target.dataset.key) setUserPref(target.dataset.key, open);
                });
            });
            node.querySelectorAll('details[data-key]').forEach(d => {
                d.addEventListener('toggle', () => setUserPref(d.dataset.key, d.open));
            });
            if (ctx.wireTooltips) ctx.wireTooltips(node);
        };
        const htmlToElement = (htmlStr) => {
            const tmp = document.createElement('div');
            tmp.innerHTML = htmlStr;
            return tmp.firstElementChild;
        };

        for (const { key, html } of phaseHtmls) {
            let node = existing.get(key);
            const cachedHtml = cache.get(key);
            if (node && cachedHtml === html) {
                // No-op: just ensure correct position.
                if (cursor !== node) stepper.insertBefore(node, cursor);
                cursor = node.nextElementSibling;
                continue;
            }
            if (node) {
                // Same key, content changed → replace just this subtree.
                const newNode = htmlToElement(html);
                node.replaceWith(newNode);
                wireSubtree(newNode);
                cache.set(key, html);
                existing.set(key, newNode);
                cursor = newNode.nextElementSibling;
            } else {
                // New phase → insert at cursor.
                const newNode = htmlToElement(html);
                stepper.insertBefore(newNode, cursor);
                wireSubtree(newNode);
                cache.set(key, html);
                existing.set(key, newNode);
                cursor = newNode.nextElementSibling;
            }
        }

        // 3. Remove obsolete phases.
        const wantedKeys = new Set(phaseHtmls.map(p => p.key));
        for (const [k, node] of existing) {
            if (!wantedKeys.has(k)) {
                node.remove();
                cache.delete(k);
            }
        }

        // ── Restore scroll position ──────────────────────────────────────
        if (wasNearBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
        else scrollEl.scrollTop = prevScroll;
    }

    function renderPhase(ph, h) {
        const key = `ph:${ph.key}`;
        const status = ph.status || 'done';
        // Auto-expand only running steps, warnings, failures, the final verdict, and conclusion;
        // collapse completed successful phases.
        const autoOpen =
            status === 'running' || status === 'warning' || status === 'failed' || status === 'disputed' ||
            ph.kind === 'verdict' || ph.kind === 'conclusion' || ph.kind === 'omens' || ph.kind === 'artefacts' ||
            ph.kind === 'planning';
        // User preference wins over auto-open.
        const pref = userPref(key);
        const open = pref === 'closed' ? false : (pref === 'open' || autoOpen);

        const title = phaseTitle(ph);
        const subtitle = phaseSubtitle(ph);

        let html = `<div class="act-phase ${statusClass(status)}" data-key="${h.esc(key)}" data-open="${open}">`;
        html +=   `<button class="act-phase__hdr" data-collapse-toggle>`;
        html +=     `<span class="act-phase__chev">▸</span>`;
        html +=     `<span class="act-phase__icon">${h.icon(ICONS[ph.kind] || ICONS.misc)}</span>`;
        html +=     `<span class="act-phase__title">${h.esc(title)}</span>`;
        if (subtitle) html += `<span class="act-phase__sub">${h.esc(subtitle)}</span>`;
        html +=     `<span class="act-phase__badge" data-status="${status}">${h.esc(statusLabel(status))}</span>`;
        html +=   `</button>`;
        html +=   `<div class="act-phase__body">${renderPhaseBody(ph, h)}</div>`;
        html += `</div>`;
        return html;
    }

    function statusLabel(s) {
        return ({running:'running',done:'done',warning:'warning',failed:'failed',disputed:'disputed',inconclusive:'inconclusive',skipped:'skipped',fixed:'fixed'})[s] || s || '';
    }

    function phaseTitle(ph) {
        switch (ph.kind) {
            case 'planning':   return ph.questId ? `Planning — ${ph.questId}` : 'Planning';
            case 'charm':      return `Charm ${ph.charmId}${ph.title ? ' — ' + ph.title : ''}`;
            case 'critic':     return `Critic review — Charm ${ph.charmId}`;
            case 'verdict':    return `Final verdict`;
            case 'conclusion': return `Research conclusion`;
            case 'omens':      return `Warnings`;
            case 'misc':       return `Other activity`;
            default:           return ph.kind;
        }
    }
    function phaseSubtitle(ph) {
        if (ph.kind === 'planning' && ph.questTitle) return ph.questTitle.slice(0, 80);
        if (ph.kind === 'charm') {
            const att = ph.attempts.length;
            return att > 1 ? `${att} attempts` : '';
        }
        return '';
    }

    function renderPhaseBody(ph, h) {
        switch (ph.kind) {
            case 'planning':   return renderPlanning(ph, h);
            case 'charm':      return renderCharm(ph, h);
            case 'critic':     return renderCritic(ph, h);
            case 'verdict':    return renderVerdict(ph, h);
            case 'conclusion': return renderConclusion(ph, h);
            case 'omens':      return renderOmens(ph, h);
            case 'misc':       return renderRawEvents(ph.events, h);
            default:           return '';
        }
    }

    function renderPlanning(ph, h) {
        let html = '';
        if (ph.questTitle)     html += `<div class="act-line"><span class="act-k">Quest:</span> ${renderMd(ph.questTitle)}</div>`;
        if (ph.questObjective) html += `<div class="act-line act-line--muted act-md">${renderMd(String(ph.questObjective).slice(0, 600))}</div>`;
        if (ph.livePreview) html += renderLivePreview(ph.livePreview, h);
        if (ph.events.length) {
            html += renderRawDetailsExpander(ph.events, h, 'Planner events');
        }
        return html;
    }

    function renderLivePreview(pv, h) {
        if (!pv || !pv.text) return '';
        const label = pv.kind === 'reasoning' ? 'Reasoning' : 'Generating';
        const text = h.esc('…' + String(pv.text).slice(-400));
        const roleAttr = pv.role ? ` data-role="${h.esc(pv.role)}"` : '';
        return `<div class="act-live"${roleAttr}><span class="act-live__dot"></span><span class="act-live__label">${label}</span><pre class="act-live__text">${text}</pre></div>`;
    }

    function renderCharm(ph, h) {
        let html = '';
        if (ph.livePreview) html += renderLivePreview(ph.livePreview, h);
        for (let i = 0; i < ph.attempts.length; i++) {
            const att = ph.attempts[i];
            const isLast = i === ph.attempts.length - 1;
            const key = `att:${ph.charmId}:${i}`;
            const autoOpen = isLast || att.status === 'failed' || att.status === 'warning' || att.status === 'running';
            const pref = userPref(key);
            const open = pref === 'closed' ? false : (pref === 'open' || autoOpen);
            html += `<div class="act-attempt" data-key="${h.esc(key)}" data-open="${open}">`;
            html +=   `<button class="act-attempt__hdr" data-collapse-toggle>`;
            html +=     `<span class="act-attempt__chev">▸</span>`;
            html +=     `<span class="act-attempt__label">${h.esc(att.label)}</span>`;
            html +=     `<span class="act-attempt__badge" data-status="${att.status}">${h.esc(statusLabel(att.status))}</span>`;
            html +=   `</button>`;
            html +=   `<div class="act-attempt__body">`;
            for (let s = 0; s < att.steps.length; s++) {
                html += renderStep(att.steps[s], `${key}:s${s}`, h);
            }
            html +=   `</div>`;
            html += `</div>`;
        }
        return html;
    }

    function renderStep(step, key, h) {
        const autoOpen = step.status === 'running' || step.status === 'failed' || step.status === 'warning';
        const pref = userPref(key);
        const open = pref === 'closed' ? false : (pref === 'open' || autoOpen);
        const chips = step.chips || {};
        let chipHtml = '';
        if (chips.llm)   chipHtml += `<span class="act-chip">${chips.llm} LLM</span>`;
        if (chips.tools) chipHtml += `<span class="act-chip">${chips.tools} tools</span>`;
        if (chips.cost)  chipHtml += `<span class="act-chip act-chip--cost">$${chips.cost.toFixed(4)}</span>`;

        let html = `<div class="act-step ${statusClass(step.status)}" data-key="${h.esc(key)}" data-open="${open}">`;
        html +=   `<button class="act-step__hdr" data-collapse-toggle>`;
        html +=     `<span class="act-step__chev">▸</span>`;
        html +=     `<span class="act-step__dot" data-status="${step.status}">${statusEmoji(step.status)}</span>`;
        html +=     `<span class="act-step__label">${h.esc(step.label || 'Working…')}</span>`;
        if (chipHtml) html += `<span class="act-step__chips">${chipHtml}</span>`;
        html +=   `</button>`;
        html +=   `<div class="act-step__body">${renderRawEvents(step.events, h)}</div>`;
        html += `</div>`;
        return html;
    }

    function renderRawEvents(events, h) {
        if (!events || !events.length) return '<div class="act-line act-line--muted">(no events)</div>';
        let html = '<ul class="act-rawlist">';
        for (const e of events) {
            html += `<li class="act-raw">${renderRawEvent(e, h)}</li>`;
        }
        html += '</ul>';
        return html;
    }

    function renderRawEvent(e, h) {
        const p = e.payload || {};
        switch (e.type) {
            case 'llm.call': {
                const role = h.esc(p.role || 'llm');
                const cost = typeof p.costUSD === 'number' ? `$${p.costUSD.toFixed(4)}` : '';
                const model = h.esc((p.model || '').split('/').pop() || '');
                let html = `<span class="act-raw__type">LLM</span> <span class="act-raw__role">${role}</span> <span class="act-raw__meta">${model}${cost?' · '+cost:''}</span>`;
                if (p.reasoning) {
                    const r = h.esc(p.reasoning);
                    const dk = `details:llm:${e.ts || ''}:${p.spanId || ''}:reasoning`;
                    html += `<details class="act-reasoning" data-key="${h.esc(dk)}"><summary>Reasoning (${(p.reasoning.match(/\S+/g)||[]).length} words)</summary><pre>${r}</pre></details>`;
                }
                return html;
            }
            case 'tool.call': {
                return `<span class="act-raw__type">tool</span> ${h.esc(summariseTool(p))}`;
            }
            case 'correlated.tool': {
                const ok = p.ok !== false;
                return `<span class="act-raw__type">tool</span> <span class="act-raw__status ${ok?'ok':'err'}">${ok?'✓':'✗'}</span> ${h.esc(summariseTool(p))}${typeof p.durationMs==='number'?` <span class="act-raw__meta">${p.durationMs}ms</span>`:''}`;
            }
            case 'spell.exec': {
                return `<span class="act-raw__type">spell</span> ${h.esc(p.summary || summariseTool(p))}`;
            }
            case 'scroll.submitted': {
                const conf = typeof p.confidence === 'number' ? p.confidence.toFixed(2) : '';
                return `<span class="act-raw__type">Scroll</span> ${h.esc(p.scrollId || '')} <span class="act-raw__meta">conf ${conf}</span>`;
            }
            case 'omen': {
                return `<span class="act-raw__type act-raw__type--warn">omen</span> ${h.esc(p.kind || '')}: ${h.esc(p.message || '')}`;
            }
            case 'budget.exhausted': {
                return `<span class="act-raw__type act-raw__type--warn">budget</span> ${h.esc(p.reason || 'exhausted')}`;
            }
            case 'ward.requested': {
                return `<span class="act-raw__type">ward</span> ${h.esc(p.method || p.wardType || '')} <span class="act-raw__meta">${h.esc(String(p.expression || '').slice(0, 80))}</span>`;
            }
            case 'ward.result': {
                return `<span class="act-raw__type">ward</span> ${h.esc(p.wardType || '')} → <span class="act-raw__status ${p.passed?'ok':'err'}">${p.passed?'pass':'fail'}</span>`;
            }
            case 'skeptic.verdict': {
                return `<span class="act-raw__type">Skeptic</span> ${h.esc(p.verdict || '')} <span class="act-raw__meta">${(p.summary && p.summary.matched) || 0}/${(p.summary && p.summary.total) || 0}</span>`;
            }
            case 'fairy.started': {
                return `<span class="act-raw__type">Fairy</span> started ${h.esc(p.model || '')}`;
            }
            case 'circle.transition': {
                return `<span class="act-raw__type">state</span> ${h.esc(p.from || '')} → ${h.esc(p.to || '')}`;
            }
            default:
                return `<span class="act-raw__type">${h.esc(e.type)}</span> <span class="act-raw__meta">${h.esc(JSON.stringify(p).slice(0, 120))}</span>`;
        }
    }

    function renderRawDetailsExpander(events, h, label) {
        if (!events.length) return '';
        // Stable key built from label + the FIRST event ts so the expander
        // doesn't lose its open-state when later events stream in.
        const dk = `details:rawlist:${label}:${(events[0] && events[0].ts) || ''}`;
        return `<details class="act-rawdetails" data-key="${h.esc(dk)}"><summary>${h.esc(label)} (${events.length})</summary>${renderRawEvents(events, h)}</details>`;
    }

    function renderCritic(ph, h) {
        let html = `<div class="act-line act-line--muted">The Critic studies the Fairy's artefacts, clean-runs the notebook where appropriate, and adds targeted checks. Results may <em>support</em>, <em>challenge</em>, or leave a claim <em>inconclusive</em>; Mathematica is not treated as an oracle.</div>`;
        if (Array.isArray(ph.items) && ph.items.length) {
            html += `<ul class="act-critic-items">`;
            for (const it of ph.items) {
                const cls = it.verdict === 'accept' ? 'ok' : it.verdict === 'dispute' ? 'err' : 'warn';
                html += `<li><span class="act-raw__status ${cls}">${it.verdict}</span> matched ${it.matched}/${it.total}`;
                if (it.failed)  html += ` · <span class="act-raw__status err">${it.failed} failed</span>`;
                if (it.skipped) html += ` · <span class="act-raw__meta">${it.skipped} skipped</span>`;
                if (Array.isArray(it.objections) && it.objections.length) {
                    const dk = `details:objections:${ph.charmId}:${it.attemptIdx || 0}`;
                    html += `<details class="act-rawdetails" data-key="${h.esc(dk)}"><summary>Objections (${it.objections.length})</summary><ul>`;
                    for (const o of it.objections) html += `<li>${h.esc(String(o).slice(0, 500))}</li>`;
                    html += `</ul></details>`;
                }
                html += `</li>`;
            }
            html += `</ul>`;
        }
        if (ph.events.length) html += renderRawDetailsExpander(ph.events, h, `Raw critic events ${ph.charmId}`);
        return html;
    }

    function renderVerdict(ph, h) {
        const v = ph.finalVerdict || {};
        let html = '';
        const verdictPretty = String(v.verdict || '').replace(/_/g, ' ').toUpperCase();
        html += `<div class="act-verdict-final" data-status="${v.verdict}">`;
        html +=   `<div class="act-verdict-final__head">Final outcome: <strong>${h.esc(verdictPretty)}</strong>${v.verificationLevel?` <span class="act-raw__meta">— ${h.esc(v.verificationLevel)}</span>`:''}</div>`;
        if (v.narrative)     html += `<div class="act-line act-md">${renderMd(String(v.narrative))}</div>`;
        if (v.mainEvidence)  html += `<div class="act-line act-md"><strong>Main evidence:</strong> ${renderMd(String(v.mainEvidence).slice(0, 800))}</div>`;
        if (v.mainFailure)   html += `<div class="act-line act-md"><strong>Main failure:</strong> ${renderMd(String(v.mainFailure).slice(0, 800))}</div>`;
        if (v.recommendedAction) html += `<div class="act-line act-md"><strong>Next:</strong> ${renderMd(String(v.recommendedAction).slice(0, 800))}</div>`;
        html += `</div>`;
        if (Array.isArray(ph.history) && ph.history.length) {
            const dk = `details:verdicthist:${ph.charmId || ''}`;
            html += `<details class="act-rawdetails" data-key="${h.esc(dk)}"><summary>Previous verdicts (${ph.history.length})</summary><ul>`;
            for (const hv of ph.history) {
                html += `<li><span class="act-raw__meta">${h.esc(String(hv.verdict || '').toUpperCase())}</span>${hv.narrative?` — ${h.esc(String(hv.narrative).slice(0, 200))}`:''}</li>`;
            }
            html += `</ul></details>`;
        }
        return html;
    }

    function renderConclusion(ph, h) {
        const c = ph.finalConclusion || {};
        let html = '';
        if (c.summary)  html += `<div class="act-line act-md">${renderMd(c.summary)}</div>`;
        const chips = [];
        if (typeof c.confidence === 'number') chips.push(`<span class="act-chip act-chip--conf">conf ${c.confidence.toFixed(2)}</span>`);
        if (typeof c.findingsCount === 'number') chips.push(`<span class="act-chip">${c.findingsCount} finding${c.findingsCount===1?'':'s'}</span>`);
        if (typeof c.evidenceCount === 'number' && c.evidenceCount) chips.push(`<span class="act-chip">${c.evidenceCount} evidence</span>`);
        if (typeof c.openQuestionsCount === 'number' && c.openQuestionsCount) chips.push(`<span class="act-chip">${c.openQuestionsCount} open Q</span>`);
        if (chips.length) html += `<div class="act-run__chips">${chips.join('')}</div>`;
        if (Array.isArray(c.findings) && c.findings.length) {
            const dk = `details:findings:${ph.runKey || ''}`;
            html += `<details class="act-rawdetails" data-key="${h.esc(dk)}"><summary>Findings (${c.findings.length})</summary><ul>`;
            for (const f of c.findings) {
                html += `<li><span class="act-raw__meta">${typeof f.confidence === 'number' ? f.confidence.toFixed(2) : ''}</span> ${h.esc(f.claim || '')}</li>`;
            }
            html += `</ul></details>`;
        }
        if (Array.isArray(c.openQuestions) && c.openQuestions.length) {
            const dk = `details:openq:${ph.runKey || ''}`;
            html += `<details class="act-rawdetails" open data-key="${h.esc(dk)}"><summary>Open questions (${c.openQuestions.length})</summary><ul>`;
            for (const q of c.openQuestions) html += `<li>${h.esc(String(q))}</li>`;
            html += `</ul></details>`;
        }
        return html;
    }

    function renderOmens(ph, h) {
        let html = '<ul class="act-rawlist">';
        for (const e of ph.events) html += `<li class="act-raw">${renderRawEvent(e, h)}</li>`;
        html += '</ul>';
        return html;
    }

    // ── exports ────────────────────────────────────────────────────────────
    global.OberonActivityView = {
        build: buildActivityViewModel,
        render: render,
    };
}(typeof window !== 'undefined' ? window : globalThis));
