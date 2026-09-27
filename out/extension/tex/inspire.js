// inspire.js — citations from INSPIRE-HEP (inspirehep.net), for the citation
// picker: search as the reader types, and the chosen record's BibTeX (or its
// \bibitem, for a paper whose bibliography is written in the .tex).
//
// Only what the reader typed into the picker is sent, to INSPIRE's public
// REST API (https://github.com/inspirehep/rest-api-doc); nothing about the
// reader or the paper. The parsing is pure and tested; `get` is the only I/O.

const https = require('https');

const API = 'https://inspirehep.net/api/literature';
const USER_AGENT = 'WPaper (INSPIRE citation search)';

/** What to ask INSPIRE for what was typed: an arXiv number or a texkey exactly, anything else as a search. */
function inspireQuery(text) {
    const q = String(text || '').trim();
    if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(q)) return `arxiv:${q.replace(/^arxiv:/i, '').replace(/v\d+$/, '')}`;
    if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/i.test(q)) return `arxiv:${q}`;
    if (/^[A-Za-z][\w'-]*:\d{4}[a-z]{2,3}$/.test(q)) return `texkey:${q}`;
    return q;
}

function searchUrl(text, size = 15) {
    const fields = 'titles,first_author,author_count,texkeys,arxiv_eprints,earliest_date,control_number';
    return `${API}?size=${size}&fields=${fields}&q=${encodeURIComponent(inspireQuery(text))}`;
}

/** The picker's rows from a search answer: `{ key, title, author, year, eprint, recid, source }`. */
function parseSearch(json) {
    const hits = json?.hits?.hits || [];
    const out = [];
    for (const hit of hits) {
        const m = hit.metadata || {};
        const key = (m.texkeys || [])[0];
        if (!key) continue;
        const first = String(m.first_author?.full_name || '').split(',')[0].trim();
        const count = Number(m.author_count) || 0;
        out.push({ key, recid: m.control_number ?? hit.id ?? null, source: 'inspire',
            title: String(m.titles?.[0]?.title || '').replace(/\s+/g, ' ').trim(),
            author: first ? (count > 2 ? `${first} et al.` : count === 2 ? `${first} and co.` : first) : '',
            year: String(m.earliest_date || '').slice(0, 4), eprint: m.arxiv_eprints?.[0]?.value || '' });
    }
    return out;
}

/** INSPIRE's latex-eu entry as a \bibitem for thebibliography: its own comment lines dropped. */
function cleanBibitem(text) {
    return String(text || '').split('\n').filter(line => !/^\s*%/.test(line)).join('\n').trim();
}

function get(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: url.includes('format=') ? 'text/plain' : 'application/json' }, timeout: timeoutMs }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(get(new URL(res.headers.location, url).toString(), timeoutMs));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(Error(`INSPIRE answered ${res.statusCode}`)); }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; if (body.length > 4 << 20) req.destroy(Error('INSPIRE answer too large')); });
            res.on('end', () => resolve(body));
        });
        req.on('timeout', () => req.destroy(Error('INSPIRE did not answer in time')));
        req.on('error', reject);
    });
}

async function searchInspire(text) { return parseSearch(JSON.parse(await get(searchUrl(text)))); }
async function inspireBibtex(recid) { return (await get(`${API}/${encodeURIComponent(recid)}?format=bibtex`)).trim(); }
async function inspireBibitem(recid) { return cleanBibitem(await get(`${API}/${encodeURIComponent(recid)}?format=latex-eu`)); }

module.exports = { inspireQuery, searchUrl, parseSearch, cleanBibitem, searchInspire, inspireBibtex, inspireBibitem };
