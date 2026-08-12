'use strict';
/**
 * Audit fixes (FAIRY_RESEARCH_AUDIT_2026-07-01 / F1–F3):
 *
 *  F1 (B2) — buildEvidenceFromSteps shape (tool 'wolfram_eval', cap, skip-failed,
 *            agentValue preferred), validationChecks rendered in the explore message.
 *  F2 (B4) — reopen_chain documented in the polish entry message; partial-report
 *            message carries the polish-failure contextNote.
 *  F3 (B7) — record persists role:'crosscheck'; literal lint warns on mostly-numeric
 *            recorded steps; prompt rule 24 present; record spec exposes `role`.
 *
 * Run: node out/extension/oberon/tests/auditFixes.test.js
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
        workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
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
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'auditfx-')); }

const tools        = require('../fairy/tools');
const prompts      = require('../fairy/prompts');
const { _internals } = require('../core/fairy');
const { createWorkDir } = require('../fairy/workDir');
const { FAIRY_TOOL_SPECS } = require('../fairy/toolSpecs');

// ── F1: buildEvidenceFromSteps ────────────────────────────────────────────────

async function runEvidence() {
    console.log('\n── F1 (B2): buildEvidenceFromSteps ──');
    const { buildEvidenceFromSteps } = _internals;

    const probes = {
        p1: { ok: true,  agentValue: '{1, 2, 3}', value: '\\{1,2,3\\}' },
        p2: { ok: true,  value: 'True' },                       // no agentValue → falls back
        p3: { ok: false, value: 'boom' },                        // failed probe → skipped
        p4: { ok: true,  value: '' },                            // valueless → skipped
    };
    const getProbe = async (id) => probes[id] || null;
    const step = (id, probeId) => ({ id, probeId, code: `${id} = f[${probeId}]` });

    await ok('shape: tool wolfram_eval + stepId + expression + output', async () => {
        const ev = await buildEvidenceFromSteps([step('s1', 'p1')], getProbe);
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].tool, 'wolfram_eval');   // Skeptic skips any other tool name
        assert.strictEqual(ev[0].stepId, 's1');
        assert.strictEqual(ev[0].expression, 's1 = f[p1]');
        assert.strictEqual(ev[0].ok, true);
    });
    await ok('agentValue (InputForm) preferred over human value', async () => {
        const ev = await buildEvidenceFromSteps([step('s1', 'p1')], getProbe);
        assert.strictEqual(ev[0].output, '{1, 2, 3}');
    });
    await ok('falls back to probe.value when agentValue absent', async () => {
        const ev = await buildEvidenceFromSteps([step('s2', 'p2')], getProbe);
        assert.strictEqual(ev[0].output, 'True');
    });
    await ok('failed and valueless probes are skipped', async () => {
        const ev = await buildEvidenceFromSteps(
            [step('s1', 'p1'), step('s3', 'p3'), step('s4', 'p4')], getProbe);
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].stepId, 's1');
    });
    await ok('caps at maxItems, keeping the MOST RECENT steps', async () => {
        const steps = Array.from({ length: 20 }, (_, i) => step(`s${i}`, 'p1'));
        const ev = await buildEvidenceFromSteps(steps, getProbe, 12);
        assert.strictEqual(ev.length, 12);
        assert.strictEqual(ev[0].stepId, 's8');            // 20-12=8 → first kept
        assert.strictEqual(ev[11].stepId, 's19');          // last step always present
    });
    await ok('output capped at 2000 chars', async () => {
        const gp = async () => ({ ok: true, agentValue: 'x'.repeat(5000) });
        const ev = await buildEvidenceFromSteps([step('s1', 'p1')], gp);
        assert.strictEqual(ev[0].output.length, 2000);
    });
    await ok('getProbe throwing is tolerated (step skipped)', async () => {
        const gp = async () => { throw new Error('disk'); };
        const ev = await buildEvidenceFromSteps([step('s1', 'p1')], gp);
        assert.strictEqual(ev.length, 0);
    });

    await ok('immutable step snapshot wins after mutable probe slot changes', async () => {
        const stepWithSnapshot = {
            id: 'snap', probeId: 'p1', code: 'x=1',
            evidenceSnapshot: { ok: true, code: 'x=1', output: '1', sha256: 'abc' },
        };
        const ev = await buildEvidenceFromSteps([stepWithSnapshot], async () => ({
            ok: true, code: 'x=999', value: '999', agentValue: '999',
        }));
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].expression, 'x=1');
        assert.strictEqual(ev[0].output, '1');
        assert.strictEqual(ev[0].evidenceSha256, 'abc');
    });
}

// ── F1: validationChecks in the explore message ──────────────────────────────

async function runExploreMessage() {
    console.log('\n── F1 (B2): validationChecks in buildExploreUserMessage ──');
    const base = {
        taskDescription: 'Compute the spectrum.',
        inputs: [], assumptions: [],
        budget: { exploreProbesRemaining: 30, backtracksRemaining: 3, turnsRemaining: 70 },
        charmId: 'C01', kernelFresh: true, inputsLoaded: 0,
    };

    await ok('checks rendered with vcN labels + symbol-name instruction', async () => {
        const msg = prompts.buildExploreUserMessage({
            ...base,
            validationChecks: ['Abs[Tr[H]] < 1*^-8', 'HermitianMatrixQ[H]'],
        });
        assert.ok(msg.includes('## Validation checks'));
        assert.ok(msg.includes('vc1: Abs[Tr[H]] < 1*^-8'));
        assert.ok(msg.includes('vc2: HermitianMatrixQ[H]'));
        assert.ok(/SAME symbol names/.test(msg));
    });
    await ok('section absent when no checks', async () => {
        const msg = prompts.buildExploreUserMessage({ ...base, validationChecks: [] });
        assert.ok(!msg.includes('## Validation checks'));
        const msg2 = prompts.buildExploreUserMessage(base);
        assert.ok(!msg2.includes('## Validation checks'));
    });
}

// ── F2: polish entry + partial report messages ────────────────────────────────

async function runPolishMessages() {
    console.log('\n── F2 (B4): reopen_chain + partial-report contextNote ──');

    await ok('polish entry documents reopen_chain (once, chain-level only)', async () => {
        const msg = prompts.buildPolishEntryMessage({
            cleanNbPath: '/tmp/clean.wb', runCleansRemaining: 6, polishTurnsRemaining: 12,
        });
        assert.ok(msg.includes('"control": "reopen_chain"'));
        assert.ok(/ONCE per run/.test(msg));
        assert.ok(/edit_cell/.test(msg));
    });
    await ok('partial report: contextNote swaps the opening + warns against claiming verification', async () => {
        const msg = prompts.buildPartialReportUserMessage({
            stepsRecorded: 7, probesUsed: 21, partialReportTurnsRemaining: 6,
            contextNote: 'Polish could not fully verify clean.wb: Dot::rect in cell 3.',
        });
        assert.ok(msg.includes('Run Could Not Complete'));
        assert.ok(msg.includes('Dot::rect in cell 3'));
        assert.ok(/Do NOT claim full verification/.test(msg));
        assert.ok(!msg.includes('Probe Budget Exhausted'));
    });
    await ok('partial report: default opening unchanged without contextNote', async () => {
        const msg = prompts.buildPartialReportUserMessage({
            stepsRecorded: 2, probesUsed: 40, partialReportTurnsRemaining: 6,
        });
        assert.ok(msg.includes('Probe Budget Exhausted'));
        assert.ok(msg.includes('You have used all 40 probe(s)'));
    });
}

// ── F3: record role + literal lint + prompt rule 24 + spec ──────────────────

async function runCrosscheck() {
    console.log('\n── F3 (B7): record role, literal lint, rule 24, spec ──');

    await ok('literalFraction: mostly-numeric code detected', async () => {
        const { literalFraction } = tools;
        const lf = literalFraction('spec = {-2.0, -1.5, -1.5, 0.5, 0.5, 0.5, 1.0, 1.0, 2.0}');
        assert.ok(lf.fraction >= 0.6, `fraction ${lf.fraction}`);
        assert.ok(lf.numeric >= 8);
    });
    await ok('literalFraction: computation code is below threshold', async () => {
        const { literalFraction } = tools;
        const lf = literalFraction('eigs = Sort[Eigenvalues[N[Hmat]]]; {Min[eigs], Max[eigs]}');
        assert.ok(lf.fraction < 0.6);
    });
    await ok('literalFraction: comments stripped', async () => {
        const { literalFraction } = tools;
        const lf = literalFraction('(* 1 2 3 4 5 6 7 8 9 10 *) x = Eigenvalues[m]');
        assert.strictEqual(lf.numeric, 0);
    });

    // record: role persistence + literal-lint warning, via a real workDir.
    const dir = tmpDir();
    const workDir = await createWorkDir(dir);
    const shim = { evalOnce: async () => ({ ok: true, value: 'True' }), DEFAULT_TIMEOUT: 30 };
    const ctx = { workDir, shim, fsm: null };

    await ok('record persists role: crosscheck', async () => {
        await workDir.saveProbe('p001', { code: 'check = Norm[H - ConjugateTranspose[H]] < 1*^-10', ok: true, value: 'True' });
        const r = await tools.handleRecord({ stepId: 'xcheck_hermitian', probeId: 'p001', role: 'crosscheck' }, ctx);
        assert.strictEqual(r.ok, true);
        const steps = await workDir.loadValidSteps();
        assert.strictEqual(steps.find(s => s.id === 'xcheck_hermitian').role, 'crosscheck');
    });
    await ok('record without role stores no role field', async () => {
        await workDir.saveProbe('p002', { code: 'eigs2 = Eigenvalues[N[m]]', ok: true, value: '{1., 2.}' });
        const r = await tools.handleRecord({ stepId: 'step_eigs', probeId: 'p002' }, ctx);
        assert.strictEqual(r.ok, true);
        const steps = await workDir.loadValidSteps();
        assert.strictEqual(steps.find(s => s.id === 'step_eigs').role, undefined);
    });
    await ok('record warns on hand-typed numeric literals (rule 20 lint)', async () => {
        await workDir.saveProbe('p003', {
            code: 'fullSpec = {-2.0, -1.5, -1.5, -1.5, 0.5, 0.5, 0.5, 1.0, 1.0, 1.0, 2.0, 2.5}',
            ok: true, value: '{...}',
        });
        const r = await tools.handleRecord({ stepId: 'step_literal', probeId: 'p003' }, ctx);
        assert.strictEqual(r.ok, true);   // warn, never reject
        const payload = JSON.parse(r.modelPayload);
        assert.ok((payload.warnings || []).some(w => /numeric literals/.test(w)), 'expected literal-lint warning');
    });
    await ok('record does NOT warn on computation code', async () => {
        await workDir.saveProbe('p004', { code: 'traceCheck = Abs[Tr[Hmat]] < 1*^-8', ok: true, value: 'True' });
        const r = await tools.handleRecord({ stepId: 'step_compute', probeId: 'p004' }, ctx);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(!(payload.warnings || []).some(w => /numeric literals/.test(w)));
    });

    await ok('prompt rule 24 (crosscheck) present in FAIRY_SYSTEM_PROMPT', async () => {
        assert.ok(prompts.FAIRY_SYSTEM_PROMPT.includes('role: "crosscheck"'));
        assert.ok(/24\.\s+\*\*Record ONE cross-check step/.test(prompts.FAIRY_SYSTEM_PROMPT));
    });
    await ok('record tool spec exposes role enum', async () => {
        const rec = FAIRY_TOOL_SPECS.find(t => t.function.name === 'record');
        const role = rec.function.parameters.properties.role;
        assert.ok(role, 'role property missing from record spec');
        assert.deepStrictEqual(role.enum, ['step', 'crosscheck']);
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    await runEvidence();
    await runExploreMessage();
    await runPolishMessages();
    await runCrosscheck();
    console.log(`\n── Audit-fix Results: ${passCount} passed, ${failCount} failed ──`);
    process.exit(failCount ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
