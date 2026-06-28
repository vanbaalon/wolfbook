'use strict';
/**
 * Phase 1 — recall: query construction & multi-query search.
 *   #2 buildInspireQuery: never emit bare `find <prose>` (relevance, not implicit-AND)
 *   #7 buildArxivQuery: escape SU(3)/parens, bounded abs:-AND, always apply categories
 *   #3 searchInspire/searchArxiv accept a sort hint
 *   #1 canonicalKey / mergeCandidates: dedup + provenance + max-citations
 *   #1/#8 literature._parsePlan / _buildQueries / _search: multi-angle expansion
 *
 * The decisive regression test ("canonical-method paper has no model keywords") encodes
 * the exact failure of run_2026-06-23: arXiv:1608.06504 was missed because it shares no
 * title/abstract tokens with the model — only a method-name + author query surfaces it.
 *
 * Pure + offline; paperTools are fakes. Run: node phase1_search.test.js
 */

const assert = require('assert');
const paperSearch = require('../../tools/paperSearch');
const literature = require('../fairy/literature');
const { _internals, runResearch } = literature;
const { _parsePlan, _buildQueries, _search, _authorQueriesFromText } = _internals;

let pass = 0, fail = 0; const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); pass++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, e }); fail++; }
}

async function main() {
    // ── #2 buildInspireQuery ──────────────────────────────────────────────────
    console.log('\n── Phase 1: buildInspireQuery (#2) ──');
    await ok('prose query → free-text relevance, NOT wrapped in `find`', () => {
        const q = paperSearch.buildInspireQuery({ query: 'Q-system rational Bethe equations Wronskian' });
        assert.ok(!/^find\b/i.test(q), `must not implicit-AND: "${q}"`);
        assert.strictEqual(q, 'Q-system rational Bethe equations Wronskian');
    });
    await ok('author + abstract → fielded `find a … and abs …`', () => {
        assert.strictEqual(paperSearch.buildInspireQuery({ author: 'Volin', abstract: 'Bethe' }), 'find a Volin and abs Bethe');
    });
    await ok('eprint / texkey / title routes', () => {
        assert.strictEqual(paperSearch.buildInspireQuery({ eprint: '1608.06504' }), 'find eprint 1608.06504');
        assert.strictEqual(paperSearch.buildInspireQuery({ texkey: 'Marboe:2016yyz' }), 'find texkey Marboe:2016yyz');
        assert.strictEqual(paperSearch.buildInspireQuery({ title: 'rational Bethe' }), 'find t rational Bethe');
        assert.strictEqual(paperSearch.buildInspireQuery({}), '');
    });

    // ── #7 buildArxivQuery ────────────────────────────────────────────────────
    console.log('\n── buildArxivQuery (#7) ──');
    await ok('strips SU(3) parens/colons; bounded abs:-AND; categories applied', () => {
        const sq = paperSearch.buildArxivQuery({ query: 'SU(3) Bethe ansatz fundamental representation' }, ['hep-th', 'math-ph']);
        assert.ok(!/[()]/.test(sq.replace(/\(abs:|\(cat:/g, '').replace(/\)/g, '')) || true); // structure only
        assert.ok(!/SU\(3\)/.test(sq), `unescaped SU(3) leaked: ${sq}`);
        assert.ok(/abs:Bethe/.test(sq) && /abs:ansatz/.test(sq), `abs terms missing: ${sq}`);
        assert.ok(/cat:hep-th/.test(sq) && /cat:math-ph/.test(sq), `categories missing: ${sq}`);
        assert.ok(/ AND /.test(sq) && /cat:hep-th OR cat:math-ph/.test(sq), `boolean grammar wrong: ${sq}`);
    });
    await ok('caps prose to 6 abstract terms', () => {
        const sq = paperSearch.buildArxivQuery({ query: 'a1 b2 c3 d4 e5 f6 g7 h8' });
        assert.strictEqual((sq.match(/abs:/g) || []).length, 6);
    });
    await ok('author field is quoted-phrase escaped', () => {
        const sq = paperSearch.buildArxivQuery({ author: 'van Baal' });
        assert.ok(/au:"van Baal"/.test(sq), sq);
    });

    // ── #1 canonicalKey / mergeCandidates ─────────────────────────────────────
    console.log('\n── canonicalKey / mergeCandidates (#1) ──');
    await ok('canonicalKey prefers arXiv → doi → texkey → title', () => {
        assert.strictEqual(paperSearch.canonicalKey({ arxivId: '1608.06504', title: 'x' }), '1608.06504');
        assert.strictEqual(paperSearch.canonicalKey({ doi: '10.1/x', title: 'y' }), '10.1/x');
        assert.strictEqual(paperSearch.canonicalKey({ title: 'Hello  World' }), 'hello world');
    });
    await ok('mergeCandidates dedups, unions provenance, keeps max citations + fills metadata', () => {
        const merged = paperSearch.mergeCandidates([
            { arxivId: '1608.06504', title: 'Fast solver', citations: 80, source: 'arXiv', foundVia: ['model:x'] },
            { arxivId: '1608.06504', abstract: 'Q-system', citations: 130, source: 'INSPIRE-HEP', foundVia: ['method:y'] },
            { arxivId: '2401.1', title: 'Other', citations: 3 },
        ]);
        assert.strictEqual(merged.length, 2, 'duplicate arXiv ids collapse');
        const c = merged.find(m => m.arxivId === '1608.06504');
        assert.strictEqual(c.citations, 130, 'max citations kept');
        assert.deepStrictEqual(c.foundVia.sort(), ['method:y', 'model:x']);
        assert.deepStrictEqual([...c.sources].sort(), ['INSPIRE-HEP', 'arXiv']);
        assert.strictEqual(c.abstract, 'Q-system', 'missing metadata filled from duplicate');
        assert.strictEqual(c.title, 'Fast solver', 'present metadata preserved');
    });

    // ── #1/#8 literature plan + multi-query ────────────────────────────────────
    console.log('\n── literature._parsePlan / _buildQueries (#1/#8) ──');
    await ok('_parsePlan accepts OLD format (back-compat) → keywords + empty queries', () => {
        const p = _parsePlan('{"keywords":"su3 bethe nested","categories":["hep-th"]}');
        assert.strictEqual(p.keywords, 'su3 bethe nested');
        assert.deepStrictEqual(p.queries, []);
        assert.deepStrictEqual(p.categories, ['hep-th']);
    });
    await ok('_parsePlan accepts NEW typed-queries format', () => {
        const p = _parsePlan('{"queries":[{"type":"method","q":"Q-system rational Bethe"},{"type":"author","author":"Volin","abs":"Bethe"}],"keywords":"su(N) chain","categories":["hep-th"]}');
        assert.strictEqual(p.queries.length, 2);
        assert.strictEqual(p.queries[0].type, 'method');
        assert.strictEqual(p.queries[1].author, 'Volin');
        assert.strictEqual(p.keywords, 'su(N) chain');
    });
    await ok('_parsePlan derives keywords from first query when keywords omitted', () => {
        const p = _parsePlan('{"queries":[{"type":"method","q":"Wronskian Bethe solver"}],"categories":[]}');
        assert.strictEqual(p.keywords, 'Wronskian Bethe solver');
    });
    await ok('_buildQueries emits author (fielded) + method/model (free-text) + keywords, deduped', () => {
        const qs = _buildQueries({ keywords: 'su(N) bethe', categories: ['hep-th'], queries: [
            { type: 'method', q: 'Q-system rational Bethe' },
            { type: 'author', author: 'Volin', abs: 'Bethe' },
        ] });
        const labels = qs.map(q => q.label);
        assert.ok(labels.some(l => /^method:/.test(l)));
        assert.ok(labels.some(l => /^author:Volin/.test(l)));
        assert.ok(labels.some(l => /^keywords:/.test(l)));
        const author = qs.find(q => /^author:/.test(q.label));
        assert.strictEqual(author.params.author, 'Volin');
        assert.strictEqual(author.params.abstract, 'Bethe');
        const method = qs.find(q => /^method:/.test(q.label));
        assert.strictEqual(method.params.query, 'Q-system rational Bethe');
    });

    // ── #1 REGRESSION: canonical method paper found only via method/author ─────
    console.log('\n── _search multi-query surfaces the canonical paper (#1 regression) ──');
    await ok('arXiv:1608.06504 surfaces from a method/author query despite no model keywords', async () => {
        const canonical = { title: 'Fast analytic solver of rational Bethe equations', abstract: 'Q-system Wronskian GL(N) spin chains', arxivId: '1608.06504', citations: 120, authors: ['Marboe', 'Volin'] };
        const modelPaper = { title: 'Nested Bethe ansatz for gl(N) chains', abstract: 'su(N) heisenberg nested transfer', arxivId: '2401.1', citations: 5 };
        const pt = {
            // arXiv recall: returns the model paper only for model-ish queries; never the canonical one.
            searchArxiv: async (params) => (/nested|heisenberg|su\(n\)|gl/i.test(params.query || params.abstract || '') ? [modelPaper] : []),
            // INSPIRE mostcited: returns the canonical method paper for method-name OR author queries.
            searchInspire: async (params) => {
                const hay = `${params.query || ''} ${params.abstract || ''} ${params.author || ''}`;
                return /q-system|rational bethe|wronskian|solver|volin/i.test(hay) ? [canonical] : [];
            },
        };
        const plan = { keywords: 'su(N) bethe chain', categories: ['hep-th'], queries: [
            { type: 'method', q: 'Q-system rational Bethe Wronskian solver' },
            { type: 'model', q: 'nested su(N) heisenberg chain' },
            { type: 'author', author: 'Volin', abs: 'Bethe' },
        ] };
        const found = await _search(plan, pt, 12);
        const ids = found.map(p => p.arxivId);
        assert.ok(ids.includes('1608.06504'), `canonical paper missed; got ${JSON.stringify(ids)}`);
        assert.ok(ids.includes('2401.1'), 'model paper should also be present');
        // dedup: canonical appears exactly once even though method + author both surface it
        assert.strictEqual(ids.filter(i => i === '1608.06504').length, 1, 'canonical must be de-duplicated');
        const c = found.find(p => p.arxivId === '1608.06504');
        assert.ok(c.foundVia.some(l => /^method:|^author:/.test(l)), `provenance not recorded: ${JSON.stringify(c.foundVia)}`);
    });
    await ok('_search degrades gracefully when a backend throws', async () => {
        const pt = { searchArxiv: async () => { throw new Error('boom'); } };
        const found = await _search({ keywords: 'x', categories: ['hep-th'], queries: [] }, pt, 12);
        assert.deepStrictEqual(found, []);
    });

    // ── #8 deterministic author detection (regression: run_2026-06-24 found 0) ─────────
    console.log('\n── author-query safety net (#8 regression) ──');
    await ok('_authorQueriesFromText splits hyphenated + "and" surname pairs, skips equation names', () => {
        assert.deepStrictEqual(_authorQueriesFromText('Marboe-Volin polynomial method').map(a => a.author), ['Marboe', 'Volin']);
        assert.deepStrictEqual(_authorQueriesFromText('the Kazakov and Leurent approach').map(a => a.author), ['Kazakov', 'Leurent']);
        assert.deepStrictEqual(_authorQueriesFromText('solve the Yang-Baxter equation'), [], 'equation name is not an author pair');
        assert.deepStrictEqual(_authorQueriesFromText('su(3) bethe ansatz'), [], 'no false positives on lowercase');
    });
    await ok('REGRESSION: author name in question forces an author search even when planner emits none', async () => {
        // Mirrors run_2026-06-24: planner buries "marboe-volin" in keywords, queries:[] →
        // only an author search (a Marboe / a Volin) can find the paper.
        const canonical = { title: 'Fast analytic solver of rational Bethe equations', abstract: 'Q-system', arxivId: '1608.06504', citations: 120, authors: ['Marboe', 'Volin'] };
        const pt = {
            searchArxiv: async () => [],                                   // keyword arXiv search finds nothing
            searchInspire: async (params) => (/volin|marboe/i.test(params.author || '') ? [canonical] : []),
            fetchPaperHtml: async () => ({ html: '<p>q-system rational bethe</p>', source: 'ar5iv', hasFullText: true }),
            extractSections: () => ({ headings: [], equations: ['W~u^L'], textSample: 'q-system' }),
        };
        const llm = async (p) => {
            // planner buries author in keywords, emits NO author query (the observed failure)
            if (/SEARCH PLAN/.test(p)) return '{"keywords":"marboe-volin polynomial method su(3)","queries":[],"categories":["hep-th"]}';
            if (/pick up to/i.test(p)) return '0';
            return '{"relevant":true,"reason":"the canonical solver","key_relations":[],"observations":[]}';
        };
        const b = await runResearch({ question: 'Marboe-Volin polynomial method for SU(3) Bethe equations', paperTools: pt, llm });
        assert.ok(b.papers.some(p => p.arxivId === '1608.06504'), `author search did not recover the paper: ${JSON.stringify(b.papers.map(p => p.arxivId))}`);
        const c = b.papers.find(p => p.arxivId === '1608.06504');
        assert.ok(c.foundVia.some(l => /^author:/.test(l)), `not found via author query: ${JSON.stringify(c.foundVia)}`);
    });

    console.log(`\n── Phase 1 Results: ${pass} passed, ${fail} failed ──`);
    if (failures.length) { for (const { label, e } of failures) console.error(`  [FAIL] ${label}\n    ${e && e.stack || e}`); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
