'use strict';
/**
 * Oberon — Quest naming for the quick-compute (Fairy) path.
 *
 * The full pipeline names quests via the Planner (nice slugs like
 * `Q05_heisenberg_l4_spectrum`). The quick-compute path bypasses the Planner and
 * used to fall back to `Q_<random>_Q_<random>` folders. This helper gives those
 * runs the same treatment:
 *
 *   { id: 'Q05', shortName: 'heisenberg_l4_spectrum' }  →  quests/Q05_heisenberg_l4_spectrum/
 *
 * The leading number is the next free sequential Quest id; the slug is produced by
 * a short LLM call (fairy_summariser role), with a deterministic keyword fallback
 * when the model is unavailable, unconfigured, slow, or returns nothing usable.
 */

const questsFs      = require('../memory/quests');
const roles         = require('../config/roles');
const { getAdapter } = require('../providers');

// Slug stopwords — generic verbs/articles that carry no identifying information.
const STOP = new Set([
    'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'via',
    'using', 'from', 'by', 'at', 'as', 'is', 'are', 'be', 'its', 'their', 'all',
    'compute', 'calculate', 'find', 'determine', 'obtain', 'evaluate', 'derive',
    'then', 'also', 'please', 'this', 'that', 'these', 'those', 'given', 'let',
    'results', 'result', 'value', 'values', 'problem', 'task',
]);

/** Normalise arbitrary text into a filesystem-safe snake_case slug. */
function slugify(text, maxLen = 48) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')   // any run of non-alnum → single underscore
        .replace(/^_+|_+$/g, '')       // trim leading/trailing underscores
        .slice(0, maxLen)
        .replace(/_+$/g, '');          // re-trim if the slice landed on an underscore
}

/** Deterministic slug from the brief's most informative words (no LLM). */
function heuristicSlug(brief) {
    const words = String(brief || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(w => w && !STOP.has(w));
    // Keep short informative tokens; prefer the first few (usually the subject).
    const picked = [];
    for (const w of words) {
        picked.push(w);
        if (picked.join('_').length >= 40 || picked.length >= 6) break;
    }
    return slugify(picked.join('_')) || 'quick_compute';
}

/** Ask the summariser model for a slug. Resolves to '' on any failure. */
async function llmSlug(brief, { timeoutMs = 8000 } = {}) {
    let binding;
    try { binding = roles.resolveRole('fairy_summariser'); } catch (_) { return ''; }
    if (!binding || !binding.configured) return '';
    const adapter = getAdapter(binding.provider);
    if (!adapter || typeof adapter.chatComplete !== 'function') return '';

    const req = {
        messages: [
            { role: 'system', content:
                'You name a scientific computation task with a short folder slug. ' +
                'Reply with ONLY the slug: 2 to 5 words, lowercase, words joined by single ' +
                'underscores, ASCII letters/digits only, max 40 characters. ' +
                'No punctuation, quotes, or explanation.' },
            { role: 'user', content: 'Task:\n' + String(brief || '').slice(0, 600) },
        ],
        model:       binding.model,
        temperature: 0,
        maxTokens:   24,
    };
    try {
        const call = adapter.chatComplete(req, { pricing: binding.pricing });
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('naming timeout')), timeoutMs));
        const result = await Promise.race([call, timeout]);
        const raw = String((result && result.content) || '').split('\n')[0];
        return slugify(raw);
    } catch (_) {
        return '';
    }
}

/**
 * Derive a meaningful, numbered folder name for a quick-compute Quest.
 * @param {string} brief  the task text
 * @param {{ useLLM?: boolean }} [opts]
 * @returns {Promise<{ id: string, shortName: string }>}
 */
async function deriveQuestNaming(brief, opts = {}) {
    const useLLM = opts.useLLM !== false;
    let id = 'Q01';
    try { id = await questsFs.nextQuestId(); } catch (_) {}

    let shortName = '';
    if (useLLM) { try { shortName = await llmSlug(brief); } catch (_) {} }
    if (!shortName) shortName = heuristicSlug(brief);

    return { id, shortName };
}

module.exports = { deriveQuestNaming, slugify, heuristicSlug };
