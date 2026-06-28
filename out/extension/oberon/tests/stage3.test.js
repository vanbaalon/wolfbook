'use strict';
/**
 * Stage 3 tests:
 *  3A — define_util (workDir helpers + handleDefineUtil)
 *  3B — checkpoint (workDir helpers + handleCheckpoint)
 *  3C — probe does NOT prepend utils (M6: utils live in persistent kernel)
 *  3D — handleChain includes utilities
 *  3E — SteerQueue push/drain
 *  3F — EXPLORE_FAIRY_TOOL_SPECS includes define_util and checkpoint (10 tools)
 *  3G — FAIRY_SYSTEM_PROMPT contains rules 23 and 24
 */

const assert  = require('assert');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const Module  = require('module');

// ── vscode stub ──────────────────────────────────────────────────────────────

const fakeVscodeId = path.resolve(__dirname, '..', 'vscode.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            getConfiguration: () => ({ get: () => undefined }),
            onDidChangeConfiguration: () => ({ dispose() {} }),
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

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stage3-'));
    return d;
}

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(label, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(() => {
                console.log(`  ok ${label}`);
                passCount++;
            }).catch(e => {
                console.error(`  FAIL ${label}: ${e && e.message || e}`);
                failures.push({ label, err: e });
                failCount++;
            });
        }
        console.log(`  ok ${label}`);
        passCount++;
    } catch (e) {
        console.error(`  FAIL ${label}: ${e && e.message || e}`);
        failures.push({ label, err: e });
        failCount++;
    }
}

// ── require modules under test ────────────────────────────────────────────────

const { WorkDir, createWorkDir } = require('../fairy/workDir');
const { dispatchFairyTool, handleDefineUtil, handleCheckpoint, handleProbe, handleChain } = require('../fairy/tools');
const { SteerQueue } = require('../core/fairy');
const { EXPLORE_FAIRY_TOOL_SPECS, FAIRY_TOOL_SPECS } = require('../fairy/toolSpecs');
const { FAIRY_SYSTEM_PROMPT } = require('../fairy/prompts');

// ── shimStub factory ──────────────────────────────────────────────────────────

function makeShim(nextResult) {
    const shim = {
        DEFAULT_TIMEOUT: 30,
        _next: nextResult || { ok: true, value: 'Null', messages: [] },
        async evalOnce({ expression }) {
            shim._lastExpression = expression;
            return shim._next;
        },
    };
    return shim;
}

// ── ctx factory ──────────────────────────────────────────────────────────────

async function makeCtx(label, shimResult) {
    const dir = tmpDir();
    const wd  = await createWorkDir(dir);
    const shim = makeShim(shimResult);
    const ctx = {
        workDir: wd,
        shim,
        signal: null,
        fsm: { canTurn: () => true, turnsUsed: 0, exploreProbesRemaining: 10 },
    };
    return ctx;
}

// ── 3A: define_util workDir helpers ──────────────────────────────────────────

async function run3A() {
    console.log('\n── 3A: define_util (workDir + handleDefineUtil) ──');

    await ok('3A: utilsFile path ends with utils.json', async () => {
        const ctx = await makeCtx('3A-path');
        assert.ok(ctx.workDir.utilsFile.endsWith('utils.json'));
    });

    await ok('3A: loadUtils returns [] when file absent', async () => {
        const ctx = await makeCtx('3A-load-empty');
        const utils = await ctx.workDir.loadUtils();
        assert.deepStrictEqual(utils, []);
    });

    await ok('3A: addUtil persists a util entry', async () => {
        const ctx = await makeCtx('3A-add');
        await ctx.workDir.addUtil({ name: 'sqr', code: 'sqr[x_] := x^2', note: 'squares x' });
        const utils = await ctx.workDir.loadUtils();
        assert.strictEqual(utils.length, 1);
        assert.strictEqual(utils[0].name, 'sqr');
        assert.strictEqual(utils[0].code, 'sqr[x_] := x^2');
    });

    await ok('3A: addUtil upserts by name', async () => {
        const ctx = await makeCtx('3A-upsert');
        await ctx.workDir.addUtil({ name: 'f', code: 'f[x_] := x', note: 'identity' });
        await ctx.workDir.addUtil({ name: 'f', code: 'f[x_] := x+1', note: 'plus one' });
        const utils = await ctx.workDir.loadUtils();
        assert.strictEqual(utils.length, 1);
        assert.strictEqual(utils[0].code, 'f[x_] := x+1');
    });

    await ok('3A: getUtilsCode joins multiple entries', async () => {
        const ctx = await makeCtx('3A-code');
        await ctx.workDir.addUtil({ name: 'f', code: 'f[x_]:=x', note: 'id' });
        await ctx.workDir.addUtil({ name: 'g', code: 'g[x_]:=x^2', note: 'sq' });
        const code = await ctx.workDir.getUtilsCode();
        assert.ok(code.includes('f[x_]:=x'), 'should include f');
        assert.ok(code.includes('g[x_]:=x^2'), 'should include g');
    });

    await ok('3A: getUtilsCode returns empty string when no utils', async () => {
        const ctx = await makeCtx('3A-empty-code');
        const code = await ctx.workDir.getUtilsCode();
        assert.strictEqual(code, '');
    });

    await ok('3A: handleDefineUtil registers util on success', async () => {
        const ctx = await makeCtx('3A-handler-ok', { ok: true, value: 'sqr', messages: [] });
        const r = await handleDefineUtil({ name: 'sqr', code: 'sqr[x_]:=x^2', note: 'square' }, ctx);
        assert.ok(r.ok !== false, `expected ok result, got: ${r.error}`);
        const payload = JSON.parse(r.modelPayload);
        assert.strictEqual(payload.utilName, 'sqr');
        const utils = await ctx.workDir.loadUtils();
        assert.strictEqual(utils.length, 1);
    });

    await ok('3A: handleDefineUtil returns error on eval failure', async () => {
        const ctx = await makeCtx('3A-handler-fail', { ok: false, error: 'syntax error', messages: [] });
        const r = await handleDefineUtil({ name: 'bad', code: 'bad code @@', note: 'broken' }, ctx);
        assert.strictEqual(r.ok, false, 'expected failure');
        assert.ok(r.error.includes('bad'), `error should mention util name: ${r.error}`);
    });

    await ok('3A: handleDefineUtil returns error when name missing', async () => {
        const ctx = await makeCtx('3A-handler-no-name');
        const r = await handleDefineUtil({ code: 'f[x_]:=x', note: 'ok' }, ctx);
        assert.strictEqual(r.ok, false);
    });

    await ok('3A: handleDefineUtil returns error when code missing', async () => {
        const ctx = await makeCtx('3A-handler-no-code');
        const r = await handleDefineUtil({ name: 'f', note: 'ok' }, ctx);
        assert.strictEqual(r.ok, false);
    });
}

// ── 3B: checkpoint workDir helpers ───────────────────────────────────────────

async function run3B() {
    console.log('\n── 3B: checkpoint (workDir + handleCheckpoint) ──');

    await ok('3B: checkpointNb path ends with clean_in_progress.wb', async () => {
        const ctx = await makeCtx('3B-path');
        assert.ok(ctx.workDir.checkpointNb.endsWith('clean_in_progress.wb'));
    });

    await ok('3B: appendCheckpointSection creates the file', async () => {
        const ctx = await makeCtx('3B-creates');
        const step = { id: 's001', code: '2+2', note: 'add two', result: '4', status: 'valid' };
        await ctx.workDir.appendCheckpointSection({
            sectionTitle: 'Basic arithmetic',
            steps:        [step],
            inputs:       ['n = 42'],
            assumptions:  ['n is prime'],
        });
        assert.ok(fs.existsSync(ctx.workDir.checkpointNb), 'clean_in_progress.wb should exist');
        const raw = JSON.parse(fs.readFileSync(ctx.workDir.checkpointNb, 'utf8'));
        assert.ok(Array.isArray(raw.cells) && raw.cells.length > 0, 'should have cells');
    });

    await ok('3B: appendCheckpointSection includes section title', async () => {
        const ctx = await makeCtx('3B-title');
        const step = { id: 's002', code: 'x^2', note: 'square', result: 'x^2', status: 'valid' };
        await ctx.workDir.appendCheckpointSection({
            sectionTitle: 'Polynomial step',
            steps:        [step],
            inputs:       [],
            assumptions:  [],
        });
        const raw = JSON.parse(fs.readFileSync(ctx.workDir.checkpointNb, 'utf8'));
        const allText = raw.cells.map(c => c.value || '').join('\n');
        assert.ok(allText.includes('Polynomial step'), 'title should appear in cells');
    });

    await ok('3B: appendCheckpointSection appends multiple sections', async () => {
        const ctx = await makeCtx('3B-multi');
        const s1 = { id: 'sA', code: '1+1', note: 'first', result: '2', status: 'valid' };
        const s2 = { id: 'sB', code: '2+2', note: 'second', result: '4', status: 'valid' };
        await ctx.workDir.appendCheckpointSection({ sectionTitle: 'Sec 1', steps: [s1], inputs: [], assumptions: [] });
        await ctx.workDir.appendCheckpointSection({ sectionTitle: 'Sec 2', steps: [s2], inputs: [], assumptions: [] });
        const raw = JSON.parse(fs.readFileSync(ctx.workDir.checkpointNb, 'utf8'));
        const allText = raw.cells.map(c => c.value || '').join('\n');
        assert.ok(allText.includes('Sec 1'), 'section 1 title');
        assert.ok(allText.includes('Sec 2'), 'section 2 title');
    });

    await ok('3B: handleCheckpoint returns ok with stepsIncluded', async () => {
        const ctx = await makeCtx('3B-handler-ok');
        // Plant a valid step in the workDir using addStep (always marks valid)
        await ctx.workDir.addStep({
            id: 's001', probeId: 'p001', code: 'Sqrt[4]', resultRef: 'p001',
            dependsOn: [], usesSymbols: [], definesSymbols: [], note: 'sqrt 4',
        });
        const r = await handleCheckpoint({ sectionTitle: 'My section', stepIds: ['s001'] }, ctx);
        assert.ok(r.ok !== false, `expected ok, got: ${r.error}`);
        const payload = JSON.parse(r.modelPayload);
        assert.deepStrictEqual(payload.stepsIncluded, ['s001']);
        assert.ok(fs.existsSync(ctx.workDir.checkpointNb), 'notebook should be created');
    });

    await ok('3B: handleCheckpoint returns error when no valid steps match', async () => {
        const ctx = await makeCtx('3B-handler-nomatch');
        const r = await handleCheckpoint({ sectionTitle: 'Nothing', stepIds: ['sXXX'] }, ctx);
        assert.strictEqual(r.ok, false, 'expected failure');
        assert.ok(r.error.includes('valid'), `error should mention valid steps: ${r.error}`);
    });

    await ok('3B: handleCheckpoint returns error when sectionTitle missing', async () => {
        const ctx = await makeCtx('3B-no-title');
        const r = await handleCheckpoint({ stepIds: ['s001'] }, ctx);
        assert.strictEqual(r.ok, false);
    });

    await ok('3B: handleCheckpoint returns error when stepIds empty', async () => {
        const ctx = await makeCtx('3B-no-steps');
        const r = await handleCheckpoint({ sectionTitle: 'Title', stepIds: [] }, ctx);
        assert.strictEqual(r.ok, false);
    });

    await ok('3B: handleCheckpoint skips invalid steps', async () => {
        const ctx = await makeCtx('3B-skip-invalid');
        // Add a valid step via addStep
        await ctx.workDir.addStep({
            id: 'sOK', probeId: 'p001', code: 'x+1', resultRef: 'p001',
            dependsOn: [], usesSymbols: [], definesSymbols: [], note: 'valid step',
        });
        // Write a 'failed' step directly to stepsFile
        const all = await ctx.workDir.loadAllSteps();
        all.push({ id: 'sBAD', code: 'err', note: 'bad', status: 'failed', recordedAt: new Date().toISOString() });
        const { promises: fspLocal } = require('fs');
        await fspLocal.writeFile(ctx.workDir.stepsFile, JSON.stringify(all, null, 2), 'utf8');

        const r = await handleCheckpoint({
            sectionTitle: 'Only valid',
            stepIds:      ['sOK', 'sBAD'],
        }, ctx);
        assert.ok(r.ok !== false, `expected ok: ${r.error}`);
        const payload = JSON.parse(r.modelPayload);
        // sBAD is 'failed', not 'valid', so it should be excluded
        assert.deepStrictEqual(payload.stepsIncluded, ['sOK']);
    });
}

// ── 3AP: plan workDir + handlePlan ───────────────────────────────────────────

async function run3AP() {
    console.log('\n── 3AP: plan (workDir + handlePlan) ──');
    const { handlePlan } = require('../fairy/tools');

    await ok('3AP: planFile path ends with plan.json', async () => {
        const ctx = await makeCtx('3AP-path');
        assert.ok(ctx.workDir.planFile.endsWith('plan.json'));
    });

    await ok('3AP: loadPlan returns null when absent', async () => {
        const ctx = await makeCtx('3AP-load-empty');
        const plan = await ctx.workDir.loadPlan();
        assert.strictEqual(plan, null);
    });

    await ok('3AP: savePlan persists steps and note', async () => {
        const ctx = await makeCtx('3AP-save');
        await ctx.workDir.savePlan({ steps: ['Step A', 'Step B'], note: 'strategy' });
        const plan = await ctx.workDir.loadPlan();
        assert.ok(plan !== null);
        assert.deepStrictEqual(plan.steps, ['Step A', 'Step B']);
        assert.strictEqual(plan.note, 'strategy');
    });

    await ok('3AP: handlePlan returns ok with stepCount', async () => {
        const ctx = await makeCtx('3AP-handler-ok');
        const r = await handlePlan({ steps: ['Do A', 'Do B', 'Do C'] }, ctx);
        assert.ok(r.ok !== false, `expected ok: ${r.error}`);
        const payload = JSON.parse(r.modelPayload);
        assert.strictEqual(payload.stepCount, 3);
    });

    await ok('3AP: handlePlan persists to workDir', async () => {
        const ctx = await makeCtx('3AP-handler-persists');
        await handlePlan({ steps: ['X', 'Y'], note: 'n' }, ctx);
        const plan = await ctx.workDir.loadPlan();
        assert.deepStrictEqual(plan.steps, ['X', 'Y']);
    });

    await ok('3AP: handlePlan rejects fewer than 2 steps', async () => {
        const ctx = await makeCtx('3AP-too-few');
        const r = await handlePlan({ steps: ['only one'] }, ctx);
        assert.strictEqual(r.ok, false);
    });

    await ok('3AP: handlePlan rejects more than 10 steps', async () => {
        const ctx = await makeCtx('3AP-too-many');
        const r = await handlePlan({ steps: Array(11).fill('s') }, ctx);
        assert.strictEqual(r.ok, false);
    });

    await ok('3AP: dispatchFairyTool handles plan', async () => {
        const ctx = await makeCtx('3AP-dispatch');
        const r = await dispatchFairyTool({ name: 'plan', args: { steps: ['A', 'B'] } }, ctx);
        assert.ok(r.ok !== false, `expected ok: ${r.error}`);
    });
}

// ── 3C: probe does NOT prepend utils (M6) ─────────────────────────────────────

async function run3C() {
    console.log('\n── 3C: probe does NOT prepend utils (M6) ──');

    await ok('3C: handleProbe does NOT prepend util bodies to kernel code', async () => {
        const ctx = await makeCtx('3C-no-prepend', { ok: true, value: '6', messages: [] });
        // Register a utility — it lives in the persistent kernel, not re-pasted per probe
        await ctx.workDir.addUtil({ name: 'triple', code: 'triple[x_]:=3x', note: 'triple' });
        // A probe that calls the util by name
        await handleProbe({ code: 'triple[2]', note: 'should call util by name' }, ctx);
        const sent = ctx.shim._lastExpression;
        assert.ok(!sent.includes('triple[x_]:=3x'), `util body must NOT be prepended, got: ${sent}`);
        assert.strictEqual(sent.trim(), 'triple[2]', `only the probe code is sent, got: ${sent}`);
    });

    await ok('3C: handleProbe with no utils sends only probe code', async () => {
        const ctx = await makeCtx('3C-no-utils', { ok: true, value: '4', messages: [] });
        await handleProbe({ code: '2+2', note: 'plain' }, ctx);
        const sent = ctx.shim._lastExpression;
        assert.strictEqual(sent.trim(), '2+2', 'probe code sent verbatim');
    });
}

// ── 3D: handleChain includes utilities ───────────────────────────────────────

async function run3D() {
    console.log('\n── 3D: handleChain includes utilities ──');

    await ok('3D: chain response includes utilities array', async () => {
        const ctx = await makeCtx('3D-chain');
        await ctx.workDir.addUtil({ name: 'myFn', code: 'myFn[x_]:=x', note: 'identity fn' });
        const r = await handleChain({}, ctx);
        assert.ok(r.ok !== false, `expected ok: ${r.error}`);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(Array.isArray(payload.utilities), 'utilities should be an array');
        assert.strictEqual(payload.utilities.length, 1);
        assert.strictEqual(payload.utilities[0].name, 'myFn');
        assert.ok('note' in payload.utilities[0], 'should include note');
    });

    await ok('3D: chain response utilities is empty array when no utils', async () => {
        const ctx = await makeCtx('3D-chain-empty');
        const r = await handleChain({}, ctx);
        assert.ok(r.ok !== false, `expected ok: ${r.error}`);
        const payload = JSON.parse(r.modelPayload);
        assert.deepStrictEqual(payload.utilities, []);
    });
}

// ── 3E: SteerQueue ────────────────────────────────────────────────────────────

async function run3E() {
    console.log('\n── 3E: SteerQueue ──');

    await ok('3E: drain returns null when empty', async () => {
        const q = new SteerQueue();
        assert.strictEqual(q.drain(), null);
    });

    await ok('3E: push + drain returns message', async () => {
        const q = new SteerQueue();
        q.push('try a different approach');
        assert.strictEqual(q.drain(), 'try a different approach');
    });

    await ok('3E: drain is FIFO', async () => {
        const q = new SteerQueue();
        q.push('first');
        q.push('second');
        assert.strictEqual(q.drain(), 'first');
        assert.strictEqual(q.drain(), 'second');
    });

    await ok('3E: drain returns null after all consumed', async () => {
        const q = new SteerQueue();
        q.push('only one');
        q.drain();
        assert.strictEqual(q.drain(), null);
    });

    await ok('3E: multiple pushes drain in order', async () => {
        const q = new SteerQueue();
        for (let i = 0; i < 5; i++) q.push(`msg${i}`);
        for (let i = 0; i < 5; i++) assert.strictEqual(q.drain(), `msg${i}`);
        assert.strictEqual(q.drain(), null);
    });
}

// ── 3F: EXPLORE_FAIRY_TOOL_SPECS has 10 tools ────────────────────────────────

async function run3F() {
    console.log('\n── 3F: EXPLORE_FAIRY_TOOL_SPECS ──');

    await ok('3F: EXPLORE_FAIRY_TOOL_SPECS is an array', async () => {
        assert.ok(Array.isArray(EXPLORE_FAIRY_TOOL_SPECS));
    });

    await ok('3F: EXPLORE_FAIRY_TOOL_SPECS has at least 11 tools', async () => {
        // Exact count is intentionally not asserted — new tools may be added.
        // The meaningful checks are the includes/excludes below.
        assert.ok(EXPLORE_FAIRY_TOOL_SPECS.length >= 11,
            `expected >= 11, got ${EXPLORE_FAIRY_TOOL_SPECS.length}: ${EXPLORE_FAIRY_TOOL_SPECS.map(t=>t.function.name).join(', ')}`);
    });

    await ok('3F: EXPLORE_FAIRY_TOOL_SPECS includes plan', async () => {
        const names = EXPLORE_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(names.includes('plan'), `names: ${names.join(', ')}`);
    });

    await ok('3F: EXPLORE_FAIRY_TOOL_SPECS includes define_util', async () => {
        const names = EXPLORE_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(names.includes('define_util'), `names: ${names.join(', ')}`);
    });

    await ok('3F: EXPLORE_FAIRY_TOOL_SPECS includes checkpoint', async () => {
        const names = EXPLORE_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(names.includes('checkpoint'), `names: ${names.join(', ')}`);
    });

    await ok('3F: EXPLORE_FAIRY_TOOL_SPECS excludes run_clean', async () => {
        const names = EXPLORE_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(!names.includes('run_clean'), 'run_clean should not be in explore spec');
    });

    await ok('3F: EXPLORE_FAIRY_TOOL_SPECS excludes edit_cell', async () => {
        const names = EXPLORE_FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(!names.includes('edit_cell'), 'edit_cell should not be in explore spec');
    });

    await ok('3F: FAIRY_TOOL_SPECS includes define_util', async () => {
        const names = FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(names.includes('define_util'), `full spec names: ${names.join(', ')}`);
    });

    await ok('3F: FAIRY_TOOL_SPECS includes checkpoint', async () => {
        const names = FAIRY_TOOL_SPECS.map(t => t.function.name);
        assert.ok(names.includes('checkpoint'), `full spec names: ${names.join(', ')}`);
    });

    await ok('3F: define_util spec has required params: name, code, note', async () => {
        const spec = FAIRY_TOOL_SPECS.find(t => t.function.name === 'define_util');
        const required = spec.function.parameters.required || [];
        assert.ok(required.includes('name'), 'name required');
        assert.ok(required.includes('code'), 'code required');
        assert.ok(required.includes('note'), 'note required');
    });

    await ok('3F: checkpoint spec has required params: sectionTitle, stepIds', async () => {
        const spec = FAIRY_TOOL_SPECS.find(t => t.function.name === 'checkpoint');
        const required = spec.function.parameters.required || [];
        assert.ok(required.includes('sectionTitle'), 'sectionTitle required');
        assert.ok(required.includes('stepIds'), 'stepIds required');
    });
}

// ── 3G: FAIRY_SYSTEM_PROMPT has rules 23+24 ──────────────────────────────────

async function run3G() {
    console.log('\n── 3G: FAIRY_SYSTEM_PROMPT rules 23+24 ──');

    await ok('3G: prompt contains rule 23 (define_util)', async () => {
        assert.ok(FAIRY_SYSTEM_PROMPT.includes('define_util'),
            'rule 23 should mention define_util');
        assert.ok(/23\./.test(FAIRY_SYSTEM_PROMPT), 'rule 23 should be numbered');
    });

    await ok('3G: prompt contains rule for checkpoint', async () => {
        assert.ok(FAIRY_SYSTEM_PROMPT.includes('checkpoint'),
            'a rule should mention checkpoint');
        assert.ok(/2[456]\./.test(FAIRY_SYSTEM_PROMPT), 'checkpoint rule should be numbered in range 24–26');
    });

    await ok('3G: rule 23 mentions reusable helpers', async () => {
        assert.ok(/reusable|register.*once|call.*by name/i.test(FAIRY_SYSTEM_PROMPT),
            'rule 23 should mention registering reusable helpers');
    });

    await ok('3G: rule 24 mentions clean_in_progress', async () => {
        assert.ok(FAIRY_SYSTEM_PROMPT.includes('clean_in_progress'),
            'rule 24 should mention clean_in_progress.wb');
    });
}

// ── HANDLERS registration ─────────────────────────────────────────────────────

async function run3H() {
    console.log('\n── 3H: HANDLERS registration ──');

    await ok('3H: dispatchFairyTool handles define_util', async () => {
        const ctx = await makeCtx('3H-dispatch-defineutil', { ok: true, value: 'f', messages: [] });
        const r = await dispatchFairyTool({ name: 'define_util', args: { name: 'f', code: 'f[x_]:=x', note: 'id' } }, ctx);
        assert.ok(r.ok !== false, `expected ok: ${r.error}`);
    });

    await ok('3H: dispatchFairyTool handles checkpoint', async () => {
        const ctx = await makeCtx('3H-dispatch-checkpoint');
        await ctx.workDir.addStep({
            id: 's001', probeId: 'p001', code: '1+1', resultRef: 'p001',
            dependsOn: [], usesSymbols: [], definesSymbols: [], note: 'one',
        });
        const r = await dispatchFairyTool({
            name: 'checkpoint',
            args: { sectionTitle: 'Test section', stepIds: ['s001'] },
        }, ctx);
        assert.ok(r.ok !== false, `expected ok: ${r.error}`);
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const allSections = [run3A, run3AP, run3B, run3C, run3D, run3E, run3F, run3G, run3H];
    for (const s of allSections) await s();

    console.log(`\n── Stage 3 Results: ${passCount} passed, ${failCount} failed ──`);
    if (failures.length) {
        for (const { label, err } of failures) {
            console.error(`  [FAIL] ${label}`);
            if (err && err.stack) console.error('    ' + err.stack.split('\n').join('\n    '));
        }
        process.exit(1);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
