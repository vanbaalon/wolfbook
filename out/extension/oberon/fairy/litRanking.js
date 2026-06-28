'use strict';
/**
 * Oberon literature — citation-intelligence ranking (Phase 4). Pure, no I/O.
 *
 *   #13 methodIntentFraction  — fraction of citations that use the paper as METHODOLOGY.
 *   #14 canonicalFromContexts — how often the paper is cited *for* the task's named method.
 *   #15 isReview              — review/lecture-note detection (field hubs).
 *   #16 velocity              — recency-adjusted impact, citations / age.
 *   #17 authorAuthority       — topic-local author recurrence across the candidate set.
 *   #19 scoreCandidate        — transparent blended score with a logged per-part breakdown.
 *
 * Every signal is an ADDITIVE boost, never a gate — missing data simply scores 0, so the
 * ranker degrades gracefully to text-relevance + citations when the graph is unavailable.
 */

const REVIEW_RE = /\b(review|reviews?|lecture\s+notes|lectures?\s+on|introduction\s+to|les\s+houches|a\s+primer|pedagogical)\b/i;

const DEFAULT_WEIGHTS = {
    textRel: 1.0, citations: 0.7, velocity: 0.3, coupling: 1.2,
    authority: 0.4, methodIntent: 0.8, canonical: 1.0, review: 0.25,
};

function _normAuthor(a) {
    return String(a || '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

/** #15 — is this candidate a review / lecture-note hub? */
function isReview(c) {
    if (!c) return false;
    if (REVIEW_RE.test(String(c.title || ''))) return true;
    if (typeof c.refCount === 'number' && c.refCount > 80) return true;
    return false;
}

/** #16 — recency-adjusted impact (citations per year since publication). */
function velocity(c, nowYear) {
    const y = parseInt(c && c.year, 10);
    if (!y || !isFinite(y)) return 0;
    const age = Math.max(1, (nowYear || new Date().getFullYear()) - y + 1);
    return (c.citations || 0) / age;
}

/** #13 — fraction of citation intents that are 'methodology'. */
function methodIntentFraction(intents) {
    const a = Array.isArray(intents) ? intents : [];
    if (!a.length) return 0;
    const meth = a.filter(i => /method/i.test(String(i))).length;
    return meth / a.length;
}

/** Distinctive named methods/terms from the task question (lowercased, len ≥ 4). */
function namedMethodsFromQuestion(question) {
    const toks = String(question || '').match(/[A-Za-z][A-Za-z-]{3,}/g) || [];
    const stop = new Set(['with', 'from', 'this', 'that', 'which', 'using', 'find', 'their', 'representation', 'method', 'methods']);
    return [...new Set(toks.map(t => t.toLowerCase()).filter(t => !stop.has(t)))];
}

/** #14 — fraction of citing sentences that mention one of the task's named methods,
 *  i.e. how often the paper is cited *for the method we care about*. */
function canonicalFromContexts(contexts, namedMethods) {
    const ctxs = (contexts || []).map(s => String(s).toLowerCase()).filter(Boolean);
    const methods = (namedMethods || []).filter(m => m && m.length >= 4);
    if (!ctxs.length || !methods.length) return 0;
    let hit = 0;
    for (const s of ctxs) if (methods.some(m => s.includes(m))) hit++;
    return hit / ctxs.length;
}

/** #17 — author authority computed *within* the candidate set (no global h-index). */
function authorAuthority(cands) {
    const freq = new Map();
    for (const c of (cands || [])) {
        for (const a of (c.authors || [])) {
            const k = _normAuthor(a);
            if (k) freq.set(k, (freq.get(k) || 0) + 1);
        }
    }
    const maxF = Math.max(1, ...(freq.size ? [...freq.values()] : [1]));
    return {
        byAuthor: freq,
        /** 0..1-ish: high when a candidate's authors recur across the set. */
        scoreFor(c) {
            const authors = (c && c.authors) || [];
            if (!authors.length) return 0;
            let s = 0;
            for (const a of authors) s += (freq.get(_normAuthor(a)) || 0);
            return (s / authors.length - 1) / maxF;   // subtract the paper's own count
        },
    };
}

/** #17 — the most recurrent authors across the set (for feeding author sub-queries, #8). */
function topAuthors(cands, n = 5) {
    const { byAuthor } = authorAuthority(cands);
    return [...byAuthor.entries()]
        .filter(([, v]) => v >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, count]) => ({ name, count }));
}

/** #19 — transparent blended score. Returns { score, scoreParts } for logging. */
function scoreCandidate(c, ctx = {}) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, ctx.weights || {});
    const nowYear = ctx.nowYear || new Date().getFullYear();
    const textRel = ctx.textRel ? Number(ctx.textRel(c)) || 0 : 0;
    const citations = Math.log1p(c.citations || 0);
    const vel = Math.log1p(velocity(c, nowYear));
    const coupling = c.coupling || 0;
    const authority = ctx.authorityFor ? (Number(ctx.authorityFor(c)) || 0) : (c.authority || 0);
    const methodIntent = (c.methodIntent != null) ? c.methodIntent : methodIntentFraction(c.citedByIntents);
    const canonical = c.canonical || 0;
    const review = isReview(c) ? 1 : 0;
    const scoreParts = { textRel, citations, velocity: vel, coupling, authority, methodIntent, canonical, review };
    const score = w.textRel * textRel + w.citations * citations + w.velocity * vel + w.coupling * coupling
        + w.authority * authority + w.methodIntent * methodIntent + w.canonical * canonical + w.review * review;
    return { score, scoreParts };
}

/** #19 — rank candidates best-first; each gets `.score` and `.scoreParts`. Stable, pure. */
function rankCandidates(cands, ctx = {}) {
    const authority = ctx.authorityFor ? null : authorAuthority(cands);
    const out = (cands || []).map((c, i) => {
        const { score, scoreParts } = scoreCandidate(c, {
            ...ctx,
            authorityFor: ctx.authorityFor || ((x) => authority.scoreFor(x)),
        });
        c.score = score; c.scoreParts = Object.assign({}, c.scoreParts, scoreParts);
        return { c, score, i };
    });
    out.sort((a, b) => (b.score - a.score) || (a.i - b.i));   // stable on ties
    return out.map(o => o.c);
}

module.exports = {
    DEFAULT_WEIGHTS, isReview, velocity, methodIntentFraction,
    namedMethodsFromQuestion, canonicalFromContexts, authorAuthority, topAuthors,
    scoreCandidate, rankCandidates,
};
