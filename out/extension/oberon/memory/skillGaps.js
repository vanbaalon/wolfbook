'use strict';
/**
 * Oberon — skill-gap ledger (I13/I20).
 *
 * When a run needed a reusable skill that the registry could not supply — either
 * detected by the harness (recall found nothing relevant for a task that then
 * DELIVERED, i.e. the knowledge provably exists now) or declared by the agent
 * (`note_skill_gap` tool) — the gap is recorded:
 *
 *   1. LOCALLY, always: appended to `.oberon/skill_gaps.jsonl` (the durable record
 *      the user can review and turn into skills).
 *   2. REMOTELY, best-effort: POST /api/v1/skill-requests via the SkilXiv client,
 *      so the registry accumulates a demand signal. Failure is swallowed — the
 *      endpoint may not exist yet.
 *
 * Dedupe: a gap with a near-identical topic already in the ledger is not re-added
 * (returns { deduped: true }), so repeated runs of the same task don't spam.
 */

const path = require('path');
const fsp  = require('fs/promises');
const project = require('./project');

/** Cheap token-Jaccard for topic dedupe (mirrors tools.utilSimilarity semantics). */
function _similarity(a, b) {
    const tok = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9$]+/g) || []);
    const A = tok(a), B = tok(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
}

function _ledgerPath() {
    const o = project.oberonDir();
    return o ? path.join(o, 'skill_gaps.jsonl') : null;
}

/** Load all recorded gaps (newest last). Returns [] when the ledger is absent. */
async function loadSkillGaps() {
    const p = _ledgerPath();
    if (!p) return [];
    try {
        return (await fsp.readFile(p, 'utf8')).trim().split('\n')
            .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
            .filter(Boolean);
    } catch (_) { return []; }
}

/**
 * Record one skill gap.
 *
 * @param {{
 *   topic:    string,          // what the missing skill should cover
 *   why?:     string,          // one sentence on the observed gap
 *   task?:    string,          // the run's task text (context)
 *   source:   'harness' | 'agent',
 *   questId?: string, charmId?: string,
 *   client?:  { requestSkill?: Function },   // optional SkilXiv client
 * }} args
 * @returns {Promise<{ recorded: boolean, deduped?: boolean, remote?: boolean, entry?: object }>}
 */
async function recordSkillGap({ topic, why = '', task = '', source = 'harness', questId, charmId, client } = {}) {
    const t = String(topic || task || '').trim();
    if (!t) return { recorded: false };

    const prior = await loadSkillGaps();
    for (const g of prior) {
        if (g && g.topic && _similarity(g.topic, t) >= 0.6) {
            return { recorded: false, deduped: true, entry: g };
        }
    }

    const entry = {
        topic:   t.slice(0, 200),
        why:     String(why || '').slice(0, 500),
        task:    String(task || '').slice(0, 400),
        source,
        questId: questId || null,
        charmId: charmId || null,
        at:      new Date().toISOString(),
    };

    const p = _ledgerPath();
    if (p) {
        try {
            await fsp.mkdir(path.dirname(p), { recursive: true });
            await fsp.appendFile(p, JSON.stringify(entry) + '\n', 'utf8');
        } catch (_) { /* local write is best-effort too */ }
    }

    let remote = false;
    if (client && typeof client.requestSkill === 'function') {
        try {
            await client.requestSkill({ topic: entry.topic, context: entry.why || entry.task });
            remote = true;
        } catch (_) { /* endpoint may not exist — the local ledger is the record */ }
    }

    return { recorded: true, remote, entry };
}

module.exports = { recordSkillGap, loadSkillGaps, _internals: { _similarity } };
