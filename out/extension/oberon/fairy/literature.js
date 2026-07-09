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

/**
 * R8: deterministically extract arXiv ids from free text — the task brief or the
 * research question often contains the paper the user wants used (a pasted
 * arxiv.org URL, "arXiv:1908.10379", or a bare new-style id). Run Q_42CQ3G's
 * brief named https://arxiv.org/pdf/1908.10379 and the search never saw it.
 */
function _extractArxivIds(text) {
    const s = String(text || '');
    const out = [];
    const seen = new Set();
    const push = (id) => {
        const bare = String(id || '').replace(/v\d+$/, '').replace(/\.pdf$/i, '');
        if (bare && !seen.has(bare)) { seen.add(bare); out.push(bare); }
    };
    for (const m of s.matchAll(/arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/gi)) push(m[1]);
    for (const m of s.matchAll(/\barXiv:\s*([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/gi)) push(m[1]);
    for (const m of s.matchAll(/\b(\d{4}\.\d{4,5})(?:v\d+)?\b/g)) push(m[1]);          // bare new-style id
    for (const m of s.matchAll(/\b((?:hep-th|hep-ph|hep-lat|math-ph|cond-mat|nlin|math|quant-ph|gr-qc|nucl-th)(?:\.[A-Za-z-]+)?\/\d{7})\b/g)) push(m[1]);
    return out.slice(0, 4);
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
        'Produce a literature SEARCH PLAN as JSON. Queries are dispatched to arXiv,',
        'INSPIRE-HEP and Semantic Scholar. The canonical paper often does NOT mention',
        'the specific model in its title/abstract (a general METHOD paper), so search',
        'from several angles, not one long keyword string:',
        '  • method  — the technique / named equations (e.g. "Q-system rational Bethe", "Wronskian")',
        '  • model   — the physical system (e.g. "nested Bethe ansatz gl(N) spin chain")',
        '  • alias   — the SAME concept under the name another community uses',
        '              (e.g. "Hirota equation" for a T-system; "QQ-relations" for a Q-system)',
        '  • review  — a survey/lectures angle (e.g. "review nested Bethe ansatz")',
        '  • author  — a canonical author of the method, if you can name one',
        'KEEP EVERY QUERY SHORT — 2 to 5 words. arXiv requires all terms to co-occur',
        'in the abstract, so a long keyword string matches nothing.',
        'Also give 3–8 discriminating fallback keywords and arXiv categories.',
        '',
        'USE YOUR OWN KNOWLEDGE OF THE LITERATURE (known_papers): if you can NAME the',
        'canonical paper(s) or standard review for this — you often can — list them',
        '(title, first authors, year, arXiv id if you know it). They are looked up',
        'DIRECTLY, bypassing keyword search, and read first. Only name papers you are',
        'confident actually exist; an id is better than a title.',
        '',
        'DISAMBIGUATE (avoid): if a key term is ambiguous across fields, name the',
        'WRONG meanings so those papers can be rejected (e.g. for Yang-Baxter fusion:',
        '"fusion categories, anyons, topological defects, nuclear fusion").',
        '',
        'Reply with COMPACT JSON ONLY — no prose before or after, no reasoning, no',
        'markdown fences. A truncated reply is discarded entirely.',
        '{"queries":[{"type":"method","q":"..."},{"type":"model","q":"..."},{"type":"alias","q":"..."},',
        '            {"type":"review","q":"..."},{"type":"author","author":"Lastname","abs":"topic"}],',
        ' "known_papers":[{"title":"...","authors":"Lastname, Lastname","year":1981,"arxivId":"...or null"}],',
        ' "avoid":"wrong-field terms, comma separated (or empty)",',
        ' "keywords":"word1 word2 ...","categories":["hep-th","math-ph"]}',
    ].join('\n');
}

/**
 * Reformulation prompt for a failed round — carries FEEDBACK (what was tried,
 * what came back, why read papers were rejected) so the model can diagnose the
 * failure instead of rephrasing blindly. Deliberately does NOT contain the
 * "SEARCH PLAN" marker: it is a different decision with different inputs.
 */
function _buildReformulatePrompt(question, attempt) {
    const a = attempt || {};
    const tried = (a.tried || []).slice(0, 12).map(t => '  - ' + t);
    const lines = [
        `LITERATURE RE-SEARCH (round ${a.round || 2}). Previous queries failed for this task.`,
        `TASK / QUESTION: ${question}`,
        '',
        'Queries already tried (do NOT repeat these or trivial rephrasings):',
        ...(tried.length ? tried : ['  (none recorded)']),
    ];
    if (a.sampleTitles && a.sampleTitles.length) {
        lines.push('', 'Sample of papers those queries returned (all judged NOT useful):');
        for (const t of a.sampleTitles.slice(0, 6)) lines.push('  - ' + t);
    } else {
        lines.push('', 'The searches found NOTHING at all.');
    }
    if (a.rejected && a.rejected.length) {
        lines.push('', 'Papers read in full and REJECTED, with the judge\'s reason:');
        for (const r of a.rejected.slice(0, 4)) lines.push(`  - "${r.title}" — ${r.reason}`);
    }
    lines.push(
        '',
        'Diagnose the failure (wrong terminology? too specific? the concept has a different',
        'name in a neighbouring community?) and produce a DIFFERENT plan: synonyms and',
        'alternative names for the method, a more general method-level phrasing, or a',
        'review/lectures angle. KEEP EVERY QUERY SHORT (2–5 words).',
        'BEST OPTION — name papers you KNOW (known_papers): if you can recall the canonical',
        'paper or standard review for this topic (title, authors, year, arXiv id if known),',
        'list it; it is looked up directly and read first. Only papers you are confident exist.',
        'Also give "avoid": wrong-field meanings of ambiguous terms, so they can be rejected.',
        'Reply with COMPACT JSON ONLY — no prose before or after, no reasoning, no markdown',
        'fences. A truncated reply is discarded entirely.',
        '{"queries":[{"type":"method","q":"..."},{"type":"alias","q":"..."},{"type":"review","q":"..."},',
        '            {"type":"author","author":"Lastname","abs":"topic"}],',
        ' "known_papers":[{"title":"...","authors":"...","year":1981,"arxivId":"...or null"}],',
        ' "avoid":"wrong-field terms (or empty)",',
        ' "keywords":"word1 word2 ...","categories":[]}',
    );
    return lines.join('\n');
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
        // R7: the model's OWN knowledge of the literature — named papers are looked
        // up directly (title/arXiv id), bypassing keyword search entirely.
        const knownPapers = Array.isArray(o.known_papers)
            ? o.known_papers.map(k => {
                if (!k || typeof k !== 'object') return null;
                const title = String(k.title || '').trim().slice(0, 200);
                const rawId = String(k.arxivId || '').trim().replace(/^arXiv:/i, '');
                const arxivId = /^null$/i.test(rawId) ? '' : rawId;
                if (!title && !arxivId) return null;
                return {
                    title,
                    authors: Array.isArray(k.authors) ? k.authors.join(', ').slice(0, 120) : String(k.authors || '').slice(0, 120),
                    year: k.year ? String(k.year).slice(0, 8) : '',
                    arxivId: arxivId || undefined,
                };
            }).filter(Boolean).slice(0, 5)
            : [];
        // R7: wrong-field meanings of ambiguous terms ("fusion categories, anyons"
        // for a Yang-Baxter-fusion task) — shown to preselect + read judge.
        const avoid = String(o.avoid || '').trim().slice(0, 160);
        if (!kw && !queries.length && !knownPapers.length) return null;
        return { keywords: kw, categories: cats.length ? cats : DEFAULT_CATEGORIES, queries, knownPapers, avoid };
    } catch (_) { return null; }
}

/**
 * R7: look up papers the planner NAMED from its own knowledge. An arXiv id is a
 * direct fetch; a bare title goes through Semantic Scholar / INSPIRE title search
 * and is kept only when the returned title actually matches (≥50% token overlap)
 * — hallucinated titles are dropped, never injected.
 */
async function _lookupKnownPapers(knownPapers, paperTools, queryLog) {
    const out = [];
    const titleMatches = (claimed, got) => {
        const a = new Set(_keywords(claimed)); const b = new Set(_keywords(got));
        if (!a.size || !b.size) return false;
        let hit = 0; for (const t of a) if (b.has(t)) hit++;
        return hit / a.size >= 0.5;
    };
    for (const k of (knownPapers || []).slice(0, 5)) {
        const label = `known:${(k.title || k.arxivId || '').slice(0, 50)}`;
        const before = out.length;
        const errs = [];
        try {
            if (k.arxivId && typeof paperTools.searchArxiv === 'function') {
                try {
                    const hits = await paperTools.searchArxiv({ eprint: k.arxivId }, 1);
                    for (const p of (hits || [])) out.push({ ...p, known: true, namedInTask: k.namedInTask || undefined });
                } catch (e) { errs.push('arxiv-id: ' + String(e && e.message || e).slice(0, 60)); }
            }
            // R9 (run Q_4PWRMS): an id lookup failing (throttled/offline search API)
            // must NOT drop a paper whose id is explicit — inject a synthetic entry;
            // the read step fetches the FULL TEXT by id via fetchPaperHtml (ar5iv),
            // which does not depend on any search API. A wrong id just fails to
            // fetch and the judge sees an empty document — bounded cost.
            if (out.length === before && k.arxivId) {
                out.push({
                    arxivId: String(k.arxivId), title: k.title || `arXiv:${k.arxivId} (named in task)`,
                    abstract: '', authors: [], year: k.year || '',
                    known: true, namedInTask: k.namedInTask || undefined, syntheticKnown: true,
                });
            }
            if (out.length === before && k.title) {
                let hits = [];
                if (typeof paperTools.searchSemanticScholar === 'function') {
                    try { hits = await paperTools.searchSemanticScholar({ query: k.title }, 3) || []; } catch (e) { errs.push('s2: ' + String(e && e.message || e).slice(0, 60)); }
                }
                if (!hits.length && typeof paperTools.searchInspire === 'function') {
                    try { hits = await paperTools.searchInspire({ title: k.title }, 3) || []; } catch (e) { errs.push('inspire: ' + String(e && e.message || e).slice(0, 60)); }
                }
                const match = hits.find(p => titleMatches(k.title, p.title || ''));
                if (match) out.push({ ...match, known: true, namedInTask: k.namedInTask || undefined });
            }
        } catch (e) { errs.push(String(e && e.message || e).slice(0, 60)); }
        if (Array.isArray(queryLog)) queryLog.push({ label, key: label.toLowerCase(), params: { known: k.title || k.arxivId }, added: out.length - before, err: errs.length ? errs : undefined });
    }
    return out;
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
    // Dedup by the ACTUAL search params, not the label — `method:x` and
    // `keywords:x` are the same query to the engines. The key also drives the
    // cross-round refire guard in _search (R6).
    const keyOf = (params) => params.author
        ? `a:${String(params.author).toLowerCase()}|${String(params.abstract || '').toLowerCase()}`
        : `q:${String(params.query || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const push = (label, params) => {
        const key = keyOf(params);
        if (!label || seen.has(key)) return;
        seen.add(key);
        out.push({ label, key, params });
    };
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

/** Abstract-based PRESELECTION — pick which papers are worth a (costly) full read.
 *  L1 (run Q_3VRPXL): METHOD papers count. The old prompt demanded the exact model
 *  instance ("SU(4), L=2, 6-dim antisym rep") which no abstract ever states — the
 *  judge replied "none" for 11 on-topic integrability papers and the pipeline
 *  starved. Abstracts under-describe methods; be permissive here and strict only
 *  against genuinely unrelated PHYSICS. */
function _buildPreselectPrompt(question, papers, maxPick, avoid) {
    const lines = papers.map((p, i) =>
        `[${i}] ${p.title || '(untitled)'}\n     ${(p.abstract || '(no abstract)').slice(0, 320)}`);
    return [
        `TASK / QUESTION: ${question}`,
        '',
        `Below are ${papers.length} candidate papers (title + abstract). Pick up to ${maxPick} that are`,
        'USEFUL for the task — EITHER they study the same system/quantity (direct), OR they develop the',
        'METHOD / formalism the task needs (a general transfer-matrix / fusion / T-system / Bethe-ansatz /',
        'representation-theory paper is useful even if it never mentions the task\'s specific model, size,',
        'or representation — method papers rarely do; the reader will SPECIALIZE the general relations).',
        'Reject only papers about genuinely unrelated physics (different phenomena entirely: experiments,',
        'astrophysics, phenomenology — e.g. neutron stars for a spin-chain question).',
        ...(avoid ? ['', `WARNING — ambiguous terms: the task is NOT about ${avoid}. Papers on those topics`,
            'share keywords with the task but are the WRONG field — do not pick them.'] : []),
        'Reply with ONLY the indices, best first, e.g. "3,1,7". Reply "none" ONLY if every single paper',
        'is unrelated physics.',
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
function _buildReadPrompt(question, paper, sections, hasFullText, avoid, named) {
    // I9: show equation numbers when the extractor found them, so extracted
    // relations can be cited as "eq. (3.12)" and re-located later via lit_read.
    const eqLines = (sections.equationsTagged && sections.equationsTagged.length)
        ? sections.equationsTagged.slice(0, 40).map(e => (e.eqNumber ? `(${e.eqNumber}) ` : '') + e.latex)
        : (sections.equations || []).slice(0, 40);
    return [
        `TASK / QUESTION: ${question}`,
        '',
        `PAPER: ${paper.title || '(untitled)'} (${_refOf(paper)})${paper.year ? ', ' + paper.year : ''}`,
        `Authors: ${(paper.authors || []).slice(0, 5).join(', ')}`,
        `Abstract: ${(paper.abstract || '').slice(0, 1200)}`,
        `Full text available: ${hasFullText ? 'yes' : 'no (abstract only)'}`,
        '',
        'Section headings: ' + (sections.headings || []).slice(0, 30).join(' | '),
        'Equations found in the paper (LaTeX): ' + eqLines.join('  ;  '),
        'Body excerpt: ' + (sections.textSample || '').slice(0, 7000),
        '',
        'GRADE this paper\'s relevance to the task:',
        '- "direct":     studies the SAME system/quantity the task asks about.',
        '- "method":     develops the METHOD or formalism the task needs (general T-system/fusion,',
        '                nested Bethe ansatz, R-matrix constructions, representation-theory machinery)',
        '                even though it does not treat the exact instance — this COUNTS as relevant;',
        '                the reader will SPECIALIZE the general relations to their instance.',
        '                PARTIAL usefulness also counts: a paper that STATES relations usable for',
        '                PART of the task (e.g. the fusion hierarchy, without the explicit',
        '                construction the task mentions) is "method" — extract those relations.',
        '- "background": related context only — no usable relations for this task.',
        '- "none":       genuinely unrelated physics (different phenomena/system class entirely,',
        '                e.g. neutron stars, collider phenomenology, for a spin-chain question).',
        ...(avoid ? [`NOTE: the task is NOT about ${avoid} — papers on those topics are "none" even`,
            'though they share keywords with the task.'] : []),
        ...(named ? ['IMPORTANT: THIS paper was NAMED in the task as the source to use. Unless the',
            'fetched text is clearly a different document than its id suggests, grade it',
            '"direct" and extract the relations the task needs from it — do not reject it',
            'for differing from your expectation of what it contains.'] : []),
        'If direct or method: extract the KEY relations/equations and observations useful for the',
        'task (use the LaTeX above; include "eqNumber" when the equation is numbered). For a GENERAL',
        'relation also give "specializeHint": one sentence on how to specialize it to the task',
        'instance (e.g. "set a=1..3 for su(4); replace the fundamental by the 6-dim antisymmetric rep").',
        '',
        'Reply ONLY as JSON:',
        '{"relevance": "direct|method|background|none", "reason": "one sentence",',
        ' "key_relations": [{"statement":"...","latex":"...","eqNumber":"3.12 or null","specializeHint":"... or null"}],',
        ' "observations": ["..."]}',
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
        // L1: graded verdicts. direct/method → relevant (method papers carry the
        // general relations the task specializes); background/none → not relevant.
        // Back-compat: old {"relevant": bool} replies still parse.
        let rel, grade = null;
        const g = String(o.relevance || '').trim().toLowerCase();
        if (['direct', 'method', 'background', 'none'].includes(g)) {
            grade = g;
            rel = (g === 'direct' || g === 'method');
        } else {
            rel = _coerceRelevant(o.relevant);
        }
        if (rel === undefined) return null;   // JSON parsed but verdict unreadable → treat as parse failure
        return {
            relevant: rel,
            grade,
            reason: String(o.reason || '').slice(0, 300),
            key_relations: Array.isArray(o.key_relations)
                ? o.key_relations.map(r => ({
                    statement: String((r && r.statement) || '').slice(0, 300),
                    latex:     String((r && r.latex) || '').slice(0, 700),
                    eqNumber:  (r && r.eqNumber && String(r.eqNumber).trim() && !/^null$/i.test(String(r.eqNumber).trim()))
                        ? String(r.eqNumber).trim().slice(0, 20) : undefined,
                    specializeHint: (r && r.specializeHint && !/^null$/i.test(String(r.specializeHint).trim()))
                        ? String(r.specializeHint).trim().slice(0, 240) : undefined,
                })).filter(r => r.statement || r.latex).slice(0, 10)
                : [],
            observations: Array.isArray(o.observations)
                ? o.observations.map(String).map(s => s.slice(0, 300)).filter(Boolean).slice(0, 8)
                : [],
        };
    } catch (_) { return null; }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function _search(plan, paperTools, maxPapers, queryLog, skipLabels) {
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
    // free-text recall; Semantic Scholar relevance-ranks prose/method queries that
    // arXiv's exact AND-grammar misses; INSPIRE with sort=mostcited (#3) floats
    // canonical papers up. skipLabels prevents refiring a query from a prior round.
    const queries = _buildQueries(plan).filter(({ key }) => !(skipLabels && skipLabels.has(key)));
    const perQ = Math.max(4, Math.ceil(maxPapers / Math.max(1, queries.length)));
    // R9: per-round circuit breaker. arXiv's export API throttles after a few
    // rapid requests (observed live: every call then TIMES OUT at 15s) — once an
    // engine fails twice in a round, stop hitting it: 10 dead arXiv calls would
    // otherwise cost 150s of pure timeout. Each round gets a fresh chance.
    const dead = { arxiv: 0, s2: 0, inspire: 0 };
    const DEAD_AT = 2;
    for (const { label, key, params } of queries) {
        if (out.length >= maxPapers * 2) break;
        const before = out.length;
        // R8: engine failures are soft but no longer INVISIBLE — a 429/network
        // error explaining an engine's 0 contribution lands in the query log.
        const errs = [];
        try { if (dead.arxiv < DEAD_AT && typeof paperTools.searchArxiv === 'function') add(await paperTools.searchArxiv(params, perQ), label); }
        catch (e) { dead.arxiv++; errs.push('arxiv: ' + String(e && e.message || e).slice(0, 60)); }
        try { if (dead.s2 < DEAD_AT && typeof paperTools.searchSemanticScholar === 'function') add(await paperTools.searchSemanticScholar(params, perQ), label); }
        catch (e) { dead.s2++; errs.push('s2: ' + String(e && e.message || e).slice(0, 60)); }
        try {
            if (dead.inspire < DEAD_AT) {
                if (typeof paperTools.searchInspire === 'function') add(await paperTools.searchInspire(params, perQ, { sort: 'mostcited' }), label);
                else if (typeof paperTools.searchPapers === 'function') { const r = await paperTools.searchPapers(params, perQ, { sort: 'mostcited' }); add(r && r.papers, label); }
            }
        } catch (e) { dead.inspire++; errs.push('inspire: ' + String(e && e.message || e).slice(0, 60)); }
        // Per-query provenance for telemetry + miss-logging (#10).
        if (Array.isArray(queryLog)) queryLog.push({ label, key, params, added: out.length - before, err: errs.length ? errs : undefined });

        // R7: an author+phrase query that found nothing refires as author-only
        // (most-cited) — canonical-method authors (Kulish, Reshetikhin) are exactly
        // the case where the paired abstract phrase over-constrains to zero hits.
        if (params.author && params.abstract && (out.length - before) === 0) {
            const broadKey = `a:${String(params.author).toLowerCase()}|`;
            if (!(skipLabels && skipLabels.has(broadKey)) && !queries.some(x => x.key === broadKey)) {
                const broadLabel = `author:${params.author}(broad)`;
                const bBefore = out.length;
                const bParams = { author: params.author, categories: params.categories };
                try { if (typeof paperTools.searchArxiv === 'function') add(await paperTools.searchArxiv(bParams, perQ), broadLabel); } catch (_) {}
                try {
                    if (typeof paperTools.searchInspire === 'function') add(await paperTools.searchInspire(bParams, perQ, { sort: 'mostcited' }), broadLabel);
                    else if (typeof paperTools.searchPapers === 'function') { const r = await paperTools.searchPapers(bParams, perQ, { sort: 'mostcited' }); add(r && r.papers, broadLabel); }
                } catch (_) {}
                if (Array.isArray(queryLog)) queryLog.push({ label: broadLabel, key: broadKey, params: bParams, added: out.length - bBefore });
            }
        }
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
async function _readAndJudge(p, { q, paperTools, llm, avoid, named }) {
    const fetch = await _normalizeFetch(paperTools, p.arxivId).catch(() => ({ html: '', source: 'none', hasFullText: false }));
    const sections = fetch.html && typeof paperTools.extractSections === 'function'
        ? paperTools.extractSections(fetch.html) : { headings: [], equations: [], textSample: '' };
    let judged = null, rawJudge = '';
    if (llm) {
        try { rawJudge = await llm(_buildReadPrompt(q, p, sections, fetch.hasFullText, avoid, named || p.namedInTask)); judged = _parseJudge(rawJudge); } catch (_) {}
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
async function runResearch({ question, paperTools, llm, signal, budget = {}, seeds = [], seedIds = [], graph = {}, onProgress = null }) {
    const q = String(question || '').trim();
    // Live progress emitter (no-op unless a callback is supplied). Keeps discovery
    // visible in working.wb; never throws into the pipeline.
    const prog = (stage, detail) => { try { if (onProgress) onProgress({ stage, detail: detail == null ? '' : String(detail) }); } catch (_) {} };
    if (!q || !paperTools) return _emptyBrief(q, 'no question or tools');
    prog('start', q.slice(0, 120));
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
    prog('plan', 'building a query plan');
    let plan = null;
    if (llm) { try { plan = _parsePlan(await llm(_buildPlanPrompt(q))); } catch (_) {} }
    if (!plan) plan = { keywords: _keywords(q).slice(0, 8).join(' ') || q, categories: DEFAULT_CATEGORIES };
    prog('plan', 'keywords: ' + String(plan.keywords || q).slice(0, 80));

    // #8 safety net: force author searches for any researcher names in the question, even
    // when the planner failed to emit them (it usually buries names in the keyword string).
    const autoAuthors = _authorQueriesFromText(q);
    if (autoAuthors.length) {
        const have = new Set((plan.queries || []).filter(x => x.author).map(x => String(x.author).toLowerCase()));
        plan.queries = [...(plan.queries || []), ...autoAuthors.filter(a => !have.has(a.author.toLowerCase()))];
    }

    // R6: a prose query gives Semantic Scholar its best shot — it relevance-ranks
    // natural language, where arXiv's AND-grammar needs exact keyword co-occurrence.
    if (typeof paperTools.searchSemanticScholar === 'function') {
        plan.queries = [...(plan.queries || []), { type: 'prose', q: q.slice(0, 200) }];
    }

    // 2. SEARCH (wide). R6: NEVER give up after one round — while the pool is empty
    // and the round budget lasts, REFORMULATE: an LLM call that sees what was tried
    // and what came back proposes different terminology (aliases used by other
    // communities, broader method phrasings, review angles). Without an LLM one
    // deterministic broadening still runs (#6).
    const maxRounds = Math.max(1, budget.rounds || 3);
    const queryLog = [];
    const firedLabels = new Set();
    const markFired = () => { for (const qq of queryLog) firedLabels.add(qq.key || qq.label); };
    let rounds = 1;
    let usedDeterministic = false;
    let found = [];
    // R7: papers the planner NAMED from its own knowledge — direct lookup, merged
    // into the pool with a `known` flag (they bypass preselect and are read first).
    // R9: duplicates ENRICH — a synthetic known stub gains real metadata when the
    // same id later arrives from a search engine; flags survive either direction.
    const keyOfP = (p) => (p.arxivId || p.doi || p.title || '').toLowerCase();
    const mergeIntoFound = (cands) => {
        for (const p of (cands || [])) {
            const k = keyOfP(p);
            if (!k) continue;
            const e = found.find(x => keyOfP(x) === k);
            if (!e) { found.push(p); continue; }
            if (p.known) e.known = true;
            if (p.namedInTask) e.namedInTask = true;
            if (e.syntheticKnown && p.title) { e.title = p.title; e.syntheticKnown = undefined; }
            for (const f of ['abstract', 'authors', 'year', 'doi', 'inspireId', 'texkey']) {
                const empty = e[f] == null || e[f] === '' || (Array.isArray(e[f]) && !e[f].length);
                if (empty && p[f] != null && p[f] !== '') e[f] = p[f];
            }
            e.citations = Math.max(e.citations || 0, p.citations || 0);
        }
    };
    // R9 (run Q_4PWRMS): task-named ids are grounded FIRST — before the query
    // barrage can rate-limit the search APIs, independent of the planner, and
    // guaranteed a pool slot even when every lookup fails (synthetic stub whose
    // full text is fetched by id at read time).
    const explicitIds = [...new Set([..._extractArxivIds(q), ...(seedIds || []).map(String)])].slice(0, 4);
    if (explicitIds.length) {
        mergeIntoFound(await _lookupKnownPapers(explicitIds.map(id => ({ title: '', arxivId: id, namedInTask: true })), paperTools, queryLog));
    }
    prog('search', 'searching arXiv · Semantic Scholar · INSPIRE');
    mergeIntoFound(await _search(plan, paperTools, maxPapers, queryLog));
    if (plan.knownPapers && plan.knownPapers.length) {
        mergeIntoFound(await _lookupKnownPapers(plan.knownPapers, paperTools, queryLog));
    }
    markFired();
    prog('search', `round 1 — ${found.length} candidate(s)`);
    // R8: a pool of 1–2 candidates is nearly as bad as an empty one (run Q_42CQ3G:
    // pool of 1 skipped every retry). Reformulate while the pool is THIN, not just
    // empty; stop as soon as a round contributes new candidates. The deterministic
    // no-LLM broadening still fires only on a truly empty pool.
    while (found.length < 3 && rounds < maxRounds && !(signal && signal.aborted)) {
        let plan2 = null;
        if (llm) {
            const tried = queryLog.map(qq => `${qq.label} (found ${qq.added})`);
            const sampleTitles = found.slice(0, 4).map(p => p.title).filter(Boolean);
            try { plan2 = _parsePlan(await llm(_buildReformulatePrompt(q, { round: rounds + 1, tried, sampleTitles }))); } catch (_) {}
            if (plan2) plan2.reformulated = true;
        }
        if (!plan2 && !usedDeterministic && !found.length) { plan2 = _reformulate(plan); usedDeterministic = true; }
        if (!plan2) break;
        plan = plan2; rounds++;
        prog('search', `round ${rounds} — reformulating (pool still thin)`);
        const beforeN = found.length;
        mergeIntoFound(await _search(plan, paperTools, maxPapers, queryLog, firedLabels));
        if (plan.knownPapers && plan.knownPapers.length) {
            mergeIntoFound(await _lookupKnownPapers(plan.knownPapers, paperTools, queryLog));
        }
        markFired();
        prog('search', `round ${rounds} — ${found.length} candidate(s)`);
        if (found.length > beforeN) break;   // progress — hand over to preselect/read (rescue remains the backstop)
    }
    const missesNow = () => queryLog.filter(qq => qq.added === 0).map(qq => qq.label);   // #10
    const meta = () => ({ queries: queryLog.map(qq => ({ label: qq.label, added: qq.added, err: qq.err || undefined })), rounds, misses: missesNow() });
    if (!found.length) return Object.assign(_emptyBrief(q, `no papers found after ${rounds} search round(s)`, plan), meta());

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
    //
    // L2 (run Q_3VRPXL): preselect is an ORDERING device, never a terminator. The
    // old code returned an empty brief when the judge said "none" — for a hyper-
    // specific question (SU(4), L=2, 6-dim antisym rep) it rejected 11 on-topic
    // integrability papers unread. Abstracts under-describe methods; the R9
    // principle is READ-before-judge, so when preselect declines we still read the
    // top-ranked candidates and let the full-text judge decide.
    let toRead = null;
    let preselectDeclined = false;
    if (llm) {
        try {
            const resp = await llm(_buildPreselectPrompt(q, found.slice(0, maxPapers), maxRead, plan.avoid));
            const idxs = _parseIndices(resp, found.length);
            if (idxs.length) {
                toRead = idxs.slice(0, maxRead).map(i => found[i]).filter(Boolean);
            } else if (/^\s*none\s*$/i.test(String(resp || ''))) {
                preselectDeclined = true;   // noted in diagnostics; reading proceeds anyway
            }
            // else: unparseable → fall through to token pre-pick below.
        } catch (_) {}
    }
    if (!toRead) {
        // No LLM (tests), preselect unparseable, or preselect declined → ranked pick.
        // On a decline read fewer (2) — enough for the full-text judge to overrule
        // a bad abstract-level call without paying for a full read set.
        const ranked = found.map(p => ({ p, s: _relevance(q, p) })).sort((a, b) => b.s - a.s);
        const count = preselectDeclined ? Math.min(found.length, 2) : Math.min(found.length, maxRead + 2);
        toRead = ranked.slice(0, count).map(r => r.p);
    }

    // R7: papers the planner NAMED are read FIRST and bypass preselect — an
    // abstract-level judge must not veto a paper the model explicitly asked for.
    const knownInPool = found.filter(p => p.known);
    if (knownInPool.length) {
        const keyR = (p) => (p.arxivId || p.doi || p.title || '').toLowerCase();
        const inRead = new Set(toRead.map(keyR));
        const extraKnown = knownInPool.filter(p => !inRead.has(keyR(p))).slice(0, 3);
        toRead = [...knownInPool.filter(p => inRead.has(keyR(p))), ...extraKnown,
                  ...toRead.filter(p => !p.known)].slice(0, maxRead + 3);
    }

    // 4. READ + JUDGE + EXTRACT per paper (fail-open retry/uncertain in _readAndJudge).
    prog('preselect', `${toRead.length} paper(s) shortlisted to read`);
    const considered = [];
    for (let i = 0; i < toRead.length; i++) {
        const p = toRead[i];
        if (signal && signal.aborted) break;
        if (considered.filter(c => c.relevant === true).length >= maxRead) break;   // enough CONFIRMED ones
        prog('read', `${i + 1}/${toRead.length} — ${String(p.title || p.arxivId || 'untitled').slice(0, 80)}`);
        considered.push(await _readAndJudge(p, { q, paperTools, llm, avoid: plan.avoid }));
    }
    prog('judge', 'assessing relevance & extracting relations');

    // 4a. RESCUE round (R6, never-give-up): everything read was rejected or
    // unjudgeable but the round budget remains → reformulate WITH the rejection
    // feedback ("we read these, they were about X — the task needs Y") and read up
    // to 2 candidates the new queries surface that the old pool did NOT contain.
    // Same-pool re-searches and unparseable reformulations are no-ops by design.
    if (llm && rounds < maxRounds && !(signal && signal.aborted)
        && considered.length && !considered.some(c => c.relevant === true)) {
        const attempt = {
            round: rounds + 1,
            tried: queryLog.map(qq => `${qq.label} (found ${qq.added})`),
            sampleTitles: found.slice(0, 6).map(p => p.title).filter(Boolean),
            rejected: considered.filter(c => c.relevant === false).slice(0, 4)
                .map(c => ({ title: c.paper.title || '(untitled)', reason: c.reason || '' })),
        };
        let plan2 = null;
        try { plan2 = _parsePlan(await llm(_buildReformulatePrompt(q, attempt))); } catch (_) {}
        if (plan2) {
            plan2.reformulated = true;
            rounds++;
            const knownKeys = new Set(found.map(p => (p.arxivId || p.doi || p.title || '').toLowerCase()));
            const extra = await _search(plan2, paperTools, maxPapers, queryLog, firedLabels);
            markFired();
            // R7: the reformulator may NAME papers it knows — look them up too.
            if (plan2.knownPapers && plan2.knownPapers.length) {
                try { extra.push(...await _lookupKnownPapers(plan2.knownPapers, paperTools, queryLog)); } catch (_) {}
            }
            const fresh = extra.filter(p => {
                const k = (p.arxivId || p.doi || p.title || '').toLowerCase();
                return k && !knownKeys.has(k);
            });
            if (fresh.length) {
                plan = plan2;   // the reformulated plan is the one that produced results
                const rankedFresh = fresh
                    .map(p => ({ p, s: _relevance(q, p) }))
                    .sort((a, b) => (b.p.known ? 1 : 0) - (a.p.known ? 1 : 0) || b.s - a.s)
                    .slice(0, 2);
                for (const { p } of rankedFresh) {
                    if (signal && signal.aborted) break;
                    const entry = await _readAndJudge(p, { q, paperTools, llm, avoid: plan2.avoid || plan.avoid });
                    entry.rescue = true;
                    considered.push(entry);
                    found.push(p);
                }
            }
        }
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
    const consideredOut = considered.map(c => ({ ref: _refOf(c.paper), title: c.paper.title, relevant: c.relevant, grade: c.grade || null, reason: c.reason, foundVia: c.paper.foundVia || [], forward: !!c.forward, rescue: !!c.rescue }));

    if (!relevant.length) {
        const note = uncertain.length
            ? `no clearly-relevant papers; ${uncertain.length} could not be judged (kept as uncertain)`
            : `no relevant papers after reading (${rounds} search round${rounds > 1 ? 's' : ''} tried)`;
        const b = _emptyBrief(q, note, plan,
            { searched: found.length, read: considered.length, relevant: 0, fullText: fullTextCount, uncertain: uncertain.length, preselectDeclined: preselectDeclined || undefined, rounds });
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
                eqNumber: r.eqNumber || undefined,   // I9: citable as "eq. (N) of <ref>"
                specializeHint: r.specializeHint || undefined,   // L3: how to adapt a GENERAL relation
                grade: c.grade || undefined,
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
            relevant: true, grade: c.grade || 'direct', reason: c.reason, fullText: c.hasFullText,
            foundVia: c.paper.foundVia || [], citations: c.paper.citations || 0, viaForward: !!c.forward,
            score: Math.round(score * 1000) / 1000, scoreParts,   // #19 transparency
        })),
        // Transparency: every paper we read and our verdict (so "rejected neutron-star" is visible).
        considered: consideredOut,
        uncertain: uncertainOut,
        key_equations: key_equations.slice(0, 24),
        observations: observations.slice(0, 14),
        queries: queryLog.map(qq => ({ label: qq.label, added: qq.added, err: qq.err || undefined })),
        rounds, misses: missesNow(), topAuthors,
        diagnostics: {
            searched: found.length, read: considered.length, relevant: relevant.length,
            uncertain: uncertain.length, fullText: fullTextCount, equations: key_equations.length,
            preselectDeclined: preselectDeclined || undefined,
            rounds, rescued: considered.filter(c => c.rescue).length || undefined,
        },
    };
}

// ── lit_read: targeted deep-read of ONE already-found paper (I10) ─────────────

function _buildDeepReadPrompt(question, arxivId, chunks, eqLines) {
    return [
        `QUESTION about paper arXiv:${arxivId}: ${question}`,
        '',
        'Below are the equations and the most relevant text excerpts from the paper.',
        'Answer the question DIRECTLY from this material. Quote the exact equations',
        '(with their numbers when shown) and the definitions/conventions around them.',
        'If the material does not answer the question, say so — do NOT invent content.',
        '',
        'EQUATIONS (numbered where the paper numbers them):',
        ...eqLines.map(l => '  ' + l),
        '',
        'EXCERPTS:',
        ...chunks.map((c, i) => `--- excerpt ${i + 1} ---\n${c}`),
        '',
        'Reply ONLY as JSON:',
        '{"answer": "direct answer, ≤10 sentences",',
        ' "equations": [{"latex": "...", "eqNumber": "3.12 or null", "context": "one sentence on what it states"}],',
        ' "excerpts": [{"text": "verbatim passage that supports the answer"}]}',
    ].join('\n');
}

function _parseDeepRead(text) {
    try {
        const o = JSON.parse(String(text || '').match(/\{[\s\S]*\}/)[0]);
        return {
            answer: String(o.answer || '').slice(0, 2000),
            equations: Array.isArray(o.equations)
                ? o.equations.map(e => ({
                    latex:    String((e && e.latex) || '').slice(0, 2000),
                    eqNumber: (e && e.eqNumber && !/^null$/i.test(String(e.eqNumber))) ? String(e.eqNumber).slice(0, 20) : null,
                    context:  String((e && e.context) || '').slice(0, 300),
                })).filter(e => e.latex).slice(0, 8)
                : [],
            excerpts: Array.isArray(o.excerpts)
                ? o.excerpts.map(x => ({ text: String((x && x.text) || '').slice(0, 1500) })).filter(x => x.text).slice(0, 3)
                : [],
        };
    } catch (_) { return null; }
}

/**
 * Deep-read one paper against a focused question. Full text is fetched once and
 * cached via loadCache/saveCache (per-run paper cache); each call selects the
 * question-relevant chunks and asks the literature LLM for a targeted answer.
 *
 * @param {{
 *   arxivId:   string,
 *   question:  string,
 *   paperTools: { fetchPaperHtml, extractSections },
 *   llm?:      (prompt: string) => Promise<string>,
 *   loadCache?: (arxivId: string) => Promise<object|null>,
 *   saveCache?: (arxivId: string, data: object) => Promise<void>,
 * }} args
 * @returns {Promise<{ arxivId, hasFullText, source, answer, equations, excerpts, note? }>}
 */
async function readPaper({ arxivId, question, paperTools, llm, loadCache, saveCache }) {
    const id = String(arxivId || '').trim();
    const q  = String(question || '').trim();
    if (!id || !q || !paperTools) return { arxivId: id, hasFullText: false, source: 'none', answer: '', equations: [], excerpts: [], note: 'bad args' };

    // 1. Cached extraction, or fetch + extract once (deep limits — this is the
    //    full-text store the search pipeline's 12k-char sample is too small for).
    let cached = null;
    if (loadCache) { try { cached = await loadCache(id); } catch (_) {} }
    if (!cached) {
        const fetch = await _normalizeFetch(paperTools, id).catch(() => ({ html: '', source: 'none', hasFullText: false }));
        const sections = (fetch.html && typeof paperTools.extractSections === 'function')
            ? paperTools.extractSections(fetch.html, { maxText: 60000, maxEqs: 200, maxSections: 60 })
            : { headings: [], equations: [], equationsTagged: [], textSample: '' };
        cached = { arxivId: id, source: fetch.source, hasFullText: fetch.hasFullText, sections, cachedAt: new Date().toISOString() };
        if (saveCache) { try { await saveCache(id, cached); } catch (_) {} }
    }
    const sections = cached.sections || { headings: [], equations: [], equationsTagged: [], textSample: '' };

    // 2. Select the question-relevant text chunks (keyword overlap, cheap).
    const kw = new Set(_keywords(q));
    const text = String(sections.textSample || '');
    const CHUNK = 2000;
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    const scored = chunks.map((c, i) => {
        const toks = new Set(_keywords(c));
        let hit = 0; for (const t of kw) if (toks.has(t)) hit++;
        return { c, i, score: kw.size ? hit / kw.size : 0 };
    }).sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, 4).sort((a, b) => a.i - b.i).map(s => s.c);

    const eqLines = (sections.equationsTagged && sections.equationsTagged.length)
        ? sections.equationsTagged.slice(0, 60).map(e => (e.eqNumber ? `(${e.eqNumber}) ` : '') + e.latex)
        : (sections.equations || []).slice(0, 60);

    // 3. LLM answer (or a raw digest when no LLM is configured).
    if (!llm) {
        return {
            arxivId: id, hasFullText: !!cached.hasFullText, source: cached.source || 'unknown',
            answer: '(no literature model configured — raw digest below)',
            equations: (sections.equationsTagged || []).slice(0, 8).map(e => ({ latex: e.latex, eqNumber: e.eqNumber, context: '' })),
            excerpts: picked.slice(0, 2).map(t => ({ text: t.slice(0, 1500) })),
        };
    }
    let parsed = null;
    try { parsed = _parseDeepRead(await llm(_buildDeepReadPrompt(q, id, picked, eqLines))); } catch (_) {}
    if (!parsed) {
        return {
            arxivId: id, hasFullText: !!cached.hasFullText, source: cached.source || 'unknown',
            answer: '(deep-read model reply unparseable — raw digest below)',
            equations: (sections.equationsTagged || []).slice(0, 8).map(e => ({ latex: e.latex, eqNumber: e.eqNumber, context: '' })),
            excerpts: picked.slice(0, 2).map(t => ({ text: t.slice(0, 1500) })),
        };
    }
    return { arxivId: id, hasFullText: !!cached.hasFullText, source: cached.source || 'unknown', ...parsed };
}

module.exports = {
    runResearch,
    readPaper,
    extractArxivIds: _extractArxivIds,
    _internals: { _keywords, _relevance, _refOf, _parsePlan, _buildQueries, _authorQueriesFromText, _reformulate, _coerceRelevant, _parseJudge, _parseIndices, _buildPlanPrompt, _buildReformulatePrompt, _buildPreselectPrompt, _buildReadPrompt, _buildJudgeRetryPrompt, _buildDeepReadPrompt, _parseDeepRead, _search, _normalizeFetch, _readAndJudge, _lookupKnownPapers, _extractArxivIds },
};
