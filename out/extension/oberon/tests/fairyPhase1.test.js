#!/usr/bin/env node
'use strict';
/**
 * Fairy Phase 1 — smoke tests.
 *
 * Covers:
 *   depAnalyzer.analyzeCode()     — symbol detection, locals, pattern vars
 *   WorkDir                       — create, saveProbe, addStep, markStale, upsertAssumption
 *   tools.handleProbe             — happy path + kernel error (stubbed shim)
 *   tools.handleRecord            — ok path + dep inference
 *   tools.handleInvalidate        — BFS prune
 *   tools.computeStructuralSummary — head detection
 *
 * Run: node out/extension/oberon/tests/fairyPhase1.test.js
 * No real Wolfram kernel required; no vscode dependency.
 */

const os    = require('os');
const path  = require('path');
const fsp   = require('fs/promises');
const assert = require('assert');

// ── Stub vscode ─────────────────────────────────────────────────────────────
// Use Module._resolveFilename intercept (same pattern as wardsSmoke.js)
const Module = require('module');
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode.js');
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

// ── Stub wolframShim ─────────────────────────────────────────────────────────
// Must be injected BEFORE requiring the modules under test.
const shimStub = {
    DEFAULT_TIMEOUT: 30,
    MAX_TIMEOUT:     120,
    _next: null,

    async evalOnce({ expression }) {
        if (this._next !== null) {
            const result = typeof this._next === 'function'
                ? this._next(expression)
                : this._next;
            this._next = null;
            return result;
        }
        return { ok: true, kind: 'ok', value: '42', messages: null, prints: null, durationMs: 1 };
    },
};

{
    const shimPath = require.resolve('../core/wolframShim');
    require.cache[shimPath] = {
        id: shimPath, filename: shimPath, loaded: true,
        exports: shimStub,
    };
}

// ── Load modules under test ──────────────────────────────────────────────────
const { analyzeCode, WL_BUILTINS }     = require('../fairy/depAnalyzer');
const { createWorkDir }                = require('../fairy/workDir');
const {
    handleProbe, handleRecord, handleInvalidate, handleAssume, handleChain,
    handleLookup, handleInspect, handleFinalize, computeStructuralSummary,
    dispatchFairyTool,
} = require('../fairy/tools');

// ── Test harness ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
    try {
        await fn();
        console.log('  ✓', name);
        pass++;
    } catch (e) {
        console.error('  ✗', name);
        console.error('   ', e.message || e);
        failures.push({ name, error: e.message || String(e) });
        fail++;
    }
}

function eq(a, b, msg) {
    assert.deepStrictEqual(a, b, msg);
}

function ok(v, msg) {
    assert.ok(v, msg);
}

// ── Temp dir per suite ───────────────────────────────────────────────────────
async function makeTmpDir(label) {
    const dir = path.join(os.tmpdir(), `fairy_test_${label}_${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

(async () => {

// ════════════════════════════════════════════════════════════════════════════
// depAnalyzer tests
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── depAnalyzer ──');

await t('analyzeCode: empty input', () => {
    const r = analyzeCode('');
    eq(r.definesSymbols, []);
    eq(r.usesSymbols, []);
});

await t('analyzeCode: null input', () => {
    const r = analyzeCode(null);
    eq(r.definesSymbols, []);
    eq(r.usesSymbols, []);
});

await t('analyzeCode: simple function def', () => {
    const r = analyzeCode('myFunc[x_] := x^2');
    ok(r.definesSymbols.includes('myFunc'), 'should define myFunc');
    ok(!r.usesSymbols.includes('myFunc'), 'myFunc should not appear in uses');
    // x_ is a pattern var — not a use
    ok(!r.usesSymbols.includes('x'), 'pattern vars excluded from uses');
});

await t('analyzeCode: lowercase user symbols detected', () => {
    // Critical regression test: lowercase symbols must be detected
    const r = analyzeCode('result = f[g[x0]] + deltaT');
    ok(r.definesSymbols.includes('result'), 'result should be defined');
    ok(r.usesSymbols.includes('f'),      'f should be used');
    ok(r.usesSymbols.includes('g'),      'g should be used');
    ok(r.usesSymbols.includes('x0'),     'x0 should be used');
    ok(r.usesSymbols.includes('deltaT'), 'deltaT should be used');
});

await t('analyzeCode: Module locals excluded from uses', () => {
    const r = analyzeCode('Module[{x, y = 0}, x + y + globalSym]');
    ok(!r.usesSymbols.includes('x'),    'Module local x excluded');
    ok(!r.usesSymbols.includes('y'),    'Module local y excluded');
    ok(r.usesSymbols.includes('globalSym'), 'globalSym should appear in uses');
});

await t('analyzeCode: With locals excluded', () => {
    const r = analyzeCode('With[{a = Pi, b = E}, a + b + outerVar]');
    ok(!r.usesSymbols.includes('a'),        'With local a excluded');
    ok(!r.usesSymbols.includes('b'),        'With local b excluded');
    ok(r.usesSymbols.includes('outerVar'), 'outerVar in uses');
});

await t('analyzeCode: Set[f, ...] form', () => {
    const r = analyzeCode('Set[myVar, 42]');
    ok(r.definesSymbols.includes('myVar'), 'myVar defined via Set[]');
});

await t('analyzeCode: symbols in comments and strings not counted', () => {
    const r = analyzeCode('(* ghostSym is a fake symbol *) "ghostSym2" + realSym');
    ok(!r.usesSymbols.includes('ghostSym'),  'comment symbol excluded');
    ok(!r.usesSymbols.includes('ghostSym2'), 'string symbol excluded');
    ok(r.usesSymbols.includes('realSym'),    'realSym in uses');
});

await t('analyzeCode: WL builtins not in usesSymbols', () => {
    const r = analyzeCode('Integrate[f[x], {x, 0, 1}]');
    ok(!r.usesSymbols.includes('Integrate'), 'Integrate is a builtin');
    ok(r.usesSymbols.includes('f'),          'f is a user symbol');
    // 2026-08-01: iterator-spec variables ({x, 0, 1}) are BOUND, not deps —
    // they were the dominant missing_deps_gate false-positive class.
    ok(!r.usesSymbols.includes('x'),         'x is bound by the iterator spec');
});

await t('analyzeCode: multi-step with interdependency', () => {
    const r1 = analyzeCode('f[x_] := x^2');
    const r2 = analyzeCode('g[x_] := f[x] + 1');
    ok(r1.definesSymbols.includes('f'), 'r1 defines f');
    ok(r2.definesSymbols.includes('g'), 'r2 defines g');
    ok(r2.usesSymbols.includes('f'),    'r2 uses f');
});

await t('WL_BUILTINS contains core symbols', () => {
    ok(WL_BUILTINS.has('Integrate'),  'Integrate in builtins');
    ok(WL_BUILTINS.has('Module'),     'Module in builtins');
    ok(WL_BUILTINS.has('List'),       'List in builtins');
    ok(WL_BUILTINS.has('Pi'),         'Pi in builtins');
    ok(!WL_BUILTINS.has('myHelper'), 'myHelper not in builtins');
});

// ════════════════════════════════════════════════════════════════════════════
// computeStructuralSummary tests
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── computeStructuralSummary ──');

await t('list value', () => {
    const r = computeStructuralSummary('{1, 2, 3}');
    eq(r.head, 'List');
    eq(r.elementCount, 3);
});

await t('rational number', () => {
    const r = computeStructuralSummary('3/7');
    eq(r.head, 'Rational');
});

await t('number', () => {
    const r = computeStructuralSummary('3.14159');
    eq(r.head, 'Number');
});

await t('named head', () => {
    const r = computeStructuralSummary('InterpolatingFunction[...]');
    eq(r.head, 'InterpolatingFunction');
});

await t('symbol', () => {
    const r = computeStructuralSummary('Infinity');
    eq(r.head, 'Infinity');
});

await t('null/empty', () => {
    const r = computeStructuralSummary(null);
    ok(r.head, 'Unknown');
});

// ════════════════════════════════════════════════════════════════════════════
// WorkDir tests
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── WorkDir ──');

await t('createWorkDir: creates expected files', async () => {
    const dir = await makeTmpDir('create');
    const wd  = await createWorkDir(dir);
    const check = async (p) => { await fsp.access(p); };
    await check(wd.stepsFile);
    await check(wd.assumFile);
    await check(wd.inputsFile);
    await check(wd.workingNb);
});

await t('createWorkDir: idempotent', async () => {
    const dir = await makeTmpDir('idem');
    await createWorkDir(dir);
    const wd2 = await createWorkDir(dir);  // second call should not throw
    ok(wd2, 'second createWorkDir succeeds');
});

await t('nextProbeCounter: increments with saved probes', async () => {
    const dir = await makeTmpDir('counter');
    const wd  = await createWorkDir(dir);
    eq(await wd.nextProbeCounter(), 1, 'starts at 1');
    await wd.saveProbe('p001', { code: '1+1', ok: true, value: '2', messages: null, prints: null, durationMs: 1, structuralSummary: {}, error: null });
    eq(await wd.nextProbeCounter(), 2, 'increments to 2 after save');
});

await t('saveProbe + getProbe: round-trip', async () => {
    const dir = await makeTmpDir('probe_rt');
    const wd  = await createWorkDir(dir);
    const data = { code: '2+2', ok: true, value: '4', messages: null, prints: null, durationMs: 5, structuralSummary: { head: 'Number' }, error: null, note: 'two plus two' };
    await wd.saveProbe('p001', data);
    const loaded = await wd.getProbe('p001');
    ok(loaded, 'loaded not null');
    eq(loaded.code,  '2+2');
    eq(loaded.value, '4');
    eq(loaded.note,  'two plus two');
});

await t('getProbe: returns null for missing probe', async () => {
    const dir = await makeTmpDir('probe_miss');
    const wd  = await createWorkDir(dir);
    eq(await wd.getProbe('p999'), null);
});

await t('addStep + loadValidSteps', async () => {
    const dir = await makeTmpDir('steps');
    const wd  = await createWorkDir(dir);
    await wd.addStep({ id: 'step_a', probeId: 'p001', code: 'a = 1', resultRef: 'p001', dependsOn: [], usesSymbols: [], definesSymbols: ['a'], note: '' });
    await wd.addStep({ id: 'step_b', probeId: 'p002', code: 'b = a + 1', resultRef: 'p002', dependsOn: ['step_a'], usesSymbols: ['a'], definesSymbols: ['b'], note: '' });
    const valid = await wd.loadValidSteps();
    eq(valid.length, 2);
    eq(valid[0].id, 'step_a');
    eq(valid[1].id, 'step_b');
});

await t('markStale: prunes step and dependents', async () => {
    const dir = await makeTmpDir('stale');
    const wd  = await createWorkDir(dir);
    await wd.addStep({ id: 'step_a', probeId: 'p001', code: 'a=1', resultRef: 'p001', dependsOn: [],         usesSymbols: [],    definesSymbols: ['a'], note: '' });
    await wd.addStep({ id: 'step_b', probeId: 'p002', code: 'b=a+1', resultRef: 'p002', dependsOn: ['step_a'], usesSymbols: ['a'], definesSymbols: ['b'], note: '' });
    await wd.addStep({ id: 'step_c', probeId: 'p003', code: 'c=b*2', resultRef: 'p003', dependsOn: ['step_b'], usesSymbols: ['b'], definesSymbols: ['c'], note: '' });

    const { prunedStepIds, keptStepIds } = await wd.markStale('step_a');
    ok(prunedStepIds.includes('step_a'), 'step_a pruned');
    ok(prunedStepIds.includes('step_b'), 'step_b transitively pruned');
    ok(prunedStepIds.includes('step_c'), 'step_c transitively pruned');
    eq(keptStepIds, []);

    const valid = await wd.loadValidSteps();
    eq(valid.length, 0, 'no valid steps remain');
});

await t('markStale: only prunes downstream, keeps independent', async () => {
    const dir = await makeTmpDir('stale2');
    const wd  = await createWorkDir(dir);
    await wd.addStep({ id: 'step_a', probeId: 'p001', code: 'a=1', resultRef: 'p001', dependsOn: [],         usesSymbols: [],    definesSymbols: ['a'], note: '' });
    await wd.addStep({ id: 'step_b', probeId: 'p002', code: 'b=2', resultRef: 'p002', dependsOn: [],         usesSymbols: [],    definesSymbols: ['b'], note: '' }); // independent
    await wd.addStep({ id: 'step_c', probeId: 'p003', code: 'c=a+1', resultRef: 'p003', dependsOn: ['step_a'], usesSymbols: ['a'], definesSymbols: ['c'], note: '' });

    const { prunedStepIds, keptStepIds } = await wd.markStale('step_a');
    ok(prunedStepIds.includes('step_a'), 'step_a pruned');
    ok(prunedStepIds.includes('step_c'), 'step_c pruned (depends on a)');
    ok(keptStepIds.includes('step_b'),   'step_b kept (independent)');

    const valid = await wd.loadValidSteps();
    eq(valid.length, 1, 'step_b still valid');
    eq(valid[0].id, 'step_b');
});

await t('upsertAssumption: insert then update', async () => {
    const dir = await makeTmpDir('assume');
    const wd  = await createWorkDir(dir);

    await wd.upsertAssumption({ id: 'a1', statement: 'n is positive', wlAssumption: 'n > 0' });
    let all = await wd.loadAssumptions();
    eq(all.length, 1);
    eq(all[0].statement, 'n is positive');

    await wd.upsertAssumption({ id: 'a1', statement: 'n is a positive integer', wlAssumption: 'Element[n, Integers] && n > 0' });
    all = await wd.loadAssumptions();
    eq(all.length, 1, 'upsert should not duplicate');
    eq(all[0].statement, 'n is a positive integer');
});

await t('setInputs / loadInputs: round-trip', async () => {
    const dir = await makeTmpDir('inputs');
    const wd  = await createWorkDir(dir);
    const inputs = [{ id: 'n', code: 'n = 5', description: 'dimension' }];
    await wd.setInputs(inputs);
    const loaded = await wd.loadInputs();
    eq(loaded, inputs);
});

await t('appendLog: creates log.jsonl', async () => {
    const dir = await makeTmpDir('log');
    const wd  = await createWorkDir(dir);
    await wd.appendLog({ phase: 'explore', turn: 1, event: 'probe_ok' });
    const raw = await fsp.readFile(wd.logFile, 'utf8');
    const line = JSON.parse(raw.trim());
    eq(line.phase, 'explore');
    eq(line.event, 'probe_ok');
});

await t('writeCleanNotebook: creates clean.wb with correct structure', async () => {
    const dir = await makeTmpDir('clean');
    const wd  = await createWorkDir(dir);

    const steps = [
        { id: 'step_a', code: 'a = 3',   note: 'set a' },
        { id: 'step_b', code: 'b = a^2', note: 'square it' },
    ];
    const inputs = [{ id: 'n', code: 'n = 5', description: 'dim' }];
    const assumptions = [{ id: 'a1', statement: 'a > 0', wlAssumption: 'a > 0' }];
    await wd.writeCleanNotebook({ steps, inputs, assumptions, taskTitle: 'Test' });

    const raw  = await fsp.readFile(wd.cleanNb, 'utf8');
    const nb   = JSON.parse(raw);
    ok(Array.isArray(nb.cells),            'has cells array');
    ok(nb.cells.length >= 4,               'header + input + assumptions + 2 steps');
    // Header cell
    ok(nb.cells[0].value.includes('Wolfbook Fairy'), 'header cell present');
    ok(nb.cells[0].value.includes('Test'),           'task title in header');
});

await t('buildChainSummary: returns structured summary', async () => {
    const dir = await makeTmpDir('chain_sum');
    const wd  = await createWorkDir(dir);
    await wd.addStep({ id: 'step_a', probeId: 'p001', code: 'a=1', resultRef: 'p001', dependsOn: [], usesSymbols: [], definesSymbols: ['a'], note: 'first' });
    const summary = await wd.buildChainSummary();
    ok(Array.isArray(summary.steps),       'steps is array');
    eq(summary.steps.length, 1,            'one step');
    eq(summary.steps[0].id, 'step_a');
    ok(Array.isArray(summary.assumptions), 'assumptions present');
});

// ════════════════════════════════════════════════════════════════════════════
// tools.js handler tests (stubbed kernel)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── tools ──');

async function makeCtx(label) {
    const dir = await makeTmpDir(label);
    const wd  = await createWorkDir(dir);
    return { workDir: wd, shim: shimStub, signal: null };
}

await t('handleProbe: happy path', async () => {
    const ctx = await makeCtx('probe_ok');
    shimStub._next = { ok: true, kind: 'ok', value: '6', messages: null, prints: null, durationMs: 3 };
    const r = await handleProbe({ code: '2*3', note: 'simple multiply' }, ctx);
    ok(r.ok, 'result ok');
    eq(r.kind, 'ok');
    const d = JSON.parse(r.modelPayload);
    ok(d.probeId, 'has probeId');
    ok(d.resultPreview === '6', 'preview is 6');

    // verify probe stored on disk
    const stored = await ctx.workDir.getProbe(d.probeId);
    ok(stored,              'probe stored');
    eq(stored.code, '2*3', 'code stored');
    eq(stored.value, '6',  'value stored');
});

await t('handleProbe: kernel failure returns structured error', async () => {
    const ctx = await makeCtx('probe_fail');
    shimStub._next = { ok: false, kind: 'syntax_error', value: null, error: 'Syntax::sntx', messages: null, prints: null, durationMs: 1 };
    const r = await handleProbe({ code: '2**3' }, ctx);
    ok(!r.ok, 'result not ok');
    const d = JSON.parse(r.modelPayload);
    ok(d.errorNotice, 'errorNotice present');
    ok(d.probeId, 'probeId still assigned even on failure');
});

await t('handleProbe: missing code → bad_args', async () => {
    const ctx = await makeCtx('probe_nocode');
    const r = await handleProbe({}, ctx);
    ok(!r.ok);
    eq(r.kind, 'bad_args');
});

await t('handleRecord: happy path with dep inference', async () => {
    const ctx = await makeCtx('record_ok');
    // Add step_a defining 'myF'
    await ctx.workDir.addStep({ id: 'step_a', probeId: 'p001', code: 'myF[x_] := x^2', resultRef: 'p001', dependsOn: [], usesSymbols: [], definesSymbols: ['myF'], note: '' });
    // Save probe for step_b that uses myF
    await ctx.workDir.saveProbe('p002', { code: 'myF[5]', ok: true, value: '25', messages: null, prints: null, durationMs: 2, structuralSummary: { head: 'Number' }, error: null, note: '' });

    const r = await handleRecord({ stepId: 'step_b', probeId: 'p002' }, ctx);
    ok(r.ok, `record ok: ${r.error || ''}`);
    const d = JSON.parse(r.modelPayload);
    ok(d.inferredDependsOn.includes('step_a'), 'dep on step_a inferred');
    eq(d.stepId, 'step_b');

    const valid = await ctx.workDir.loadValidSteps();
    eq(valid.length, 2, 'two valid steps now');
    ok(valid[1].evidenceSnapshot, 'immutable evidence snapshot stored');
    eq(valid[1].evidenceSnapshot.code, 'myF[5]');
    eq(valid[1].evidenceSnapshot.output, '25');
    ok(/^[a-f0-9]{64}$/.test(valid[1].evidenceSnapshot.sha256), 'snapshot is sha256-stamped');
});

await t('handleRecord: one probe cannot back two different steps', async () => {
    const ctx = await makeCtx('record_probe_reuse');
    await ctx.workDir.saveProbe('p001', { code: 'x=1', ok: true, value: '1', messages: null, durationMs: 1 });
    const a = await handleRecord({ stepId: 'step_a', probeId: 'p001' }, ctx);
    ok(a.ok, 'first binding accepted');
    const b = await handleRecord({ stepId: 'step_b', probeId: 'p001' }, ctx);
    ok(!b.ok, 'second binding rejected');
    eq(b.kind, 'probe_already_recorded');
});

await t('handleRecord: duplicate stepId → error', async () => {
    const ctx = await makeCtx('record_dup');
    await ctx.workDir.addStep({ id: 'step_a', probeId: 'p001', code: 'a=1', resultRef: 'p001', dependsOn: [], usesSymbols: [], definesSymbols: ['a'], note: '' });
    await ctx.workDir.saveProbe('p002', { code: 'a=2', ok: true, value: '2', messages: null, prints: null, durationMs: 1, structuralSummary: {}, error: null });
    const r = await handleRecord({ stepId: 'step_a', probeId: 'p002' }, ctx);
    ok(!r.ok, 'duplicate stepId rejected');
    eq(r.kind, 'duplicate_step');
});

await t('handleRecord: failed probe → error', async () => {
    const ctx = await makeCtx('record_fail_probe');
    await ctx.workDir.saveProbe('p001', { code: 'bad', ok: false, value: null, messages: null, prints: null, durationMs: 1, structuralSummary: {}, error: 'Syntax error' });
    const r = await handleRecord({ stepId: 'step_a', probeId: 'p001' }, ctx);
    ok(!r.ok);
    eq(r.kind, 'probe_failed');
});

await t('handleRecord: missing probeId → error', async () => {
    const ctx = await makeCtx('record_no_probe');
    const r = await handleRecord({ stepId: 'step_a', probeId: 'p999' }, ctx);
    ok(!r.ok);
    eq(r.kind, 'probe_not_found');
});

await t('handleInvalidate: prunes step + dependents', async () => {
    const ctx = await makeCtx('invalidate_ok');
    await ctx.workDir.addStep({ id: 'step_a', probeId: 'p001', code: 'a=1', resultRef: 'p001', dependsOn: [],         usesSymbols: [],    definesSymbols: ['a'], note: '' });
    await ctx.workDir.addStep({ id: 'step_b', probeId: 'p002', code: 'b=a', resultRef: 'p002', dependsOn: ['step_a'], usesSymbols: ['a'], definesSymbols: ['b'], note: '' });

    const r = await handleInvalidate({ fromStepId: 'step_a' }, ctx);
    ok(r.ok);
    const d = JSON.parse(r.modelPayload);
    ok(d.prunedStepIds.includes('step_a'));
    ok(d.prunedStepIds.includes('step_b'));
});

await t('handleInvalidate: missing fromStepId → bad_args', async () => {
    const ctx = await makeCtx('invalidate_noarg');
    const r = await handleInvalidate({}, ctx);
    ok(!r.ok);
    eq(r.kind, 'bad_args');
});

await t('handleAssume: insert and kernel update', async () => {
    const ctx = await makeCtx('assume_ok');
    shimStub._next = { ok: true, kind: 'ok', value: 'True', messages: null, prints: null, durationMs: 1 };
    const r = await handleAssume({ id: 'a1', statement: 'x > 0', wlAssumption: 'x > 0' }, ctx);
    ok(r.ok);
    const d = JSON.parse(r.modelPayload);
    eq(d.id, 'a1');
    eq(d.totalAssumptions, 1);
    ok(d.kernelUpdated);
});

await t('handleChain: returns valid steps', async () => {
    const ctx = await makeCtx('chain_ok');
    await ctx.workDir.addStep({ id: 'step_x', probeId: 'p001', code: 'x=99', resultRef: 'p001', dependsOn: [], usesSymbols: [], definesSymbols: ['x'], note: 'test' });
    const r = await handleChain({}, ctx);
    ok(r.ok);
    const d = JSON.parse(r.modelPayload);
    ok(Array.isArray(d.steps));
    eq(d.steps.length, 1);
    eq(d.steps[0].id, 'step_x');
});

await t('handleLookup: valid symbol name', async () => {
    const ctx = await makeCtx('lookup_ok');
    shimStub._next = { ok: true, kind: 'ok', value: 'Integrate[f, {x, a, b}] computes...', messages: null, prints: null, durationMs: 5 };
    const r = await handleLookup({ symbol: 'Integrate' }, ctx);
    ok(r.ok);
    const d = JSON.parse(r.modelPayload);
    eq(d.symbol, 'Integrate');
    ok(d.info.length > 0);
});

await t('handleLookup: invalid symbol name → bad_args', async () => {
    const ctx = await makeCtx('lookup_bad');
    const r = await handleLookup({ symbol: '123bad' }, ctx);
    ok(!r.ok);
    eq(r.kind, 'bad_args');
});

await t('handleInspect: valid probe', async () => {
    const ctx = await makeCtx('inspect_ok');
    await ctx.workDir.saveProbe('p001', { code: '{1,2,3}', ok: true, value: '{1, 2, 3}', messages: null, prints: null, durationMs: 2, structuralSummary: { head: 'List' }, error: null });
    shimStub._next = { ok: true, kind: 'ok', value: '3', messages: null, prints: null, durationMs: 2 };
    const r = await handleInspect({ resultRef: 'p001', op: 'Length' }, ctx);
    ok(r.ok);
    const d = JSON.parse(r.modelPayload);
    eq(d.resultRef, 'p001');
    ok(d.preview.includes('3'));
});

await t('handleInspect: missing probe → not_found', async () => {
    const ctx = await makeCtx('inspect_miss');
    const r = await handleInspect({ resultRef: 'p999' }, ctx);
    ok(!r.ok);
    eq(r.kind, 'not_found');
});

await t('handleFinalize: delivered → bad_args', () => {
    const r = handleFinalize({ status: 'delivered', summary: 'done', reason: 'done' }, {});
    ok(!r.ok);
    eq(r.kind, 'bad_args');
});

await t('handleFinalize: failed status', () => {
    const r = handleFinalize({ status: 'failed', summary: 'Could not converge.', reason: 'integral diverges' }, {});
    ok(r.ok);
    const d = JSON.parse(r.modelPayload);
    eq(d.status, 'failed');
});

await t('handleFinalize: escalate status', () => {
    const r = handleFinalize({ status: 'escalate', summary: 'Needs decomposition.', reason: 'too complex' }, {});
    ok(r.ok);
    const d = JSON.parse(r.modelPayload);
    eq(d.status, 'escalate');
});

await t('dispatchFairyTool: unknown tool → error', async () => {
    const ctx = await makeCtx('dispatch_unknown');
    const r = await dispatchFairyTool({ name: 'nonexistent', args: {} }, ctx);
    ok(!r.ok);
    eq(r.kind, 'unknown_tool');
});

await t('dispatchFairyTool: routes to probe', async () => {
    const ctx = await makeCtx('dispatch_probe');
    shimStub._next = { ok: true, kind: 'ok', value: '7', messages: null, prints: null, durationMs: 1 };
    const r = await dispatchFairyTool({ name: 'probe', args: { code: '3+4' } }, ctx);
    ok(r.ok, `dispatched probe ok: ${r.error}`);
});

await t('ask_specialist: duplicate question is suppressed and answer reused', async () => {
    const ctx = await makeCtx('ask_dedup');
    let dialogs = 0;
    ctx.askUser = async () => { dialogs++; return 'the planner check is invalid'; };
    ctx.askState = { count: 0, cache: new Map(), max: 2 };
    const a = await dispatchFairyTool({ name: 'ask_specialist', args: {
        question: 'Is the negative ground-state validation condition incorrect?', context: 'E0 is positive',
    } }, ctx);
    const b = await dispatchFairyTool({ name: 'ask_specialist', args: {
        question: 'Could the negative ground state validation check be incorrect?', context: 'same evidence',
    } }, ctx);
    ok(a.ok && b.ok);
    eq(dialogs, 1, 'only one user dialog');
    const payload = JSON.parse(b.modelPayload);
    ok(payload.duplicate, 'second question marked duplicate');
    eq(payload.answer, 'the planner check is invalid');
});

await t('ask_specialist: per-charm cap prevents additional dialogs', async () => {
    const ctx = await makeCtx('ask_cap');
    let dialogs = 0;
    ctx.askUser = async () => { dialogs++; return ''; };
    ctx.askState = { count: 1, cache: new Map(), max: 1 };
    const r = await dispatchFairyTool({ name: 'ask_specialist', args: {
        question: 'A completely different question requiring user input?',
    } }, ctx);
    eq(dialogs, 0);
    ok(JSON.parse(r.modelPayload).capped);
});

// ════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n── Results: ${pass} passed, ${fail} failed ──`);
if (failures.length) {
    console.error('\nFailed tests:');
    for (const f of failures) console.error(`  ✗ ${f.name}: ${f.error}`);
}
process.exit(fail > 0 ? 1 : 0);

})().catch(e => { console.error('FATAL', e); process.exit(2); });
