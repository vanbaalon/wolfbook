'use strict';
/**
 * Oberon literature — citation-graph expansion & priors (Phase 3).
 *
 *   #4  expandReferences  — backward snowball: the papers a seed CITES become candidates.
 *   #18 expandCitations   — forward snowball: the papers that CITE a confirmed hit.
 *   #12 couplingScore     — bibliographic coupling = Jaccard of two reference-id sets.
 *   #11 rankByPrior       — order candidates by log(citations) + coupling-to-seed.
 *
 * Pure logic; `paperTools` (INSPIRE/Semantic-Scholar clients) and `cache` (#20) are
 * injected, so the whole module is unit-testable offline with fakes.
 */

function _seedKey(s) { return s && (s.arxivId || s.inspireId || s.texkey || s.title) || ''; }
function _hitRef(p)  { return p && (p.arxivId ? `arXiv:${p.arxivId}` : (p.texkey || p.title || '')); }

/** Fetch (cached, permanent) the reference list of a paper, normalized to candidate stubs. */
async function _fetchRefs(seed, paperTools, cache) {
    const id = seed && (seed.arxivId || seed.texkey || seed.inspireId);
    if (!id || typeof paperTools.getInspireReferences !== 'function') return [];
    const refs = await cache.getOrFetch(`refs:${id}`, () => paperTools.getInspireReferences(id), { ttlHours: Infinity });
    return (refs || []).map(r => ({
        arxivId: r.arxivEprint || r.arxivId || null,
        title: r.title || null,
        texkey: r.texkey || null,
        authors: r.authors || [],
    })).filter(r => r.arxivId || r.title);
}

/** #4 Backward snowball: collect the references of each seed as new candidates. */
async function expandReferences({ seeds = [], paperTools, cache, max = 10, maxSeeds = 3 }) {
    const out = [];
    const seen = new Set();
    for (const seed of seeds.slice(0, maxSeeds)) {
        const refs = await _fetchRefs(seed, paperTools, cache);
        for (const r of refs) {
            if (!r.arxivId || seen.has(r.arxivId)) continue;  // need an id to fetch/judge later
            seen.add(r.arxivId);
            out.push({ ...r, foundVia: [`ref:${_seedKey(seed)}`] });
            if (out.length >= max) return out;
        }
    }
    return out;
}

/** #18 Forward snowball: collect papers that CITE each hit as new candidates. */
async function expandCitations({ hits = [], paperTools, cache, max = 8, maxSeeds = 3 }) {
    if (typeof paperTools.getCitationContexts !== 'function') return [];
    const out = [];
    const seen = new Set();
    for (const hit of hits.slice(0, maxSeeds)) {
        const id = hit && hit.arxivId;
        if (!id) continue;
        const citing = await cache.getOrFetch(`cites:${id}`, () => paperTools.getCitationContexts(id), { ttlHours: 24 });
        for (const c of (citing || [])) {
            if (!c.arxivId || seen.has(c.arxivId)) continue;
            seen.add(c.arxivId);
            out.push({
                arxivId: c.arxivId, title: c.title || null,
                foundVia: [`cite:${_hitRef(hit)}`],
                citedByIntents: Array.isArray(c.intents) ? c.intents : [],
            });
            if (out.length >= max) return out;
        }
    }
    return out;
}

/** Aggregate (cached) the citation contexts of a paper into raw intent + sentence lists,
 *  so litRanking can compute method-intent (#13) and canonical-name (#14) signals without
 *  a second network call (reuses the same `cites:<id>` cache key as the forward snowball). */
async function citationSignals(arxivId, paperTools, cache) {
    if (!arxivId || typeof paperTools.getCitationContexts !== 'function') return null;
    const entries = await cache.getOrFetch(`cites:${arxivId}`, () => paperTools.getCitationContexts(arxivId), { ttlHours: 24 });
    if (!entries) return null;
    const allIntents = [], allContexts = [];
    for (const e of entries) {
        for (const i of (e.intents || [])) allIntents.push(i);
        for (const s of (e.contexts || [])) allContexts.push(s);
    }
    return { allIntents, allContexts, citingCount: entries.length };
}

/** #12 Bibliographic coupling: Jaccard overlap of two reference-id sets. */
function couplingScore(refsA, refsB) {
    const A = new Set((refsA || []).filter(Boolean));
    const B = new Set((refsB || []).filter(Boolean));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
}

/**
 * #11 + #12 ordering prior. Enriches the top `max` candidates with `.citations`-based
 * weight and bibliographic `.coupling` to the seed, sets `.prior`/`.scoreParts`, and
 * returns the list sorted best-first (candidates past `max` keep prior 0, appended).
 */
async function rankByPrior(cands, { paperTools, cache, seedRefIds = [], max = 12, wCit = 1, wCoup = 2 } = {}) {
    const head = cands.slice(0, max);
    const tail = cands.slice(max);
    for (const c of head) {
        let coupling = 0;
        if (seedRefIds.length && c.arxivId && typeof paperTools.getInspireReferences === 'function') {
            const refs = await _fetchRefs({ arxivId: c.arxivId }, paperTools, cache);
            coupling = couplingScore(refs.map(r => r.arxivId), seedRefIds);
        }
        const citW = Math.log1p(c.citations || 0);
        c.coupling = coupling;
        c.scoreParts = Object.assign({}, c.scoreParts, { citations: citW, coupling });
        c.prior = wCit * citW + wCoup * coupling;
    }
    head.sort((a, b) => (b.prior || 0) - (a.prior || 0));
    return [...head, ...tail];
}

module.exports = { expandReferences, expandCitations, citationSignals, couplingScore, rankByPrior, _fetchRefs };
