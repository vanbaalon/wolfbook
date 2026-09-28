'use strict';

// tex-webview-bugs.spec.cjs — one regression test per user-reported WPaper bug
// that lives in the webview (docs/tex-reported-bugs.md, class "webview"),
// plus the Pro badge switch, right-click → editHere and tikzOpenAt.
//
// Run with:  node out/extension/kernel/tests/webview/harness.cjs [ids…]
//
// Every test is black-box: it posts what the extension host would post, reads
// what the panel posts back (window.__posted) and looks at the DOM, computed
// style or screen pixels. Each test starts from a fresh panel with the
// fixture below open as generation 1. A test with `todo` is a known,
// unfixed bug: it is expected to fail and does not fail the run.

const fixtureTex = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath}
\usepackage{tikz}\usepackage{hyperref}
\begin{document}
\section{Fixture}
The velocity $\dot{Z}$ of the particle appears here in a paragraph of
ordinary prose, long enough to wrap onto a second line so that a selection
has more than one printed row to cover on the page.

\begin{tabular}{|l|c|}\hline
alpha & beta \\
gamma & delta \\ \hline
\end{tabular}

\begin{tikzpicture}
\draw[thick] (0,0) -- (3,1.5);
\node at (1.5,0) {figlabel};
\end{tikzpicture}

\begin{equation}\label{eq:x}
  E = \frac{m c^2}{\sqrt{1 - v^2}}
\end{equation}
Seen again in \eqref{eq:x}, here.
\end{document}
`;

// The paragraph's source (lines 7–9), as the host would send it to the card.
const PARA = fixtureTex.split('\n').slice(6, 9).join('\n');
const TABLE = fixtureTex.split('\n').slice(10, 14).join('\n');

// --- helpers -----------------------------------------------------------------

const box = (w) => ({ page: w.page, x: w.x, y: w.y, w: w.w, h: w.h });

/** The printed rows of the fixture paragraph, as the host's row rects. */
function paraRows(t) {
    const rowOf = (from, to) => {
        const a = t.word(from), b = t.word(to);
        return { page: 1, x: a.x, y: a.y, w: b.x1 - a.x, h: b.y1 - a.y };
    };
    return [rowOf('The', 'onto'), rowOf('second', 'page.')];
}

/** An exact ('native') highlight on a word with the red caret k characters in. */
function highlightOn(w, k = 1, extra = {}) {
    return {
        type: 'highlight', exact: true, word: w.text, rects: [box(w)],
        caret: { page: w.page, x: w.x + (w.w * k) / w.text.length, y: w.y, h: w.h, offset: k },
        ...extra,
    };
}

async function openParagraphCard(t, extra = {}) {
    await t.post({
        type: 'editOpen', editId: 11, label: 'paragraph', file: 'fx.tex',
        startLine: 7, endLine: 9, text: PARA, rects: paraRows(t), ...extra,
    });
    await t.waitFor(() => !!document.querySelector('.editcard textarea'), null, { what: 'the mini-editor card' });
    await t.sleep(120);
}

async function proOn(t) {
    await t.post({ type: 'engine', state: 'live', keyMs: 18 });
    await t.waitFor(() => !document.getElementById('probadge').hidden, null, { what: 'the Pro badge' });
}

async function clickWord(t, w, frac = 0.5, opts = {}) {
    const p = await t.toClient(w.page, w.x + w.w * frac, w.y + w.h / 2);
    await t.page.mouse.click(p.x, p.y, opts);
    return p;
}

const count = (t, sel) => t.eval(s => document.querySelectorAll(s).length, sel);

// --- the tests ------------------------------------------------------------------

const tests = [
    {
        id: '#3',
        name: 'a page click with the card open moves the card caret to the clicked character',
        async run(t) {
            await openParagraphCard(t);
            await t.clear();
            const w = t.word('particle');
            await clickWord(t, w, 0.4);
            const click = await t.waitPosted('click');
            t.assert(click.page === 1, 'the click names page 1');
            t.assert(click.xBp >= w.x - 1 && click.xBp <= w.x1 + 1 && click.yTopBp >= w.y - 1 && click.yTopBp <= w.y1 + 1,
                `the click is posted at the clicked word (xBp ${click.xBp}, yTopBp ${click.yTopBp})`);
            t.assert((await t.posted('editHere')).length === 0, 'a left click does not ask for a new card');
            // The host resolves the click into the open block and answers.
            const at = PARA.indexOf('particle');
            await t.post({ type: 'editSelect', editId: 11, start: at, end: at + 8, caret: at + 3, focus: true });
            await t.waitFor(c => { const ta = document.querySelector('.editcard textarea');
                return ta && ta.selectionStart === c && ta.selectionEnd === c && document.activeElement === ta; },
            at + 3, { what: 'the card caret to reach the clicked character' });
            await t.post({ type: 'editSelect', editId: 11, start: at, end: at + 8, caret: at + 6, focus: true });
            await t.waitFor(c => document.querySelector('.editcard textarea').selectionStart === c, at + 6,
                { what: 'a second click to move the card caret again' });
            await t.sleep(150);
            t.assert((await t.posted('editCaret')).length === 0,
                'the caret the page put in the card is not posted back as a move of the reader\'s');
        },
    },
    {
        id: '#4',
        name: 'the page caret does not blink; a card caret move reaches the host at once; a burst collapses',
        async run(t) {
            await t.post(highlightOn(t.word('velocity'), 3));
            await t.waitFor(() => !!document.querySelector('.curcaret'), null, { what: 'the red caret' });
            const anim = await t.eval(() => getComputedStyle(document.querySelector('.curcaret')).animationName);
            t.assert(anim === 'none', `the red page caret has no animation (got ${anim})`);
            const blinkRules = await t.eval(() => {
                let n = 0;
                for (const sheet of document.styleSheets) {
                    let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
                    for (const r of rules) if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'caretblink') n++;
                }
                return n;
            });
            t.assert(blinkRules === 0, `no caretblink keyframes are defined (${blinkRules})`);

            await openParagraphCard(t);
            await t.eval(() => document.querySelector('.editcard textarea').focus());
            await t.sleep(200);
            await t.clear();
            const dt = await t.eval(async () => {
                const ta = document.querySelector('.editcard textarea');
                const t0 = performance.now();
                ta.setSelectionRange(5, 5);
                ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
                for (let i = 0; i < 100; i++) {
                    const k = window.__posted.findIndex(m => m.type === 'editCaret');
                    if (k >= 0) return window.__postedAt[k] - t0;
                    await new Promise(r => setTimeout(r, 1));
                }
                return -1;
            });
            t.assert(dt >= 0, 'an isolated caret move in the card is posted');
            t.assert(dt <= 10, `and within 10 ms, not on a debounce (${dt.toFixed(1)} ms)`);

            await t.sleep(200);
            await t.clear();
            await t.eval(() => {
                const ta = document.querySelector('.editcard textarea');
                for (let i = 0; i < 12; i++) {
                    ta.setSelectionRange(10 + i, 10 + i);
                    ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
                }
            });
            await t.sleep(250);
            const burst = await t.posted('editCaret');
            t.assert(burst.length === 1, `a burst of 12 moves posts one message (${burst.length})`);
            t.assert(burst[0].start === 21, `carrying the final position (${burst[0].start})`);
        },
    },
    {
        id: '#5',
        name: 'focusing the card posts no caret, and one gesture posts exactly one caret, never synchronously',
        async run(t) {
            await openParagraphCard(t);
            await t.eval(() => document.activeElement && document.activeElement.blur());
            await t.sleep(150);
            await t.clear();
            await t.eval(() => document.querySelector('.editcard textarea').focus());
            await t.sleep(200);
            t.assert((await t.posted('editCaret')).length === 0, 'focusing the card moves nothing and posts nothing');

            const syncCount = await t.eval(() => {
                const ta = document.querySelector('.editcard textarea');
                ta.setSelectionRange(7, 7);
                ta.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                ta.dispatchEvent(new Event('select', { bubbles: true }));
                return window.__posted.filter(m => m.type === 'editCaret').length;
            });
            t.assert(syncCount === 0, `nothing is posted synchronously inside the gesture (${syncCount})`);
            await t.sleep(200);
            const after = await t.posted('editCaret');
            t.assert(after.length === 1 && after[0].start === 7,
                `one click in the card posts one caret at the clicked offset (${JSON.stringify(after.map(m => m.start))})`);

            // Clicking word W on the page: the host highlights W and puts the
            // card caret there. The page keeps W; nothing echoes back.
            await t.clear();
            const w = t.word('appears');
            const at = PARA.indexOf('appears');
            await t.post(highlightOn(w, 2));
            await t.post({ type: 'editSelect', editId: 11, start: at, end: at + 7, caret: at + 2, focus: true });
            await t.sleep(250);
            t.assert((await t.posted('editCaret')).length === 0, 'the host\'s caret is not posted back');
            const hl = await t.eval(() => { const h = document.querySelector('.hl'); return h && { left: parseFloat(h.style.left), width: parseFloat(h.style.width) }; });
            const k = await t.pxPerBp();
            t.assert(!!hl, 'the page shows the highlight');
            t.near(hl.left, w.x * k, 1.5, 'and it stays on the clicked word');
        },
    },
    {
        id: '#6',
        name: 'holding an arrow key in the card moves the page caret during auto-repeat',
        async run(t) {
            await openParagraphCard(t);
            await t.eval(() => { const ta = document.querySelector('.editcard textarea'); ta.focus(); ta.setSelectionRange(30, 30); });
            await t.sleep(200);
            await t.clear();
            // Real key events through the browser: the first down, then
            // auto-repeats (Playwright marks a second down as a repeat). No
            // keyup until the end and no setSelectionRange, so neither
            // `keyup` nor `select` can be what reports the move.
            for (let i = 0; i < 8; i++) {
                await t.page.keyboard.down('ArrowRight');
                await t.sleep(40);
            }
            const during = await t.posted('editCaret');
            const pos = await t.eval(() => document.querySelector('.editcard textarea').selectionStart);
            await t.page.keyboard.up('ArrowRight');
            t.assert(pos > 30, `the key really moved the caret (at ${pos})`);
            t.assert(during.length >= 2, `the moves are posted while the key is held, not only on release (${during.length})`);
            t.assert(during[during.length - 1].start > 30, `the last one is further along (${JSON.stringify(during.map(m => m.start))})`);
            t.assert(during.length <= 8, `still coalesced (${during.length})`);
        },
    },
    {
        id: '#9',
        name: 'review marks are re-placed for the render on screen, and follow a re-render',
        async run(t) {
            const session = (generation, rect) => ({
                file: 'fx.tex', pending: 1, census: '1 change', summary: {}, focus: 'h1', generation,
                groups: [{ id: 'b1', at: Date.now(), lastAt: Date.now(), writes: 1, source: 'disk', count: 1,
                    hunks: [{ id: 'h1', verb: 'change', where: 'rows', page: 1, lines: 1, changedWords: 1,
                        rects: [rect], name: 'paragraph', startLine: 7, editedByYou: false, section: null,
                        theirText: 'one', ourText: 'two', words: null }] }],
                decided: [],
            });
            const band = () => t.eval(() => {
                const wrap = document.querySelector('.page[data-page="1"]');
                const b = wrap && wrap.querySelector('.rband');
                if (!b) return null;
                const p = wrap.getBoundingClientRect(), r = b.getBoundingClientRect();
                return { fx: (r.left - p.left) / p.width, fy: (r.top - p.top) / p.height };
            });
            const W = t.fixture.pages[0].width, H = t.fixture.pages[0].height;
            const A = box(t.word('velocity')), B = box(t.word('selection'));
            await t.post({ type: 'review', session: session(1, A) });
            await t.waitFor(() => !!document.querySelector('.rband'), null, { what: 'the review band' });
            const a = await band();
            t.near(a.fx, A.x / W, 0.01, 'the band is on its rect');

            // A new generation lands: the old placement describes another render.
            await t.open(2);
            await t.sleep(200);
            t.assert(await count(t, '.rband') === 0, 'a placement stamped for generation 1 is not painted over generation 2');
            // …and one that arrives late, still measured against generation 1.
            await t.post({ type: 'review', session: session(1, A) });
            await t.sleep(250);
            t.assert(await count(t, '.rband') === 0, 'a late placement for generation 1 is not painted over generation 2');
            t.assert(await count(t, '.rh') === 1, 'while the change itself stays on the review list');
            await t.post({ type: 'review', session: session(2, B) });
            await t.waitFor(() => !!document.querySelector('.rband'), null, { what: 'the re-placed band' });
            const b = await band();
            t.near(b.fx, B.x / W, 0.01, 'the re-placed band is at its new rect (x)');
            t.near(b.fy, B.y / H, 0.01, 'the re-placed band is at its new rect (y)');

            // A re-render (zoom) repaints it at the same spot of the page.
            await t.page.click('#zoomin');
            await t.sleep(500);
            await t.page.click('#zoomin');
            await t.sleep(700);
            const c = await band();
            t.assert(!!c, 'the band survives the re-render');
            t.near(c.fx, b.fx, 0.01, 'and stays on the same spot of the page (x)');
            t.near(c.fy, b.fy, 0.01, 'and stays on the same spot of the page (y)');
        },
    },
    {
        id: '#20',
        name: 'the Pro badge is compact: a state dot and a PRO tag, the state in the tooltip',
        async run(t) {
            await proOn(t);
            const b = await t.eval(() => {
                const badge = document.getElementById('probadge');
                const r = badge.getBoundingClientRect();
                const st = badge.querySelector('.pro-state');
                const tag = badge.querySelector('.pro-mark b');
                return { w: r.width, stateShown: getComputedStyle(st).display !== 'none',
                    tag: tag && getComputedStyle(tag).display !== 'none' ? getComputedStyle(tag).textTransform + ':' + tag.textContent : null,
                    dot: getComputedStyle(badge.querySelector('.pro-dot')).display !== 'none',
                    title: badge.title };
            });
            t.assert(b.w > 0 && b.w <= 64, `the badge is a few tens of px wide (${b.w.toFixed(1)} px)`);
            t.assert(!b.stateShown, 'the state text is not shown in the toolbar');
            t.assert(b.dot, 'a state dot is shown');
            t.assert(b.tag === 'uppercase:Pro', `a PRO tag is shown (${b.tag})`);
            t.assert(/typing, 18 ms after the key/.test(b.title), `the state moved to the tooltip (${b.title})`);
            const aria = await t.eval(() => document.getElementById('probadge').getAttribute('aria-label'));
            t.assert(/live · 18 ms/.test(aria), `and is still named for assistive tech (${aria})`);
        },
    },
    {
        id: '#21',
        name: 'find hits are a translucent multiplied wash; the glyph under the current hit stays visible',
        async run(t) {
            await t.page.click('#findtool');
            await t.page.fill('#findinput', 'velocity');
            await t.waitFor(() => !!document.querySelector('.find-hit.current'), null, { what: 'a current find hit' });
            await t.sleep(150);
            const s = await t.eval(() => {
                const hit = document.querySelector('.find-hit.current');
                const cs = getComputedStyle(hit);
                const r = hit.getBoundingClientRect();
                return { bg: cs.backgroundColor, blend: cs.mixBlendMode, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
            });
            const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(s.bg);
            t.assert(alpha && Number(alpha[1]) < 0.7, `the current hit is translucent (${s.bg})`);
            t.assert(!/255,\s*0,\s*0/.test(s.bg), `it does not use the theme's (opaque) find colour (${s.bg})`);
            t.assert(s.blend === 'multiply', `it is multiplied over the ink (${s.blend})`);
            const px = await t.pixels(s.rect);
            let dark = 0;
            for (let i = 0; i < px.data.length; i += 4) {
                const lum = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
                if (lum < 90) dark++;
            }
            t.assert(dark >= 20, `the word's ink is still visible under the current hit (${dark} dark px)`);
        },
    },
    {
        id: '#24',
        name: 'a left click only moves the cursor; the card opens on right-click with its caret at the clicked symbol',
        async run(t) {
            await proOn(t);
            await t.clear();
            await clickWord(t, t.word('beta'));
            await t.waitPosted('click');
            await t.sleep(200);
            t.assert((await t.posted('editHere')).length === 0, 'a left click on a table does not ask for the card');
            t.assert(await count(t, '.editcard') === 0, 'and no card opens');

            // Right-click an equation-like block: the host answers with the
            // clicked symbol's offset and the card's caret goes there.
            await clickWord(t, t.word('Ż'), 0.5, { button: 'right' });
            await t.waitPosted('editHere');
            const EQ = String.raw`The velocity $\dot{Z}$ of`;
            const at = EQ.indexOf(String.raw`\dot`);
            await t.post({ type: 'editOpen', editId: 21, label: 'equation', file: 'fx.tex', startLine: 7, endLine: 7,
                text: EQ, rects: paraRows(t).slice(0, 1), clickOffset: at, caretStart: at, caretEnd: at });
            await t.waitFor(c => { const ta = document.querySelector('.editcard textarea');
                return ta && ta.selectionStart === c && ta.selectionEnd === c && document.activeElement === ta; }, at,
            { what: `the card caret at the clicked symbol (offset ${at})` });

            // A table: the grid focuses the clicked cell.
            await t.post({ type: 'editClosed' });
            const cellAt = TABLE.indexOf('beta') + 1;
            await t.post({ type: 'editOpen', editId: 22, label: 'table', file: 'fx.tex', startLine: 11, endLine: 14,
                text: TABLE, rects: [box(t.word('alpha')), box(t.word('delta'))],
                clickOffset: cellAt, caretStart: cellAt, caretEnd: cellAt });
            await t.waitFor(() => !!document.querySelector('.editcard'), null, { what: 'the table card' });
            await t.sleep(200);
            const f = await t.eval(() => {
                const a = document.activeElement, ta = document.querySelector('.editcard textarea');
                return { row: a && a.dataset ? a.dataset.row : null, col: a && a.dataset ? a.dataset.col : null,
                    grid: !!document.querySelector('.editcard .ec-grid'), ta: ta && ta.selectionStart };
            });
            t.assert(f.ta === cellAt, `the table card's source caret is at the clicked cell (${f.ta} vs ${cellAt})`);
            if (f.grid) t.assert(f.row === '0' && f.col === '1', `the grid focuses the clicked cell (row ${f.row}, col ${f.col})`);
        },
    },
    {
        id: '#25',
        name: 'dragging one selection bracket adjusts only that end',
        async run(t) {
            const v = t.word('velocity'), p = t.word('particle');
            const row = { page: 1, x: v.x, y: v.y, w: p.x1 - v.x, h: v.h };
            await t.post({ type: 'selection', span: { native: true, rows: [row],
                start: { exactEdge: { page: 1, x: v.x, y: v.y, h: v.h } },
                end: { exactEdge: { page: 1, x: p.x1, y: p.y, h: p.h } }, lines: 1 }, reveal: false });
            await t.waitFor(() => document.querySelectorAll('.selbrk').length === 2, null, { what: 'two brackets' });
            await t.sleep(100);
            const center = (sel) => t.eval(s => { const r = document.querySelector(s).getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);

            for (const side of ['end', 'start']) {
                await t.clear();
                const c = await center(`.selbrk.${side}`);
                await t.page.mouse.move(c.x, c.y);
                await t.page.mouse.down();
                const dx = side === 'end' ? 12 : -12;
                for (let i = 1; i <= 5; i++) { await t.page.mouse.move(c.x + dx * i, c.y); await t.sleep(80); }
                await t.page.mouse.up();
                await t.sleep(250);
                const all = await t.posted();
                const adj = all.filter(m => m.type === 'selectAdjust');
                t.assert(adj.length === 1 && adj[0].end === side,
                    `pressing the ${side} bracket adjusts the ${side} end only (${JSON.stringify(adj)})`);
                t.assert(!all.some(m => m.type === 'selectionClear'), `dragging the ${side} bracket does not drop the selection`);
                const picks = all.filter(m => m.type === 'click');
                t.assert(picks.length >= 2 && picks.every(m => m.pick), `the drag reports picks of the moving end (${picks.length})`);
                const xs = picks.map(m => m.xBp);
                t.assert(side === 'end' ? xs[xs.length - 1] > xs[0] : xs[xs.length - 1] < xs[0],
                    `the picks follow the pointer (${xs.map(x => x.toFixed(0)).join(',')})`);
                // Put the selection back for the other side.
                await t.post({ type: 'selection', span: { native: true, rows: [row],
                    start: { exactEdge: { page: 1, x: v.x, y: v.y, h: v.h } },
                    end: { exactEdge: { page: 1, x: p.x1, y: p.y, h: p.h } }, lines: 1 }, reveal: false });
                await t.waitFor(() => document.querySelectorAll('.selbrk').length === 2, null, { what: 'two brackets again' });
                await t.sleep(300);
            }
        },
    },
    {
        id: '#28',
        name: 'the compile glow does not shine through the tour card',
        async run(t) {
            await t.page.emulateMedia({ reducedMotion: 'reduce' });   // a steady glow, not a pulse
            await t.post({ type: 'tour', step: { index: 0, total: 6, id: 'fixture', title: 'Tour',
                say: 'A tour card over the page.', doIt: null, done: 'Done', point: null } });
            await t.waitFor(() => !document.getElementById('tour').hidden, null, { what: 'the tour card' });
            await t.sleep(300);
            const geo = await t.eval(() => {
                const r = document.getElementById('tour').getBoundingClientRect();
                const q = document.getElementById('reader').getBoundingClientRect();
                return { tour: { x: r.left, y: r.top, width: r.width, height: r.height },
                    reader: { x: q.left, y: q.top, width: q.width, height: q.height } };
            });
            // The inset glow reaches ~16 px in from the reader's edges; the
            // card's bottom rows sit that close to the reader's bottom edge.
            // Only the card's own pixels are compared: its corners are rounded
            // (7 px), and outside that curve the page behind is meant to show.
            const gap = (geo.reader.y + geo.reader.height) - (geo.tour.y + geo.tour.height);
            t.assert(gap >= 0 && gap < 14, `the card's bottom is inside the glow band (${gap.toFixed(0)} px from the reader's edge)`);
            const strip = { x: geo.tour.x + 9, y: geo.tour.y + geo.tour.height - 8, width: geo.tour.width - 18, height: 7 };
            const diff = (a, b) => { let n = 0, max = 0; for (let i = 0; i < a.data.length; i += 4) {
                const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
                if (d > 3) n++; max = Math.max(max, d); }
            return n; };
            const off = await t.pixels(strip);
            await t.post({ type: 'compileState', compiling: true });
            await t.waitFor(() => document.getElementById('reader').classList.contains('is-compiling'), null, { what: 'the glow' });
            await t.sleep(200);
            const on = await t.pixels(strip);
            // Ablation: take the reader's own stacking context away and the
            // glow must reach the card — proving the pixels can see it.
            await t.eval(() => { document.getElementById('reader').style.isolation = 'auto'; });
            await t.sleep(100);
            const leak = await t.pixels(strip);
            await t.eval(() => { document.getElementById('reader').style.isolation = ''; });
            const control = diff(off, leak);
            t.assert(control > 50, `ablation: without its own stacking context the glow does reach the card (${control} px) — the check can see it`);
            const changed = diff(off, on);
            t.assert(changed === 0, `no glow pixels over the card while compiling (${changed} px changed)`);
        },
    },
    {
        id: '#29',
        name: 'a cursor move never shows a frame without the wash or the caret',
        async run(t) {
            const words = ['velocity', 'particle', 'appears', 'paragraph', 'ordinary', 'second', 'selection', 'printed'].map(x => t.word(x));
            await t.post(highlightOn(words[0], 2, { reveal: true, instant: true }));
            await t.waitFor(() => !!document.querySelector('.hl') && !!document.querySelector('.curcaret'), null, { what: 'the first highlight' });
            const frames = await t.eval(async (moves) => {
                const out = []; let run = true;
                const tick = () => { out.push([document.querySelectorAll('.hl').length, document.querySelectorAll('.curcaret').length]);
                    if (run) requestAnimationFrame(tick); };
                requestAnimationFrame(tick);
                for (const m of moves) { window.postMessage(m, '*'); await new Promise(r => setTimeout(r, 35)); }
                await new Promise(r => setTimeout(r, 120));
                run = false;
                return out;
            }, words.slice(1).map((w, i) => highlightOn(w, 1 + (i % 3), { reveal: true, instant: true })));
            t.assert(frames.length >= 10, `frames were sampled (${frames.length})`);
            const blank = frames.filter(([h, c]) => h !== 1 || c !== 1);
            t.assert(blank.length === 0, `every frame has exactly one wash and one caret (${blank.length}/${frames.length} did not: ${JSON.stringify(blank.slice(0, 3))})`);
            const k = await t.pxPerBp();
            const last = words[words.length - 1];
            const left = await t.eval(() => parseFloat(document.querySelector('.hl').style.left));
            t.near(left, last.x * k, 1.5, 'the wash ends on the last word');
        },
    },
    {
        id: '#30',
        name: 'the lag pill is only a spinner while compiling, and the cursor readout is in the footer',
        async run(t) {
            await t.post({ type: 'traceState', paused: true, compiling: true, source: 'editor' });
            await t.waitFor(() => !document.getElementById('tracelag').hidden, null, { what: 'the lag pill' });
            const s = await t.eval(() => {
                const lag = document.getElementById('tracelag');
                return { pill: getComputedStyle(lag).display, text: getComputedStyle(lag.querySelector('.lagtext')).display,
                    spin: getComputedStyle(lag, '::before').animationName, w: lag.getBoundingClientRect().width };
            });
            t.assert(s.pill !== 'none', 'the pill is shown');
            t.assert(s.text === 'none', `its words are not shown while compiling (lagtext display ${s.text})`);
            t.assert(/wpspin/.test(s.spin), `it shows a spinner (${s.spin})`);
            t.assert(s.w < 30, `it is spinner-sized (${s.w.toFixed(1)} px)`);

            const where = await t.eval(() => ({ inHeader: !!document.querySelector('header #where'), inFooter: !!document.querySelector('footer #where') }));
            t.assert(!where.inHeader, 'the cursor readout is not in the toolbar');
            t.assert(where.inFooter, 'it is in the footer');
            await t.post({ type: 'traceState', paused: false });
            await t.post(highlightOn(t.word('velocity'), 1, { label: 'fx.tex:7:9' }));
            await t.waitFor(() => document.getElementById('where').textContent === 'fx.tex:7:9', null, { what: 'the readout text' });
            const vis = await t.eval(() => { const w = document.getElementById('where'); const f = document.querySelector('footer').getBoundingClientRect();
                const r = w.getBoundingClientRect(); return { shown: getComputedStyle(w).display !== 'none' && r.width > 0, inside: r.top >= f.top - 1 && r.bottom <= f.bottom + 1 }; });
            t.assert(vis.shown && vis.inside, 'the readout is visible inside the footer bar');
        },
    },
    {
        id: '#35',
        name: 'only one caret: the red caret gives way to the typing caret, and comes back',
        async run(t) {
            await t.post(highlightOn(t.word('particle'), 3));
            await t.waitFor(() => document.querySelectorAll('.curcaret').length === 1, null, { what: 'the red caret' });
            const s = t.word('second');
            await t.post({ type: 'inkCaret', page: 1, x: s.x + 5, y: s.y, h: s.h });
            await t.waitFor(() => document.querySelectorAll('.inkcaret').length === 1, null, { what: 'the typing caret' });
            t.assert(await count(t, '.curcaret') === 0, 'the red caret hides while the typing caret is on the page');
            await t.post(highlightOn(t.word('appears'), 2));
            await t.sleep(150);
            t.assert(await count(t, '.curcaret') === 0, 'an editor move meanwhile paints no second (red) caret');
            t.assert(await count(t, '.inkcaret') === 1, 'the typing caret stays');
            await t.post({ type: 'inkCaret', clear: true });
            await t.waitFor(() => document.querySelectorAll('.inkcaret').length === 0, null, { what: 'the typing caret to go' });
            t.assert(await count(t, '.curcaret') === 1, 'when the typing caret goes, the red caret comes back');
        },
    },
    {
        id: '#36',
        name: 'selection brackets sit at the exact first and last selected glyphs (not on the dot of \\dot Z)',
        async run(t) {
            // Selected source: "velocity $\dot{Z}$ of". The host sends the
            // glyph boxes sorted by (page, y, x): the dot of Ż is highest, so
            // it comes FIRST, and Z itself (lower) comes LAST — both
            // mid-selection. exactEdge names the real ends.
            const v = t.word('velocity'), z = t.word('Ż'), of = t.word('of');
            const dot = { page: 1, x: z.x + 2.2, y: v.y - 0.8, w: 2.5, h: 2.2 };
            const zbox = { page: 1, x: z.x, y: z.y, w: z.w, h: z.h };
            const rows = [dot, box(v), box(of), zbox];
            await t.post({ type: 'selection', span: { native: true, rows,
                start: { exactEdge: { page: 1, x: v.x, y: v.y, h: v.h } },
                end: { exactEdge: { page: 1, x: of.x1, y: of.y, h: of.h } }, lines: 1 }, reveal: false });
            await t.waitFor(() => document.querySelectorAll('.selbrk').length === 2, null, { what: 'two brackets' });
            const k = await t.pxPerBp();
            const b = await t.eval(() => ({
                start: parseFloat(document.querySelector('.selbrk.start').style.left),
                end: parseFloat(document.querySelector('.selbrk.end').style.left) }));
            t.near(b.start, v.x * k, 1.5, 'the opening bracket is at the first selected glyph (v of "velocity")');
            t.near(b.end, of.x1 * k, 1.5, 'the closing bracket is after the last selected glyph (f of "of")');
        },
    },
    {
        id: 'pro-switch',
        name: 'clicking the Pro badge posts proToggle; the disabled state greys it; right-click shows the panel',
        async run(t) {
            await proOn(t);
            await t.clear();
            await t.page.click('#probadge');
            await t.waitPosted('proToggle');
            t.assert(await t.eval(() => document.getElementById('propanel').hidden), 'a click toggles, it does not open the panel');
            await t.post({ type: 'engine', state: 'disabled' });
            await t.sleep(100);
            const s = await t.eval(() => { const b = document.getElementById('probadge'); const cs = getComputedStyle(b);
                return { filter: cs.filter, opacity: Number(cs.opacity), title: b.title, shown: !b.hidden,
                    marks: document.body.classList.contains('pro-live-marks'), tikz: document.getElementById('tikztool').hidden }; });
            t.assert(s.shown, 'the badge stays so it can be switched back on');
            t.assert(/grayscale\(1\)/.test(s.filter) && s.opacity < 0.7, `switched off it is grey (${s.filter}, opacity ${s.opacity})`);
            t.assert(/Click to switch it on/.test(s.title), `its tooltip says how to switch it on (${s.title})`);
            t.assert(!s.marks && s.tikz, 'Pro-only page marks and the TikZ button are gone');
            await t.clear();
            await t.page.click('#probadge');
            await t.waitPosted('proToggle');
            await t.page.click('#probadge', { button: 'right' });
            t.assert(!(await t.eval(() => document.getElementById('propanel').hidden)), 'right-click opens the details panel');
            t.assert((await t.posted('proToggle')).length === 1, 'and does not toggle');
        },
    },
    {
        id: 'edit-here',
        name: 'right-click on the page posts editHere and says "opening the editor…" until the card arrives',
        async run(t) {
            const w = t.word('particle');
            await clickWord(t, w, 0.5, { button: 'right' });
            const m = await t.waitPosted('editHere');
            t.assert(m.page === 1 && m.xBp >= w.x - 1 && m.xBp <= w.x1 + 1 && m.yTopBp >= w.y - 1 && m.yTopBp <= w.y1 + 1,
                `editHere names the clicked point (${m.xBp}, ${m.yTopBp})`);
            t.assert(await t.eval(() => document.getElementById('status').textContent) === 'opening the editor…',
                'the status says the editor is opening, at once');
            await openParagraphCard(t);
            t.assert(await t.eval(() => document.getElementById('status').textContent) === '',
                'the note goes when the card arrives');
        },
    },
    {
        id: 'tikz-open-at',
        name: 'tikzOpenAt turns the TikZ tool on',
        async run(t) {
            await proOn(t);
            const w = t.word('figlabel');
            await clickWord(t, w, 0.5, { button: 'right' });
            await t.waitPosted('editHere');
            await t.clear();
            await t.post({ type: 'tikzOpenAt', page: 1, xBp: w.x + w.w / 2, yTopBp: w.y + w.h / 2 });
            await t.waitFor(() => document.body.classList.contains('tikz-on'), null, { what: 'the TikZ tool to turn on' });
            const s = await t.eval(() => ({ pressed: document.getElementById('tikztool').getAttribute('aria-pressed'),
                panel: !document.getElementById('tikzpanel').hidden, status: document.getElementById('status').textContent }));
            t.assert(s.pressed === 'true', 'the TikZ button shows it is on');
            t.assert(s.panel, 'the TikZ panel is shown');
            t.assert(s.status === 'TikZ: opening the picture…', `the status says the picture is opening (${s.status})`);
            t.assert((await t.posted('tikzPalette')).length === 1, 'the panel asks the host for its palette');
        },
    },
];

tests.push({
    id: 'card-comments',
    name: 'the card opens its block\'s comments beside the text: the text keeps its width, the divider shares it out, a new comment posts addAt',
    async run(t) {
        await t.eval(() => { try { localStorage.removeItem('wpaper.card.comments'); } catch (_) {} });
        await openParagraphCard(t, { path: '/p/fx.tex' });
        const at = new Date().toISOString();
        await t.post({ type: 'comments', generation: 1, items: [
            { id: 'c1', cellId: 'x1', file: '/p/fx.tex', line: 8, endLine: 8, text: 'Is this sign right?', author: { name: 'Ada' }, createdAt: at },
            { id: 'c2', cellId: 'x2', file: '/p/other.tex', line: 8, endLine: 8, text: 'another file', createdAt: at },
            { id: 'c3', cellId: 'x3', file: '/p/fx.tex', line: 30, endLine: 31, text: 'another block', createdAt: at }] });
        await t.waitFor(() => /1/.test(document.querySelector('.ec-commentsbtn')?.textContent || ''), null, { what: 'the comment count on the card' });
        const before = await t.eval(() => ({ text: document.querySelector('.ec-editor').getBoundingClientRect().width,
            card: document.querySelector('.editcard').getBoundingClientRect().width }));
        await t.eval(() => document.querySelector('.ec-commentsbtn').click());
        await t.waitFor(() => !!document.querySelector('.ec-comments'), null, { what: 'the comments pane' });
        await t.sleep(60);
        const after = await t.eval(() => ({ text: document.querySelector('.ec-editor').getBoundingClientRect().width,
            card: document.querySelector('.editcard').getBoundingClientRect().width,
            pane: document.querySelector('.ec-comments').getBoundingClientRect().width,
            items: [...document.querySelectorAll('.ecc-text')].map(x => x.value) }));
        t.near(after.text, before.text, 2, 'the text keeps its width when the pane opens');
        t.near(after.card, before.card + after.pane + 6, 3, 'the card grows by the pane');
        t.assert(JSON.stringify(after.items) === JSON.stringify(['Is this sign right?']), `only this block's comments (${JSON.stringify(after.items)})`);
        // The divider shares the width out: dragging it left widens the pane, narrows the text, keeps the card.
        const d = await t.eval(() => { const r = document.querySelector('.ec-divider').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await t.page.mouse.move(d.x, d.y); await t.page.mouse.down();
        for (const k of [1, 2, 3, 4]) {
            await t.page.mouse.move(d.x - 15 * k, d.y);
        }
        await t.page.mouse.up();
        const dragged = await t.eval(() => ({ text: document.querySelector('.ec-editor').getBoundingClientRect().width,
            card: document.querySelector('.editcard').getBoundingClientRect().width,
            pane: document.querySelector('.ec-comments').getBoundingClientRect().width }));
        t.near(dragged.pane, after.pane + 60, 3, 'the pane widens by the drag');
        t.near(dragged.text, after.text - 60, 3, 'the text narrows by the drag');
        t.near(dragged.card, after.card, 3, 'the card keeps its width');
        if (process.env.WPAPER_WEBVIEW_SHOTS) await t.page.screenshot({ path: `${process.env.WPAPER_WEBVIEW_SHOTS}/card-comments.png` });
        await t.clear();
        await t.eval(() => { const ta = document.querySelector('.ecc-new textarea'); ta.focus(); ta.value = 'A new remark'; });
        await t.page.keyboard.press('Meta+Enter');
        const sent = await t.waitPosted('commentAction', m => m.action === 'addAt');
        t.assert(sent.file === '/p/fx.tex' && sent.line === 7 && sent.text === 'A new remark', `addAt for the block (${JSON.stringify(sent)})`);
        // Closing gives the text its width back.
        await t.eval(() => document.querySelector('.ec-commentsbtn').click());
        await t.waitFor(() => !document.querySelector('.ec-comments'), null, { what: 'the pane to close' });
    },
});

tests.push({
    id: 'eq-preview',
    name: 'hovering an equation reference shows the equation even without the label map (it is found by its printed number)',
    async run(t) {
        const link = await t.waitFor(() => {
            const l = [...document.querySelectorAll('.pdflink')].find(a => a._dest && /^equation/.test(typeof a._dest === 'string' ? a._dest : ''));
            if (!l) return null;
            const r = l.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, null, { what: 'the \\eqref link' });
        await t.page.mouse.move(link.x, link.y);
        const card = await t.waitFor(() => {
            const c = document.querySelector('.destination-preview');
            return c ? { img: !!c.querySelector('img'), text: c.textContent } : null;
        }, null, { what: 'the reference preview', timeout: 4000 });
        t.assert(card.img, `the preview shows the equation, not "Preview unavailable" (${card.text})`);
        if (process.env.WPAPER_WEBVIEW_SHOTS) await t.page.screenshot({ path: `${process.env.WPAPER_WEBVIEW_SHOTS}/eq-preview.png` });
    },
});

tests.push({
    id: '#40',
    name: 'a drag on the page sends its press point with every pick, so the selection starts where the button went down',
    async run(t) {
        await t.clear();
        const a = t.word('velocity'), b = t.word('prose,');
        const p0 = await t.toClient(a.page, a.x + a.w * 0.3, a.y + a.h / 2);
        const p1 = await t.toClient(b.page, b.x + b.w * 0.7, b.y + b.h / 2);
        await t.page.mouse.move(p0.x, p0.y);
        await t.page.mouse.down();
        for (let k = 1; k <= 6; k++) { await t.page.mouse.move(p0.x + (p1.x - p0.x) * k / 6, p0.y + (p1.y - p0.y) * k / 6); await t.sleep(70); }
        await t.page.mouse.up();
        await t.sleep(100);
        const picks = (await t.posted('click')).filter(m => m.pick);
        t.assert(picks.length >= 2, `the drag sent picks (${picks.length})`);
        const k = await t.pxPerBp(a.page);
        for (const m of picks) {
            t.assert(m.from && m.from.page === a.page, `every pick names the press point (${JSON.stringify(m.from)})`);
            t.near(m.from.xBp, a.x + a.w * 0.3, 1.5 / k + 0.5, 'at the press x');
        }
        t.assert(picks.at(-1).live !== true, 'the release sends the final pick');
    },
});

tests.push({
    id: '#41',
    name: 'a folded section under a heading that runs to the margin gets its chip under the heading, readable, not a sliver at the edge',
    async run(t) {
        const w = t.word('prose,');
        // A heading row that ends 20 bp before the page's right edge (595 bp wide).
        await t.post({ type: 'sections', generation: 1, pageWidth: 612, items: [{ key: 's1', kind: 'section', foldable: true,
            collapsed: true, hidden: 25, page: 1, line: 3, x: 90, y: w.y, w: 500, h: w.h, title: 'Long' }] });
        const box = await t.waitFor(() => {
            const b = document.querySelector('.wpa .secfold');
            if (!b) return null;
            const r = b.getBoundingClientRect(), p = document.querySelector('.page[data-page="1"]').getBoundingClientRect();
            return { w: r.width, top: r.top - p.top, left: r.left - p.left, text: b.textContent, scrollW: b.scrollWidth, clientW: b.clientWidth };
        }, null, { what: 'the fold chip' });
        const k = await t.pxPerBp(1);
        t.assert(box.top > (w.y + w.h) * k, `under the heading row (top ${box.top}, row bottom ${(w.y + w.h) * k})`);
        t.near(box.left, 90 * k, 6, 'at the heading row\'s left');
        t.assert(box.scrollW <= box.clientW + 1, `the whole "${box.text}" is shown, not cut (scroll ${box.scrollW} > ${box.clientW})`);
    },
});

tests.push({
    id: '#43',
    name: 'typing that adds a line to the block moves the card down so the new line shows (and back up when it goes)',
    async run(t) {
        await openParagraphCard(t);
        const rows = paraRows(t);
        const cardTop = () => t.eval(() => document.querySelector('.editcard').getBoundingClientRect().top);
        const rowBottom = async (r) => (await t.toClient(r.page, r.x, r.y + r.h)).y;
        const top0 = await cardTop();
        t.assert(top0 >= await rowBottom(rows[1]) - 1, 'the card opens under the block');
        // The live page grew the paragraph by a row.
        const extra = { ...rows[1], y: rows[1].y + (rows[1].y - rows[0].y) };
        await t.post({ type: 'editAnchor', editId: 11, rects: [...rows, extra], live: true });
        await t.sleep(80);
        const top1 = await cardTop();
        t.assert(top1 >= await rowBottom(extra) - 1, `the card moved below the new line (card ${top1}, line bottom ${await rowBottom(extra)})`);
        // …and back when the line goes.
        await t.post({ type: 'editAnchor', editId: 11, rects: rows, live: true });
        await t.sleep(80);
        t.near(await cardTop(), top0, 2, 'back under the block');
        // The textarea kept focus through both moves.
        t.assert(await t.eval(() => document.activeElement?.closest?.('.editcard') != null), 'the card keeps focus');
    },
});

module.exports = { fixtureTex, tests };
