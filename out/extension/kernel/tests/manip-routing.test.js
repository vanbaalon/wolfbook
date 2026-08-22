'use strict';

// Manipulate slider messages must reach exactly ONE kernel.
//
// vscode.notebooks.createRendererMessaging() is a channel per RENDERER, not per
// controller, and every WolframNotebookKernel subscribes to it. With more than
// one kernel alive, a single 'manipulate-set' is therefore delivered to all of
// them. Only the kernel bound to that notebook holds the Manipulate in its
// registry; the others answered "this Manipulate is no longer live" and posted
// it back, so the notice flickered between good frames.
//
// This pins the routing law: for any notebook, exactly one controller claims it,
// and it is the one KernelManager binds.

const assert = require('assert');
const { KernelManager } = require('../manager');

function controller() {
    return {
        _controller: { label: 'initial' },
        kernelStatusString: 'resolved',
        arbiter: { status: () => ({ lifecycle: 'idle', busy: false }) },
        launchKernel: async () => {}, quitKernel: async () => {}, dispose: () => {},
    };
}

// The ownership test the controller applies to every renderer message, built
// from the same claimNotebook predicates extension.js installs.
// Mirrors controller.js _ownsNotebook. The `!nb` guard is load-bearing: the
// default kernel's predicate answers TRUE for an absent notebook (bindingFor
// falls back to the default entry), so without it an editor-less message would
// still be executed.
function ownsNotebook(claim, nb) {
    if (!nb) return false;
    try { return !!claim(nb); } catch (_) { return false; }
}

(async () => {
    const persisted = {};
    const context = { workspaceState: {
        get: (k, d) => Object.prototype.hasOwnProperty.call(persisted, k) ? persisted[k] : d,
        update: async (k, v) => { persisted[k] = v; },
    } };

    let manager;
    const c1 = controller();
    // extension.js: the default kernel claims a notebook when nothing else is bound.
    const claim1 = nb => !manager || manager.bindingFor(nb)?.controller === c1;
    manager = new KernelManager(context, { experimental: true, maximum: 3, factory: async () => controller() });
    const k1 = manager.addDefault(c1);

    const k2 = await manager.create();
    const c2 = k2.controller;
    const claim2 = nb => manager.bindingFor(nb)?.controller === c2;

    const k3 = await manager.create();
    const c3 = k3.controller;
    const claim3 = nb => manager.bindingFor(nb)?.controller === c3;

    const claims = [claim1, claim2, claim3];
    const owners = nb => claims.filter(c => ownsNotebook(c, nb)).length;

    // An unbound notebook falls back to the default kernel — and to it alone.
    assert.strictEqual(owners('/tmp/a.wb'), 1, 'unbound notebook must have exactly one owner');
    assert.ok(ownsNotebook(claim1, '/tmp/a.wb'), 'unbound notebook belongs to the default kernel');

    // Binding it elsewhere moves ownership rather than duplicating it. This is
    // the case that produced the flicker: before the guard, all three answered.
    await manager.bind('/tmp/a.wb', k2.id);
    assert.strictEqual(owners('/tmp/a.wb'), 1, 'a bound notebook must still have exactly one owner');
    assert.ok(ownsNotebook(claim2, '/tmp/a.wb'), 'ownership follows the binding');
    assert.ok(!ownsNotebook(claim1, '/tmp/a.wb'), 'the default kernel must stand down once bound');
    assert.ok(!ownsNotebook(claim3, '/tmp/a.wb'), 'an unrelated kernel never answers');

    // Two notebooks on two kernels stay independent.
    await manager.bind('/tmp/b.wb', k3.id);
    assert.strictEqual(owners('/tmp/b.wb'), 1);
    assert.ok(ownsNotebook(claim3, '/tmp/b.wb'));
    assert.ok(ownsNotebook(claim2, '/tmp/a.wb'), 'binding b must not disturb a');

    // Unbinding hands the notebook back to the default kernel, still singly.
    await manager.unbind('/tmp/a.wb');
    assert.strictEqual(owners('/tmp/a.wb'), 1);
    assert.ok(ownsNotebook(claim1, '/tmp/a.wb'));

    // A message with no editor (hence no notebook) is claimed by nobody — and
    // that is the guard's doing, not the predicate's: claim1 alone says yes.
    assert.ok(claim1(undefined), 'the default predicate does answer for an absent notebook');
    assert.ok(!ownsNotebook(claim1, undefined), 'the guard must reject it anyway');
    assert.ok(!ownsNotebook(claim2, undefined));

    console.log('manip-routing: ok');
})().catch(err => { console.error(err); process.exit(1); });
