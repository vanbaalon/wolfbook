'use strict';
/**
 * Stage 4 — stepwise-calculation improvements (FAIRY_STEPWISE_IMPROVEMENTS_22JUN.md):
 *  4M6  — handleProbe does NOT prepend utils; wolframShim exposes setPostRestartSeeder
 *  4M7  — workDir.buildSymbolTable (utils + valid steps, truncation)
 *  4M8  — redefinition detection + handleProbe rejection (setting-gated, whitelist)
 *  4M9  — extractTargetSymbol (repeat-and-abandon target extraction)
 *  4M10 — handleProbe large-step warning
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

// ── harness ──────────────────────────────────────────────────────────────────

let passCount = 0, failCount = 0;
const failures = [];

async function ok(label, fn) {
    try {
        await fn();
        console.log(`  ok ${label}`);
        passCount++;
    } catch (e) {
        console.error(`  FAIL ${label}: ${e && e.message || e}`);
        failures.push({ label, err: e });
        failCount++;
    }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'stage4-')); }

// ── modules under test ───────────────────────────────────────────────────────

const { createWorkDir } = require('../fairy/workDir');
const {
    handleProbe, detectRedefinition, extractDefinedSymbols, extractRedefineWhitelist,
} = require('../fairy/tools');
const wolframShim = require('../core/wolframShim');
const { _internals } = require('../core/fairy');
const { extractTargetSymbol } = _internals;

function makeShim(nextResult) {
    const shim = {
        DEFAULT_TIMEOUT: 30,
        _next: nextResult || { ok: true, value: 'Null', messages: [] },
        async evalOnce({ expression }) { shim._lastExpression = expression; return shim._next; },
    };
    return shim;
}

async function makeCtx(label, { shimResult, rejectRedefinition } = {}) {
    const dir  = tmpDir();
    const wd   = await createWorkDir(dir);
    const shim = makeShim(shimResult);
    return {
        workDir: wd,
        shim,
        signal: null,
        rejectRedefinition,  // undefined → guard on (default)
        fsm: { canTurn: () => true, turnsUsed: 0, exploreProbesRemaining: 10 },
    };
}

async function addValidStep(wd, { id, defines, note }) {
    await wd.addStep({
        id, probeId: id.replace('s', 'p'), code: `${(defines || [])[0] || 'x'} = 1`,
        resultRef: id.replace('s', 'p'), dependsOn: [], usesSymbols: [],
        definesSymbols: defines || [], note: note || '',
    });
}

// ── 4M6 ──────────────────────────────────────────────────────────────────────

async function run4M6() {
    console.log('\n── 4M6: no per-probe prepend; restart seeder ──');

    await ok('4M6: wolframShim exports setPostRestartSeeder', async () => {
        assert.strictEqual(typeof wolframShim.setPostRestartSeeder, 'function');
    });

    await ok('4M6: setPostRestartSeeder accepts a function and null without throwing', async () => {
        wolframShim.setPostRestartSeeder(async () => 'foo[x_]:=x');
        wolframShim.setPostRestartSeeder(null);
    });

    await ok('4M6: handleProbe sends only the probe code (no util body)', async () => {
        const ctx = await makeCtx('4M6-noprepend', { shimResult: { ok: true, value: '6', messages: [] } });
        await ctx.workDir.addUtil({ name: 'triple', code: 'triple[x_]:=3x', note: 'triple' });
        await handleProbe({ code: 'triple[2]', note: 'call by name' }, ctx);
        assert.strictEqual(ctx.shim._lastExpression.trim(), 'triple[2]');
    });
}

// ── 4M7 ──────────────────────────────────────────────────────────────────────

async function run4M7() {
    console.log('\n── 4M7: buildSymbolTable ──');

    await ok('4M7: empty when nothing defined', async () => {
        const wd = await createWorkDir(tmpDir());
        assert.strictEqual(await wd.buildSymbolTable(), '');
    });

    await ok('4M7: lists registered utils', async () => {
        const wd = await createWorkDir(tmpDir());
        await wd.addUtil({ name: 'buildT', code: 'buildT[L_]:=L', note: 'transfer matrix' });
        const tbl = await wd.buildSymbolTable();
        assert.ok(tbl.includes('buildT'), tbl);
        assert.ok(tbl.includes('util'), tbl);
        assert.ok(tbl.includes('transfer matrix'), tbl);
    });

    await ok('4M7: lists symbols defined by valid steps', async () => {
        const wd = await createWorkDir(tmpDir());
        await addValidStep(wd, { id: 's003', defines: ['Hmat'], note: 'Hamiltonian' });
        const tbl = await wd.buildSymbolTable();
        assert.ok(tbl.includes('Hmat'), tbl);
        assert.ok(tbl.includes('s003'), tbl);
    });

    await ok('4M7: truncates at maxChars with marker', async () => {
        const wd = await createWorkDir(tmpDir());
        for (let i = 0; i < 40; i++) {
            await wd.addUtil({ name: `util${i}`, code: `util${i}[x_]:=x`, note: 'x'.repeat(50) });
        }
        const tbl = await wd.buildSymbolTable({ maxChars: 300 });
        assert.ok(tbl.length <= 400, `length ${tbl.length}`);
        assert.ok(tbl.includes('truncated'), 'should mark truncation');
    });
}

// ── 4M8 ──────────────────────────────────────────────────────────────────────

async function run4M8() {
    console.log('\n── 4M8: redefinition detection + rejection ──');

    await ok('4M8: extractDefinedSymbols finds line-start definitions', async () => {
        const syms = extractDefinedSymbols('Hmat = {{1,0},{0,1}}\nfoo[x_] := x^2');
        assert.ok(syms.includes('Hmat'), syms.join(','));
        assert.ok(syms.includes('foo'), syms.join(','));
    });

    await ok('4M8: extractDefinedSymbols ignores == comparisons', async () => {
        const syms = extractDefinedSymbols('result == expected');
        assert.deepStrictEqual(syms, []);
    });

    await ok('4M8: extractDefinedSymbols ignores Module-internal semicolon assigns', async () => {
        // y is after a semicolon mid-line, not a line-start definition
        const syms = extractDefinedSymbols('f[a_] := Module[{y}, y = a; y + 1]');
        assert.ok(syms.includes('f'), syms.join(','));
        assert.ok(!syms.includes('y'), 'must not flag Module-local y');
    });

    await ok('4M8: extractRedefineWhitelist parses comment', async () => {
        const wl = extractRedefineWhitelist('(* redefine: tmat, rMat *)\ntmat = 1');
        assert.ok(wl.has('tmat') && wl.has('rMat'));
    });

    await ok('4M8: detectRedefinition flags a redefined util', async () => {
        const ctx = await makeCtx('4M8-detect');
        await ctx.workDir.addUtil({ name: 'buildT', code: 'buildT[L_]:=L', note: 'tm' });
        const hits = await detectRedefinition('buildT[L_] := L + 1', ctx);
        assert.deepStrictEqual(hits, ['buildT']);
    });

    await ok('4M8: detectRedefinition flags a redefined step symbol', async () => {
        const ctx = await makeCtx('4M8-step');
        await addValidStep(ctx.workDir, { id: 's001', defines: ['Hmat'], note: 'H' });
        const hits = await detectRedefinition('Hmat = {{2}}', ctx);
        assert.deepStrictEqual(hits, ['Hmat']);
    });

    await ok('4M8: detectRedefinition ignores call-by-name', async () => {
        const ctx = await makeCtx('4M8-call');
        await ctx.workDir.addUtil({ name: 'buildT', code: 'buildT[L_]:=L', note: 'tm' });
        const hits = await detectRedefinition('eigs = Eigenvalues[buildT[2]]', ctx);
        assert.deepStrictEqual(hits, []);
    });

    await ok('4M8: detectRedefinition respects whitelist comment', async () => {
        const ctx = await makeCtx('4M8-wl');
        await ctx.workDir.addUtil({ name: 'buildT', code: 'buildT[L_]:=L', note: 'tm' });
        const hits = await detectRedefinition('(* redefine: buildT *)\nbuildT[L_] := L + 1', ctx);
        assert.deepStrictEqual(hits, []);
    });

    await ok('4M8: handleProbe rejects a redefinition when guard on', async () => {
        const ctx = await makeCtx('4M8-reject', { shimResult: { ok: true, value: '1', messages: [] } });
        await ctx.workDir.addUtil({ name: 'buildT', code: 'buildT[L_]:=L', note: 'tm' });
        const r = await handleProbe({ code: 'buildT[L_] := L + 1', note: 'rebuild' }, ctx);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'redefinition');
        // kernel must not have been called
        assert.strictEqual(ctx.shim._lastExpression, undefined);
    });

    await ok('4M8: handleProbe allows redefinition when guard disabled', async () => {
        const ctx = await makeCtx('4M8-off', { shimResult: { ok: true, value: '1', messages: [] }, rejectRedefinition: false });
        await ctx.workDir.addUtil({ name: 'buildT', code: 'buildT[L_]:=L', note: 'tm' });
        const r = await handleProbe({ code: 'buildT[L_] := L + 1', note: 'rebuild' }, ctx);
        assert.ok(r.ok !== false, `expected ok, got ${r.error}`);
    });

    await ok('4M8: handleProbe allows call-by-name when guard on', async () => {
        const ctx = await makeCtx('4M8-callok', { shimResult: { ok: true, value: '1', messages: [] } });
        await ctx.workDir.addUtil({ name: 'buildT', code: 'buildT[L_]:=L', note: 'tm' });
        const r = await handleProbe({ code: 'Eigenvalues[buildT[2]]', note: 'use it' }, ctx);
        assert.ok(r.ok !== false, `expected ok, got ${r.error}`);
    });
}

// ── 4M9 ──────────────────────────────────────────────────────────────────────

async function run4M9() {
    console.log('\n── 4M9: extractTargetSymbol ──');

    await ok('4M9: SetDelayed target', async () => {
        assert.strictEqual(extractTargetSymbol('tmat[L_] := Module[{}, L]'), 'tmat');
    });

    await ok('4M9: Set target', async () => {
        assert.strictEqual(extractTargetSymbol('Hmat = {{1,0},{0,1}}'), 'Hmat');
    });

    await ok('4M9: returns null when nothing defined', async () => {
        assert.strictEqual(extractTargetSymbol('Eigenvalues[Hmat]'), null);
    });

    await ok('4M9: does not match == equality', async () => {
        assert.strictEqual(extractTargetSymbol('a == b'), null);
    });

    await ok('4M9: first definition wins across multiple lines', async () => {
        assert.strictEqual(extractTargetSymbol('foo = 1\nbar = 2'), 'foo');
    });
}

// ── 4M10 ─────────────────────────────────────────────────────────────────────

async function run4M10() {
    console.log('\n── 4M10: large-step warning ──');

    await ok('4M10: large probe gets a warning', async () => {
        const ctx = await makeCtx('4M10-large', { shimResult: { ok: true, value: '42', messages: [] } });
        const bigCode = 'sum = ' + Array.from({ length: 400 }, (_, i) => `a${i}`).join(' + ');
        assert.ok(bigCode.length > 1500, `setup: code is ${bigCode.length} chars`);
        const r = await handleProbe({ code: bigCode, note: 'big' }, ctx);
        assert.ok(r.ok !== false, `expected ok, got ${r.error}`);
        const payload = JSON.parse(r.modelPayload);
        assert.ok(payload.warning && /rebuilding/i.test(payload.warning), `warning missing: ${payload.warning}`);
    });

    await ok('4M10: small probe has no warning', async () => {
        const ctx = await makeCtx('4M10-small', { shimResult: { ok: true, value: '4', messages: [] } });
        const r = await handleProbe({ code: '2 + 2', note: 'small' }, ctx);
        const payload = JSON.parse(r.modelPayload);
        assert.strictEqual(payload.warning, undefined);
    });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    for (const s of [run4M6, run4M7, run4M8, run4M9, run4M10]) await s();
    console.log(`\n── Stage 4 Results: ${passCount} passed, ${failCount} failed ──`);
    if (failures.length) {
        for (const { label, err } of failures) {
            console.error(`  [FAIL] ${label}`);
            if (err && err.stack) console.error('    ' + err.stack.split('\n').join('\n    '));
        }
        process.exit(1);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
