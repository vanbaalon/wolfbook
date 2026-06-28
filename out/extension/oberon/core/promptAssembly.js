'use strict';
/**
 * Oberon — prompt assembly.
 *
 * Still active:
 *   - buildPlannerPrompt()  — used by core/planner.js
 *   - sha256()              — used by core/fairy.js, core/planner.js, core/executive.js
 *
 * LEGACY (to be removed):
 *   - buildFairyPrompt()    — superseded by fairy/prompts.js (buildExploreUserMessage etc.)
 *                             No callers remain in the active Fairy loop.
 */

const crypto = require('crypto');
const { buildPlannerSystemPrompt } = require('../agents/oberonPlanner.prompt');
const { FAIRY_SYSTEM_PROMPT }   = require('../agents/fairy.prompt');

/**
 * Build the Planner prompt as a sequence of ChatMessages.
 * @param {{ brief: string, contextNote?: string }} args
 * @returns {{ messages: import('../providers/provider').ChatMessage[], prefixSha256: string }}
 */
function buildPlannerPrompt(args) {
    const brief = String((args && args.brief) || '').trim();
    if (!brief) throw new Error('buildPlannerPrompt: brief is empty');

    // The system message IS the stable prefix.
    const systemMsg = { role: 'system', content: buildPlannerSystemPrompt() };

    // User-facing variable suffix.
    const note = args && args.contextNote ? `\n\nProject context:\n${String(args.contextNote).slice(0, 2000)}` : '';
    const userMsg = {
        role: 'user',
        content: `RESEARCH BRIEF:\n\n${brief.slice(0, 8000)}${note}`,
    };

    const prefixSha256 = sha256(systemMsg.content);
    return { messages: [systemMsg, userMsg], prefixSha256 };
}

function sha256(s) {
    return 'sha256:' + crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * Build the Fairy prompt as a sequence of ChatMessages.
 *
 * The system message (FAIRY_SYSTEM_PROMPT) is the stable prefix; the user
 * message embeds the Charm + Quest context as JSON so the Fairy has every
 * field it needs to satisfy the schema.
 *
 * @param {{
 *   charm: object,
 *   quest: object,
 *   contextNote?: string,
 * }} args
 * @returns {{ messages: import('../providers/provider').ChatMessage[], prefixSha256: string }}
 */
function buildFairyPrompt(args) {
    if (!args || !args.charm || !args.quest) {
        throw new Error('buildFairyPrompt: charm and quest are required');
    }
    const systemContent = (args.systemPromptOverride && typeof args.systemPromptOverride === 'string')
        ? args.systemPromptOverride
        : FAIRY_SYSTEM_PROMPT;
    const systemMsg = { role: 'system', content: systemContent };

    // The Charm is self-contained — it carries task, deliverables, constraints,
    // and validationChecks. The Quest block is kept minimal (id + title only)
    // so the Fairy can fill in Scroll.questId and understand its parent context
    // without being distracted by Quest-level successCriteria that belong to
    // other charms or the overall research goal.
    const questContext = {
        id:    args.quest.id,
        title: args.quest.title,
    };
    const charmBlock = {
        id:               args.charm.id,
        title:            args.charm.title,
        task:             args.charm.task,
        deliverables:     args.charm.deliverables     || [],
        constraints:      args.charm.constraints      || [],
        validationChecks: args.charm.validationChecks || [],
    };
    const note = args.contextNote
        ? `\n\nProject context:\n${String(args.contextNote).slice(0, 2000)}`
        : '';
    const userMsg = {
        role: 'user',
        content:
            `QUEST: ${JSON.stringify(questContext)}\n\n` +
            `CHARM:\n${JSON.stringify(charmBlock, null, 2)}${note}`,
    };

    const prefixSha256 = sha256(systemMsg.content);
    return { messages: [systemMsg, userMsg], prefixSha256 };
}

module.exports = { buildPlannerPrompt, buildFairyPrompt, sha256 };
