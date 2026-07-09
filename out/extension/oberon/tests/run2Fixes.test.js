'use strict';
/**
 * Run-analysis fixes (run Q_2N8616, 2026-07-01) + audit leftovers:
 *
 *  I1  — compile no longer embeds the Off[...] suppression cell in clean.wb
 *  I2  — edit_cell falls back to disk when no document is open (appliedVia)
 *  I3  — edit_cell cannot gut a crosscheck step's cell
 *  I4  — run_clean syncs polish-edited cell code back into steps.json
 *  I5  — run_clean executes charm.validationChecks (block ×2, then downgrade)
 *  I7  — record warns when a used symbol has no defining step (names the probe)
 *  I8  — recall times out and fails open
 *  I9  — extractSections captures equation numbers; judge keeps eqNumber
 *  I10 — lit_read: whitelist, cache reuse, per-run cap
 *  O1  — providerConfigured accepts anthropic/openai with env keys
 *  O7  — revise_plan: requires a plan, capped at 2 revisions
 *  O8  — inspect applies ops to the stored value (no re-evaluation)
 *
 * Run: node out/extension/oberon/tests/run2Fixes.test.js
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
        workspace: {
            getConfiguration: () => ({ get: () => undefined }),
            onDidChangeConfiguration: () => ({ dispose() {} }),
            notebookDocuments: [],
        },
        window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) },
        EventEmitter: class { constructor() { this.event = () => {}; } on() {} off() {} fire() {} },
        Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
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
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'run2fx-')); }

const tools          = require('../fairy/tools');
const { createWorkDir } = require('../fairy/workDir');
const { compile }    = require('../fairy/harness');
const { runRecall }  = require('../fairy/recall');
const paperSearch    = require('../../tools/paperSearch');
const literature     = require('../fairy/literature');
const roles          = require('../config/roles');

// ── I1: no suppression cell in the compiled deliverable ─────────────────────

async function runI1() {
    console.log('\n── I1: clean.wb ships without the Off[...] suppression cell ──');
    const workDir = await createWorkDir(tmpDir());
    await workDir.saveProbe('p001', { code: 'x = 1 + 1', ok: true, value: '2' });
    await workDir.addStep({
        id: 'step_x', probeId: 'p001', code: 'x = 1 + 1', resultRef: 'p001',
        dependsOn: [], usesSymbols: [], definesSymbols: ['x'], note: 'define x',
    });
    const res = await compile(workDir, 'step_x', { taskTitle: 'test' });
    assert.strictEqual(res.ok, true);
    const nb = JSON.parse(fs.readFileSync(workDir.cleanNb, 'utf8'));
    const all = nb.cells.map(c => c.value).join('\n');
    await ok('no Off[...] cell and no "Suppressed" heading', async () => {
        assert.ok(!/\bOff\[/.test(all), 'found Off[ in clean.wb');
        assert.ok(!/Suppressed non-critical/.test(all), 'found suppression heading');
    });
    await ok('step cell still present with its tag', async () => {
        const stepCell = nb.cells.find(c => c.metadata && c.metadata.tags && c.metadata.tags[0] === 'step');
        assert.ok(stepCell && stepCell.value.includes('x = 1 + 1'));
    });
}

// ── I2/I3: edit_cell coherence + crosscheck protection ──────────────────────

async function setupPolishDir() {
    const workDir = await createWorkDir(tmpDir());
    await workDir.saveProbe('p001', { code: 'c2Eigs = Sort[Eigenvalues[C2]]', ok: true, value: '{1}' });
    await workDir.addStep({
        id: 'xcheck', probeId: 'p001', code: 'c2Eigs = Sort[Eigenvalues[C2]]', resultRef: 'p001',
        dependsOn: [], usesSymbols: ['C2'], definesSymbols: ['c2Eigs'],
        note: 'Casimir crosscheck', role: 'crosscheck',
    });
    await workDir.saveProbe('p002', { code: 'spec = Sort[Eigenvalues[N[H]]]', ok: true, value: '{1.}' });
    await workDir.addStep({
        id: 'spectrum', probeId: 'p002', code: 'spec = Sort[Eigenvalues[N[H]]]', resultRef: 'p002',
        dependsOn: [], usesSymbols: ['H'], definesSymbols: ['spec'], note: 'spectrum',
    });
    // clean.wb with tagged step cells (as buildCleanCells would produce)
    const nb = { cells: [
        { id: 'hdr', kind: 1, languageId: 'markdown', value: 'header', outputs: [], metadata: { tags: ['header'] } },
        { id: 'xcheck_cell', kind: 2, languageId: 'wolfram',
          value: '(* Casimir crosscheck *)\nc2Eigs = Sort[Eigenvalues[C2]]', outputs: [],
          metadata: { tags: ['step', 'xcheck'] } },
        { id: 'spectrum_cell', kind: 2, languageId: 'wolfram',
          value: '(* spectrum *)\nspec = Sort[Eigenvalues[N[H]]]', outputs: [],
          metadata: { tags: ['step', 'spectrum'] } },
    ] };
    fs.writeFileSync(workDir.cleanNb, JSON.stringify(nb, null, 2), 'utf8');
    return workDir;
}

async function runI23() {
    console.log('\n── I2/I3: edit_cell coherence + crosscheck protection ──');
    const workDir = await setupPolishDir();
    const ctx = { workDir, shim: {} };   // no editNotebookCell → disk fallback

    await ok('gutting a crosscheck cell is rejected', async () => {
        const r = await tools.handleEditCell({
            notebook: 'clean', cellIndex: 0,
            newCode: 'gm1 = {{0, 1}, {1, 0}};\ngm2 = {{0, -I}, {I, 0}};',
        }, ctx);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.kind, 'crosscheck_protected');
        const payload = JSON.parse(r.modelPayload);
        assert.ok(/reopen_chain/.test(payload.suggestedAction));
    });
    await ok('crosscheck edit that KEEPS the verification is allowed', async () => {
        const r = await tools.handleEditCell({
            notebook: 'clean', cellIndex: 0,
            newCode: 'c2Eigs = Sort[Eigenvalues[N[C2]]]',   // still defines c2Eigs
        }, ctx);
        assert.strictEqual(r.ok, true);
        const payload = JSON.parse(r.modelPayload);
        assert.strictEqual(payload.appliedVia, 'disk');
        assert.strictEqual(payload.stepId, 'xcheck');
    });
    await ok('regular-step edit dropping its symbols warns (not rejects)', async () => {
        const r = await tools.handleEditCell({
            notebook: 'clean', cellIndex: 1,
            newCode: 'unrelated = 42',
        }, ctx);
        assert.strictEqual(r.ok, true);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(/reopen_chain/.test(payload.warning || ''), 'expected structural-edit warning');
    });
    await ok('document path used when shim.editNotebookCell applies', async () => {
        let calledWith = null;
        const ctx2 = { workDir, shim: { editNotebookCell: async (p, idx, code) => { calledWith = { p, idx, code }; return { applied: true }; } } };
        const r = await tools.handleEditCell({ notebook: 'clean', cellIndex: 1, newCode: 'spec = Sort[Eigenvalues[N[H]]]' }, ctx2);
        const payload = JSON.parse(r.modelPayload);
        assert.strictEqual(payload.appliedVia, 'document');
        assert.strictEqual(calledWith.idx, 2);   // ABSOLUTE index (markdown header at 0)
    });
}

// ── I4/I5: run_clean validations + step-sync ─────────────────────────────────

async function runI45() {
    console.log('\n── I4/I5: run_clean validation checks + step-sync ──');
    const workDir = await setupPolishDir();

    // Simulate a polish edit that changed the spectrum cell on disk.
    const nb = JSON.parse(fs.readFileSync(workDir.cleanNb, 'utf8'));
    nb.cells[2].value = '(* spectrum *)\nspec = Sort[Eigenvalues[N[H]]] // Chop';
    fs.writeFileSync(workDir.cleanNb, JSON.stringify(nb, null, 2), 'utf8');

    const cleanRun = { allClean: true, cellCount: 2, failures: [], allResults: [] };
    const mkShim = (valValue) => ({
        restartKernel: async () => ({ ok: true }),
        runNotebook:   async () => cleanRun,
        evalOnce:      async ({ expression }) => ({ ok: true, value: valValue(expression) }),
    });

    await ok('failing validation blocks allClean (attempt 1 and 2), then downgrades', async () => {
        const ctx = {
            workDir, shim: mkShim(() => 'False'),
            charm: { validationChecks: ['HermitianMatrixQ[H]'] },
            polishState: {},
        };
        const r1 = JSON.parse((await tools.handleRunClean({}, ctx)).modelPayload);
        assert.strictEqual(r1.allClean, false);
        assert.ok(/validation check\(s\) FAILED/.test(r1.validationNotice));
        const r2 = JSON.parse((await tools.handleRunClean({}, ctx)).modelPayload);
        assert.strictEqual(r2.allClean, false);
        const r3 = JSON.parse((await tools.handleRunClean({}, ctx)).modelPayload);
        assert.strictEqual(r3.allClean, true);   // downgraded after 2 blocked attempts
        assert.ok(/downgraded to warnings/.test(r3.validationNotice));
    });
    await ok('passing validations keep allClean and reset the streak', async () => {
        const ctx = {
            workDir, shim: mkShim(() => 'True'),
            charm: { validationChecks: ['HermitianMatrixQ[H]'] },
            polishState: { validationFailStreak: 1 },
        };
        const r = JSON.parse((await tools.handleRunClean({}, ctx)).modelPayload);
        assert.strictEqual(r.allClean, true);
        assert.strictEqual(ctx.polishState.validationFailStreak, 0);
        assert.strictEqual(r.validationResults[0].passed, true);
    });
    await ok('step-sync writes edited cell code back into steps.json', async () => {
        // Fresh polish edit (earlier allClean calls already synced the // Chop change).
        const nb2 = JSON.parse(fs.readFileSync(workDir.cleanNb, 'utf8'));
        nb2.cells[2].value = '(* spectrum *)\nspec = Sort[Chop[Eigenvalues[N[H]], 10^-12]]';
        fs.writeFileSync(workDir.cleanNb, JSON.stringify(nb2, null, 2), 'utf8');

        const ctx = { workDir, shim: mkShim(() => 'True'), charm: {}, polishState: {} };
        const r = JSON.parse((await tools.handleRunClean({}, ctx)).modelPayload);
        assert.ok((r.syncedSteps || []).includes('spectrum'), 'spectrum not synced');
        const steps = await workDir.loadValidSteps();
        const spec = steps.find(s => s.id === 'spectrum');
        assert.strictEqual(spec.code, 'spec = Sort[Chop[Eigenvalues[N[H]], 10^-12]]');
        assert.strictEqual(spec.editedInPolish, true);
    });
}

// ── I7: record missing-dependency warning ────────────────────────────────────

async function runI7() {
    console.log('\n── I7: record-time missing-dependency warning ──');
    const workDir = await createWorkDir(tmpDir());
    const shim = { evalOnce: async () => ({ ok: true, value: 'True' }), DEFAULT_TIMEOUT: 30 };
    const ctx = { workDir, shim };

    await workDir.saveProbe('p001', { code: 'eigs = Eigenvalues[m]', ok: true, value: '{1, 2}' });
    await workDir.saveProbe('p002', { code: 'counts = Tally[eigs]', ok: true, value: '{{1,1},{2,1}}' });

    await ok('warns and names the defining probe', async () => {
        const r = await tools.handleRecord({ stepId: 'step_counts', probeId: 'p002' }, ctx);
        assert.strictEqual(r.ok, true);
        const payload = JSON.parse(r.modelPayload);
        const w = (payload.warnings || []).find(x => /`eigs`/.test(x));
        assert.ok(w, 'expected missing-dep warning for eigs');
        assert.ok(/p001/.test(w), 'expected the warning to name probe p001');
    });
    await ok('no warning once the defining step is recorded', async () => {
        await tools.handleRecord({ stepId: 'step_eigs', probeId: 'p001' }, ctx);
        await workDir.saveProbe('p003', { code: 'sorted = Sort[eigs]', ok: true, value: '{1, 2}' });
        const r = await tools.handleRecord({ stepId: 'step_sorted', probeId: 'p003' }, ctx);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(!(payload.warnings || []).some(x => /`eigs`/.test(x)));
    });
}

// ── I8: recall timeout ────────────────────────────────────────────────────────

async function runI8() {
    console.log('\n── I8: recall timeout fails open ──');
    await ok('slow backend → mode none with timeout error, within deadline', async () => {
        const client = { search: () => new Promise(r => setTimeout(() => r({ results: [] }), 5000)) };
        const t0 = Date.now();
        const res = await runRecall('find the spectrum', { client, timeoutMs: 1000 });
        const elapsed = Date.now() - t0;
        assert.strictEqual(res.mode, 'none');
        assert.ok(/timed out/.test(res.recallLog.error), res.recallLog.error);
        assert.ok(elapsed < 3000, `took ${elapsed}ms`);
    });
    await ok('fast backend unaffected', async () => {
        const client = {
            search: async () => ({ results: [{ namespace: 'a', name: 'b', version: '1', score: 0.9 }] }),
            getSkill: async () => ({ body: '# Skill\n## Method\nuse it' }),
        };
        const res = await runRecall('task', { client, timeoutMs: 5000 });
        assert.strictEqual(res.mode, 'consult');
        assert.strictEqual(res.skillRef, '@a/b@1');
    });
}

// ── I9: equation numbers ──────────────────────────────────────────────────────

async function runI9() {
    console.log('\n── I9: equation-number extraction + judge passthrough ──');
    const html = `
      <h2>2. The QQ system</h2>
      <table class="ltx_equation"><tr><td>
        <math alttext="Q^{+}(u)Q^{-}(u) = f(u)"></math>
        <span class="ltx_tag ltx_tag_equation">(2.1)</span>
      </td></tr></table>
      <p>where the normalisation is fixed by...</p>`;
    await ok('extractSections pairs equations with their numbers', async () => {
        const s = paperSearch.extractSections(html);
        assert.ok(s.equations.length >= 1);
        assert.ok(Array.isArray(s.equationsTagged));
        assert.strictEqual(s.equationsTagged[0].eqNumber, '2.1');
        assert.ok(/Q\^\{\+\}/.test(s.equationsTagged[0].latex));
    });
    await ok('_parseJudge keeps eqNumber, drops "null"', async () => {
        const j = literature._internals._parseJudge(JSON.stringify({
            relevant: true, reason: 'on topic',
            key_relations: [
                { statement: 'QQ', latex: 'Q^+Q^-=f', eqNumber: '2.1' },
                { statement: 'other', latex: 'T=..', eqNumber: 'null' },
            ],
            observations: [],
        }));
        assert.strictEqual(j.key_relations[0].eqNumber, '2.1');
        assert.strictEqual(j.key_relations[1].eqNumber, undefined);
    });
}

// ── I10: lit_read ─────────────────────────────────────────────────────────────

async function runI10() {
    console.log('\n── I10: lit_read whitelist, cache, cap ──');
    const workDir = await createWorkDir(tmpDir());
    await workDir.addLiteratureBrief({
        question: 'QQ system for su(3)',
        papers: [{ arxivId: '1608.06504', title: 'QQ paper', ref: 'arXiv:1608.06504' }],
    });
    let fetches = 0;
    const paperTools = {
        fetchPaperHtml: async () => {
            fetches++;
            return { html: '<h2>QQ</h2><span class="ltx_tag ltx_tag_equation">(3.12)</span><math alttext="Q(u+i)Q(u-i)=W"></math><p>normalisation convention: monic polynomials in u with unit leading coefficient and roots at Bethe roots</p>', source: 'ar5iv', hasFullText: true };
        },
        extractSections: paperSearch.extractSections,
    };
    const llm = async () => JSON.stringify({
        answer: 'The QQ relation is Q(u+i)Q(u-i)=W with monic normalisation.',
        equations: [{ latex: 'Q(u+i)Q(u-i)=W', eqNumber: '3.12', context: 'the QQ relation' }],
        excerpts: [{ text: 'normalisation convention: monic polynomials' }],
    });
    const ctx = { workDir, paperTools, literatureLlm: llm };

    await ok('reads a surfaced paper: answer + numbered equation', async () => {
        const r = await tools.handleLitRead({ arxivId: '1608.06504', question: 'what normalisation does the QQ relation use?' }, ctx);
        assert.strictEqual(r.ok, true);
        const p = JSON.parse(r.modelPayload);
        assert.ok(/monic/.test(p.answer));
        assert.strictEqual(p.equations[0].eqNumber, '3.12');
        assert.ok(/UNVERIFIED/.test(p.reminder));
    });
    await ok('second read hits the cache (no refetch)', async () => {
        const before = fetches;
        const r = await tools.handleLitRead({ arxivId: '1608.06504', question: 'give the full form of eq 3.12' }, ctx);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(fetches, before);
    });
    await ok('un-surfaced paper: 2 direct reads allowed (R7 — user/known refs), then rejected', async () => {
        // R7 relaxed the strict whitelist: up to 2 ids from OUTSIDE the search
        // results (ask_specialist answers, model-known canonical papers).
        const r1 = await tools.handleLitRead({ arxivId: '9999.00001', question: 'what does this paper say?' }, ctx);
        assert.strictEqual(r1.ok, true);
        assert.strictEqual(JSON.parse(r1.modelPayload).direct, true, 'flagged as a direct read');
        const r2 = await tools.handleLitRead({ arxivId: '9999.00002', question: 'what does this paper say?' }, ctx);
        assert.strictEqual(r2.ok, true);
        const r3 = await tools.handleLitRead({ arxivId: '9999.00003', question: 'what does this paper say?' }, ctx);
        assert.strictEqual(r3.ok, false);
        assert.strictEqual(r3.kind, 'not_surfaced');
    });
    await ok('per-run cap enforced', async () => {
        for (let i = 0; i < 4; i++) await workDir.addLitRead({ arxivId: '1608.06504', question: 'q' + i });
        const r = await tools.handleLitRead({ arxivId: '1608.06504', question: 'one question too many here' }, ctx);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.kind, 'budget_spent');
    });
}

// ── O1: provider enablement ───────────────────────────────────────────────────

async function runO1() {
    console.log('\n── O1: anthropic/openai providerConfigured via env keys ──');
    await ok('anthropic configured iff key present', async () => {
        const prev = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        assert.strictEqual(roles.providerConfigured('anthropic'), false);
        process.env.ANTHROPIC_API_KEY = 'sk-test';
        assert.strictEqual(roles.providerConfigured('anthropic'), true);
        if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    });
    await ok('unknown provider still rejected', async () => {
        assert.strictEqual(roles.providerConfigured('gemini'), false);
    });
}

// ── O7: revise_plan ───────────────────────────────────────────────────────────

async function runO7() {
    console.log('\n── O7: revise_plan bounds ──');
    const workDir = await createWorkDir(tmpDir());
    const ctx = { workDir };
    const steps = ['build H', 'diagonalise H', 'cross-check'];

    await ok('rejected before any plan exists', async () => {
        const r = await tools.handleRevisePlan({ changes: 'p014 showed the method diverges badly', steps }, ctx);
        assert.strictEqual(r.kind, 'no_plan');
    });
    await ok('two revisions allowed, third rejected', async () => {
        await tools.handlePlan({ steps }, ctx);
        const r1 = await tools.handleRevisePlan({ changes: 'p014 showed the nested-BAE route diverges', steps }, ctx);
        assert.strictEqual(JSON.parse(r1.modelPayload).revision, 1);
        const r2 = await tools.handleRevisePlan({ changes: 'p020 showed the QQ route needs a different seed', steps }, ctx);
        assert.strictEqual(JSON.parse(r2.modelPayload).revision, 2);
        const r3 = await tools.handleRevisePlan({ changes: 'p025 suggests yet another route to try', steps }, ctx);
        assert.strictEqual(r3.kind, 'revision_cap');
    });
    await ok('vague justification rejected', async () => {
        const r = await tools.handleRevisePlan({ changes: 'new plan', steps }, ctx);
        assert.strictEqual(r.kind, 'bad_args');
    });
}

// ── O8: inspect from stored value ────────────────────────────────────────────

async function runO8() {
    console.log('\n── O8: inspect applies ops to the stored value ──');
    await ok('stored-value path used (no re-evaluation of probe code)', async () => {
        const calls = [];
        const ctx = {
            workDir: { getProbe: async () => ({ ok: true, value: '{1, 2, 3}', code: 'ExpensiveComputation[]' }) },
            shim: { evalOnce: async ({ expression }) => { calls.push(expression); return { ok: true, value: '3' }; } },
        };
        const r = await tools.handleInspect({ resultRef: 'p001', op: 'Length' }, ctx);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(calls.length, 1);
        assert.ok(/ToExpression/.test(calls[0]), 'expected stored-value path');
        assert.ok(!/ExpensiveComputation/.test(calls[0]), 'must not re-run the probe code');
        assert.strictEqual(JSON.parse(r.modelPayload).preview, '3');
    });
    await ok('falls back to re-evaluation when round-trip fails', async () => {
        const calls = [];
        const ctx = {
            workDir: { getProbe: async () => ({ ok: true, value: 'some \\frac{a}{b} latex', code: 'Cheap[]' }) },
            shim: { evalOnce: async ({ expression }) => { calls.push(expression); return { ok: true, value: 'done' }; } },
        };
        const r = await tools.handleInspect({ resultRef: 'p001', op: 'Head' }, ctx);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(calls.length, 1);           // LaTeX heuristic skips the fast path
        assert.ok(/Cheap\[\]/.test(calls[0]), 'expected re-evaluation of the probe code');
        assert.ok(/TimeConstrained\[\(Cheap\[\]\), 60/.test(calls[0]), 'expected the raised 60s bound');
    });
    await ok('sentinel from kernel routes to re-evaluation', async () => {
        const calls = [];
        const ctx = {
            workDir: { getProbe: async () => ({ ok: true, value: '{1, 2}', code: 'Cheap2[]' }) },
            shim: { evalOnce: async ({ expression }) => {
                calls.push(expression);
                return calls.length === 1 ? { ok: true, value: 'WB_INSPECT_REEVAL' } : { ok: true, value: 'List' };
            } },
        };
        const r = await tools.handleInspect({ resultRef: 'p001', op: 'Head' }, ctx);
        assert.strictEqual(calls.length, 2);
        assert.ok(/Cheap2/.test(calls[1]));
        assert.strictEqual(JSON.parse(r.modelPayload).preview, 'List');
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    await runI1();
    await runI23();
    await runI45();
    await runI7();
    await runI8();
    await runI9();
    await runI10();
    await runO1();
    await runO7();
    await runO8();
    console.log(`\n── Run-2 fixes: ${passCount} passed, ${failCount} failed ──`);
    process.exit(failCount ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
