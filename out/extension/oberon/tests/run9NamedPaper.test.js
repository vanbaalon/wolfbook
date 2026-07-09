'use strict';
/**
 * Round-9 tests (run Q_4PWRMS — "reproduce the L operators from <arXiv URL>" went
 * to DIFFERENT papers):
 *  S — synthetic grounding: a task-named id enters the pool even when EVERY
 *      search-API lookup fails (throttled arXiv) — the read step fetches the
 *      full text by id (ar5iv), independent of any search engine.
 *  G — named-source judging: the read prompt tells the judge THIS paper was
 *      named in the task (grade direct; don't reject it for differing from the
 *      model's hallucinated expectation of its content).
 *  M — metadata enrichment: a synthetic stub gains title/abstract when the same
 *      id later arrives from a search engine.
 *  B — missing-named backstop: if a named id is absent from the delivered
 *      papers, the tool reply orders an immediate lit_read of it.
 *  C — circuit breaker: an engine failing twice in a round is not called again
 *      that round (arXiv throttle = 15s timeout per dead call).
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
const vscodeStub = path.join(os.tmpdir(), 'run9-vscode-stub.js');
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
    const d = path.join(os.tmpdir(), 'run9-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(d, { recursive: true });
    return d;
}

const DIRECT_JUDGE = JSON.stringify({ relevance: 'direct', reason: 'the named source',
    key_relations: [{ statement: 'graph-building operator', latex: 'B(u)=...' }], observations: [] });
const BAD_JUDGE = JSON.stringify({ relevance: 'none', reason: 'different physics', key_relations: [], observations: [] });
const FULLTEXT = { html: '<math alttext="x">x</math>' + 'x'.repeat(500), source: 'ar5iv', hasFullText: true };
const SECTIONS = { headings: ['Fishnet'], equations: ['B=1'], textSample: 'holographic dual fishchain graph building' };

// ── S/G: synthetic grounding of a task-named id ────────────────────────────────

async function runSyntheticGrounding() {
    console.log('\n── S/G: named id survives total search-API failure ──');

    await ok('id lookup fails (throttled) → synthetic stub still enters the pool and is READ', async () => {
        let judgePrompt = '';
        const fetched = [];
        const pt = {
            searchArxiv: async () => { throw new Error('Timeout'); },   // arXiv fully dead
            fetchPaperHtml: async (id) => { fetched.push(id); return FULLTEXT; },
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/GRADE this paper/.test(prompt)) { judgePrompt = prompt; return DIRECT_JUDGE; }
            return 'unparseable garbage';   // planner, preselect, reformulate all fail
        };
        const brief = await literature.runResearch({
            question: 'reproduce the fusion L operators from https://arxiv.org/pdf/1908.10379',
            paperTools: pt, llm });
        assert.ok(fetched.includes('1908.10379'), 'named paper full text fetched by id');
        assert.ok(brief.papers.some(p => p.arxivId === '1908.10379'), 'named paper delivered as relevant');
        assert.ok(/NAMED in the task/.test(judgePrompt), 'judge told this is the named source');
        const knownQ = (brief.queries || []).find(qq => /^known:1908\.10379/.test(qq.label));
        assert.ok(knownQ && (knownQ.err || []).some(e => /arxiv-id: Timeout/.test(e)), 'lookup failure recorded in query log');
    });

    await ok('title-only known papers get NO synthetic stub (hallucination guard)', async () => {
        const got = await literature._internals._lookupKnownPapers(
            [{ title: 'Some paper the planner imagined' }],
            { searchSemanticScholar: async () => [] }, []);
        assert.strictEqual(got.length, 0, 'no stub without an explicit id');
    });

    await ok('named-source line absent for ordinary papers', async () => {
        const p = literature._internals._buildReadPrompt('q', { title: 't' }, SECTIONS, true);
        assert.ok(!/NAMED in the task/.test(p));
    });
}

// ── M: metadata enrichment of the stub ────────────────────────────────────────

async function runEnrichment() {
    console.log('\n── M: synthetic stub enriched by later search hit ──');
    await ok('stub title replaced when a search engine returns the same id', async () => {
        const real = { arxivId: '1908.10379', title: 'The Holographic Dual of Strongly deformed SYM', abstract: 'fishchain', authors: ['G'], year: 2019 };
        const pt = {
            // Id lookup dead; the keyword search DOES return the real record.
            searchArxiv: async (params) => params.eprint ? [] : [real],
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"fishchain holographic","categories":[]}';
            if (/Pick up to/.test(prompt)) return '0';
            return /GRADE this paper/.test(prompt) ? DIRECT_JUDGE : 'none';
        };
        const brief = await literature.runResearch({
            question: 'reproduce operators from arXiv:1908.10379', paperTools: pt, llm });
        const named = brief.papers.find(p => p.arxivId === '1908.10379');
        assert.ok(named, 'named paper delivered');
        assert.ok(/Holographic Dual/.test(named.title), `stub enriched with the real title (got: ${named.title})`);
    });
}

// ── B: missing-named backstop in the tool reply ────────────────────────────────

async function runBackstop() {
    console.log('\n── B: tool reply orders lit_read of an undelivered named id ──');
    await ok('0-relevant reply names the missing paper and orders a direct read', async () => {
        const ctx = {
            workDir: await createWorkDir(tmpDir()),
            paperTools: {
                searchArxiv: async () => { throw new Error('Timeout'); },
                fetchPaperHtml: async () => ({ html: '', source: 'none', hasFullText: false }),   // even the read fails
                extractSections: () => ({ headings: [], equations: [], textSample: '' }),
            },
            literatureLlm: async (prompt) => /GRADE this paper/.test(prompt) ? BAD_JUDGE : 'junk',
        };
        const r = await tools.handleResearchLiterature(
            { question: 'reproduce the L operators from https://arxiv.org/pdf/1908.10379' }, ctx);
        const payload = JSON.parse(r.modelPayload);
        assert.deepStrictEqual(payload.papers, []);
        assert.ok(/THE TASK NAMES arXiv:1908\.10379/.test(payload.reminder), 'missing named id called out');
        assert.ok(/lit_read\("1908\.10379"\)/.test(payload.reminder), 'direct read ordered');
    });
    await ok('no backstop text when the named paper WAS delivered', async () => {
        const named = { arxivId: '1908.10379', title: 'Holographic dual', abstract: 'fishchain', authors: [], year: 2019 };
        const ctx = {
            workDir: await createWorkDir(tmpDir()),
            paperTools: {
                searchArxiv: async (params) => params.eprint ? [named] : [],
                fetchPaperHtml: async () => FULLTEXT,
                extractSections: () => SECTIONS,
            },
            literatureLlm: async (prompt) => /GRADE this paper/.test(prompt) ? DIRECT_JUDGE : 'junk',
        };
        const r = await tools.handleResearchLiterature(
            { question: 'reproduce the L operators from arXiv:1908.10379' }, ctx);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(payload.papers.length >= 1);
        assert.ok(!/THE TASK NAMES/.test(payload.reminder), 'no false alarm');
    });
}

// ── C: engine circuit breaker ─────────────────────────────────────────────────

async function runBreaker() {
    console.log('\n── C: engine failing twice is benched for the round ──');
    await ok('arXiv stops being called after 2 failures in one round', async () => {
        let arxivCalls = 0;
        const pt = {
            searchArxiv: async () => { arxivCalls++; throw new Error('Timeout'); },
            searchSemanticScholar: async () => [],
        };
        const plan = { keywords: 'kw one', categories: [], queries: [
            { type: 'method', q: 'query a' }, { type: 'method', q: 'query b' },
            { type: 'method', q: 'query c' }, { type: 'method', q: 'query d' },
        ] };
        await literature._internals._search(plan, pt, 12, []);
        assert.strictEqual(arxivCalls, 2, `benched after 2 (got ${arxivCalls})`);
    });
    await ok('healthy engines keep running after another engine is benched', async () => {
        let s2Calls = 0;
        const pt = {
            searchArxiv: async () => { throw new Error('Timeout'); },
            searchSemanticScholar: async () => { s2Calls++; return []; },
        };
        const plan = { keywords: 'kw one', categories: [], queries: [
            { type: 'method', q: 'query a' }, { type: 'method', q: 'query b' }, { type: 'method', q: 'query c' },
        ] };
        await literature._internals._search(plan, pt, 12, []);
        assert.strictEqual(s2Calls, 4, `S2 ran for all queries (got ${s2Calls})`);
    });
}

(async () => {
    console.log('run9NamedPaper.test.js — Round-9 (named-paper grounding, enrichment, backstop, circuit breaker)');
    await runSyntheticGrounding();
    await runEnrichment();
    await runBackstop();
    await runBreaker();
    console.log(`\n── Round-9: ${passed} passed, ${failed} failed ──`);
    process.exit(failed ? 1 : 0);
})();
