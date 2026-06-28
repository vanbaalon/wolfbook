'use strict';
/**
 * Oberon — shared research pipeline.
 *
 * `runOneResearch` encapsulates the three-phase pipeline (Planner → Dispatcher
 * → Fairy) and emits the `research.conclusion` event.  It does NOT call
 * `beginRun` or `endRun` — lifecycle management is the caller's responsibility.
 *
 * Usage:
 *   await runManager.beginRun({ brief });
 *   try {
 *     const result = await runOneResearch({ brief, bus, runManager, signal });
 *     // capture stats from runManager.summary and bus.recent() HERE (before endRun)
 *     await runManager.endRun({ state: 'IDLE' });
 *   } catch (e) {
 *     await runManager.endRun({ state: 'ERROR' });
 *     throw e;
 *   }
 */

const { runPlanner }            = require('./planner');
const { buildCharms, dispatchCharms } = require('./dispatcher');
const { runFairy }              = require('./fairy');
const { runReviewLoop } = require('./reviewLoop');
const { synthesizeWardOutFromSkeptic } = require('./wards');
const { runScribe }     = require('./scribe');
const { populateResearchNotebooks } = require('../memory/populateNotebooks');
const grimoire                  = require('../memory/grimoire');

/**
 * Combine two AbortSignals into a single one that fires when either fires.
 * @param {AbortSignal} a
 * @param {AbortSignal} b
 * @returns {AbortSignal}
 */
function combineSignals(a, b) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    if (a.aborted || b.aborted) { ctrl.abort(); return ctrl.signal; }
    a.addEventListener('abort', abort, { once: true });
    b.addEventListener('abort', abort, { once: true });
    return ctrl.signal;
}

/**
 * Run the full Planner → Dispatcher → Fairy pipeline.
 *
 * @param {{
 *   brief:      string,
 *   bus:        import('../telemetry/bus').TelemetryBus,
 *   runManager: import('./runManager').RunManager,
 *   signal?:    AbortSignal | null,
 * }} opts
 * @returns {Promise<{
 *   quest:         object,
 *   charm:         object,
 *   scroll:        object,
 *   scrollFileRef: object,
 *   questFileRef:  object,
 * }>}
 */
async function runOneResearch({ brief, bus, runManager, signal = null }) {
    const ctrl = runManager.newAbortController();
    const effectiveSignal = signal ? combineSignals(ctrl.signal, signal) : ctrl.signal;

    try {
        // ── Phase 1: Planner — brief → Quest ──────────────────────────────
        // Stage-4 S4.5: inject Grimoire summary so the Planner inherits
        // canonical state from prior runs instead of re-discovering it.
        let grimoireContext = '';
        try { grimoireContext = await grimoire.recentEntriesSummary({ limit: 6, maxChars: 2400 }); }
        catch (_) { /* best-effort */ }
        const { quest, fileRef: questFileRef } = await runPlanner({
            brief,
            bus,
            signal: effectiveSignal,
            contextNote: grimoireContext || undefined,
        });
        await runManager.transition('QUEST_DEFINED', { questId: quest.id, file: questFileRef });

        // ── Phase 2: Dispatcher — build all Charms ───────────────────────
        // buildCharms respects quest.subtasks for multi-Charm decomposition;
        // it returns [singleCharm] for focused quests with no subtasks.
        const rawCharms = buildCharms(quest);

        // Per-Charm accumulated results for the merged conclusion.
        const charmResults = [];
        let priorFindingsSummary = ''; // Threaded into each non-first Charm's task.

        for (let ci = 0; ci < rawCharms.length; ci++) {
            const isFirst = ci === 0;
            const isLast  = ci === rawCharms.length - 1;

            // ── Inter-Charm FSM transitions ──────────────────────────────
            // After each non-last reviewLoop the FSM is stuck in REVIEWING.
            // We must return to QUEST_DEFINED before the next CHARM_DISPATCHED.
            if (!isFirst) {
                const prevId = charmResults[ci - 1].charm.id;
                await runManager.transition('DECISION', {
                    questId: quest.id, charmId: prevId,
                    note: `Charm ${ci} complete; advancing to next sub-task`,
                });
                await runManager.transition('GRIMOIRE_UPDATED', { questId: quest.id, charmId: prevId });
                await runManager.transition('QUEST_DEFINED', {
                    questId: quest.id,
                    note: `Starting sub-task ${ci + 1} of ${rawCharms.length}`,
                });
            }

            // ── Dispatch this Charm (write file + emit charm.dispatched) ──
            let charm, charmFileRef;
            try {
                const dispatched = await dispatchCharms({ quest, bus, charms: [rawCharms[ci]] });
                charm        = dispatched[0].charm;
                charmFileRef = dispatched[0].fileRef;
            } catch (e) {
                await bus.appendEvent('omen', {
                    kind:    (e && e.kind) || 'dispatcher_failed',
                    message: e && e.message || String(e),
                    detail:  e && e.detail || null,
                });
                throw e;
            }
            await runManager.transition('CHARM_DISPATCHED', { questId: quest.id, charmId: charm.id });

            // ── Phase 3: Fairy — Charm → Scroll ───────────────────────────
            // If prior Charms ran, prepend their findings as context in the task.
            const charmForFairy = priorFindingsSummary
                ? { ...charm, task: `${charm.task}\n\n---\n${priorFindingsSummary}` }
                : charm;
            await runManager.transition('FAIRY_WORKING', { questId: quest.id, charmId: charm.id });
            const fairyOut = await runFairy({
                quest, charm: charmForFairy, bus,
                signal: effectiveSignal,
            });
            let scroll            = fairyOut.scroll;
            let scrollFileRef     = fairyOut.fileRef;
            let charmNotebookPathLive = fairyOut.notebookPath || null;
            await runManager.transition('SCROLL_SUBMITTED', {
                questId: quest.id, charmId: charm.id, scrollId: scroll.id,
            });

            // ── Phase 4: Skeptic + revision loop + Oberon verdict ─────────
            let reviewOut = null;
            try {
                reviewOut = await runReviewLoop({
                    quest, charm,
                    scroll, scrollFileRef,
                    bus, runManager,
                    signal: effectiveSignal,
                    maxRevisions: 1,
                    charmNotebookPath: charmNotebookPathLive,
                });
                scroll        = reviewOut.scroll;
                scrollFileRef = reviewOut.scrollFileRef;
            } catch (e) {
                await bus.appendEvent('omen', {
                    kind:    'review_loop_failed',
                    message: e && e.message || String(e),
                });
            }

            // ── Phase 4b: Wards ───────────────────────────────────────────
            let wardOut = null;
            try {
                wardOut = synthesizeWardOutFromSkeptic({
                    skeptic: reviewOut && reviewOut.skeptic,
                    quest, charm, scroll,
                });
            } catch (e) {
                try {
                    await bus.appendEvent('omen', {
                        kind:    'wards_synthesise_failed',
                        message: e && e.message || String(e),
                    }, { questId: quest.id, charmId: charm.id });
                } catch (_) {}
            }

            // ── Phase 4c: Scribe ──────────────────────────────────────────
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

            // Build prior-findings context for the next Charm's task.
            if (!isLast && Array.isArray(scroll.findings) && scroll.findings.length) {
                const snippets = scroll.findings.slice(0, 4).map((f, j) => {
                    const claim = typeof f === 'string' ? f : (f.claim || '');
                    return `${j + 1}. ${claim.slice(0, 300)}`;
                });
                priorFindingsSummary =
                    `Prior findings from sub-task ${ci + 1}/${rawCharms.length}:\n${snippets.join('\n')}`;
            }

            charmResults.push({
                charm, charmFileRef, scroll, scrollFileRef,
                reviewOut, wardOut, grimoireResult, charmNotebookPathLive,
            });
        }

        // ── Merge results across all Charms ──────────────────────────────
        const lastResult       = charmResults[charmResults.length - 1];
        const mergedFindings   = charmResults.flatMap(r => r.scroll.findings      || []);
        const mergedEvidence   = charmResults.flatMap(r => r.scroll.evidence      || []);
        const mergedOpenQs     = charmResults.flatMap(r => r.scroll.openQuestions || []);
        const mergedConfidence = Math.min(...charmResults.map(r => r.scroll.confidence || 0));
        const mergedScroll = {
            ...lastResult.scroll,
            findings:      mergedFindings,
            evidence:      mergedEvidence,
            openQuestions: mergedOpenQs,
            confidence:    mergedConfidence,
        };

        // Emit conclusion — must land in log before caller's endRun.
        await bus.appendEvent('research.conclusion', {
            questId:            quest.id,
            scrollId:           lastResult.scroll.id,
            summary:            lastResult.scroll.summary || '',
            confidence:         mergedConfidence,
            findingsCount:      mergedFindings.length,
            evidenceCount:      mergedEvidence.length,
            openQuestionsCount: mergedOpenQs.length,
            charmsRun:          charmResults.length,
            findings: mergedFindings.map(f => ({
                claim:      typeof f === 'string' ? f : (f.claim || ''),
                confidence: typeof f === 'string' ? mergedConfidence : (f.confidence || 0),
            })),
            openQuestions:      mergedOpenQs,
            skepticVerdict:     lastResult.reviewOut && lastResult.reviewOut.skeptic && lastResult.reviewOut.skeptic.verdict || null,
            verificationLevel:  lastResult.reviewOut && lastResult.reviewOut.skeptic && lastResult.reviewOut.skeptic.verificationLevel || null,
            verificationCounts: lastResult.reviewOut && lastResult.reviewOut.skeptic && lastResult.reviewOut.skeptic.verificationCounts || null,
            oberonVerdict:      lastResult.reviewOut && lastResult.reviewOut.oberonVerdict && lastResult.reviewOut.oberonVerdict.verdict || null,
            revisionsUsed:      lastResult.reviewOut && lastResult.reviewOut.revisionsUsed || 0,
            wardSummary:        lastResult.wardOut && lastResult.wardOut.summary || null,
            charmNotebookPath:  lastResult.charmNotebookPathLive,
            criticNotebookPath: lastResult.reviewOut && lastResult.reviewOut.skeptic && lastResult.reviewOut.skeptic.criticNotebookPath || null,
            grimoire:           lastResult.grimoireResult
                ? { wrote:            !!lastResult.grimoireResult.wrote,
                    kind:             lastResult.grimoireResult.kind,
                    findingsWritten:  lastResult.grimoireResult.findingsWritten  || 0,
                    findingsExcluded: lastResult.grimoireResult.findingsExcluded || 0 }
                : null,
        });

        // ── Phase 5: Notebooks — last Charm's notebook + quest summary ───
        let charmNotebookPath   = null;
        let summaryNotebookPath = null;
        try {
            const nb = await populateResearchNotebooks({
                quest,
                charm:     lastResult.charm,
                scroll:    mergedScroll,
                reviewOut: lastResult.reviewOut,
                bus,
                show: true,
                closeCharm: true,
                existingCharmNotebookPath: lastResult.charmNotebookPathLive,
            });
            charmNotebookPath   = nb.charmNotebookPath;
            summaryNotebookPath = nb.summaryNotebookPath;
        } catch (e) {
            try {
                await bus.appendEvent('omen', {
                    kind:    'notebooks_populate_failed',
                    message: e && e.message || String(e),
                }, { questId: quest.id, charmId: lastResult.charm.id });
            } catch (_) {}
        }

        return {
            quest, questFileRef,
            charm:          lastResult.charm,
            scroll:         mergedScroll,
            scrollFileRef:  lastResult.scrollFileRef,
            wardOut:        lastResult.wardOut,
            grimoireResult: lastResult.grimoireResult,
            charmNotebookPath,
            summaryNotebookPath,
        };

    } finally {
        runManager.clearAbortController();
    }
}

module.exports = { runOneResearch };
