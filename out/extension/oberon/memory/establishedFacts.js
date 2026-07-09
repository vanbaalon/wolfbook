'use strict';
/**
 * Oberon — Established Facts (cross-charm working memory).
 *
 * Persists verified findings (Skeptic verdict = success, or extracted by
 * the Oberon executive analysis from partial scrolls) so that subsequent
 * Charms in the same Quest do NOT redo work already proven.
 *
 * Storage layout: <workspaceRoot>/quests/<questId>_<shortName>/facts/F<nn>.json
 *
 *   {
 *     id:           "F03",
 *     questId:      "Q12",
 *     sourceCharmId:"C02",
 *     sourceScrollId:"S04",
 *     verified:     true,        // came from a Skeptic-success scroll
 *     confidence:   0.85,
 *     claim:        "The Heisenberg Hamiltonian on the 3-site chain is traceless.",
 *     details:      "Tr[heisenbergH] = 0 (numeric, |.| < 1e-12).",
 *     evidence:     [ ... wolfram expressions used to verify ... ],
 *     writtenAt:    "2026-04-25T12:34:56.000Z",
 *     extractedBy:  "skeptic" | "oberon_executive" | "fairy"
 *   }
 */

const fsp     = require('fs/promises');
const path    = require('path');
const project = require('./project');

function _factsDir({ quest }) {
    const root = project.getWorkspaceRoot();
    if (!root) return null;
    // Canonical folder name — the inline `${quest.shortName}` (no fallback) wrote
    // quick-compute facts to `Qxx_undefined/`, split from the quest's other artefacts.
    return path.join(root, 'quests', require('./quests').questFolderName(quest), 'facts');
}

async function _nextFactId(dir) {
    try {
        const entries = await fsp.readdir(dir);
        const ids = entries
            .map(n => /^F(\d{2,4})\.json$/.exec(n))
            .filter(Boolean)
            .map(m => parseInt(m[1], 10));
        const next = ids.length ? Math.max(...ids) + 1 : 1;
        return `F${String(next).padStart(2, '0')}`;
    } catch (_) { return 'F01'; }
}

/**
 * Append a single fact. Returns the persisted record (or null on failure).
 *
 * @param {{
 *   quest: { id: string, shortName: string },
 *   sourceCharmId?: string,
 *   sourceScrollId?: string,
 *   verified?: boolean,
 *   confidence?: number,
 *   claim: string,
 *   details?: string,
 *   evidence?: string[],
 *   extractedBy?: 'skeptic'|'oberon_executive'|'fairy',
 *   bus?: any,
 * }} opts
 */
async function writeFact(opts) {
    const dir = _factsDir({ quest: opts.quest });
    if (!dir) return null;
    try { await fsp.mkdir(dir, { recursive: true }); } catch (_) {}
    const id   = await _nextFactId(dir);
    const rec = {
        id,
        questId:        opts.quest.id,
        sourceCharmId:  opts.sourceCharmId  || null,
        sourceScrollId: opts.sourceScrollId || null,
        verified:       !!opts.verified,
        confidence:     typeof opts.confidence === 'number' ? opts.confidence : 0,
        claim:          String(opts.claim || '').trim().slice(0, 1200),
        details:        String(opts.details || '').trim().slice(0, 2400),
        evidence:       Array.isArray(opts.evidence) ? opts.evidence.slice(0, 8).map(String) : [],
        writtenAt:      new Date().toISOString(),
        extractedBy:    opts.extractedBy || 'unspecified',
    };
    const file = path.join(dir, `${id}.json`);
    try {
        await fsp.writeFile(file, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    } catch (e) {
        if (opts.bus) {
            try {
                await opts.bus.appendEvent('omen', {
                    kind: 'facts_write_failed',
                    message: e && e.message || String(e),
                }, { questId: opts.quest.id, charmId: opts.sourceCharmId });
            } catch (_) {}
        }
        return null;
    }
    if (opts.bus) {
        try {
            await opts.bus.appendEvent('fact.established', {
                questId: opts.quest.id,
                factId:  id,
                charmId: opts.sourceCharmId,
                claim:   rec.claim.slice(0, 240),
                verified: rec.verified,
                confidence: rec.confidence,
                path: file,
            }, { questId: opts.quest.id, charmId: opts.sourceCharmId });
        } catch (_) {}
    }
    return rec;
}

/** Read all facts for a quest, sorted by id. */
async function readFacts({ quest }) {
    const dir = _factsDir({ quest });
    if (!dir) return [];
    let names;
    try { names = await fsp.readdir(dir); } catch (_) { return []; }
    const facts = [];
    for (const n of names.sort()) {
        if (!/^F\d{2,4}\.json$/.test(n)) continue;
        try {
            const raw = await fsp.readFile(path.join(dir, n), 'utf8');
            facts.push(JSON.parse(raw));
        } catch (_) {}
    }
    return facts;
}

/**
 * Auto-extract facts from a Scroll whose Skeptic verdict was 'success'.
 * Writes each high-confidence finding as a separate fact.
 *
 * @returns {Promise<number>} count of facts written
 */
async function extractFactsFromScroll({ quest, charm, scroll, skResult, bus }) {
    if (!scroll || !Array.isArray(scroll.findings) || !scroll.findings.length) return 0;
    const verdict = skResult && skResult.verdict;
    const verified = verdict === 'success';
    // Be conservative — only auto-promote when Skeptic agrees.
    if (!verified) return 0;

    let written = 0;
    for (const f of scroll.findings) {
        const claim = typeof f === 'string' ? f : (f && f.claim);
        if (!claim) continue;
        const conf = typeof f === 'object' && typeof f.confidence === 'number'
            ? f.confidence
            : (typeof scroll.confidence === 'number' ? scroll.confidence : 0);
        if (conf < 0.6) continue;
        const evidence = (Array.isArray(scroll.evidence) ? scroll.evidence : [])
            .filter(e => e && (e.expression || e.expr))
            .slice(0, 4)
            .map(e => String(e.expression || e.expr));
        const rec = await writeFact({
            quest,
            sourceCharmId:  charm && charm.id,
            sourceScrollId: scroll.id,
            verified:       true,
            confidence:     conf,
            claim,
            details:        (typeof f === 'object' && f.details) ? String(f.details) : '',
            evidence,
            extractedBy:    'skeptic',
            bus,
        });
        if (rec) written++;
    }
    return written;
}

/**
 * Auto-extract WORKING facts from a Scroll whose Skeptic verdict was
 * NOT 'success' (or where there is no Skeptic result). These are stored
 * with `verified:false, extractedBy:'fairy_partial'` so subsequent Charms
 * see them but understand they are provisional.
 *
 * Skipped when the Scroll's confidence is too low to be salvageable, or
 * when the verdict IS success (use extractFactsFromScroll instead).
 *
 * @returns {Promise<number>} count of facts written
 */
async function extractFactsFromPartialScroll({ quest, charm, scroll, skResult, bus, minConfidence = 0.4 }) {
    if (!scroll || !Array.isArray(scroll.findings) || !scroll.findings.length) return 0;
    const verdict = skResult && skResult.verdict;
    if (verdict === 'success') return 0;          // success path handled elsewhere
    const sConf = typeof scroll.confidence === 'number' ? scroll.confidence : 0;
    if (sConf < minConfidence) return 0;

    let written = 0;
    for (const f of scroll.findings) {
        const claim = typeof f === 'string' ? f : (f && f.claim);
        if (!claim) continue;
        const conf = typeof f === 'object' && typeof f.confidence === 'number'
            ? f.confidence
            : sConf;
        if (conf < minConfidence) continue;
        const evidence = (Array.isArray(scroll.evidence) ? scroll.evidence : [])
            .filter(e => e && (e.expression || e.expr))
            .slice(0, 4)
            .map(e => String(e.expression || e.expr));
        const rec = await writeFact({
            quest,
            sourceCharmId:  charm && charm.id,
            sourceScrollId: scroll.id,
            verified:       false,
            confidence:     conf,
            claim,
            details:        (typeof f === 'object' && f.details) ? String(f.details) : '',
            evidence,
            extractedBy:    'fairy_partial',
            bus,
        });
        if (rec) written++;
    }
    return written;
}

/**
 * Build a compact markdown block describing the established facts so
 * far. Used to prepend context to the next Charm's task / next Fairy
 * call. Empty string when there are no facts.
 *
 * Verified facts (Skeptic-confirmed) and working facts (partial /
 * executive-extracted, unverified) are rendered in separate sections
 * so the Fairy can treat them with the appropriate level of trust.
 */
function renderFactsBlock(facts, { maxFacts = 12, maxChars = 2400 } = {}) {
    if (!Array.isArray(facts) || !facts.length) return '';
    const verified  = facts.filter(f => f && f.verified);
    const working   = facts.filter(f => f && !f.verified);
    const lines = [];
    if (verified.length) {
        lines.push('ESTABLISHED FACTS (verified by Skeptic in earlier Charms — DO NOT re-derive):');
        for (const f of verified.slice(0, maxFacts)) {
            const tag = `[${f.id}${f.sourceCharmId ? ' from ' + f.sourceCharmId : ''}]`;
            lines.push(`- ${tag} ${f.claim || ''}`);
            if (f.details) lines.push(`    ${f.details}`);
        }
    }
    if (working.length) {
        if (lines.length) lines.push('');
        lines.push('WORKING NOTES (unverified — extracted from earlier partial results; cross-check before relying on these):');
        for (const f of working.slice(0, maxFacts)) {
            const src = f.extractedBy === 'oberon_executive' ? 'oberon' : 'partial';
            const tag = `[${f.id}${f.sourceCharmId ? ' from ' + f.sourceCharmId : ''} · ${src}]`;
            lines.push(`- ${tag} ${f.claim || ''}`);
            if (f.details) lines.push(`    ${f.details}`);
        }
    }
    const out = lines.join('\n');
    return out.length > maxChars ? out.slice(0, maxChars - 3) + '...' : out;
}

module.exports = { writeFact, readFacts, extractFactsFromScroll, extractFactsFromPartialScroll, renderFactsBlock };
