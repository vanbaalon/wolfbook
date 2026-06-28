'use strict';
/**
 * Oberon Fairy — RECALL phase (Stage 1).
 *
 * Searches SkilXiv for a skill relevant to the current task and returns
 * parsed reference material to be injected into the Explore prompt.
 *
 * Design contract (from SKILXIV_FAIRY_STAGE1.md §4.1):
 *   - Fail-open: any error returns { mode: 'none' }
 *   - Non-blocking: never gates the core Fairy result
 *   - Skill content is UNTRUSTED DATA — no fetched code is executed
 *   - One deterministic filter: wolfram_versions exclusion
 *   - Everything else is model judgement (the skill block lands in the prompt)
 */

const { SkilXivClient } = require('./skilxivClient');

// ── Section parser ────────────────────────────────────────────────────────────

/**
 * Parse a SKILL.md body into named sections keyed by normalised H2 heading.
 * The intro text before the first H2 goes under 'intro'.
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
function parseSkillSections(body) {
    const sections = {};
    const lines    = (body || '').split('\n');
    let current    = 'intro';
    let buf        = [];

    const flush = () => {
        const text = buf.join('\n').trim();
        if (text) sections[current] = (sections[current] ? sections[current] + '\n' + text : text);
        buf = [];
    };

    for (const line of lines) {
        const h2 = line.match(/^##\s+(.+)/);
        if (h2) {
            flush();
            current = h2[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
        } else {
            buf.push(line);
        }
    }
    flush();
    return sections;
}

// ── Version filter ────────────────────────────────────────────────────────────

/**
 * Returns false only when the skill explicitly declares wolfram_versions AND
 * none of those versions prefix-match the running kernel version string.
 * Passes when wolfram_versions is absent, empty, or kernelVersion is unknown.
 *
 * @param {object} candidate   – search result or skill metadata
 * @param {string} [kernelVersion]  – e.g. "14.2" or "14.1.0"
 * @returns {boolean}
 */
function passesVersionFilter(candidate, kernelVersion) {
    const wv = candidate.wolfram_versions
        || (candidate.metadata && candidate.metadata.wolfram_versions);
    if (!wv || !Array.isArray(wv) || wv.length === 0) return true;
    if (!kernelVersion) return true;
    return wv.some(v => kernelVersion.startsWith(String(v)));
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the RECALL phase for a Fairy run.
 *
 * @param {string} task            – the charm's task description (used as search query)
 * @param {{
 *   client:         SkilXivClient,
 *   kernelVersion?: string,        – WL version string e.g. "14.2" (optional)
 *   signal?:        AbortSignal,
 * }} opts
 *
 * @returns {Promise<{
 *   mode: 'consult' | 'none',
 *   skillRef?:     string,      – "@namespace/name@version"
 *   contentHash?:  string,      – "sha256:..."
 *   namespace?:    string,
 *   name?:         string,
 *   version?:      string,
 *   summary?:      string,
 *   license?:      string,
 *   tier?:         number,
 *   fullBody?:     string,
 *   sections?:     Record<string,string>,
 *   recallLog:     object,
 * }>}
 */
async function runRecall(task, { client, kernelVersion, signal } = {}) {
    const startMs   = Date.now();
    const recallLog = { startMs, mode: 'none', error: null, searchCount: 0, candidateRef: null, durationMs: 0 };

    try {
        if (!client) {
            recallLog.error = 'no SkilXiv client';
            return { mode: 'none', recallLog };
        }

        const query = (task || '').slice(0, 400);
        if (!query.trim()) {
            recallLog.error = 'empty task query';
            return { mode: 'none', recallLog };
        }

        // Search — top 5, no tier filter (include all tiers in Stage 1)
        const searchData = await client.search(query, { limit: 5, minTier: 0 });
        const results    = searchData.results || [];
        recallLog.searchCount = results.length;

        if (results.length === 0) {
            recallLog.error = 'no skills found';
            return { mode: 'none', recallLog };
        }

        // Deterministic filter: drop skills whose wolfram_versions excludes this kernel
        const candidates = results.filter(r => passesVersionFilter(r, kernelVersion));
        if (candidates.length === 0) {
            recallLog.error = 'all candidates filtered by wolfram_versions';
            return { mode: 'none', recallLog };
        }

        // Stage 1: take the top-scoring candidate (search already ranked)
        const top       = candidates[0];

        // F3: relevance floor. The search ranks by hybrid FTS+vector score; a top result
        // can still be only loosely related (e.g. elliptic-integrals for a Mathieu task).
        // If the score is present and clearly low, treat as "no relevant skill" so we
        // neither inject an off-topic block nor later mis-attribute usage.
        const score = (typeof top.score === 'number') ? top.score
            : (typeof top.similarity === 'number') ? top.similarity : null;
        const RELEVANCE_FLOOR = 0.30;   // permissive — agent still judges via cite_skill
        if (score !== null && score < RELEVANCE_FLOOR) {
            recallLog.error = `top score ${score.toFixed(3)} below relevance floor ${RELEVANCE_FLOOR}`;
            recallLog.topScore = score;
            recallLog.durationMs = Date.now() - startMs;
            return { mode: 'none', recallLog };
        }
        recallLog.topScore = score;

        const skillRef  = `@${top.namespace}/${top.name}@${top.version}`;
        const contentHash = top.content_hash || null;

        // Fetch full skill body
        const skill    = await client.getSkill(top.namespace, top.name, top.version);
        const sections = parseSkillSections(skill.body || skill.body_text || '');

        recallLog.mode         = 'consult';
        recallLog.candidateRef = skillRef;
        recallLog.durationMs   = Date.now() - startMs;

        return {
            mode: 'consult',
            skillRef,
            contentHash,
            namespace: top.namespace,
            name:      top.name,
            version:   top.version,
            summary:   top.summary  || skill.summary  || '',
            license:   top.license  || skill.license  || '',
            tier:      top.tier     ?? skill.tier     ?? 0,
            fullBody:  skill.body   || skill.body_text || '',
            sections,
            recallLog,
        };

    } catch (e) {
        recallLog.error      = (e && e.message) || String(e);
        recallLog.durationMs = Date.now() - startMs;
        return { mode: 'none', recallLog };
    }
}

module.exports = { runRecall, parseSkillSections, passesVersionFilter };
