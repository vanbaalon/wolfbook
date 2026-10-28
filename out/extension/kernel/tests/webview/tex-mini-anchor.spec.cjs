'use strict';

const { fixtureTex } = require('./tex-webview-bugs.spec.cjs');
const rect = { page: 1, x: 72, y: 180, w: 400, h: 200 };

async function snapshot(t) {
    return t.eval(() => {
        const c = document.querySelector('.editcard'), ta = c.querySelector('textarea');
        return { top: parseFloat(c.style.top), height: c.offsetHeight,
            scroll: document.querySelector('main').scrollTop,
            start: ta.selectionStart, end: ta.selectionEnd, focused: document.activeElement === ta };
    });
}

async function dragTo(t, top) {
    // Scroll the header into view without giving the browser a focus target.
    await t.eval(() => {
        const c = document.querySelector('.editcard'), m = document.querySelector('main');
        m.scrollTop += c.getBoundingClientRect().top - m.getBoundingClientRect().top - 80;
    });
    await t.sleep(50);
    const before = await snapshot(t);
    const p = await t.eval(() => {
        const r = document.querySelector('.ec-title').getBoundingClientRect();
        return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await t.page.mouse.move(p.x, p.y);
    await t.page.mouse.down();
    await t.page.mouse.move(p.x, p.y + top - before.top, { steps: 4 });
    await t.page.mouse.up();
    await t.eval(() => {
        const ta = document.querySelector('.editcard textarea');
        ta.focus({ preventScroll: true }); ta.setSelectionRange(2, 5);
    });
    t.near((await snapshot(t)).top, top, 1, 'the title drag placed the card');
}

async function open(t) {
    await t.post({ type: 'editOpen', editId: 11, label: 'paragraph', file: 'fx.tex',
        startLine: 7, endLine: 9, text: 'One line of source text.', rects: [rect] });
    await t.waitFor(() => !!document.querySelector('.editcard textarea'), null, { what: 'mini-editor' });
    await t.sleep(80);
    return t.pxPerBp(1);
}

async function anchor(t, r, expected) {
    const before = await snapshot(t);
    await t.post({ type: 'editAnchor', editId: 11, rects: [r], live: true });
    await t.sleep(50);
    const after = await snapshot(t);
    t.near(after.top, expected, 1, 'the chosen edge and distance are preserved');
    t.near(after.scroll, before.scroll, 1, 'reanchoring does not scroll the viewer');
    t.assert(after.start === before.start && after.end === before.end && after.focused,
        'the textarea keeps focus and its selection');
}

const tests = [{
    id: 'mini-above', name: 'a card dragged above stays above through growth, shrinkage and a full PDF handoff',
    async run(t) {
        const k = await open(t), top = 90 * k;
        await dragTo(t, top);
        const height = (await snapshot(t)).height;
        await t.post({ type: 'editUpdate', editId: 11, text: 'A newly typed source line.\n'.repeat(30) });
        t.assert((await snapshot(t)).height > height, 'source typing grows the editor without choosing another edge');
        await anchor(t, { ...rect, h: rect.h + 40 }, top);
        await t.open(2);
        await anchor(t, { ...rect, h: rect.h + 80 }, top);
        await anchor(t, { ...rect, y: rect.y + 16 }, top + 16 * k);
    },
}, {
    id: 'mini-below', name: 'a card dragged below follows the bottom with its custom gap on growth and shrinkage',
    async run(t) {
        const k = await open(t), top = (rect.y + rect.h) * k + 48;
        await dragTo(t, top);
        await anchor(t, { ...rect, h: rect.h + 40 }, top + 40 * k);
        await anchor(t, { ...rect, h: rect.h + 80 }, top + 80 * k);
        await anchor(t, rect, top);
    },
}, ...['top', 'bottom'].map(edge => ({
    id: `mini-overlap-${edge}`, name: `a card overlapping mostly toward the ${edge} follows that edge`,
    async run(t) {
        const k = await open(t), height = (await snapshot(t)).height;
        const top = (rect.y + rect.h / 2) * k - height / 2 + (edge === 'top' ? -20 : 20);
        await dragTo(t, top);
        await anchor(t, { ...rect, h: rect.h + 40 }, top + (edge === 'bottom' ? 40 * k : 0));
        await anchor(t, rect, top);
    },
})), {
    id: 'mini-redrag', name: 'dragging to another side replaces the attachment and double-click restores automatic placement',
    async run(t) {
        const k = await open(t), above = 90 * k;
        await dragTo(t, above);
        await anchor(t, { ...rect, h: rect.h + 40 }, above);
        const below = (rect.y + rect.h + 40) * k + 32;
        await dragTo(t, below);
        await anchor(t, { ...rect, h: rect.h + 80 }, below + 40 * k);
        await t.eval(() => document.querySelector('.ec-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        const auto = (rect.y + rect.h + 80) * k + 8;
        t.near((await snapshot(t)).top, auto, 1, 'double-click restores the default gap');
        await anchor(t, rect, (rect.y + rect.h) * k + 8);
    },
}];

module.exports = { fixtureTex, tests };
