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
 *   2. REMOTELY only after explicit human consent. Merely recording a gap never
 *      uploads task-derived text.
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
async function recordSkillGap({ topic, why = '', task = '', source = 'harness', questId, charmId, client, remoteApproved = false } = {}) {
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
    if (remoteApproved && client && typeof client.requestSkill === 'function') {
        try {
            await client.requestSkill({ topic: entry.topic, context: entry.why || entry.task, consentToPublish: true });
            remote = true;
        } catch (_) { /* endpoint may not exist — the local ledger is the record */ }
    }

    return { recorded: true, remote, pendingConsent: !remote, entry };
}

async function submitSkillGap(entry, client) {
    if (!entry || !client || typeof client.requestSkill !== 'function') return { submitted: false };
    const result = await client.requestSkill({ topic: entry.topic, context: entry.why || entry.task, consentToPublish: true });
    return { submitted: true, result };
}

/**
 * Stage A1 (2026-08-04): CONSUME the gap ledger.
 *
 * The ledger accumulated 78 entries with zero readers — the same write-only
 * pathology the lessons channel had. A gap that is recorded but never surfaced
 * teaches nobody. This clusters near-duplicate topics (the recorder dedups only
 * against recent entries, so the same capability recurs across months), ranks by
 * demand, and returns the authoring queue for the skill flywheel.
 *
 * Ranking is deliberately simple and explainable: how many distinct RUNS wanted
 * this capability, tie-broken by recency. No scoring model to drift.
 *
 * @param {{ minCount?: number, limit?: number, sinceDays?: number|null }} opts
 * @returns {Promise<Array<{topic, count, runs, lastSeen, examples, tasks}>>}
 */
async function rankSkillGaps({ minCount = 1, limit = 20, sinceDays = null } = {}) {
    const all = await loadSkillGaps();
    const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : null;
    const rows = all.filter(g => {
        if (!g || !g.topic) return false;
        if (!cutoff) return true;
        const t = Date.parse(g.at || '');
        return Number.isFinite(t) ? t >= cutoff : true;
    });

    const clusters = [];
    for (const g of rows) {
        // Cluster by topic similarity — the same capability is phrased slightly
        // differently by each run that needs it.
        const hit = clusters.find(c => _similarity(c.topic, g.topic) >= 0.5);
        if (hit) {
            hit.members.push(g);
            if (String(g.topic).length < String(hit.topic).length) hit.topic = g.topic;  // shortest phrasing wins
        } else {
            clusters.push({ topic: g.topic, members: [g] });
        }
    }

    return clusters
        .map(c => {
            const runs = new Set(c.members.map(m => m.questId).filter(Boolean));
            const times = c.members.map(m => Date.parse(m.at || '')).filter(Number.isFinite);
            return {
                topic:    c.topic,
                count:    c.members.length,
                runs:     runs.size || c.members.length,
                lastSeen: times.length ? new Date(Math.max(...times)).toISOString() : null,
                examples: [...new Set(c.members.map(m => m.topic))].slice(0, 4),
                tasks:    [...new Set(c.members.map(m => m.task).filter(Boolean))].slice(0, 3),
            };
        })
        .filter(c => c.runs >= minCount)
        .sort((a, b) => (b.runs - a.runs) || (b.count - a.count)
            || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
        .slice(0, limit);
}

/** Human-readable authoring queue (Control Room / command output / ledger). */
function renderGapQueue(ranked) {
    if (!ranked || !ranked.length) return 'No skill gaps recorded yet.';
    const lines = ['# Skill-gap queue — candidate skills to author', '',
        'Ranked by how many distinct runs needed the capability. Author the top of',
        'this list, kernel-verify every claim, publish, then re-run the task that',
        'filed it: that is the flywheel.', ''];
    ranked.forEach((c, i) => {
        lines.push(`## ${i + 1}. ${c.topic}`);
        lines.push(`- wanted by **${c.runs} run(s)** (${c.count} filing(s)); last ${String(c.lastSeen || '').slice(0, 10)}`);
        if (c.examples.length > 1) lines.push(`- phrasings: ${c.examples.map(e => `"${e}"`).join('; ')}`);
        if (c.tasks.length) lines.push(`- seen in: ${c.tasks.map(t => `"${String(t).slice(0, 90)}"`).join('; ')}`);
        lines.push('');
    });
    return lines.join('\n');
}

module.exports = { recordSkillGap, loadSkillGaps, submitSkillGap, rankSkillGaps, renderGapQueue, _internals: { _similarity } };
