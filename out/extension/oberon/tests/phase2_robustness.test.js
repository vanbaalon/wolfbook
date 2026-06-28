'use strict';
/**
 * Phase 2 — robustness & observability.
 *   #5 fail-open judge: tolerant parse, retry once, then keep as 'uncertain' (never
 *      silently drop a possibly-relevant paper — the bug that lost 2 good papers).
 *   #6 reformulate-on-empty: one broadened search round when the first finds nothing.
 *   #10 persist queries/negatives: brief carries queries[], rounds, misses[], uncertain[].
 *
 * Pure + offline; paperTools/llm are fakes. Run: node phase2_robustness.test.js
 */

const assert = require('assert');
const literature = require('../fairy/literature');
const { _coerceRelevant, _parseJudge, _reformulate, _search } = literature._internals;
const { runResearch } = literature;

let pass = 0, fail = 0; const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); pass++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, e }); fail++; }
}

const Q = 'su3 bethe ansatz heisenberg chain energy';

// paperTools with a settable paper list + full-text fakes (so the read step runs).
function fakePt(papers) {
    return {
        searchArxiv: async () => papers,
        searchInspire: async () => [],
        fetchPaperHtml: async () => ({ html: '<p>su3 bethe heisenberg transfer</p>', source: 'ar5iv', hasFullText: true }),
        extractSections: () => ({ headings: ['H'], equations: ['E=1'], textSample: 'su3 bethe heisenberg' }),
    };
}
const onTopic = () => [
    { title: 'AAA SU(3) Bethe ansatz chain', abstract: 'su3 bethe heisenberg', arxivId: 'a1', year: 2024, authors: ['A'] },
    { title: 'BBB nested Bethe su3', abstract: 'su3 bethe nested', arxivId: 'b1', year: 2023, authors: ['B'] },
];

async function main() {
    // ── #5 tolerant parse ──────────────────────────────────────────────────────
    console.log('\n── Phase 2: tolerant judge parse (#5) ──');
    await ok('_coerceRelevant maps booleans + yes/no/uncertain strings', () => {
        assert.strictEqual(_coerceRelevant(true), true);
        assert.strictEqual(_coerceRelevant(false), false);
        assert.strictEqual(_coerceRelevant('yes'), true);
        assert.strictEqual(_coerceRelevant('No'), false);
        assert.strictEqual(_coerceRelevant('UNCERTAIN'), 'uncertain');
        assert.strictEqual(_coerceRelevant('banana'), undefined);
    });
    await ok('_parseJudge accepts string verdicts; null on prose or unreadable verdict', () => {
        assert.strictEqual(_parseJudge('{"relevant":"yes","reason":"r"}').relevant, true);
        assert.strictEqual(_parseJudge('{"relevant":"no"}').relevant, false);
        assert.strictEqual(_parseJudge('{"relevant":"uncertain"}').relevant, 'uncertain');
        assert.strictEqual(_parseJudge('I cannot tell'), null);
        assert.strictEqual(_parseJudge('{"reason":"x","relevant":"???"}'), null);
    });

    // ── #5 fail-open: retry + uncertain ─────────────────────────────────────────
    console.log('\n── fail-open judge: retry then uncertain (#5) ──');
    await ok('retry RECOVERS a paper when the second judge reply parses', async () => {
        let calls = 0;
        const llm = async (p) => {
            if (/SEARCH PLAN/.test(p)) return '{"keywords":"su3 bethe","categories":["hep-th"]}';
            if (/pick up to/i.test(p)) return '0';
            calls++;
            return calls === 1 ? 'no json at all' : '{"relevant":true,"reason":"ok","key_relations":[{"latex":"E=1"}],"observations":[]}';
        };
        const b = await runResearch({ question: Q, paperTools: fakePt(onTopic()), llm });
        assert.strictEqual(calls, 2, 'judge retried exactly once');
        assert.strictEqual(b.papers.length, 1, 'paper recovered on retry → relevant');
        assert.strictEqual((b.uncertain || []).length, 0);
    });
    await ok('unparseable twice → kept as UNCERTAIN, not relevant, not dropped', async () => {
        const llm = async (p) => {
            if (/SEARCH PLAN/.test(p)) return '{"keywords":"su3 bethe","categories":["hep-th"]}';
            if (/pick up to/i.test(p)) return '0';
            return 'hard to say, maybe';   // unparseable on read AND retry
        };
        const b = await runResearch({ question: Q, paperTools: fakePt(onTopic()), llm });
        assert.deepStrictEqual(b.papers, [], 'not promoted to relevant');
        assert.strictEqual((b.uncertain || []).length, 1, 'kept as uncertain');
        assert.ok(/unparseable/i.test(b.uncertain[0].reason), 'reason explains why');
        assert.ok(b.diagnostics.uncertain === 1, 'diagnostics counts uncertain');
    });
    await ok('relevant + uncertain coexist in one run', async () => {
        const llm = async (p) => {
            if (/SEARCH PLAN/.test(p)) return '{"keywords":"su3 bethe","categories":["hep-th"]}';
            if (/pick up to/i.test(p)) return '0,1';
            const head = p.split('Body excerpt')[0] || p;
            if (/PAPER:.*AAA/.test(head)) return '{"relevant":true,"reason":"ok","key_relations":[],"observations":[]}';
            return 'garbage';   // BBB → uncertain
        };
        const b = await runResearch({ question: Q, paperTools: fakePt(onTopic()), llm });
        assert.strictEqual(b.papers.length, 1, 'AAA judged relevant');
        assert.strictEqual(b.papers[0].arxivId, 'a1');
        assert.strictEqual((b.uncertain || []).length, 1, 'BBB kept uncertain');
        assert.strictEqual(b.uncertain[0].arxivId, 'b1');
    });

    // ── #6 reformulate-on-empty ─────────────────────────────────────────────────
    console.log('\n── reformulate on empty search (#6) ──');
    await ok('_reformulate drops categories, shortens keywords, keeps method/author; null when empty', () => {
        const r = _reformulate({ keywords: 'a b c d e f', categories: ['hep-th'], queries: [
            { type: 'method', q: 'Q-system' }, { type: 'model', q: 'nested' }, { type: 'author', author: 'Volin' },
        ] });
        assert.deepStrictEqual(r.categories, [], 'categories dropped (broaden)');
        assert.strictEqual(r.keywords.split(' ').length, 4, 'keywords capped to 4');
        assert.ok(r.queries.every(x => x.type === 'method' || x.author), 'only method/author kept');
        assert.strictEqual(r.queries.length, 2);
        assert.strictEqual(_reformulate({ keywords: '', categories: [], queries: [] }), null);
    });
    await ok('round-1 empty → broadened round-2 finds papers (rounds=2)', async () => {
        // searchArxiv returns nothing while a category filter is present; the reformulated
        // round drops categories → finds the paper.
        const pt = {
            searchArxiv: async (params) => ((params.categories && params.categories.length) ? [] : onTopic().slice(0, 1)),
            searchInspire: async () => [],
            fetchPaperHtml: async () => ({ html: '<p>su3 bethe</p>', source: 'ar5iv', hasFullText: true }),
            extractSections: () => ({ headings: [], equations: ['E=1'], textSample: 'su3 bethe heisenberg' }),
        };
        const b = await runResearch({ question: Q, paperTools: pt });   // no llm → token judge keeps on-topic
        assert.strictEqual(b.rounds, 2, 'second (broadened) round ran');
        assert.ok(b.papers.length >= 1, 'paper found only after reformulation');
    });
    await ok('both rounds empty → honest "no papers found" with provenance', async () => {
        const pt = { searchArxiv: async () => [], searchInspire: async () => [] };
        const b = await runResearch({ question: Q, paperTools: pt });
        assert.deepStrictEqual(b.papers, []);
        assert.strictEqual(b.rounds, 2, 'reformulation was attempted');
        assert.ok(/no papers found/i.test(b.note));
        assert.ok(Array.isArray(b.queries) && Array.isArray(b.misses), 'queries + misses recorded');
    });

    // ── #10 query log / misses ──────────────────────────────────────────────────
    console.log('\n── query log & misses (#10) ──');
    await ok('_search records per-query added counts into queryLog', async () => {
        const pt = {
            searchArxiv: async (params) => {
                const s = `${params.query || ''}`;
                if (/Q-system/.test(s)) return [];                                  // method → empty (a miss)
                if (/nested/.test(s)) return [{ arxivId: 'm1', title: 'model', citations: 2 }];
                return [{ arxivId: 'k1', title: 'kw', citations: 1 }];               // keywords
            },
            searchInspire: async () => [],
        };
        const plan = { keywords: 'kw', categories: ['hep-th'], queries: [{ type: 'method', q: 'Q-system' }, { type: 'model', q: 'nested' }] };
        const log = [];
        const found = await _search(plan, pt, 12, log);
        assert.strictEqual(log.length, 3, 'method + model + keywords logged');
        assert.strictEqual(log.find(l => /^method:/.test(l.label)).added, 0, 'method query was a miss');
        assert.ok(log.find(l => /^model:/.test(l.label)).added >= 1, 'model query contributed');
        assert.ok(found.some(p => p.arxivId === 'm1'));
    });
    await ok('runResearch brief surfaces queries[], rounds and misses[] (#10)', async () => {
        const llm = async (p) => {
            if (/SEARCH PLAN/.test(p)) return '{"queries":[{"type":"method","q":"Q-system"},{"type":"model","q":"nested"}],"keywords":"kw","categories":["hep-th"]}';
            if (/pick up to/i.test(p)) return '0';
            return '{"relevant":true,"reason":"ok","key_relations":[],"observations":[]}';
        };
        const pt = {
            searchArxiv: async (params) => (/Q-system/.test(params.query || '') ? [] : [{ title: 'nested su3 bethe', abstract: 'x', arxivId: 'n1', year: 2024 }]),
            searchInspire: async () => [],
            fetchPaperHtml: async () => ({ html: '<p>x</p>', source: 'ar5iv', hasFullText: true }),
            extractSections: () => ({ headings: [], equations: [], textSample: 'su3 bethe' }),
        };
        const b = await runResearch({ question: Q, paperTools: pt, llm });
        assert.ok(Array.isArray(b.queries) && b.queries.length >= 3, 'query log present');
        assert.ok(b.queries.every(x => 'label' in x && 'added' in x), 'query log entries shaped');
        assert.ok(b.misses.some(m => /^method:Q-system/.test(m)), `empty method query logged as a miss: ${JSON.stringify(b.misses)}`);
        assert.strictEqual(b.rounds, 1, 'one round sufficed (papers found)');
    });

    console.log(`\n── Phase 2 Results: ${pass} passed, ${fail} failed ──`);
    if (failures.length) { for (const { label, e } of failures) console.error(`  [FAIL] ${label}\n    ${e && e.stack || e}`); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
