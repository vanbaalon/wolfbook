// tourSteps.js — the first-run tour, as data.
//
// Pure: no vscode. The panel draws a card, the viewer watches the messages the
// panel already posts, and this decides what to say and when it has been done.
//
// A TOUR THAT TALKS IS A TOUR NOBODY FINISHES. Every step here asks for one
// real gesture on the reader's own paper and advances when the panel reports
// that gesture — not when a Next button is pressed. That is why the steps are
// keyed to the message vocabulary the viewer already has (`click` with its
// modifiers, `editHere`, `labelsWanted`, `reviewAction`): nothing here is a
// simulation, and a reader who skips the tour has still learned it by doing.
//
// A step that cannot be done on THIS paper is not offered (see `when`): a paper
// with no labels must not be told to hold Shift and watch nothing happen.

/** @typedef {{type:string, widen?:boolean, takeMe?:boolean, pick?:boolean}} TourEvent */

const STEPS = [
    {
        id: 'click',
        title: 'Click any word',
        say: 'Every word on the page knows where it came from — in maths, right down to the symbol.',
        doIt: 'Click a word on the paper.',
        satisfy: (e) => e.type === 'click' && !e.widen && !e.takeMe && !e.pick,
    },
    {
        id: 'widen',
        title: 'Take more of what it is in',
        say: 'Cmd-click walks outwards: the word, then what encloses it — the sentence, the equation, the section. Shift walks back in.',
        doIt: 'Cmd-click (Ctrl on Windows) the word you just clicked.',
        satisfy: (e) => e.type === 'click' && !!e.widen,
    },
    {
        id: 'cursor',
        title: 'It works the other way too',
        say: 'Move the caret in the .tex and the paper marks where you are — the same map, read backwards.',
        doIt: 'Click somewhere in the editor.',
        satisfy: (e) => e.type === 'cursor',
    },
    {
        id: 'labels',
        title: 'Every name on the page',
        say: 'Hold Shift and each \\label appears beside the thing it names, each \\ref beside what it points at. Click one to copy the reference.',
        doIt: 'Hold Shift.',
        point: '#labels',
        when: (ctx) => !!ctx.hasLabels,
        satisfy: (e) => e.type === 'labelsWanted' || e.type === 'copyLabel',
    },
    {
        id: 'edit',
        title: 'Edit it where it prints',
        say: 'Right-click a paragraph or an equation and it opens in a card pinned under it. What you type goes straight into the .tex.',
        doIt: 'Right-click a paragraph.',
        satisfy: (e) => e.type === 'editHere',
    },
    {
        id: 'takeMe',
        title: 'Go to the source',
        say: 'Double-click anything to jump to it in the editor — and out of full screen, if you are in it.',
        doIt: 'Double-click a word.',
        satisfy: (e) => e.type === 'click' && !!e.takeMe,
    },
    {
        id: 'review',
        title: 'When an agent edits the paper',
        say: 'Its changes wait in the review below until you Keep or Undo them, one at a time. Nothing is ever approved by arriving.',
        // No gesture: a reader with no pending changes cannot perform one, and
        // asking them to would be a dead end. The card's own button ends it.
        done: 'Done',
        point: '#reviewbar',
    },
];

/** The steps that make sense for this paper. */
function stepsFor(ctx = {}) {
    return STEPS.filter(s => (typeof s.when === 'function' ? !!s.when(ctx) : true));
}

/**
 * Where the tour is: the step to show, or null when there is nothing left.
 *
 * @param {{at:number, done:boolean}} progress
 * @param {object} ctx
 */
function stepAt(progress = {}, ctx = {}) {
    if (progress.done) return null;
    const steps = stepsFor(ctx);
    const at = Math.max(0, Math.min(Number(progress.at) || 0, steps.length));
    if (at >= steps.length) return null;
    const s = steps[at];
    return {
        index: at,
        total: steps.length,
        id: s.id,
        title: s.title,
        say: s.say,
        doIt: s.doIt || null,
        done: s.done || null,
        point: s.point || null,
    };
}

/** Did this message do what the step asked for? */
function satisfies(step, ev) {
    if (!step || !ev) return false;
    const s = STEPS.find(x => x.id === (step.id || step));
    if (!s || typeof s.satisfy !== 'function') return false;
    try { return !!s.satisfy(ev); } catch (_) { return false; }
}

module.exports = { STEPS, stepsFor, stepAt, satisfies };
