'use strict';
/**
 * Round-7 tests (run Q_41HVIJ analysis + user feedback):
 *  K — known_papers: the planner NAMES canonical papers from its own knowledge;
 *      they are looked up directly (id or validated title match), read first,
 *      and hallucinated titles are dropped.
 *  A — author-only fallback: author+phrase query that finds 0 refires author-only.
 *  D — disambiguation: plan.avoid threads into preselect + read-judge prompts.
 *  P — partial-credit "method" grading line in the read prompt.
 *  U — ask_specialist: literature failure paths point at it (only when a human is
 *      wired); lit_read allows ≤2 direct reads for user/known references.
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
const vscodeStub = path.join(os.tmpdir(), 'run7-vscode-stub.js');
fs.writeFileSync(vscodeStub, 'module.exports = { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) }, window: {}, Uri: { file: (f) => ({ fsPath: f }) }, commands: { executeCommand: async () => {} } };');
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return origResolve.call(this, request, ...rest);
};

const literature = require(path.join(__dirname, '..', 'fairy', 'literature.js'));
const tools      = require(path.join(__dirname, '..', 'fairy', 'tools.js'));
const toolSpecs  = require(path.join(__dirname, '..', 'fairy', 'toolSpecs.js'));
const prompts    = require(path.join(__dirname, '..', 'fairy', 'prompts.js'));
const { createWorkDir } = require(path.join(__dirname, '..', 'fairy', 'workDir.js'));

let passed = 0, failed = 0;
async function ok(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e && e.message}`); }
}
function tmpDir() {
    const d = path.join(os.tmpdir(), 'run7-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(d, { recursive: true });
    return d;
}

const GOOD_JUDGE = JSON.stringify({ relevance: 'method', reason: 'fusion procedure paper',
    key_relations: [{ statement: 'fusion', latex: 'R_{12}R_{13}R_{23}' }], observations: [] });
const BAD_JUDGE = JSON.stringify({ relevance: 'none', reason: 'different physics', key_relations: [], observations: [] });
const FULLTEXT = { html: '<math alttext="x">x</math>' + 'x'.repeat(500), source: 'ar5iv', hasFullText: true };
const SECTIONS = { headings: ['H'], equations: ['R=1'], textSample: 'fusion procedure projectors' };

// ── K: known_papers — the model's own knowledge of the literature ──────────────

async function runKnownPapers() {
    console.log('\n── K: known_papers (model names canonical papers) ──');

    await ok('_parsePlan parses known_papers + avoid', async () => {
        const p = literature._internals._parsePlan(JSON.stringify({
            keywords: 'fusion', categories: ['hep-th'],
            known_papers: [
                { title: 'Yang-Baxter equation and representation theory I', authors: 'Kulish, Reshetikhin, Sklyanin', year: 1981, arxivId: null },
                { title: '', arxivId: 'arXiv:1010.4022' },
                { bogus: true },
            ],
            avoid: 'fusion categories, anyons, topological defects',
        }));
        assert.strictEqual(p.knownPapers.length, 2);
        assert.strictEqual(p.knownPapers[0].title, 'Yang-Baxter equation and representation theory I');
        assert.strictEqual(p.knownPapers[0].arxivId, undefined, 'null id normalized away');
        assert.strictEqual(p.knownPapers[1].arxivId, '1010.4022', 'arXiv: prefix stripped');
        assert.ok(/anyons/.test(p.avoid));
    });

    await ok('known paper with arXiv id → direct id lookup', async () => {
        const seen = [];
        const pt = { searchArxiv: async (params) => { seen.push(params); return params.eprint ? [{ arxivId: params.eprint, title: 'T-system paper', abstract: 'a', authors: [], year: 2010 }] : []; } };
        const got = await literature._internals._lookupKnownPapers([{ title: 'T-system paper', arxivId: '1010.4022' }], pt, []);
        assert.strictEqual(got.length, 1);
        assert.strictEqual(got[0].arxivId, '1010.4022');
        assert.strictEqual(got[0].known, true);
        assert.ok(seen.some(s => s.eprint === '1010.4022'), 'id lookup used eprint param');
    });

    await ok('known paper by title → title search, kept on match, dropped on mismatch', async () => {
        const pt = {
            searchSemanticScholar: async ({ query }) => [
                { arxivId: '8888.1', title: query.includes('representation theory') ? 'Yang-Baxter equation and representation theory' : 'Totally different anyon paper', abstract: '', authors: [], year: 1981 },
            ],
        };
        const hit = await literature._internals._lookupKnownPapers(
            [{ title: 'Yang-Baxter equation and representation theory' }], pt, []);
        assert.strictEqual(hit.length, 1, 'matching title kept');
        const miss = await literature._internals._lookupKnownPapers(
            [{ title: 'Fusion procedure for quantum groups' }], pt, []);
        assert.strictEqual(miss.length, 0, 'hallucinated/mismatched title dropped');
    });

    await ok('known papers are read FIRST even when keyword search found other papers', async () => {
        const readOrder = [];
        const pool = { arxivId: '2001.1', title: 'Random fusion category paper', abstract: 'anyons fusion', authors: [], year: 2020, citations: 900 };
        const krs  = { arxivId: '8103.9', title: 'Fusion procedure original', abstract: 'projectors', authors: [], year: 1981 };
        const pt = {
            searchArxiv: async (params) => params.eprint ? [krs] : [pool],
            fetchPaperHtml: async (id) => { readOrder.push(id); return FULLTEXT; },
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return JSON.stringify({
                keywords: 'fusion procedure', categories: [],
                known_papers: [{ title: 'Fusion procedure original', arxivId: '8103.9' }],
            });
            if (/Pick up to/.test(prompt)) return '0';   // preselect picks the pool paper only
            const head = prompt.split('Body excerpt')[0] || prompt;
            return /Fusion procedure original/.test(head) ? GOOD_JUDGE : BAD_JUDGE;
        };
        const brief = await literature.runResearch({ question: 'fusion procedure for SU(4) L operators', paperTools: pt, llm });
        assert.strictEqual(readOrder[0], '8103.9', 'known paper fetched first');
        assert.ok(brief.papers.some(p => p.arxivId === '8103.9'), 'known paper delivered');
    });

    await ok('plan + reformulate prompts request known_papers and avoid', async () => {
        const plan = literature._internals._buildPlanPrompt('q');
        assert.ok(/known_papers/.test(plan) && /YOUR OWN KNOWLEDGE/.test(plan));
        assert.ok(/avoid/.test(plan) && /DISAMBIGUATE/.test(plan));
        const ref = literature._internals._buildReformulatePrompt('q', { round: 2, tried: [] });
        assert.ok(/known_papers/.test(ref), 'reformulate also asks for known papers');
        assert.ok(/avoid/.test(ref));
    });
}

// ── A: author-only fallback ────────────────────────────────────────────────────

async function runAuthorFallback() {
    console.log('\n── A: author+phrase → author-only fallback ──');

    await ok('author query with abstract finding 0 refires author-only (mostcited)', async () => {
        const calls = [];
        const pt = {
            searchArxiv: async (params) => { calls.push({ ...params }); return []; },
            searchInspire: async (params, max, opts) => {
                calls.push({ ...params, sort: opts && opts.sort });
                // Only the author-ONLY query finds the pre-arXiv canonical paper.
                return (params.author && !params.abstract)
                    ? [{ inspireId: '42', title: 'Yang-Baxter equation and representation theory', abstract: '', authors: ['P. Kulish'], year: 1981, citations: 1500 }]
                    : [];
            },
        };
        const queryLog = [];
        const found = await literature._internals._search(
            { keywords: '', categories: [], queries: [{ type: 'author', author: 'Kulish', abs: 'fusion of L operators' }] },
            pt, 12, queryLog);
        assert.ok(found.length >= 1, 'author-only fallback found the paper');
        assert.ok(queryLog.some(qq => /\(broad\)$/.test(qq.label) && qq.added >= 1), 'broad query logged');
        assert.ok(calls.some(c => c.author === 'Kulish' && !c.abstract && c.sort === 'mostcited'), 'refired author-only mostcited');
    });

    await ok('no fallback when the author+phrase query already found papers', async () => {
        const queryLog = [];
        const pt = { searchArxiv: async () => [{ arxivId: '1', title: 'T', abstract: '', authors: [], year: 2000 }] };
        await literature._internals._search(
            { keywords: '', categories: [], queries: [{ type: 'author', author: 'Kulish', abs: 'fusion' }] },
            pt, 12, queryLog);
        assert.ok(!queryLog.some(qq => /\(broad\)$/.test(qq.label)), 'no broad refire on success');
    });
}

// ── D/P: disambiguation + partial credit ──────────────────────────────────────

async function runPrompting() {
    console.log('\n── D/P: avoid-terms + partial-credit grading ──');

    await ok('avoid terms appear in preselect and read prompts', async () => {
        const pre = literature._internals._buildPreselectPrompt('q', [{ title: 't', abstract: 'a' }], 3, 'fusion categories, anyons');
        assert.ok(/NOT about fusion categories, anyons/.test(pre));
        const read = literature._internals._buildReadPrompt('q', { title: 't' }, SECTIONS, true, 'fusion categories, anyons');
        assert.ok(/NOT about fusion categories, anyons/.test(read));
        const noAvoid = literature._internals._buildPreselectPrompt('q', [{ title: 't', abstract: 'a' }], 3);
        assert.ok(!/NOT about/.test(noAvoid), 'no avoid line when unset');
    });

    await ok('read prompt gives partial usefulness method credit', async () => {
        const read = literature._internals._buildReadPrompt('q', { title: 't' }, SECTIONS, true);
        assert.ok(/PARTIAL usefulness also counts/.test(read));
        assert.ok(/PART of the task/.test(read));
    });

    await ok('avoid threads through the full pipeline into the judge prompt', async () => {
        let judgePrompt = '';
        const pt = {
            searchArxiv: async () => [{ arxivId: '1', title: 'Ising defects', abstract: 'fusion category', authors: [], year: 2020 }],
            fetchPaperHtml: async () => FULLTEXT,
            extractSections: () => SECTIONS,
        };
        const llm = async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return JSON.stringify({ keywords: 'fusion', categories: [], avoid: 'fusion categories, anyons' });
            if (/Pick up to/.test(prompt)) return '0';
            if (/GRADE this paper/.test(prompt)) { judgePrompt = prompt; return BAD_JUDGE; }
            return BAD_JUDGE;
        };
        await literature.runResearch({ question: 'Yang-Baxter fusion for spin chains', paperTools: pt, llm, budget: { rounds: 1 } });
        assert.ok(/NOT about fusion categories/.test(judgePrompt), 'judge saw the avoid terms');
    });
}

// ── U: ask_specialist wiring + lit_read direct reads ──────────────────────────

async function runAskUser() {
    console.log('\n── U: ask_specialist guidance + lit_read direct reads ──');

    const offTopic = { arxivId: '1901.1', title: 'Neutron star cooling', abstract: 'astro', authors: ['N'], year: 2019 };
    const mkCtx = async (withAskUser) => ({
        workDir: await createWorkDir(tmpDir()),
        paperTools: { searchArxiv: async () => [offTopic], fetchPaperHtml: async () => FULLTEXT, extractSections: () => SECTIONS },
        literatureLlm: async (prompt) => {
            if (/SEARCH PLAN/.test(prompt)) return '{"keywords":"star","categories":[]}';
            if (/Pick up to/.test(prompt)) return '0';
            return BAD_JUDGE;
        },
        ...(withAskUser ? { askUser: async () => 'answer' } : {}),
    });

    await ok('0-relevant reminder suggests ask_specialist ONLY when a human is wired', async () => {
        const withUser = await tools.handleResearchLiterature({ question: 'long enough literature question' }, await mkCtx(true));
        assert.ok(/ask_specialist/.test(JSON.parse(withUser.modelPayload).reminder), 'suggested with askUser');
        const noUser = await tools.handleResearchLiterature({ question: 'long enough literature question' }, await mkCtx(false));
        assert.ok(!/ask_specialist/.test(JSON.parse(noUser.modelPayload).reminder), 'absent without askUser');
    });

    await ok('budget_spent error suggests asking the user for a reference', async () => {
        const ctx = await mkCtx(true);
        for (let i = 0; i < 3; i++) await ctx.workDir.addLiteratureBrief({ question: 'q' + i, papers: [{ ref: 'x' }], key_equations: [], diagnostics: { read: 1 } });
        const r = await tools.handleResearchLiterature({ question: 'yet another literature question' }, ctx);
        assert.strictEqual(r.kind, 'budget_spent');
        assert.ok(/ask_specialist/.test(r.error), 'budget error mentions ask_specialist');
    });

    await ok('lit_read allows 2 direct (unsurfaced) reads, rejects the 3rd', async () => {
        const ctx = await mkCtx(true);
        for (const id of ['1111.1', '2222.2']) {
            const r = await tools.handleLitRead({ arxivId: id, question: 'what is the main relation?' }, ctx);
            assert.strictEqual(r.ok, true, `direct read ${id}: ${r.error || ''}`);
            assert.strictEqual(JSON.parse(r.modelPayload).direct, true);
        }
        const r3 = await tools.handleLitRead({ arxivId: '3333.3', question: 'what is the main relation?' }, ctx);
        assert.strictEqual(r3.ok, false);
        assert.strictEqual(r3.kind, 'not_surfaced');
        assert.ok(/direct-read allowance/.test(r3.error));
    });

    await ok('surfaced papers do not consume the direct-read allowance', async () => {
        const ctx = await mkCtx(true);
        await ctx.workDir.addLiteratureBrief({ question: 'q', papers: [{ arxivId: '4444.4', ref: 'arXiv:4444.4' }], key_equations: [], diagnostics: { read: 1 } });
        for (const id of ['5555.5', '6666.6']) await tools.handleLitRead({ arxivId: id, question: 'what is the relation here?' }, ctx);
        const r = await tools.handleLitRead({ arxivId: '4444.4', question: 'what is the relation here?' }, ctx);
        assert.strictEqual(r.ok, true, r.error || '');
        assert.strictEqual(JSON.parse(r.modelPayload).direct, undefined, 'surfaced read not flagged direct');
    });

    await ok('specs + system prompt teach the two ask_specialist uses', async () => {
        const spec = toolSpecs.FAIRY_TOOL_SPECS.find(t => t.function.name === 'ask_specialist');
        assert.ok(/ambiguous or underspecified/.test(spec.function.description));
        assert.ok(/arXiv id/.test(spec.function.description));
        assert.ok(/ask the human/i.test(prompts.FAIRY_SYSTEM_PROMPT), 'system prompt: literature-failure escalation');
        assert.ok(/ask before building\s+on a guess/i.test(prompts.FAIRY_SYSTEM_PROMPT), 'system prompt: early ambiguity ask');
        const explore = toolSpecs.EXPLORE_FAIRY_TOOL_SPECS.find(t => t.function.name === 'lit_read');
        assert.ok(/OUTSIDE the search results/.test(explore.function.description), 'lit_read hint mentions direct reads');
    });
}

(async () => {
    console.log('run7Feedback.test.js — Round-7 (known papers, author fallback, disambiguation, ask-the-user)');
    await runKnownPapers();
    await runAuthorFallback();
    await runPrompting();
    await runAskUser();
    console.log(`\n── Round-7: ${passed} passed, ${failed} failed ──`);
    process.exit(failed ? 1 : 0);
})();
