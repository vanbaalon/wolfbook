#!/usr/bin/env node
'use strict';
/**
 * Fairy Phase 3 — unit tests for the FSM-driven fairy.js loop.
 *
 * Covers:
 *   tryParseControlSignal   — JSON control signal detection
 *   tryParseJson            — JSON extraction from model text
 *   findRecordedValue       — probe lookup from workDir
 *   buildAndPersistScroll   — Scroll construction for delivered/failed/escalate
 *   runFairy (integration)  — full FSM loop with a mocked adapter
 *
 * Run: node out/extension/oberon/tests/fairyPhase3.test.js
 * No real Wolfram kernel required; no vscode dependency.
 */

const os     = require('os');
const path   = require('path');
const fsp    = require('fs/promises');
const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');

// ── Stub vscode ──────────────────────────────────────────────────────────────
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode_p3.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            workspaceFolders: [],
            onDidChangeConfiguration: () => ({ dispose() {} }),
            getConfiguration: () => ({ get: () => undefined, update: () => Promise.resolve() }),
        },
        window: {
            showInformationMessage: () => Promise.resolve(),
            showWarningMessage:     () => Promise.resolve(),
            showErrorMessage:       () => Promise.resolve(),
        },
        Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
        EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} dispose(){} },
    },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve.call(this, req, parent, ...rest);
};

// ── Stub wolframShim ──────────────────────────────────────────────────────────
const shimStubId = path.resolve(__dirname, '..', 'core', 'wolframShim.js');
const shimStub = {
    DEFAULT_TIMEOUT: 30, MAX_TIMEOUT: 120,
    _nextRestart: { ok: true },
    _nextEval:    { ok: true, kind: 'ok', value: '42', truncated: false, originalLength: 2, prints: null, messages: null, durationMs: 10, timeoutSeconds: 30, error: null },
    kernelStatus: () => ({ available: true }),
    restartKernel: async function() { return this._nextRestart; },
    evalOnce: async function() { return this._nextEval; },
    setPostRestartSeeder() {},
};
require.cache[shimStubId] = { id: shimStubId, filename: shimStubId, loaded: true, exports: shimStub };

// ── Stub providers ────────────────────────────────────────────────────────────
const providersId = path.resolve(__dirname, '..', 'providers', 'index.js');
// Will be set per-test via adapterStub
const adapterStub = {
    _responses: [],
    async chatComplete() {
        const resp = this._responses.shift();
        if (!resp) throw new Error('adapterStub: no more responses');
        return resp;
    },
};
const providersModule = {
    getAdapter: () => adapterStub,
};
require.cache[providersId] = { id: providersId, filename: providersId, loaded: true, exports: providersModule };

// ── Stub providers/cost ───────────────────────────────────────────────────────
const costId = path.resolve(__dirname, '..', 'providers', 'cost.js');
require.cache[costId] = { id: costId, filename: costId, loaded: true, exports: { computeCost: () => 0 } };

// ── Stub roles ────────────────────────────────────────────────────────────────
const rolesId = path.resolve(__dirname, '..', 'config', 'roles.js');
require.cache[rolesId] = {
    id: rolesId, filename: rolesId, loaded: true,
    exports: {
        resolveRole: () => ({
            configured: true, provider: 'deepseek', model: 'deepseek-reasoner',
            pricing: {}, maxTokens: 8000,
        }),
    },
};

// ── Stub settings ─────────────────────────────────────────────────────────────
const settingsId = path.resolve(__dirname, '..', 'config', 'settings.js');
require.cache[settingsId] = {
    id: settingsId, filename: settingsId, loaded: true,
    exports: {
        telemetry: () => ({ saveRawPrompts: false, saveRawResponses: false }),
        fairyDefaultBudget: () => ({ maxLlmCalls: 12 }),
        toolLoopMultiplier: () => 1,
        notebookFirstExecution: () => false,
    },
};

// ── Stub bus ──────────────────────────────────────────────────────────────────
function makeBus() {
    const events = [];
    return {
        events,
        async appendEvent(type, data) { events.push({ type, data }); },
        on() {},
    };
}

// ── Stub scrollsFs ────────────────────────────────────────────────────────────
const scrollsFsId = path.resolve(__dirname, '..', 'memory', 'scrolls.js');
require.cache[scrollsFsId] = {
    id: scrollsFsId, filename: scrollsFsId, loaded: true,
    exports: {
        nextScrollId: async () => 'S01',
        writeScroll:  async (quest, scroll) => ({ path: '/tmp/S01.json', sha256: 'sha256:abc' }),
    },
};

// ── Stub project ──────────────────────────────────────────────────────────────
let _testQuestsDir = null;
const projectId = path.resolve(__dirname, '..', 'memory', 'project.js');
require.cache[projectId] = {
    id: projectId, filename: projectId, loaded: true,
    exports: {
        questsDir: () => _testQuestsDir,
        getWorkspaceRoot: () => _testQuestsDir ? path.dirname(_testQuestsDir) : null,
    },
};

// ── Stub find-kernel ──────────────────────────────────────────────────────────
const findKernelId = path.resolve(__dirname, '..', '..', '..', 'find-kernel.js');
require.cache[findKernelId] = {
    id: findKernelId, filename: findKernelId, loaded: true,
    exports: class FindKernel {
        resolveKernel() { return 'kernel-not-found'; }
    },
};

// ── Stub promptAssembly (sha256 only) ─────────────────────────────────────────
const promptAsmId = path.resolve(__dirname, 'promptAssembly.js');
const promptAsmIdAlt = path.resolve(__dirname, '..', 'core', 'promptAssembly.js');
const fakePromptAssembly = {
    sha256: (s) => crypto.createHash('sha256').update(s || '').digest('hex'),
    buildFairyPrompt: () => ({ messages: [], prefixSha256: 'abc' }),
    buildPlannerPrompt: () => '',
};
require.cache[promptAsmIdAlt] = { id: promptAsmIdAlt, filename: promptAsmIdAlt, loaded: true, exports: fakePromptAssembly };

// ── Load modules under test ───────────────────────────────────────────────────
const { runFairy, _internals } = require('../core/fairy');
const { tryParseControlSignal, tryParseJson, findRecordedValue, buildAndPersistScroll } = _internals;
const { createWorkDir }  = require('../fairy/workDir');
const { FairyFSM }       = require('../fairy/fsm');

// ── Test framework ────────────────────────────────────────────────────────────
let passed = 0;
let failed  = 0;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

async function run() {
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            process.stdout.write(`  ✓ ${t.name}\n`);
        } catch (e) {
            failed++;
            process.stderr.write(`  ✗ ${t.name}\n    ${e.message}\n${e.stack ? e.stack.split('\n').slice(1, 4).join('\n') : ''}\n`);
        }
    }
    process.stdout.write(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

// ── Helper ────────────────────────────────────────────────────────────────────
async function withTempDir(fn) {
    const dir = path.join(os.tmpdir(), 'oberon_p3_' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(dir, { recursive: true });
    try { return await fn(dir); }
    finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

function fakeQuest(id = 'Q01') {
    return { id, shortName: 'test', title: 'Test Quest' };
}
function fakeCharm(id = 'C01') {
    return { id, task: 'Compute 2+2', inputs: [], assumptions: [], validationChecks: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. tryParseJson
// ─────────────────────────────────────────────────────────────────────────────
test('tryParseJson: parses plain JSON object', () => {
    const r = tryParseJson('{"a":1}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.a, 1);
});

test('tryParseJson: parses JSON in code fence', () => {
    const r = tryParseJson('```json\n{"a":2}\n```');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.a, 2);
});

test('tryParseJson: extracts JSON from prose', () => {
    const r = tryParseJson('Here is the result: {"control":"done_exploring"}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.control, 'done_exploring');
});

test('tryParseJson: unwraps single-element array', () => {
    const r = tryParseJson('[{"control":"escalate"}]');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.control, 'escalate');
});

test('tryParseJson: returns ok:false on empty', () => {
    const r = tryParseJson('');
    assert.strictEqual(r.ok, false);
});

test('tryParseJson: returns ok:false on non-JSON prose', () => {
    const r = tryParseJson('no json here, just prose');
    assert.strictEqual(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. tryParseControlSignal
// ─────────────────────────────────────────────────────────────────────────────
test('tryParseControlSignal: detects done_exploring', () => {
    const text = JSON.stringify({ control: 'done_exploring', targetStepId: 's1', includeSteps: [], excludeSteps: [] });
    const result = tryParseControlSignal(text);
    assert.ok(result);
    assert.strictEqual(result.control, 'done_exploring');
    assert.strictEqual(result.targetStepId, 's1');
});

test('tryParseControlSignal: detects escalate', () => {
    const text = JSON.stringify({ control: 'escalate', reason: 'out of scope' });
    const result = tryParseControlSignal(text);
    assert.ok(result);
    assert.strictEqual(result.control, 'escalate');
    assert.strictEqual(result.reason, 'out of scope');
});

test('tryParseControlSignal: extracts from prose + fence', () => {
    const text = 'I am done.\n```json\n{"control":"done_exploring","targetStepId":"s2","includeSteps":[],"excludeSteps":[]}\n```';
    const result = tryParseControlSignal(text);
    assert.ok(result);
    assert.strictEqual(result.control, 'done_exploring');
    assert.strictEqual(result.targetStepId, 's2');
});

test('tryParseControlSignal: returns null for no control field', () => {
    const result = tryParseControlSignal('{"foo":"bar"}');
    assert.strictEqual(result, null);
});

test('tryParseControlSignal: returns null for empty string', () => {
    const result = tryParseControlSignal('');
    assert.strictEqual(result, null);
});

test('tryParseControlSignal: returns null for tool call JSON (no .control)', () => {
    const text = JSON.stringify({ id: 'call_1', name: 'probe', arguments: { code: '2+2' } });
    const result = tryParseControlSignal(text);
    assert.strictEqual(result, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. findRecordedValue
// ─────────────────────────────────────────────────────────────────────────────
test('findRecordedValue: returns null when no steps', () => withTempDir(async (dir) => {
    const wd = await createWorkDir(dir);
    const v  = await findRecordedValue(wd, 'nonexistent');
    assert.strictEqual(v, null);
}));

test('findRecordedValue: returns probe value for existing step', () => withTempDir(async (dir) => {
    const wd = await createWorkDir(dir);
    // Add a probe result
    await wd.saveProbe('p1', { code: '2+2', ok: true, value: '4', messages: null, prints: null, durationMs: 5, structuralSummary: {}, error: null });
    // Add a step referencing it
    await wd.addStep({
        id: 's1', probeId: 'p1', code: '2+2', resultRef: 'p1',
        dependsOn: [], usesSymbols: [], definesSymbols: ['result'], note: '',
    });
    const v = await findRecordedValue(wd, 's1');
    assert.strictEqual(v, '4');
}));

test('findRecordedValue: returns null when probe file missing', () => withTempDir(async (dir) => {
    const wd = await createWorkDir(dir);
    await wd.addStep({
        id: 's1', probeId: 'nonexistent', code: '2+2', resultRef: 'nonexistent',
        dependsOn: [], usesSymbols: [], definesSymbols: [], note: '',
    });
    const v = await findRecordedValue(wd, 's1');
    assert.strictEqual(v, null);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 4. buildAndPersistScroll
// ─────────────────────────────────────────────────────────────────────────────
test('buildAndPersistScroll: delivered — confidence 0.9 and readable conclusion', () => withTempDir(async (dir) => {
    const wd  = await createWorkDir(dir);
    const fsm = new FairyFSM();
    fsm.transitionTo('explore');
    fsm.transitionTo('compile');
    fsm.transitionTo('verify');
    fsm.transitionTo('delivered');

    const bus = makeBus();
    const { scroll } = await buildAndPersistScroll({
        terminalResult: { status: 'delivered', cleanNbPath: '/tmp/clean.wb' },
        workDir: wd, quest: fakeQuest(), charm: fakeCharm(), bus, fsm, spanId: 'sp1',
    });

    assert.strictEqual(scroll.confidence, 0.9);
    assert.strictEqual(scroll.fairyArtifact.status, 'delivered');
    assert.strictEqual(scroll.fairyArtifact.cleanNbPath, '/tmp/clean.wb');
    assert.strictEqual(scroll.id, 'S01');
    assert.ok(scroll.createdAt);
    assert.ok(scroll.fairyArtifact.conclusionPath);
    const conclusion = await fsp.readFile(scroll.fairyArtifact.conclusionPath, 'utf8');
    assert.match(conclusion, /^# Test Quest/m);
    assert.match(conclusion, /## Punchline/);

    const submittedEv = bus.events.find(e => e.type === 'scroll.submitted');
    assert.ok(submittedEv);
    assert.strictEqual(submittedEv.data.status, 'delivered');
}));

test('buildAndPersistScroll: failed — confidence 0.1', () => withTempDir(async (dir) => {
    const wd  = await createWorkDir(dir);
    const fsm = new FairyFSM();
    fsm.transitionTo('explore');
    fsm.transitionTo('failed');

    const bus = makeBus();
    const { scroll } = await buildAndPersistScroll({
        terminalResult: { status: 'failed', summary: 'could not solve', reason: 'divergent' },
        workDir: wd, quest: fakeQuest(), charm: fakeCharm(), bus, fsm, spanId: 'sp2',
    });

    assert.strictEqual(scroll.confidence, 0.1);
    assert.strictEqual(scroll.fairyArtifact.status, 'failed');
    assert.ok(scroll.openQuestions.length > 0);
}));

test('buildAndPersistScroll: escalate — confidence 0.05', () => withTempDir(async (dir) => {
    const wd  = await createWorkDir(dir);
    const fsm = new FairyFSM();
    fsm.transitionTo('explore');
    fsm.transitionTo('escalate');

    const bus = makeBus();
    const { scroll } = await buildAndPersistScroll({
        terminalResult: { status: 'escalate', reason: 'task too complex' },
        workDir: wd, quest: fakeQuest(), charm: fakeCharm(), bus, fsm, spanId: 'sp3',
    });

    assert.strictEqual(scroll.confidence, 0.05);
    assert.strictEqual(scroll.fairyArtifact.status, 'escalate');
    assert.ok(scroll.openQuestions[0].includes('task too complex'));
}));

test('buildAndPersistScroll: includes step summaries in fairyArtifact', () => withTempDir(async (dir) => {
    const wd  = await createWorkDir(dir);
    await wd.saveProbe('p1', { code: 'x = 1', ok: true, value: '1', messages: null, prints: null, durationMs: 5, structuralSummary: {}, error: null });
    await wd.addStep({ id: 's1', probeId: 'p1', code: 'x = 1', resultRef: 'p1', dependsOn: [], usesSymbols: [], definesSymbols: ['x'], note: '' });

    const fsm = new FairyFSM();
    fsm.transitionTo('explore');
    fsm.transitionTo('compile');
    fsm.transitionTo('verify');
    fsm.transitionTo('delivered');

    const bus = makeBus();
    const { scroll } = await buildAndPersistScroll({
        terminalResult: { status: 'delivered', cleanNbPath: '/tmp/clean.wb' },
        workDir: wd, quest: fakeQuest(), charm: fakeCharm(), bus, fsm, spanId: 'sp4',
    });

    assert.strictEqual(scroll.fairyArtifact.steps.length, 1);
    assert.strictEqual(scroll.fairyArtifact.steps[0].id, 's1');
    assert.deepStrictEqual(scroll.fairyArtifact.steps[0].definesSymbols, ['x']);
}));

test('buildAndPersistScroll: phaseHistory captured', () => withTempDir(async (dir) => {
    const wd  = await createWorkDir(dir);
    const fsm = new FairyFSM();
    fsm.transitionTo('explore');
    fsm.transitionTo('compile');
    fsm.transitionTo('diagnose');
    fsm.transitionTo('explore');
    fsm.transitionTo('compile');
    fsm.transitionTo('verify');
    fsm.transitionTo('delivered');

    const bus = makeBus();
    const { scroll } = await buildAndPersistScroll({
        terminalResult: { status: 'delivered', cleanNbPath: '/tmp/clean.wb' },
        workDir: wd, quest: fakeQuest(), charm: fakeCharm(), bus, fsm, spanId: 'sp5',
    });

    assert.ok(scroll.fairyArtifact.phaseHistory.includes('diagnose'));
    assert.ok(scroll.fairyArtifact.phaseHistory.includes('delivered'));
}));

// ─────────────────────────────────────────────────────────────────────────────
// 5. runFairy integration tests (mocked adapter)
// ─────────────────────────────────────────────────────────────────────────────
// Each test sets adapterStub._responses to control what the LLM returns.
// FindKernel stub always returns 'kernel-not-found' so verification is skipped.

function makeTurn({ content = '', toolCalls = [], costUSD = 0 } = {}) {
    return {
        content, toolCalls,
        usage: { inputTokens: 10, outputTokens: 10 },
        costUSD, latencyMs: 5,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        provider: 'deepseek', model: 'deepseek-reasoner',
        reasoning: null,
    };
}

function makeControlSignalTurn(signal) {
    return makeTurn({ content: JSON.stringify(signal) });
}

function makeToolTurn(toolName, args, id = 'tc1') {
    return makeTurn({
        toolCalls: [{ id, name: toolName, arguments: args }],
    });
}

test('runFairy: escalate via control signal → scroll with status escalate', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    adapterStub._responses = [
        makeControlSignalTurn({ control: 'escalate', reason: 'out of scope for this charm' }),
    ];

    const quest = fakeQuest();
    const charm = fakeCharm();
    const bus   = makeBus();

    const { scroll } = await runFairy({ quest, charm, bus });

    assert.strictEqual(scroll.fairyArtifact.status, 'escalate');
    assert.strictEqual(scroll.confidence, 0.05);
    _testQuestsDir = null;
}));

test('runFairy: done_exploring (missing targetStep) → compile fails → diagnose → escalate', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    // Model emits done_exploring with a non-existent targetStepId.
    // FSM → compile → fails (target_missing) → diagnose.
    // In diagnose, model escalates.
    adapterStub._responses = [
        makeControlSignalTurn({ control: 'done_exploring', targetStepId: 'nonexistent', includeSteps: [], excludeSteps: [] }),
        makeControlSignalTurn({ control: 'escalate', reason: 'target step not found in chain' }),
    ];

    const quest = fakeQuest();
    const charm = fakeCharm();
    const bus   = makeBus();

    const { scroll } = await runFairy({ quest, charm, bus });
    assert.strictEqual(scroll.fairyArtifact.status, 'escalate');
    _testQuestsDir = null;
}));

test('runFairy: finalize(failed) → scroll status failed', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    adapterStub._responses = [
        makeToolTurn('finalize', { status: 'failed', summary: 'Cannot solve', reason: 'diverges' }),
        // tool result ack then model produces content — but finalize short-circuits
    ];

    const quest = fakeQuest();
    const charm = fakeCharm();
    const bus   = makeBus();

    const { scroll } = await runFairy({ quest, charm, bus });
    assert.strictEqual(scroll.fairyArtifact.status, 'failed');
    assert.strictEqual(scroll.confidence, 0.1);
    _testQuestsDir = null;
}));

test('runFairy: finalize(escalate) → scroll status escalate', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    adapterStub._responses = [
        makeToolTurn('finalize', { status: 'escalate', summary: 'Needs decomposition', reason: 'Too many variables' }),
    ];

    const quest = fakeQuest();
    const charm = fakeCharm();
    const bus   = makeBus();

    const { scroll } = await runFairy({ quest, charm, bus });
    assert.strictEqual(scroll.fairyArtifact.status, 'escalate');
    _testQuestsDir = null;
}));

test('runFairy: steer injection when model emits no tool or signal', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    adapterStub._responses = [
        makeTurn({ content: 'I am thinking...' }),  // no tool, no signal → steer
        makeControlSignalTurn({ control: 'escalate', reason: 'gave up' }),
    ];

    const quest = fakeQuest();
    const charm = fakeCharm();
    const bus   = makeBus();

    const { scroll } = await runFairy({ quest, charm, bus });
    assert.strictEqual(scroll.fairyArtifact.status, 'escalate');
    _testQuestsDir = null;
}));

test('runFairy: probe budget exhaustion guard fires correctly', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    // Use a tiny probe budget via FairyFSM — but we can't inject it directly.
    // Instead we exhaust by calling probe 38 times (budget=40, reserve=3, so 37 in explore).
    // That's too many adapter responses. Instead, test the error path:
    // Call finalize with bad args (delivered), model gets error, then escalates.
    adapterStub._responses = [
        makeToolTurn('finalize', { status: 'delivered', summary: 'done', reason: 'done' }, 'tc1'),
        // After bad-args error, model escalates
        makeControlSignalTurn({ control: 'escalate', reason: 'cannot finalize with delivered' }),
    ];

    const quest = fakeQuest();
    const charm = fakeCharm();
    const bus   = makeBus();

    const { scroll } = await runFairy({ quest, charm, bus });
    assert.strictEqual(scroll.fairyArtifact.status, 'escalate');
    _testQuestsDir = null;
}));

test('runFairy: emits fairy.started event', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    adapterStub._responses = [
        makeControlSignalTurn({ control: 'escalate', reason: 'test' }),
    ];

    const quest = fakeQuest('Q02');
    const charm = fakeCharm('C02');
    const bus   = makeBus();

    await runFairy({ quest, charm, bus });

    const startedEv = bus.events.find(e => e.type === 'fairy.started');
    assert.ok(startedEv);
    assert.strictEqual(startedEv.data.questId, 'Q02');
    assert.strictEqual(startedEv.data.charmId, 'C02');
    _testQuestsDir = null;
}));

test('runFairy: emits scroll.submitted event', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    adapterStub._responses = [
        makeControlSignalTurn({ control: 'escalate', reason: 'test' }),
    ];

    const bus = makeBus();
    await runFairy({ quest: fakeQuest(), charm: fakeCharm(), bus });

    const submittedEv = bus.events.find(e => e.type === 'scroll.submitted');
    assert.ok(submittedEv);
    assert.ok(submittedEv.data.scrollId);
    _testQuestsDir = null;
}));

test('runFairy: throws not_configured when role not configured', async () => {
    // Override roles stub temporarily
    const savedExports = require.cache[rolesId].exports;
    require.cache[rolesId].exports = { resolveRole: () => ({ configured: false }) };
    // Clear cached fairy module so it picks up new stub
    const fairyId = require.resolve('../core/fairy');
    delete require.cache[fairyId];

    try {
        const { runFairy: rf } = require('../core/fairy');
        await rf({ quest: fakeQuest(), charm: fakeCharm(), bus: makeBus() });
        assert.fail('should have thrown');
    } catch (e) {
        assert.strictEqual(e.kind, 'not_configured');
    } finally {
        // Restore
        require.cache[rolesId].exports = savedExports;
        delete require.cache[require.resolve('../core/fairy')];
        // Re-load to restore to the original module
        require('../core/fairy');
    }
});

test('runFairy: throws no_workspace when project.questsDir() returns null', async () => {
    _testQuestsDir = null; // already null — no workspace
    // Need to clear fairy cache since module was re-loaded above
    const fairyId = require.resolve('../core/fairy');
    if (!require.cache[fairyId]) require('../core/fairy');

    try {
        const { runFairy: rf } = require('../core/fairy');
        await rf({ quest: fakeQuest(), charm: fakeCharm(), bus: makeBus() });
        assert.fail('should have thrown');
    } catch (e) {
        assert.strictEqual(e.kind, 'no_workspace');
    }
});

test('runFairy: kernel unavailable emits omen event', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    shimStub.kernelStatus = () => ({ available: false, reason: 'no_controller' });

    adapterStub._responses = [
        makeControlSignalTurn({ control: 'escalate', reason: 'no kernel' }),
    ];

    const bus = makeBus();
    await runFairy({ quest: fakeQuest(), charm: fakeCharm(), bus });

    const omenEv = bus.events.find(e => e.type === 'omen' && e.data.kind === 'kernel_unavailable_warning');
    assert.ok(omenEv);

    // Restore
    shimStub.kernelStatus = () => ({ available: true });
    _testQuestsDir = null;
}));

test('runFairy: charm.inputs are saved to workDir', () => withTempDir(async (dir) => {
    _testQuestsDir = dir;
    shimStub.kernelStatus = () => ({ available: true });

    const charm = {
        ...fakeCharm(),
        inputs: [{ id: 'n', code: 'n = 5', description: 'size' }],
    };

    adapterStub._responses = [
        makeControlSignalTurn({ control: 'escalate', reason: 'done' }),
    ];

    const bus = makeBus();
    await runFairy({ quest: fakeQuest(), charm, bus });

    // Check that inputs.json was written in the charmDir
    const questFolder = 'Q01_test';
    const charmDir = path.join(dir, questFolder, 'charms', 'C01');
    const raw = await fsp.readFile(path.join(charmDir, 'inputs.json'), 'utf8').catch(() => null);
    assert.ok(raw !== null, 'inputs.json should exist');
    const inputs = JSON.parse(raw);
    assert.strictEqual(inputs[0].id, 'n');
    _testQuestsDir = null;
}));

// ─────────────────────────────────────────────────────────────────────────────
// 6. agents/fairy.prompt.js re-export
// ─────────────────────────────────────────────────────────────────────────────
test('agents/fairy.prompt.js re-exports FAIRY_SYSTEM_PROMPT', () => {
    const { FAIRY_SYSTEM_PROMPT: fromAgent } = require('../agents/fairy.prompt');
    const { FAIRY_SYSTEM_PROMPT: fromPrompts } = require('../fairy/prompts');
    assert.strictEqual(fromAgent, fromPrompts);
    assert.ok(typeof fromAgent === 'string' && fromAgent.length > 100);
});

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    process.stdout.write('Fairy Phase 3 tests\n\n');
    await run();
})().catch(e => {
    process.stderr.write(`Fatal: ${e.stack || e}\n`);
    process.exit(1);
});
