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
    const parts = [];
    if (params.eprint)  return `find eprint ${params.eprint}`;
    if (params.texkey)  return `find texkey ${params.texkey}`;
    if (params.title)   parts.push(`t ${params.title}`);
    if (params.author)  parts.push(`a ${params.author}`);
    if (params.abstract) parts.push(`abs ${params.abstract}`);
    // query field: use raw if it already starts with 'find', else wrap it
    if (params.query) {
        const q = params.query.trim();
        parts.push(/^find\b/i.test(q) ? q : q);
    }
    if (parts.length === 0) return '';
    // If any part is already a full 'find ...' expression, don't double-wrap
    const allRaw = parts.length === 1 && /^find\b/i.test(parts[0]);
    return allRaw ? parts[0] : `find ${parts.join(' and ')}`;
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

async function searchInspire(params, maxResults = 5) {
    const q = buildInspireQuery(params);
    if (!q) throw new Error('No search criteria provided');

    const fields = 'titles,authors.full_name,abstracts,arxiv_eprints,dois,texkeys,publication_info,imprints,citation_count';
    const url = `https://inspirehep.net/api/literature?q=${encodeURIComponent(q)}&size=${maxResults}&fields=${fields}`;
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
async function searchArxiv(params, maxResults = 5) {
    const parts = [];
    if (params.title)    parts.push(`ti:${params.title}`);
    if (params.author)   parts.push(`au:${params.author}`);
    if (params.abstract) parts.push(`abs:${params.abstract}`);
    if (params.eprint)   parts.push(`id:${params.eprint}`);
    if (params.query)    parts.push(`all:${params.query}`);
    if (parts.length === 0) throw new Error('No search criteria');

    const sq = parts.join('+AND+');
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(sq)}&max_results=${maxResults}`;
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

// ── Semantic Scholar — citation contexts ─────────────────────────────────

/**
 * Get papers + citation contexts for papers that CITE the given paper.
 * Returns array of { title, contexts[], intents[] }
 */
async function getCitationContexts(arxivId, limit = 10) {
    const url = `https://api.semanticscholar.org/graph/v1/paper/ArXiv:${arxivId}/citations?fields=title,contexts,intents&limit=${limit}`;
    const data = await jsonGet(url);
    return (data?.data || []).map(d => ({
        title: d.citingPaper?.title || '(unknown)',
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
async function searchPapers(params, maxResults = 5) {
    try {
        const papers = await searchInspire(params, maxResults);
        if (papers.length > 0) return { source: 'INSPIRE-HEP', papers };
    } catch (e) {
        // INSPIRE failed — fall through to arXiv
    }
    try {
        const papers = await searchArxiv(params, maxResults);
        return { source: 'arXiv', papers };
    } catch (e2) {
        throw new Error(`Both INSPIRE and arXiv searches failed: ${e2.message}`);
    }
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

module.exports = {
    // Search
    searchPapers,
    searchInspire,
    searchArxiv,
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
