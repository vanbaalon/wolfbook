// paperSearch.js — INSPIRE-HEP + arXiv + Semantic Scholar paper search module
// ---------------------------------------------------------------------------
// Primary:   INSPIRE-HEP API (inspirehep.net/api)  — best for HEP papers
// Fallback:  arXiv API (export.arxiv.org/api)       — broader coverage
// Extras:    Semantic Scholar (api.semanticscholar.org) — citation contexts
// ---------------------------------------------------------------------------

const https = require('https');
const http  = require('http');

// ── HTTP helpers ────────────────────────────────────────────────────────────

/** Simple GET returning a Promise<string>. Follows up to 3 redirects. */
function httpGet(url, accept = 'application/json', _depth = 0) {
    if (_depth > 3) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { Accept: accept, 'Accept-Encoding': 'identity', 'User-Agent': 'Wolfbook/1.0' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(httpGet(res.headers.location, accept, _depth + 1));
            }
            if (res.statusCode === 429) {
                return reject(new Error('Rate limited (429)'));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const bufs = [];
            res.on('data', chunk => bufs.push(chunk));
            res.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function jsonGet(url) {
    return httpGet(url).then(body => JSON.parse(body));
}

// ── INSPIRE-HEP ────────────────────────────────────────────────────────────

/**
 * Build an INSPIRE search query from structured fields.
 * Supports: title (t), author (a), abstract, eprint, texkey, freeform query (q).
 */
function buildInspireQuery(params) {
    if (params.eprint)  return `find eprint ${params.eprint}`;
    if (params.texkey)  return `find texkey ${params.texkey}`;
    // Structured/precise fields → SPIRES `find` syntax (these are exact constraints).
    const fielded = [];
    if (params.title)    fielded.push(`t ${params.title}`);
    if (params.author)   fielded.push(`a ${params.author}`);
    if (params.abstract) fielded.push(`abs ${params.abstract}`);
    if (fielded.length) return `find ${fielded.join(' and ')}`;
    // Prose-only → FREE-TEXT relevance search. Do NOT wrap bare prose in `find`:
    // `find <many words>` ANDs every token implicitly and collapses recall (the
    // failure that hid arXiv:1608.06504). A plain query lets INSPIRE rank by relevance.
    if (params.query) {
        const q = params.query.trim();
        return /^find\b/i.test(q) ? q : q;
    }
    return '';
}

/** Detect identifier type: 'inspireId' | 'arxivNew' | 'arxivOld' | 'texkey' */
function identifierType(id) {
    if (/^\d+$/.test(id))                                return 'inspireId';
    if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id))            return 'arxivNew';
    if (/^[a-z][a-z.-]+\/\d{7}(v\d+)?$/i.test(id))     return 'arxivOld';
    return 'texkey';
}

/**
 * Resolve an identifier to an INSPIRE base URL fragment.
 * For arXiv IDs use the /arxiv/<id> endpoint which is more reliable than find eprint.
 */
function inspireUrlForId(identifier) {
    const type = identifierType(identifier);
    const cleanId = identifier.replace(/v\d+$/, '');
    if (type === 'inspireId') return `/api/literature/${cleanId}`;
    if (type === 'arxivNew' || type === 'arxivOld') {
        return `/api/arxiv/${cleanId}`;
    }
    // texkey — still use search
    return null;
}

/**
 * Search INSPIRE-HEP.  Returns array of paper objects:
 * { inspireId, title, authors[], abstract?, arxivId?, doi?, texkey, year, ar5ivUrl }
 */
function parseInspireHit(h) {
    const m = h.metadata || {};
    const arxivEprint = m.arxiv_eprints?.[0]?.value || null;
    const year = m.imprints?.[0]?.date?.slice(0, 4)
        || m.publication_info?.[0]?.year?.toString()
        || null;
    return {
        inspireId: h.id,
        title: m.titles?.[0]?.title || '(no title)',
        authors: (m.authors || []).map(a => a.full_name),
        abstract: m.abstracts?.[0]?.value || null,
        arxivId: arxivEprint,
        doi: m.dois?.[0]?.value || null,
        texkey: m.texkeys?.[0] || null,
        year,
        citations: m.citation_count ?? null,
        ar5ivUrl: arxivEprint ? `https://ar5iv.labs.arxiv.org/html/${arxivEprint}` : null,
        inspireUrl: `https://inspirehep.net/literature/${h.id}`,
    };
}

async function searchInspire(params, maxResults = 5, { sort } = {}) {
    const q = buildInspireQuery(params);
    if (!q) throw new Error('No search criteria provided');

    const fields = 'titles,authors.full_name,abstracts,arxiv_eprints,dois,texkeys,publication_info,imprints,citation_count';
    let url = `https://inspirehep.net/api/literature?q=${encodeURIComponent(q)}&size=${maxResults}&fields=${fields}`;
    // Impact ranking (#3): surface canonical, highly-cited methods papers. INSPIRE's
    // default (no sort) is relevance/bestmatch; 'mostcited' floats the standard refs up.
    if (sort && sort !== 'relevance') url += `&sort=${encodeURIComponent(sort)}`;
    const data = await jsonGet(url);
    const hits = data?.hits?.hits || [];
    return hits.map(parseInspireHit);
}

/**
 * Get BibTeX for a paper from INSPIRE. Accepts inspireId or texkey or eprint.
 */
async function getInspireBibtex(identifier) {
    const directUrl = inspireUrlForId(identifier);
    if (directUrl) {
        return httpGet(`https://inspirehep.net${directUrl}`, 'application/x-bibtex');
    }
    const q = `find texkey ${identifier}`;
    const url = `https://inspirehep.net/api/literature?q=${encodeURIComponent(q)}&size=1`;
    return httpGet(url, 'application/x-bibtex');
}

/**
 * Get LaTeX \bibitem for a paper (INSPIRE's "latex-us" format).
 */
async function getInspireLatexUS(identifier) {
    const directUrl = inspireUrlForId(identifier);
    if (directUrl) {
        return httpGet(`https://inspirehep.net${directUrl}?format=latex-us`, 'text/plain');
    }
    const q = `find texkey ${identifier}`;
    const url = `https://inspirehep.net/api/literature?q=${encodeURIComponent(q)}&size=1&format=latex-us`;
    return httpGet(url, 'text/plain');
}

/**
 * Get references (papers cited BY the given paper) from INSPIRE.
 * Returns array of { label, authors[], arxivEprint?, texkey? }
 */
async function getInspireReferences(identifier) {
    let url;
    const directUrl = inspireUrlForId(identifier);
    if (directUrl) {
        url = `https://inspirehep.net${directUrl}?fields=references`;
    } else {
        const q = `find texkey ${identifier}`;
        url = `https://inspirehep.net/api/literature?q=${encodeURIComponent(q)}&size=1&fields=references`;
    }
    const data = await jsonGet(url);
    // Direct endpoint returns the record directly; search endpoint returns hits wrapper
    const hit = data?.hits?.hits?.[0] || (data?.metadata ? data : null);
    const refs = hit?.metadata?.references || [];
    return refs.map((r, i) => {
        const ref = r.reference || {};
        return {
            label: ref.label || (i + 1).toString(),
            authors: (ref.authors || []).map(a => a.full_name || a.last_name || '').filter(Boolean),
            arxivEprint: ref.arxiv_eprint || null,
            title: ref.title?.title || null,
            texkey: ref.texkey || null,
            misc: ref.misc?.[0] || null,
            inspireUrl: r.record?.['$ref']?.replace('https://inspirehep.net/api/literature/', 'https://inspirehep.net/literature/') || null,
        };
    });
}

// ── arXiv API (fallback) ────────────────────────────────────────────────────

/** Minimal XML tag extractor (no dependency). */
function xmlText(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const m = xml.match(re);
    return m ? m[1].trim() : '';
}
function xmlAll(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
    return out;
}

/**
 * Search arXiv API.  Returns array of paper objects matching searchInspire format.
 */
/**
 * Build a safe arXiv `search_query` string (pure; URL-unencoded). Special characters
 * that break the arXiv boolean grammar — parentheses (e.g. `SU(3)`), colons, quotes —
 * are stripped, prose is split into a bounded AND of `abs:` terms (not one raw `all:`
 * blob), and category constraints are always applied. Returned value is encoded by the
 * caller exactly once (the old code double-encoded `+AND+` → literal `%2BAND%2B`).
 */
function buildArxivQuery(params, categories) {
    const sanitize = (s) => String(s || '').replace(/["()[\]{}:]/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = [];
    if (params.title)    parts.push(`ti:"${sanitize(params.title)}"`);
    if (params.author)   parts.push(`au:"${sanitize(params.author)}"`);
    if (params.abstract) parts.push(`abs:"${sanitize(params.abstract)}"`);
    if (params.eprint)   parts.push(`id:${sanitize(params.eprint)}`);
    if (params.query) {
        const kws = sanitize(params.query).split(' ').filter(w => w.length > 1).slice(0, 6);
        if (kws.length) parts.push('(' + kws.map(k => `abs:${k}`).join(' AND ') + ')');
    }
    const cats = Array.isArray(categories) ? categories.filter(Boolean)
        : (Array.isArray(params.categories) ? params.categories.filter(Boolean) : []);
    if (cats.length) parts.push('(' + cats.map(c => `cat:${c}`).join(' OR ') + ')');
    return parts.join(' AND ');
}

async function searchArxiv(params, maxResults = 5, { sort } = {}) {
    // R9: a bare id lookup uses the documented `id_list` parameter — the
    // `search_query=id:` field grammar is flaky for new-style ids.
    let url;
    if (params.eprint && !params.title && !params.author && !params.abstract && !params.query) {
        const id = String(params.eprint).trim().replace(/^arXiv:/i, '').replace(/v\d+$/, '');
        url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=${maxResults}`;
    } else {
        const sq = buildArxivQuery(params);
        if (!sq) throw new Error('No search criteria');
        // arXiv has no citation sort; map any impact request to its best proxy, relevance.
        const sortBy = (sort === 'mostcited' || !sort) ? 'relevance' : sort;
        url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(sq)}`
            + `&sortBy=${sortBy}&sortOrder=descending&max_results=${maxResults}`;
    }
    const xml = await httpGet(url, 'application/atom+xml');

    const entries = xmlAll(xml, 'entry');
    return entries.map(entry => {
        const idUrl = xmlText(entry, 'id');
        const arxivId = idUrl.replace(/.*abs\//, '').replace(/v\d+$/, '');
        const authorNames = xmlAll(entry, 'name');
        const year = xmlText(entry, 'published').slice(0, 4);
        return {
            inspireId: null,
            title: xmlText(entry, 'title').replace(/\s+/g, ' '),
            authors: authorNames,
            abstract: xmlText(entry, 'summary').replace(/\s+/g, ' '),
            arxivId,
            doi: null,
            texkey: null,
            year,
            ar5ivUrl: `https://ar5iv.labs.arxiv.org/html/${arxivId}`,
            inspireUrl: null,
            arxivUrl: `https://arxiv.org/abs/${arxivId}`,
        };
    });
}

// ── Semantic Scholar — keyword/relevance search ──────────────────────────

/**
 * Search Semantic Scholar's relevance-ranked engine. Handles prose-ish and
 * method-level queries far better than arXiv's `abs:` AND-grammar (arXiv
 * requires every term to co-occur; S2 ranks by relevance), and returns
 * citation counts that feed the blended ranking. Unauthenticated shared rate
 * pool — callers keep per-run query counts small and treat failures as soft.
 */
async function searchSemanticScholar(params, maxResults = 8) {
    const q = [params.query || '', params.author || '', params.abstract || '', params.title || '']
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!q) throw new Error('No search criteria');
    const fields = 'title,abstract,year,authors,externalIds,citationCount';
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}`
        + `&fields=${fields}&limit=${Math.min(Math.max(1, maxResults), 20)}`;
    const data = await jsonGet(url);
    return (data?.data || []).map(d => {
        const arxivId = d.externalIds?.ArXiv || null;
        return {
            inspireId: null,
            title: (d.title || '').replace(/\s+/g, ' '),
            authors: (d.authors || []).map(a => a && a.name).filter(Boolean),
            abstract: (d.abstract || '').replace(/\s+/g, ' '),
            arxivId,
            doi: d.externalIds?.DOI || null,
            texkey: null,
            year: d.year ? String(d.year) : '',
            citations: d.citationCount || 0,
            ar5ivUrl: arxivId ? `https://ar5iv.labs.arxiv.org/html/${arxivId}` : null,
            inspireUrl: null,
            arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
        };
    });
}

// ── Semantic Scholar — citation contexts ─────────────────────────────────

/**
 * Get papers + citation contexts for papers that CITE the given paper.
 * Returns array of { title, arxivId?, contexts[], intents[] } — arxivId lets the
 * forward citation snowball (#18) add citing papers as new candidates.
 */
async function getCitationContexts(arxivId, limit = 10) {
    const url = `https://api.semanticscholar.org/graph/v1/paper/ArXiv:${arxivId}/citations?fields=title,externalIds,contexts,intents&limit=${limit}`;
    const data = await jsonGet(url);
    return (data?.data || []).map(d => ({
        title: d.citingPaper?.title || '(unknown)',
        arxivId: d.citingPaper?.externalIds?.ArXiv || null,
        contexts: d.contexts || [],
        intents: d.intents || [],
    }));
}

/**
 * Get papers cited BY the given paper, with citation contexts.
 * Returns array of { title, arxivId?, contexts[], intents[] }
 */
async function getReferenceContexts(arxivId, limit = 20) {
    const url = `https://api.semanticscholar.org/graph/v1/paper/ArXiv:${arxivId}/references?fields=title,externalIds,contexts,intents&limit=${limit}`;
    const data = await jsonGet(url);
    return (data?.data || []).map(d => ({
        title: d.citedPaper?.title || '(unknown)',
        arxivId: d.citedPaper?.externalIds?.ArXiv || null,
        contexts: d.contexts || [],
        intents: d.intents || [],
    }));
}

// ── Unified search with INSPIRE → arXiv fallback ───────────────────────

/**
 * Search for papers.  Tries INSPIRE first; falls back to arXiv on failure.
 * @param {Object} params  { title?, author?, abstract?, eprint?, texkey?, query? }
 * @param {number} maxResults
 * @returns {Promise<{ source: string, papers: Object[] }>}
 */
async function searchPapers(params, maxResults = 5, { sort } = {}) {
    try {
        const papers = await searchInspire(params, maxResults, { sort });
        if (papers.length > 0) return { source: 'INSPIRE-HEP', papers };
    } catch (e) {
        // INSPIRE failed — fall through to arXiv
    }
    let arxivErr = null;
    let arxivPapers = null;
    try {
        arxivPapers = await searchArxiv(params, maxResults, { sort });
        if (arxivPapers.length > 0) return { source: 'arXiv', papers: arxivPapers };
    } catch (e2) {
        arxivErr = e2;
    }
    // Semantic Scholar last: its relevance ranking rescues prose/method queries
    // that arXiv's exact AND-grammar returns nothing for.
    try {
        const papers = await searchSemanticScholar(params, maxResults);
        if (papers.length > 0) return { source: 'SemanticScholar', papers };
    } catch (_) { /* soft */ }
    if (arxivPapers) return { source: 'arXiv', papers: arxivPapers };   // empty but not an error
    throw new Error(`INSPIRE, arXiv and Semantic Scholar searches all failed: ${arxivErr ? arxivErr.message : 'no results'}`);
}

// ── Multi-query expansion & dedup (#1) ──────────────────────────────────────

/** Canonical identity for de-duplicating the same work across queries/sources. */
function canonicalKey(p) {
    if (!p) return '';
    return String(
        p.arxivId || p.doi || p.texkey
        || (p.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
    );
}

/**
 * Merge candidate lists from several queries/sources into one deduped list.
 * Keeps the richest metadata, the MAX citation count, and unions `sources`/`foundVia`.
 */
function mergeCandidates(list) {
    const byKey = new Map();
    for (const p of (list || [])) {
        const k = canonicalKey(p);
        if (!k) continue;
        if (!byKey.has(k)) {
            byKey.set(k, {
                ...p,
                sources: p.sources || (p.source ? [p.source] : []),
                foundVia: Array.isArray(p.foundVia) ? [...p.foundVia] : [],
            });
            continue;
        }
        const e = byKey.get(k);
        e.citations = Math.max(e.citations || 0, p.citations || 0);
        e.sources = [...new Set([...(e.sources || []), ...(p.sources || (p.source ? [p.source] : []))])];
        e.foundVia = [...new Set([...(e.foundVia || []), ...(Array.isArray(p.foundVia) ? p.foundVia : [])])];
        for (const f of ['abstract', 'arxivId', 'doi', 'texkey', 'inspireId', 'year', 'authors', 'title']) {
            if ((e[f] == null || e[f] === '' || (Array.isArray(e[f]) && !e[f].length)) && p[f] != null) e[f] = p[f];
        }
    }
    return [...byKey.values()];
}

/**
 * Run several sub-queries (method-name / model / author …) and return one deduped,
 * provenance-tagged candidate list. Each query item: { label?, sort?, ...searchParams }.
 */
async function searchPapersMulti(queries, { maxPerQuery = 8 } = {}) {
    const all = [];
    for (const qy of (queries || [])) {
        const { label, sort, ...params } = qy || {};
        try {
            const r = await searchPapers(params, maxPerQuery, { sort });
            const tag = label || params.query || params.author || params.title || 'q';
            for (const p of (r.papers || [])) all.push({ ...p, source: r.source, foundVia: [tag] });
        } catch (_) { /* skip a failed sub-query, keep the rest */ }
    }
    return { papers: mergeCandidates(all) };
}

// ── Format helpers ──────────────────────────────────────────────────────

function formatPaperShort(p, idx) {
    const auth = p.authors.length > 3
        ? `${p.authors.slice(0, 3).join(', ')} et al.`
        : p.authors.join(', ');
    const lines = [];
    lines.push(`**[${idx}]** ${p.title}`);
    lines.push(`    ${auth} (${p.year || '?'})`);
    if (p.arxivId)    lines.push(`    arXiv: [${p.arxivId}](https://arxiv.org/abs/${p.arxivId})`);
    if (p.ar5ivUrl)   lines.push(`    HTML:  [ar5iv](${p.ar5ivUrl})`);
    if (p.doi)        lines.push(`    DOI:   ${p.doi}`);
    if (p.inspireUrl) lines.push(`    INSPIRE: [${p.inspireId}](${p.inspireUrl})`);
    return lines.join('\n');
}

function formatPaperFull(p, idx) {
    const lines = [formatPaperShort(p, idx)];
    if (p.abstract) {
        lines.push(`\n    **Abstract:** ${p.abstract}`);
    }
    return lines.join('\n');
}

function formatReference(r, idx) {
    const auth = r.authors.length > 0 ? r.authors.join(', ') : '';
    const parts = [`[${idx}]`];
    if (auth) parts.push(auth);
    if (r.title) parts.push(`"${r.title}"`);
    if (r.arxivEprint) parts.push(`arXiv:${r.arxivEprint}`);
    if (r.misc && !r.title) parts.push(r.misc);
    return parts.join('  ');
}

function formatCitationContext(c, idx) {
    const lines = [`**[${idx}]** ${c.title}`];
    if (c.intents.length > 0) lines.push(`    Intents: ${c.intents.join(', ')}`);
    for (const ctx of c.contexts) {
        lines.push(`    > ${ctx}`);
    }
    return lines.join('\n');
}

// ── Exports ─────────────────────────────────────────────────────────────

/**
 * Fetch the HTML rendering of a paper (ar5iv = arXiv→HTML; no PDF/OCR). Falls back to
 * the arXiv abstract page on error. Used by the literature sub-agent to read papers.
 * @param {string} arxivId
 * @param {{ maxChars?: number }} [opts]
 * @returns {Promise<string>}  raw HTML (capped)
 */
/**
 * Fetch a paper's HTML and report whether we actually got FULL TEXT or just the
 * abstract landing page. The old version silently fell back to the abstract page
 * (no equations), which made the literature extractor "succeed" with nothing.
 *
 * Tries arXiv's native HTML first (best for recent papers), then ar5iv, then the
 * abstract page (flagged hasFullText:false).
 *
 * @returns {Promise<{ html:string, source:'arxiv-html'|'ar5iv'|'abstract'|'none', hasFullText:boolean }>}
 */
async function fetchPaperHtml(arxivId, { maxChars = 400000 } = {}) {
    const id = String(arxivId || '').replace(/v\d+$/, '');
    if (!id) return { html: '', source: 'none', hasFullText: false };

    // A real full-text render carries inline math (MathML/alttext/TeX annotations).
    const looksFullText = (html) =>
        /alttext=|<math[\s>]|annotation\s+encoding="application\/x-tex"/i.test(html) || html.length > 60000;

    // ar5iv first: it's a complete LaTeX→HTML mirror of (almost) all of arXiv with
    // inline MathML+TeX, and is more reliable/complete than arxiv.org/html (which only
    // covers recent native-HTML submissions). arxiv.org/html is the secondary source.
    for (const [url, source] of [
        [`https://ar5iv.labs.arxiv.org/html/${id}`, 'ar5iv'],
        [`https://arxiv.org/html/${id}`, 'arxiv-html'],
    ]) {
        try {
            const html = String(await httpGet(url, 'text/html')).slice(0, maxChars);
            if (html && looksFullText(html)) return { html, source, hasFullText: true };
        } catch (_) { /* try next source */ }
    }
    // Last resort: the abstract page — usable for relevance/abstract only, NOT equations.
    try {
        const html = String(await httpGet(`https://arxiv.org/abs/${id}`, 'text/html')).slice(0, maxChars);
        return { html, source: 'abstract', hasFullText: false };
    } catch (_) {
        return { html: '', source: 'none', hasFullText: false };
    }
}

/**
 * Extract a model-friendly outline from ar5iv HTML: headings, paragraph text, and the
 * LaTeX of equations. ar5iv puts the source LaTeX in `<math … alttext="...">`, which is
 * far more reliable than PDF OCR.
 * @param {string} html
 * @param {{ maxSections?: number, maxEqs?: number }} [opts]
 * @returns {{ headings: string[], equations: string[], textSample: string }}
 */
function extractSections(html, { maxSections = 40, maxEqs = 80, maxText = 12000 } = {}) {
    const h = String(html || '');
    // Strip scripts/styles first.
    const clean = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_x, hx) => String.fromCharCode(parseInt(hx, 16)))
        .replace(/&#(\d+);/g, (_x, d) => String.fromCharCode(parseInt(d, 10)));

    // I9: capture displayed-equation NUMBERS so briefs and lit_read can cite
    // "eq. (3.12) of arXiv:XXXX". ar5iv marks them as
    //   <span class="ltx_tag ltx_tag_equation">(3.12)</span>
    // near the <math> node; pair each equation with the nearest tag by char offset.
    const eqTags = [];
    {
        const tagRe = /<span[^>]*class="[^"]*ltx_tag_equation[^"]*"[^>]*>\s*\(?([^<()]{1,20})\)?\s*<\/span>/gi;
        let tm;
        while ((tm = tagRe.exec(clean)) !== null) eqTags.push({ idx: tm.index, tag: tm[1].trim() });
    }
    const nearestEqTag = (idx) => {
        let best = null, bestDist = Infinity;
        for (const t of eqTags) {
            const d = Math.abs(t.idx - idx);
            if (d < bestDist && d <= 1500) { bestDist = d; best = t.tag; }
        }
        return best;
    };

    const equations = [];
    const equationsTagged = [];
    const pushEq = (raw, idx) => {
        const t = decode(String(raw)).trim();
        if (t.length >= 3 && t.length <= 600 && !equations.includes(t) && equations.length < maxEqs) {
            equations.push(t);
            equationsTagged.push({ latex: t, eqNumber: (idx != null ? nearestEqTag(idx) : null) || null });
        }
    };
    let m;
    // ar5iv: <math alttext="LaTeX">
    const altRe = /alttext="([^"]+)"/g;
    while ((m = altRe.exec(clean)) !== null) pushEq(m[1], m.index);
    // arXiv native HTML: <annotation encoding="application/x-tex">LaTeX</annotation>
    const annRe = /<annotation\s+encoding="application\/x-tex">([\s\S]*?)<\/annotation>/gi;
    while ((m = annRe.exec(clean)) !== null) pushEq(m[1].replace(/<[^>]+>/g, ''), m.index);

    // Headings.
    const headings = [];
    const hRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
    while ((m = hRe.exec(clean)) !== null && headings.length < maxSections) {
        const txt = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (txt) headings.push(txt);
    }
    // A larger plain-text sample so the LLM can actually READ the paper.
    const textSample = clean.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, maxText);
    return { headings, equations, equationsTagged, textSample };
}

module.exports = {
    // Search
    searchPapers,
    searchPapersMulti,
    searchInspire,
    searchArxiv,
    searchSemanticScholar,
    // Query builders & dedup (pure; unit-tested)
    buildInspireQuery,
    buildArxivQuery,
    canonicalKey,
    mergeCandidates,
    // HTML reading (literature sub-agent)
    fetchPaperHtml,
    extractSections,
    // Bibliography
    getInspireBibtex,
    getInspireLatexUS,
    // References & citations
    getInspireReferences,
    getCitationContexts,
    getReferenceContexts,
    // Formatters
    formatPaperShort,
    formatPaperFull,
    formatReference,
    formatCitationContext,
};
