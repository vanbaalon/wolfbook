'use strict';
/**
 * Headless unit suite for the local tricks pack (fairy/tricks.js + seed).
 * Run: node out/extension/oberon/tests/tricks.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const tricks = require('../fairy/tricks');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e && e.message}`); }
}

const SEED = tricks.loadTricks(null);

test('seed pack loads with 31 valid tricks', () => {
    assert.strictEqual(SEED.length, 31);
    for (const t of SEED) {
        assert.ok(t.id.startsWith('wolfram/'), t.id);
        assert.ok(t.title.length <= 120 && t.body.length <= 700, t.id);
        // Tier-B tricks fire on failure signatures; pure Tier-A prevention
        // tricks (system-prompt only) may have none.
        assert.ok(Array.isArray(t.signatures) && (t.signatures.length >= 1 || t.tierA === true),
            t.id + ' needs signatures (or tierA)');
    }
    const ids = SEED.map(t => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids');
});

test('evidence-driven matches: the top mined failure classes all hit', () => {
    const cases = [
        ['FindRoot::jsing: Encountered a singular Jacobian at the point {u1, u2}', 'wolfram/findroot-singular-jacobian'],
        ['Power::infy: Infinite expression 1/0 encountered.', 'wolfram/rational-eq-pole-clearing'],
        ['Infinity::indet: Indeterminate expression 0 ComplexInfinity encountered.', 'wolfram/rational-eq-pole-clearing'],
        ['Thread::tdlen: Objects of unequal length cannot be combined.', 'wolfram/thread-length-mismatch'],
        ['FindRoot::nveq: The number of equations does not match the number of variables', 'wolfram/findroot-vars-vs-equations'],
        ['NSolve::ivar: 0.114122 is not a valid variable.', 'wolfram/solver-variable-has-value'],
        ['ReplaceAll::reps: {False, False} is neither a list of replacements', 'wolfram/solver-output-shape'],
        ['Abs::argx: Abs called with 2 arguments', 'wolfram/abs-single-argument'],
        ['Take::take: Cannot take positions 1 through 5 in {}.', 'wolfram/guard-empty-lists'],
        ['Dot::dotsh: Tensors ... have incompatible shapes', 'wolfram/dot-shape-mismatch'],
    ];
    for (const [msg, expectedId] of cases) {
        const m = tricks.matchTricks(SEED, { messages: msg });
        assert.ok(m.some(t => t.id === expectedId), `${expectedId} should match "${msg.slice(0, 40)}" (got ${m.map(t => t.id)})`);
    }
});

test('harness-kind matches (near_duplicate, redefinition)', () => {
    assert.ok(tricks.matchTricks(SEED, { kind: 'near_duplicate' }).some(t => t.id === 'wolfram/near-duplicate-change-approach'));
    assert.ok(tricks.matchTricks(SEED, { kind: 'redefinition' }).some(t => t.id === 'wolfram/build-forward-no-redefinition'));
});

test('code-signature matches (Return[, Module[{u...)', () => {
    assert.ok(tricks.matchTricks(SEED, { code: 'f[] := Module[{}, If[bad, Return[1]]; 2]' })
        .some(t => t.id === 'wolfram/return-escapes-inline-module'));
    assert.ok(tricks.matchTricks(SEED, { code: 'Module[{u, res}, Expand[Q /. u -> u + I]]' })
        .some(t => t.id === 'wolfram/module-shadows-global-symbol'));
});

test('at most 2 matches, highest priority first', () => {
    const m = tricks.matchTricks(SEED, {
        messages: 'FindRoot::jsing ... Power::infy ... Thread::tdlen ... General::stop',
    });
    assert.ok(m.length <= 2);
    assert.ok((m[0].priority || 0) >= (m[1].priority || 0));
});

test('no match on clean input', () => {
    assert.strictEqual(tricks.matchTricks(SEED, { messages: '', code: 'x = 1 + 1' }).length, 0);
});

test('renderTrick includes title, body, example', () => {
    const t = SEED.find(x => x.id === 'wolfram/findroot-singular-jacobian');
    const s = tricks.renderTrick(t);
    assert.ok(s.includes('[WL trick — ') && s.includes(t.body) && s.includes('e.g.'));
});

test('renderPrefixPack: tierA only, bounded, priority-ordered', () => {
    const pack = tricks.renderPrefixPack(SEED, { maxChars: 6000 });
    assert.ok(pack.includes('## Wolfram gotchas'));
    assert.ok(pack.includes('symmetric seeds kill the Jacobian'));
    assert.ok(!pack.includes('General::stop is not the error'), 'non-tierA trick leaked into prefix');
    assert.ok(pack.length <= 6100);
    const small = tricks.renderPrefixPack(SEED, { maxChars: 800 });
    assert.ok(small.length <= 900 && small.includes('## Wolfram gotchas'));
});

test('local file merges: override by id, add new, disable seed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricks-'));
    const localPath = path.join(dir, 'tricks.local.json');
    fs.writeFileSync(localPath, JSON.stringify([
        { id: 'wolfram/abs-single-argument', title: 'OVERRIDDEN', body: 'local body', signatures: [{ kind: 'message', value: 'Abs::argx' }] },
        { id: 'wolfram/my-own', title: 'Custom trick', body: 'my note', signatures: [{ kind: 'code', value: 'MyFunc[' }], priority: 99 },
        { id: 'wolfram/general-stop-find-first-message', disabled: true },
    ]), 'utf8');
    const merged = tricks.loadTricks(localPath);
    assert.strictEqual(merged.find(t => t.id === 'wolfram/abs-single-argument').title, 'OVERRIDDEN');
    assert.ok(merged.some(t => t.id === 'wolfram/my-own'));
    assert.ok(!merged.some(t => t.id === 'wolfram/general-stop-find-first-message'));
});

test('malformed local file falls back to seed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricks-'));
    const localPath = path.join(dir, 'tricks.local.json');
    fs.writeFileSync(localPath, '{not json', 'utf8');
    assert.strictEqual(tricks.loadTricks(localPath).length, 31);
});

test('bad regex signature never throws', () => {
    const list = [{ id: 'x/y', title: 't', body: 'b', signatures: [{ kind: 'regex', value: '([' }] }];
    assert.strictEqual(tricks.matchTricks(list, { messages: 'anything' }).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
