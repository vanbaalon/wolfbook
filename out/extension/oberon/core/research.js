'use strict';
/**
 * Oberon — research pipeline helpers.
 *
 * The full Planner → Dispatcher → Fairy pipeline lives in `index.js`'s inline
 * runner (the one that actually executes). This module now exports only the two
 * reusable helpers that inline pipeline calls: `clarifyQuestGate` (O2 clarify
 * gate) and `applyDeclaredAssumptions`. The former `runOneResearch` orchestrator
 * was dead (no caller) and depended on the removed Skeptic/Wards layer.
 */

const { runPlanner }            = require('./planner');

/**
 * O2: clarification gate. A Quest flagged CLARIFICATION NEEDED (or carrying
 * missingInfo) must not run on silently-guessed parameters (runs Q21/Q22 guessed
 * L, boundary conditions, and J, and delivered wrong-premise results).
 *
 * Interactive (`askClarify` provided): ONE dialog round; a non-empty answer
 * triggers ONE re-plan with the answers appended to the brief. Headless or
 * dismissed: the Planner's stated defaults become EXPLICIT prose assumptions
 * (`prose: true` — shown to the Fairy and carried into the deliverable header,
 * never evaluated into $Assumptions).
 *
 * @param {{
 *   quest: object, questFileRef: object, brief: string,
 *   bus: object, signal?: AbortSignal,
 *   askClarify?: (args: { quest: object, missingInfo: string[] }) => Promise<string|null>,
 *   contextNote?: string,
 * }} args
 * @returns {Promise<{ quest: object, questFileRef: object, declaredAssumptions: object[] }>}
 */
async function clarifyQuestGate({ quest, questFileRef, brief, bus, signal, askClarify, contextNote }) {
    const needsClarify = (qq) =>
        /^\s*CLARIFICATION NEEDED/i.test((qq && qq.objective) || '')
        || (qq && Array.isArray(qq.missingInfo) && qq.missingInfo.length > 0);

    let declaredAssumptions = [];
    if (!needsClarify(quest)) return { quest, questFileRef, declaredAssumptions };

    const items = (Array.isArray(quest.missingInfo) && quest.missingInfo.length)
        ? quest.missingInfo.slice(0, 8)
        : ['the under-specified parameters named in the objective'];

    let answer = null;
    if (typeof askClarify === 'function') {
        try { answer = await askClarify({ quest, missingInfo: items }); } catch (_) { answer = null; }
    }
    await bus.appendEvent('quest.clarify', {
        questId: quest.id, missingInfo: items, answered: !!(answer && String(answer).trim()),
    }, { questId: quest.id }).catch(() => {});

    let replanFailed = false;
    if (answer && String(answer).trim()) {
        const originalRequirements = {
            successCriteria: Array.isArray(quest.successCriteria) ? quest.successCriteria.slice() : [],
            validationChecks: Array.isArray(quest.validationChecks) ? quest.validationChecks.slice() : [],
            risks: Array.isArray(quest.risks) ? quest.risks.slice() : [],
        };
        // The user took the time to answer — a single provider hiccup must not
        // discard that answer (run Q25: DeepSeek stream timeout → the answer was
        // dropped and every default silently ASSUMED). Retry the re-plan once;
        // if it still fails, carry the answer forward as explicit declarations.
        const replanBrief = `${brief}\n\nCLARIFICATIONS (from the user):\n${String(answer).trim()}`;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const replanned = await runPlanner({ brief: replanBrief, bus, signal, contextNote });
                quest = replanned.quest;
                questFileRef = replanned.fileRef;
                quest.successCriteria = originalRequirements.successCriteria;
                quest.validationChecks = originalRequirements.validationChecks;
                quest.risks = [...new Set([...originalRequirements.risks, ...(quest.risks || [])])].slice(0, 12);
                try { questFileRef = await require('../memory/quests').writeQuest(quest); } catch (_) {}
                await bus.appendEvent('quest.requirements_preserved', {
                    questId: quest.id,
                    successCriteria: quest.successCriteria.length,
                    validationChecks: quest.validationChecks.length,
                    message: 'Clarification replan preserved the original scientific requirements.',
                }, { questId: quest.id }).catch(() => {});
                replanFailed = false;
                break;
            } catch (e) {
                replanFailed = true;
                await bus.appendEvent('omen', {
                    kind: 'clarify_replan_failed',
                    message: `Re-plan with user clarifications failed (attempt ${attempt + 1}/2): ${(e && e.message) || String(e)}`,
                }, { questId: quest.id }).catch(() => {});
                if (signal && signal.aborted) break;
            }
        }
    }

    if (needsClarify(quest)) {
        if (replanFailed && answer && String(answer).trim()) {
            // Re-plan never happened, but the user DID answer: their words become
            // the declared parameters (shown to the Fairy + deliverable header),
            // taking precedence over the planner's guessed defaults.
            const answerLines = String(answer).trim().split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 8);
            declaredAssumptions = answerLines.map((m, i) => ({
                id: `user_clarified_${i + 1}`,
                statement: `USER CLARIFICATION: ${m.slice(0, 480)}`,
                prose: true,
            }));
            await bus.appendEvent('quest.assumed_parameters', {
                questId: quest.id,
                assumptions: declaredAssumptions.map(a => a.statement),
                source: 'user_answer_replan_failed',
            }, { questId: quest.id }).catch(() => {});
            return { quest, questFileRef, declaredAssumptions };
        }
        // Still unresolved → declare the defaults instead of hiding them in prose.
        const src = (Array.isArray(quest.missingInfo) && quest.missingInfo.length)
            ? quest.missingInfo.slice(0, 8) : items;
        declaredAssumptions = src.map((m, i) => ({
            id: `assumed_${i + 1}`,
            statement: `ASSUMED: ${String(m).slice(0, 480)}`,
            prose: true,   // documentation, not a WL expression — never enters $Assumptions
        }));
        await bus.appendEvent('quest.assumed_parameters', {
            questId: quest.id,
            assumptions: declaredAssumptions.map(a => a.statement),
        }, { questId: quest.id }).catch(() => {});
    }
    return { quest, questFileRef, declaredAssumptions };
}

/**
 * O2: apply declared assumptions to freshly-built charms (task banner + the
 * assumptions array that runFairy pre-registers and shows in the deliverable).
 */
function applyDeclaredAssumptions(charms, declaredAssumptions) {
    if (!declaredAssumptions || !declaredAssumptions.length) return charms;
    return charms.map(c => ({
        ...c,
        assumptions: declaredAssumptions,
        task: ('ASSUMED PARAMETERS (declare these in your outputs; they were defaulted, not given):\n'
            + declaredAssumptions.map(a => `- ${a.statement}`).join('\n')
            + '\n\n' + c.task).slice(0, 8000),
    }));
}

module.exports = { clarifyQuestGate, applyDeclaredAssumptions };
