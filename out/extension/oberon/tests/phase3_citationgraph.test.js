'use strict';
/**
 * Phase 3 — citation-graph core.
 *   #20 litCache         — disk/memory cache w/ TTL; failures not cached; stale-on-error.
 *   #12 couplingScore    — Jaccard of reference-id sets.
 *   #4  expandReferences — backward snowball (papers a seed cites → candidates).
 *   #18 expandCitations  — forward snowball (papers citing a hit → candidates).
 *   #11 rankByPrior      — order by log(citations) + coupling-to-seed.
 *   integration: runResearch surfaces a canonical paper via backward snowball, and a
 *     refinement via forward snowball; graph stays inert when the tools are absent.
 *
 * Pure + offline; paperTools/llm are fakes. Run: node phase3_citationgraph.test.js
 */

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { makeCache } = require('../fairy/litCache');
const litGraph = require('../fairy/litGraph');
const literature = require('../fairy/literature');
const { runResearch } = literature;

let pass = 0, fail = 0; const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); pass++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, e }); fail++; }
}

async function main() {
    // ── #20 litCache ────────────────────────────────────────────────────────────
    console.log('\n── Phase 3: litCache (#20) ──');
    await ok('getOrFetch memoises (fetchFn runs once)', async () => {
        const c = makeCache();
        let calls = 0;
        const f = () => { calls++; return Promise.resolve({ n: calls }); };
        const a = await c.getOrFetch('k', f);
        const b = await c.getOrFetch('k', f);
        assert.deepStrictEqual(a, { n: 1 });
        assert.deepStrictEqual(b, { n: 1 }, 'second call served from cache');
        assert.strictEqual(calls, 1);
        assert.strictEqual(c.stats().hits, 1);
    });
    await ok('ttlHours:0 forces refetch; Infinity is permanent', async () => {
        const c = makeCache({ ttlHours: 24 });
        let n = 0; const f = () => Promise.resolve(++n);
        await c.getOrFetch('k', f, { ttlHours: 0 });
        await c.getOrFetch('k', f, { ttlHours: 0 });
        assert.strictEqual(n, 2, 'ttl 0 always refetches');
        await c.getOrFetch('p', f, { ttlHours: Infinity });
        await c.getOrFetch('p', f, { ttlHours: Infinity });
        assert.strictEqual(n, 3, 'permanent entry fetched once');
    });
    await ok('fetchFn error is not cached; stale value served if present', async () => {
        const c = makeCache();
        await c.getOrFetch('k', () => Promise.resolve('good'));
        const v = await c.getOrFetch('k', () => { throw new Error('net'); }, { ttlHours: 0 });
        assert.strictEqual(v, 'good', 'stale value served on error');
        const miss = await c.getOrFetch('z', () => { throw new Error('net'); });
        assert.strictEqual(miss, null, 'no prior value → null on error');
    });
    await ok('disk mode persists across cache instances', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litcache-'));
        try {
            const c1 = makeCache({ dir });
            await c1.getOrFetch('refs:X', () => Promise.resolve([{ arxivId: '1' }]), { ttlHours: Infinity });
            const c2 = makeCache({ dir });
            let called = false;
            const v = await c2.getOrFetch('refs:X', () => { called = true; return Promise.resolve([]); }, { ttlHours: Infinity });
            assert.deepStrictEqual(v, [{ arxivId: '1' }], 'read from disk');
            assert.strictEqual(called, false, 'did not refetch');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // ── #12 couplingScore ─────────────────────────────────────────────────────────
    console.log('\n── couplingScore (#12) ──');
    await ok('Jaccard of reference sets', () => {
        assert.strictEqual(litGraph.couplingScore(['a', 'b', 'c'], ['b', 'c', 'd']), 2 / 4);
        assert.strictEqual(litGraph.couplingScore(['a'], ['a']), 1);
        assert.strictEqual(litGraph.couplingScore([], ['a']), 0);
        assert.strictEqual(litGraph.couplingScore(['a'], ['b']), 0);
    });

    // ── #4 / #18 expansion ─────────────────────────────────────────────────────────
    console.log('\n── expandReferences (#4) / expandCitations (#18) ──');
    await ok('expandReferences turns a seed\'s references into candidates (tagged ref:)', async () => {
        const pt = { getInspireReferences: async (id) => (id === 'S1' ? [
            { arxivEprint: '1608.06504', title: 'Fast solver', texkey: 'M:16' },
            { title: 'no-arxiv ref' },          // dropped: no id to fetch later
            { arxivEprint: '1010.4022', title: 'Backlund flow' },
        ] : []) };
        const cands = await litGraph.expandReferences({ seeds: [{ arxivId: 'S1' }], paperTools: pt, cache: makeCache(), max: 10 });
        const ids = cands.map(c => c.arxivId);
        assert.deepStrictEqual(ids, ['1608.06504', '1010.4022']);
        assert.ok(cands[0].foundVia.some(l => /^ref:S1/.test(l)));
    });
    await ok('expandReferences respects max + dedups; empty when tool absent', async () => {
        const pt = { getInspireReferences: async () => [{ arxivEprint: 'a' }, { arxivEprint: 'a' }, { arxivEprint: 'b' }] };
        const cands = await litGraph.expandReferences({ seeds: [{ arxivId: 'S' }], paperTools: pt, cache: makeCache(), max: 1 });
        assert.strictEqual(cands.length, 1, 'max respected');
        assert.deepStrictEqual(await litGraph.expandReferences({ seeds: [{ arxivId: 'S' }], paperTools: {}, cache: makeCache() }), []);
    });
    await ok('expandCitations turns citing papers into candidates (tagged cite:)', async () => {
        const pt = { getCitationContexts: async (id) => (id === 'H1' ? [
            { arxivId: '2502.1', title: 'Refinement', intents: ['methodology'] },
            { title: 'no id citing paper' },     // dropped
        ] : []) };
        const cands = await litGraph.expandCitations({ hits: [{ arxivId: 'H1' }], paperTools: pt, cache: makeCache(), max: 10 });
        assert.strictEqual(cands.length, 1);
        assert.strictEqual(cands[0].arxivId, '2502.1');
        assert.deepStrictEqual(cands[0].citedByIntents, ['methodology']);
        assert.ok(cands[0].foundVia.some(l => /^cite:arXiv:H1/.test(l)));
    });

    // ── #11 rankByPrior ─────────────────────────────────────────────────────────────
    console.log('\n── rankByPrior (#11 + #12) ──');
    await ok('orders by log(citations) + coupling; enriches scoreParts/prior', async () => {
        const pt = { getInspireReferences: async (id) => (id === 'coupled' ? [{ arxivEprint: 's1' }, { arxivEprint: 's2' }] : []) };
        const cands = [
            { arxivId: 'lowcite', citations: 1 },
            { arxivId: 'coupled', citations: 1 },                 // shares all seed refs
            { arxivId: 'highcite', citations: 500 },
        ];
        const ranked = await litGraph.rankByPrior(cands, { paperTools: pt, cache: makeCache(), seedRefIds: ['s1', 's2'], max: 10 });
        assert.ok(ranked[0].prior >= ranked[1].prior && ranked[1].prior >= ranked[2].prior, 'sorted desc by prior');
        const coupled = ranked.find(c => c.arxivId === 'coupled');
        assert.strictEqual(coupled.coupling, 1, 'full coupling computed');
        assert.ok(coupled.scoreParts && 'citations' in coupled.scoreParts, 'scoreParts recorded');
    });

    // ── integration through runResearch ──────────────────────────────────────────────
    console.log('\n── runResearch integration: backward (#4) + forward (#18) ──');
    const judgeAllRelevant = async (p) => {
        if (/SEARCH PLAN/.test(p)) return '{"keywords":"su(n) bethe method","categories":["hep-th"]}';
        if (/pick up to/i.test(p)) return '0,1,2';
        return '{"relevant":true,"reason":"ok","key_relations":[{"latex":"W~u^L"}],"observations":[]}';
    };
    const readFakes = {
        fetchPaperHtml: async () => ({ html: '<p>q-system wronskian rational bethe</p>', source: 'ar5iv', hasFullText: true }),
        extractSections: () => ({ headings: [], equations: ['W ~ u^L'], textSample: 'q-system wronskian' }),
    };

    await ok('#4 backward snowball surfaces a canonical paper cited by an initial hit', async () => {
        const model = { arxivId: '2401.1', title: 'Nested Bethe ansatz su(N)', abstract: 'su(n) nested heisenberg', citations: 5 };
        const pt = Object.assign({
            searchArxiv: async () => [model],
            searchInspire: async () => [],
            // model cites the canonical method paper (which has NO model keywords)
            getInspireReferences: async (id) => (id === '2401.1'
                ? [{ arxivEprint: '1608.06504', title: 'Fast analytic solver of rational Bethe equations', texkey: 'Marboe:2016' }]
                : []),
        }, readFakes);
        const b = await runResearch({ question: 'efficient higher-rank su(n) bethe method', paperTools: pt, llm: judgeAllRelevant });
        const ids = b.papers.map(p => p.arxivId);
        assert.ok(ids.includes('1608.06504'), `canonical not surfaced via references: ${JSON.stringify(ids)}`);
        const can = b.papers.find(p => p.arxivId === '1608.06504');
        assert.ok(can.foundVia.some(l => /^ref:/.test(l)), `provenance missing: ${JSON.stringify(can.foundVia)}`);
    });

    await ok('#18 forward snowball surfaces a refinement that CITES a confirmed hit', async () => {
        const seed = { arxivId: '2401.2', title: 'SU(3) Bethe method', abstract: 'su3 bethe', citations: 3 };
        const pt = Object.assign({
            searchArxiv: async () => [seed],
            searchInspire: async () => [],
            // no getInspireReferences → backward inert; forward active
            getCitationContexts: async (id) => (id === '2401.2'
                ? [{ arxivId: '2502.9', title: 'Refinement of SU(3) Bethe', intents: ['methodology'], contexts: ['we follow the method of'] }]
                : []),
        }, readFakes);
        const llm = async (p) => {
            if (/SEARCH PLAN/.test(p)) return '{"keywords":"su3 bethe","categories":["hep-th"]}';
            if (/pick up to/i.test(p)) return '0';
            return '{"relevant":true,"reason":"ok","key_relations":[],"observations":[]}';
        };
        const b = await runResearch({ question: 'su3 bethe method', paperTools: pt, llm });
        const ids = b.papers.map(p => p.arxivId);
        assert.ok(ids.includes('2401.2'), 'seed missing');
        assert.ok(ids.includes('2502.9'), `forward-cited refinement not added: ${JSON.stringify(ids)}`);
        const fwd = b.papers.find(p => p.arxivId === '2502.9');
        assert.strictEqual(fwd.viaForward, true, 'viaForward flag set');
        assert.ok(fwd.foundVia.some(l => /^cite:/.test(l)));
    });

    await ok('graph stays INERT when the tools are absent (no ref:/cite: provenance)', async () => {
        const pt = Object.assign({
            searchArxiv: async () => [{ arxivId: 'x1', title: 'su3 bethe ansatz', abstract: 'su3 bethe heisenberg' }],
            searchInspire: async () => [],
        }, readFakes);
        const b = await runResearch({ question: 'su3 bethe ansatz heisenberg', paperTools: pt });  // no llm, no graph tools
        assert.ok(b.papers.length >= 1);
        const provs = b.papers.flatMap(p => p.foundVia || []);
        assert.ok(!provs.some(l => /^ref:|^cite:/.test(l)), `graph ran without tools: ${JSON.stringify(provs)}`);
    });

    console.log(`\n── Phase 3 Results: ${pass} passed, ${fail} failed ──`);
    if (failures.length) { for (const { label, e } of failures) console.error(`  [FAIL] ${label}\n    ${e && e.stack || e}`); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
