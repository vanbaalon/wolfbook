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
async function runRecall(task, { client, kernelVersion, signal, timeoutMs = 15000, llm = null } = {}) {
    const startMs   = Date.now();
    const recallLog = { startMs, mode: 'none', error: null, searchCount: 0, candidateRef: null, durationMs: 0 };

    // I8 (run Q_2N8616): hard deadline. A slow SkilXiv backend (54s observed) must
    // not stall run start — fail open to mode:'none' and let the run proceed.
    // (I12: callers that inject the skill LATE pass a generous timeoutMs, since the
    // recall no longer blocks run start.)
    let timer = null;
    const deadline = new Promise(resolve => {
        timer = setTimeout(() => resolve({ __recallTimeout: true }), Math.max(1000, timeoutMs));
    });
    try {
        const result = await Promise.race([
            _runRecallInner(task, { client, kernelVersion, signal, llm }, recallLog, startMs),
            deadline,
        ]);
        if (result && result.__recallTimeout) {
            recallLog.error      = `recall timed out after ${timeoutMs}ms (SkilXiv backend slow) — proceeding without a skill`;
            recallLog.durationMs = Date.now() - startMs;
            return { mode: 'none', recallLog };
        }
        return result;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ── I11/S1: capability triage — judge ALL candidates against the task's NEEDS ──
// The hybrid FTS+vector score alone picked an SU(2) skill for an SU(3) task (R5 #7),
// and scores cluster ~0.40–0.44 where ranking noise dominates. Worse, a single
// marginal hit used to MASK real gaps: run Q_3VRPXL needed (a) SU(N) generators in
// an arbitrary irrep, (b) transfer-matrix construction, (c) T-system relations —
// the QQ-system skill loosely covered (c) and gaps (a)/(b) were never surfaced.
//
// One cheap LLM call now: decomposes the task into 2–4 required CAPABILITIES,
// matches each candidate against them with a graded fit (exact/partial), and names
// the capabilities NO candidate covers — the explicit gap list that drives skill
// requests and is shown to the fairy ("no skill exists for X — derive it cleanly").

function _buildTriagePrompt(task, candidates) {
    const lines = candidates.map((c, i) =>
        `[${i}] @${c.namespace}/${c.name}@${c.version} (score ${typeof c.score === 'number' ? c.score.toFixed(2) : '?'}, tier ${c.tier ?? 0})\n     ${(c.summary || '(no summary)').slice(0, 240)}`);
    return [
        `TASK: ${task}`,
        '',
        'Step 1 — list the 2–4 distinct CAPABILITIES this task needs (e.g. "SU(N) generator',
        'construction in a given irrep", "R-matrix/transfer-matrix construction", "T-system',
        'fusion relations", "numerical Bethe-root solving").',
        `Step 2 — below are ${candidates.length} candidate skills from a registry. For each capability,`,
        'pick the candidate (if any) whose METHOD genuinely serves it — same algebra/technique,',
        'not just shared words (an SU(2)-only method does NOT fit an SU(3) task unless it',
        'explicitly generalises). fit "exact" = directly applicable; "partial" = applicable',
        'with adaptation (say what it lacks).',
        'Step 3 — list the capabilities NO candidate covers under "gaps".',
        '',
        'Reply ONLY as JSON:',
        '{"capabilities": ["..."],',
        ' "picks": [{"index": 0, "capability": "...", "fit": "exact|partial", "covers": "one line", "lacks": "one line or null"}],',
        ' "gaps": ["capability with no fitting skill", "..."]}',
        'picks may be empty; at most one pick per capability; at most 2 picks total.',
        '', ...lines,
    ].join('\n');
}

function _parseTriage(text, n) {
    const s = String(text || '').trim();
    // Legacy replies ("2" / "none") still parse — kept for prompt-drift resilience.
    if (/^\s*none\b/i.test(s)) return { pick: null, none: true, picks: [], gaps: [], capabilities: [] };
    try {
        const o = JSON.parse(s.match(/\{[\s\S]*\}/)[0]);
        const capabilities = Array.isArray(o.capabilities)
            ? o.capabilities.map(x => String(x).slice(0, 160)).filter(Boolean).slice(0, 4) : [];
        const gaps = Array.isArray(o.gaps)
            ? o.gaps.map(x => String(x).slice(0, 160)).filter(Boolean).slice(0, 4) : [];
        const seen = new Set();
        const picks = (Array.isArray(o.picks) ? o.picks : [])
            .map(pk => ({
                index:      Number(pk && pk.index),
                capability: String((pk && pk.capability) || '').slice(0, 160),
                fit:        (pk && pk.fit === 'exact') ? 'exact' : 'partial',
                covers:     String((pk && pk.covers) || '').slice(0, 200),
                lacks:      (pk && pk.lacks && !/^null$/i.test(String(pk.lacks))) ? String(pk.lacks).slice(0, 200) : null,
            }))
            .filter(pk => Number.isInteger(pk.index) && pk.index >= 0 && pk.index < n)
            .filter(pk => !seen.has(pk.index) && seen.add(pk.index))
            .slice(0, 2);
        if (!picks.length && !gaps.length && !capabilities.length) {
            // JSON but empty verdict → fall through to legacy index parse below.
        } else {
            return { pick: picks.length ? picks[0].index : null, none: !picks.length, picks, gaps, capabilities };
        }
    } catch (_) { /* not JSON — legacy parse */ }
    const m = s.match(/\d+/);
    if (!m) return null;
    const i = parseInt(m[0], 10);
    return (i >= 0 && i < n) ? { pick: i, none: false, picks: [{ index: i, capability: '', fit: 'partial', covers: '', lacks: null }], gaps: [], capabilities: [] } : null;
}

async function _runRecallInner(task, { client, kernelVersion, signal, llm } = {}, recallLog, startMs) {
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

        // I11: log EVERY candidate + score so recall reliability can be calibrated
        // from telemetry instead of anecdotes.
        recallLog.candidates = candidates.slice(0, 5).map(c => ({
            ref:   `@${c.namespace}/${c.name}@${c.version}`,
            score: (typeof c.score === 'number') ? +c.score.toFixed(4)
                 : (typeof c.similarity === 'number') ? +c.similarity.toFixed(4) : null,
            tier:  c.tier ?? 0,
        }));

        // I11/S1: capability triage across all candidates (falls back to top-1 on
        // any failure). The verdict carries picks (<=2, graded fit) AND gaps — the
        // capabilities no candidate covers.
        let picks = null;          // [{ candidate, fit, covers, lacks, capability }]
        let gaps  = [];
        let capabilities = [];
        if (llm && candidates.length >= 1) {
            try {
                const verdict = _parseTriage(await llm(_buildTriagePrompt(String(task || '').slice(0, 400), candidates)), candidates.length);
                if (verdict) {
                    gaps = verdict.gaps || [];
                    capabilities = verdict.capabilities || [];
                    recallLog.triage = {
                        capabilities,
                        picks: (verdict.picks || []).map(pk => ({
                            ref: `@${candidates[pk.index].namespace}/${candidates[pk.index].name}@${candidates[pk.index].version}`,
                            capability: pk.capability, fit: pk.fit,
                        })),
                        gaps,
                    };
                    if (verdict.none || !(verdict.picks || []).length) {
                        recallLog.error  = 'triage: no candidate genuinely fits the task';
                        recallLog.gaps   = gaps;
                        recallLog.durationMs = Date.now() - startMs;
                        return { mode: 'none', gaps, capabilities, recallLog };
                    }
                    picks = verdict.picks.map(pk => ({ ...pk, candidate: candidates[pk.index] }));
                }
            } catch (_) { /* triage is best-effort — fall through to top-1 */ }
        }

        if (!picks) {
            // No LLM / triage failed: top-1 by score, guarded by the relevance floor.
            // F3: the hybrid FTS+vector score clusters ~0.4; a clearly low top score
            // means "no relevant skill" — don't inject an off-topic block.
            const top = candidates[0];
            const score = (typeof top.score === 'number') ? top.score
                : (typeof top.similarity === 'number') ? top.similarity : null;
            const RELEVANCE_FLOOR = 0.30;   // permissive — agent still judges via cite_skill
            if (score !== null && score < RELEVANCE_FLOOR) {
                recallLog.error = `top score ${score.toFixed(3)} below relevance floor ${RELEVANCE_FLOOR}`;
                recallLog.topScore = score;
                recallLog.durationMs = Date.now() - startMs;
                return { mode: 'none', gaps: [], capabilities: [], recallLog };
            }
            picks = [{ candidate: top, fit: 'partial', covers: '', lacks: null, capability: '' }];
        }
        recallLog.topScore = (typeof picks[0].candidate.score === 'number') ? picks[0].candidate.score
            : (typeof picks[0].candidate.similarity === 'number') ? picks[0].candidate.similarity : null;

        // Fetch full bodies for every picked skill (<=2).
        const skills = [];
        for (const pk of picks) {
            const c = pk.candidate;
            const ref = `@${c.namespace}/${c.name}@${c.version}`;
            let body = '', meta = {};
            try {
                meta = await client.getSkill(c.namespace, c.name, c.version);
                body = meta.body || meta.body_text || '';
            } catch (_) { /* a fetch failure drops this pick */ }
            if (!body) continue;
            skills.push({
                skillRef:    ref,
                contentHash: c.content_hash || null,
                namespace:   c.namespace, name: c.name, version: c.version,
                summary:     c.summary || meta.summary || '',
                license:     c.license || meta.license || '',
                tier:        c.tier ?? meta.tier ?? 0,
                fullBody:    body,
                sections:    parseSkillSections(body),
                fit:         pk.fit,
                covers:      pk.covers || '',
                lacks:       pk.lacks || null,
                capability:  pk.capability || '',
            });
        }
        if (!skills.length) {
            recallLog.error = 'all picked skill bodies failed to fetch';
            recallLog.durationMs = Date.now() - startMs;
            return { mode: 'none', gaps, capabilities, recallLog };
        }

        const primary = skills[0];
        recallLog.mode         = 'consult';
        recallLog.candidateRef = primary.skillRef;
        recallLog.skillCount   = skills.length;
        recallLog.gaps         = gaps;
        recallLog.durationMs   = Date.now() - startMs;

        return {
            mode: 'consult',
            // Back-compat top-level fields = the PRIMARY skill (usage reporting,
            // contribution lineage, skills-used block all key off these).
            skillRef:    primary.skillRef,
            contentHash: primary.contentHash,
            namespace:   primary.namespace,
            name:        primary.name,
            version:     primary.version,
            summary:     primary.summary,
            license:     primary.license,
            tier:        primary.tier,
            fullBody:    primary.fullBody,
            sections:    primary.sections,
            // S1: the full picture — all picked skills (graded) + uncovered capabilities.
            skills,
            gaps,
            capabilities,
            recallLog,
        };

    } catch (e) {
        recallLog.error      = (e && e.message) || String(e);
        recallLog.durationMs = Date.now() - startMs;
        return { mode: 'none', recallLog };
    }
}

module.exports = { runRecall, parseSkillSections, passesVersionFilter, _internals: { _buildTriagePrompt, _parseTriage } };
