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
        id: 'contents',
        title: 'Find your way through it',
        say: 'The contents open over the paper, numbered as the paper numbers them, with the section you are in already marked. Click one and they get out of the way. The paper\'s own cross-references work too — a \\ref or a contents entry is a live link, marked with a dashed rule.',
        doIt: 'Press ☰ in the toolbar (or ⌘⌥O), then click a section.',
        point: '#outline',
        when: (ctx) => !!ctx.hasSections,
        satisfy: (e) => e.type === 'revealSection',
    },
    {
        id: 'labels',
        title: 'Hold Shift: the paper\'s own skeleton',
        say: 'Every \\label appears beside the thing it names and every \\ref beside what it points at — and every heading and equation grows a tag and a fold control.',
        doIt: 'Hold Shift.',
        point: '#labels',
        when: (ctx) => !!(ctx.hasLabels || ctx.hasAnchors),
        satisfy: (e) => e.type === 'labelsWanted' || e.type === 'copyLabel',
    },
    {
        id: 'tag',
        title: 'Point an agent at a place',
        say: 'The tag beside a heading or an equation copies its file and line — paste that at an agent and it can open the paper exactly there. Alt-click adds the page and the name, for a person.',
        doIt: 'With Shift held, click a § or ≡ tag.',
        when: (ctx) => !!ctx.hasAnchors,
        satisfy: (e) => e.type === 'copyAnchor',
    },
    {
        id: 'fold',
        title: 'Put a section away while you work',
        say: 'Fold a section and WPaper stops typesetting it, so the paper on screen is the part you are working on. Your .tex keeps every word — two comment lines record the fold, and a colleague on Overleaf still sees the whole paper.',
        doIt: 'With Shift held, press ▾ fold beside a heading.',
        when: (ctx) => !!ctx.hasSections,
        satisfy: (e) => e.type === 'sectionFold' && !!e.collapse,
    },
    {
        id: 'sectionAction',
        title: 'Move a section, from the page',
        say: 'The same three the selection bar offers — copy, cut, delete — on a whole sectioning unit WITH its body. Copy one, then press ⌘V on the paper: a paste asks WHERE, with the same blue caret, and the click decides.',
        doIt: 'With Shift held, press the copy icon beside a heading.',
        when: (ctx) => !!ctx.hasSections,
        satisfy: (e) => e.type === 'anchorAction',
    },
    {
        id: 'edit',
        title: 'Edit it where it prints',
        say: 'Right-click a paragraph or an equation and it opens in a card pinned under it. What you type goes straight into the .tex.',
        doIt: 'Right-click a paragraph.',
        satisfy: (e) => e.type === 'editHere',
    },
    {
        id: 'computation',
        title: 'Compute inside the paper',
        say: 'Drop a Mathematica cell where you want its result. Run it on a kernel and the answer comes back as real LaTeX — an equation broken to the paper\'s own width, or a PDF figure — written into the .tex as managed output with its own provenance. The .tex still compiles anywhere: everything Wolfbook adds is a comment.',
        doIt: 'Press ∑+ and move over the paper — the caret shows where it would go. Esc if you would rather not.',
        point: '#addmma',
        satisfy: (e) => e.type === 'insertPreview' || e.type === 'insertCommit',
    },
    {
        id: 'takeMe',
        title: 'Go to the source',
        say: 'Double-click anything to jump to it in the editor — and out of full screen, if you are in it.',
        doIt: 'Double-click a word.',
        satisfy: (e) => e.type === 'click' && !!e.takeMe,
    },
    {
        id: 'follow',
        title: 'Decide how much the page follows you',
        say: 'follow cycles off, mark and scroll. `mark` shows where your caret is without moving the paper — which is what you want while writing prose beside it. The footer keeps the places you have been editing, so getting back to one is a click.',
        doIt: 'Click follow in the toolbar.',
        point: '#follow',
        satisfy: (e) => e.type === 'follow',
    },
    {
        id: 'review',
        title: 'When an agent edits the paper',
        say: 'Its changes wait below, grouped by the section they are in, until you Keep or Undo them — one, a whole section, or all of them. Nothing is ever approved by arriving, and a change that lands while you are typing is merged with your unsaved edits rather than fighting them.',
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
