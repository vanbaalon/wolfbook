'use strict';
/**
 * Round 5 — run Q_3VRPXL analysis (gmGens clean.wb failure, lit read:0, skill gaps):
 *
 *  H1 — topoSortSteps: dependency-orders the closure (the gmGens fix); stable
 *       tie-break by recorded order; cycle fallback.
 *  H2 — recoverMissingDefiners: unrecorded definer probes injected as synthetic steps.
 *  L1/L2 — literature: preselect "none" no longer terminates (reads top-2 anyway);
 *       graded judge (method counts as relevant); specializeHint parsed.
 *  L4 — research_literature retry allowed after a read:0 pipeline-failure brief.
 *  S1/S2 — capability triage: multi-pick with graded fit, gap list, legacy fallback.
 *  S3 — skill-gap section in the explore message.
 *
 * Run: node out/extension/oberon/tests/run5Research.test.js
 */

const assert = require('assert');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

// ── vscode stub ──────────────────────────────────────────────────────────────
const fakeVscodeId = path.resolve(__dirname, '..', 'vscode.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }), notebookDocuments: [], workspaceFolders: [] },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
        EventEmitter: class { constructor() { this.event = () => {}; } on() {} off() {} fire() {} },
        Uri: { file: (p) => ({ fsPath: p }) },
    },
};
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (req, parent, isMain, opts) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve(req, parent, isMain, opts);
};

let passCount = 0, failCount = 0;
async function ok(label, fn) {
    try { await fn(); console.log(`  ok ${label}`); passCount++; }
    catch (e) { console.error(`  FAIL ${label}: ${e && e.message || e}`); failCount++; }
}

const { topoSortSteps, recoverMissingDefiners } = require('../fairy/harness');
const literature = require('../fairy/literature');
const { runRecall, _internals: recallInternals } = require('../fairy/recall');
const tools = require('../fairy/tools');
const prompts = require('../fairy/prompts');
const { createWorkDir } = require('../fairy/workDir');
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'run5-')); }

// ── H1: topological sort ─────────────────────────────────────────────────────

async function runH1() {
    console.log('\n── H1: topoSortSteps (the gmGens ordering fix) ──');
    // Reconstruction of Q_3VRPXL: user-of-gmGens recorded BEFORE its definer.
    const steps = [
        { id: 'correct_gens6',  usesSymbols: ['gmGens'],           definesSymbols: ['gens6h'] },
        { id: 'invariance',     usesSymbols: ['gens6h'],           definesSymbols: ['buildTNew'] },
        { id: 'full_spectrum',  usesSymbols: ['t1n', 't2n'],       definesSymbols: ['eigC1'] },
        { id: 'gellmann',       usesSymbols: [],                   definesSymbols: ['gmGens'] },
        { id: 'build_t',        usesSymbols: ['buildTNew', 'gmGens', 'gens6h'], definesSymbols: ['t1n', 't2n'] },
    ];
    await ok('definers precede users; diagnostics note the reorder', async () => {
        const diags = [];
        const out = topoSortSteps(steps, diags);
        const pos = Object.fromEntries(out.map((s, i) => [s.id, i]));
        assert.ok(pos.gellmann < pos.correct_gens6, 'gmGens definer before user');
        assert.ok(pos.correct_gens6 < pos.invariance);
        assert.ok(pos.build_t < pos.full_spectrum, 't-matrices before spectrum');
        assert.ok(diags.some(d => d.type === 'reordered'));
    });
    await ok('already-ordered chains are untouched (stable, no diagnostic)', async () => {
        const ordered = [
            { id: 'a', usesSymbols: [], definesSymbols: ['x'] },
            { id: 'b', usesSymbols: ['x'], definesSymbols: ['y'] },
            { id: 'c', usesSymbols: ['y'], definesSymbols: [] },
        ];
        const diags = [];
        const out = topoSortSteps(ordered, diags);
        assert.deepStrictEqual(out.map(s => s.id), ['a', 'b', 'c']);
        assert.strictEqual(diags.length, 0);
    });
    await ok('cycles fall back to recorded order with a diagnostic', async () => {
        const cyc = [
            { id: 'p', usesSymbols: ['q1'], definesSymbols: ['p1'] },
            { id: 'q', usesSymbols: ['p1'], definesSymbols: ['q1'] },
        ];
        const diags = [];
        const out = topoSortSteps(cyc, diags);
        assert.deepStrictEqual(out.map(s => s.id), ['p', 'q']);
        assert.ok(diags.some(d => d.type === 'dependency_cycle'));
    });
    await ok('self-defined symbols create no self-edge', async () => {
        const st = [{ id: 'a', usesSymbols: ['x'], definesSymbols: ['x'] }];
        assert.strictEqual(topoSortSteps(st, []).length, 1);
    });
}

// ── H2: probe auto-recovery ───────────────────────────────────────────────────

async function runH2() {
    console.log('\n── H2: recoverMissingDefiners ──');
    const probes = [
        { probeId: 'p003', ok: true,  code: 'gmGens = Table[mat[i], {i, 15}]' },
        { probeId: 'p007', ok: true,  code: 'gmGens = correctedTable[base]' },   // latest definer wins
        { probeId: 'p004', ok: false, code: 'gmGens = broken[' },
        { probeId: 'p005', ok: true,  code: 'base = buildBase[4]' },
    ];
    await ok('missing definer pulled from the LATEST clean probe', async () => {
        const steps = [{ id: 's1', probeId: 'p010', code: 'c2 = Tr[gmGens[[1]].gmGens[[1]]]', usesSymbols: ['gmGens'], definesSymbols: ['c2'] }];
        const diags = [];
        const out = recoverMissingDefiners(steps, probes, new Set(), diags);
        const auto = out.find(s => s.auto);
        assert.ok(auto, 'synthetic step injected');
        assert.strictEqual(auto.probeId, 'p007');
        assert.ok(auto.note.includes('auto-recovered'));
        assert.ok(diags.some(d => d.type === 'auto_recovered_probe'));
    });
    await ok('recovery iterates (recovered probe needs a further symbol)', async () => {
        const steps = [{ id: 's1', probeId: 'p010', code: 'x', usesSymbols: ['gmGens'], definesSymbols: ['c2'] }];
        const out = recoverMissingDefiners(steps, probes, new Set(), []);
        const ids = out.map(s => s.probeId);
        assert.ok(ids.includes('p007'), 'gmGens definer recovered');
        assert.ok(ids.includes('p005'), 'transitive `base` definer recovered');
    });
    await ok('symbols known from utils/inputs are not recovered', async () => {
        const steps = [{ id: 's1', probeId: 'p010', code: 'x', usesSymbols: ['gmGens'], definesSymbols: [] }];
        const out = recoverMissingDefiners(steps, probes, new Set(['gmGens']), []);
        assert.strictEqual(out.length, 1);
    });
    await ok('no clean definer anywhere → nothing injected, no throw', async () => {
        const steps = [{ id: 's1', probeId: 'p010', code: 'x', usesSymbols: ['neverDefined'], definesSymbols: [] }];
        const out = recoverMissingDefiners(steps, probes, new Set(), []);
        assert.strictEqual(out.length, 1);
    });
}

// ── L1/L2: literature grading + read-anyway ───────────────────────────────────

function mkPaperTools(nPapers = 3) {
    return {
        searchArxiv: async () => Array.from({ length: nPapers }, (_, i) => ({
            arxivId: `2001.0000${i}`, title: `Fusion and T-systems, part ${i}`,
            abstract: 'General fusion relations for integrable transfer matrices.',
            authors: ['A'], year: 2020, citations: 10,
        })),
        fetchPaperHtml: async () => ({ html: '<math alttext="T_a(u+i/2)T_a(u-i/2)=T_{a+1}T_{a-1}+..."></math>' + 'x'.repeat(70000), source: 'ar5iv', hasFullText: true }),
        extractSections: () => ({ headings: ['Fusion'], equations: ['T_a(u+i/2)T_a(u-i/2)=T_{a+1}(u)T_{a-1}(u)+\\phi'], equationsTagged: [{ latex: 'T_a(u+i/2)T_a(u-i/2)=T_{a+1}(u)T_{a-1}(u)+\\phi', eqNumber: '2.7' }], textSample: 'fusion hierarchy for su(n) chains in any representation' }),
    };
}

async function runL12() {
    console.log('\n── L1/L2: method-grade judging + read-anyway fallback ──');

    await ok('L2: preselect "none" no longer terminates — top-2 are read and judged', async () => {
        let readCalls = 0;
        const llm = async (prompt) => {
            if (/Pick up to/.test(prompt)) return 'none';                       // preselect declines
            readCalls++;
            return JSON.stringify({ relevance: 'method', reason: 'general fusion relations apply',
                key_relations: [{ statement: 'fusion', latex: 'T_aT_a=T_{a+1}T_{a-1}+1', eqNumber: '2.7', specializeHint: 'set a=1..3 for su(4)' }],
                observations: [] });
        };
        const brief = await literature.runResearch({ question: 'T-system for SU(4) XXX chain, 6-dim antisym rep, L=2', paperTools: mkPaperTools(), llm });
        assert.ok(readCalls >= 1, 'papers were read despite preselect none');
        assert.ok(brief.papers.length >= 1, 'method-grade papers returned');
        assert.strictEqual(brief.papers[0].grade, 'method');
        assert.strictEqual(brief.diagnostics.preselectDeclined, true);
        assert.ok(brief.key_equations[0].specializeHint.includes('su(4)'));
        assert.strictEqual(brief.key_equations[0].eqNumber, '2.7');
    });
    await ok('graded judge: "none" grade rejects; back-compat bool still parses', async () => {
        const j1 = literature._internals._parseJudge(JSON.stringify({ relevance: 'none', reason: 'neutron stars', key_relations: [], observations: [] }));
        assert.strictEqual(j1.relevant, false);
        assert.strictEqual(j1.grade, 'none');
        const j2 = literature._internals._parseJudge(JSON.stringify({ relevant: true, reason: 'old-style', key_relations: [], observations: [] }));
        assert.strictEqual(j2.relevant, true);
        assert.strictEqual(j2.grade, null);
        const j3 = literature._internals._parseJudge(JSON.stringify({ relevance: 'background', reason: 'context', key_relations: [], observations: [] }));
        assert.strictEqual(j3.relevant, false);
    });
}

// ── L4: retry after a read:0 pipeline failure ─────────────────────────────────

async function runL4() {
    console.log('\n── L4: research_literature retry after read:0 brief ──');
    const workDir = await createWorkDir(tmpDir());
    await workDir.addLiteratureBrief({
        question: 'T-system for SU(4) XXX chain L=2 in 6-dim rep',
        papers: [], key_equations: [], diagnostics: { searched: 11, read: 0, relevant: 0 },
    });
    const ctx = {
        workDir,
        paperTools: mkPaperTools(),
        literatureLlm: async (prompt) => /Pick up to/.test(prompt) ? '0'
            : JSON.stringify({ relevance: 'method', reason: 'fits', key_relations: [], observations: [] }),
    };
    await ok('near-duplicate question ALLOWED when the prior brief read nothing', async () => {
        const r = await tools.handleResearchLiterature({ question: 'T-system for SU(4) XXX spin chain L=2 in the 6-dim representation' }, ctx);
        assert.strictEqual(r.ok, true, r.error || '');
    });
    await ok('near-duplicate still REJECTED when the prior brief actually read papers', async () => {
        const wd2 = await createWorkDir(tmpDir());
        await wd2.addLiteratureBrief({
            question: 'fusion hierarchy for su(4) transfer matrices',
            papers: [{ ref: 'arXiv:x' }], key_equations: [{ latex: 'T' }],
            diagnostics: { searched: 5, read: 3, relevant: 1 },
        });
        const r = await tools.handleResearchLiterature(
            { question: 'fusion hierarchy of su(4) transfer matrices' }, { ...ctx, workDir: wd2 });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.kind, 'duplicate_query');
    });
}

// ── S1/S2: capability triage ──────────────────────────────────────────────────

const CANDS = [
    { namespace: 'a', name: 'qq-system', version: '1', score: 0.43, summary: 'QQ-system solver for SU(N) chains.' },
    { namespace: 'b', name: 'rep-gens',  version: '1', score: 0.41, summary: 'SU(N) generators in arbitrary irreps.' },
    { namespace: 'c', name: 'feynman',   version: '1', score: 0.38, summary: 'Feynman diagram power counting.' },
];
function mkClient() {
    return { search: async () => ({ results: CANDS }), getSkill: async (ns, n) => ({ body: `# ${n}\n## Method\nM` }) };
}

async function runS12() {
    console.log('\n── S1/S2: capability triage — multi-pick, graded fit, gaps ──');
    const verdict = JSON.stringify({
        capabilities: ['SU(N) generators in a given irrep', 'transfer-matrix construction', 'T-system relations'],
        picks: [
            { index: 1, capability: 'SU(N) generators in a given irrep', fit: 'exact', covers: 'irrep generators', lacks: null },
            { index: 0, capability: 'T-system relations', fit: 'partial', covers: 'QQ relations', lacks: 'no explicit T-system fusion' },
        ],
        gaps: ['transfer-matrix construction'],
    });
    await ok('two skills picked, graded; gaps surfaced; primary = first pick', async () => {
        const res = await runRecall('T-system for SU(4) chain', { client: mkClient(), llm: async () => verdict, timeoutMs: 5000 });
        assert.strictEqual(res.mode, 'consult');
        assert.strictEqual(res.skills.length, 2);
        assert.strictEqual(res.skillRef, '@b/rep-gens@1');
        assert.strictEqual(res.skills[0].fit, 'exact');
        assert.strictEqual(res.skills[1].fit, 'partial');
        assert.ok(res.skills[1].lacks.includes('fusion'));
        assert.deepStrictEqual(res.gaps, ['transfer-matrix construction']);
        assert.strictEqual(res.recallLog.triage.picks.length, 2);
    });
    await ok('empty picks + gaps → mode none WITH the gap list (feeds skill requests)', async () => {
        const v = JSON.stringify({ capabilities: ['x'], picks: [], gaps: ['x'] });
        const res = await runRecall('task', { client: mkClient(), llm: async () => v, timeoutMs: 5000 });
        assert.strictEqual(res.mode, 'none');
        assert.deepStrictEqual(res.gaps, ['x']);
    });
    await ok('legacy bare-index reply still picks one skill', async () => {
        const res = await runRecall('task', { client: mkClient(), llm: async () => '2', timeoutMs: 5000 });
        assert.strictEqual(res.mode, 'consult');
        assert.strictEqual(res.skillRef, '@c/feynman@1');
        assert.strictEqual(res.skills.length, 1);
    });
    await ok('_parseTriage caps picks at 2 and dedupes indices', async () => {
        const v = JSON.stringify({ capabilities: ['a'], picks: [{ index: 0, fit: 'exact' }, { index: 0, fit: 'partial' }, { index: 1, fit: 'exact' }, { index: 2, fit: 'exact' }], gaps: [] });
        const t = recallInternals._parseTriage(v, 3);
        assert.strictEqual(t.picks.length, 2);
        assert.notStrictEqual(t.picks[0].index, t.picks[1].index);
    });
}

// ── S3: gap section in the explore message ───────────────────────────────────

async function runS3() {
    console.log('\n── S3: skill-gap visibility ──');
    const base = {
        taskDescription: 'T.', inputs: [], assumptions: [],
        budget: { exploreProbesRemaining: 30, backtracksRemaining: 3, turnsRemaining: 70 },
        charmId: 'C01', kernelFresh: true, inputsLoaded: 0,
    };
    await ok('gaps rendered with derive-cleanly instruction', async () => {
        const msg = prompts.buildExploreUserMessage({ ...base, skillGaps: ['SU(N) generators in arbitrary irreps'] });
        assert.ok(msg.includes('## Known skill gaps'));
        assert.ok(msg.includes('SU(N) generators in arbitrary irreps'));
        assert.ok(/candidate NEW skills/.test(msg));
    });
    await ok('section absent without gaps', async () => {
        assert.ok(!prompts.buildExploreUserMessage(base).includes('Known skill gaps'));
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    await runH1();
    await runH2();
    await runL12();
    await runL4();
    await runS12();
    await runS3();
    console.log(`\n── Round-5 research: ${passCount} passed, ${failCount} failed ──`);
    process.exit(failCount ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
