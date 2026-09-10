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
        say: 'The contents open over the paper, numbered as the paper numbers them, with the section you are in already marked. Click one and they get out of the way. The paper\'s own cross-references work too: hover an equation number for a miniature, or click it to jump.',
        doIt: 'Press ☰ in the toolbar (or ⌘⌥O), then click a section.',
        point: '#outline',
        when: (ctx) => !!ctx.hasSections,
        satisfy: (e) => e.type === 'revealSection',
    },
    {
        id: 'compare',
        title: 'Compare any version',
        say: 'Compare overlays another saved, Git or working-tree version on this paper. Step through its changes without leaving the place you are reading.',
        doIt: 'Press the compare icon in the toolbar. You can cancel the version picker.',
        point: '#compare',
        satisfy: (e) => e.type === 'compare',
    },
    {
        id: 'pageTheme',
        title: 'Choose the paper, not the editor',
        say: 'The page may stay white in a dark editor, or be softened for dark reading. Fit remains edge-to-edge; comment bubbles move inside the sheet when there is no outer margin.',
        doIt: 'Press the sun or moon in the toolbar.',
        point: '#pagetheme',
        satisfy: (e) => e.type === 'pageTheme',
    },
    {
        id: 'fit',
        title: 'Fit that follows your workspace',
        say: 'A click fits once. Double-click Fit to keep the page width tied to the visible field while you drag the editor separator, without losing your place. At a larger zoom, the horizontal scrollbar reaches both edges of the paper.',
        doIt: 'Double-click Fit in the toolbar.',
        point: '#fit',
        satisfy: (e) => e.type === 'fitMode',
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
        id: 'comments',
        title: 'Leave instructions for an agent',
        say: 'Comments are designed chiefly as precise feedback for agents: each note stays attached as the source moves and is saved beside the paper for sharing. The arrow lists every note; ‹ and › move through them on the page.',
        doIt: 'Press Comments in the toolbar.',
        point: '#commentsbutton',
        satisfy: (e) => e.type === 'commentView' && !!e.open,
    },
    {
        id: 'commentAt',
        title: 'Comment exactly where it belongs',
        say: 'Cmd-click text—including a heading, title page or abstract—or use its + bubble. The compact card is resizable; its options copy every note with current file and line numbers, ready for one agent prompt.',
        doIt: 'Cmd-click (Ctrl on Windows) the passage you want to annotate.',
        satisfy: (e) => e.type === 'click' && !!e.commentTarget,
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
        say: 'Right-click a paragraph or equation and it opens in a card pinned under it, with the main-editor caret kept in sync. Edits go into the live .tex buffer; tracing pauses while the page is behind and a small edit does not move your reading position.',
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
        id: 'layout',
        title: 'Make room for the work at hand',
        say: 'The layout button switches between a focused WPaper and WPaper beside your editor. Fit recalculates against the space the paper actually has.',
        doIt: 'Press the layout icon in the toolbar.',
        point: '#full',
        satisfy: (e) => e.type === 'layoutCycle',
    },
    {
        id: 'review',
        title: 'When an agent edits the paper',
        say: 'Its changes wait below until you Keep or Undo them—one, a section, or all. A decision advances only to a nearby change; the arrows can cross the paper deliberately. Accept + comment saves a revision note with the ordinary comments, ready for the next agent prompt.',
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
