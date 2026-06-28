'use strict';
/**
 * Oberon — bounded literature-research sub-agent.
 *
 * Pipeline (R9 rewrite — find → READ → judge relevance → extract task-relevant
 * relations; never return irrelevant papers):
 *   1. PLAN   — prose question → keyword query + arXiv categories.
 *   2. SEARCH — arXiv `all:` full-text first; INSPIRE `find` from keywords fallback.
 *   3. PRE-PICK — a lenient token-overlap pre-filter only chooses WHICH papers to
 *               read (caps fetches). It does NOT decide relevance.
 *   4. READ + JUDGE + EXTRACT — for each candidate, fetch the FULL text (arXiv-HTML
 *               / ar5iv; abstract is flagged), then ONE LLM call reads it and returns
 *               {relevant, reason, key_relations[], observations[]}. Sharing a symmetry
 *               name (e.g. SU(3)) while being about a different system (neutron stars)
 *               is NOT relevant — the LLM rejects it after reading.
 *   5. BRIEF  — only the papers judged relevant, with their extracted relations and
 *               observations. Every equation is an UNVERIFIED transcription.
 *
 * Pure-ish module: `paperTools` and `llm` are injected so it is fully unit-testable
 * with fakes and never touches the network in tests.
 *
 *   paperTools: { searchArxiv?, searchInspire?, searchPapers, fetchPaperHtml, extractSections }
 *   llm:        async (prompt:string) => string   (fast model; required for real judging)
 */

const STOPWORDS = new Set(('a an the of for to in on and or is are was what which how does do '
    + 'with from into exact form explicit formula relation give given find derive derivation '
    + 'using use used between among this that these those it its their there here as at by be '
    + 'can could would should may might will shall not no yes please value values term terms '
    + 'paper papers literature reference references question answer about your you we i').split(/\s+/));

const DEFAULT_CATEGORIES = ['hep-th', 'math-ph', 'cond-mat.stat-mech', 'nlin.SI'];

const litGraph = require('./litGraph');       // citation-graph expansion (#4/#18/#11/#12)
const litRanking = require('./litRanking');    // citation-intelligence ranking (#13–#19)
const { makeCache } = require('./litCache');   // cached graph traversals (#20)

/** Extract topical content words from a prose question (lowercased, stopwords dropped). */
function _keywords(question) {
    const toks = String(question || '')
        .toLowerCase()
        .replace(/[^a-z0-9()+\-\s]/g, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(Boolean)
        .filter(t => (t.length >= 3 || /[0-9()]/.test(t)) && !STOPWORDS.has(t));
    const seen = new Set(); const out = [];
    for (const t of toks) { if (!seen.has(t)) { seen.add(t); out.push(t); } }
    return out;
}

function _refOf(p) {
    if (!p) return '';
    if (p.arxivId) return `arXiv:${p.arxivId}`;
    if (p.doi)     return `doi:${p.doi}`;
    if (p.inspireId) return `inspire:${p.inspireId}`;
    return p.title || '';
}

function _emptyBrief(question, note, plan, diag) {
    return {
        question, plan: plan || null, papers: [], considered: [], key_equations: [], observations: [], note,
        diagnostics: Object.assign({ searched: 0, read: 0, relevant: 0, fullText: 0, equations: 0 }, diag || {}),
    };
}

/** Lenient token-overlap score — used ONLY to pick which papers to read, not relevance. */
function _relevance(question, paper) {
    const q = new Set(_keywords(question));
    if (!q.size) return 1;
    const hay = new Set(_keywords(`${paper.title || ''} ${paper.abstract || ''}`));
    if (!hay.size) return 0;
    let hit = 0;
    for (const t of q) if (hay.has(t)) hit++;
    return hit / q.size;
}

// ── LLM prompts ──────────────────────────────────────────────────────────────

function _buildPlanPrompt(question) {
    return [
        `Question: ${question}`,
        '',
        'Produce a literature SEARCH PLAN as JSON. The canonical paper often does NOT',
        'mention the specific model in its title/abstract (a general METHOD paper), so',
        'search from several angles, not one long keyword string:',
        '  • method  — the technique / named equations (e.g. "Q-system rational Bethe", "Wronskian")',
        '  • model   — the physical system (e.g. "nested Bethe ansatz gl(N) spin chain")',
        '  • author  — a canonical author of the method, if you can name one',
        'Also give 3–8 discriminating fallback keywords and arXiv categories.',
        'Reply ONLY with JSON of the form:',
        '{"queries":[{"type":"method","q":"..."},{"type":"model","q":"..."},{"type":"author","author":"Lastname","abs":"topic"}],',
        ' "keywords":"word1 word2 ...","categories":["hep-th","math-ph"]}',
    ].join('\n');
}

function _parsePlan(text) {
    try {
        const o = JSON.parse(String(text || '').match(/\{[\s\S]*\}/)[0]);
        const cats = Array.isArray(o.categories) ? o.categories.map(String).filter(Boolean) : [];
        // Typed sub-queries (#1/#8) — optional; tolerated absent for back-compat.
        let queries = [];
        if (Array.isArray(o.queries)) {
            queries = o.queries.map(s => {
                if (!s || typeof s !== 'object') return null;
                if (s.author) return { type: 'author', author: String(s.author).trim(), abs: s.abs ? String(s.abs).trim() : undefined };
                const q = s.q || s.query || s.keywords;
                return q ? { type: String(s.type || 'q'), q: String(q).trim() } : null;
            }).filter(x => x && (x.author || x.q)).slice(0, 6);
        }
        let kw = Array.isArray(o.keywords) ? o.keywords.join(' ') : String(o.keywords || '');
        kw = kw.trim();
        if (!kw && queries.length) { const f = queries.find(x => x.q); kw = f ? f.q : ''; }
        if (!kw && !queries.length) return null;
        return { keywords: kw, categories: cats.length ? cats : DEFAULT_CATEGORIES, queries };
    } catch (_) { return null; }
}

/**
 * Expand a plan into an ordered list of de-duplicated sub-queries (#1).
 * Each entry: { label, params } where params is a paperTools search-params object.
 * Author queries (#8) use fielded {author, abstract}; method/model use free-text {query}.
 */
function _buildQueries(plan) {
    const cats = plan.categories || DEFAULT_CATEGORIES;
    const out = [];
    const seen = new Set();
    const push = (label, params) => { if (label && !seen.has(label)) { seen.add(label); out.push({ label, params }); } };
    for (const sq of (plan.queries || [])) {
        if (sq.author) push(`author:${sq.author}${sq.abs ? '/' + sq.abs : ''}`, { author: sq.author, abstract: sq.abs, categories: cats });
        else if (sq.q) push(`${sq.type || 'q'}:${sq.q}`, { query: sq.q, categories: cats });
    }
    if (plan.keywords) push(`keywords:${plan.keywords}`, { query: plan.keywords, categories: cats });
    return out;
}

/**
 * Deterministic author-query detector (#8 safety net). LLM planners routinely bury
 * researcher names in the keyword string as a dead hyphenated token (e.g. "marboe-volin"),
 * which matches no abstract text. Pull surname pairs out of the raw question so author
 * searches (`a Marboe`, `a Volin`) fire regardless of what the planner emitted.
 */
function _authorQueriesFromText(text) {
    const s = String(text || '');
    // Common hyphenated EQUATION/concept names that look like author pairs but are not searches.
    const NOISE = new Set([
        'yang-baxter', 'wess-zumino', 'gross-neveu', 'knizhnik-zamolodchikov', 'riemann-hilbert',
        'gelfand-levitan', 'sine-gordon', 'ablowitz-ladik', 'landau-lifshitz', 'kardar-parisi',
    ]);
    const names = new Set();
    const add = (w) => { if (/^[A-Z][a-z]{2,}$/.test(w)) names.add(w); };
    for (const m of s.matchAll(/\b([A-Z][a-z]{2,})-([A-Z][a-z]{2,})\b/g)) {        // Marboe-Volin
        if (NOISE.has(m[0].toLowerCase())) continue;
        add(m[1]); add(m[2]);
    }
    for (const m of s.matchAll(/\b([A-Z][a-z]{2,})\s+(?:and|&)\s+([A-Z][a-z]{2,})\b/g)) { add(m[1]); add(m[2]); }  // X and Y
    return [...names].slice(0, 4).map(a => ({ type: 'author', author: a }));
}

/**
 * Broaden a plan for a second search round (#6) when the first returned nothing:
 * keep the most discriminating method/author angles, shorten the keywords, and DROP
 * the category constraint (widening the net). Returns null if it cannot broaden.
 */
function _reformulate(plan) {
    const queries = (plan.queries || []).filter(s => s && (s.type === 'method' || s.author));
    const kw = String(plan.keywords || '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    if (!queries.length && !kw) return null;
    return { keywords: kw, categories: [], queries, reformulated: true };
}

/** Abstract-based PRESELECTION — pick which papers are worth a (costly) full read. */
function _buildPreselectPrompt(question, papers, maxPick) {
    const lines = papers.map((p, i) =>
        `[${i}] ${p.title || '(untitled)'}\n     ${(p.abstract || '(no abstract)').slice(0, 320)}`);
    return [
        `TASK / QUESTION: ${question}`,
        '',
        `Below are ${papers.length} candidate papers (title + abstract). From the ABSTRACTS, pick up to`,
        `${maxPick} that are MOST likely to actually address the task — the SAME model/method/quantity.`,
        'A paper that merely shares a symmetry name (e.g. "SU(3)") but is about a different system',
        '(neutron stars, nuclear matter, a different algebra like sl(2)/SU(2)) should NOT be picked.',
        'Reply with ONLY the indices, best first, e.g. "3,1,7". If none look relevant, reply "none".',
        '', ...lines,
    ].join('\n');
}

/** A strict schema-only re-ask used once when the first judge reply was unparseable (#5). */
function _buildJudgeRetryPrompt(question, paper) {
    return [
        `TASK / QUESTION: ${question}`,
        `PAPER: ${paper.title || '(untitled)'} (${_refOf(paper)})`,
        '',
        'Your previous answer could not be parsed. Reply with NOTHING but a single JSON object,',
        'no prose, no code fence:',
        '{"relevant": true|false, "reason": "one sentence", "key_relations": [], "observations": []}',
    ].join('\n');
}

function _parseIndices(text, n) {
    if (/^\s*none\s*$/i.test(String(text || ''))) return [];
    const out = [];
    for (const m of String(text || '').matchAll(/\d+/g)) {
        const i = parseInt(m[0], 10);
        if (i >= 0 && i < n && !out.includes(i)) out.push(i);
    }
    return out;
}

/** The READ + JUDGE + EXTRACT prompt — the LLM actually reads the paper content. */
function _buildReadPrompt(question, paper, sections, hasFullText) {
    return [
        `TASK / QUESTION: ${question}`,
        '',
        `PAPER: ${paper.title || '(untitled)'} (${_refOf(paper)})${paper.year ? ', ' + paper.year : ''}`,
        `Authors: ${(paper.authors || []).slice(0, 5).join(', ')}`,
        `Abstract: ${(paper.abstract || '').slice(0, 1200)}`,
        `Full text available: ${hasFullText ? 'yes' : 'no (abstract only)'}`,
        '',
        'Section headings: ' + (sections.headings || []).slice(0, 30).join(' | '),
        'Equations found in the paper (LaTeX): ' + (sections.equations || []).slice(0, 40).join('  ;  '),
        'Body excerpt: ' + (sections.textSample || '').slice(0, 7000),
        '',
        'Decide whether THIS paper is genuinely relevant to the task above — i.e. it actually',
        'studies the SAME model/method/quantity asked about. A paper that merely shares a name',
        'or symmetry group (e.g. "SU(3)") but is about a DIFFERENT physical system (e.g. neutron',
        'stars, nuclear matter, cosmology) is NOT relevant. Be strict.',
        'If relevant, extract the KEY relations/equations and observations from the paper that are',
        'useful for the task (use the LaTeX above where possible).',
        '',
        'Reply ONLY as JSON:',
        '{"relevant": true|false, "reason": "one sentence", "key_relations": [{"statement":"...","latex":"..."}], "observations": ["..."]}',
        'If not relevant: {"relevant": false, "reason": "...", "key_relations": [], "observations": []}',
    ].join('\n');
}

/** Coerce a judge's `relevant` field: accepts booleans and yes/no/true/false/uncertain
 *  strings. Returns true | false | 'uncertain' | undefined (unrecognized → caller retries). */
function _coerceRelevant(v) {
    if (v === true) return true;
    if (v === false) return false;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (['true', 'yes', 'y', 'relevant', '1'].includes(s)) return true;
    if (['false', 'no', 'n', 'irrelevant', 'notrelevant', '0'].includes(s)) return false;
    if (['uncertain', 'maybe', 'unsure', 'unclear'].includes(s)) return 'uncertain';
    return undefined;
}

function _parseJudge(text) {
    try {
        const o = JSON.parse(String(text || '').match(/\{[\s\S]*\}/)[0]);
        const rel = _coerceRelevant(o.relevant);
        if (rel === undefined) return null;   // JSON parsed but verdict unreadable → treat as parse failure
        return {
            relevant: rel,
            reason: String(o.reason || '').slice(0, 300),
            key_relations: Array.isArray(o.key_relations)
                ? o.key_relations.map(r => ({
                    statement: String((r && r.statement) || '').slice(0, 300),
                    latex:     String((r && r.latex) || '').slice(0, 400),
                })).filter(r => r.statement || r.latex).slice(0, 10)
                : [],
            observations: Array.isArray(o.observations)
                ? o.observations.map(String).map(s => s.slice(0, 300)).filter(Boolean).slice(0, 8)
                : [],
        };
    } catch (_) { return null; }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function _search(plan, paperTools, maxPapers, queryLog) {
    const out = [];
    const byKey = new Map();
    const add = (arr, label) => {
        for (const p of (arr || [])) {
            const key = (p.arxivId || p.doi || p.title || '').toLowerCase();
            if (!key) continue;
            if (!byKey.has(key)) { const rec = { ...p, foundVia: [label] }; byKey.set(key, rec); out.push(rec); }
            else { const e = byKey.get(key); if (!e.foundVia.includes(label)) e.foundVia.push(label); e.citations = Math.max(e.citations || 0, p.citations || 0); }
        }
    };
    // Multi-query expansion (#1): fire each angle, union the results. arXiv gives
    // free-text recall; INSPIRE with sort=mostcited (#3) floats canonical papers up.
    const queries = _buildQueries(plan);
    const perQ = Math.max(4, Math.ceil(maxPapers / Math.max(1, queries.length)));
    for (const { label, params } of queries) {
        if (out.length >= maxPapers * 2) break;
        const before = out.length;
        try { if (typeof paperTools.searchArxiv === 'function') add(await paperTools.searchArxiv(params, perQ), label); } catch (_) {}
        try {
            if (typeof paperTools.searchInspire === 'function') add(await paperTools.searchInspire(params, perQ, { sort: 'mostcited' }), label);
            else if (typeof paperTools.searchPapers === 'function') { const r = await paperTools.searchPapers(params, perQ, { sort: 'mostcited' }); add(r && r.papers, label); }
        } catch (_) {}
        // Per-query provenance for telemetry + miss-logging (#10).
        if (Array.isArray(queryLog)) queryLog.push({ label, params, added: out.length - before });
    }
    return out.slice(0, Math.max(maxPapers, out.length));
}

// ── Fetch + read one paper ─────────────────────────────────────────────────────

async function _normalizeFetch(paperTools, arxivId) {
    // fetchPaperHtml may return a string (legacy) or { html, source, hasFullText }.
    if (!arxivId || typeof paperTools.fetchPaperHtml !== 'function') return { html: '', source: 'none', hasFullText: false };
    const r = await paperTools.fetchPaperHtml(arxivId);
    if (r && typeof r === 'object' && 'html' in r) return { html: r.html || '', source: r.source || 'none', hasFullText: !!r.hasFullText };
    const html = String(r || '');
    return { html, source: html ? 'unknown' : 'none', hasFullText: html.length > 200 };
}

/** Read ONE paper, judge it (with fail-open retry + uncertain), return a considered entry.
 *  Shared by the main read loop and the forward citation snowball (#18). */
async function _readAndJudge(p, { q, paperTools, llm }) {
    const fetch = await _normalizeFetch(paperTools, p.arxivId).catch(() => ({ html: '', source: 'none', hasFullText: false }));
    const sections = fetch.html && typeof paperTools.extractSections === 'function'
        ? paperTools.extractSections(fetch.html) : { headings: [], equations: [], textSample: '' };
    let judged = null, rawJudge = '';
    if (llm) {
        try { rawJudge = await llm(_buildReadPrompt(q, p, sections, fetch.hasFullText)); judged = _parseJudge(rawJudge); } catch (_) {}
        if (!judged) { try { rawJudge = await llm(_buildJudgeRetryPrompt(q, p)); judged = _parseJudge(rawJudge); } catch (_) {} }
        if (!judged) {
            judged = {
                relevant: 'uncertain',
                reason: '(judge response unparseable after retry — kept as uncertain)',
                rawJudge: String(rawJudge || '').slice(0, 200),
                key_relations: (sections.equations || []).slice(0, 4).map(e => ({ statement: '', latex: e })),
                observations: [],
            };
        }
    } else {
        judged = {
            relevant: _relevance(q, p) >= 0.34,
            reason: '(no judge model — token heuristic)',
            key_relations: (sections.equations || []).slice(0, 4).map(e => ({ statement: '', latex: e })),
            observations: [],
        };
    }
    return { paper: p, source: fetch.source, hasFullText: fetch.hasFullText, ...judged };
}

/**
 * Run the bounded research loop.
 * @returns {Promise<object>} literature brief (relevant papers only) + diagnostics
 */
async function runResearch({ question, paperTools, llm, signal, budget = {}, seeds = [], graph = {} }) {
    const q = String(question || '').trim();
    if (!q || !paperTools) return _emptyBrief(q, 'no question or tools');
    const maxPapers = budget.papers || 12;   // cast a wider net; preselection trims it
    const maxRead   = budget.read   || 4;

    // Citation-graph config (Phase 3). Inert unless the paperTools expose the graph
    // clients, so kernel-only / test runs are unaffected.
    const G = graph || {};
    const cache = G.cache || makeCache({ dir: G.cacheDir || null, ttlHours: G.cacheTtlHours || 24 });
    const maxSeeds   = G.maxSeeds   || 2;
    const maxRefAdd  = G.maxRefAdd  || 10;
    const maxForward = G.maxForward || 3;
    const backwardOn = G.enabled !== false && typeof paperTools.getInspireReferences === 'function';
    const forwardOn  = G.enabled !== false && typeof paperTools.getCitationContexts === 'function';

    // 1. PLAN.
    let plan = null;
    if (llm) { try { plan = _parsePlan(await llm(_buildPlanPrompt(q))); } catch (_) {} }
    if (!plan) plan = { keywords: _keywords(q).slice(0, 8).join(' ') || q, categories: DEFAULT_CATEGORIES };

    // #8 safety net: force author searches for any researcher names in the question, even
    // when the planner failed to emit them (it usually buries names in the keyword string).
    const autoAuthors = _authorQueriesFromText(q);
    if (autoAuthors.length) {
        const have = new Set((plan.queries || []).filter(x => x.author).map(x => String(x.author).toLowerCase()));
        plan.queries = [...(plan.queries || []), ...autoAuthors.filter(a => !have.has(a.author.toLowerCase()))];
    }

    // 2. SEARCH (wide), with one broadening retry if the first round finds nothing (#6).
    const queryLog = [];
    let rounds = 1;
    let found = await _search(plan, paperTools, maxPapers, queryLog);
    if (!found.length) {
        const plan2 = _reformulate(plan);
        if (plan2) { plan = plan2; rounds = 2; found = await _search(plan, paperTools, maxPapers, queryLog); }
    }
    const misses = queryLog.filter(qq => qq.added === 0).map(qq => qq.label);   // #10
    const meta = () => ({ queries: queryLog.map(qq => ({ label: qq.label, added: qq.added })), rounds, misses });
    if (!found.length) return Object.assign(_emptyBrief(q, 'no papers found', plan), meta());

    // 2b. CITATION-GRAPH backward snowball (#4) + citation/coupling prior (#11/#12).
    // The references of the recalled seed(s), the strongest initial hits, and any review
    // hubs (#15) often ARE the canonical method papers, even when their titles share no
    // model keywords.
    let seedRefIds = [];
    if (backwardOn) {
        try {
            const reviews = found.filter(p => litRanking.isReview(p));   // #15 reference hubs
            const seedList = [...(seeds || []), ...reviews, ...found.slice(0, maxSeeds)]
                .filter(s => s && (s.arxivId || s.texkey || s.inspireId));
            const refCands = await litGraph.expandReferences({ seeds: seedList, paperTools, cache, max: maxRefAdd, maxSeeds });
            const seen = new Set(found.map(p => (p.arxivId || p.title || '').toLowerCase()));
            for (const rc of refCands) {
                const k = (rc.arxivId || rc.title || '').toLowerCase();
                if (k && !seen.has(k)) { seen.add(k); found.push(rc); }
            }
            for (const s of seedList.slice(0, maxSeeds)) {
                const refs = await litGraph._fetchRefs(s, paperTools, cache);
                for (const r of refs) if (r.arxivId) seedRefIds.push(r.arxivId);
            }
            // sets .coupling/.citations scoreParts on the top candidates (#11/#12)
            found = await litGraph.rankByPrior(found, { paperTools, cache, seedRefIds, max: maxPapers });
        } catch (_) { /* graph is best-effort; fall back to plain search order */ }
    }

    // 2c. BLENDED citation-intelligence ranking (#13–#19): pure + cheap; reorders the read
    // queue so the best candidates are read first. Degrades to text-relevance + citations
    // when graph signals are absent.
    const authority = litRanking.authorAuthority(found);
    let topAuthors = litRanking.topAuthors(found, 5);     // #17 → available for #8 author queries
    found = litRanking.rankCandidates(found, {
        textRel: (c) => _relevance(q, c),
        authorityFor: (c) => authority.scoreFor(c),
        nowYear: new Date().getFullYear(),
        weights: G.weights,
    });

    // 3. PRESELECT from ABSTRACTS (one cheap LLM turn) — full reads are expensive, so
    //    cut low-quality candidates before fetching. Falls back to token pre-pick.
    let toRead = null;
    if (llm) {
        try {
            const resp = await llm(_buildPreselectPrompt(q, found.slice(0, maxPapers), maxRead));
            const idxs = _parseIndices(resp, found.length);
            if (idxs.length) {
                toRead = idxs.slice(0, maxRead).map(i => found[i]).filter(Boolean);
            } else if (/^\s*none\s*$/i.test(String(resp || ''))) {
                // The model read the abstracts and judged none relevant — believe it.
                const b = _emptyBrief(q, 'no abstracts looked relevant (preselection)', plan, { searched: found.length, read: 0, relevant: 0 });
                b.considered = found.slice(0, 6).map(p => ({ ref: _refOf(p), title: p.title, relevant: false, reason: 'not selected from abstract' }));
                return Object.assign(b, meta(), { uncertain: [] });
            }
            // else: unparseable → fall through to token pre-pick below.
        } catch (_) {}
    }
    if (!toRead) {
        // No LLM (tests) or preselect unparseable → lenient token pre-pick.
        const ranked = found.map(p => ({ p, s: _relevance(q, p) })).sort((a, b) => b.s - a.s);
        toRead = ranked.slice(0, Math.min(found.length, maxRead + 2)).map(r => r.p);
    }

    // 4. READ + JUDGE + EXTRACT per paper (fail-open retry/uncertain in _readAndJudge).
    const considered = [];
    for (const p of toRead) {
        if (signal && signal.aborted) break;
        if (considered.filter(c => c.relevant === true).length >= maxRead) break;   // enough CONFIRMED ones
        considered.push(await _readAndJudge(p, { q, paperTools, llm }));
    }

    // 4b. FORWARD citation snowball (#18): papers that CITE a confirmed hit are often the
    // refinements/applications we want; read+judge a bounded few and merge them in.
    if (forwardOn && considered.some(c => c.relevant === true)) {
        try {
            const hits = considered.filter(c => c.relevant === true).map(c => c.paper);
            const seenIds = new Set(considered.map(c => c.paper.arxivId).filter(Boolean));
            const citeCands = await litGraph.expandCitations({ hits, paperTools, cache, max: maxForward * 3, maxSeeds });
            let added = 0;
            for (const cc of citeCands) {
                if (added >= maxForward || (signal && signal.aborted)) break;
                if (!cc.arxivId || seenIds.has(cc.arxivId)) continue;
                seenIds.add(cc.arxivId);
                const entry = await _readAndJudge(cc, { q, paperTools, llm });
                entry.forward = true;
                considered.push(entry);
                added++;
            }
        } catch (_) { /* forward snowball is best-effort */ }
    }

    const fullTextCount = considered.filter(c => c.hasFullText).length;
    const relevant  = considered.filter(c => c.relevant === true);
    const uncertain = considered.filter(c => c.relevant === 'uncertain');
    const uncertainOut = uncertain.map(c => ({
        title: c.paper.title, ref: _refOf(c.paper), arxivId: c.paper.arxivId || null,
        reason: c.reason, raw: c.rawJudge || '',
        key_relations: (c.key_relations || []).map(r => ({ statement: r.statement || '', latex: r.latex || '' })),
    }));
    const consideredOut = considered.map(c => ({ ref: _refOf(c.paper), title: c.paper.title, relevant: c.relevant, reason: c.reason, foundVia: c.paper.foundVia || [], forward: !!c.forward }));

    if (!relevant.length) {
        const note = uncertain.length
            ? `no clearly-relevant papers; ${uncertain.length} could not be judged (kept as uncertain)`
            : 'no relevant papers after reading';
        const b = _emptyBrief(q, note, plan,
            { searched: found.length, read: considered.length, relevant: 0, fullText: fullTextCount, uncertain: uncertain.length });
        b.considered = consideredOut;
        return Object.assign(b, meta(), { uncertain: uncertainOut });
    }

    // 5a. Enrich confirmed papers with citation-intent (#13) + canonical-name (#14)
    // signals from their (cached) citation contexts — bounded to the top few.
    if (forwardOn) {
        const named = litRanking.namedMethodsFromQuestion(q);
        for (const c of relevant.slice(0, 3)) {
            if (!c.paper.arxivId) continue;
            try {
                const sig = await litGraph.citationSignals(c.paper.arxivId, paperTools, cache);
                if (sig) {
                    c.paper.citedByIntents = sig.allIntents;
                    c.paper.methodIntent = litRanking.methodIntentFraction(sig.allIntents);
                    c.paper.canonical = litRanking.canonicalFromContexts(sig.allContexts, named);
                }
            } catch (_) { /* signals are best-effort */ }
        }
    }

    // 5b. Order the brief by the blended citation-intelligence score (#19).
    const relAuthority = litRanking.authorAuthority(considered.map(c => c.paper));
    const scored = relevant.map(c => {
        const { score, scoreParts } = litRanking.scoreCandidate(c.paper, {
            textRel: (p) => _relevance(q, p),
            authorityFor: (p) => relAuthority.scoreFor(p),
            nowYear: new Date().getFullYear(), weights: G.weights,
        });
        return { c, score, scoreParts };
    }).sort((a, b) => b.score - a.score);

    // 5c. BRIEF — relevant papers only (uncertain surfaced separately, never as relevant).
    const key_equations = [];
    for (const { c } of scored) {
        for (const r of c.key_relations) {
            key_equations.push({
                latex: r.latex || '', statement: r.statement || '', source: _refOf(c.paper),
                caveat: 'transcribed from paper — VERIFY in the kernel before recording',
            });
        }
    }
    const observations = [];
    for (const { c } of scored) for (const o of c.observations) observations.push({ text: o, source: _refOf(c.paper) });

    return {
        question: q, plan,
        papers: scored.map(({ c, score, scoreParts }) => ({
            title: c.paper.title, authors: (c.paper.authors || []).slice(0, 4), year: c.paper.year,
            arxivId: c.paper.arxivId || null, doi: c.paper.doi || null, texkey: c.paper.texkey || null,
            inspireId: c.paper.inspireId || null, ref: _refOf(c.paper),
            relevant: true, reason: c.reason, fullText: c.hasFullText,
            foundVia: c.paper.foundVia || [], citations: c.paper.citations || 0, viaForward: !!c.forward,
            score: Math.round(score * 1000) / 1000, scoreParts,   // #19 transparency
        })),
        // Transparency: every paper we read and our verdict (so "rejected neutron-star" is visible).
        considered: consideredOut,
        uncertain: uncertainOut,
        key_equations: key_equations.slice(0, 24),
        observations: observations.slice(0, 14),
        queries: queryLog.map(qq => ({ label: qq.label, added: qq.added })),
        rounds, misses, topAuthors,
        diagnostics: {
            searched: found.length, read: considered.length, relevant: relevant.length,
            uncertain: uncertain.length, fullText: fullTextCount, equations: key_equations.length,
        },
    };
}

module.exports = {
    runResearch,
    _internals: { _keywords, _relevance, _refOf, _parsePlan, _buildQueries, _authorQueriesFromText, _reformulate, _coerceRelevant, _parseJudge, _parseIndices, _buildPlanPrompt, _buildPreselectPrompt, _buildReadPrompt, _buildJudgeRetryPrompt, _search, _normalizeFetch, _readAndJudge },
};
