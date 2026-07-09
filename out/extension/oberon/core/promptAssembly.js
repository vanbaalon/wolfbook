'use strict';
/**
 * Oberon — prompt assembly.
 *
 * Still active:
 *   - buildPlannerPrompt()  — used by core/planner.js
 *   - sha256()              — used by core/fairy.js, core/planner.js, core/executive.js
 *
 * (buildFairyPrompt was removed 2026-07-02 — superseded by fairy/prompts.js.)
 */

const crypto = require('crypto');
const { buildPlannerSystemPrompt } = require('../agents/oberonPlanner.prompt');

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

module.exports = { buildPlannerPrompt, sha256 };
