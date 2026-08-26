// tex-tour.test.js — the first-run tour, executed.
//
// The tour's whole claim is that it advances on the READER'S OWN GESTURE, not
// on a Next button, and that it never asks for a gesture this paper cannot
// perform. Both are properties of `tourSteps.js` plus the viewer's observer,
// so both are asserted here against the message shapes the panel really posts
// (see `_onMessage` in texViewer.js: `click` with `widen`/`takeMe`/`pick`,
// `editHere`, `labelsWanted`, `copyAnchor`, `sectionFold`).

const assert = require('assert');
const { STEPS, stepsFor, stepAt, satisfies } = require('../../tex/tourSteps');

let pass = 0; let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A paper with everything the tour can demonstrate, and one with nothing.
const WITH_LABELS = { hasLabels: true, hasSections: true, hasAnchors: true };
const BARE = {};                       // no sectioning, no equations, no labels

test('every step says what to do, and every gesture step can be satisfied', () => {
    for (const s of STEPS) {
        assert.ok(s.id && s.title && s.say, `step ${s.id} is incomplete`);
        // A step either asks for a gesture it can recognise, or offers a button.
        assert.ok(typeof s.satisfy === 'function' || s.done,
            `step ${s.id} can never be finished`);
        if (typeof s.satisfy === 'function') assert.ok(s.doIt, `step ${s.id} never says what to do`);
    }
});

test('A PAPER WITH NOTHING TO SHOW IS NEVER ASKED TO LOOK AT IT', () => {
    // The dead-end case: a step whose feature is not present on this paper is
    // not offered, and the count on the card shrinks with it.
    const all = stepsFor(WITH_LABELS).map(s => s.id);
    const bare = stepsFor(BARE).map(s => s.id);
    assert.deepStrictEqual(all, ['click', 'widen', 'cursor', 'contents', 'labels', 'tag',
        'fold', 'sectionAction', 'edit', 'computation', 'takeMe', 'follow', 'review']);
    for (const id of ['labels', 'tag', 'fold', 'contents', 'sectionAction']) {
        assert.ok(!bare.includes(id), `${id} needs something on the page to point at`);
    }
    // A computation can be dropped into ANY paper — it needs nothing already
    // there — so it survives the bare case, and so does deciding how much the
    // page follows you.
    assert.deepStrictEqual(bare,
        ['click', 'widen', 'cursor', 'edit', 'computation', 'takeMe', 'follow', 'review'],
        'what is left is what any paper can do');
    assert.strictEqual(stepAt({ at: 0 }, BARE).total, bare.length,
        'the card counts the steps this reader will actually see');
});

test('SHIFT IS STILL OFFERED FOR THE TAGS WHEN A PAPER HAS NO LABELS', () => {
    // Shift used to reveal only the \label badges, so the step was gated on
    // those alone. It now also brings the copy tags and the fold controls, and
    // a paper without a single \label still has all of those.
    const ids = stepsFor({ hasLabels: false, hasSections: true, hasAnchors: true }).map(s => s.id);
    assert.ok(ids.includes('labels'), 'the Shift step is still worth showing');
    assert.ok(ids.includes('tag') && ids.includes('fold'));

    // An unsectioned paper with equations can be tagged but not folded.
    const eqOnly = stepsFor({ hasAnchors: true, hasSections: false }).map(s => s.id);
    assert.ok(eqOnly.includes('tag'), 'an equation is somewhere worth pointing at');
    assert.ok(!eqOnly.includes('fold'), 'but there is no section to fold');
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

    // The two gestures added since: a place copied, and a section folded.
    assert.ok(satisfies({ id: 'tag' }, { type: 'copyAnchor', key: 'eq:1' }));
    assert.ok(!satisfies({ id: 'tag' }, { type: 'copyLabel' }),
        'copying a \\ref is the step before, not this one');
    assert.ok(satisfies({ id: 'fold' }, { type: 'sectionFold', key: 's1', collapse: true }));
    assert.ok(!satisfies({ id: 'fold' }, { type: 'sectionFold', key: 's1', collapse: false }),
        'UNfolding is not the thing being taught');

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

test('every step that names a control still names one that exists', () => {
    // A ring pointing at nothing is worse than no ring.
    const inShell = require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', '..', 'client', 'tex-viewer.shell.html'), 'utf8');
    for (const s of STEPS) {
        if (!s.point) continue;
        assert.ok(inShell.includes(`id="${s.point.slice(1)}"`),
            `${s.id} points at ${s.point}, which is not in the panel`);
    }
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
