'use strict';
/**
 * Round-6 literature-pipeline tests (user feedback after run Q_3VRPXL follow-up):
 *  R6.1 — Semantic Scholar joins arXiv/INSPIRE as a search engine (per query).
 *  R6.2 — a prose query is appended when the S2 engine is available.
 *  R6.3 — empty search → LLM reformulation WITH feedback (not just deterministic
 *          keyword truncation); up to budget.rounds rounds; queries never refired.
 *  R6.4 — RESCUE round: all read papers rejected → reformulate with the rejection
 *          feedback, read up to 2 truly-NEW candidates only.
 *  R6.5 — bounded give-up: still-empty briefs carry rounds + tried queries.
 *  R6.6 — tool payload for 0-relevant briefs exposes searchRounds + triedQueries.
 *
 * Headless: no vscode, no network, no kernel.
 */

const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');

// ── vscode stub (same pattern as the other suites) ────────────────────────────
const Module = require('module');
const origResolve = Module._resolveFilename;
const vscodeStub = path.join(os.tmpdir(), 'run6-vscode-stub.js');
fs.writeFileSync(vscodeStub, 'module.exports = { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) }, window: {}, Uri: { file: (f) => ({ fsPath: f }) }, commands: { executeCommand: async () => {} } };');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return origResolve.call(this, request, ...rest);
};

const literature = require(path.join(__dirname, '..', 'fairy', 'literature.js'));
const tools      = require(path.join(__dirname, '..', 'fairy', 'tools.js'));
const { createWorkDir } = require(path.join(__dirname, '..', 'fairy', 'workDir.js'));

let passed = 0, failed = 0;
async function ok(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e && e.message}`); }
}
function tmpDir() {
    const d = path.join(os.tmpdir(), 'run6-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(d, { recursive: true });
    return d;
}

const GOOD_JUDGE = JSON.stringify({ relevance: 'method', reason: 'general fusion relations apply',
    key_relations: [{ statement: 'fusion', latex: 'T_aT_a=T_{a+1}T_{a-1}+1' }], observations: [] });
const BAD_JUDGE = JSON.stringify({ relevance: 'none', reason: 'different physics entirely',
    key_relations: [], observations: [] });

const FULLTEXT = { html: '<math alttext="x">x</math>' + 'x'.repeat(500), source: 'ar5iv', hasFullText: true };
const SECTIONS = { headings: ['H'], equations: ['T=1'], textSample: 'fusion hierarchy transfer matrix' };

// ── R6.1/R6.2: Semantic Scholar engine + prose query ──────────────────────────

async function runS2Engine() {
    console.log('\n── R6.1/R6.2: Semantic Scholar search engine ──');

    await ok('S2 results are merged into the candidate pool', async () => {
        const s2Paper = { arxivId: '2101.11111', title: 'Hirota dynamics for quantum integrability', abstract: 'fusion hirota', authors: ['K'], year: 2021, citations: 300 };
        const pt = {
            searchArxiv: async () => [],
            searchSemanticScholar: async () => [s2Paper],
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"fusion hirota","categories":["hep-th"]}';
            if (/Pick up to/.test(prompt)) return '0';
            return GOOD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'T-system fusion for SU(4) spin chain', paperTools: pt, llm });
        assert.ok(brief.papers.length >= 1, 'S2-found paper returned');
        assert.strictEqual(brief.papers[0].arxivId, '2101.11111');
    });

    await ok('prose query appended only when the S2 engine exists', async () => {
        const seenQueries = [];
        const pt = {
            searchArxiv: async () => [],
            searchSemanticScholar: async (params) => { seenQueries.push(params.query || ''); return []; },
        };
        const b = await literature.runResearch({ question: 'anomalous dimensions of twist-2 operators', paperTools: pt, budget: { rounds: 1 } });
        assert.ok(seenQueries.some(qq => /anomalous dimensions of twist-2 operators/.test(qq)), 'raw question fired as a prose query');
        assert.deepStrictEqual(b.papers, []);
    });

    await ok('no S2 engine → no prose query, old query set unchanged', async () => {
        const labels = [];
        const pt = { searchArxiv: async (params) => { labels.push(params.query || params.author || ''); return []; } };
        await literature.runResearch({ question: 'anomalous dimensions of twist-2 operators', paperTools: pt, budget: { rounds: 1 } });
        assert.ok(!labels.some(l => /anomalous dimensions of twist-2 operators/.test(l)), 'no raw-prose query without S2');
    });
}

// ── R6.3: LLM reformulation rounds on empty search ─────────────────────────────

async function runReformulation() {
    console.log('\n── R6.3: LLM reformulation with feedback ──');

    await ok('empty round 1 → reformulated round 2 finds the paper (rounds=2)', async () => {
        let reformulatePrompt = '';
        const pt = {
            // Only the reformulated alias query hits.
            searchArxiv: async (params) => /hirota/i.test(params.query || '')
                ? [{ arxivId: '2202.2', title: 'Hirota equation and quantum spin chains', abstract: 'hirota bilinear', authors: ['V'], year: 2022 }]
                : [],
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"queries":[{"type":"method","q":"wrong terminology entirely"}],"keywords":"wrong terminology","categories":["hep-th"]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) { reformulatePrompt = prompt; return '{"queries":[{"type":"alias","q":"hirota equation"}],"keywords":"hirota","categories":[]}'; }
            if (/Pick up to/.test(prompt)) return '0';
            return GOOD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'T-system for SU(4) XXX chain', paperTools: pt, llm });
        assert.ok(brief.papers.length >= 1, 'reformulated query found the paper');
        assert.strictEqual(brief.rounds, 2);
        assert.ok(/wrong terminology/.test(reformulatePrompt), 'feedback lists the tried queries');
        assert.ok(/NOTHING at all/.test(reformulatePrompt), 'feedback says the search came back empty');
        assert.ok(!/SEARCH PLAN/.test(reformulatePrompt), 'reformulate prompt is distinct from the plan prompt');
    });

    await ok('reformulation rounds are bounded by budget.rounds', async () => {
        let searchCalls = 0, reformCalls = 0;
        const pt = { searchArxiv: async () => { searchCalls++; return []; } };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"queries":[{"type":"method","q":"q one"}],"keywords":"q one","categories":[]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) { reformCalls++; return `{"queries":[{"type":"alias","q":"variant ${reformCalls}"}],"keywords":"variant","categories":[]}`; }
            return BAD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'completely unfindable topic', paperTools: pt, llm, budget: { rounds: 3 } });
        assert.deepStrictEqual(brief.papers, []);
        assert.strictEqual(brief.rounds, 3, 'stopped at the round cap');
        assert.strictEqual(reformCalls, 2, 'two reformulations for three rounds');
        assert.ok(/after 3 search round/.test(brief.note), 'note reports the rounds tried');
    });

    await ok('queries from earlier rounds are never refired', async () => {
        const fired = [];
        const pt = { searchArxiv: async (params) => { fired.push(params.query || ''); return []; } };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"queries":[{"type":"method","q":"same query"}],"keywords":"same query","categories":[]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) return '{"queries":[{"type":"method","q":"same query"}],"keywords":"same query","categories":[]}';
            return BAD_JUDGE;
        };
        await literature.runResearch({ question: 'topic', paperTools: pt, llm, budget: { rounds: 3 } });
        const sameQ = fired.filter(f => f === 'same query');
        assert.strictEqual(sameQ.length, 1, `"same query" fired once, got ${sameQ.length}`);
    });

    await ok('no-LLM fallback still gets the single deterministic broadening', async () => {
        let calls = 0;
        const pt = { searchArxiv: async () => { calls++; return []; } };
        const b = await literature.runResearch({ question: 'nested bethe ansatz su4 chain energies', paperTools: pt });
        assert.deepStrictEqual(b.papers, []);
        assert.ok(b.rounds >= 2, 'deterministic reformulation round ran');
    });
}

// ── R6.4: rescue round after all-rejected read ─────────────────────────────────

async function runRescue() {
    console.log('\n── R6.4: rescue round with rejection feedback ──');

    await ok('all read papers rejected → rescue round reads a NEW paper and succeeds', async () => {
        let rescuePrompt = '';
        // Pool of 3 (R8: pools <3 trigger the pre-read thin-pool reformulation
        // instead — the rescue path needs a full pool that all fails the judge).
        const offTopics = [
            { arxivId: '1901.1', title: 'Neutron star cooling in chiral models', abstract: 'astrophysics dense matter', authors: ['N'], year: 2019 },
            { arxivId: '1902.2', title: 'Dense matter equations of state', abstract: 'astro dense matter', authors: ['M'], year: 2019 },
            { arxivId: '1903.3', title: 'Compact star oscillation modes', abstract: 'astro oscillations', authors: ['O'], year: 2019 },
        ];
        const onTopic = { arxivId: '2303.3', title: 'Fusion hierarchies for rational spin chains', abstract: 'transfer matrix fusion', authors: ['F'], year: 2023 };
        const pt = {
            searchArxiv: async (params) => /fusion hierarchy/i.test(params.query || '') ? [onTopic] : offTopics,
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"queries":[{"type":"model","q":"badly aimed query"}],"keywords":"badly aimed","categories":["hep-th"]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) { rescuePrompt = prompt; return '{"queries":[{"type":"method","q":"fusion hierarchy"}],"keywords":"fusion","categories":[]}'; }
            if (/Pick up to/.test(prompt)) return '0,1,2';
            // Judge by paper identity in the prompt head.
            const head = prompt.split('Body excerpt')[0] || prompt;
            return /neutron star|dense matter|compact star/i.test(head) ? BAD_JUDGE : GOOD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'T-system for SU(4) spin chain', paperTools: pt, llm });
        assert.ok(brief.papers.length >= 1, 'rescue produced a relevant paper');
        assert.strictEqual(brief.papers[0].arxivId, '2303.3');
        assert.ok(brief.considered.some(c => c.rescue === true), 'rescue read recorded in considered[]');
        assert.ok(/REJECTED, with the judge/.test(rescuePrompt), 'rescue prompt carries rejection feedback');
        assert.ok(/Neutron star cooling/.test(rescuePrompt), 'rejected title shown to the reformulator');
        assert.strictEqual(brief.diagnostics.rescued, 1);
    });

    await ok('rescue is a NO-OP when the re-search returns only already-known papers', async () => {
        let reads = 0;
        const offTopic = { arxivId: '1901.1', title: 'Neutron star cooling', abstract: 'astro', authors: ['N'], year: 2019 };
        const pt = {
            searchArxiv: async () => [offTopic],   // same paper every round
            fetchPaperHtml: async () => { reads++; return FULLTEXT; },
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"queries":[{"type":"model","q":"query a"}],"keywords":"query a","categories":[]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) return '{"queries":[{"type":"alias","q":"query b"}],"keywords":"query b","categories":[]}';
            if (/Pick up to/.test(prompt)) return '0';
            return BAD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'spin chain question', paperTools: pt, llm });
        assert.deepStrictEqual(brief.papers, []);
        assert.strictEqual(reads, 1, `no extra read for a same-pool rescue (got ${reads})`);
        assert.ok(/no relevant/i.test(brief.note));
    });

    await ok('unparseable reformulation reply → rescue silently skipped', async () => {
        const offTopic = { arxivId: '1901.1', title: 'Neutron star cooling', abstract: 'astro', authors: ['N'], year: 2019 };
        let searches = 0;
        const pt = {
            searchArxiv: async () => { searches++; return [offTopic]; },
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"query a","categories":[]}';
            if (/Pick up to/.test(prompt)) return '0';
            return BAD_JUDGE;   // also lands on the RE-SEARCH prompt → unparseable as a plan
        };
        const brief = await literature.runResearch({ question: 'spin chain question', paperTools: pt, llm });
        assert.deepStrictEqual(brief.papers, []);
        assert.strictEqual(searches, 1, 'no second search without a parseable reformulation');
        assert.strictEqual(brief.rounds, 1);
    });

    await ok('no rescue when a paper was already judged relevant', async () => {
        let reformCalls = 0;
        // Pool of 3 so the R8 thin-pool loop stays quiet — this test isolates the
        // rescue path: a successful read must never trigger a reformulation.
        const pool = [
            { arxivId: '2303.3', title: 'Fusion hierarchies', abstract: 'fusion', authors: ['F'], year: 2023 },
            { arxivId: '2303.4', title: 'Transfer matrix relations', abstract: 'fusion transfer', authors: ['G'], year: 2023 },
            { arxivId: '2303.5', title: 'T-systems for spin chains', abstract: 'fusion t-system', authors: ['H'], year: 2023 },
        ];
        const pt = { searchArxiv: async () => pool, fetchPaperHtml: async () => FULLTEXT, extractSections: () => SECTIONS };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"fusion","categories":[]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) { reformCalls++; return 'none'; }
            if (/Pick up to/.test(prompt)) return '0';
            return GOOD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'fusion for spin chains', paperTools: pt, llm });
        assert.ok(brief.papers.length >= 1);
        assert.strictEqual(reformCalls, 0, 'no reformulation on a successful run');
        assert.strictEqual(brief.rounds, 1);
    });
}

// ── R6.5/R6.6: prompts + tool payload ─────────────────────────────────────────

async function runPromptsAndPayload() {
    console.log('\n── R6.5/R6.6: prompt content + tool payload ──');

    await ok('plan prompt asks for short queries, alias and review angles, names all engines', async () => {
        const p = literature._internals._buildPlanPrompt('question');
        assert.ok(/2 to 5 words/.test(p), 'short-query instruction');
        assert.ok(/alias/.test(p), 'alias angle');
        assert.ok(/review/.test(p), 'review angle');
        assert.ok(/Semantic Scholar/.test(p) && /INSPIRE/.test(p) && /arXiv/.test(p), 'engines named');
        assert.ok(/SEARCH PLAN/.test(p), 'marker retained for dispatch');
    });

    await ok('reformulate prompt structure: tried queries, sample titles, rejected reasons', async () => {
        const p = literature._internals._buildReformulatePrompt('q', {
            round: 2,
            tried: ['method:foo (found 0)'],
            sampleTitles: ['Some Paper'],
            rejected: [{ title: 'Some Paper', reason: 'wrong physics' }],
        });
        assert.ok(/round 2/.test(p));
        assert.ok(/method:foo/.test(p));
        assert.ok(/Some Paper/.test(p));
        assert.ok(/wrong physics/.test(p));
        assert.ok(/do NOT repeat/i.test(p));
        assert.ok(!/SEARCH PLAN/.test(p));
    });

    await ok('handleResearchLiterature: 0-relevant payload carries searchRounds + triedQueries', async () => {
        const workDir = await createWorkDir(tmpDir());
        const offTopic = { arxivId: '1901.1', title: 'Neutron star cooling', abstract: 'astro', authors: ['N'], year: 2019 };
        const ctx = {
            workDir,
            paperTools: { searchArxiv: async () => [offTopic], fetchPaperHtml: async () => FULLTEXT, extractSections: () => SECTIONS },
            literatureLlm: async (prompt) => {
                if (/SEARCH PLAN/.test(prompt)) return '{"queries":[{"type":"model","q":"star query"}],"keywords":"star query","categories":[]}';
                if (/Pick up to/.test(prompt)) return '0';
                return BAD_JUDGE;
            },
        };
        const r = await tools.handleResearchLiterature({ question: 'a long enough literature question' }, ctx);
        assert.strictEqual(r.ok, true);
        const payload = JSON.parse(r.modelPayload);
        assert.deepStrictEqual(payload.papers, []);
        assert.ok(payload.searchRounds >= 1, 'searchRounds present');
        assert.ok(Array.isArray(payload.triedQueries) && payload.triedQueries.length >= 1, 'triedQueries present');
        assert.ok(/triedQueries/.test(payload.reminder), 'reminder points at triedQueries');
    });
}

(async () => {
    console.log('run6Literature.test.js — Round-6 literature pipeline (S2 engine, reformulation, rescue)');
    await runS2Engine();
    await runReformulation();
    await runRescue();
    await runPromptsAndPayload();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
