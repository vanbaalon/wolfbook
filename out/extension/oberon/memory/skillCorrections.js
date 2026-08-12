'use strict';
/**
 * Stage A3 (2026-08-04): the skill-correction ledger.
 *
 * The flywheel has an obvious failure mode we hit for real: a published skill
 * containing a WRONG claim is worse than no skill, because it is trusted. When
 * v0.1.0 of the S_n skill asserted "FiniteGroupData has no S_n character table"
 * (false), every run that recalled it inherited the misdiagnosis, and the only
 * reason it got fixed was that a human happened to read a postmortem.
 *
 * This closes that loop: when a run FOLLOWS a skill and the kernel disproves one
 * of its claims (`cite_skill` with disposition 'contradicted'), the contradiction
 * is written here — deduplicated per (skill, claim) — so the author sees a
 * revision queue instead of nothing.
 *
 * Same discipline as the other ledgers: append-only JSONL, bounded read, no
 * network, never blocks a run.
 */

const fsp  = require('fs/promises');
const path = require('path');
const project = require('./project');

function _ledgerPath() {
    const o = project.oberonDir();
    return o ? path.join(o, 'skill_corrections.jsonl') : null;
}

function _key(skillRef, claim) {
    return `${skillRef}|${String(claim || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 100)}`;
}

/** Load all corrections (newest last). */
async function loadCorrections() {
    const p = _ledgerPath();
    if (!p) return [];
    try {
        return (await fsp.readFile(p, 'utf8')).trim().split('\n')
            .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
            .filter(Boolean);
    } catch (_) { return []; }
}

/**
 * Record one contradiction. Deduplicated on (skillRef, normalised claim) so a
 * skill that is wrong in the same way across many runs produces ONE queue entry
 * with a count, not noise.
 *
 * @returns {Promise<{recorded: boolean, deduped?: boolean}>}
 */
async function recordCorrection({ skillRef, claim, questId, charmId, contentHash } = {}) {
    const p = _ledgerPath();
    if (!p || !skillRef || !claim) return { recorded: false };
    const existing = await loadCorrections();
    const k = _key(skillRef, claim);
    if (existing.some(e => _key(e.skillRef, e.claim) === k)) return { recorded: false, deduped: true };
    const entry = {
        skillRef: String(skillRef), claim: String(claim).slice(0, 600),
        contentHash: contentHash || null,
        questId: questId || null, charmId: charmId || null,
        at: new Date().toISOString(),
    };
    try {
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.appendFile(p, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) { return { recorded: false }; }
    return { recorded: true, entry };
}

/** Group by skill: the author's revision queue, most-contradicted first. */
async function correctionQueue() {
    const all = await loadCorrections();
    const bySkill = new Map();
    for (const c of all) {
        if (!bySkill.has(c.skillRef)) bySkill.set(c.skillRef, []);
        bySkill.get(c.skillRef).push(c);
    }
    return [...bySkill.entries()]
        .map(([skillRef, items]) => ({
            skillRef,
            count: items.length,
            lastSeen: items[items.length - 1].at,
            claims: items.map(i => i.claim).slice(0, 8),
        }))
        .sort((a, b) => b.count - a.count || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

function renderCorrectionQueue(queue) {
    if (!queue || !queue.length) return 'No skill contradictions recorded — every cited skill has held up in the kernel.';
    const lines = ['# Skill revision queue — claims the kernel disproved', '',
        'A published skill is trusted by every run that recalls it, so a wrong claim',
        'propagates silently. Each entry below is a run that FOLLOWED the skill and',
        'got refuted. Fix the skill, bump its version, republish.', ''];
    for (const q of queue) {
        lines.push(`## ${q.skillRef} — ${q.count} contradiction(s)`);
        for (const c of q.claims) lines.push(`- ${c}`);
        lines.push('');
    }
    return lines.join('\n');
}

module.exports = { recordCorrection, loadCorrections, correctionQueue, renderCorrectionQueue };
