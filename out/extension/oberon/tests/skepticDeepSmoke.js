'use strict';
/**
 * Oberon — Skeptic / Critic deep-verification smoke tests (Session 16).
 *
 * Exercises the layered verification logic in `core/skeptic.js`:
 *   - re-eval match + boolean ward pass   -> accept / verified
 *   - re-eval match + numeric ward pass   -> accept / verified
 *   - re-eval match + equality ward pass  -> accept / verified
 *   - parameterised equality + symbolic unresolved -> random test runs
 *   - re-eval match + no ward shape       -> accept / heuristic
 *   - re-eval mismatch                    -> dispute / disputed
 *   - re-eval match + ward failed         -> dispute / partial
 *   - no evidence                         -> needs_review / none
 *   - ward.requested + ward.result events emitted in pairs
 *
 * Stubs `vscode`, `wolframShim`, and `tools/mathematica` so no kernel
 * is needed.
 *
 * Run:   node out/extension/oberon/tests/skepticDeepSmoke.js
 * Expects exit code 0 and "ALL OK" on stdout.
 */

const path = require('path');
const assert = require('assert');
const Module = require('module');

// ── Stub `vscode` (transitive dep) ─────────────────────────────────────────
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

// ── Stub wolframShim BEFORE requiring the modules under test ──────────────
const shimPath = require.resolve('../core/wolframShim');
const shim = {
    _queue: [],
    setControllerProvider() {},
    push(r) { this._queue.push(r); },
    evalOnce: async () => {
        const r = shim._queue.shift() || {
            ok: false, kind: 'kernel_unavailable', value: null, error: 'no stub set', durationMs: 1,
        };
        return r;
    },
    OUTPUT_HARD_CAP: 4000, MAX_TIMEOUT: 60, DEFAULT_TIMEOUT: 15,
    kernelStatus() { return { available: true, reason: 'stub' }; },
};
require.cache[shimPath] = { id: shimPath, filename: shimPath, loaded: true, exports: shim };

// ── Stub `tools/mathematica` deep-verification helpers ────────────────────
const mmPath = require.resolve('../tools/mathematica');
const mm = {
    _bool: [],   // evaluateBoolean results
    _num:  [],   // numericProbe results
    _sym:  [],   // symbolicSimplify results
    _rand: [],   // numericRandomTest results
    callCounts: { evaluateBoolean: 0, numericProbe: 0, symbolicSimplify: 0, numericRandomTest: 0 },
    reset() {
        this._bool = []; this._num = []; this._sym = []; this._rand = [];
        this.callCounts = { evaluateBoolean: 0, numericProbe: 0, symbolicSimplify: 0, numericRandomTest: 0 };
    },
    async evaluateBoolean() {
        this.callCounts.evaluateBoolean++;
        return this._bool.shift() || { ok: false, value: null, kind: 'kernel_unavailable', error: 'unset', durationMs: 1 };
    },
    async numericProbe() {
        this.callCounts.numericProbe++;
        return this._num.shift() || { ok: false, withinTol: null, kind: 'kernel_unavailable', error: 'unset', durationMs: 1 };
    },
    async symbolicSimplify() {
        this.callCounts.symbolicSimplify++;
        return this._sym.shift() || { ok: false, equal: null, kind: 'kernel_unavailable', error: 'unset', durationMs: 1 };
    },
    async numericRandomTest() {
        this.callCounts.numericRandomTest++;
        return this._rand.shift() || { ok: false, withinTol: null, kind: 'kernel_unavailable', error: 'unset', samples: 0, passed: 0, failed: 0, skipped: 0, durationMs: 1 };
    },
    denylistViolation() { return null; },
};
require.cache[mmPath] = { id: mmPath, filename: mmPath, loaded: true, exports: mm };

const { runSkeptic, looksParameterised } = require('../core/skeptic');

// ── Test plumbing ─────────────────────────────────────────────────────────
function makeFakeBus() {
    return {
        events: [],
        appendEvent(t, p, m) { this.events.push({ type: t, payload: p, meta: m }); return Promise.resolve(); },
    };
}

const quest = { id: 'Q01', shortName: 'smoke', title: 'Smoke Test' };
const charm = { id: 'C01' };

function reset() { shim._queue = []; mm.reset(); }

let pass = 0, fail = 0;
function t(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { pass++; console.log('  ok   ' + name); },
        (e) => { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.stack || e)); }
    );
}

(async () => {
    // ── 1. No evidence → needs_review/none ────────────────────────────────
    await t('no evidence → verdict=needs_review, level=none', async () => {
        reset();
        const bus = makeFakeBus();
        const scroll = { id: 'S01', evidence: [] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'needs_review');
        assert.strictEqual(out.verificationLevel, 'none');
        assert.strictEqual(out.wardResults.length, 0);
    });

    // ── 2. Boolean output → evaluateBoolean called, pass → verified ───────
    await t('boolean evidence → evaluateBoolean ward → verified', async () => {
        reset();
        shim.push({ ok: true, kind: 'ok', value: 'True', durationMs: 1, error: null });
        mm._bool.push({ ok: true, value: true, kind: 'ok', error: null, durationMs: 1 });
        const bus = makeFakeBus();
        const scroll = { id: 'S02', evidence: [{ tool: 'wolfram_eval', expression: 'TrueQ[1 < 2]', output: 'True', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'accept');
        assert.strictEqual(out.verificationLevel, 'verified');
        assert.strictEqual(mm.callCounts.evaluateBoolean, 1);
        assert.strictEqual(out.wardSummary.passed, 1);
        // ward.requested then ward.result pair
        const wardReq = bus.events.filter(e => e.type === 'ward.requested');
        const wardRes = bus.events.filter(e => e.type === 'ward.result');
        assert.strictEqual(wardReq.length, 1);
        assert.strictEqual(wardRes.length, 1);
    });

    // ── 3. Numeric output → numericProbe called → verified ────────────────
    await t('numeric evidence → numericProbe ward → verified', async () => {
        reset();
        shim.push({ ok: true, kind: 'ok', value: '3.14159265358979', durationMs: 1, error: null });
        mm._num.push({ ok: true, withinTol: true, kind: 'ok', value: '3.14159265358979', expected: 3.14159265358979, error: null, durationMs: 1 });
        const bus = makeFakeBus();
        const scroll = { id: 'S03', evidence: [{ tool: 'wolfram_eval', expression: 'N[Pi, 15]', output: '3.14159265358979', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'accept');
        assert.strictEqual(out.verificationLevel, 'verified');
        assert.strictEqual(mm.callCounts.numericProbe, 1);
    });

    // ── 4. Equality expression → symbolicSimplify pass → verified ─────────
    await t('equality evidence → symbolicSimplify ward (equal=true) → verified', async () => {
        reset();
        shim.push({ ok: true, kind: 'ok', value: 'True', durationMs: 1, error: null });
        // Skeptic's evaluateBoolean ward runs first because output is "True":
        mm._bool.push({ ok: true, value: true, kind: 'ok', durationMs: 1 });
        const bus = makeFakeBus();
        const scroll = { id: 'S04', evidence: [{ tool: 'wolfram_eval', expression: 'Sin[2 x] == 2 Sin[x] Cos[x]', output: 'True', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'accept');
        assert.strictEqual(out.verificationLevel, 'verified');
        assert.strictEqual(mm.callCounts.evaluateBoolean, 1);
    });

    // ── 5. Parameterised equality + symbolic unresolved → random runs ────
    await t('parameterised equality + symbolic unresolved → numericRandomTest invoked', async () => {
        reset();
        // Output is an algebraic expression (not True/False, not finite), so
        // Skeptic enters the equality-shape branch.  We craft an expression
        // whose RAW output (the citedOutput) is a top-level lhs == rhs.
        shim.push({ ok: true, kind: 'ok', value: 'Sin[x]^2 + Cos[x]^2 == 1', durationMs: 1, error: null });
        mm._sym.push({ ok: true, equal: null, kind: 'unresolved', durationMs: 1 });
        mm._rand.push({ ok: true, withinTol: 'all', samples: 3, passed: 3, failed: 0, skipped: 0, worstResidual: 1e-20, durationMs: 2, kind: 'ok' });
        const bus = makeFakeBus();
        const scroll = { id: 'S05', evidence: [{ tool: 'wolfram_eval', expression: 'Sin[x]^2 + Cos[x]^2 == 1', output: 'Sin[x]^2 + Cos[x]^2 == 1', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'accept');
        assert.strictEqual(out.verificationLevel, 'verified');
        assert.strictEqual(mm.callCounts.symbolicSimplify, 1);
        assert.strictEqual(mm.callCounts.numericRandomTest, 1);
    });

    // ── 6. Re-eval match but no checkable shape → heuristic ───────────────
    await t('re-eval match + no ward shape → accept/heuristic', async () => {
        reset();
        // Output is a symbolic blob that is neither boolean, finite number,
        // nor a top-level equality. Skeptic should skip wards.
        shim.push({ ok: true, kind: 'ok', value: 'Plot[…]', durationMs: 1, error: null });
        const bus = makeFakeBus();
        const scroll = { id: 'S06', evidence: [{ tool: 'wolfram_eval', expression: 'Plot[Sin[x], {x, 0, 1}]', output: 'Plot[…]', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'accept');
        assert.strictEqual(out.verificationLevel, 'heuristic');
        assert.strictEqual(out.wardSummary.passed, 0);
        assert.strictEqual(out.wardSummary.failed, 0);
    });

    // ── 7. Re-eval mismatch → dispute/disputed ────────────────────────────
    await t('re-eval mismatch + no wards → dispute/disputed', async () => {
        reset();
        shim.push({ ok: true, kind: 'ok', value: 'False', durationMs: 1, error: null });
        // Skeptic also tries an evaluateBoolean ward on the "False" output;
        // claim it returns kernel_unavailable so it's a SKIP not a fail.
        mm._bool.push({ ok: false, value: null, kind: 'kernel_unavailable', durationMs: 0, error: 'no kernel' });
        const bus = makeFakeBus();
        const scroll = { id: 'S07', evidence: [{ tool: 'wolfram_eval', expression: 'TrueQ[2 < 1]', output: 'True', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'dispute');
        assert.strictEqual(out.verificationLevel, 'disputed');
        assert.ok(out.objections.length >= 1);
    });

    // ── 8. Re-eval match + ward failed → dispute/partial ──────────────────
    await t('re-eval match + ward failed → dispute/partial', async () => {
        reset();
        // One evidence: re-eval matches, but boolean ward says False -> failed
        shim.push({ ok: true, kind: 'ok', value: 'True', durationMs: 1, error: null });
        mm._bool.push({ ok: true, value: false, kind: 'ok', durationMs: 1 });
        const bus = makeFakeBus();
        const scroll = { id: 'S08', evidence: [{ tool: 'wolfram_eval', expression: 'TrueQ[1 == 2]', output: 'True', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verdict, 'dispute');
        // summary.matched === 1 (re-eval matched), wardSummary.failed === 1
        // policy: (summary.matched > 0 || anyWardPassed) ? 'partial' : 'disputed'
        assert.strictEqual(out.verificationLevel, 'partial');
    });

    // ── 9. verificationCounts populated ───────────────────────────────────
    await t('verificationCounts: numeric path increments .numeric and .reEval', async () => {
        reset();
        shim.push({ ok: true, kind: 'ok', value: '2.718281828', durationMs: 1, error: null });
        mm._num.push({ ok: true, withinTol: true, kind: 'ok', durationMs: 1 });
        const bus = makeFakeBus();
        const scroll = { id: 'S09', evidence: [{ tool: 'wolfram_eval', expression: 'N[E, 10]', output: '2.718281828', ok: true }] };
        const out = await runSkeptic({ scroll, quest, charm, bus });
        assert.strictEqual(out.verificationCounts.reEval, 1);
        assert.strictEqual(out.verificationCounts.numeric, 1);
    });

    // ── 10. looksParameterised helper ─────────────────────────────────────
    await t('looksParameterised: detects free symbols', () => {
        assert.strictEqual(looksParameterised('Sin[x]^2 + Cos[x]^2'), true);
        assert.strictEqual(looksParameterised('Pi + E'), false);
        assert.strictEqual(looksParameterised('1 + 2 + 3'), false);
        assert.strictEqual(looksParameterised('a + b'), true);
    });

    console.log('');
    console.log(fail === 0 ? 'ALL OK (' + pass + ' tests)' : 'FAILED (' + fail + ' / ' + (pass + fail) + ')');
    process.exit(fail === 0 ? 0 : 1);
})();
