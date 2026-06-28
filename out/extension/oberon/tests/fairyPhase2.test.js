#!/usr/bin/env node
'use strict';
/**
 * Fairy Phase 2 — smoke tests.
 *
 * Covers:
 *   FairyFSM       — phase transitions, budget enforcement, probe reserve
 *   harness.compile — closure computation, static checks, auto-extend
 *   harness.staticCheck — conflict detection, missing dep detection
 *   harness.computeClosure — BFS, missing-step detection
 *   harness.autoCorrectMissingStep — symbol extraction
 *   kernelVerifier  — buildVerifyScript, parseVerifyOutput (no real kernel)
 *   prompts         — buildExploreUserMessage, buildDiagnoseUserMessage
 *
 * No real Wolfram kernel required. The verify/subprocess path is NOT tested here
 * (requires integration test with real wolframscript).
 *
 * Run: node out/extension/oberon/tests/fairyPhase2.test.js
 */

const os    = require('os');
const path  = require('path');
const fsp   = require('fs/promises');
const assert = require('assert');

// ── Stub vscode ──────────────────────────────────────────────────────────────
const Module = require('module');
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode.js');
if (!require.cache[fakeVscodeId]) {
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
            Uri: { file: p => ({ fsPath: p, toString: () => p }) },
            EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} dispose(){} },
        },
    };
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve.call(this, req, parent, ...rest);
};

// ── Load modules under test ──────────────────────────────────────────────────
const { FairyFSM, DEFAULTS }              = require('../fairy/fsm');
const { computeClosure, staticCheck, autoCorrectMissingStep, compile } = require('../fairy/harness');
const { buildVerifyScript, parseVerifyOutput } = require('../fairy/kernelVerifier');
const { buildExploreUserMessage, buildDiagnoseUserMessage, buildBudgetReminderMessage, FAIRY_SYSTEM_PROMPT } = require('../fairy/prompts');
const { createWorkDir }                   = require('../fairy/workDir');

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

function ok(v, msg) { assert.ok(v, msg); }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); }
function notOk(v, msg) { assert.ok(!v, msg); }

async function makeTmpDir(label) {
    const dir = path.join(os.tmpdir(), `fairy2_${label}_${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

// ════════════════════════════════════════════════════════════════════════════
// FairyFSM tests
// ════════════════════════════════════════════════════════════════════════════

(async () => {

console.log('\n── FairyFSM ──');

await t('starts in intake phase', () => {
    const fsm = new FairyFSM();
    eq(fsm.phase, 'intake');
    notOk(fsm.isTerminal);
});

await t('uses default budget constants', () => {
    const fsm = new FairyFSM();
    eq(fsm.probesRemaining, DEFAULTS.probe_budget);
    eq(fsm.turnsRemaining,  DEFAULTS.max_turns);
    eq(fsm.backtracksRemaining, DEFAULTS.max_backtracks);
});

await t('custom budget overrides defaults', () => {
    const fsm = new FairyFSM({ probe_budget: 10, max_turns: 20 });
    eq(fsm.probesRemaining, 10);
    eq(fsm.turnsRemaining,  20);
});

await t('canProbe() in explore respects reserve', () => {
    const fsm = new FairyFSM({ probe_budget: 5, diagnose_probe_reserve: 3 });
    fsm.transitionTo('explore');
    // Explore effective budget = 5 - 3 = 2
    ok(fsm.canProbe(), 'can probe at start');
    fsm.consumeProbe();  // used=1, effective_remaining=1
    ok(fsm.canProbe(), 'can still probe');
    fsm.consumeProbe();  // used=2, effective_remaining=0
    notOk(fsm.canProbe(), 'cannot probe: reserve boundary reached');
});

await t('canProbe() in diagnose uses full budget', () => {
    const fsm = new FairyFSM({ probe_budget: 5, diagnose_probe_reserve: 3 });
    fsm.transitionTo('explore');
    fsm.consumeProbe();
    fsm.consumeProbe();   // used=2, explore exhausted
    fsm.transitionTo('compile');
    fsm.transitionTo('verify');
    fsm.transitionTo('diagnose');
    // In Diagnose: remaining = 5 - 2 = 3 (reserve now accessible)
    ok(fsm.canProbe(), 'can use reserve in Diagnose');
    fsm.consumeProbe();  // used=3
    fsm.consumeProbe();  // used=4
    fsm.consumeProbe();  // used=5
    notOk(fsm.canProbe(), 'exhausted total budget');
});

await t('consumeProbe() throws when exhausted', () => {
    const fsm = new FairyFSM({ probe_budget: 2, diagnose_probe_reserve: 0 });
    fsm.transitionTo('explore');
    fsm.consumeProbe();
    fsm.consumeProbe();
    assert.throws(() => fsm.consumeProbe(), /probe budget exhausted/);
});

await t('turn tracking', () => {
    const fsm = new FairyFSM({ max_turns: 3 });
    fsm.transitionTo('explore');
    eq(fsm.turnsRemaining, 3);
    ok(fsm.canTurn());
    fsm.incrementTurn();
    fsm.incrementTurn();
    fsm.incrementTurn();
    eq(fsm.turnsRemaining, 0);
    notOk(fsm.canTurn());
});

await t('backtrack tracking', () => {
    const fsm = new FairyFSM({ max_backtracks: 2 });
    fsm.transitionTo('explore');
    ok(fsm.canBacktrack());
    fsm.consumeBacktrack();
    fsm.consumeBacktrack();
    notOk(fsm.canBacktrack());
    assert.throws(() => fsm.consumeBacktrack(), /max_backtracks exhausted/);
});

await t('diagnose turn limit resets on each Diagnose entry', () => {
    const fsm = new FairyFSM({ max_diagnose_turns: 3 });
    fsm.transitionTo('explore');
    fsm.transitionTo('compile');
    fsm.transitionTo('verify');
    fsm.transitionTo('diagnose');
    fsm.incrementTurn();
    fsm.incrementTurn();
    eq(fsm.diagnose_turns_remaining, 1);
    eq(fsm.canDiagnoseTurn(), true);
    fsm.incrementTurn();
    eq(fsm.canDiagnoseTurn(), false);
    // Re-enter Diagnose: counter resets
    fsm.transitionTo('explore');
    fsm.transitionTo('compile');
    fsm.transitionTo('verify');
    fsm.transitionTo('diagnose');
    eq(fsm.diagnose_turns_remaining, 3, 'counter reset on re-entry');
});

await t('terminal phases cannot be exited', () => {
    const fsm = new FairyFSM();
    fsm.transitionTo('explore');
    fsm.transitionTo('compile');
    fsm.transitionTo('verify');
    fsm.transitionTo('delivered');
    ok(fsm.isTerminal);
    assert.throws(() => fsm.transitionTo('explore'), /terminal/);
});

await t('getBudgetStatus() returns complete snapshot', () => {
    const fsm = new FairyFSM({ probe_budget: 10, diagnose_probe_reserve: 2 });
    fsm.transitionTo('explore');
    fsm.consumeProbe();
    const s = fsm.getBudgetStatus();
    eq(s.phase,            'explore');
    eq(s.probesUsed,       1);
    eq(s.probesRemaining,  9);
    eq(s.exploreProbesRemaining, 7);  // 10 - 2 - 1
});

await t('verify auto-correct tracking', () => {
    const fsm = new FairyFSM({ verify_auto_correct: 2 });
    ok(fsm.canAutoCorrect());
    fsm.consumeAutoCorrect();
    fsm.consumeAutoCorrect();
    notOk(fsm.canAutoCorrect());
    assert.throws(() => fsm.consumeAutoCorrect(), /verify_auto_correct limit/);
});

// ════════════════════════════════════════════════════════════════════════════
// harness.computeClosure tests
// ════════════════════════════════════════════════════════════════════════════

console.log('\n── harness.computeClosure ──');

// Helper: make a fake step
function makeStep(id, deps = [], uses = [], defines = [], code = '') {
    return { id, dependsOn: deps, usesSymbols: uses, definesSymbols: defines, code, status: 'valid', probeId: `p_${id}` };
}

await t('simple chain closure', () => {
    const steps = [
        makeStep('a', [],    [],    ['x']),
        makeStep('b', ['a'], ['x'], ['y']),
        makeStep('c', ['b'], ['y'], ['z']),
    ];
    const r = computeClosure(steps, 'c');
    ok(r.closure.has('a'), 'a in closure');
    ok(r.closure.has('b'), 'b in closure');
    ok(r.closure.has('c'), 'c in closure');
    eq(r.missing, []);
    eq(r.ordered.map(s => s.id), ['a', 'b', 'c']);
});

await t('single step closure', () => {
    const steps = [makeStep('a', [], [], ['x'])];
    const r = computeClosure(steps, 'a');
    ok(r.closure.has('a'));
    eq(r.ordered.length, 1);
});

await t('closure excludes unreachable sibling', () => {
    const steps = [
        makeStep('a', [], [], ['x']),
        makeStep('b', [], [], ['y']),  // sibling, not in closure of 'a'
    ];
    const r = computeClosure(steps, 'a');
    ok(r.closure.has('a'));
    notOk(r.closure.has('b'), 'b not in closure of a');
});

await t('missing target step → reports missing', () => {
    const steps = [makeStep('a', [], [], ['x'])];
    const r = computeClosure(steps, 'missing_target');
    ok(r.missing.includes('missing_target'));
    eq(r.ordered.length, 0);
});

await t('includeSteps forces extra step into closure', () => {
    const steps = [
        makeStep('a', [], [], ['x']),
        makeStep('b', [], [], ['y']),  // independent
    ];
    const r = computeClosure(steps, 'a', ['b']);
    ok(r.closure.has('b'), 'b force-included');
});

await t('excludeSteps removes a step from closure', () => {
    const steps = [
        makeStep('a', [], [], ['x']),
        makeStep('b', ['a'], ['x'], ['y']),
    ];
    const r = computeClosure(steps, 'b', [], ['a']);
    notOk(r.closure.has('a'), 'a excluded');
    ok(r.closure.has('b'),    'b still in closure');
});

await t('diamond dependency resolves without duplication', () => {
    // a → b, a → c, b → d, c → d; target=d
    const steps = [
        makeStep('a', [],         [], ['sym_a']),
        makeStep('b', ['a'],      ['sym_a'], ['sym_b']),
        makeStep('c', ['a'],      ['sym_a'], ['sym_c']),
        makeStep('d', ['b', 'c'], ['sym_b', 'sym_c'], ['sym_d']),
    ];
    const r = computeClosure(steps, 'd');
    eq([...r.closure].sort(), ['a', 'b', 'c', 'd']);
    eq(r.ordered.length, 4);
    eq(r.missing, []);
});

// ════════════════════════════════════════════════════════════════════════════
// harness.staticCheck tests
// ════════════════════════════════════════════════════════════════════════════

console.log('\n── harness.staticCheck ──');

await t('clean chain: no diagnostics', () => {
    const closure = [
        makeStep('a', [], [], ['x']),
        makeStep('b', ['a'], ['x'], ['y']),
    ];
    const r = staticCheck(closure, closure);
    ok(r.ok);
    eq(r.extendedWith, []);
    eq(r.diagnose, false);
    // symbol_not_in_closure warnings for 'x' used in b but... wait, x IS in closure via a.
    // Actually closureDefines['x'] = 'a', so b's use of 'x' is fine.
    const conflicts = r.diagnostics.filter(d => d.type === 'redefinition_conflict');
    eq(conflicts.length, 0);
});

await t('redefinition conflict → diagnose', () => {
    const closure = [
        makeStep('a', [], [], ['x']),
        makeStep('b', [], [], ['x']),  // both define 'x'
        makeStep('c', ['a', 'b'], ['x'], ['y']),
    ];
    const r = staticCheck(closure, closure);
    notOk(r.ok);
    ok(r.diagnose);
    ok(r.diagnostics.some(d => d.type === 'redefinition_conflict' && d.symbol === 'x'));
});

await t('auto-extend: symbol defined outside closure', () => {
    const all = [
        makeStep('helper', [], [], ['helperFn']),    // not in original closure
        makeStep('main',   [], ['helperFn'], ['result']), // uses helperFn
    ];
    const closure = [all[1]];  // only 'main' in closure
    const r = staticCheck(closure, all);
    ok(r.extendedWith.includes('helper'), 'helper auto-extended');
    notOk(r.diagnose, 'not a diagnose — auto-extend handles it');
});

await t('symbol_not_in_closure (no step defines it): warning only', () => {
    const all = [
        makeStep('a', [], ['ghostSym'], ['result']),
    ];
    const r = staticCheck(all, all);
    ok(r.ok, 'not diagnose');
    eq(r.extendedWith, [], 'no extension');
    ok(r.diagnostics.some(d => d.type === 'symbol_not_in_closure' && d.symbol === 'ghostSym'));
});

await t('two independent steps, no conflict', () => {
    const closure = [
        makeStep('a', [], [], ['x']),
        makeStep('b', [], [], ['y']),  // defines 'y', not 'x'
    ];
    const r = staticCheck(closure, closure);
    ok(r.ok);
    eq(r.diagnose, false);
});

// ════════════════════════════════════════════════════════════════════════════
// harness.compile (full integration, no kernel)
// ════════════════════════════════════════════════════════════════════════════

console.log('\n── harness.compile ──');

async function makeWorkDirWithSteps(label, steps) {
    const dir = await makeTmpDir(label);
    const wd  = await createWorkDir(dir);
    for (const s of steps) {
        await wd.addStep(s);
    }
    return wd;
}

await t('compile: simple two-step chain → verify phase', async () => {
    const wd = await makeWorkDirWithSteps('compile_ok', [
        makeStep('step_a', [], [], ['f']),
        makeStep('step_b', ['step_a'], ['f'], ['result']),
    ]);
    const r = await compile(wd, 'step_b');
    ok(r.ok, `compile ok: ${r.diagnostics.map(d => d.details).join('; ')}`);
    eq(r.phase, 'verify');
    eq(r.closureSteps.length, 2);
    ok(r.cleanNbPath, 'cleanNbPath set');
    // Verify clean.wb exists
    await fsp.access(r.cleanNbPath);
});

await t('compile: target missing → diagnose phase', async () => {
    const wd = await makeWorkDirWithSteps('compile_missing', [
        makeStep('step_a', [], [], ['f']),
    ]);
    const r = await compile(wd, 'nonexistent');
    notOk(r.ok);
    eq(r.phase, 'diagnose');
    ok(r.targetStepMissing);
});

await t('compile: redefinition conflict → diagnose phase', async () => {
    const wd = await makeWorkDirWithSteps('compile_conflict', [
        makeStep('step_a', [],        [], ['x']),
        makeStep('step_b', [],        [], ['x']),  // redefines x
        makeStep('step_c', ['step_a', 'step_b'], ['x'], ['result']),
    ]);
    const r = await compile(wd, 'step_c');
    notOk(r.ok);
    eq(r.phase, 'diagnose');
    ok(r.diagnostics.some(d => d.type === 'redefinition_conflict'));
});

await t('compile: auto-extend pulls in missing dep step', async () => {
    const wd = await makeWorkDirWithSteps('compile_autoext', [
        makeStep('step_helper', [], [], ['helperFn']),
        makeStep('step_main',   [], ['helperFn'], ['result']),
    ]);
    // Only record step_main as the target; step_helper has no dependsOn link
    // but step_main uses 'helperFn' which step_helper defines
    const r = await compile(wd, 'step_main');
    ok(r.ok, `compile with auto-extend ok: ${r.diagnostics.map(d => d.details).join('; ')}`);
    eq(r.phase, 'verify');
    ok(r.closureSteps.some(s => s.id === 'step_helper'), 'step_helper auto-included');
});

await t('compile: includeSteps forces extra step', async () => {
    const wd = await makeWorkDirWithSteps('compile_include', [
        makeStep('step_a', [], [], ['x']),
        makeStep('step_b', [], [], ['y']),
        makeStep('step_c', ['step_a'], ['x'], ['result']),
    ]);
    const r = await compile(wd, 'step_c', { includeSteps: ['step_b'] });
    ok(r.ok);
    ok(r.closureSteps.some(s => s.id === 'step_b'), 'step_b force-included');
});

await t('compile: single step (no deps)', async () => {
    const wd = await makeWorkDirWithSteps('compile_single', [
        makeStep('step_a', [], [], ['result']),
    ]);
    const r = await compile(wd, 'step_a');
    ok(r.ok);
    eq(r.closureSteps.length, 1);
    eq(r.phase, 'verify');
});

// ════════════════════════════════════════════════════════════════════════════
// harness.autoCorrectMissingStep
// ════════════════════════════════════════════════════════════════════════════

console.log('\n── harness.autoCorrectMissingStep ──');

await t('extracts symbol from Wolfram error message', () => {
    const verifyResult = {
        classification: 'missing_step',
        firstFailureCell: 'step_b_cell',
        freshOutput: 'Symbol "myFunc" in context "Global`" is not defined',
    };
    const allValid = [
        makeStep('step_helper', [], [], ['myFunc']),
        makeStep('step_b', [], ['myFunc'], ['result']),
    ];
    const result = autoCorrectMissingStep(verifyResult, allValid, []);
    ok(result, 'returns updated includeSteps');
    ok(result.includes('step_helper'), 'step_helper added to includeSteps');
});

await t('returns null for non-missing-step classification', () => {
    const result = autoCorrectMissingStep(
        { classification: 'output_differs', freshOutput: '' },
        [],
        []
    );
    eq(result, null);
});

await t('returns null when no step defines the missing symbol', () => {
    const verifyResult = {
        classification: 'missing_step',
        freshOutput: 'Symbol "unknownSym" in context "Global`" is not defined',
    };
    const result = autoCorrectMissingStep(verifyResult, [], []);
    eq(result, null, 'null when no step defines the symbol');
});

await t('does not re-add step already in includeSteps', () => {
    const verifyResult = {
        classification: 'missing_step',
        freshOutput: 'Symbol "myFunc" in context "Global`" is not defined',
    };
    const allValid = [makeStep('step_helper', [], [], ['myFunc'])];
    const result = autoCorrectMissingStep(verifyResult, allValid, ['step_helper']);
    eq(result, null, 'no new step found to add (already included)');
});

// ════════════════════════════════════════════════════════════════════════════
// kernelVerifier helpers (no subprocess)
// ════════════════════════════════════════════════════════════════════════════

console.log('\n── kernelVerifier helpers ──');

await t('buildVerifyScript: generates sentinels for each cell', () => {
    const cells = [
        { id: 'cell_a', kind: 2, language: 'wolfram', value: 'a = 1', outputs: [], metadata: {} },
        { id: 'cell_b', kind: 2, language: 'wolfram', value: 'b = a + 1', outputs: [], metadata: {} },
    ];
    const script = buildVerifyScript(cells, 30);
    ok(script.includes('__WB_CELL_START__ cell_a'), 'start sentinel for cell_a');
    ok(script.includes('__WB_CELL_START__ cell_b'), 'start sentinel for cell_b');
    ok(script.includes('__WB_CELL_END__ cell_a'),   'end sentinel for cell_a');
    ok(script.includes('__WB_CELL_END__ cell_b'),   'end sentinel for cell_b');
    ok(script.includes('a = 1'),     'code for cell_a');
    ok(script.includes('b = a + 1'), 'code for cell_b');
    ok(script.includes('Exit[];'),   'Exit at end');
    ok(script.includes('ToString[$wbResult$, InputForm]'), 'InputForm wrapping');
    ok(script.includes('TimeConstrained'), 'timeout wrapping');
});

await t('buildVerifyScript: skips markup cells (kind=1)', () => {
    const cells = [
        { id: 'markup', kind: 1, language: 'markdown', value: '# Header', outputs: [], metadata: {} },
        { id: 'code',   kind: 2, language: 'wolfram',  value: 'x = 5',   outputs: [], metadata: {} },
    ];
    const script = buildVerifyScript(cells, 30);
    notOk(script.includes('__WB_CELL_START__ markup'), 'markup cell skipped');
    ok(script.includes('__WB_CELL_START__ code'), 'code cell included');
});

await t('parseVerifyOutput: extracts cell results', () => {
    const stdout = [
        '__WB_CELL_START__ cell_a',
        '1',
        '__WB_CELL_END__ cell_a',
        '__WB_CELL_START__ cell_b',
        '2',
        '__WB_CELL_END__ cell_b',
    ].join('\n');
    const cells = [
        { id: 'cell_a', kind: 2 },
        { id: 'cell_b', kind: 2 },
    ];
    const results = parseVerifyOutput(stdout, cells);
    ok(results.has('cell_a'), 'cell_a parsed');
    ok(results.has('cell_b'), 'cell_b parsed');
    eq(results.get('cell_a').output, '1');
    eq(results.get('cell_b').output, '2');
    notOk(results.get('cell_a').error);
    notOk(results.get('cell_a').timeout);
});

await t('parseVerifyOutput: detects timeout sentinel', () => {
    const stdout = [
        '__WB_CELL_START__ cell_a',
        '__WB_CELL_TIMEOUT__ cell_a',
        '__WB_CELL_END__ cell_a',
    ].join('\n');
    const results = parseVerifyOutput(stdout, [{ id: 'cell_a', kind: 2 }]);
    ok(results.get('cell_a').timeout, 'timeout detected');
});

await t('parseVerifyOutput: handles multi-line output', () => {
    const stdout = [
        '__WB_CELL_START__ cell_a',
        'line1',
        'line2',
        'line3',
        '__WB_CELL_END__ cell_a',
    ].join('\n');
    const results = parseVerifyOutput(stdout, [{ id: 'cell_a', kind: 2 }]);
    const out = results.get('cell_a').output;
    ok(out.includes('line1'), 'line1 in output');
    ok(out.includes('line3'), 'line3 in output');
});

await t('parseVerifyOutput: no output for missing cells', () => {
    const stdout = '__WB_CELL_START__ cell_a\n1\n__WB_CELL_END__ cell_a\n';
    const results = parseVerifyOutput(stdout, [{ id: 'cell_a', kind: 2 }, { id: 'cell_b', kind: 2 }]);
    ok(results.has('cell_a'), 'cell_a present');
    notOk(results.has('cell_b'), 'cell_b not present (not in stdout)');
});

// ════════════════════════════════════════════════════════════════════════════
// prompts tests
// ════════════════════════════════════════════════════════════════════════════

console.log('\n── prompts ──');

await t('FAIRY_SYSTEM_PROMPT is a non-empty string', () => {
    ok(typeof FAIRY_SYSTEM_PROMPT === 'string' && FAIRY_SYSTEM_PROMPT.length > 100);
    ok(FAIRY_SYSTEM_PROMPT.includes('probe'), 'mentions probe');
    ok(FAIRY_SYSTEM_PROMPT.includes('record'), 'mentions record');
    ok(FAIRY_SYSTEM_PROMPT.includes('done_exploring'), 'mentions control signal');
});

await t('buildExploreUserMessage: includes task, inputs, budget', () => {
    const msg = buildExploreUserMessage({
        taskDescription: 'Compute the integral of sin(x)^2 from 0 to Pi.',
        inputs: [{ id: 'n', code: 'n = 5', description: 'dimension' }],
        assumptions: [],
        budget: { exploreProbesRemaining: 37, backtracksRemaining: 3, turnsRemaining: 78 },
        charmId: 'charm_001',
    });
    ok(msg.includes('charm_001'),     'charmId in message');
    ok(msg.includes('sin(x)^2'),      'task description in message');
    ok(msg.includes('n = 5'),         'input code in message');
    ok(msg.includes('37'),            'probe budget in message');
    ok(msg.includes('done_exploring'), 'mentions control signal');
});

await t('buildExploreUserMessage: no inputs section when inputs empty', () => {
    const msg = buildExploreUserMessage({
        taskDescription: 'Simplify (a+b)^2.',
        inputs: [],
        assumptions: [],
        budget: { exploreProbesRemaining: 40, backtracksRemaining: 3, turnsRemaining: 80 },
        charmId: 'charm_002',
    });
    notOk(msg.includes('Task inputs'), 'no inputs section when empty');
});

await t('buildExploreUserMessage: assumptions section appears when populated', () => {
    const msg = buildExploreUserMessage({
        taskDescription: 'Solve for x.',
        inputs: [],
        assumptions: [{ id: 'a1', statement: 'x > 0' }],
        budget: { exploreProbesRemaining: 40, backtracksRemaining: 3, turnsRemaining: 80 },
        charmId: 'charm_003',
    });
    ok(msg.includes('a1: x > 0'), 'assumption listed');
    ok(msg.includes('$Assumptions'), 'mentions kernel setup');
});

await t('buildDiagnoseUserMessage: includes all required sections', () => {
    const msg = buildDiagnoseUserMessage({
        classification:   'output_differs',
        firstFailureCell: 'step_b_cell',
        freshOutput:      'Pi/3',
        recordedOutput:   'Pi/2',
        messages:         ['NIntegrate::ncvb: ...'],
        details:          'Output mismatch on target step_b',
        budget:           { diagnoseProbesRemaining: 3, diagnoseTurnsRemaining: 6 },
        targetStepId:     'step_b',
    });
    ok(msg.includes('output_differs'),         'classification');
    ok(msg.includes('step_b'),                  'targetStepId');
    ok(msg.includes('Pi/3'),                    'fresh output');
    ok(msg.includes('Pi/2'),                    'recorded output');
    ok(msg.includes('NIntegrate::ncvb'),        'kernel message');
    ok(msg.includes('Canonical drift'),          'canonical drift rule');
    ok(msg.includes('Redefinition conflict'),    'redefinition rule');
    ok(msg.includes('Inputs are not assumptions'), 'inputs rule');
    ok(msg.includes('3'),                        'diagnose probe budget');
});

await t('buildDiagnoseUserMessage: missing_step classification', () => {
    const msg = buildDiagnoseUserMessage({
        classification:   'missing_step',
        firstFailureCell: 'step_a_cell',
        freshOutput:      'Symbol "myF" is not defined',
        recordedOutput:   'myF[5]',
        messages:         null,
        details:          'Undefined symbol',
        budget:           { diagnoseProbesRemaining: 2, diagnoseTurnsRemaining: 5 },
        targetStepId:     'step_a',
    });
    ok(msg.includes('missing_step'), 'classification included');
});

await t('buildBudgetReminderMessage: includes remaining counts', () => {
    const msg = buildBudgetReminderMessage({ exploreProbesRemaining: 2, backtracksRemaining: 1 });
    ok(msg.includes('2'), 'probe count');
    ok(msg.includes('1'), 'backtrack count');
    ok(msg.includes('done_exploring'), 'suggests done_exploring');
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
