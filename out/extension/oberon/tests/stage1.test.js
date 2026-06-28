#!/usr/bin/env node
'use strict';
/**
 * Stage 1 implementation tests.
 *
 * Covers:
 *   1A — handleProbe result/error caps in modelPayload
 *   1B — EXPLORE_FAIRY_TOOL_SPECS structure and completeness
 *   1C — consecutive failure counter logic
 *
 * Run: node out/extension/oberon/tests/stage1.test.js
 * No real Wolfram kernel required.
 */

const os     = require('os');
const path   = require('path');
const fsp    = require('fs/promises');
const assert = require('assert');

// ── Stub vscode ───────────────────────────────────────────────────────────────
const Module = require('module');
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: {
            workspaceFolders: [],
            onDidChangeConfiguration: () => ({ dispose() {} }),
            getConfiguration: () => ({ get: () => undefined }),
        },
        window: {
            showInformationMessage: () => Promise.resolve(),
            showWarningMessage:     () => Promise.resolve(),
            showErrorMessage:       () => Promise.resolve(),
        },
        Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
        EventEmitter: class {
            constructor() { this.event = () => ({ dispose() {} }); }
            fire() {} dispose() {}
        },
    },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve.call(this, req, parent, ...rest);
};

// ── Stub wolframShim ──────────────────────────────────────────────────────────
const _NON_CRITICAL = new Set(['FindRoot::lstol', 'FindRoot::cvmit', 'NIntegrate::ncvb']);
const shimStub = {
    DEFAULT_TIMEOUT: 30,
    MAX_TIMEOUT:     120,
    _next: null,
    // Faithful mini-copy of the real classifier (the real module is cache-stubbed here).
    classifyMessages(text) {
        const tags = [...new Set([...String(text || '').matchAll(/([A-Z][A-Za-z0-9]*::[A-Za-z][A-Za-z0-9]*)/g)].map(m => m[1]))];
        const critical = tags.filter(t => !_NON_CRITICAL.has(t));
        const soft     = tags.filter(t =>  _NON_CRITICAL.has(t));
        return { tags, critical, soft, hasMessages: tags.length > 0, allNonCritical: tags.length > 0 && critical.length === 0 };
    },
    async evalOnce({ expression }) {
        if (this._next !== null) {
            const r = typeof this._next === 'function' ? this._next(expression) : this._next;
            this._next = null;
            return r;
        }
        return { ok: true, kind: 'ok', value: '42', messages: null, prints: null, durationMs: 1 };
    },
};
{
    const shimPath = require.resolve('../core/wolframShim');
    require.cache[shimPath] = {
        id: shimPath, filename: shimPath, loaded: true, exports: shimStub,
    };
}

// ── Load modules ──────────────────────────────────────────────────────────────
const { handleProbe, dispatchFairyTool } = require('../fairy/tools');
const { createWorkDir }                  = require('../fairy/workDir');
const {
    FAIRY_TOOL_SPECS,
    EXPLORE_FAIRY_TOOL_SPECS,
    POLISH_FAIRY_TOOL_SPECS,
    FAILED_PROBE_TOOL_SPECS,
} = require('../fairy/toolSpecs');

// ── Test harness ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
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
function eq(a, b, msg)  { assert.deepStrictEqual(a, b, msg); }
function ok(v, msg)     { assert.ok(v, msg); }
function notOk(v, msg)  { assert.ok(!v, msg); }

async function makeTmpDir(label) {
    const dir = path.join(os.tmpdir(), `stage1_test_${label}_${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

async function makeCtx(label, shimOverride) {
    const dir = await makeTmpDir(label);
    const wd  = await createWorkDir(dir);
    return {
        workDir: wd,
        shim: shimOverride || shimStub,
        signal: null,
        getWorkingNbDoc: () => null,
        fsm: {
            canProbe: () => true,
            consumeProbe: () => {},
            getBudgetStatus: () => ({}),
        },
    };
}

(async () => {

// ══════════════════════════════════════════════════════════════════════════════
// 1A
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 1A: Probe result caps ──');

await t('1A: successful probe with small value -> full value in resultPreview', async () => {
    const ctx = await makeCtx('1a_small_ok');
    shimStub._next = { ok: true, kind: 'ok', value: '42', messages: null, prints: null, durationMs: 1 };
    const r = await handleProbe({ code: '6*7', note: 'test' }, ctx);
    ok(r.ok, `should be ok, got: ${r.error}`);
    const d = JSON.parse(r.modelPayload);
    eq(d.resultPreview, '42');
    notOk(d.previewTruncated, 'should not be truncated for small value');
});

await t('1A: successful probe with large value (>400 chars) -> truncated in modelPayload', async () => {
    const ctx = await makeCtx('1a_large_ok');
    const bigValue = 'x'.repeat(1000);
    shimStub._next = { ok: true, kind: 'ok', value: bigValue, messages: null, prints: null, durationMs: 1 };
    const r = await handleProbe({ code: 'Table[x,{1000}]', note: 'test' }, ctx);
    ok(r.ok, `should be ok, got: ${r.error}`);
    const d = JSON.parse(r.modelPayload);
    // resultPreview is sliced at VALUE_LIMIT (400); the hint is in previewTruncated
    ok(d.resultPreview.length <= 400,
        `resultPreview length ${d.resultPreview.length} should be <= 400`);
    ok(d.previewTruncated, 'previewTruncated should be set');
    ok(String(d.previewTruncated).includes('1000'), 'previewTruncated should mention original length');
    const probe = await ctx.workDir.getProbe('p001');
    eq(probe.value.length, 1000, 'full value preserved on disk');
});

await t('1A: full value preserved on disk even when truncated in payload', async () => {
    const ctx = await makeCtx('1a_disk');
    const bigValue = 'A'.repeat(800);
    shimStub._next = { ok: true, kind: 'ok', value: bigValue, messages: null, prints: null, durationMs: 1 };
    await handleProbe({ code: 'someExpr', note: 'test' }, ctx);
    const probe = await ctx.workDir.getProbe('p001');
    eq(probe.value, bigValue, 'disk value is full, not truncated');
});

await t('1A: failed probe with large messages -> capped in modelPayload', async () => {
    const ctx = await makeCtx('1a_fail_msgs');
    const bigMessages = 'Error::msg: ' + 'x'.repeat(2000);
    shimStub._next = { ok: false, kind: 'messages', value: bigMessages, messages: bigMessages, error: 'messages', prints: null, durationMs: 1 };
    const r = await handleProbe({ code: 'badCode[]', note: 'test', prevAnalysis: 'prior probe showed 42' }, ctx);
    notOk(r.ok, 'should be failed');
    const d = JSON.parse(r.modelPayload);
    // 400 cap + suffix up to ~60 chars
    ok(typeof d.error === 'string' && d.error.length <= 470,
        `error field length ${typeof d.error === 'string' ? d.error.length : 'n/a'} should be <= 470`);
    if (d.messages && typeof d.messages === 'string') {
        ok(d.messages.length <= 470,
            `messages field length ${d.messages.length} should be <= 470`);
    }
});

await t('1A: failed probe with short error -> not truncated', async () => {
    const ctx = await makeCtx('1a_fail_short');
    shimStub._next = { ok: false, kind: 'eval_error', value: null, messages: null, error: 'short error', prints: null, durationMs: 1 };
    const r = await handleProbe({ code: 'broken', note: 'test', prevAnalysis: 'prev showed 42' }, ctx);
    notOk(r.ok, 'should be failed');
    const d = JSON.parse(r.modelPayload);
    ok(d.error && d.error.startsWith('short'),
        `short error should not be truncated, got: ${d.error}`);
});

await t('1A: truncated error contains inspect hint', async () => {
    const ctx = await makeCtx('1a_inspect_hint');
    const bigMessages = 'Warning::msg: ' + 'y'.repeat(2000);
    shimStub._next = { ok: false, kind: 'messages', value: bigMessages, messages: bigMessages, error: 'messages', prints: null, durationMs: 1 };
    const r = await handleProbe({ code: 'warnCode[]', note: 'test', prevAnalysis: 'prior ok' }, ctx);
    const d = JSON.parse(r.modelPayload);
    const errStr = d.error || '';
    if (errStr.length > 400) {
        ok(errStr.includes('inspect') || errStr.includes('chars total'),
            'truncated error should mention inspect or total chars');
    }
});

await t('1A: prints field capped in successful probe', async () => {
    const ctx = await makeCtx('1a_prints');
    const bigPrints = 'Print: ' + 'p'.repeat(1000);
    shimStub._next = { ok: true, kind: 'ok', value: '1', messages: null, prints: bigPrints, durationMs: 1 };
    const r = await handleProbe({ code: 'Print["x"]; 1', note: 'test' }, ctx);
    ok(r.ok, `should be ok: ${r.error}`);
    const d = JSON.parse(r.modelPayload);
    if (d.prints && typeof d.prints === 'string') {
        ok(d.prints.length <= 470,
            `prints in payload should be <= 470 chars, got ${d.prints.length}`);
    }
    const probe = await ctx.workDir.getProbe('p001');
    eq(probe.prints, bigPrints, 'full prints preserved on disk');
});

// ══════════════════════════════════════════════════════════════════════════════
// 1B
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 1B: EXPLORE_FAIRY_TOOL_SPECS ──');

const exploreNames = new Set(EXPLORE_FAIRY_TOOL_SPECS.map(tt => tt.function.name));
const polishNames  = new Set(POLISH_FAIRY_TOOL_SPECS.map(tt => tt.function.name));
const failedNames  = new Set(FAILED_PROBE_TOOL_SPECS.map(tt => tt.function.name));

await t('1B: EXPLORE_FAIRY_TOOL_SPECS is defined and non-empty', () => {
    ok(Array.isArray(EXPLORE_FAIRY_TOOL_SPECS), 'should be an array');
    ok(EXPLORE_FAIRY_TOOL_SPECS.length > 0, 'should have tools');
});

await t('1B: run_clean absent from explore spec', () => {
    notOk(exploreNames.has('run_clean'), 'run_clean must not be in explore spec');
});

await t('1B: edit_cell absent from explore spec', () => {
    notOk(exploreNames.has('edit_cell'), 'edit_cell must not be in explore spec');
});

await t('1B: core tools present in explore spec', () => {
    const required = ['probe', 'inspect', 'lookup', 'record', 'assume', 'chain', 'invalidate', 'finalize'];
    for (const name of required) {
        ok(exploreNames.has(name), `explore spec must include '${name}'`);
    }
});

await t('1B: explore descriptions are shorter than full descriptions', () => {
    let shorterCount = 0;
    for (const expTool of EXPLORE_FAIRY_TOOL_SPECS) {
        const fullTool = FAIRY_TOOL_SPECS.find(tt => tt.function.name === expTool.function.name);
        if (fullTool) {
            if (expTool.function.description.length < fullTool.function.description.length) shorterCount++;
        }
    }
    ok(shorterCount >= 4, `at least 4 tools should have shorter descriptions; got ${shorterCount}`);
});

await t('1B: explore spec total description chars < full spec', () => {
    const exploreChars = EXPLORE_FAIRY_TOOL_SPECS.reduce((s, tt) => s + tt.function.description.length, 0);
    const fullChars    = FAIRY_TOOL_SPECS.reduce((s, tt) => s + tt.function.description.length, 0);
    ok(exploreChars < fullChars,
        `explore descriptions (${exploreChars} chars) should be < full (${fullChars} chars)`);
    console.log(`     explore: ${exploreChars} chars  full: ${fullChars} chars  save: ${fullChars - exploreChars}`);
});

await t('1B: all explore tools have valid type/name/description/parameters', () => {
    for (const tool of EXPLORE_FAIRY_TOOL_SPECS) {
        ok(tool.type === 'function',
            `type should be 'function' for ${tool.function && tool.function.name}`);
        ok(tool.function && tool.function.name, 'function.name required');
        ok(tool.function.description, 'function.description required');
        ok(tool.function.parameters && tool.function.parameters.type === 'object',
            `parameters.type should be object for ${tool.function.name}`);
    }
});

await t('1B: explore spec schemas identical to full spec schemas', () => {
    for (const expTool of EXPLORE_FAIRY_TOOL_SPECS) {
        const fullTool = FAIRY_TOOL_SPECS.find(tt => tt.function.name === expTool.function.name);
        if (fullTool) {
            const expSchema  = JSON.stringify(expTool.function.parameters);
            const fullSchema = JSON.stringify(fullTool.function.parameters);
            eq(expSchema, fullSchema,
                `parameters schema must be identical for '${expTool.function.name}'`);
        }
    }
});

await t('1B: explore spec is frozen', () => {
    ok(Object.isFrozen(EXPLORE_FAIRY_TOOL_SPECS), 'EXPLORE_FAIRY_TOOL_SPECS should be frozen');
});

await t('1B: run_clean still present in polish spec', () => {
    ok(polishNames.has('run_clean'), 'run_clean should still be in polish spec');
});

await t('1B: FAILED_PROBE_TOOL_SPECS is amend_probe + probe + lookup (R7)', () => {
    const sorted = [...failedNames].sort();
    eq(sorted, ['amend_probe', 'lookup', 'probe'], 'failed probe spec: amend_probe + probe + lookup');
});

// ══════════════════════════════════════════════════════════════════════════════
// 1C
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 1C: Consecutive failure counter ──');

await t('1C: handleProbe returns ok:false on kernel eval_error', async () => {
    const ctx = await makeCtx('1c_fail');
    shimStub._next = { ok: false, kind: 'eval_error', value: null, messages: null, error: 'syntax error', prints: null, durationMs: 1 };
    // NB: code must be lint-clean (balanced) so it reaches the kernel stub; the
    // forced eval_error from shimStub is what we are asserting on, not a syntax slip.
    const r = await handleProbe({ code: 'badCall[1]', note: 'test', prevAnalysis: 'prior ok' }, ctx);
    notOk(r.ok, 'should be ok:false');
    eq(r.kind, 'eval_error');
});

await t('1C: handleProbe returns ok:false when messages present', async () => {
    const ctx = await makeCtx('1c_msg');
    await ctx.workDir.saveProbe('p001', { code: 'x', ok: true, value: '1', messages: null, prints: null, durationMs: 1, structuralSummary: {}, error: null });
    shimStub._next = { ok: true, kind: 'ok', value: 'something', messages: 'Rule::rhs: warning', prints: null, durationMs: 1 };
    const r = await handleProbe({ code: 'f[x_] := x', note: 'test', prevAnalysis: 'p001 returned 1' }, ctx);
    notOk(r.ok, 'probe with messages should be ok:false');
    eq(r.kind, 'messages');
});

await t('1C: handleProbe returns ok:true on clean eval', async () => {
    const ctx = await makeCtx('1c_ok');
    shimStub._next = { ok: true, kind: 'ok', value: '100', messages: null, prints: null, durationMs: 1 };
    const r = await handleProbe({ code: '10^2', note: 'test' }, ctx);
    ok(r.ok, `should be ok:true, got: ${r.error}`);
});

await t('1C: counter simulation -- resets to 0 after success', () => {
    let consecutiveFailures = 0;
    consecutiveFailures++;
    consecutiveFailures++;
    eq(consecutiveFailures, 2);
    consecutiveFailures = 0;
    eq(consecutiveFailures, 0, 'counter should reset on success');
});

await t('1C: counter simulation -- fires at exactly 3 and resets', () => {
    let consecutiveFailures = 0;
    let interventions = 0;
    const THRESHOLD = 3;
    for (let i = 0; i < 5; i++) {
        consecutiveFailures++;
        if (consecutiveFailures >= THRESHOLD) {
            interventions++;
            consecutiveFailures = 0;
        }
    }
    eq(interventions, 1, 'should fire exactly once for 5 consecutive failures');
    eq(consecutiveFailures, 2, 'remaining 2 failures after reset');
});

await t('1C: counter simulation -- fires independently per group', () => {
    let consecutiveFailures = 0;
    let interventions = 0;
    const THRESHOLD = 3;
    const outcomes = ['fail','fail','fail', 'ok', 'fail','fail','fail', 'ok'];
    for (const outcome of outcomes) {
        if (outcome === 'fail') {
            consecutiveFailures++;
            if (consecutiveFailures >= THRESHOLD) {
                interventions++;
                consecutiveFailures = 0;
            }
        } else {
            consecutiveFailures = 0;
        }
    }
    eq(interventions, 2, 'should fire twice: once per block of 3 failures');
});

await t('1C: dispatchFairyTool: probe tool dispatches to handleProbe (integration)', async () => {
    const ctx = await makeCtx('1c_dispatch');
    shimStub._next = { ok: true, kind: 'ok', value: '99', messages: null, prints: null, durationMs: 1 };
    const r = await dispatchFairyTool({ name: 'probe', args: { code: '9^2', note: 'test' } }, ctx);
    // dispatchFairyTool returns the raw handleProbe result
    ok(r.ok, `probe via dispatchFairyTool should be ok, got: ${r && r.error}`);
    const d = JSON.parse(r.modelPayload);
    eq(d.resultPreview, '99', 'should contain the evaluated result');
});

await t('1C: dispatchFairyTool: budget consumption is in fairy.js not tools.js', async () => {
    // consumeProbe is called in fairy.js runModelTurns after dispatchFairyTool returns.
    // Here we verify that: (a) handleProbe result has ok:true for success, ok:false for fail,
    // so that fairy.js can decide whether to call consumeProbe.
    const ctx1 = await makeCtx('1c_ok_flag');
    shimStub._next = { ok: true, kind: 'ok', value: '1', messages: null, prints: null, durationMs: 1 };
    const rOk = await dispatchFairyTool({ name: 'probe', args: { code: '1', note: 'test' } }, ctx1);
    ok(rOk.ok === true, 'successful probe result should have ok:true');

    const ctx2 = await makeCtx('1c_fail_flag');
    shimStub._next = { ok: false, kind: 'eval_error', value: null, messages: null, error: 'oops', prints: null, durationMs: 1 };
    const rFail = await dispatchFairyTool({ name: 'probe', args: { code: 'bad(', note: 'test', prevAnalysis: 'prior ok' } }, ctx2);
    ok(rFail.ok === false, 'failed probe result should have ok:false');
});

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n── Stage 1 Results: ${pass} passed, ${fail} failed ──`);
if (failures.length) {
    console.error('\nFailed tests:');
    for (const f of failures) console.error(`  x ${f.name}: ${f.error}`);
}
process.exit(fail > 0 ? 1 : 0);

})();
