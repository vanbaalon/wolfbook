#!/usr/bin/env node
'use strict';
/**
 * Fairy Phase 4 — end-to-end smoke tests with a real wolframscript subprocess.
 *
 * Requires a local Wolfram installation. Skips all tests (exit 0) if
 * wolframscript is not found on this machine.
 *
 * Covers:
 *   kernelVerifier.verifyCleanNotebook  — delivered, output_differs, cell_errored
 *     (target-not-found), numeric tolerance, multi-cell notebook
 *   compile + verify pipeline           — workDir round-trip with real kernel
 *
 * Run: node out/extension/oberon/tests/fairyPhase4.smoke.js
 * Takes ~10-30 s depending on kernel startup time.
 */

const os     = require('os');
const path   = require('path');
const fsp    = require('fs/promises');
const fs     = require('fs');
const assert = require('assert');
const crypto = require('crypto');

// ── Locate wolframscript ───────────────────────────────────────────────────────
// We derive the path the same way fairy.js does: FindKernel → resolveWolframscript.
// As a fallback we search common macOS/Linux paths.

const { resolveWolframscript } = require('../fairy/kernelVerifier');

function findWolframscriptBin() {
    // Mirrors FindKernel search order without needing vscode
    const candidates = [
        '/Applications/Mathematica.app/Contents/MacOS/WolframKernel',
        '/Applications/Wolfram 3.app/Contents/MacOS/WolframKernel',
        '/usr/local/bin/WolframKernel',
        '/opt/Wolfram/WolframEngine/13.0/Executables/WolframKernel',
    ];
    for (const kp of candidates) {
        if (fs.existsSync(kp)) {
            const ws = resolveWolframscript(kp);
            if (fs.existsSync(ws)) return ws;
        }
    }
    // Direct wolframscript locations
    const direct = [
        '/Applications/WolframScript.app/Contents/MacOS/wolframscript',
        '/usr/local/bin/wolframscript',
    ];
    for (const p of direct) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const wolframscriptBin = findWolframscriptBin();

if (!wolframscriptBin) {
    console.log('wolframscript not found — skipping Phase 4 smoke tests (exit 0).');
    process.exit(0);
}

console.log(`Using wolframscript: ${wolframscriptBin}`);

// ── Modules under test ────────────────────────────────────────────────────────
const { verifyCleanNotebook, buildVerifyScript, parseVerifyOutput } = require('../fairy/kernelVerifier');
const { createWorkDir }  = require('../fairy/workDir');
const { compile, verify } = require('../fairy/harness');

// ── Test framework ────────────────────────────────────────────────────────────
let passed = 0;
let failed  = 0;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

async function run() {
    for (const t of tests) {
        process.stdout.write(`  running: ${t.name} …`);
        try {
            await t.fn();
            passed++;
            process.stdout.write(` ✓\n`);
        } catch (e) {
            failed++;
            process.stdout.write(` ✗\n`);
            process.stderr.write(`    ${e.message}\n${e.stack ? e.stack.split('\n').slice(1, 4).join('\n') : ''}\n`);
        }
    }
    process.stdout.write(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function withTempDir(fn) {
    const dir = path.join(os.tmpdir(), 'oberon_p4_' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(dir, { recursive: true });
    try { return await fn(dir); }
    finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

function makeCleanNb(cells) {
    return { cells };
}

function makeCodeCell(id, value) {
    return { id, kind: 2, language: 'wolfram', value, outputs: [], metadata: { tags: [id + '_cell'] } };
}

async function writeNb(dir, nb) {
    const p = path.join(dir, 'clean.wb');
    await fsp.writeFile(p, JSON.stringify(nb, null, 2), 'utf8');
    return p;
}

const OPTS = { wolframscriptBin, numeric_tol: 1e-10, timeoutPerCell: 15, totalTimeoutMs: 60_000 };

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. Basic delivered — integer arithmetic
test('verifyCleanNotebook: 2+2=4 → delivered', () => withTempDir(async (dir) => {
    const nb   = makeCleanNb([makeCodeCell('s1', '2 + 2')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', '4', OPTS);
    assert.strictEqual(r.classification, 'delivered', `Expected delivered, got ${r.classification}: ${r.details}`);
    assert.strictEqual(r.freshOutput, '4');
}));

// 2. String output
test('verifyCleanNotebook: string output → delivered', () => withTempDir(async (dir) => {
    const nb   = makeCleanNb([makeCodeCell('s1', '"hello world"')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', '"hello world"', OPTS);
    assert.strictEqual(r.classification, 'delivered', `${r.classification}: ${r.details}`);
}));

// 3. List output
test('verifyCleanNotebook: list → delivered', () => withTempDir(async (dir) => {
    const nb   = makeCleanNb([makeCodeCell('s1', '{1, 2, 3}')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', '{1, 2, 3}', OPTS);
    assert.strictEqual(r.classification, 'delivered', `${r.classification}: ${r.details}`);
}));

// 4. output_differs — wrong recorded value
test('verifyCleanNotebook: wrong recorded value → output_differs', () => withTempDir(async (dir) => {
    const nb   = makeCleanNb([makeCodeCell('s1', '3 * 7')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', '99', OPTS);
    assert.strictEqual(r.classification, 'output_differs', `${r.classification}: ${r.details}`);
    assert.strictEqual(r.freshOutput, '21');
    assert.strictEqual(r.recordedOutput, '99');
}));

// 5. Target step not in clean.wb → cell_errored
test('verifyCleanNotebook: target step not in notebook → cell_errored', () => withTempDir(async (dir) => {
    const nb   = makeCleanNb([makeCodeCell('s1', '1 + 1')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 'nonexistent_step', '2', OPTS);
    assert.strictEqual(r.classification, 'cell_errored', `${r.classification}: ${r.details}`);
    assert.ok(r.details.includes('nonexistent_step'));
}));

// 6. Numeric tolerance — float that matches within tol
test('verifyCleanNotebook: float within tolerance → delivered', () => withTempDir(async (dir) => {
    // N[Pi] evaluates to 3.141592653589793... and recorded is N[Pi] output
    const nb   = makeCleanNb([makeCodeCell('s1', 'N[1/3]')]);
    const nbPath = await writeNb(dir, nb);
    // Get the actual output first to record it, then verify
    const r1 = await verifyCleanNotebook(nbPath, 's1', '0.3333333333333333', OPTS);
    // If exact match or numeric match, should be delivered
    assert.strictEqual(r1.classification, 'delivered',
        `Expected delivered, got ${r1.classification} fresh="${r1.freshOutput}"`);
}));

// 7. Multi-cell notebook — earlier cells define state used by target cell
test('verifyCleanNotebook: multi-cell with variable dependency → delivered', () => withTempDir(async (dir) => {
    const nb = makeCleanNb([
        makeCodeCell('setup', 'x = 10;'),
        makeCodeCell('s1',    'x * x'),
    ]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', '100', OPTS);
    assert.strictEqual(r.classification, 'delivered', `${r.classification}: ${r.details} (fresh=${r.freshOutput})`);
}));

// 8. Cell timeout
test('verifyCleanNotebook: timed-out cell → cell_errored', () => withTempDir(async (dir) => {
    // Pause[5] with timeoutPerCell=1 should timeout
    const nb = makeCleanNb([makeCodeCell('s1', 'Pause[5]')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', 'Null', {
        ...OPTS, timeoutPerCell: 1, totalTimeoutMs: 15_000,
    });
    assert.strictEqual(r.classification, 'cell_errored', `${r.classification}: ${r.details}`);
    assert.ok(r.details.includes('timed out'), `Details: ${r.details}`);
}));

// 9. Empty recorded value — output_differs (fresh output is not empty)
test('verifyCleanNotebook: empty recorded vs real output → output_differs', () => withTempDir(async (dir) => {
    const nb = makeCleanNb([makeCodeCell('s1', '42')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', '', OPTS);
    assert.strictEqual(r.classification, 'output_differs', `${r.classification}: fresh="${r.freshOutput}"`);
}));

// 10. Tag-based target cell lookup (metadata.tags includes stepId)
test('verifyCleanNotebook: target found by metadata.tags → delivered', () => withTempDir(async (dir) => {
    const cell = {
        id: 'cell_abc', kind: 2, language: 'wolfram', value: '5 + 3',
        outputs: [], metadata: { tags: ['myStep'] },
    };
    const nb = makeCleanNb([cell]);
    const nbPath = await writeNb(dir, nb);
    // Look up by tag 'myStep', not by id
    const r = await verifyCleanNotebook(nbPath, 'myStep', '8', OPTS);
    assert.strictEqual(r.classification, 'delivered', `${r.classification}: ${r.details}`);
}));

// 11. compile + verify pipeline — workDir round-trip
test('compile + verify pipeline: simple step → delivered', () => withTempDir(async (dir) => {
    const wd = await createWorkDir(dir);

    // Probe: evaluate 7 * 6
    await wd.saveProbe('p1', {
        code: '7 * 6', ok: true, value: '42',
        messages: null, prints: null, durationMs: 5, structuralSummary: {}, error: null,
    });

    // Record as step s1
    await wd.addStep({
        id: 's1', probeId: 'p1', code: '7 * 6', resultRef: 'p1',
        dependsOn: [], usesSymbols: [], definesSymbols: [], note: 'compute 42',
    });

    // Compile → clean.wb
    const compileResult = await compile(wd, 's1', {});
    assert.ok(compileResult.ok, `compile failed: ${JSON.stringify(compileResult.diagnostics)}`);
    assert.ok(compileResult.cleanNbPath, 'cleanNbPath should be set');

    // Verify with real kernel
    const verifyResult = await verify(wd, 's1', '42', { wolframscriptBin, numeric_tol: 1e-10 });
    assert.strictEqual(verifyResult.classification, 'delivered',
        `Expected delivered, got ${verifyResult.classification}: ${verifyResult.details}`);
}));

// 12. compile + verify pipeline — output_differs detected
test('compile + verify pipeline: wrong recorded value → output_differs', () => withTempDir(async (dir) => {
    const wd = await createWorkDir(dir);

    await wd.saveProbe('p1', {
        code: 'Length[{a, b, c}]', ok: true, value: '3',
        messages: null, prints: null, durationMs: 5, structuralSummary: {}, error: null,
    });
    await wd.addStep({
        id: 's1', probeId: 'p1', code: 'Length[{a, b, c}]', resultRef: 'p1',
        dependsOn: [], usesSymbols: [], definesSymbols: [], note: '',
    });

    const compileResult = await compile(wd, 's1', {});
    assert.ok(compileResult.ok);

    // Pass wrong recorded value '99' — should get output_differs
    const verifyResult = await verify(wd, 's1', '99', { wolframscriptBin, numeric_tol: 1e-10 });
    assert.strictEqual(verifyResult.classification, 'output_differs',
        `Expected output_differs, got ${verifyResult.classification}: fresh=${verifyResult.freshOutput}`);
    assert.strictEqual(verifyResult.freshOutput, '3');
}));

// 13. compile + verify — multi-step chain
test('compile + verify pipeline: two-step chain → delivered', () => withTempDir(async (dir) => {
    const wd = await createWorkDir(dir);

    await wd.saveProbe('p1', {
        code: 'myBase = 100', ok: true, value: '100',
        messages: null, prints: null, durationMs: 5, structuralSummary: {}, error: null,
    });
    await wd.addStep({
        id: 'step_base', probeId: 'p1', code: 'myBase = 100', resultRef: 'p1',
        dependsOn: [], usesSymbols: [], definesSymbols: ['myBase'], note: '',
    });

    await wd.saveProbe('p2', {
        code: 'myBase + 23', ok: true, value: '123',
        messages: null, prints: null, durationMs: 5, structuralSummary: {}, error: null,
    });
    await wd.addStep({
        id: 'step_result', probeId: 'p2', code: 'myBase + 23', resultRef: 'p2',
        dependsOn: ['step_base'], usesSymbols: ['myBase'], definesSymbols: [], note: '',
    });

    const compileResult = await compile(wd, 'step_result', {});
    assert.ok(compileResult.ok, `compile failed: ${JSON.stringify(compileResult.diagnostics)}`);
    // Both steps should be in the closure
    assert.strictEqual(compileResult.closureSteps.length, 2);

    const verifyResult = await verify(wd, 'step_result', '123', { wolframscriptBin, numeric_tol: 1e-10 });
    assert.strictEqual(verifyResult.classification, 'delivered',
        `Expected delivered: ${verifyResult.details} (fresh=${verifyResult.freshOutput})`);
}));

// 14. Symbolic output — exact match
test('verifyCleanNotebook: symbolic result → delivered', () => withTempDir(async (dir) => {
    const nb = makeCleanNb([makeCodeCell('s1', 'Integrate[x^2, x]')]);
    const nbPath = await writeNb(dir, nb);
    const r = await verifyCleanNotebook(nbPath, 's1', 'x^3/3', OPTS);
    assert.strictEqual(r.classification, 'delivered',
        `${r.classification}: fresh="${r.freshOutput}" (expected "x^3/3")`);
}));

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
    process.stdout.write('Fairy Phase 4 smoke tests (real wolframscript)\n\n');
    await run();
})().catch(e => {
    process.stderr.write(`Fatal: ${e.stack || e}\n`);
    process.exit(1);
});
