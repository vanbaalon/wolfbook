'use strict';
/**
 * Oberon — Ward verification smoke tests (MVP-4).
 *
 * Standalone Node tests for the *pure* helpers in `tools/mathematica.js` and
 * `core/wards.js` that do not require a live Wolfram kernel:
 *   - denylistViolation
 *   - splitTopLevelEquality
 *   - parseFiniteNumber
 *
 * For the kernel-coupled checks (symbolic identity, numeric probe, abort,
 * kernel-offline behaviour) the test stubs `wolframShim` so the verification
 * primitives can be exercised without a real kernel.
 *
 * Run:   node out/extension/oberon/tests/wardsSmoke.js
 * Expects exit code 0 and "ALL OK" on stdout.
 */

const path = require('path');
const assert = require('assert');

// Stub `vscode` (required transitively via telemetry/bus -> memory/project).
const Module = require('module');
const fakeVscodeId = path.resolve(__dirname, '_fakeVscode.js');
require.cache[fakeVscodeId] = {
    id: fakeVscodeId, filename: fakeVscodeId, loaded: true,
    exports: {
        workspace: { workspaceFolders: [], onDidChangeConfiguration: () => ({ dispose() {} }), getConfiguration: () => ({ get: () => undefined, update: () => Promise.resolve() }) },
        window:    { showInformationMessage: () => Promise.resolve(), showWarningMessage: () => Promise.resolve(), showErrorMessage: () => Promise.resolve() },
        Uri:       { file: (p) => ({ fsPath: p, toString: () => p }) },
        EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} dispose(){} },
    },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return fakeVscodeId;
    return origResolve.call(this, req, parent, ...rest);
};

// Stub wolframShim BEFORE requiring the modules under test.
const shimPath = require.resolve('../core/wolframShim');
const stub = {
    _next: null,
    setControllerProvider() {},
    evalOnce: async () => {
        const r = stub._next || { ok: false, kind: 'kernel_unavailable', value: null, error: 'no stub set', durationMs: 1 };
        stub._next = null;
        return r;
    },
    OUTPUT_HARD_CAP: 4000, MAX_TIMEOUT: 60, DEFAULT_TIMEOUT: 15,
    kernelStatus() { return { available: false, reason: 'stub' }; },
};
require.cache[shimPath] = { id: shimPath, filename: shimPath, loaded: true, exports: stub };

const mathematica = require('../tools/mathematica');
const wards       = require('../core/wards');

let pass = 0, fail = 0;
function t(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { pass++; console.log('  ok   ' + name); },
        (e) => { fail++; console.log('  FAIL ' + name + ' \u2014 ' + (e && e.message || e)); }
    );
}

(async () => {
    // ── pure helpers ───────────────────────────────────────────────────────
    await t('denylist: blocks Run[', () => {
        assert.strictEqual(mathematica.denylistViolation('Run["rm -rf"]'), 'Run[');
    });
    await t('denylist: allows benign Plus', () => {
        assert.strictEqual(mathematica.denylistViolation('Plus[1,2]'), null);
    });
    await t('splitTopLevelEquality: top-level a == b', () => {
        const r = wards.splitTopLevelEquality('Sin[x]^2 + Cos[x]^2 == 1');
        assert.deepStrictEqual(r, { lhs: 'Sin[x]^2 + Cos[x]^2', rhs: '1' });
    });
    await t('splitTopLevelEquality: ignores === and != and >=', () => {
        assert.strictEqual(wards.splitTopLevelEquality('a === b'), null);
        assert.strictEqual(wards.splitTopLevelEquality('a >= b'), null);
        assert.strictEqual(wards.splitTopLevelEquality('a != b'), null);
    });
    await t('splitTopLevelEquality: skips == nested in brackets', () => {
        assert.strictEqual(wards.splitTopLevelEquality('f[a == b]'), null);
    });
    await t('parseFiniteNumber: 3.14', () => {
        assert.strictEqual(wards.parseFiniteNumber('3.14'), 3.14);
    });
    await t('parseFiniteNumber: rejects mixed text', () => {
        assert.strictEqual(wards.parseFiniteNumber('3.14 + I'), null);
    });

    // ── symbolic identity: passes ──────────────────────────────────────────
    await t('symbolicSimplify: identity passes', async () => {
        stub._next = { ok: true, kind: 'ok', value: '{"ZERO", "0"}', durationMs: 4, error: null, prints: null, messages: null, truncated: false, originalLength: 16, timeoutSeconds: 15 };
        const r = await mathematica.symbolicSimplify({ lhs: 'Sin[x]^2 + Cos[x]^2', rhs: '1' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.equal, true);
    });

    // ── symbolic identity: fails ───────────────────────────────────────────
    await t('symbolicSimplify: false identity fails', async () => {
        stub._next = { ok: true, kind: 'ok', value: '{"NONZERO", "1"}', durationMs: 4, error: null, prints: null, messages: null, truncated: false, originalLength: 16, timeoutSeconds: 15 };
        const r = await mathematica.symbolicSimplify({ lhs: '1', rhs: '2' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.equal, false);
    });

    // ── numeric probe within tolerance ─────────────────────────────────────
    await t('numericProbe: matches within tol', async () => {
        stub._next = { ok: true, kind: 'ok', value: '3.14159265358979', durationMs: 2, error: null, prints: null, messages: null, truncated: false, originalLength: 15, timeoutSeconds: 15 };
        const r = await mathematica.numericProbe({ expression: 'Pi', expected: 3.14159265359, tolerance: 1e-8 });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.withinTol, true);
    });

    // ── numeric probe outside tolerance ────────────────────────────────────
    await t('numericProbe: out of tol', async () => {
        stub._next = { ok: true, kind: 'ok', value: '3.14159', durationMs: 2, error: null, prints: null, messages: null, truncated: false, originalLength: 7, timeoutSeconds: 15 };
        const r = await mathematica.numericProbe({ expression: 'Pi', expected: 4.0, tolerance: 1e-6 });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.withinTol, false);
    });

    // ── kernel offline ─────────────────────────────────────────────────────
    await t('symbolicSimplify: kernel offline -> ok=false, equal=null', async () => {
        stub._next = { ok: false, kind: 'kernel_unavailable', value: null, error: 'kernel not available', durationMs: 0, prints: null, messages: null, truncated: false, originalLength: 0, timeoutSeconds: 15 };
        const r = await mathematica.symbolicSimplify({ lhs: 'a', rhs: 'b' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.equal, null);
        assert.strictEqual(r.kind, 'kernel_unavailable');
    });

    // ── abort during verification ──────────────────────────────────────────
    await t('Ward runner: aborts cleanly when signal pre-aborted', async () => {
        const fakeBus = { events: [], appendEvent(t, p, m) { this.events.push({ t, p, m }); return Promise.resolve(); } };
        const ac = new AbortController();
        ac.abort();
        const scroll = { id: 'S01', evidence: [{ tool: 'wolfram_eval', expression: 'Pi', output: '3.14', ok: true }] };
        const out = await wards.runWards({
            scroll,
            quest: { id: 'Q00', shortName: 'smoke' },
            charm: { id: 'C01' },
            bus: fakeBus,
            signal: ac.signal,
        });
        assert.ok(out.results.length >= 0);
        // at least one ward.result event emitted (the aborted one or the no-evidence one)
        assert.ok(fakeBus.events.some(e => e.t === 'ward.result'));
    });

    // ── malformed evidence is skipped, not crashed ─────────────────────────
    await t('Ward runner: malformed evidence -> skipped', async () => {
        const fakeBus = { events: [], appendEvent(t, p, m) { this.events.push({ t, p, m }); return Promise.resolve(); } };
        const scroll = { id: 'S02', evidence: [{ tool: 'wolfram_eval', expression: '', output: '', ok: false }] };
        const out = await wards.runWards({
            scroll,
            quest: { id: 'Q00', shortName: 'smoke' },
            charm: { id: 'C01' },
            bus: fakeBus,
        });
        assert.strictEqual(out.results.length, 1);
        assert.strictEqual(out.results[0].status, 'skipped');
    });

    // ── freshKernel stub ───────────────────────────────────────────────────
    await t('freshKernel: returns unsupported stub', () => {
        const r = mathematica.freshKernel();
        assert.strictEqual(r.supported, false);
        assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
    });

    console.log('');
    console.log(fail === 0 ? 'ALL OK (' + pass + ' tests)' : 'FAILED (' + fail + ' / ' + (pass + fail) + ')');
    process.exit(fail === 0 ? 0 : 1);
})();
