'use strict';
/**
 * Phase 4 — citation-intelligence ranking.
 *   #13 methodIntentFraction   — methodology-citation fraction
 *   #14 canonicalFromContexts  — cited *for* the task's named method
 *   #15 isReview               — review / lecture-note hubs
 *   #16 velocity               — recency-adjusted impact
 *   #17 authorAuthority/topAuthors — topic-local author recurrence
 *   #19 scoreCandidate/rankCandidates — transparent blended score
 *   integration: runResearch ranks the brief by blended score and exposes topAuthors;
 *     a high-citation method paper outranks a low-impact same-topic paper.
 *
 * Pure + offline; paperTools/llm are fakes. Run: node phase4_ranking.test.js
 */

const assert = require('assert');
const R = require('../fairy/litRanking');
const literature = require('../fairy/literature');
const { runResearch } = literature;

let pass = 0, fail = 0; const failures = [];
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); pass++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failures.push({ label, e }); fail++; }
}

async function main() {
    // ── pure signals ─────────────────────────────────────────────────────────────
    console.log('\n── Phase 4: pure ranking signals ──');
    await ok('#13 methodIntentFraction', () => {
        assert.strictEqual(R.methodIntentFraction(['methodology', 'background', 'methodology', 'result']), 0.5);
        assert.strictEqual(R.methodIntentFraction([]), 0);
        assert.strictEqual(R.methodIntentFraction(['background']), 0);
    });
    await ok('#14 canonicalFromContexts: fraction of citing sentences naming a method', () => {
        const ctx = ['we use the Q-system of [12]', 'as background see [12]', 'following the Q-system approach'];
        assert.strictEqual(R.canonicalFromContexts(ctx, ['q-system', 'wronskian']), 2 / 3);
        assert.strictEqual(R.canonicalFromContexts([], ['q-system']), 0);
        assert.strictEqual(R.canonicalFromContexts(ctx, []), 0);
    });
    await ok('#14 namedMethodsFromQuestion drops stopwords, keeps tech terms', () => {
        const m = R.namedMethodsFromQuestion('efficient Q-system method for the SU(N) Bethe ansatz representation');
        assert.ok(m.includes('q-system') && m.includes('bethe') && m.includes('ansatz'));
        assert.ok(!m.includes('method') && !m.includes('representation'), 'stopwords removed');
    });
    await ok('#15 isReview detects reviews / lecture notes / large bibliographies', () => {
        assert.ok(R.isReview({ title: 'A Review of Integrable Spin Chains' }));
        assert.ok(R.isReview({ title: 'Lecture notes on the Bethe ansatz' }));
        assert.ok(R.isReview({ title: 'Introduction to QSC' }));
        assert.ok(R.isReview({ title: 'Some paper', refCount: 120 }));
        assert.ok(!R.isReview({ title: 'A fast solver for Bethe equations', refCount: 30 }));
    });
    await ok('#16 velocity = citations / age (recency-adjusted)', () => {
        assert.strictEqual(R.velocity({ citations: 100, year: 2020 }, 2025), 100 / 6);
        assert.strictEqual(R.velocity({ citations: 100 }, 2025), 0, 'no year → 0');
        assert.ok(R.velocity({ citations: 10, year: 2024 }, 2025) > R.velocity({ citations: 10, year: 2000 }, 2025), 'newer wins for equal cites');
    });
    await ok('#17 authorAuthority + topAuthors reward recurrence', () => {
        const cands = [
            { authors: ['Volin', 'Marboe'] }, { authors: ['Volin', 'Kazakov'] },
            { authors: ['Volin'] }, { authors: ['Nobody'] },
        ];
        const a = R.authorAuthority(cands);
        assert.ok(a.scoreFor({ authors: ['Volin'] }) > a.scoreFor({ authors: ['Nobody'] }), 'recurring author scores higher');
        const top = R.topAuthors(cands, 5);
        assert.strictEqual(top[0].name, 'volin');
        assert.ok(top[0].count === 3);
    });

    // ── #19 blended score ────────────────────────────────────────────────────────
    console.log('\n── #19 blended score ──');
    await ok('scoreCandidate returns score + per-part breakdown', () => {
        const { score, scoreParts } = R.scoreCandidate(
            { citations: 100, year: 2018, coupling: 0.5, title: 'x' },
            { textRel: () => 0.8, nowYear: 2025 });
        assert.ok(score > 0);
        for (const k of ['textRel', 'citations', 'velocity', 'coupling', 'authority', 'methodIntent', 'canonical', 'review'])
            assert.ok(k in scoreParts, `scoreParts.${k} missing`);
        assert.ok(Math.abs(scoreParts.textRel - 0.8) < 1e-9);
    });
    await ok('rankCandidates: high-citation/coupling method paper outranks a bare same-topic paper', () => {
        const cands = [
            { arxivId: 'weak', citations: 1, year: 2024, coupling: 0 },
            { arxivId: 'canonical', citations: 400, year: 2016, coupling: 0.8 },
        ];
        const ranked = R.rankCandidates(cands, { textRel: () => 0.5, nowYear: 2025 });
        assert.strictEqual(ranked[0].arxivId, 'canonical');
        assert.ok(ranked[0].score >= ranked[1].score);
        assert.ok(ranked[0].scoreParts && typeof ranked[0].score === 'number');
    });
    await ok('rankCandidates is stable on ties (input order preserved)', () => {
        const cands = [{ arxivId: 'a' }, { arxivId: 'b' }, { arxivId: 'c' }];
        const ranked = R.rankCandidates(cands, { textRel: () => 0 });   // all equal
        assert.deepStrictEqual(ranked.map(c => c.arxivId), ['a', 'b', 'c']);
    });

    // ── integration through runResearch ──────────────────────────────────────────
    console.log('\n── runResearch integration: brief ranked by score (#19) + topAuthors (#17) ──');
    await ok('brief papers carry score/scoreParts and are sorted best-first; topAuthors exposed', async () => {
        const weak = { arxivId: 'w1', title: 'SU(3) Bethe minor note', abstract: 'su3 bethe heisenberg', citations: 2, year: 2024, authors: ['Nobody'] };
        const strong = { arxivId: 's1', title: 'SU(3) Bethe ansatz solver', abstract: 'su3 bethe heisenberg method', citations: 350, year: 2017, authors: ['Volin', 'Marboe'] };
        const also = { arxivId: 'a1', title: 'SU(3) Bethe chains again', abstract: 'su3 bethe heisenberg', citations: 40, year: 2020, authors: ['Volin'] };
        const pt = {
            searchArxiv: async () => [weak, strong, also],
            searchInspire: async () => [],
            fetchPaperHtml: async () => ({ html: '<p>su3 bethe heisenberg method</p>', source: 'ar5iv', hasFullText: true }),
            extractSections: () => ({ headings: [], equations: ['E=1'], textSample: 'su3 bethe' }),
        };
        const llm = async (p) => {
            if (/SEARCH PLAN/.test(p)) return '{"keywords":"su3 bethe heisenberg","categories":["hep-th"]}';
            if (/pick up to/i.test(p)) return '0,1,2';
            return '{"relevant":true,"reason":"ok","key_relations":[],"observations":[]}';
        };
        const b = await runResearch({ question: 'su3 bethe ansatz heisenberg method', paperTools: pt, llm });
        assert.strictEqual(b.papers.length, 3);
        assert.strictEqual(b.papers[0].arxivId, 's1', `expected high-impact first, got ${b.papers.map(p => p.arxivId)}`);
        assert.ok(b.papers[0].score >= b.papers[1].score && b.papers[1].score >= b.papers[2].score, 'sorted desc by score');
        assert.ok(b.papers[0].scoreParts && 'citations' in b.papers[0].scoreParts, 'scoreParts surfaced (#19)');
        assert.ok(Array.isArray(b.topAuthors) && b.topAuthors[0] && b.topAuthors[0].name === 'volin', 'topAuthors exposed (#17)');
    });
    await ok('ranking is inert-safe: works with no graph signals (text-relevance fallback)', async () => {
        const pt = {
            searchArxiv: async () => [{ arxivId: 'x', title: 'su3 bethe', abstract: 'su3 bethe heisenberg' }],
            searchInspire: async () => [],
            fetchPaperHtml: async () => ({ html: '<p>su3 bethe</p>', source: 'ar5iv', hasFullText: true }),
            extractSections: () => ({ headings: [], equations: [], textSample: 'su3 bethe' }),
        };
        const b = await runResearch({ question: 'su3 bethe heisenberg', paperTools: pt });   // no llm, no graph
        assert.ok(b.papers.length >= 1);
        assert.ok('score' in b.papers[0], 'score present even without citation signals');
    });

    console.log(`\n── Phase 4 Results: ${pass} passed, ${fail} failed ──`);
    if (failures.length) { for (const { label, e } of failures) console.error(`  [FAIL] ${label}\n    ${e && e.stack || e}`); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
