'use strict';
/**
 * Round-8 tests (run Q_42CQ3G analysis — "searched 1, read 1, 0 relevant"):
 *  T — token cap: literature role fallback maxTokens raised 800 → 2000 (DeepSeek
 *      plan/reformulate JSON was truncating at exactly 800, silently degrading
 *      the plan to the keyword fallback AND killing the rescue round).
 *  X — deterministic arXiv-id extraction: a pasted URL / "arXiv:..." id in the
 *      question, the note, or the TASK text reaches the pipeline as a direct
 *      lookup, read first — even when the planner LLM fails entirely.
 *  N — thin-pool reformulation: a pool of 1–2 candidates reformulates like an
 *      empty one (merge, stop on first round that contributes).
 *  E — engine-error visibility: a throwing engine lands in queryLog[].err.
 *
 * Headless: no vscode, no network, no kernel.
 */

const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');

// ── vscode stub ────────────────────────────────────────────────────────────────
const Module = require('module');
const origResolve = Module._resolveFilename;
const vscodeStub = path.join(os.tmpdir(), 'run8-vscode-stub.js');
fs.writeFileSync(vscodeStub, 'module.exports = { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) }, window: {}, Uri: { file: (f) => ({ fsPath: f }) }, commands: { executeCommand: async () => {} } };');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return origResolve.call(this, request, ...rest);
};

const literature = require(path.join(__dirname, '..', 'fairy', 'literature.js'));
const tools      = require(path.join(__dirname, '..', 'fairy', 'tools.js'));
const roles      = require(path.join(__dirname, '..', 'config', 'roles.js'));
const { createWorkDir } = require(path.join(__dirname, '..', 'fairy', 'workDir.js'));

let passed = 0, failed = 0;
async function ok(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e && e.message}`); }
}
function tmpDir() {
    const d = path.join(os.tmpdir(), 'run8-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(d, { recursive: true });
    return d;
}

const GOOD_JUDGE = JSON.stringify({ relevance: 'direct', reason: 'the named paper',
    key_relations: [{ statement: 'fused R', latex: 'R^{(k)}=P_k R...' }], observations: [] });
const BAD_JUDGE = JSON.stringify({ relevance: 'none', reason: 'different physics', key_relations: [], observations: [] });
const FULLTEXT = { html: '<math alttext="x">x</math>' + 'x'.repeat(500), source: 'ar5iv', hasFullText: true };
const SECTIONS = { headings: ['H'], equations: ['R=1'], textSample: 'fusion projectors transfer matrices' };

// ── T: token cap ───────────────────────────────────────────────────────────────

async function runTokenCap() {
    console.log('\n── T: literature role token cap ──');
    await ok('literature fallback binding carries maxTokens 2000 (was 800)', async () => {
        const b = roles.resolveRole('literature');
        assert.strictEqual(b.maxTokens, 2000);
    });
    await ok('plan + reformulate prompts demand COMPACT JSON (anti-rambling)', async () => {
        assert.ok(/COMPACT JSON ONLY/.test(literature._internals._buildPlanPrompt('q')));
        assert.ok(/COMPACT JSON ONLY/.test(literature._internals._buildReformulatePrompt('q', { round: 2, tried: [] })));
    });
}

// ── X: deterministic arXiv-id extraction ──────────────────────────────────────

async function runIdExtraction() {
    console.log('\n── X: arXiv ids from question / note / task text ──');

    await ok('extractArxivIds handles URLs, arXiv: prefixes, bare and old-style ids', async () => {
        const ids = literature.extractArxivIds(
            'see https://arxiv.org/pdf/1908.10379 and arXiv:2101.11111v2, also hep-th/9604044 and bare 1010.4022.');
        assert.deepStrictEqual(ids, ['1908.10379', '2101.11111', '1010.4022', 'hep-th/9604044']);
        assert.deepStrictEqual(literature.extractArxivIds('no ids in here (eq 3.12)'), []);
    });

    await ok('id in the QUESTION is looked up directly even when the planner LLM fails', async () => {
        const named = { arxivId: '1908.10379', title: 'Fused transfer matrices for SU(N)', abstract: 'fusion', authors: ['A'], year: 2019 };
        const pt = {
            searchArxiv: async (params) => params.eprint === '1908.10379' ? [named] : [],
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        // llm returns garbage for EVERYTHING except the read judge — the planner,
        // preselect and reformulations all fail, exactly like run Q_42CQ3G.
        const llm = async (prompt) => /GRADE this paper/.test(prompt) ? GOOD_JUDGE : 'garbled nonsense';
        const brief = await literature.runResearch({
            question: 'Fusion as in https://arxiv.org/pdf/1908.10379 for SU(4) L=2', paperTools: pt, llm });
        assert.ok(brief.papers.some(p => p.arxivId === '1908.10379'), 'named paper delivered');
        assert.ok(brief.queries.some(qq => /^known:/.test(qq.label)), 'direct lookup logged');
    });

    await ok('id in ctx.taskText reaches the pipeline when the fairy question omits it', async () => {
        const named = { arxivId: '1908.10379', title: 'Fused transfer matrices', abstract: 'fusion', authors: ['A'], year: 2019 };
        const ctx = {
            workDir: await createWorkDir(tmpDir()),
            taskText: 'Find transfermatrices with fusion. See how it was done in https://arxiv.org/pdf/1908.10379',
            paperTools: {
                searchArxiv: async (params) => params.eprint === '1908.10379' ? [named] : [],
                fetchPaperHtml: async () => FULLTEXT,
                extractSections: () => SECTIONS,
            },
            literatureLlm: async (prompt) => {
                if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"fusion method transfer","categories":[]}';
                if (/Pick up to/.test(prompt)) return '0';
                return /GRADE this paper/.test(prompt) ? GOOD_JUDGE : 'none';
            },
        };
        const r = await tools.handleResearchLiterature(
            { question: 'Fusion method for SU(N) transfer matrices, explicit projector formulas' }, ctx);
        assert.strictEqual(r.ok, true);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(payload.papers.some(p => /1908\.10379/.test(p.ref || '')), 'task-text paper in the result');
    });

    await ok('note field ids are extracted too', async () => {
        const named = { arxivId: '2202.02222', title: 'Named in note', abstract: 'x', authors: [], year: 2022 };
        const ctx = {
            workDir: await createWorkDir(tmpDir()),
            paperTools: {
                searchArxiv: async (params) => params.eprint === '2202.02222' ? [named] : [],
                fetchPaperHtml: async () => FULLTEXT,
                extractSections: () => SECTIONS,
            },
            literatureLlm: async (prompt) => /GRADE this paper/.test(prompt) ? GOOD_JUDGE : 'unparseable',
        };
        const r = await tools.handleResearchLiterature(
            { question: 'A sufficiently long literature question', note: 'the user pointed at arXiv:2202.02222' }, ctx);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(payload.papers.some(p => /2202\.02222/.test(p.ref || '')), 'note-id paper delivered');
    });
}

// ── N: thin-pool reformulation ────────────────────────────────────────────────

async function runThinPool() {
    console.log('\n── N: thin pool (<3) reformulates; merge not replace ──');

    await ok('pool of 1 triggers reformulation; results MERGE with the original pool', async () => {
        const first = { arxivId: '1111.1', title: 'Lone first hit', abstract: 'fusion transfer', authors: [], year: 2020 };
        const second = { arxivId: '2222.2', title: 'Reformulated hit on fusion', abstract: 'fusion projectors', authors: [], year: 2021 };
        const pt = {
            searchArxiv: async (params) => /alias term/.test(params.query || '') ? [second] : [first],
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"queries":[{"type":"method","q":"first query"}],"keywords":"first query","categories":[]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) {
                assert.ok(/Lone first hit/.test(prompt), 'thin-pool feedback shows the pool titles');
                return '{"queries":[{"type":"alias","q":"alias term"}],"keywords":"alias term","categories":[]}';
            }
            if (/Pick up to/.test(prompt)) return '0,1';
            return GOOD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'fusion transfer matrices projector', paperTools: pt, llm });
        assert.strictEqual(brief.rounds, 2, 'one reformulation round');
        const ids = brief.papers.map(p => p.arxivId);
        assert.ok(ids.includes('1111.1') && ids.includes('2222.2'), 'both pools merged and read');
    });

    await ok('thin loop stops at the first round that contributes (no round burning)', async () => {
        let reformCalls = 0;
        const pt = {
            searchArxiv: async (params) => /alias term/.test(params.query || '')
                ? [{ arxivId: '2222.2', title: 'Hit', abstract: 'fusion', authors: [], year: 2021 }]
                : [{ arxivId: '1111.1', title: 'Lone', abstract: 'fusion', authors: [], year: 2020 }],
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"first query","categories":[]}';
            if (/LITERATURE RE-SEARCH/.test(prompt)) { reformCalls++; return '{"queries":[{"type":"alias","q":"alias term"}],"keywords":"alias","categories":[]}'; }
            if (/Pick up to/.test(prompt)) return '0,1';
            return GOOD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'fusion transfer', paperTools: pt, llm, budget: { rounds: 3 } });
        assert.strictEqual(reformCalls, 1, 'stopped after the contributing round');
        assert.strictEqual(brief.rounds, 2);
    });

    await ok('no-LLM thin pool does NOT loop (deterministic broadening reserved for empty)', async () => {
        let searches = 0;
        const pt = { searchArxiv: async () => { searches++; return [{ arxivId: '1111.1', title: 'Lone', abstract: 'a', authors: [], year: 2020 }]; } };
        const b = await literature.runResearch({ question: 'fusion transfer matrices', paperTools: pt });
        assert.strictEqual(b.rounds, 1, 'no reformulation without an LLM on a non-empty pool');
    });
}

// ── E: engine-error visibility ────────────────────────────────────────────────

async function runEngineErrors() {
    console.log('\n── E: engine failures land in the query log ──');
    await ok('throwing engine recorded as queryLog[].err', async () => {
        const queryLog = [];
        const pt = {
            searchArxiv: async () => { throw new Error('HTTP 429 rate limited'); },
            searchSemanticScholar: async () => [],
        };
        await literature._internals._search({ keywords: 'fusion', categories: [], queries: [] }, pt, 12, queryLog);
        assert.ok(queryLog.length >= 1);
        assert.ok((queryLog[0].err || []).some(e => /arxiv: .*429/.test(e)), `err captured: ${JSON.stringify(queryLog[0].err)}`);
    });
}

(async () => {
    console.log('run8Robustness.test.js — Round-8 (token cap, id extraction, thin pool, engine errors)');
    await runTokenCap();
    await runIdExtraction();
    await runThinPool();
    await runEngineErrors();
    console.log(`\n── Round-8: ${passed} passed, ${failed} failed ──`);
    process.exit(failed ? 1 : 0);
})();
