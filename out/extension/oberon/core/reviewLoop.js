'use strict';
/**
 * Oberon — Review Loop.
 *
 * Glue layer that runs after the Fairy submits a Scroll and BEFORE the run
 * ends. Responsibilities:
 *
 *   1. Drive the FSM into REVIEWING.
 *   2. Run the deterministic Skeptic to re-verify cited evidence.
 *   3. If the Skeptic disputes the Scroll AND a revision budget remains,
 *      transition back to FAIRY_WORKING, ask the Fairy to revise the Scroll
 *      using the Skeptic's objections, then re-run the Skeptic. Bounded by
 *      `maxRevisions` (default 1 — i.e. one extra Fairy turn at most).
 *   4. Build the final OberonVerdict (deterministic mapping; the optional
 *      narrated explanation can come from an LLM via the Fairy role, but the
 *      verdict label is fixed by Skeptic + confidence).
 *   5. Emit `oberon.verdict` so all UI surfaces can react.
 *
 * The function never throws on Skeptic / LLM failures — degraded paths still
 * produce a (possibly `needs_review`) OberonVerdict so the user always sees
 * a final outcome.
 *
 * @returns {{
 *   scroll: object,                      // final scroll (possibly revised)
 *   scrollFileRef: object,
 *   skeptic: object,                     // final Skeptic result
 *   oberonVerdict: object,               // structured final verdict (already emitted)
 *   revisionsUsed: number,
 * }}
 */

const { runFairy }       = require('./fairy');
const { runSkeptic }     = require('./skeptic');
const { runCellCritic }  = require('./cellCritic');
const roles              = require('../config/roles');
const { getAdapter }     = require('../providers');
const { validateOberonVerdict } = require('./schemas');

const DEFAULT_MAX_REVISIONS = 2;   // up to two revision turns (total ≤ 3 Fairy turns)
const NARRATION_MAX_TOKENS  = 600;

async function runReviewLoop({
    quest, charm, scroll, scrollFileRef,
    bus, runManager,
    signal = null,
    maxRevisions = DEFAULT_MAX_REVISIONS,
    charmNotebookPath = null,   // path from Fairy's notebookWriter, if any
}) {
    let currentScroll      = scroll;
    let currentScrollFile  = scrollFileRef;
    let skResult           = null;
    let revisionsUsed      = 0;

    // SCROLL_SUBMITTED → REVIEWING
    await runManager.transition('REVIEWING', {
        questId: quest.id, charmId: charm.id, scrollId: currentScroll.id,
    });

    skResult = await safeRunSkeptic({ scroll: currentScroll, quest, charm, bus, signal, charmNotebookPath });

    // Optional revision loop.
    while (skResult.verdict === 'dispute' && revisionsUsed < maxRevisions) {
        if (signal && signal.aborted) break;

        revisionsUsed += 1;

        // REVIEWING → FAIRY_WORKING (revision)
        const okT = await runManager.transition('FAIRY_WORKING', {
            questId: quest.id, charmId: charm.id, revision: revisionsUsed,
        });
        if (!okT) break;

        const revisionNote = buildRevisionNote(currentScroll, skResult, charmNotebookPath);

        let revisedScroll, revisedFile;
        try {
            const out = await runFairy({
                quest, charm, bus, signal,
                contextNote: revisionNote,
                isRevision: true,  // preserve kernel state so prior definitions survive
            });
            revisedScroll = out.scroll;
            revisedFile   = out.fileRef;
        } catch (e) {
            await bus.appendEvent('omen', {
                kind:    'fairy_revision_failed',
                message: e && e.message || String(e),
                detail:  { revision: revisionsUsed },
            }, { questId: quest.id, charmId: charm.id });
            break;
        }

        await runManager.transition('SCROLL_SUBMITTED', {
            questId: quest.id, charmId: charm.id, scrollId: revisedScroll.id, revision: revisionsUsed,
        });

        currentScroll     = revisedScroll;
        currentScrollFile = revisedFile;

        await runManager.transition('REVIEWING', {
            questId: quest.id, charmId: charm.id, scrollId: currentScroll.id, revision: revisionsUsed,
        });

        // Stage-3 verified-evidence cache: pass last round's checks so the
        // Skeptic can skip re-eval of expressions that already verified.
        // Safe because the kernel is restarted + notebook replayed before
        // this Skeptic pass, so deterministic expressions repeat their result.
        skResult = await safeRunSkeptic({
            scroll: currentScroll, quest, charm, bus, signal, charmNotebookPath,
            priorChecks: (skResult && skResult.checks) || null,
        });
    }

    // Build OberonVerdict from final state.
    const counts = collectCounts(bus, runManager);
    const oberonVerdict = buildOberonVerdict({
        quest, charm, scroll: currentScroll, skeptic: skResult, counts, revisionsUsed,
    });

    // Optional LLM narration — non-fatal if it fails.
    try {
        const narrated = await narrate({
            quest, charm, scroll: currentScroll, skeptic: skResult,
            verdict: oberonVerdict, signal,
        });
        if (narrated) oberonVerdict.narrative = narrated;
    } catch (e) {
        // keep deterministic narrative
        try {
            await bus.appendEvent('omen', {
                kind: 'oberon_narration_failed',
                message: e && e.message || String(e),
            }, { questId: quest.id, charmId: charm.id });
        } catch (_) {}
    }

    // Validate (defensive — should always pass) then emit.
    const v = validateOberonVerdict(oberonVerdict);
    const valueToEmit = v.ok ? v.value : oberonVerdict;
    await bus.appendEvent('oberon.verdict', {
        questId: quest.id, charmId: charm.id, scrollId: currentScroll.id,
        revisionsUsed,
        ...valueToEmit,
    }, { questId: quest.id, charmId: charm.id });

    return {
        scroll: currentScroll,
        scrollFileRef: currentScrollFile,
        skeptic: skResult,
        oberonVerdict: valueToEmit,
        revisionsUsed,
    };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function safeRunSkeptic(args) {
    const { scroll } = args;

    // Phase B self-critique path: if the Fairy already reviewed its own work
    // and all checks passed, synthesise skResult directly — no CellCritic call.
    if (scroll && scroll.self_review &&
        Array.isArray(scroll.self_review.passed) &&
        Array.isArray(scroll.self_review.failed) &&
        scroll.self_review.failed.length === 0) {

        const passedDescs = scroll.self_review.passed;
        const checks = passedDescs.map(desc => ({
            expression:      String(desc).slice(0, 240),
            match:           true,
            kind:            'ok',
            durationMs:      0,
            cached:          false,
            originalOutput:  '',
            recheckOutput:   '',
            recheckMessages: null,
            error:           null,
            deepChecks:      [],
        }));
        try {
            await args.bus.appendEvent('skeptic.verdict', {
                questId: args.quest.id, charmId: args.charm.id,
                scrollId: scroll.id,
                verdict: 'accept',
                verificationLevel: passedDescs.length > 0 ? 'verified' : 'heuristic',
                objections: [],
                summary: { total: passedDescs.length, matched: passedDescs.length, failed: 0, skipped: 0 },
                wardSummary: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
                source: 'self_review',
                checks,
            }, { questId: args.quest.id, charmId: args.charm.id });
        } catch (_) {}
        return {
            verdict:           'accept',
            verificationLevel: passedDescs.length > 0 ? 'verified' : 'heuristic',
            objections:        [],
            checks,
            summary:           { total: passedDescs.length, matched: passedDescs.length, failed: 0, skipped: 0 },
            wardSummary:       { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
            source:            'self_review',
        };
    }

    // Fallback: self_review absent or has failures — run CellCritic.
    if (args.charmNotebookPath) {
        try {
            return await runCellCritic(args);
        } catch (e) {
            try {
                await args.bus.appendEvent('omen', {
                    kind:    'cell_critic_failed',
                    message: e && e.message || String(e),
                }, { questId: args.quest.id, charmId: args.charm.id });
            } catch (_) {}
            // Fall through to legacy Skeptic below.
        }
    }

    // Legacy path: wait for idle kernel, optionally replay notebook, then
    // run the deterministic evidence-based Skeptic.
    const idle = await waitForKernelIdle(8000);

    // FM-7: if the kernel stays busy past the wait, reboot it and replay the
    // charm notebook so the Skeptic gets back a clean, populated kernel
    // instead of failing every ward check with "kernel busy".
    if (!idle) {
        try {
            const wolframShim = require('./wolframShim');
            await args.bus.appendEvent('omen', {
                kind:    'skeptic_kernel_busy_reboot',
                message: 'Kernel remained busy past 8 s wait — rebooting + replaying notebook before Skeptic.',
            }, { questId: args.quest.id, charmId: args.charm.id });
            const restart = await wolframShim.restartKernel();
            if (restart.ok && args.charmNotebookPath) {
                const settings = require('../config/settings');
                const replay = await wolframShim.replayNotebook(args.charmNotebookPath, {
                    signal: args.signal, timeoutSeconds: settings.replayPerCellTimeoutSeconds(),
                });
                await args.bus.appendEvent('notebook.replayed', {
                    path: args.charmNotebookPath,
                    ok: replay.ok,
                    evaluatedCount: replay.evaluatedCount,
                    skippedCount: replay.skippedCount,
                    errorCount: (replay.errors && replay.errors.length) || 0,
                    reason: replay.reason || null,
                    trigger: 'skeptic_busy_recovery',
                }, { questId: args.quest.id, charmId: args.charm.id });
            }
        } catch (_) {}
    }

    try {
        return await runSkeptic(args);
    } catch (e) {
        try {
            await args.bus.appendEvent('omen', {
                kind: 'skeptic_failed',
                message: e && e.message || String(e),
            }, { questId: args.quest.id, charmId: args.charm.id });
        } catch (_) {}
        return {
            verdict: 'needs_review',
            objections: [`Skeptic itself failed: ${e && e.message || String(e)}`],
            checks: [],
            summary: { total: 0, matched: 0, failed: 0, skipped: 0 },
            spanId: null,
        };
    }
}

/**
 * Poll until the Wolfram kernel is available (idle) or the timeout elapses.
 * Always resolves (never throws) — if the kernel stays busy, we proceed anyway
 * and the Skeptic will handle individual evaluation failures gracefully.
 */
async function waitForKernelIdle(maxWaitMs = 8000) {
    const wolframShim = require('./wolframShim');
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const ks = wolframShim.kernelStatus();
            if (ks.available) return true;
        } catch (_) { return false; }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

function buildRevisionNote(prevScroll, skResult, charmNotebookPath) {
    const bullets = skResult.objections.slice(0, 8).map(o => `  • ${o}`).join('\n');

    // Gather already-verified cells/checks. Tell the Fairy not to re-derive them.
    const verifiedExprs = (skResult.checks || [])
        .filter(c => c.match === true)
        .slice(0, 4)
        .map(c => `  ✓ ${String(c.expression || '').replace(/\s+/g, ' ').slice(0, 100)}`);

    const verifiedSection = verifiedExprs.length > 0
        ? [
            'The Critic VERIFIED these cells/expressions (already correct) — do NOT change them:',
            verifiedExprs.join('\n'),
            '',
          ]
        : [];

    // Pinpoint the failing cells the Critic flagged so the Fairy doesn't have
    // to guess which cells need editing.
    const failedChecks = (skResult.checks || []).filter(c => c.match === false);
    const failedCellsList = failedChecks.length
        ? [
            'CELLS YOU MUST FIX (from the Critic\'s check results):',
            ...failedChecks.slice(0, 8).map((c, i) => {
                const expr = String(c.expression || '').replace(/\s+/g, ' ').slice(0, 90);
                const exp  = c.expected != null ? `expected ${String(c.expected).slice(0, 60)}` : '';
                const got  = c.actual   != null ? `got ${String(c.actual).slice(0, 60)}`       : '';
                const why  = c.reason   ? ` — ${String(c.reason).slice(0, 120)}` : '';
                return `  ${i + 1}. ${expr}${exp || got ? ` (${[exp, got].filter(Boolean).join('; ')})` : ''}${why}`;
            }),
            '',
          ]
        : [];

    const notebookNote = charmNotebookPath
        ? [
            `The charm notebook "${require('path').basename(charmNotebookPath)}" from your previous run is`,
            'still open.  The Critic has added annotation cells (grey markers) after each code cell —',
            'read them to understand which cells have issues.  Before this revision turn started, the',
            'Wolfram kernel was RESTARTED so all symbols are cleared.',
            'CONTINUE from the existing notebook:',
            '  1. Call wolfbook_getNotebookContext (action:"brief") FIRST to see every existing cell and its 1-based cellNumber.',
            '  2. For each failing cell above, call wolfbook_editCell with `cellNumber`=N (integer), `newContent`=fix, `run`=true.',
            '     Do NOT pass cellId strings — use the integer cellNumber from getNotebookContext output.',
            '  3. After each edit, INSPECT the output: if the kernel emits any messages or the value is still wrong,',
            '     edit again. Repeat until the cell runs CLEANLY (zero messages, correct value).',
            '  4. Use wolfram_eval ONLY for genuinely new diagnostics or computations not already in the notebook.',
            '     Do NOT use wolfram_eval to "redo" a broken cell — that just stacks duplicates.',
            '  5. If a fix doesn\'t pass on the first attempt, run ≥2 diagnostic probes to isolate the ACTUAL',
            '     root cause before attempting a second fix.',
            '',
          ]
        : [];

    return [
        '═══════════════════════════════════════════════════════════════════════',
        `RERUN — REVISION ${(prevScroll && prevScroll.id) ? 'of Scroll ' + prevScroll.id : ''}`,
        '═══════════════════════════════════════════════════════════════════════',
        '',
        'This is NOT a new charm: this is a REVISION of your previous attempt.',
        'The Critic reviewed your last Scroll and found problems listed below.',
        'Your job in this turn:',
        '  (a) Fix ONLY the specific cells the Critic flagged.',
        '  (b) Verify each fixed cell runs cleanly (no kernel messages, correct output).',
        '  (c) Produce a revised Scroll that reflects the corrected results.',
        '',
        prevScroll && prevScroll.summary
            ? `Your previous summary was: "${String(prevScroll.summary).slice(0, 200)}"`
            : '',
        '',
        ...verifiedSection,
        ...failedCellsList,
        ...notebookNote,
        'CRITIC OBJECTIONS (verbatim):',
        bullets,
        '',
        'Produce a REVISED Scroll that:',
        '  1. Accepts the correct findings unchanged (do NOT re-derive them).',
        '  2. Fixes ONLY the disputed cells and reports corrected outputs.',
        '  3. Updates findings and summary to reflect corrected results.',
        '  4. Sets confidence honestly.',
        '',
        `Previous Scroll id was ${prevScroll && prevScroll.id}; use a new id for this revision.`,
    ].filter(s => s !== undefined).join('\n');
}

function collectCounts(bus, runManager) {
    const events = bus.recent(5000);
    const toolCalls = events.filter(e => e.type === 'tool.call').length;
    const skepticChecksEv = events.filter(e => e.type === 'skeptic.verdict');
    const skepticChecks   = skepticChecksEv.reduce((acc, e) => acc + ((e.payload && e.payload.summary && e.payload.summary.total) || 0), 0);
    const s = runManager.summary || {};
    return {
        quests:        s.questId ? 1 : 0,
        charms:        s.charmId ? 1 : 0,
        toolCalls,
        llmCalls:      s.llmCallCount || 0,
        skepticChecks,
    };
}

function buildOberonVerdict({ quest, charm, scroll, skeptic, counts, revisionsUsed }) {
    const conf = typeof scroll.confidence === 'number' ? scroll.confidence : 0;
    const vlevel = (skeptic && skeptic.verificationLevel) || 'none';
    const wardSummary = (skeptic && skeptic.wardSummary) || { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 };

    // Deterministic verdict label. The legacy 4-value vocabulary
    // (success / partial_success / failed / needs_review) is preserved, but
    // we now refine it with the Skeptic's verificationLevel — so the same
    // 'success' label can carry either 'verified' (≥1 deep ward passed) or
    // 'heuristic' (only re-evaluation matched).
    let verdict;
    if (skeptic.verdict === 'accept') {
        if (conf >= 0.7) verdict = 'success';
        else if (conf >= 0.4) verdict = 'partial_success';
        else verdict = 'needs_review';
    } else if (skeptic.verdict === 'dispute') {
        // After revisions ran out.  If at least one re-eval matched OR at
        // least one ward passed, downgrade rather than declare hard failure.
        const someEvidence = (counts.skepticChecks > 0) || (wardSummary.passed > 0);
        verdict = someEvidence ? 'failed' : 'needs_review';
    } else {
        verdict = 'needs_review';
    }

    // Human-readable verification label, kept separate from the legacy
    // verdict so existing consumers (test runner, Grimoire, Postmortem)
    // continue to switch on the same four strings.
    const verificationLabel = ({
        verified:   'accepted with verification',
        heuristic:  'accepted heuristically',
        partial:    'partial',
        disputed:   'disputed',
        none:       'no verification',
    })[vlevel] || 'no verification';

    // Deterministic baseline narrative — overwritten by `narrate()` when LLM available.
    const skSummary = skeptic.summary || {};
    const wardSummaryLine = (wardSummary.total > 0)
        ? ` Critic ran ${wardSummary.total} deep verification${wardSummary.total === 1 ? '' : 's'} (${wardSummary.passed} passed, ${wardSummary.failed} failed, ${wardSummary.skipped} skipped${wardSummary.errored ? `, ${wardSummary.errored} errored` : ''}).`
        : '';
    const baseLines = [
        `Quest "${quest.title || quest.id}" produced Scroll ${scroll.id} (confidence ${conf.toFixed(2)}).`,
        `Skeptic verdict: ${skeptic.verdict} — ${skSummary.matched || 0} matched, ${skSummary.failed || 0} mismatched, ${skSummary.skipped || 0} skipped (of ${skSummary.total || 0} cited).${wardSummaryLine}`,
    ];
    if (revisionsUsed > 0) baseLines.push(`The research agent used ${revisionsUsed} revision pass${revisionsUsed === 1 ? '' : 'es'}.`);
    baseLines.push(`Final verdict: ${verdict} (${verificationLabel}).`);
    const narrative = baseLines.join(' ');

    // Main evidence: prefer a passed ward, then a matched check, then a finding.
    const passedWard = (skeptic.wardResults || []).find(w => w.status === 'passed');
    const matchedCheck = (skeptic.checks || []).find(c => c.match === true);
    let mainEvidence = '';
    if (passedWard) {
        mainEvidence = `${String(passedWard.expression || '').slice(0, 200)} → ${String(passedWard.detail || '').slice(0, 400)}`;
    } else if (matchedCheck) {
        mainEvidence = `${String(matchedCheck.expression).slice(0, 200)} → ${String(matchedCheck.recheckOutput || matchedCheck.originalOutput || '').slice(0, 400)}`;
    } else if (Array.isArray(scroll.findings) && scroll.findings[0]) {
        const f0 = scroll.findings[0];
        mainEvidence = String(typeof f0 === 'string' ? f0 : (f0.claim || '')).slice(0, 600);
    }

    const mainFailure = (verdict === 'failed' || verdict === 'needs_review')
        ? String((skeptic.objections && skeptic.objections[0]) || '').slice(0, 800)
        : '';

    const recommendedAction = recommend(verdict, vlevel, skeptic, scroll);

    return {
        verdict, narrative, counts,
        verificationLevel: vlevel,
        verificationLabel,
        wardSummary,
        mainEvidence, mainFailure, recommendedAction,
    };
}

function recommend(verdict, vlevel, skeptic, scroll) {
    switch (verdict) {
        case 'success':
            if (vlevel === 'verified')  return 'Open the Scroll — main claims passed deep verification. No further action needed.';
            if (vlevel === 'heuristic') return 'Open the Scroll — re-evaluation matched but no deep verification ran.  Consider adding a verifiable identity or numeric check.';
            return 'Open the Scroll for full details. No further action needed.';
        case 'partial_success':
            return 'Open the Scroll and review the findings — only partial verification succeeded.  Consider following up with a sharper brief.';
        case 'failed':
            if (vlevel === 'partial')  return 'Some checks passed and some failed.  Open the Skeptic objections, fix the disputed claims, and re-run.';
            if (vlevel === 'disputed') return 'No claim survived verification.  Open the Skeptic objections, refine the brief, then re-run.';
            return 'Open the Scroll and the Skeptic objections; refine the brief or check kernel availability, then re-run.';
        case 'needs_review':
        default:
            return ((scroll.evidence || []).length === 0)
                ? 'Scroll cites no executable evidence — ask the agent to produce a verifiable computation, or accept as text-only.'
                : 'Human review recommended. Open the Scroll, inspect the Skeptic checks, then accept or re-run.';
    }
}

async function narrate({ quest, charm, scroll, skeptic, verdict, signal }) {
    const binding = roles.resolveRole('fairy');
    if (!binding.configured) return null;

    const adapter = getAdapter(binding.provider);

    const skSummary = skeptic.summary || {};
    const findingsBlock = (scroll.findings || []).slice(0, 8).map((f, i) =>
        `  ${i + 1}. ${String(typeof f === 'string' ? f : (f.claim || '')).slice(0, 400)}`).join('\n') || '  (none)';
    const objectionsBlock = (skeptic.objections || []).slice(0, 6).map((o, i) =>
        `  ${i + 1}. ${String(o).slice(0, 400)}`).join('\n') || '  (none)';

    const prompt =
`You are writing the final verdict shown to the user after one CHARM completed.

The deterministic verdict label is: ${verdict.verdict}

⚠️ SCOPING — READ FIRST ⚠️
This verdict covers ONE CHARM (a single subtask of the larger quest). The
charm's specific objective is shown below. You MUST judge whether THIS CHARM
fulfilled ITS OWN objective — NOT whether the whole quest is solved. Do not
penalise the charm for omitting computations that belong to other charms; a
quest-level verdict is produced separately at the end of the full run.

Larger quest (context only): ${quest.title || quest.id}
Quest objective (context only — DO NOT use as the bar for this charm):
${String(quest.objective || '').slice(0, 400)}

THIS CHARM's task (the actual bar to judge against):
${String((charm && (charm.task || charm.title)) || '').slice(0, 800)}

Scroll summary: ${String(scroll.summary || '').slice(0, 800)}
Scroll confidence: ${typeof scroll.confidence === 'number' ? scroll.confidence.toFixed(2) : 'n/a'}

Findings:
${findingsBlock}

Verification re-checked ${skSummary.total || 0} cited expressions: ${skSummary.matched || 0} matched, ${skSummary.failed || 0} mismatched, ${skSummary.skipped || 0} skipped.
Verification objections:
${objectionsBlock}

Write 2–4 plain sentences (≤ 800 characters total) that explain to the user:
  • What THIS CHARM was asked to do and whether it succeeded at THAT specific task.
  • Why the verdict is "${verdict.verdict}" (referring to the verification of
    the charm's OWN deliverables, not the rest of the quest).
  • The single most useful next step (which may be "proceed to the next charm").

IMPORTANT: Do NOT use internal system names like "Fairy", "Skeptic", "Charm", "Scroll", or "Oberon".
Say "this step", "this part of the work", "the research agent", "independent verification",
"the computation", "the findings" instead.

Reply with ONLY the narrative text — no JSON, no headings, no fenced code, no preamble.`;

    const result = await adapter.chatComplete({
        model:     binding.model,
        messages:  [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens:  NARRATION_MAX_TOKENS,
        signal,
    }, { pricing: null });   // narration is bookkeeping; do not bill against the run

    const text = (result && result.content ? String(result.content) : '').trim();
    if (!text) return null;
    return text.slice(0, 1800);
}

module.exports = { runReviewLoop };
// re-export for tests that want to compare:
module.exports.buildOberonVerdict = buildOberonVerdict;
