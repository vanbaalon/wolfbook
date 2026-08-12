'use strict';
/**
 * Oberon Director — the LLM layer ABOVE the Fairy.
 *
 * One Director run ("Programme") = plan → [fairy stage → analyse clean.wb →
 * adjust plan]* → synthesis → (SkilXiv skill candidate for considerable novel
 * results) → concise LaTeX report.
 *
 * Design invariants (mirror the fairy's run-flow invariants — do not regress):
 *  - JOURNALED: programme.json is re-persisted after every mutation, so a crash
 *    or reload can resume with `runDirector({ resumeDir })` (completed stages
 *    and banked key results survive; the kernel handoff does not).
 *  - BOUNDED: maxStages / maxReplans / maxLitConsults / maxAskUser / cost caps
 *    are enforced in the loop; a 15%-of-budget reserve is kept for synthesis +
 *    report so the run always ends with a report, never a bare crash.
 *  - EVIDENCE-DRIVEN: the assess step judges from deterministic digests of the
 *    delivered clean.wb + facts.json + scroll — never from the fairy's word
 *    alone. LLM failures degrade to deterministic fallbacks, never wedge.
 *  - HONEST: a failed programme still produces a report saying what failed and
 *    what was established; skipped stages are recorded as skipped.
 *
 * All side-effectful collaborators are injectable via `deps` so the test suite
 * exercises the whole loop headless (mock LLM + mock fairy):
 *   llm          ({messages, maxTokens, responseFormat, purpose}) → {content,...}
 *   runStage     ({stage, task, handoff, signal}) → {questId, charmDir, scroll,
 *                 cleanNbPath, partialNbPath, handoff}
 *   literature   ({question, signal}) → literature brief (fairy/literature shape) | null
 *   skilxivSearch(query) → markdown-ish hits string | ''
 *   askUser      ({question}) → string|null
 *   contribute   ({programme, synthesis, stage}) → {candidateId,...}|null
 *   submitSkill  ({candidateId}) → {ok}|null       (only when autoSubmitSkill)
 *   onTransition (state) — circle-FSM hook (index.js maps to runManager)
 *   shouldAbort  () → boolean
 *   budgetStatus () → { exhausted: boolean, costUSD: number }
 */

const { getAdapter }   = require('../providers');
const { computeCost }  = require('../providers/cost');
const { makeSpanId }   = require('../telemetry/bus');
const { makeOnChunk }  = require('../core/llmStream');
const roles            = require('../config/roles');
const settings         = require('../config/settings');

const state    = require('./state');
const prompts  = require('./prompts');
const analyst  = require('./analyst');
const reportMod = require('./report');

// Stage B3 escalation threshold: a stage that has failed this many attempts is
// retried once on the stronger judgment binding rather than re-attempted on the
// cheap execution model. Escalation economics (Pro ~3.1x Flash) say: rarely.
const ESCALATE_AFTER = 2;

// ── Director LLM plumbing ─────────────────────────────────────────────────────

/**
 * Default LLM caller on the `director` role (falls back to `oberon` binding).
 * Emits llm.call telemetry; cost flows into the RunManager budget automatically.
 */
function makeDirectorLlm({ bus, signal, programmeId }) {
    const binding = roles.resolveRole('director');
    if (!binding.configured) {
        const err = new Error('Director role is not configured (provider + model + API key required).');
        err.kind = 'not_configured';
        throw err;
    }
    const adapter = getAdapter(binding.provider);
    return async function llm({ messages, maxTokens, responseFormat, purpose }) {
        const spanId = makeSpanId('dir');
        const onChunk = makeOnChunk({ bus, role: 'director', spanId });
        const result = await adapter.chatComplete({
            messages,
            model:          binding.model,
            temperature:    0.2,
            maxTokens:      maxTokens || binding.maxTokens || 6000,
            responseFormat: responseFormat || undefined,
            signal,
        }, { pricing: binding.pricing, onChunk });
        const costUSD = (typeof result.costUSD === 'number') ? result.costUSD : computeCost(result.usage, binding.pricing);
        await bus.appendEvent('llm.call', {
            role: 'director', purpose: purpose || null,
            provider: result.provider, model: result.model,
            usage: result.usage, costUSD,
            latencyMs: result.latencyMs, stopReason: result.stopReason,
            promptMessages: messages, responseText: result.content,
            reasoning: result.reasoning || null,
            programmeId: programmeId || null,
        }, { spanId }).catch(() => {});
        return { ...result, costUSD };
    };
}

/**
 * Call + parse with ONE repair turn. Returns parsed.value or null (never throws
 * on parse failure; throws only on provider errors so callers can decide).
 */
async function llmJson({ llm, messages, parse, maxTokens, purpose, spend }) {
    const r1 = await llm({ messages, maxTokens, responseFormat: 'json_object', purpose });
    if (spend) { spend.directorLlmCalls++; spend.directorCostUSD += r1.costUSD || 0; }
    let parsed = parse(r1.content);
    if (parsed.ok) return { value: parsed.value, raw: r1.content };
    const repair = [
        ...messages,
        { role: 'assistant', content: String(r1.content || '') },
        { role: 'user',      content: prompts.REPAIR_MSG(parsed.errors) },
    ];
    const r2 = await llm({ messages: repair, maxTokens, responseFormat: 'json_object', purpose: (purpose || '') + '_repair' });
    if (spend) { spend.directorLlmCalls++; spend.directorCostUSD += r2.costUSD || 0; }
    parsed = parse(r2.content);
    if (parsed.ok) return { value: parsed.value, raw: r2.content };
    return { value: null, errors: parsed.errors };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function nextPendingStage(programme) {
    for (const s of (programme.plan && programme.plan.stages) || []) {
        if (s.status === 'pending') return s;
    }
    return null;
}

function markRemainingSkipped(programme, reason) {
    for (const s of (programme.plan && programme.plan.stages) || []) {
        if (s.status === 'pending') {
            s.status = 'skipped';
            s.assessment = s.assessment || null;
            s.notesForNext = s.notesForNext || '';
            s.skipReason = reason;
        }
    }
}

function lastExecutedStage(programme) {
    const stages = (programme.plan && programme.plan.stages) || [];
    for (let i = stages.length - 1; i >= 0; i--) {
        if (['delivered', 'partial', 'failed'].includes(stages[i].status)) return stages[i];
    }
    return null;
}

function lastDeliveredStage(programme) {
    const stages = (programme.plan && programme.plan.stages) || [];
    for (let i = stages.length - 1; i >= 0; i--) {
        if (stages[i].status === 'delivered' && stages[i].charmDir) return stages[i];
    }
    return null;
}

/** Compose the full self-contained fairy task for a stage. ≤7900 chars (charm schema cap 8000). */
function composeStageTask(programme, stage) {
    const parts = [];
    if ((programme.assumptions || []).length) {
        parts.push('ASSUMED PARAMETERS (declare these in your outputs; they were defaulted, not given):\n'
            + programme.assumptions.map(a => `- ${a.statement || a}`).join('\n'));
    }
    const krBlock = state.renderKeyResultsBlock(programme);
    if (krBlock) parts.push(krBlock);
    const prev = lastExecutedStage(programme);
    if (prev && prev.notesForNext) {
        parts.push(`HANDOFF NOTES from the previous stage (${prev.id}):\n${prev.notesForNext}`);
    }
    // A retry of a partially-solved stage (or a stage following one) starts
    // INFORMED: the previous attempt's verified utilities + facts are re-seeded
    // into the kernel by the handoff mechanism — tell the fairy explicitly so it
    // builds on them instead of re-deriving.
    if (prev && (prev.status === 'partial' || (stage.attempt > 0 && prev.id.startsWith(stage.id)))) {
        parts.push('CONTINUATION: a previous run partially solved this problem. Its verified utility ' +
            'definitions and established facts are pre-loaded in your kernel and ledger (see the ' +
            'ESTABLISHED RESULTS above). Build directly on them — do NOT restart from scratch.');
    }
    parts.push(`YOUR TASK (stage ${stage.id} of research programme "${programme.title}"):\n${stage.task}`);
    if ((stage.successCriteria || []).length) {
        parts.push('SUCCESS CRITERIA:\n' + stage.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n'));
    }
    return parts.join('\n\n').slice(0, 7900);
}

/** Deterministic stage status from run artifacts (before the LLM verdict refines it). */
function statusFromArtifacts(art) {
    const st = art && art.scroll && art.scroll.fairyArtifact && art.scroll.fairyArtifact.status;
    if (st === 'delivered') return 'delivered';
    if (st === 'partial_delivered' || art.partialNbPath) return 'partial';
    return 'failed';
}

/** Deterministic fallback assessment when the assess LLM is unreachable. */
function fallbackAssessment(stage, art) {
    const status = statusFromArtifacts(art);
    const findings = (art && art.scroll && Array.isArray(art.scroll.findings)) ? art.scroll.findings : [];
    const conf = (art && art.scroll && typeof art.scroll.confidence === 'number') ? art.scroll.confidence : 0.4;
    return {
        verdict: status === 'delivered' ? 'achieved' : (status === 'partial' ? 'partial' : 'failed'),
        surprise: 'none',
        keyResults: findings.slice(0, 3).map(f => ({
            statement:  String(typeof f === 'string' ? f : (f && f.claim) || '').slice(0, 1200),
            evidence:   'fairy scroll finding (director LLM analysis unavailable)',
            confidence: Math.min(conf, 0.7),
        })).filter(k => k.statement),
        issues: ['director assess LLM unavailable — deterministic fallback used'],
        stageNotes: '',
        action: 'continue',
        reason: 'fallback: proceed with the planned stages',
        revisedStage: null, newStage: null, dropStageId: null,
        literatureQuestion: null, userQuestion: null,
        fallback: true,
    };
}

function budgetsNote(programme, cfg, budget) {
    return `stages run ${programme.stagesRun}/${cfg.maxStages}, plan changes ${programme.replansUsed}/${cfg.maxReplans}, ` +
        `literature consults ${programme.litConsultsUsed}/${cfg.maxLitConsults}, user questions ${programme.askUserUsed}/${cfg.maxAskUser}` +
        (budget && typeof budget.costUSD === 'number' && cfg.maxUSD > 0
            ? `, spend $${budget.costUSD.toFixed(2)}/$${cfg.maxUSD.toFixed(2)}` : '');
}

// ── the run ───────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   brief?: string, resumeDir?: string, root: string,
 *   bus: import('../telemetry/bus').TelemetryBus,
 *   signal?: AbortSignal|null,
 *   deps?: object,
 * }} args
 * @returns {Promise<{ programme: object }>}
 */
async function runDirector({ brief, resumeDir, root, bus, signal = null, deps = {} }) {
    const cfg = settings.director();
    const d = {
        llm:           deps.llm || null,           // created lazily below (needs programmeId)
        runStage:      deps.runStage,
        literature:    deps.literature   || null,
        skilxivSearch: deps.skilxivSearch || null,
        askUser:       deps.askUser      || null,
        contribute:    deps.contribute   || defaultContribute,
        submitSkill:   deps.submitSkill  || null,
        onTransition:  deps.onTransition || (async () => {}),
        shouldAbort:   deps.shouldAbort  || (() => !!(signal && signal.aborted)),
        budgetStatus:  deps.budgetStatus || (() => ({ exhausted: false, costUSD: 0 })),
        openArtifact:  deps.openArtifact || (async () => {}),
    };
    if (typeof d.runStage !== 'function') throw new Error('runDirector: deps.runStage is required');

    // ── programme bootstrap / resume ────────────────────────────────────────
    let programme;
    if (resumeDir) {
        programme = await state.loadProgramme(resumeDir);
        // A stage that was mid-flight when we died is re-run from scratch.
        for (const s of (programme.plan && programme.plan.stages) || []) {
            if (s.status === 'running') s.status = 'pending';
        }
        if (['done'].includes(programme.status)) {
            throw new Error(`Programme ${programme.id} is already done — nothing to resume.`);
        }
    } else {
        if (!brief || !String(brief).trim()) throw new Error('runDirector: brief is empty');
        programme = await state.createProgramme({ root, goal: String(brief).trim() });
    }
    if (!d.llm) d.llm = makeDirectorLlm({ bus, signal, programmeId: programme.id });
    if (bus && bus.runId && !programme.runIds.includes(bus.runId)) programme.runIds.push(bus.runId);
    const spend = programme.spend;

    await bus.appendEvent('director.started', {
        programmeId: programme.id, dir: programme.dir,
        resumed: !!resumeDir, goalPreview: programme.goal.slice(0, 240),
    }).catch(() => {});

    const checkAbort = () => {
        if (d.shouldAbort()) {
            const e = new Error('Director run aborted');
            e.kind = 'aborted';
            throw e;
        }
    };

    try {
        // ── A. PLAN ─────────────────────────────────────────────────────────
        if (!programme.plan) {
            checkAbort();
            let skillHits = '';
            if (d.skilxivSearch) {
                try {
                    skillHits = await Promise.race([
                        d.skilxivSearch(programme.goal.slice(0, 300)),
                        new Promise(r => setTimeout(() => r(''), 8000)),
                    ]) || '';
                } catch (_) { skillHits = ''; }
            }
            let grimoireNote = '';
            try {
                grimoireNote = await require('../memory/grimoire')
                    .recentEntriesSummary({ limit: 4, maxChars: 1600 });
            } catch (_) { /* best-effort */ }

            let planOut = await llmJson({
                llm: d.llm, purpose: 'plan', maxTokens: 8000, spend,
                messages: prompts.buildPlanMessages({ goal: programme.goal, skillHits, grimoireNote }),
                parse: prompts.parsePlanReply,
            });
            if (!planOut.value) {
                const e = new Error(`Director plan invalid after repair: ${(planOut.errors || []).join('; ')}`);
                e.kind = 'plan_invalid';
                throw e;
            }
            let plan = planOut.value;

            // Clarify gate (O2 semantics): one round with the user, else declare
            // the defaults as explicit prose assumptions.
            if (plan.missingInfo.length) {
                let answer = null;
                if (d.askUser && programme.askUserUsed < cfg.maxAskUser) {
                    programme.askUserUsed++;
                    try {
                        answer = await d.askUser({
                            question: `Before planning stages, Oberon Director needs: ${plan.missingInfo.join(' · ')}`,
                        });
                    } catch (_) { answer = null; }
                    programme.askUserLog.push({
                        question: `missingInfo: ${plan.missingInfo.join(' · ')}`,
                        answer: answer || null, at: new Date().toISOString(),
                    });
                }
                if (answer && String(answer).trim()) {
                    const replanned = await llmJson({
                        llm: d.llm, purpose: 'plan_clarified', maxTokens: 8000, spend,
                        messages: prompts.buildPlanMessages({
                            goal: `${programme.goal}\n\nCLARIFICATIONS (from the user):\n${String(answer).trim()}`,
                            skillHits, grimoireNote,
                        }),
                        parse: prompts.parsePlanReply,
                    });
                    if (replanned.value) plan = replanned.value;
                }
                if (plan.missingInfo.length && !(answer && String(answer).trim())) {
                    programme.assumptions = plan.missingInfo.map((m, i) => ({
                        id: `assumed_${i + 1}`,
                        statement: `ASSUMED: ${String(m).slice(0, 480)}`,
                        prose: true,
                    }));
                    await bus.appendEvent('director.assumed_parameters', {
                        programmeId: programme.id,
                        assumptions: programme.assumptions.map(a => a.statement),
                    }).catch(() => {});
                }
            }

            programme.title = plan.title || programme.title;
            programme.slug  = state.slugify(plan.shortName || plan.title || programme.slug);
            programme.plan = {
                objective:        plan.objective,
                finalDeliverable: plan.finalDeliverable,
                version:          1,
                stages:           [],
            };
            for (const spec of plan.stages) {
                programme.plan.stages.push(state.makeStage({
                    ...spec, id: state.nextStageId(programme.plan),
                }));
            }
            programme.status = 'running';
            await state.saveProgramme(programme);
            await bus.appendEvent('director.plan', {
                programmeId: programme.id, title: programme.title,
                objective: programme.plan.objective.slice(0, 400),
                stages: programme.plan.stages.map(s => ({ id: s.id, title: s.title })),
                assumptions: programme.assumptions.map(a => a.statement),
            }).catch(() => {});
        } else {
            programme.status = 'running';
            await state.saveProgramme(programme);
        }

        // ── Stage B3: SESSION CANARY (plan §Stage 4 "session ritual") ───────
        // One trivial kernel computation before spending a multi-stage budget.
        // A Director programme is the most expensive thing this system runs; if
        // the kernel is wedged, unlicensed, or answering nonsense, failing here
        // costs seconds instead of dollars and a confusing failed programme.
        if (typeof d.canaryEval === 'function') {
            try {
                const c = await d.canaryEval({ expression: 'Total[Range[10]] + Length[IntegerPartitions[4]]', timeoutSeconds: 30 });
                const val = String((c && c.value) || '').trim();
                const okCanary = c && c.ok !== false && /\b60\b/.test(val);   // 55 + 5
                await bus.appendEvent('director.canary', {
                    programmeId: programme.id, ok: !!okCanary, value: val.slice(0, 80),
                }).catch(() => {});
                if (!okCanary) {
                    await bus.appendEvent('omen', {
                        kind: 'director_canary_failed',
                        message: `Kernel canary failed (expected 60, got "${val.slice(0, 60)}") — aborting before the stage loop.`,
                    }).catch(() => {});
                    programme.status = 'failed';
                    programme.stopReason = 'kernel canary failed before stage 1 — the environment is not usable';
                    await state.saveProgramme(programme);
                    return { programme, aborted: true, reason: programme.stopReason };
                }
            } catch (e) {
                // A canary that cannot RUN is inconclusive, not a failure: log and
                // continue rather than blocking a programme on harness plumbing.
                await bus.appendEvent('omen', {
                    kind: 'director_canary_skipped', message: (e && e.message) || String(e),
                }).catch(() => {});
            }
        }

        // ── B/C/D. STAGE LOOP ───────────────────────────────────────────────
        let handoff = null;   // fairy utils+facts carried between consecutive stages
        let stopAction = null;
        let guard = 0;
        while (true) {
            if (++guard > 60) {   // absolute wedge protection; never expected
                await bus.appendEvent('omen', { kind: 'director_guard_tripped', message: 'stage loop guard (60) tripped' }).catch(() => {});
                break;
            }
            const stage = nextPendingStage(programme);
            if (!stage) break;
            checkAbort();

            // Budget gates: hard exhaustion, 85% soft reserve, stage-count cap.
            const budget = d.budgetStatus();
            if (budget.exhausted || (cfg.maxUSD > 0 && budget.costUSD >= 0.85 * cfg.maxUSD)) {
                markRemainingSkipped(programme, 'budget reserve reached');
                await bus.appendEvent('omen', {
                    kind: 'director_budget_reserve',
                    message: `Skipping remaining stages at $${(budget.costUSD || 0).toFixed(2)} — reserving budget for synthesis + report.`,
                }).catch(() => {});
                break;
            }
            if (programme.stagesRun >= cfg.maxStages) {
                markRemainingSkipped(programme, 'stage cap reached');
                await bus.appendEvent('omen', {
                    kind: 'director_stage_cap',
                    message: `Stage cap (${cfg.maxStages}) reached — moving to synthesis.`,
                }).catch(() => {});
                break;
            }

            // ── run the stage via the fairy ──────────────────────────────────
            const taskText = composeStageTask(programme, stage);
            stage.status    = 'running';
            stage.attempt  += 1;
            stage.startedAt = new Date().toISOString();
            await state.saveProgramme(programme);
            await bus.appendEvent('director.stage_started', {
                programmeId: programme.id, stageId: stage.id, attempt: stage.attempt,
                title: stage.title, taskPreview: taskText.slice(0, 240),
            }).catch(() => {});

            let art;
            try {
                const out = await d.runStage({ stage, task: taskText, handoff, signal });
                if (out && out.handoff) handoff = out.handoff;
                art = {
                    scroll:        out && out.scroll        || null,
                    cleanNbPath:   out && out.cleanNbPath   || null,
                    partialNbPath: out && out.partialNbPath || null,
                    charmDir:      out && out.charmDir      || null,
                    questId:       out && out.questId       || null,
                    errorNote:     null,
                };
            } catch (e) {
                if (d.shouldAbort() || (e && e.kind === 'aborted')) throw e;
                art = { scroll: null, cleanNbPath: null, partialNbPath: null, charmDir: null, questId: null,
                        errorNote: (e && e.message) || String(e) };
            }
            programme.stagesRun++;
            stage.questId      = art.questId;
            stage.charmDir     = art.charmDir;
            stage.cleanNbPath  = art.cleanNbPath || art.partialNbPath || null;
            stage.scrollStatus = art.scroll && art.scroll.fairyArtifact && art.scroll.fairyArtifact.status || (art.errorNote ? 'error' : null);
            stage.confidence   = art.scroll && typeof art.scroll.confidence === 'number' ? art.scroll.confidence : null;
            stage.status       = statusFromArtifacts(art);
            // ── Stage B3: HARNESS-GATED `passes` (plan §Stage 4 ledger protocol) ──
            // `passes` records OBSERVED verification, never opinion: the stage
            // authored validationChecks at plan time, the fairy executed them in a
            // fresh-kernel replay, the replay was clean, and they were NOT
            // downgraded to warnings. No LLM verdict may set this — the assess step
            // below can only downgrade `status`, and never touches `passes`.
            {
                const fa = (art.scroll && art.scroll.fairyArtifact) || {};
                const hadChecks   = Array.isArray(stage.validationChecks) && stage.validationChecks.length > 0;
                const downgraded  = !!fa.validationDowngraded;
                stage.passes = !!(hadChecks && stage.scrollStatus === 'delivered' && !downgraded);
                stage.passesEvidence = hadChecks
                    ? (stage.passes
                        ? `${stage.validationChecks.length} plan-time check(s) passed in the fresh-kernel replay`
                        : `checks ${downgraded ? 'DOWNGRADED to warnings' : `not confirmed (scroll: ${stage.scrollStatus || 'none'})`}`)
                    : 'no plan-time validationChecks were authored for this stage';
            }
            await state.saveProgramme(programme);
            await bus.appendEvent('director.stage_finished', {
                programmeId: programme.id, stageId: stage.id,
                status: stage.status, scrollStatus: stage.scrollStatus,
                questId: stage.questId, cleanNbPath: stage.cleanNbPath,
                passes: stage.passes, passesEvidence: stage.passesEvidence,
            }).catch(() => {});
            checkAbort();

            // ── assess (LLM, with bounded consult mini-loop) ────────────────
            const digest = await analyst.buildStageDigest(art);
            const assessment = await assessStage({
                programme, stage, digest, art, cfg, d, bus, spend,
                budget: d.budgetStatus(),
            });
            stage.assessment = {
                verdict: assessment.verdict, surprise: assessment.surprise,
                issues: assessment.issues, action: assessment.action,
                reason: assessment.reason, fallback: !!assessment.fallback,
            };
            stage.notesForNext = assessment.stageNotes || '';
            for (const kr of assessment.keyResults) {
                state.addKeyResult(programme, { ...kr, stageId: stage.id });
            }
            // The LLM verdict refines the deterministic status (never upgrades a
            // failed run to delivered without a delivered scroll behind it).
            if (assessment.verdict === 'failed') stage.status = 'failed';
            else if (assessment.verdict === 'partial' && stage.status === 'delivered') stage.status = 'partial';
            stage.endedAt = new Date().toISOString();
            await state.saveProgramme(programme);
            // Stage B3: regenerate the progress digest after every stage — it is
            // GENERATED from programme.json (never hand-kept), so a human checking
            // in mid-run reads ledger truth, not a stale narrative.
            try { await require('./report').writeProgressDigest(programme); } catch (_) {}
            await bus.appendEvent('director.stage_assessed', {
                programmeId: programme.id, stageId: stage.id,
                verdict: assessment.verdict, surprise: assessment.surprise,
                action: assessment.action, reason: assessment.reason,
                keyResults: assessment.keyResults.map(k => k.statement.slice(0, 200)),
            }).catch(() => {});
            await d.onTransition('stage_assessed');

            // ── apply the plan action ────────────────────────────────────────
            const action = assessment.action;
            if (action === 'stop_success' || action === 'stop_failure') {
                markRemainingSkipped(programme, action);
                stopAction = action;
                await state.saveProgramme(programme);
                break;
            }
            if (action === 'revise_stage' && assessment.revisedStage) {
                if (programme.replansUsed < cfg.maxReplans && stage.attempt < 3) {
                    programme.replansUsed++;
                    const idx = programme.plan.stages.indexOf(stage);
                    const revived = state.makeStage({ ...assessment.revisedStage, id: stage.id });
                    revived.attempt = stage.attempt;           // attempts carry across revisions
                    revived.rationale = assessment.reason || revived.rationale;
                    // ── Stage B3: ESCALATION (plan §Stage 4, "the only new routing")
                    // A stage that has already failed ESCALATE_AFTER times is not
                    // failing for want of another identical attempt — the cheap
                    // execution model is out of its depth. Retry it once on the
                    // stronger judgment binding. Hard cap: ONE escalation per
                    // stage, and only when that role is actually configured.
                    if (stage.attempt >= ESCALATE_AFTER && !stage.escalated) {
                        const strongRole = cfg.escalateRole || 'oberon';
                        revived.escalated    = true;
                        revived.bindingRole  = strongRole;
                        await bus.appendEvent('director.escalated', {
                            programmeId: programme.id, stageId: revived.id,
                            attempt: stage.attempt, role: strongRole, reason: assessment.reason || '',
                        }).catch(() => {});
                    }
                    // Keep the failed attempt's record under a shadow id for the
                    // report/history; superseded records never affect the outcome.
                    stage.id = `${stage.id}r${stage.attempt}`;
                    stage.superseded = true;
                    programme.plan.stages.splice(idx + 1, 0, revived);
                    await bus.appendEvent('director.replan', {
                        programmeId: programme.id, kind: 'revise_stage',
                        stageId: revived.id, reason: assessment.reason,
                    }).catch(() => {});
                } else {
                    await bus.appendEvent('omen', {
                        kind: 'director_replan_cap',
                        message: `revise_stage requested but replans/attempts exhausted (${programme.replansUsed}/${cfg.maxReplans}, attempt ${stage.attempt}) — continuing.`,
                    }).catch(() => {});
                }
            } else if (action === 'insert_stage' && assessment.newStage) {
                if (programme.replansUsed < cfg.maxReplans
                    && programme.plan.stages.filter(s => s.status === 'pending').length + programme.stagesRun < cfg.maxStages) {
                    programme.replansUsed++;
                    const idx = programme.plan.stages.indexOf(stage);
                    const inserted = state.makeStage({ ...assessment.newStage, id: state.nextStageId(programme.plan) });
                    programme.plan.stages.splice(idx + 1, 0, inserted);
                    await bus.appendEvent('director.replan', {
                        programmeId: programme.id, kind: 'insert_stage',
                        stageId: inserted.id, title: inserted.title, reason: assessment.reason,
                    }).catch(() => {});
                } else {
                    await bus.appendEvent('omen', {
                        kind: 'director_replan_cap',
                        message: 'insert_stage requested but replan/stage caps exhausted — continuing.',
                    }).catch(() => {});
                }
            } else if (action === 'drop_stage' && assessment.dropStageId) {
                const victim = programme.plan.stages.find(
                    s => s.id === assessment.dropStageId && s.status === 'pending');
                if (victim && programme.replansUsed < cfg.maxReplans) {
                    programme.replansUsed++;
                    victim.status = 'dropped';
                    victim.skipReason = assessment.reason || 'dropped by director';
                    await bus.appendEvent('director.replan', {
                        programmeId: programme.id, kind: 'drop_stage',
                        stageId: victim.id, reason: assessment.reason,
                    }).catch(() => {});
                }
            }
            await state.saveProgramme(programme);
        }

        // ── E. SYNTHESIS ────────────────────────────────────────────────────
        checkAbort();
        programme.status = 'synthesis';
        await state.saveProgramme(programme);
        await d.onTransition('synthesis');
        await bus.appendEvent('director.synthesis_started', { programmeId: programme.id }).catch(() => {});

        let synthesis = null;
        try {
            const sOut = await llmJson({
                llm: d.llm, purpose: 'synthesis', maxTokens: 8000, spend,
                messages: prompts.buildSynthesisMessages({
                    programme,
                    stageSummaries: analyst.renderStageSummaries(programme),
                    literatureNote: analyst.renderLiteratureNote(programme),
                }),
                parse: prompts.parseSynthesisReply,
            });
            synthesis = sOut.value;
        } catch (_) { synthesis = null; }
        if (!synthesis) {
            // Deterministic fallback — the report must still exist.
            synthesis = {
                abstract: `Research programme "${programme.title}". Goal: ${programme.goal.slice(0, 400)}. ` +
                    `${programme.keyResults.length} kernel-verified key result(s) were established across ` +
                    `${programme.stagesRun} stage(s). (Synthesis LLM unavailable — deterministic summary.)`,
                conclusions: programme.keyResults.slice(0, 8).map(k => k.statement),
                methodSummary: 'Each stage was executed by the Fairy agent against a live Wolfram kernel; delivered notebooks re-execute in a fresh kernel.',
                literatureComparison: programme.literature.length ? 'See literature briefs in the programme folder.' : 'No literature comparison was made.',
                openProblems: [],
                novelty: { considerable: false, why: 'synthesis LLM unavailable', skillTitle: '', skillSummary: '', skillMethod: '' },
                fallback: true,
            };
        }
        programme.synthesis = synthesis;
        programme.novelty   = synthesis.novelty;

        // Outcome (deterministic, honest). Stages skipped by an early
        // stop_success (goal already achieved) or deliberately dropped do NOT
        // downgrade the outcome; budget/cap skips and failures do. Superseded
        // attempt records (revise_stage history) are excluded — what counts is
        // the final state of each planned stage.
        const stages = programme.plan.stages.filter(s => !s.superseded && s.status !== 'dropped');
        const delivered = stages.filter(s => s.status === 'delivered').length;
        const partial   = stages.filter(s => s.status === 'partial').length;
        const degrading = stages.some(s => s.status === 'failed'
            || (s.status === 'skipped' && s.skipReason !== 'stop_success'));
        const outcomeStatus = stopAction === 'stop_failure' ? 'failed'
            : (delivered > 0 && programme.keyResults.length > 0)
                ? ((degrading || partial > 0) ? 'partial' : 'success')
                : (partial > 0 ? 'partial' : 'failed');
        programme.outcome = {
            status: outcomeStatus,
            note: `${delivered} delivered / ${partial} partial / ${stages.filter(s => s.status === 'failed').length} failed stages; ` +
                  `${programme.keyResults.length} key results.`,
        };
        await state.saveProgramme(programme);
        await bus.appendEvent('director.synthesised', {
            programmeId: programme.id, outcome: programme.outcome,
            novelty: { considerable: !!synthesis.novelty.considerable, why: synthesis.novelty.why },
            conclusionsCount: synthesis.conclusions.length,
        }).catch(() => {});

        // ── F. SKILL CONTRIBUTION (fail-open, never blocks the report) ─────
        if (synthesis.novelty.considerable
            && cfg.skillCandidate
            && outcomeStatus !== 'failed'
            && settings.contribution().mode !== 'off') {
            try {
                const stage = lastDeliveredStage(programme);
                const contrib = await d.contribute({ programme, synthesis, stage, llm: d.llm, bus, spend });
                if (contrib) {
                    programme.contribution = contrib;
                    if (cfg.autoSubmitSkill && d.submitSkill && contrib.candidateId) {
                        try {
                            const sub = await d.submitSkill({ candidateId: contrib.candidateId });
                            programme.contribution.submitted = !!(sub && sub.ok);
                        } catch (_) { programme.contribution.submitted = false; }
                    }
                    await state.saveProgramme(programme);
                }
            } catch (e) {
                await bus.appendEvent('omen', {
                    kind: 'director_contribution_failed',
                    message: (e && e.message) || String(e),
                }).catch(() => {});
            }
        }

        // ── G. REPORT ───────────────────────────────────────────────────────
        checkAbort();
        programme.status = 'reporting';
        await state.saveProgramme(programme);
        const citations = reportMod.buildCitations(programme);
        let body = null;
        try {
            const r1 = await d.llm({
                messages: prompts.buildReportMessages({
                    programme, synthesis,
                    citeKeys: citations.map(c => ({ key: c.key, label: c.label })),
                }),
                maxTokens: 8000, purpose: 'report',
            });
            spend.directorLlmCalls++; spend.directorCostUSD += r1.costUSD || 0;
            let parsed = prompts.parseReportReply(r1.content);
            if (!parsed.ok) {
                const r2 = await d.llm({
                    messages: [
                        ...prompts.buildReportMessages({ programme, synthesis, citeKeys: citations.map(c => ({ key: c.key, label: c.label })) }),
                        { role: 'assistant', content: String(r1.content || '') },
                        { role: 'user',      content: prompts.REPAIR_MSG(parsed.errors) + `\nRemember the ${prompts.REPORT_BEGIN} / ${prompts.REPORT_END} markers.` },
                    ],
                    maxTokens: 8000, purpose: 'report_repair',
                });
                spend.directorLlmCalls++; spend.directorCostUSD += r2.costUSD || 0;
                parsed = prompts.parseReportReply(r2.content);
            }
            if (parsed.ok) body = parsed.value;
        } catch (_) { body = null; }
        if (!body) {
            // Deterministic fallback body from the synthesis.
            body = [
                '\\begin{abstract}', reportMod.texEscape(synthesis.abstract), '\\end{abstract}',
                '\\section{Results}',
                '\\begin{enumerate}',
                ...synthesis.conclusions.map(c => `\\item ${reportMod.texEscape(c)}`),
                '\\end{enumerate}',
                synthesis.methodSummary ? `\\section{Method}\n${reportMod.texEscape(synthesis.methodSummary)}` : '',
                synthesis.literatureComparison ? `\\section{Discussion}\n${reportMod.texEscape(synthesis.literatureComparison)}` : '',
            ].filter(Boolean).join('\n');
        }
        const tex     = reportMod.composeReportTex({ programme, body, citations });
        const texPath = await reportMod.writeReport(programme, tex);
        let pdfPath   = null;
        if (cfg.compilePdf) pdfPath = await reportMod.tryCompilePdf(texPath);
        programme.report = { texPath, pdfPath };
        programme.status = 'done';
        await state.saveProgramme(programme);
        await bus.appendEvent('director.finished', {
            programmeId: programme.id, outcome: programme.outcome,
            report: programme.report,
            keyResults: programme.keyResults.length,
            stagesRun: programme.stagesRun,
            contribution: programme.contribution
                ? { candidateId: programme.contribution.candidateId, submitted: !!programme.contribution.submitted }
                : null,
        }).catch(() => {});
        try { await d.openArtifact(texPath, 'report'); } catch (_) {}
        if (pdfPath) { try { await d.openArtifact(pdfPath, 'pdf'); } catch (_) {} }

        return { programme };
    } catch (e) {
        const aborted = (e && e.kind === 'aborted') || d.shouldAbort();
        programme.status = aborted ? 'aborted' : 'failed';
        programme.outcome = programme.outcome || {
            status: 'failed',
            note: aborted ? 'aborted by user' : `director error: ${(e && e.message) || String(e)}`,
        };
        await state.saveProgramme(programme).catch(() => {});
        await bus.appendEvent(aborted ? 'director.aborted' : 'director.failed', {
            programmeId: programme.id, message: (e && e.message) || String(e),
        }).catch(() => {});
        throw e;
    }
}

// ── the assess mini-loop (consult literature / ask user, bounded) ─────────────

async function assessStage({ programme, stage, digest, art, cfg, d, bus, spend, budget }) {
    let messages = prompts.buildAssessMessages({
        programme, stage, digest,
        planView: analyst.renderPlanView(programme, stage.id),
        budgetsNote: budgetsNote(programme, cfg, budget),
    });
    let last = null;
    for (let round = 0; round < 3; round++) {
        let out;
        try {
            out = await llmJson({
                llm: d.llm, purpose: round === 0 ? 'assess' : 'assess_followup',
                maxTokens: 6000, spend,
                messages, parse: prompts.parseAssessReply,
            });
        } catch (_) { out = { value: null }; }
        if (!out.value) return last || fallbackAssessment(stage, art || { scroll: null });
        last = out.value;

        // Mid-assessment consults: run the side call, then require a final action.
        if (last.action === 'consult_literature') {
            if (d.literature && programme.litConsultsUsed < cfg.maxLitConsults) {
                programme.litConsultsUsed++;
                await state.saveProgramme(programme);
                await bus.appendEvent('director.literature_started', {
                    programmeId: programme.id, stageId: stage.id,
                    question: last.literatureQuestion,
                }).catch(() => {});
                let brief = null;
                try { brief = await d.literature({ question: last.literatureQuestion }); }
                catch (_) { brief = null; }
                let litNote = 'Literature search failed or returned nothing.';
                if (brief) {
                    const rec = await state.saveLiteratureBrief(programme, {
                        question: last.literatureQuestion, brief, stageId: stage.id,
                    });
                    await state.saveProgramme(programme);
                    litNote = analyst.renderLiteratureNote({ literature: [rec] }, { maxChars: 2200 })
                        || 'No relevant papers found.';
                    await bus.appendEvent('director.literature_done', {
                        programmeId: programme.id, stageId: stage.id,
                        briefId: rec.id, papers: rec.papers.length,
                    }).catch(() => {});
                }
                messages = [
                    ...messages,
                    { role: 'assistant', content: JSON.stringify(last) },
                    { role: 'user', content:
                        `LITERATURE BRIEF (your consult):\n${litNote}\n\n` +
                        'Given this, reply again with the FULL assessment JSON. ' +
                        'The action must NOT be consult_literature this time.' },
                ];
                continue;
            }
            last.action = 'continue';
            last.reason = (last.reason ? last.reason + ' ' : '') + '(literature consult unavailable/exhausted)';
            return last;
        }
        if (last.action === 'ask_user') {
            if (d.askUser && programme.askUserUsed < cfg.maxAskUser) {
                programme.askUserUsed++;
                await state.saveProgramme(programme);
                let answer = null;
                try { answer = await d.askUser({ question: last.userQuestion }); } catch (_) { answer = null; }
                programme.askUserLog.push({ question: last.userQuestion, answer: answer || null, at: new Date().toISOString() });
                await state.saveProgramme(programme);
                await bus.appendEvent('director.asked_user', {
                    programmeId: programme.id, stageId: stage.id,
                    question: last.userQuestion, answered: !!(answer && String(answer).trim()),
                }).catch(() => {});
                messages = [
                    ...messages,
                    { role: 'assistant', content: JSON.stringify(last) },
                    { role: 'user', content:
                        (answer && String(answer).trim()
                            ? `USER ANSWER: ${String(answer).trim().slice(0, 1000)}`
                            : 'The user did not answer. Proceed on your best judgment and state the assumption in stageNotes.') +
                        '\n\nReply again with the FULL assessment JSON. The action must NOT be ask_user this time.' },
                ];
                continue;
            }
            last.action = 'continue';
            last.reason = (last.reason ? last.reason + ' ' : '') + '(ask_user unavailable/exhausted)';
            return last;
        }
        return last;
    }
    // Rounds exhausted mid-consult — coerce to continue.
    if (last && (last.action === 'consult_literature' || last.action === 'ask_user')) {
        last.action = 'continue';
    }
    return last || fallbackAssessment(stage, art || { scroll: null });
}

// ── default SkilXiv contribution (quest-level candidate + SKILL.draft.md) ─────

/**
 * Reuses the Stage-2 machinery: writeCandidate → author SKILL.draft.md via one
 * LLM call (fairy's own author-prompt internals) → novelty.json → events. The
 * existing review panel + notification pick it up; submission stays behind the
 * human gate unless director.autoSubmitSkill is enabled (handled by caller).
 */
async function defaultContribute({ programme, synthesis, stage, llm, bus, spend }) {
    const path = require('path');
    const fsp  = require('fs/promises');
    const contributionInbox = require('../memory/contributionInbox');

    // Definitions ledger from the last delivered stage's workDir (best-effort).
    let defsLedger = '';
    if (stage && stage.charmDir) {
        try {
            const { openWorkDir } = require('../fairy/workDir');
            defsLedger = await openWorkDir(stage.charmDir).buildDefinitionsLedger({ maxChars: 6000 });
        } catch (_) { defsLedger = ''; }
    }
    const factsLedger = programme.keyResults
        .map(k => `- ${k.statement}${k.evidence ? ` (evidence: ${k.evidence})` : ''}`)
        .join('\n').slice(0, 4000);

    const nov = synthesis.novelty || {};
    const title = nov.skillTitle || programme.title;
    const task  = (nov.skillSummary ? `${nov.skillSummary}\n\n` : '') + programme.goal;

    const cand = await contributionInbox.writeCandidate({
        charmId:  (stage && stage.id) || 'S00',
        questId:  (stage && stage.questId) || programme.id,
        title:    String(title).slice(0, 120),
        task:     String(task).slice(0, 4000),
        status:   'delivered',
        confidential: false,
        inputs: [], outputs: [],
        definitionsLedger: defsLedger,
        factsLedger,
        factsCount: programme.keyResults.length,
        cleanNbPath: (stage && stage.cleanNbPath) || null,
        derivedFrom: null,
        generatedWith: 'wolfbook-director',
    });
    if (!cand || !cand.eligible) {
        await bus.appendEvent('contribution.skipped', {
            programmeId: programme.id, reasons: (cand && cand.reasons) || ['ineligible'],
        }).catch(() => {});
        return null;
    }
    await bus.appendEvent('contribution.candidate', {
        programmeId: programme.id, questId: (stage && stage.questId) || null,
        candidateId: cand.id, dir: cand.dir, isNewSkill: true,
    }).catch(() => {});

    // Author a human-reviewable SKILL.draft.md (one LLM call, best-effort).
    let draftPath = null;
    try {
        const fairyInternals = require('../core/fairy')._internals;
        const reply = await llm({
            messages: [{ role: 'user', content: fairyInternals.buildSkillAuthorPrompt({
                task, definitionsLedger: defsLedger, factsLedger,
            }) }],
            maxTokens: 4000, purpose: 'skill_author',
        });
        if (spend) { spend.directorLlmCalls++; spend.directorCostUSD += reply.costUSD || 0; }
        const authored = fairyInternals.parseSkillAuthorReply(reply.content);
        if (authored) {
            const md = fairyInternals.composeSkillDraftMd({
                authored, task, definitionsLedger: defsLedger, model: 'director',
            });
            draftPath = path.join(cand.dir, 'SKILL.draft.md');
            await fsp.writeFile(draftPath, md, 'utf8');
        }
    } catch (_) { /* raw candidate remains reviewable */ }
    try {
        await fsp.writeFile(path.join(cand.dir, 'novelty.json'),
            JSON.stringify({ novelty: 'novel', why: nov.why || '', draftPath, source: 'director', at: new Date().toISOString() }, null, 2), 'utf8');
    } catch (_) {}
    await bus.appendEvent('contribution.draft', {
        programmeId: programme.id, candidateId: cand.id,
        novelty: 'novel', draftAuthored: !!draftPath,
    }).catch(() => {});
    return { candidateId: cand.id, dir: cand.dir, draftPath, submitted: false };
}

module.exports = {
    runDirector,
    makeDirectorLlm,
    _internals: {
        llmJson, nextPendingStage, markRemainingSkipped, lastExecutedStage,
        lastDeliveredStage, composeStageTask, statusFromArtifacts,
        fallbackAssessment, assessStage, defaultContribute, budgetsNote,
    },
};
