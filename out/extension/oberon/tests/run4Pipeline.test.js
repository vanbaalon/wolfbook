'use strict';
/**
 * Round 4 — pipeline improvements (audit leftovers O2/O6/O11 + cleanups):
 *
 *  O2  — clarifyQuestGate: interactive re-plan path, headless declare mode,
 *        prose assumptions never entering $Assumptions; applyDeclaredAssumptions;
 *        quest schema accepts missingInfo; charm schema accepts assumptions.
 *  O6  — handoff plumbing: buildExploreUserMessage handoff section.
 *  O11 — run-cap maths (reserve + continuation bonus) exercised via a stub loop.
 *  Cleanup — promptAssembly no longer exports buildFairyPrompt.
 *
 * Run: node out/extension/oberon/tests/run4Pipeline.test.js
 */

const assert = require('assert');
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
            workspaceFolders: [],
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

const { clarifyQuestGate, applyDeclaredAssumptions } = require('../core/research');
const { validateQuest, validateCharm } = require('../core/schemas');
const prompts = require('../fairy/prompts');

const fakeBus = { appendEvent: async () => {} };

function mkQuest(over = {}) {
    return {
        id: 'Q01', shortName: 'test_quest', title: 'T',
        objective: 'CLARIFICATION NEEDED: find the spectrum of an SU(3) chain',
        successCriteria: ['spectrum computed'], risks: [],
        missingInfo: ['chain length L (default: 4)', 'boundary conditions (default: periodic)'],
        ...over,
    };
}

// ── O2: schemas ───────────────────────────────────────────────────────────────

async function runSchemas() {
    console.log('\n── O2: schema extensions ──');
    await ok('validateQuest passes missingInfo through', async () => {
        const v = validateQuest(mkQuest());
        assert.strictEqual(v.ok, true, (v.errors || []).join('; '));
        assert.deepStrictEqual(v.value.missingInfo, mkQuest().missingInfo);
    });
    await ok('validateQuest rejects oversized missingInfo', async () => {
        const v = validateQuest(mkQuest({ missingInfo: Array(9).fill('x'.repeat(10)) }));
        assert.strictEqual(v.ok, false);
    });
    await ok('validateCharm passes assumptions through', async () => {
        const v = validateCharm({
            id: 'C01', questId: 'Q01', title: 'T', task: 'do it',
            assumptions: [{ id: 'assumed_1', statement: 'ASSUMED: L (default: 4)', prose: true }],
        });
        assert.strictEqual(v.ok, true, (v.errors || []).join('; '));
        assert.strictEqual(v.value.assumptions.length, 1);
        assert.strictEqual(v.value.assumptions[0].prose, true);
    });
}

// ── O2: clarify gate ──────────────────────────────────────────────────────────

async function runClarify() {
    console.log('\n── O2: clarifyQuestGate ──');

    await ok('fully-specified quest passes untouched', async () => {
        const q = mkQuest({ objective: 'Find the spectrum for L=4 PBC', missingInfo: [] });
        const g = await clarifyQuestGate({ quest: q, questFileRef: { path: 'x' }, brief: 'b', bus: fakeBus });
        assert.strictEqual(g.quest, q);
        assert.strictEqual(g.declaredAssumptions.length, 0);
    });
    await ok('headless: defaults become prose assumptions', async () => {
        const g = await clarifyQuestGate({ quest: mkQuest(), questFileRef: {}, brief: 'b', bus: fakeBus });
        assert.strictEqual(g.declaredAssumptions.length, 2);
        assert.ok(g.declaredAssumptions[0].statement.startsWith('ASSUMED: chain length L'));
        assert.strictEqual(g.declaredAssumptions[0].prose, true);
    });
    await ok('dismissed dialog (empty answer) → declare mode', async () => {
        const g = await clarifyQuestGate({
            quest: mkQuest(), questFileRef: {}, brief: 'b', bus: fakeBus,
            askClarify: async () => '',
        });
        assert.strictEqual(g.declaredAssumptions.length, 2);
    });
    await ok('askClarify throwing is tolerated (declare mode)', async () => {
        const g = await clarifyQuestGate({
            quest: mkQuest(), questFileRef: {}, brief: 'b', bus: fakeBus,
            askClarify: async () => { throw new Error('ui gone'); },
        });
        assert.strictEqual(g.declaredAssumptions.length, 2);
    });
    await ok('applyDeclaredAssumptions: banner + array on every charm, task capped', async () => {
        const charms = [{ id: 'C01', task: 'solve it', title: 'T' }, { id: 'C02', task: 'verify it', title: 'T2' }];
        const declared = [{ id: 'assumed_1', statement: 'ASSUMED: L (default: 4)', prose: true }];
        const out = applyDeclaredAssumptions(charms, declared);
        assert.strictEqual(out.length, 2);
        for (const c of out) {
            assert.ok(c.task.startsWith('ASSUMED PARAMETERS'));
            assert.ok(c.task.includes('ASSUMED: L (default: 4)'));
            assert.strictEqual(c.assumptions, declared);
            assert.ok(c.task.length <= 8000);
        }
        // no-op without declared assumptions
        assert.strictEqual(applyDeclaredAssumptions(charms, [])[0].task, 'solve it');
    });
}

// ── O6: handoff section in the explore message ────────────────────────────────

async function runHandoff() {
    console.log('\n── O6: handoff section ──');
    const base = {
        taskDescription: 'Diagonalise H.', inputs: [], assumptions: [],
        budget: { exploreProbesRemaining: 30, backtracksRemaining: 3, turnsRemaining: 70 },
        charmId: 'C02', kernelFresh: true, inputsLoaded: 0,
    };
    await ok('utils + facts listed with build-on instruction', async () => {
        const msg = prompts.buildExploreUserMessage({
            ...base,
            handoff: { utils: ['buildHamiltonian', 'pauliOps'], facts: ['spectrum_L4'] },
        });
        assert.ok(msg.includes('## Results from completed sub-tasks'));
        assert.ok(msg.includes('buildHamiltonian, pauliOps'));
        assert.ok(msg.includes('spectrum_L4'));
        assert.ok(/do NOT redefine/.test(msg));
    });
    await ok('section absent without handoff', async () => {
        assert.ok(!prompts.buildExploreUserMessage(base).includes('completed sub-tasks'));
        assert.ok(!prompts.buildExploreUserMessage({ ...base, handoff: { utils: [], facts: [] } }).includes('completed sub-tasks'));
    });
}

// ── O11: run-cap maths (mirrors the fairy-loop guard) ─────────────────────────

async function runCaps() {
    console.log('\n── O11: run-cap maths ──');
    // Re-implementation of the guard for unit-checking the boundary conditions.
    const overRunCap = (M, runCaps) => {
        const bonus   = M.runCapBonus || 0;
        const callCap = Number(runCaps.runLlmCalls) > 0 ? Number(runCaps.runLlmCalls) + bonus : 0;
        const usdCap  = Number(runCaps.runUSD) > 0 ? Number(runCaps.runUSD) * (1 + bonus / 60) : 0;
        if (callCap > 0 && (M.llmCalls || 0) >= Math.max(4, callCap - 8)) return 'run_llm_calls';
        if (usdCap  > 0 && (M.costUSD  || 0) >= usdCap)                   return 'run_usd';
        return null;
    };
    await ok('call cap fires with the 8-call partial-report reserve', async () => {
        assert.strictEqual(overRunCap({ llmCalls: 51 }, { runLlmCalls: 60, runUSD: 0 }), null);
        assert.strictEqual(overRunCap({ llmCalls: 52 }, { runLlmCalls: 60, runUSD: 0 }), 'run_llm_calls');
    });
    await ok('usd cap fires at the limit', async () => {
        assert.strictEqual(overRunCap({ costUSD: 4.99 }, { runLlmCalls: 0, runUSD: 5 }), null);
        assert.strictEqual(overRunCap({ costUSD: 5.0  }, { runLlmCalls: 0, runUSD: 5 }), 'run_usd');
    });
    await ok('0 means no enforcement', async () => {
        assert.strictEqual(overRunCap({ llmCalls: 9999, costUSD: 9999 }, { runLlmCalls: 0, runUSD: 0 }), null);
    });
    await ok('continuation bonus raises both caps', async () => {
        const M = { llmCalls: 52, runCapBonus: 25 };
        assert.strictEqual(overRunCap(M, { runLlmCalls: 60, runUSD: 0 }), null);
        M.llmCalls = 77;
        assert.strictEqual(overRunCap(M, { runLlmCalls: 60, runUSD: 0 }), 'run_llm_calls');
    });
}

// ── Cleanup: buildFairyPrompt removed ─────────────────────────────────────────

async function runCleanup() {
    console.log('\n── Cleanup: dead code removed ──');
    await ok('promptAssembly exports only buildPlannerPrompt + sha256', async () => {
        const pa = require('../core/promptAssembly');
        assert.strictEqual(typeof pa.buildPlannerPrompt, 'function');
        assert.strictEqual(typeof pa.sha256, 'function');
        assert.strictEqual(pa.buildFairyPrompt, undefined);
    });
    await ok('planner prompt schema mentions missingInfo (rule 4)', async () => {
        const { buildPlannerSystemPrompt } = require('../agents/oberonPlanner.prompt');
        const p = buildPlannerSystemPrompt();
        assert.ok(p.includes('"missingInfo"'));
        assert.ok(/default: <sensible default>/.test(p));
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
    await runSchemas();
    await runClarify();
    await runHandoff();
    await runCaps();
    await runCleanup();
    console.log(`\n── Round-4 pipeline: ${passCount} passed, ${failCount} failed ──`);
    process.exit(failCount ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
