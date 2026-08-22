// tex-tour.test.js — the first-run tour, executed.
//
// The tour's whole claim is that it advances on the READER'S OWN GESTURE, not
// on a Next button, and that it never asks for a gesture this paper cannot
// perform. Both are properties of `tourSteps.js` plus the viewer's observer,
// so both are asserted here against the message shapes the panel really posts
// (see `_onMessage` in texViewer.js: `click` with `widen`/`takeMe`/`pick`,
// `editHere`, `labelsWanted`).

const assert = require('assert');
const { STEPS, stepsFor, stepAt, satisfies } = require('../../tex/tourSteps');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const WITH_LABELS = { hasLabels: true };
const NO_LABELS = { hasLabels: false };

test('every step says what to do, and every gesture step can be satisfied', () => {
    for (const s of STEPS) {
        assert.ok(s.id && s.title && s.say, `step ${s.id} is incomplete`);
        // A step either asks for a gesture it can recognise, or offers a button.
        assert.ok(typeof s.satisfy === 'function' || s.done,
            `step ${s.id} can never be finished`);
        if (typeof s.satisfy === 'function') assert.ok(s.doIt, `step ${s.id} never says what to do`);
    }
});

test('A PAPER WITH NO LABELS IS NEVER ASKED TO HOLD SHIFT', () => {
    // The dead-end case: a step whose feature is not present on this paper is
    // not shown at all, and the count the card prints shrinks with it.
    const withL = stepsFor(WITH_LABELS).map(s => s.id);
    const without = stepsFor(NO_LABELS).map(s => s.id);
    assert.ok(withL.includes('labels'));
    assert.ok(!without.includes('labels'));
    assert.strictEqual(without.length, withL.length - 1);
    assert.strictEqual(stepAt({ at: 0 }, NO_LABELS).total, without.length,
        'the card counts the steps this reader will actually see');
});

test('the gestures the panel posts are the ones that advance the tour', () => {
    const click = { type: 'click', page: 1, x: 10, y: 10 };
    assert.ok(satisfies({ id: 'click' }, click));
    assert.ok(!satisfies({ id: 'click' }, { ...click, widen: true }),
        'a widening click is the NEXT step, not this one');
    assert.ok(!satisfies({ id: 'click' }, { ...click, takeMe: true }));

    assert.ok(satisfies({ id: 'widen' }, { ...click, widen: true }));
    assert.ok(!satisfies({ id: 'widen' }, click));

    assert.ok(satisfies({ id: 'takeMe' }, { ...click, takeMe: true }));
    assert.ok(satisfies({ id: 'edit' }, { type: 'editHere', page: 1 }));
    assert.ok(satisfies({ id: 'labels' }, { type: 'labelsWanted' }));
    assert.ok(satisfies({ id: 'cursor' }, { type: 'cursor' }));

    // Anything else is not the gesture, however close it looks.
    assert.ok(!satisfies({ id: 'edit' }, { type: 'click' }));
    assert.ok(!satisfies({ id: 'labels' }, { type: 'click' }));
    assert.ok(!satisfies({ id: 'review' }, { type: 'click' }), 'the last step has no gesture');
});

test('progress walks the steps and then ends', () => {
    const seen = [];
    for (let at = 0; ; at++) {
        const s = stepAt({ at }, WITH_LABELS);
        if (!s) break;
        seen.push(s.id);
        assert.strictEqual(s.index, at);
        if (at > 20) throw new Error('the tour never ends');
    }
    assert.deepStrictEqual(seen, stepsFor(WITH_LABELS).map(s => s.id));
    assert.strictEqual(stepAt({ at: seen.length }, WITH_LABELS), null, 'past the end is nothing');
    assert.strictEqual(stepAt({ at: 2, done: true }, WITH_LABELS), null, 'finished stays finished');
});

test('the first step is the one that teaches the whole feature', () => {
    const first = stepAt({ at: 0 }, WITH_LABELS);
    assert.strictEqual(first.id, 'click');
    assert.ok(first.doIt && /click/i.test(first.doIt));
    assert.strictEqual(first.index, 0);
});

test('nonsense progress does not throw or skip the tour', () => {
    assert.strictEqual(stepAt({ at: -5 }, WITH_LABELS).id, 'click');
    assert.strictEqual(stepAt({ at: NaN }, WITH_LABELS).id, 'click');
    assert.strictEqual(stepAt({}, {}).id, 'click');
    assert.doesNotThrow(() => stepAt(undefined, undefined));
    assert.strictEqual(satisfies(null, { type: 'click' }), false);
    assert.strictEqual(satisfies({ id: 'click' }, null), false);
    assert.strictEqual(satisfies({ id: 'nope' }, { type: 'click' }), false);
});

(async () => {
    console.log('the WPaper tour, executed\n');
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log('  ok   ' + name); }
        catch (e) {
            fail++;
            console.log('  FAIL ' + name + '\n         ' +
                String((e && e.stack) || e).split('\n').slice(0, 4).join('\n         '));
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
