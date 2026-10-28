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
Compare \cite{cc}.
\begin{thebibliography}{9}
\bibitem{cc} A. Author, \emph{A title}, \href{https://arxiv.org/abs/2001.07259}{2001.07259}.
\end{thebibliography}
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
        id: 'modifier-compile-pdf',
        name: 'Cmd/Ctrl-click Compile requests a PDF export with the latest mini-editor text, in both modes',
        async run(t) {
            for (const pro of [false, true]) {
                if (pro) await proOn(t);
                await openParagraphCard(t);
                await t.eval(() => { const ta = document.querySelector('.ec-editor textarea'); ta.value = 'Newest block text'; });
                for (const modifier of ['Meta', 'Control']) {
                    await t.clear();
                    if (modifier === 'Meta') await t.page.locator('#recompile').click({ modifiers: [modifier] });
                    else await t.page.locator('#recompile').dispatchEvent('click', { ctrlKey: true }); // Ctrl-click is macOS's context menu gesture.
                    const request = await t.waitPosted('recompile');
                    t.assert(request.exportPdf && request.editId === 11 && request.text === 'Newest block text',
                        'modified Compile includes the latest draft and requests a PDF');
                }
                await t.clear();
                await t.page.locator('#recompile').click();
                const normal = await t.waitPosted('recompile');
                t.assert(normal.exportPdf === false, 'ordinary Compile retains its viewer build');
                await t.post({ type: 'editClosed' });
                await t.waitFor(() => !document.querySelector('.editcard'), null, { what: 'card closure' });
            }
        },
    },
    {
        id: 'selection-copy-location',
        name: 'selection toolbar offers file:line copying in both modes and the button cannot start a page drag',
        async run(t) {
            const rows = paraRows(t);
            for (const pro of [false, true]) {
                if (pro) await proOn(t);
                await t.post({ type: 'selection', span: { native: true, rows,
                    start: { exactEdge: { page: 1, x: rows[0].x, y: rows[0].y, h: rows[0].h }, rects: [rows[0]] },
                    end: { exactEdge: { page: 1, x: rows[1].x + rows[1].w, y: rows[1].y, h: rows[1].h }, rects: [rows[1]] },
                } });
                await t.waitFor(() => !!document.querySelector('.selact button[data-action="copyLocation"]'), null,
                    { what: 'the source location button' });
                const button = t.page.locator('.selact button[data-action="copyLocation"]');
                t.assert((await button.getAttribute('title')).includes('file:line'), 'the tooltip explains what is copied');
                await t.clear();
                await button.click();
                await t.waitPosted('selectionAction', m => m.action === 'copyLocation');
                t.assert(!(await t.posted('click')).length && !(await t.posted('moveCommit')).length,
                    'copying a source location leaves the selected fragment in place');
            }
        },
    },
    {
        id: 'selection-add-comment',
        name: 'selection menu opens a quoted source-line comment in standard and Pro, and separate selections retain separate quotes',
        async run(t) {
            const rows = paraRows(t);
            for (const pro of [false, true]) {
                if (pro) await proOn(t);
                await t.post({ type: 'selection', span: { native: true, rows,
                    start: { exactEdge: { page: 1, x: rows[0].x, y: rows[0].y, h: rows[0].h }, rects: [rows[0]] },
                    end: { exactEdge: { page: 1, x: rows[1].x + rows[1].w, y: rows[1].y, h: rows[1].h }, rects: [rows[1]] },
                } });
                const button = t.page.locator('.selact button[data-action="comment"]');
                await t.waitFor(() => !!document.querySelector('.selact button[data-action="comment"]'), null,
                    { what: 'the Add comment button' });
                t.assert((await button.getAttribute('aria-label')).includes('Add comment'), 'the icon has an accessible name');
                await t.clear();
                await button.click();
                await t.waitPosted('selectionAction', m => m.action === 'comment');
                t.assert(!(await t.posted('click')).length && !(await t.posted('moveCommit')).length &&
                    !(await t.posted('selectionClear')).length, 'the button preserves the selected range');
                const quote = 'ordinary prose, long enough to wrap onto a second line';
                const selection = { quote, lineOffset: 1, endLineOffset: 1 };
                await t.post({ type: 'commentTarget', target: { id: pro ? 902 : 901, file: '/p/fx.tex',
                    kind: 'paragraph', line: 8, endLine: 8, sourcePreview: quote, excerpt: quote,
                    selection, sectionPath: ['Fixture'] } });
                await t.waitFor(() => !document.querySelector('#commentcomposer').hidden &&
                    document.querySelector('#commentexcerpt').textContent.includes('ordinary prose'), null,
                    { what: 'the selection comment composer and quote' });
                t.assert(await t.eval(() => document.querySelector('#commentexcerpt').textContent) === quote,
                    'the context quotes only the selected fragment');
                t.assert((await t.eval(() => document.querySelector('#commentlocation').textContent)).includes('fx.tex:8'),
                    'the comment visibly identifies its source file and line');
                await t.page.locator('#commentdraft').fill('Check this fragment.');
                await t.page.locator('#commentsave').click();
                await t.waitPosted('commentAction', m => m.action === 'add' && m.targetId === (pro ? 902 : 901) &&
                    m.text === 'Check this fragment.');
                const items = [
                    { id: 'other-selection', cellId: 'same-paragraph', file: '/p/fx.tex', kind: 'paragraph',
                        line: 7, endLine: 7, text: 'An older comment.', selection: { quote: 'The velocity', lineOffset: 0, endLineOffset: 0 },
                        sourcePreview: 'The velocity', excerpt: 'The velocity', rects: [rows[0]] },
                    { id: 'new-selection', cellId: 'same-paragraph', file: '/p/fx.tex', kind: 'paragraph',
                        line: 8, endLine: 8, text: 'Check this fragment.', selection,
                        sourcePreview: quote, excerpt: quote, rects: [rows[1]] },
                ];
                await t.post({ type: 'commentComposed' });
                await t.post({ type: 'comments', items, errors: [], generation: 1 });
                await t.waitFor(() => !!document.querySelector('.cp-text[data-comment="new-selection"]'), null,
                    { what: 'the saved selection comment' });
                t.assert(await t.eval(() => document.querySelector('#commentexcerpt').textContent) === quote,
                    'saving selects the newly composed fragment rather than an older comment on the paragraph');
                t.assert(await count(t, '.cp-text') === 1, 'each selection has its own quote context');
                await t.page.locator('#commentprev').click();
                await t.waitFor(() => document.querySelector('#commentexcerpt').textContent === 'The velocity', null,
                    { what: 'the other selection quote' });
                await t.page.locator('#commentnext').click();
                await t.waitFor(value => document.querySelector('#commentexcerpt').textContent === value, quote,
                    { what: 'the original selection quote' });
                await t.page.screenshot({ path: `/tmp/wpaper-selection-comment-${pro ? 'pro' : 'standard'}.png` });
                await t.page.locator('#commentclose').click();
                await t.post({ type: 'comments', items: [], errors: [], generation: 1 });
            }
        },
    },
    {
        id: 'mini-comment-shortcuts',
        name: 'mini-editor comments selected LaTeX lines with editor shortcuts in both modes and keeps one-step undo',
        async run(t) {
            for (const pro of [false, true]) {
                if (pro) await proOn(t);
                await openParagraphCard(t);
                const initial = '  First line\n    Second line\n\nLast line';
                await t.eval(value => {
                    const ta = document.querySelector('.ec-editor textarea');
                    ta.focus(); ta.value = value; ta.setSelectionRange(2, value.indexOf('Last line'));
                    ta.dispatchEvent(new Event('input'));
                }, initial);
                await t.clear();
                await t.page.keyboard.press('Meta+/');
                const commented = '  % First line\n  %   Second line\n\nLast line';
                await t.waitFor(value => document.querySelector('.ec-editor textarea').value === value,
                    commented, { what: 'the selected lines to be commented' });
                const change = await t.waitPosted('editChange');
                t.assert(change.text === commented, 'comment edits reach source through the live user-edit path');
                await t.page.keyboard.press('Meta+/');
                t.assert(await t.eval(() => document.querySelector('.ec-editor textarea').value) === initial, 'the same shortcut uncomments');
                await t.page.keyboard.press('Alt+Shift+A');
                t.assert(await t.eval(() => document.querySelector('.ec-editor textarea').value) === commented, 'block comment shortcut toggles the selected lines');
                await t.page.keyboard.press('Meta+z');
                t.assert(await t.eval(() => document.querySelector('.ec-editor textarea').value) === initial, 'one undo reverses the comment operation');
                await t.post({ type: 'editClosed' });
                await t.waitFor(() => !document.querySelector('.editcard'), null, { what: 'card closure' });
            }
        },
    },
    {
        id: 'field-paste-shortcuts',
        name: 'Ctrl/Cmd+V paste through the host into new and existing comments and source, preserve undo, and reject stale replies',
        async run(t) {
            await openParagraphCard(t, { path: '/p/fx.tex' });
            await t.post({ type: 'comments', generation: 1, items: [
                { id: 'paste-comment', file: '/p/fx.tex', text: 'Existing comment', line: 7, endLine: 9 },
            ] });
            await t.eval(() => document.querySelector('.ec-commentsbtn').click());
            await t.waitFor(() => !!document.querySelector('.ecc-new textarea'), null, { what: 'comment fields' });
            for (const selector of ['.ecc-new textarea', '.ecc-text', '.ec-editor textarea']) {
                for (const modifier of ['Control', 'Meta']) {
                    await t.eval(selector => {
                        const ta = document.querySelector(selector); ta.focus(); ta.value = 'Before SELECT after';
                        ta.setSelectionRange(7, 13);
                    }, selector);
                    await t.clear();
                    await t.page.keyboard.press(`${modifier}+v`);
                    const request = await t.waitPosted('fieldPaste');
                    await t.post({ type: 'fieldPasteResult', requestId: request.requestId, text: 'pasted\ntext' });
                    await t.waitFor(selector => document.querySelector(selector).value === 'Before pasted\ntext after',
                        selector, { what: `${modifier}+V paste in ${selector}` });
                    t.assert(!(await t.posted('pasteCommit')).length && !(await t.posted('selectionAction')).length,
                        'a field paste never arms a page paste or edits the page selection');
                    await t.page.keyboard.press('Meta+z');
                    t.assert(await t.eval(selector => document.querySelector(selector).value, selector) === 'Before SELECT after', 'pasting is one undo');
                }
            }
            await t.eval(() => { const ta = document.querySelector('.ecc-new textarea'); ta.focus(); ta.value = 'My draft'; ta.setSelectionRange(8, 8); });
            await t.clear();
            await t.page.keyboard.press('Control+v');
            const stale = await t.waitPosted('fieldPaste');
            await t.page.keyboard.type(' continued');
            await t.post({ type: 'fieldPasteResult', requestId: stale.requestId, text: 'old clipboard' });
            await t.sleep(50);
            t.assert(await t.eval(() => document.querySelector('.ecc-new textarea').value) === 'My draft continued', 'a delayed clipboard reply cannot overwrite newer typing');
            await proOn(t);
            await t.post({ type: 'commentTarget', target: {
                id: 55, file: '/p/fx.tex', line: 7, endLine: 9, kind: 'paragraph', excerpt: 'Fixture paragraph',
            } });
            await t.waitFor(() => document.activeElement === document.getElementById('commentdraft'), null,
                { what: 'the sidebar comment draft' });
            await t.clear();
            await t.page.keyboard.press('Control+v');
            const sidebar = await t.waitPosted('fieldPaste');
            await t.post({ type: 'fieldPasteResult', requestId: sidebar.requestId, text: 'Sidebar remark' });
            await t.waitFor(() => document.getElementById('commentdraft').value === 'Sidebar remark', null,
                { what: 'Ctrl+V in the sidebar comment draft in Pro mode' });
        },
    },
    {
        id: 'double-click-source-focus',
        name: 'two-panel double-click requests source focus immediately in both modes, even while mapping is paused',
        async run(t) {
            for (const pro of [false, true]) {
                if (pro) await proOn(t);
                await t.post({ type: 'fullscreen', mode: 'all' });
                await t.post({ type: 'traceState', paused: true });
                await t.sleep(40);
                await t.clear();
                await clickWord(t, t.word('velocity'), 0.5, { clickCount: 2 });
                await t.waitPosted('focusSource');
                t.assert((await t.posted('focusSource')).length === 1, 'double-click focuses source without a mapping response');
                await t.post({ type: 'traceState', paused: false });
            }
            await t.post({ type: 'fullscreen', mode: 'viewer' });
            await t.waitFor(() => {
                const page = document.querySelector('.page[data-page="1"]'), main = document.querySelector('main');
                const css = getComputedStyle(main);
                const available = main.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
                return Math.abs(page.getBoundingClientRect().width - available) < 2 &&
                    !!page.querySelector('canvas');
            }, null, { what:'the fitted viewer page to finish rendering' });
            await t.sleep(100);
            await t.clear();
            await clickWord(t, t.word('velocity'), 0.5, { clickCount: 2 });
            await t.waitPosted('click', m => m.takeMe);
            t.assert((await t.posted('focusSource')).length === 0, 'viewer-only navigation keeps its existing take-me-there path');
        },
    },
    {
        id:'shift-cells-mini',
        name:'Shift reveals semantic mini-editor cell rules without moving text or intercepting selection, in both modes',
        async run(t) {
            for (const pro of [false,true]) {
                await t.post({ type:'engine', state:pro ? 'live' : 'disabled', interactive:pro });
                const first = 'Long paragraph with wrapped lines. '.repeat(18);
                const second = '\\paragraph{Title.}\nParagraph text.\nStill the same paragraph.';
                const third = '\\begin{equation}\nx=y\n\\end{equation}';
                const text = first + '\n\n' + second + '\n\n' + third;
                const starts = [0,first.length+2,first.length+second.length+4];
                await openParagraphCard(t,{ text,cellStarts:starts });
                const ta = t.page.locator('.editcard textarea');
                await ta.focus();
                await ta.evaluate(n => n.setSelectionRange(0,0));
                const before = await t.eval(() => {
                    const n = document.querySelector('.editcard textarea');
                    return { height:n.offsetHeight, pre:document.querySelector('.ec-hl').textContent, start:n.selectionStart,end:n.selectionEnd };
                });
                await t.clear();
                await t.page.keyboard.down('Shift');
                t.assert(await count(t,'.ec-cell-boundary') === 2, 'one rule per semantic seam, none inside the title or equation');
                const after = await t.eval(() => {
                    const n = document.querySelector('.editcard textarea');
                    return { height:n.offsetHeight, pre:document.querySelector('.ec-hl').textContent, start:n.selectionStart,end:n.selectionEnd };
                });
                t.assert(JSON.stringify(before) === JSON.stringify(after), 'Shift does not alter text, selection, height or wrapping');
                t.assert((await t.posted('labelsWanted')).length === 0, 'Shift in the textarea requests no label-map refresh');
                t.assert((await t.posted('editChange')).length === 0 && (await t.posted('editExtend')).length === 0,
                    'revealing rules produces no source edits or range expansion');
                await ta.press('ArrowRight');
                t.assert(await ta.evaluate(n => n.selectionStart === 0 && n.selectionEnd === 1), 'Shift+Right still selects normally');
                await ta.evaluate(n => n.setSelectionRange(0,0));
                await t.page.keyboard.insertText('extra\n');
                t.assert(JSON.stringify(await t.eval(() => [...document.querySelectorAll('.ec-cell-boundary')].map(n => Number(n.dataset.offset)))) ===
                    JSON.stringify(starts.slice(1).map(n => n + 6)), 'rules follow edits before their cells while Shift remains held');
                await t.eval(() => { document.querySelector('.editcard').style.width = '280px'; });
                await t.sleep(100);
                t.assert(await t.eval(() => {
                    const pre = document.querySelector('.ec-hl');
                    const line = document.querySelector('.ec-cell-boundary');
                    return line.offsetWidth <= pre.clientWidth && parseFloat(line.style.top) > 200;
                }), 'rules follow long wrapped paragraphs after a width change');
                if (process.env.WPAPER_SHIFT_SCREENSHOT && pro) {
                    await t.eval(() => {
                        const box = document.querySelector('.ec-editor');
                        box.scrollTop = box.scrollHeight;
                    });
                    await t.page.locator('.editcard').screenshot({ path:process.env.WPAPER_SHIFT_SCREENSHOT });
                }
                await t.page.keyboard.up('Shift');
                t.assert(await count(t,'.ec-cell-boundary') === 0, 'rules vanish on release');
                await t.page.keyboard.down('Shift');
                await t.eval(() => window.dispatchEvent(new Event('blur')));
                t.assert(await count(t,'.ec-cell-boundary') === 0, 'focus loss clears a held Shift');
                await t.page.keyboard.up('Shift');
                await t.post({ type:'editOpen', editId:12,text:'next',startLine:1,endLine:1,rects:paraRows(t) });
            }
        },
    },
    {
        id:'shift-cells-paper',
        name:'Shift paper cell rules follow map coordinates and disappear on release, stale source and visibility loss',
        async run(t) {
            const rect = { page:1,x:72,y:140,w:400,h:0 };
            for (const pro of [false,true]) {
                await t.post({ type:'engine', state:pro ? 'live' : 'disabled',interactive:pro });
                await t.post({ type:'cellBoundaries', generation:1,items:[rect] });
                await t.page.keyboard.down('Shift');
                t.assert(await count(t,'.paper-cell-boundary') === 1, 'Shift reveals a mapped paper cell edge');
                const expected = await t.toClient(1,rect.x,rect.y);
                const actual = await t.page.locator('.paper-cell-boundary').evaluate(n => {
                    const r = n.getBoundingClientRect(); return { x:r.x,y:r.y,pointer:getComputedStyle(n).pointerEvents };
                });
                t.assert(Math.abs(actual.x-expected.x)<1 && Math.abs(actual.y-expected.y)<1 && actual.pointer === 'none',
                    'rule uses PDF coordinates without intercepting page clicks');
                await t.post({ type:'traceState', paused:true });
                await t.waitFor(() => !document.getElementById('tracelag').hidden,null,{ what:'paused correspondence' });
                t.assert(await count(t,'.paper-cell-boundary') === 0, 'obsolete geometry disappears as soon as the source moves ahead');
                await t.post({ type:'traceState', paused:false });
                await t.waitFor(() => document.getElementById('tracelag').hidden,null,{ what:'current correspondence' });
                t.assert(await count(t,'.paper-cell-boundary') === 1, 'rules return when the page catches up');
                await t.page.keyboard.up('Shift');
                t.assert(await count(t,'.paper-cell-boundary') === 0, 'release clears paper rules');
                await t.page.keyboard.down('Shift');
                await t.eval(() => {
                    Object.defineProperty(document,'hidden',{ configurable:true,value:true });
                    document.dispatchEvent(new Event('visibilitychange'));
                    delete document.hidden;
                });
                t.assert(await count(t,'.paper-cell-boundary') === 0, 'hiding the panel clears Shift rules');
                await t.page.keyboard.up('Shift');
                await t.post({ type:'cellBoundaries', generation:0,items:[{ ...rect,y:10 }] });
                await t.page.keyboard.down('Shift');
                const y = await t.page.locator('.paper-cell-boundary').evaluate(n => n.getBoundingClientRect().y);
                t.assert(Math.abs(y-expected.y)<1, 'late messages cannot place an older generation on the current page');
                await t.page.keyboard.up('Shift');
            }
        },
    },
    {
        id:'mini-extend',
        name:'Down at the end and Up at the start add adjacent blocks to the same focused mini-editor in both modes',
        async run(t) {
            for (const pro of [false,true]) {
                await t.post({ type:'engine', state:pro ? 'live' : 'disabled', interactive:pro });
                await openParagraphCard(t);
                const ta = t.page.locator('.editcard textarea');
                await ta.focus();
                await t.eval(() => { window.__extensionTextarea = document.querySelector('.editcard textarea'); });
                const text = await ta.inputValue();
                await ta.evaluate(n => n.setSelectionRange(n.value.length - 1,n.value.length - 1));
                await t.clear();
                await ta.press('ArrowDown');
                t.assert((await t.posted('editExtend')).length === 0, 'reaching the edge is an ordinary caret move');
                await ta.press('ArrowDown');
                const request = await t.waitPosted('editExtend');
                t.assert(request.delta === 1 && request.text === text, 'the next Down asks for the following block');
                await ta.evaluate(n => n.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', repeat:true, bubbles:true })));
                t.assert((await t.posted('editExtend')).length === 1, 'auto-repeat does not add more blocks');
                const suffix = '\n\n\\begin{equation}\nx=y\n\\end{equation}';
                await t.post({ type:'editExtended', editId:11, requestId:request.requestId, added:true,
                    prefix:'', suffix, text:text + suffix, caret:text.length + 2, cellStarts:[0,text.length+2], startLine:7,endLine:14,label:'blocks' });
                await t.waitFor(expected => document.querySelector('.editcard textarea').value === expected, text + suffix,
                    { what:'appended block' });
                t.assert(await t.eval(() => document.activeElement === window.__extensionTextarea && document.querySelector('.editcard textarea') === window.__extensionTextarea),
                    'expansion retains the textarea and typing focus');
                t.assert(await ta.evaluate(n => n.selectionStart === n.value.indexOf('\\begin{equation}')), 'caret moves into the added block');
                await ta.evaluate(n => n.setSelectionRange(0,0));
                await t.clear();
                await ta.press('ArrowUp');
                const up = await t.waitPosted('editExtend');
                t.assert(up.delta === -1, 'Up at the start asks for the preceding block');
                const prefix = 'Previous paragraph.\n\n';
                await t.post({ type:'editExtended', editId:11, requestId:up.requestId, added:true,
                    prefix, suffix:'', text:prefix + text + suffix, caret:'Previous paragraph.'.length,
                    cellStarts:[0,prefix.length,prefix.length+text.length+2], startLine:4,endLine:14,label:'blocks' });
                await t.waitFor(expected => document.querySelector('.editcard textarea').value === expected, prefix + text + suffix,
                    { what:'prepended block' });
                t.assert(await ta.evaluate(n => n.selectionStart === 'Previous paragraph.'.length), 'caret moves to the end of the preceding block');
                t.assert(await t.eval(() => document.querySelector('.editcard .ec-lines').textContent.includes('4–14')), 'header reflects the expanded source range');
                await t.page.keyboard.down('Shift');
                t.assert(await count(t,'.ec-cell-boundary') === 2, 'expanded editor retains the boundaries of all three cells');
                await t.page.keyboard.up('Shift');
                await t.post({ type:'editOpen', editId:12, text:PARA, label:'paragraph', file:'fx.tex', startLine:7,endLine:9,rects:paraRows(t) });
            }
        },
    },
    {
        id:'mini-extend-typing',
        name:'typing and saving during block expansion are retained and rebased into the expanded range before close',
        async run(t) {
            await openParagraphCard(t);
            const ta = t.page.locator('.editcard textarea');
            await ta.focus();
            await ta.evaluate(n => n.setSelectionRange(n.value.length,n.value.length));
            await t.clear();
            await ta.press('ArrowDown');
            const request = await t.waitPosted('editExtend');
            await ta.press('Z');
            await ta.press('Control+s');
            t.assert((await t.posted('editChange')).length === 0 && (await t.posted('editSave')).length === 0,
                'keys stay local until the host defines the expanded range');
            await ta.press('Escape');
            t.assert(await count(t,'.editcard') === 1, 'close waits for the buffered edit');
            const suffix = '\n\nNext paragraph.';
            await t.post({ type:'editExtended', editId:11, requestId:request.requestId, added:true,
                prefix:'', suffix, text:PARA + suffix, caret:PARA.length + 2,startLine:7,endLine:11,label:'blocks' });
            const change = await t.waitPosted('editChange');
            t.assert(change.text === PARA + 'Z' + suffix && change.beforeText === PARA + suffix,
                'the buffered key is applied at the old caret inside the new range');
            t.assert(change.operation.start === PARA.length && change.operation.text === 'Z', 'the key remains a precise range edit');
            const messages = await t.posted();
            t.assert(messages.findIndex(m => m.type === 'editChange') < messages.findIndex(m => m.type === 'editSave') &&
                messages.findIndex(m => m.type === 'editSave') < messages.findIndex(m => m.type === 'editClose'),
                'source update, save and close remain ordered');
            await t.waitFor(() => !document.querySelector('.editcard'),null,{ what:'close after expansion' });
        },
    },
    {
        id:'error-banner',
        name:'mapped LaTeX errors expand beside their line in both modes, survive zoom, open the source and clear on recovery',
        async run(t) {
            for (const pro of [false, true]) {
                await t.open(pro ? 3 : 2);
                await t.post({ type:'engine', state:pro ? 'live' : 'disabled', interactive:pro });
                await openParagraphCard(t);
                await t.page.locator('.editcard textarea').focus();
                const r = paraRows(t)[0];
                const item = { id:'paper:42', file:'/project/paper.tex', name:'paper.tex', line:42,
                    page:r.page, rects:[r], exact:true,
                    messages:['Argument of \\math@egroup has an extra }.\nThe equation could not be typeset.'] };
                await t.post({ type:'errorAnnotations', items:[item] });
                await t.waitFor(() => !!document.querySelector('.compile-error'), null, { what:'mapped error banner' });
                t.assert(await t.eval(() => document.activeElement === document.querySelector('.editcard textarea')),
                    'an error arriving does not steal typing focus');
                const position = await t.eval(() => {
                    const b = document.querySelector('.compile-error');
                    return { top:parseFloat(b.style.top), page:Number(b.closest('.page').dataset.page), open:b.open };
                });
                t.assert(position.page === r.page && !position.open, 'error is collapsed on its mapped page');
                const point = await t.toClient(r.page, r.x, r.y + r.h);
                const top = await t.eval(() => document.querySelector('.compile-error').getBoundingClientRect().top);
                t.near(top, point.y + 3, 2, 'banner sits directly below the source line');
                await t.page.locator('.compile-error summary').click({ timeout:5000 });
                await t.waitFor(() => document.querySelector('.compile-error').open, null, { what:'expanded error text' });
                t.assert(await t.eval(() => document.querySelector('.error-body').textContent.includes('The equation could not be typeset.')),
                    'expansion shows the full compiler text');
                if (process.env.WPAPER_ERROR_SCREENSHOT) await t.page.screenshot({ path:process.env.WPAPER_ERROR_SCREENSHOT });
                await t.eval(() => { window.__errorNode = document.querySelector('.compile-error'); });
                await t.post({ type:'errorAnnotations', items:[item] });
                t.assert(await t.eval(() => document.querySelector('.compile-error') === window.__errorNode && window.__errorNode.open),
                    'repeat updates preserve the expanded node');
                const before = (await t.posted('openSourceLine')).length;
                await t.page.locator('.error-source').click();
                const source = await t.waitPosted('openSourceLine', m => m.file === item.file && m.line === 42);
                t.assert(!!source && (await t.posted('openSourceLine')).length === before + 1, 'source navigation names the exact file and line');
                await t.page.locator('#zoomin').click();
                await t.waitFor(() => !!document.querySelector('.compile-error-ink'), null, { what:'error underline after zoom' });
                const zoomed = await t.toClient(r.page, r.x, r.y + r.h);
                t.near(await t.eval(() => document.querySelector('.compile-error').getBoundingClientRect().top), zoomed.y + 3, 2,
                    'banner follows the mapped line after zoom');
                t.assert(await t.eval(() => document.querySelector('.compile-error').open), 'zoom retains expansion');
                await t.post({ type:'errorAnnotations', items:[] });
                await t.waitFor(() => !document.querySelector('.compile-error, .compile-error-ink'), null, { what:'successful build removes errors' });
            }
        },
    },
    {
        id:'error-banner-unmapped',
        name:'unmapped LaTeX errors remain visible without invented page geometry and compiler text stays plain text',
        async run(t) {
            const text = 'Emergency stop. <img src=x onerror="window.errorInjected=true">';
            await t.post({ type:'errorAnnotations', items:[{ id:'unknown', file:'/project/paper.tex', name:'paper.tex',
                line:null, page:null, rects:[], exact:false, messages:[text] }] });
            await t.waitFor(() => !document.getElementById('compileerrorlist').hidden, null, { what:'unmapped error panel' });
            await t.page.locator('#compileerrorlist summary').click();
            t.assert(await t.eval(() => document.querySelector('.error-location').textContent === 'No mapped position available'),
                'unmapped error explains the absent position');
            t.assert(await t.eval(() => !document.querySelector('.error-body img') && !window.errorInjected),
                'compiler text cannot insert HTML');
            t.assert(await t.eval(() => document.querySelector('.error-body p').textContent, null) === text, 'all compiler text is retained');
            await t.post({ type:'blank' });
            await t.waitFor(() => !document.querySelector('.compile-error'), null, { what:'switching papers clears errors' });
        },
    },
    {
        id: 'pro-source-error',
        name: 'a temporary source error crosses Pro with its line and message, keeps editing enabled, and recovers',
        async run(t) {
            await proOn(t);
            await t.post({ type:'engine', state:'settling', interactive:true,
                previewError:'Line 42: Argument of \\math@egroup has an extra }.' });
            await t.waitFor(() => document.getElementById('probadge').dataset.fallback === 'true', null, { what:'temporary error indication' });
            const title = await t.eval(() => document.getElementById('probadge').title);
            t.assert(title.includes('Current source: Line 42: Argument of \\math@egroup'), 'hover explains the actual syntax error');
            t.assert(title.includes('retries as you edit'), 'hover describes automatic recovery');
            t.assert(await t.eval(() => !document.getElementById('tikztool').hidden), 'the error leaves Pro editing enabled');
            await t.post({ type:'engine', state:'live', interactive:true, previewError:null });
            await t.waitFor(() => document.getElementById('probadge').dataset.fallback === 'false', null, { what:'syntax recovery' });
            t.assert(await t.eval(() => !getComputedStyle(document.querySelector('#probadge b')).textDecorationLine.includes('line-through')),
                'a healthy preview clears the crossing');
        },
    },
    {
        id: 'new-tail-page',
        name: 'a live last page arriving beyond a missing page remains drawable and pages stay in numerical order',
        async run(t) {
            for (const pro of [false, true]) {
                await t.post({ type: 'engine', state: pro ? 'live' : 'off' });
                await t.open(pro ? 3 : 2);
                const page = t.fixture.pages.length + 2;
                const txdl = { fonts: [], ops: [{ op: 'rule', x: 0, y: 0, w: 60 * 65536, h: 6 * 65536 }] };
                await t.post({ type: 'txdlPage', generation: 99, page, changed: true, identity: 'new-tail', txdl });
                await t.waitFor(n => !!document.querySelector(`.page[data-page="${n}"] canvas.txdl-overlay`), page,
                    { what: 'the new last page live overlay' });
                await t.post({ type: 'txdlBuilt', generation: 99, pageCount: page });
                const order = await t.eval(() => [...document.querySelectorAll('#pages .page')].map(w => Number(w.dataset.page)));
                t.assert(order.join(',') === Array.from({ length: page }, (_, i) => i + 1).join(','),
                    `new last-page preview has all preceding pages in order: ${order}`);
            }
        },
    },
    {
        id: 'pro-fallback-reason',
        name: 'Pro is crossed on a PDF fallback and its hover explains the actual font or drawing error',
        async run(t) {
            await proOn(t);
            const rule = { fonts: [], ops: [{ op: 'rule', x: 0, y: 0, w: 60 * 65536, h: 6 * 65536 }] };
            await t.post({ type: 'txdlPage', generation: 99, page: 1, changed: true,
                txdl: { ...rule, unsupported: ['PostScript special unsupported'] } });
            await t.waitFor(() => document.getElementById('probadge').dataset.fallback === 'true', null, { what: 'crossed Pro badge' });
            t.assert(await t.eval(() => getComputedStyle(document.querySelector('#probadge b')).textDecorationLine.includes('line-through')),
                'the visible Pro label is crossed');
            await t.post({ type: 'engine', state: 'live', keyMs: 12 });
            t.assert(await t.eval(() => document.getElementById('probadge').title.includes('PostScript special unsupported')),
                'a later engine success does not hide the visible page failure');
            await t.post({ type: 'txdlPage', generation: 100, page: 1, changed: true, txdl: rule });
            await t.waitFor(() => document.getElementById('probadge').dataset.fallback === 'false', null, { what: 'Pro recovery' });

            const font = { definition_digest: 'missing-bitmap', kind: 'tfm', name: 'bbm10', size_sp: 655360 };
            await t.post({ type: 'txdlPage', generation: 101, page: 1, changed: true,
                txdl: { fonts: [font], ops: [{ op: 'glyphs', font: font.definition_digest, glyphs: [[49, 0, 0]] }] } });
            const request = await t.waitPosted('txdlOutlines', m => m.font === font.definition_digest);
            await t.post({ type: 'txdlOutlines', id: request.id, error: 'font file unresolved' });
            await t.waitFor(() => document.getElementById('probadge').dataset.fallback === 'true', null, { what: 'font failure badge' });
            const title = await t.eval(() => document.getElementById('probadge').title);
            t.assert(/Page 1: Font bbm10: font file unresolved/.test(title), `hover names the page, font and error: ${title}`);
            t.assert(title.includes('updates when you pause typing'), 'hover explains how the PDF catches up');
            await t.open(2);
            t.assert(await t.eval(() => document.getElementById('probadge').dataset.fallback === 'true'), 'the final PDF does not claim that live font rendering recovered');
            await t.post({ type: 'txdlPage', generation: 102, page: 1, changed: true, txdl: rule });
            await t.waitFor(() => document.getElementById('probadge').dataset.fallback === 'false', null, { what: 'live page recovery' });
        },
    },
    {
        id: 'agent-page-order',
        name: 'a settled agent edit inserts a missing page before an existing later page',
        async run(t) {
            const { buildFixture } = require('./harness.cjs');
            const grown = buildFixture(fixtureTex.replace('\\end{document}', '\\newpage Middle page.\\newpage Last page.\n\\end{document}'));
            // An earlier preview can leave the later page while the middle
            // page falls back to PDF. The full PDF fills the gap in place.
            await t.eval(n => {
                const previous = document.querySelector('#pages .page:last-child');
                const later = previous.cloneNode(false);
                later.dataset.page = String(n);
                later.dataset.liveExtra = 'true';
                previous.after(later);
            }, grown.pages.length);
            await t.open(2, { pdfBase64: grown.base64, pages: grown.pages.length });
            const order = await t.eval(() => [...document.querySelectorAll('#pages .page')].map(w => Number(w.dataset.page)));
            t.assert(order.join(',') === grown.pages.map((_, i) => i + 1).join(','),
                `settled PDF fills gaps in order: ${order}`);
            await t.post({ type: 'viewerProbe', requestId: 'ordered', generation: 2, page: grown.pages.length });
            t.assert((await t.waitPosted('viewerProbeResult', m => m.requestId === 'ordered')).ok, 'the final page remains usable');
        },
    },
    {
        id: 'mini-pdf-refresh',
        name: 'PDF updates preserve the focused mini-editor, selection, draft and continued typing',
        async run(t) {
            let generation = 1;
            for (const pro of [false, true]) {
                if (pro) await proOn(t);
                else await t.post({ type: 'engine', state: 'disabled' });
                await t.post({ type: 'editClosed' });
                await openParagraphCard(t);
                const ta = t.page.locator('.editcard .ec-editor textarea');
                await ta.focus();
                await ta.press('End');
                await ta.press('A');
                const draft = await ta.inputValue();
                await t.eval(() => {
                    const ta = document.querySelector('.editcard .ec-editor textarea');
                    ta.setSelectionRange(2, 6, 'backward');
                    window.__typingTextarea = ta;
                });
                for (let i = 0; i < 3; i++) {
                    await t.open(++generation);
                    const actual = await t.eval(() => {
                        const ta = document.querySelector('.editcard .ec-editor textarea');
                        return { same: ta === window.__typingTextarea, focused: document.activeElement === ta,
                            text: ta.value, start: ta.selectionStart, end: ta.selectionEnd, direction: ta.selectionDirection };
                    });
                    t.assert(actual.same && actual.focused && actual.text === draft,
                        'the same focused textarea keeps its draft across PDF replacement');
                    t.assert(actual.start === 2 && actual.end === 6 && actual.direction === 'backward',
                        'the selection and its direction survive');
                }
                await t.clear();
                await ta.press('{');
                const edit = await t.waitPosted('editChange');
                t.assert(edit.text === draft.slice(0, 2) + '{' + draft.slice(6),
                    'the next keystroke immediately replaces the preserved selection');
            }
        },
    },
    {
        id: 'mini-braces',
        name: 'typing environment braces keeps visible text and caret aligned in both modes',
        async run(t) {
            for (const pro of [false, true]) {
                if (pro) await proOn(t);
                else await t.post({ type: 'engine', state: 'disabled' });
                for (const prefix of ['', 'We can always fix the phase.\n\n']) {
                    for (const command of ['\\begin', '\\end']) {
                        const suffix = '\n\\boxed{\\Theta\\Psi_n=\\Psi_n}';
                        let before = prefix + command;
                        await t.post({ type: 'editClosed' });
                        await openParagraphCard(t, { text: before + suffix, caretStart: before.length });
                        await t.clear();
                        const ta = t.page.locator('.editcard .ec-editor textarea');
                        await ta.focus();
                        for (const key of ['{', ...'equation', '}', 'Backspace', '}']) {
                            await ta.press(key);
                            before = key === 'Backspace' ? before.slice(0, -1) : before + key;
                            const actual = await t.eval(() => {
                                const ta = document.querySelector('.editcard .ec-editor textarea');
                                return { text: ta.value, visible: document.querySelector('.editcard .ec-hl').textContent,
                                    caret: ta.selectionStart, focused: document.activeElement === ta,
                                    sent: window.__posted.filter(m => m.type === 'editChange').at(-1) };
                            });
                            const expected = before + suffix;
                            t.assert(actual.text === expected && actual.sent?.text === expected,
                                `${pro ? 'Pro' : 'standard'} ${command}: ${key} changes only the typed character`);
                            t.assert(actual.visible === expected,
                                `${pro ? 'Pro' : 'standard'} ${command}: ${key} adds no visible newline or duplicate character`);
                            t.assert(actual.focused && actual.caret === before.length,
                                'the caret stays immediately after the typed character');
                        }
                    }
                }
            }
        },
    },
    {
        id: 'pro-switch-card',
        name: 'switching Pro updates the existing card controls and shortcuts without replacing its draft',
        async run(t) {
            await proOn(t);
            await openParagraphCard(t, { text: '$x+y$' });
            await t.eval(() => {
                const ta = document.querySelector('.editcard textarea');
                ta.focus(); ta.setSelectionRange(2, 2);
                window.__auditTextarea = ta;
            });
            t.assert(await count(t, '.editcard .ec-mathwrap') === 1, 'Pro card has its math bar');
            await t.post({ type: 'engine', state: 'disabled' });
            t.assert(await count(t, '.editcard .ec-mathwrap') === 0, 'the open card loses Pro controls immediately');
            const plain = await t.eval(() => {
                const ta = document.querySelector('.editcard textarea');
                const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
                // Observe the capture handler without invoking the ordinary Esc-close handler.
                ta.addEventListener('keydown', e => e.stopImmediatePropagation(), { once: true, capture: true });
                ta.dispatchEvent(key);
                return { intercepted: key.defaultPrevented, same: ta === window.__auditTextarea,
                    text: ta.value, caret: ta.selectionStart, focused: document.activeElement === ta };
            });
            t.assert(!plain.intercepted, 'the Pro math alias handler no longer intercepts Esc');
            t.assert(plain.same && plain.text === '$x+y$' && plain.caret === 2 && plain.focused,
                'the draft, textarea, focus and selection are preserved');
            await proOn(t);
            t.assert(await count(t, '.editcard .ec-mathwrap') === 1, 'switch-on restores controls on this same card');
            t.assert(await t.eval(() => document.querySelector('.editcard textarea') === window.__auditTextarea),
                'switching on also keeps the textarea');
        },
    },
    {
        id: 'mini-live',
        name: 'rapid title typing and deletion post immediately and keep the same focused card',
        async run(t) {
            for (const native of [false, true]) {
                await openParagraphCard(t, { native });
                await t.clear();
                const result = await t.eval(() => {
                    const ta = document.querySelector('.editcard textarea');
                    ta.focus();
                    const values = [];
                    for (const key of ['A', 'B', 'Backspace', 'C']) {
                        const end = ta.value.length;
                        ta.setSelectionRange(end, end);
                        const inputType = key === 'Backspace' ? 'deleteContentBackward' : 'insertText';
                        ta.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true }));
                        ta.value = key === 'Backspace' ? ta.value.slice(0, -1) : ta.value + key;
                        ta.setSelectionRange(ta.value.length, ta.value.length);
                        ta.dispatchEvent(new InputEvent('input', { inputType, bubbles: true }));
                        values.push(ta.value);
                    }
                    const edits = window.__posted.filter(m => m.type === 'editChange');
                    return { values, edits, focused: document.activeElement === ta,
                        caret: ta.selectionStart, text: ta.value };
                });
                t.assert(result.edits.length === 4, 'all four inputs arrive within the same browser turn');
                t.assert(result.edits.every((m, i) => m.text === result.values[i] && m.caret.start === m.text.length),
                    'every caret describes its own new text');
                t.assert(result.focused && result.caret === result.text.length, 'typing leaves focus and caret in place');
                await t.post({ type: 'editAnchor', editId: 11, rects: paraRows(t) });
                const after = await t.eval(() => {
                    const ta = document.querySelector('.editcard textarea');
                    return { focused: document.activeElement === ta, text: ta.value, caret: ta.selectionStart };
                });
                t.assert(after.focused && after.text === result.text && after.caret === result.caret,
                    'a page update keeps the live draft and its caret');
            }
        },
    },
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
        id: 'fragment-paint',
        name: 'a paragraph fragment is painted over the page shown: the old line cleared, the fragment drawn, the column below moved',
        async run(t) {
            // The fixture line that holds "velocity" plays the typed paragraph;
            // the fragment is one black rule where the line's right half was.
            const w = t.word('velocity');
            const sp = bp => Math.round((bp * 72.27 / 72 - 72.27) * 65536);
            const top = w.y - 2, bottom = w.y1 + 2;
            const shift = 14;                                   // bp: the paragraph "grew" by a line
            const placement = { page: w.page, identity: null, dx: sp(w.x + 120) - 0, dy: sp(bottom - 3), lines: 2, old_lines: 1,
                clip: [sp(0), sp(0), sp(600), sp(780)], clear: [sp(0), sp(top), sp(600), sp(bottom)],
                below: [sp(0), sp(bottom), sp(600), sp(780)], shift: Math.round(shift * 72.27 / 72 * 65536) };
            // A rule 60 bp wide and 6 bp tall, its bottom edge at the fragment's origin line.
            const txdl = { fonts: [], ops: [{ op: 'rule', x: 0, y: 0, w: Math.round(60 * 72.27 / 72 * 65536), h: Math.round(6 * 72.27 / 72 * 65536) }] };
            const k = await t.pxPerBp(w.page);
            const at = async (xBp, yBp, wBp, hBp) => { const c = await t.toClient(w.page, xBp, yBp); return { x: c.x, y: c.y, width: wBp * k, height: hBp * k }; };
            const dark = px => { let n = 0; for (let i = 0; i < px.data.length; i += 4) if (0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2] < 90) n++; return n; };
            const wordBox = await at(w.x, w.y, w.w, w.y1 - w.y);
            const belowBox = await at(40, bottom + 1, 500, 12);
            const belowBefore = dark(await t.pixels(belowBox));
            t.assert(dark(await t.pixels(wordBox)) > 20, 'the word is inked before the fragment');
            await t.post({ type: 'txdlFragment', generation: 99, page: w.page, index: 0, placement, txdl, fonts: null });
            await t.waitFor(() => !!document.querySelector('canvas.txdl-fragment'), null, { what: 'the fragment canvas' });
            await t.sleep(100);
            t.assert(dark(await t.pixels(wordBox)) === 0, 'the old line is cleared');
            const rule = await at(w.x + 120 + 5, bottom - 3 - 5, 50, 4);
            t.assert(dark(await t.pixels(rule)) > 0.8 * rule.width * rule.height, 'the fragment is drawn where it was placed');
            // What was below the line is now one line (14 bp) lower.
            const moved = dark(await t.pixels(await at(40, bottom + 1 + shift, 500, 12)));
            t.assert(Math.abs(moved - belowBefore) <= Math.max(10, 0.1 * belowBefore), `the band below moved down (${belowBefore} dark px before, ${moved} after moving)`);
            // The settled PDF replaces it (as the page itself would).
            await t.open(100);
            const gone = await t.eval(() => !document.querySelector('canvas.txdl-fragment'));
            t.assert(gone, 'the fragment is gone once the PDF replaces it');
            t.assert(dark(await t.pixels(wordBox)) > 20, 'and the page shows its own ink again');
        },
    },
    {
        id: 'adopt-in-place',
        name: 'a rebuild of the same paper that is not live (a save, a Compile) is swapped in under the page: the page never blanks',
        async run(t) {
            await t.eval(() => {
                const w = window;
                w.__wrap = document.querySelector('#pages .page[data-page="1"]');
                w.__blankFrames = 0;
                w.__sampling = true;
                const tick = () => {
                    if (!w.__sampling) return;
                    const c = document.querySelector('#pages .page[data-page="1"] canvas:not(.txdl-overlay)');
                    if (!c || !(c.width > 1)) w.__blankFrames++;
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            });
            await t.open(2);
            const r = await t.eval(() => {
                window.__sampling = false;
                return { blank: window.__blankFrames, same: window.__wrap === document.querySelector('#pages .page[data-page="1"]') };
            });
            t.assert(r.blank === 0, `no frame showed page 1 without a picture (${r.blank} did)`);
            t.assert(r.same, 'the page box was kept, not rebuilt from placeholders');
        },
    },
    {
        id: 'concurrent-first-open',
        name: 'overlapping first opens share one PDF worker initialization and admit the newest PDF',
        async run(t) {
            await t.page.route('**/pdf.min.mjs', async route => {
                await new Promise(resolve => setTimeout(resolve, 150));
                await route.continue();
            });
            await t.page.reload();
            await t.waitFor(() => window.__all?.some(m => m.type === 'ready'), null, { what: 'fresh webview ready' });
            for (const generation of [101, 102, 103]) await t.post({ type: 'open',
                base: `${t.origin}/pdfjs`, pdfBase64: t.fixture.base64, generation, pages: t.fixture.pages.length });
            await t.waitFor(() => window.__all.some(m => m.type === 'opened' && m.generation === 103),
                null, { what: 'newest PDF opened' });
            const timing = await t.waitPosted('timing', m => !!m.worker);
            t.assert(timing.marks.filter(m => m[0] === 'pdfjs imported').length === 1,
                'the first-open requests share PDF.js and worker initialization');
            t.assert((await t.posted('opened')).every(m => m.generation === 103), 'older opens cannot replace the newest PDF');
        },
    },
    {
        id: 'open-without-visible-pages',
        name: 'a PDF open paints a page before acknowledging even when no page intersects the viewport',
        async run(t) {
            await t.eval(() => {
                window.__previousCanvas = document.querySelector('.page canvas:not(.txdl-overlay)');
                window.IntersectionObserver = class { observe() {} disconnect() {} };
                for (const page of document.querySelectorAll('.page')) window.__wbTexViewerTest.dropRenderedForTest(page.dataset.page);
                Object.defineProperty(document.querySelector('main'), 'scrollTop', { configurable: true, get: () => 100000 });
            });
            await t.open(2);
            t.assert(await t.eval(() => document.querySelector('.page canvas:not(.txdl-overlay)') !== window.__previousCanvas),
                'the acknowledgement follows painting the new PDF, even without visible-page geometry');
        },
    },
    {
        id: 'overlapping-pdf-handoffs',
        name: 'replacing an in-flight PDF does not destroy the worker needed by the next PDF',
        async run(t) {
            for (const generation of [2, 3, 4]) await t.post({ type: 'open', base: `${t.origin}/pdfjs`,
                pdfBase64: t.fixture.base64, generation, pages: t.fixture.pages.length });
            await t.waitFor(() => window.__all.some(m => m.type === 'opened' && m.generation === 4),
                null, { what: 'newest replacement PDF' });
            await t.open(5);
            await t.post({ type: 'viewerProbe', requestId: 'handoff', generation: 5, page: 1 });
            const result = await t.waitPosted('viewerProbeResult', m => m.requestId === 'handoff');
            t.assert(result.ok, `the shared PDF worker still answers after replacement: ${result.reason || ''}`);
        },
    },
    {
        id: 'fragment-during-open',
        name: 'a paragraph fragment that arrives while a PDF opens is drawn once it has opened, not dropped',
        async run(t) {
            const w = t.word('velocity');
            const sp = bp => Math.round((bp * 72.27 / 72 - 72.27) * 65536);
            const top = w.y - 2, bottom = w.y1 + 2;
            const placement = { page: w.page, identity: null, dx: sp(w.x + 120), dy: sp(bottom - 3), lines: 1, old_lines: 1,
                clip: [sp(0), sp(0), sp(600), sp(780)], clear: [sp(0), sp(top), sp(600), sp(bottom)],
                below: [sp(0), sp(bottom), sp(600), sp(780)], shift: 0 };
            const txdl = { fonts: [], ops: [{ op: 'rule', x: 0, y: 0, w: Math.round(60 * 72.27 / 72 * 65536), h: Math.round(6 * 72.27 / 72 * 65536) }] };
            await t.post({ type: 'open', base: `${t.origin}/pdfjs`, pdfBase64: t.fixture.base64, generation: 3, pages: t.fixture.pages.length });
            await t.post({ type: 'txdlFragment', generation: 99, page: w.page, index: 0, placement, txdl, fonts: null });
            await t.waitFor(() => window.__all.some(m => m.type === 'opened' && m.generation === 3), null, { what: 'the PDF to open' });
            await t.waitFor(() => !!document.querySelector('canvas.txdl-fragment'), null, { what: 'the fragment, drawn after the open' });
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
        id: 'native-bands',
        name: 'a native selection is one band per printed line, the line\'s full height, touching the next line: not each glyph\'s own ink',
        async run(t) {
            // Glyph boxes of two printed lines, of different heights as the
            // host sends them (a capital, an x-height letter, a dot above).
            const words = t.fixture.pages[0].words;
            const v = t.word('velocity');
            const first = words.filter(w => Math.abs(w.y - v.y) < 1 && w.x >= v.x);
            const nextY = Math.min(...words.filter(w => w.y > v.y + v.h * 0.8).map(w => w.y));
            const second = words.filter(w => Math.abs(w.y - nextY) < 1).slice(0, 4);
            t.assert(first.length >= 2 && second.length >= 2, 'two printed lines of words in the fixture');
            const rows = [];
            for (const [i, w] of [...first, ...second].entries()) {
                const h = w.y1 - w.y;
                if (i % 3 === 0) rows.push({ page: 1, x: w.x, y: w.y, w: w.x1 - w.x, h });
                else if (i % 3 === 1) rows.push({ page: 1, x: w.x, y: w.y + h * 0.35, w: w.x1 - w.x, h: h * 0.55 });
                else rows.push({ page: 1, x: w.x, y: w.y + h * 0.1, w: (w.x1 - w.x) / 2, h: h * 0.7 },
                    { page: 1, x: w.x + 1, y: w.y - 1, w: 2, h: 1.5 });
            }
            const last = second[second.length - 1];
            await t.post({ type: 'selection', span: { native: true, rows,
                start: { exactEdge: { page: 1, x: v.x, y: v.y + 2, h: 4 } },
                end: { exactEdge: { page: 1, x: last.x1, y: last.y + 2, h: 4 } }, lines: 2 }, reveal: false });
            await t.waitFor(() => document.querySelectorAll('.selbrk').length === 2, null, { what: 'the selection' });
            const r = await t.eval(() => ({
                fills: [...document.querySelectorAll('.selfill')].map(e => ({ y: parseFloat(e.style.top), h: parseFloat(e.style.height) }))
                    .sort((a, b) => a.y - b.y),
                brk: [...document.querySelectorAll('.selbrk')].map(e => ({ y: parseFloat(e.style.top), h: parseFloat(e.style.height) })),
            }));
            t.assert(r.fills.length === 2, `one band per printed line (${r.fills.length} bands)`);
            t.near(r.fills[0].y + r.fills[0].h, r.fills[1].y, 0.5, 'the first band reaches down to the second: no gap');
            const k = await t.pxPerBp();
            t.assert(r.fills[1].h >= (last.y1 - last.y) * k - 1, `the second band is the line's full height (${r.fills[1].h.toFixed(1)} px)`);
            for (const b of r.brk) t.assert(r.fills.some(f => Math.abs(f.y - b.y) < 0.5 && Math.abs(f.h - b.h) < 0.5),
                'each bracket is as tall as its line\'s band');
        },
    },
    {
        id: 'native-bands-fast',
        name: 'a native selection of a few hundred glyphs is drawn within a frame (a drag repaints it at every step)',
        async run(t) {
            const words = t.fixture.pages[0].words;
            const rows = [];
            for (const w of words) {
                const n = Math.max(1, w.text.length), cw = (w.x1 - w.x) / n;
                for (let i = 0; i < n; i++) rows.push({ page: 1, x: w.x + i * cw, y: w.y, w: cw, h: w.y1 - w.y });
            }
            const a = words[0], b = words[words.length - 1];
            const ms = await t.eval(async ([rows, a, b]) => {
                const times = [];
                for (let k = 0; k < 8; k++) {
                    const cut = rows.slice(0, Math.floor(rows.length * (k + 3) / 10));
                    const last = cut[cut.length - 1];
                    const before = document.querySelector('.selbrk.end')?.dataset.selPaint || '';
                    const t0 = performance.now();
                    window.postMessage({ type: 'selection', reveal: false, span: { native: true, rows: cut,
                        start: { exactEdge: { page: 1, x: a.x, y: a.y, h: a.y1 - a.y } },
                        end: { exactEdge: { page: 1, x: last.x + last.w, y: last.y, h: last.h } }, lines: 3 } }, '*');
                    await new Promise(resolve => {
                        const check = () => {
                            const end = document.querySelector('.selbrk.end');
                            const ends = document.querySelectorAll('.selbrk.end');
                            if (ends.length === 1 && end.dataset.selPaint !== before) resolve();
                            else setTimeout(check, 0);
                        };
                        check();
                    });
                    times.push(performance.now() - t0);
                    await new Promise(r => requestAnimationFrame(() => r()));
                }
                return times;
            }, [rows, a, b]);
            ms.sort((x, y) => x - y);
            const median = ms[Math.floor(ms.length / 2)];
            console.log(`      ${rows.length} glyphs: median ${median.toFixed(1)} ms, max ${ms[ms.length - 1].toFixed(1)} ms`);
            t.assert(median < 16, `drawn within a frame (median ${median.toFixed(1)} ms)`);
        },
    },
    {
        id: 'overleaf-button',
        name: 'the toolbar has the Overleaf control; a click asks the extension for it',
        async run(t) {
            await t.clear();
            await t.page.click('#overleaf');
            await t.waitPosted('overleafMenu');
            // Connected: green, and the tooltip names the project and the file there.
            const grey = await t.eval(() => getComputedStyle(document.getElementById('overleaf')).color);
            await t.post({ type: 'overleafState', connected: true, title: 'Connected to Overleaf in real time: “Fishnets” — main.tex' });
            await t.sleep(50);
            const on = await t.eval(() => { const b = document.getElementById('overleaf'); return { color: getComputedStyle(b).color, title: b.title, cls: b.className }; });
            t.assert(/connected/.test(on.cls) && on.color !== grey, `the leaf turns green (${grey} → ${on.color})`);
            t.assert(on.title === 'Connected to Overleaf in real time: “Fishnets” — main.tex', on.title);
            await t.post({ type: 'overleafState', connected: false, title: 'Overleaf — how this paper stays in step with it' });
            await t.sleep(50);
            t.assert(await t.eval(() => !document.getElementById('overleaf').classList.contains('connected')), 'and back when not');
        },
    },
    {
        id: 'toolbar-fits',
        name: 'the toolbar never squeezes its controls into each other: it drops words first, measured, at any width',
        async run(t) {
            await proOn(t);
            const size = t.page.viewportSize();
            const report = [];
            try {
                for (const w of [1300, 1000, 900, 800, 700, 600, 520, 380]) {
                    await t.page.setViewportSize({ width: w, height: size.height });
                    await t.sleep(120);
                    const r = await t.eval(() => {
                        const head = document.querySelector('header');
                        const shown = [...head.children].filter(c => c.id !== 'hdrgap' && c.getClientRects().length && getComputedStyle(c).display !== 'none');
                        const boxes = shown.map(c => ({ id: c.id || c.className, r: c.getBoundingClientRect(), squeezed: c.scrollWidth > c.clientWidth + 1 }));
                        const overlaps = [];
                        for (let i = 1; i < boxes.length; i++) if (Math.abs(boxes[i].r.top - boxes[i - 1].r.top) < 4 && boxes[i].r.left < boxes[i - 1].r.right - 1) overlaps.push(`${boxes[i - 1].id}/${boxes[i].id}`);
                        return { cls: head.className, overlaps, squeezed: boxes.filter(b => b.squeezed).map(b => b.id),
                            cut: head.scrollWidth > head.clientWidth + 1 };
                    });
                    report.push(`${w}: ${r.cls || 'wide'}`);
                    t.assert(!r.overlaps.length && !r.squeezed.length && !r.cut,
                        `at ${w}px (${r.cls || 'wide'}): overlapping ${r.overlaps.join(', ') || '-'}; squeezed ${r.squeezed.join(', ') || '-'}; cut ${r.cut}`);
                }
            } finally { await t.page.setViewportSize(size); await t.sleep(80); }
            t.assert(/wide/.test(report[0]) && /wrap/.test(report.at(-1)), report.join(' · '));
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
                    tikz: document.getElementById('tikztool').hidden }; });
            t.assert(s.shown, 'the badge stays so it can be switched back on');
            t.assert(/grayscale\(1\)/.test(s.filter) && s.opacity < 0.7, `switched off it is grey (${s.filter}, opacity ${s.opacity})`);
            t.assert(/Click to switch it on/.test(s.title), `its tooltip says how to switch it on (${s.title})`);
            t.assert(s.tikz, 'the Pro-only TikZ button is gone');
            await t.clear();
            await t.page.click('#probadge');
            await t.waitPosted('proToggle');
            await t.page.click('#probadge', { button: 'right' });
            t.assert(!(await t.eval(() => document.getElementById('propanel').hidden)), 'right-click opens the details panel');
            t.assert((await t.posted('proToggle')).length === 1, 'and does not toggle');
        },
    },
    {
        id: 'edit-selected-fragment',
        name: 'right-click cancels a viewer selection and opens the clicked point for insertion',
        async run(t) {
            const velocity = t.word('velocity'), particle = t.word('particle');
            const row = { page:1, x:velocity.x, y:velocity.y, w:particle.x1 - velocity.x, h:velocity.h };
            const span = { native:true, rows:[row],
                start:{ exactEdge:{ page:1, x:velocity.x, y:velocity.y, h:velocity.h } },
                end:{ exactEdge:{ page:1, x:particle.x1, y:particle.y, h:particle.h } }, lines:1 };
            await t.post({ type:'selection', span, reveal:false });
            await t.waitFor(() => document.querySelectorAll('.selbrk').length === 2, null, { what:'viewer selection' });
            await t.clear();
            await clickWord(t, t.word('ordinary'), 0.5, { button:'right' });
            const message = await t.waitPosted('editHere');
            t.assert(message.preserveSelection === false && message.word === 'ordinary',
                'the right-click resolves the word under the pointer');
            const clears = await t.posted('selectionClear');
            t.assert(clears.length === 1, 'right-click clears the host selection once');
            t.assert(await t.eval(() => document.querySelectorAll('.selbrk,.selfill,.selact').length) === 0,
                'old selection marks disappear before the editor arrives');
            const caret = PARA.indexOf('ordinary') + 4;
            await openParagraphCard(t, { caretStart:caret, caretEnd:caret });
            const selected = await t.eval(() => {
                const ta = document.querySelector('.editcard .ec-editor textarea');
                return { start:ta.selectionStart, end:ta.selectionEnd, focused:document.activeElement === ta };
            });
            t.assert(selected.focused && selected.start === caret && selected.end === caret,
                'the clicked caret arrives focused without inheriting the old selected fragment');
            await t.page.keyboard.type('X');
            const expected = PARA.slice(0,caret) + 'X' + PARA.slice(caret);
            const edited = await t.waitPosted('editChange', m => m.text === expected);
            t.assert(edited.text === expected, 'typing inserts at the new point and preserves the former selection text');
        },
    },
    {
        id: 'edit-here',
        name: 'right-click on the page posts editHere and says "opening the editor…" until the card arrives',
        async run(t) {
            const w = t.word('particle');
            await clickWord(t, w, 0.5, { button: 'right' });
            const m = await t.waitPosted('editHere');
            t.assert(m.preserveSelection === false, 'with no viewer selection the pointer still supplies the caret');
            t.assert(m.page === 1 && m.xBp >= w.x - 1 && m.xBp <= w.x1 + 1 && m.yTopBp >= w.y - 1 && m.yTopBp <= w.y1 + 1,
                `editHere names the clicked point (${m.xBp}, ${m.yTopBp})`);
            t.assert(await t.eval(() => document.getElementById('status').textContent) === 'opening the editor…',
                'the status says the editor is opening, at once');
            await openParagraphCard(t);
            // Standard inverse search answers after the card has opened.
            // Its explicit caret must override the initial textarea position.
            const start = PARA.indexOf('particle');
            const caret = start + 4;
            await t.post({ type:'editSelect', editId:11, start, end:start + 8, caret, focus:true });
            await t.waitFor(at => {
                const ta = document.querySelector('.editcard .ec-editor textarea');
                return ta && document.activeElement === ta && ta.selectionStart === at && ta.selectionEnd === at;
            }, caret, { what:'the right-click caret inside the word' });
            await t.page.keyboard.type('X');
            t.assert(await t.eval(() => document.querySelector('.editcard .ec-editor textarea').value) ===
                PARA.slice(0, caret) + 'X' + PARA.slice(caret), 'typing inserts at the click without replacing the word');
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

tests.push({
    id: 'pdf-figure-worker',
    name: 'drawing a PDF figure preserves the main PDF worker and later mini-editor openings',
    async run(t) {
        await proOn(t);
        const txdl = { fonts: [], ops: [{ op: 'image', file: 'figure.pdf', page: 1,
            x: 72 * 65536, y: 200 * 65536, w: 100 * 65536, h: 100 * 65536 }] };
        await t.clear();
        await t.post({ type: 'txdlPage', generation: 90, page: 1, changed: true,
            identity: 'pdf-figure-page', txdl });
        const image = await t.waitPosted('txdlImage');
        await t.post({ type: 'txdlImage', id: image.id, kind: 'pdf', base64: t.fixture.base64 });
        await t.waitFor(() => !!document.querySelector('canvas.txdl-overlay'), null,
            { what: 'the PDF figure to finish drawing' });
        await t.sleep(150);
        await t.open(2);
        await t.open(3);
        t.assert((await t.posted('viewerError')).length === 0, 'figure cleanup cannot destroy the shared PDF worker');
        await openParagraphCard(t);
        t.assert(await count(t, '.editcard textarea') === 1, 'the mini-editor appears after subsequent PDF updates');
    },
});

tests.push({
    id: 'pdf-worker-error-notify',
    name: 'an asynchronous PDF worker failure notifies the host and later opening recovers',
    async run(t) {
        await t.clear();
        await t.eval(async () => {
            const pdfjs = await import('/pdfjs/pdf.min.mjs');
            pdfjs.GlobalWorkerOptions.workerPort.dispatchEvent(new ErrorEvent('error',
                { message:'PDF worker stopped during idle' }));
        });
        const failure = await t.waitPosted('viewerError');
        t.assert(failure.workerDead && failure.generation === 1,
            'the host receives an actionable failure bound to the displayed PDF');
        await t.open(2);
        await t.post({ type:'viewerProbe', requestId:'after-worker-event', generation:2, page:1 });
        const probe = await t.waitPosted('viewerProbeResult', m => m.requestId === 'after-worker-event');
        t.assert(probe.ok, 'the next open replaces the failed worker');
        await openParagraphCard(t);
        t.assert(await count(t, '.editcard textarea') === 1, 'editing resumes on the recovered PDF');
    },
});

tests.push({
    id: 'pdf-worker-graceful-restart',
    name: 'restarting a destroyed PDF worker retains the draft, focus, selection and page position',
    async run(t) {
        await proOn(t);
        await openParagraphCard(t);
        const ta = t.page.locator('.editcard .ec-editor textarea');
        await ta.focus(); await ta.press('End'); await ta.press('A');
        const draft = await ta.inputValue();
        const before = await t.eval(async base64 => {
            const ta = document.querySelector('.editcard .ec-editor textarea');
            ta.setSelectionRange(2, 6, 'backward');
            window.__beforeRestartTextarea = ta;
            const pdfjs = await import('/pdfjs/pdf.min.mjs');
            window.__beforeRestartWorker = pdfjs.GlobalWorkerOptions.workerPort;
            const doc = await pdfjs.getDocument({ data:Uint8Array.from(atob(base64), c => c.charCodeAt(0)) }).promise;
            await doc.destroy();
            return { top:document.querySelector('main').scrollTop };
        }, t.fixture.base64);
        await t.clear();
        await t.post({ type:'restartPdfWorker' });
        await t.open(2);
        const after = await t.eval(async () => {
            const ta = document.querySelector('.editcard .ec-editor textarea');
            const pdfjs = await import('/pdfjs/pdf.min.mjs');
            return { same:ta === window.__beforeRestartTextarea, focused:document.activeElement === ta,
                text:ta.value, start:ta.selectionStart, end:ta.selectionEnd, direction:ta.selectionDirection,
                top:document.querySelector('main').scrollTop,
                newWorker:pdfjs.GlobalWorkerOptions.workerPort !== window.__beforeRestartWorker };
        });
        t.assert(after.newWorker, 'the PDF uses a newly created worker');
        t.assert(after.same && after.focused && after.text === draft, 'the same focused editor retains its draft');
        t.assert(after.start === 2 && after.end === 6 && after.direction === 'backward', 'selection survives worker replacement');
        t.near(after.top, before.top, 1, 'the page stays at the reading position');
        t.assert(!(await t.posted('viewerError')).length, 'worker replacement does not fail opening the PDF');
        await t.post({ type:'viewerProbe', requestId:'graceful', generation:2, page:1 });
        const probe = await t.waitPosted('viewerProbeResult', m => m.requestId === 'graceful');
        t.assert(probe.ok, 'the replacement worker answers page queries');
        await t.clear(); await ta.press('{');
        const edit = await t.waitPosted('editChange');
        t.assert(edit.text === draft.slice(0,2) + '{' + draft.slice(6), 'typing continues at the preserved selection');
    },
});

tests.push({
    id: 'pdf-worker-graceful-ranges',
    name: 'worker restart reopens the same native PDF generation and releases its old range resource',
    async run(t) {
        await t.eval(base64 => {
            const raw = atob(base64), answered = new Set();
            window.__rangeResponder = setInterval(() => {
                for (const m of window.__all.filter(m => m.type === 'pdfRangeRequest')) {
                    const key = `${m.token}:${m.request}`;
                    if (answered.has(key)) continue;
                    answered.add(key);
                    window.postMessage({ type:'pdfRange', token:m.token, request:m.request,
                        begin:m.begin, data:btoa(raw.slice(m.begin,m.end)) }, '*');
                }
            }, 5);
        }, t.fixture.base64);
        try {
            const open = async token => {
                await t.clear();
                await t.post({ type:'open', generation:2, pdfHash:'same-native-pdf',
                    base:`${t.origin}/pdfjs`, pdfRange:{ token, length:Buffer.from(t.fixture.base64,'base64').length } });
                await t.waitPosted('opened', m => m.generation === 2, 10000);
            };
            await open('native-before');
            await openParagraphCard(t);
            await t.eval(() => { window.__nativeRestartTextarea = document.querySelector('.editcard textarea'); });
            await t.clear();
            await t.post({ type:'restartPdfWorker' });
            await t.waitPosted('pdfRangeRelease', m => m.token === 'native-before');
            await open('native-after');
            t.assert(await t.eval(() => document.querySelector('.editcard textarea') === window.__nativeRestartTextarea),
                'the native range handoff retains the editor DOM');
            t.assert(!(await t.posted('pdfRangeRelease')).some(m => m.token === 'native-after'),
                'the replacement artifact stays pinned while it is displayed');
            await t.post({ type:'viewerProbe', requestId:'native-restarted', generation:2, page:1 });
            const probe = await t.waitPosted('viewerProbeResult', m => m.requestId === 'native-restarted');
            t.assert(probe.ok, 'the replacement worker opens the same generation from fresh ranges');
        } finally { await t.eval(() => clearInterval(window.__rangeResponder)); }
    },
});

tests.push({
    id: 'pdf-worker-recovery',
    name: 'a destroyed PDF worker is replaced on the next update and editing resumes',
    async run(t) {
        // Reproduce the ownership mistake made by PDF figure previews before
        // the fix, without giving the test access to the viewer's state.
        await t.eval(async base64 => {
            const pdfjs = await import('/pdfjs/pdf.min.mjs');
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const doc = await pdfjs.getDocument({ data:bytes }).promise;
            await doc.destroy();
        }, t.fixture.base64);
        await t.open(2);
        await t.post({ type:'viewerProbe', requestId:'recovered', generation:2, page:1 });
        const probe = await t.waitPosted('viewerProbeResult', m => m.requestId === 'recovered');
        t.assert(probe.ok, `the replacement worker serves page geometry: ${probe.reason || ''}`);
        const w = t.word('E');
        await t.post({ type:'sections', generation:2, pageWidth:595, items:[{
            key:'equation', kind:'equation', line:21, page:1, x:w.x, y:w.y, w:w.w, h:w.h,
            anchorX:530, anchorMaxW:60,
        }] });
        await t.page.keyboard.down('Shift');
        await t.waitFor(() => !!document.querySelector('.wpatag-equation'), null,
            { what:'the Shift equation tag after recovery' });
        await t.page.keyboard.up('Shift');
        await openParagraphCard(t);
        await t.open(3);
        t.assert(await count(t, '.editcard textarea') === 1, 'the mini-editor survives the next page update');
        t.assert((await t.posted('viewerError')).length === 0, 'the destroyed worker cannot strand later generations');
    },
});

tests.push({
    id: 'card-over-corrections',
    name: 'the mini-editor floats over corrections and follows its page while scrolling',
    async run(t) {
        await t.page.setViewportSize({ width: 1000, height: 720 });
        await t.post({ type: 'review', session: {
            file: 'fx.tex', pending: 1, census: '1 change', summary: {}, generation: 1,
            groups: [{ id: 'b1', at: Date.now(), source: 'disk', count: 1, hunks: [{
                id: 'h1', verb: 'change', where: 'rows', page: 1, lines: 1, changedWords: 1,
                rects: paraRows(t), name: 'paragraph', startLine: 7, theirText: 'old', ourText: 'new',
            }] }], decided: [],
        } });
        await t.eval(() => { document.getElementById('reviewpanel').style.height = '45vh'; });
        await openParagraphCard(t, { text: Array(30).fill(PARA).join('\n') });
        await t.sleep(250);
        const geometry = () => {
            const card = document.querySelector('.editcard'), c = card.getBoundingClientRect();
            const p = document.getElementById('reviewpanel').getBoundingClientRect();
            const x = c.left + c.width / 2, y = Math.max(c.top + 70, p.top + 20);
            return { cardTop: c.top, pageTop: card.parentElement.getBoundingClientRect().top,
                overlaps: c.bottom > p.top + 20 && y < c.bottom,
                onTop: document.elementFromPoint(x, y)?.closest('.editcard') === card };
        };
        const before = await t.eval(geometry);
        t.assert(before.overlaps, 'the card extends into the corrections panel');
        t.assert(before.onTop, 'the overlapping part of the mini-editor is visible and receives input');
        await t.eval(() => document.querySelector('main').scrollBy(0, 40));
        await t.sleep(100);
        const after = await t.eval(geometry);
        t.near(after.cardTop - before.cardTop, after.pageTop - before.pageTop, 1,
            'the floating card follows its source page');
        const handle = await t.eval(() => {
            const r = document.querySelector('.editcard .ec-title').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await t.page.mouse.move(handle.x, handle.y);
        await t.page.mouse.down();
        await t.page.mouse.move(handle.x, handle.y + 20);
        await t.page.mouse.up();
        const dragged = await t.eval(geometry);
        t.near(dragged.cardTop - after.cardTop, 20, 1, 'the floating card can still be dragged');
        t.assert(dragged.onTop, 'the dragged editor remains above corrections');
        if (process.env.WPAPER_WEBVIEW_SHOTS) await t.page.screenshot({
            path: `${process.env.WPAPER_WEBVIEW_SHOTS}/card-over-corrections.png`,
        });
        await t.post({ type: 'editClosed', editId: 11 });
        t.assert(await count(t, '.editcard') === 0, 'closing removes the floating editor');
    },
});

tests.push({
    id: 'card-comments-remembered',
    name: 'with the comments pane remembered open, the next right-click still opens the card (it used to recurse until the stack ran out)',
    async run(t) {
        await t.eval(() => { localStorage.setItem('wpaper.card.comments', JSON.stringify({ open: true, width: 280 })); });
        const rows = paraRows(t);
        await t.post({ type: 'comments', generation: 1, items: [
            { id: 'c1', cellId: 'x1', file: '/p/fx.tex', line: 8, endLine: 8, text: 'Added from the card', author: { name: 'Ada' },
                createdAt: new Date().toISOString(), rects: rows, unplaced: false }] });
        await openParagraphCard(t, { path: '/p/fx.tex' });
        if (!(await t.eval(() => document.getElementById('commentsbutton').getAttribute('aria-pressed') === 'true')))
            await t.page.click('#commentsbutton');
        await t.waitFor(() => document.querySelectorAll('.comment-marker').length > 0, null, { what: 'the comment marked beside its paragraph' });
        const r = await t.eval(() => ({ card: !!document.querySelector('.editcard'), cards: document.querySelectorAll('.editcard').length,
            pane: !!document.querySelector('.editcard .ec-comments'),
            items: [...document.querySelectorAll('.ecc-text')].map(x => x.value) }));
        t.assert(r.card && r.cards === 1, `one card opened (${r.cards})`);
        t.assert(r.pane, 'with its comments pane open, as remembered');
        t.assert(JSON.stringify(r.items) === JSON.stringify(['Added from the card']), `the block's comment is in it (${JSON.stringify(r.items)})`);
        await t.eval(() => localStorage.removeItem('wpaper.card.comments'));
    },
});

tests.push({
    id: 'preview-links',
    name: 'a reference preview keeps the links printed in it: the crop reports them, and the card makes them clickable',
    async run(t) {
        // The line "Seen again in (1), here." holds the \eqref link.
        const w = t.word('Seen');
        const rect = { page: 1, x: w.x - 2, y: w.y - 2, w: 300, h: (w.y1 - w.y) + 4 };
        await t.clear();
        await t.post({ type: 'crop', id: 'k1', rects: [rect], scale: 2, links: true });
        const got = await t.waitPosted('cropped');
        t.assert(Array.isArray(got.links) && got.links.length >= 1, `the crop reports the link (${JSON.stringify(got.links)})`);
        const l = got.links[0];
        t.assert(l.dest && l.fx >= 0 && l.fx + l.fw <= 1.001 && l.fy >= 0 && l.fy + l.fh <= 1.001, 'placed inside the crop, as fractions of it');
        // Hovering the reference in the text opens the preview; its link areas are anchors over the picture.
        const r = await t.eval(() => {
            const a = document.querySelector('.pdflink:not(.ext)');
            if (!a) return null;
            const b = a.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        });
        t.assert(!!r, 'the page has an internal link to hover');
        // Hovering the citation: its preview's arXiv link is clickable where it is printed.
        await t.clear();
        const cite = await t.eval(() => {
            const a = [...document.querySelectorAll('.pdflink:not(.ext)')].find(x => /^cite/.test(String(x._dest)));
            if (!a) return null;
            const b = a.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        });
        t.assert(!!cite, 'the citation is a link on the page');
        await t.page.mouse.move(cite.x, cite.y);
        await t.waitFor(() => !!document.querySelector('.destination-preview .destination-preview-link'), null, { what: 'the preview with its link' });
        const href = await t.eval(() => document.querySelector('.destination-preview .destination-preview-link').getAttribute('href'));
        t.assert(href === 'https://arxiv.org/abs/2001.07259', `the arXiv link is on the preview (${href})`);
        const box = await t.eval(() => { const b = document.querySelector('.destination-preview .destination-preview-link').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
        await t.page.mouse.move(box.x, box.y);
        await t.page.mouse.click(box.x, box.y);
        const opened = await t.waitPosted('openExternal');
        t.assert(opened.url === 'https://arxiv.org/abs/2001.07259', 'a click opens it in the browser');
    },
});

tests.push({
    id: 'card-comment-quote',
    name: 'text selected in the card is quoted in the new comment when the card\'s comments are open; another selection replaces the quote, what was written stays',
    async run(t) {
        await t.eval(() => { try { localStorage.removeItem('wpaper.card.comments'); } catch (_) {} });
        await openParagraphCard(t, { path: '/p/fx.tex' });
        await t.eval(() => document.querySelector('.ec-commentsbtn').click());
        await t.waitFor(() => !!document.querySelector('.ec-comments .ecc-new textarea'), null, { what: 'the comments pane' });
        const select = (word) => t.eval((w) => {
            const ta = document.querySelector('.ec-editor textarea');
            const i = ta.value.indexOf(w);
            ta.setSelectionRange(i, i + w.length);
            ta.dispatchEvent(new Event('select'));
            return document.querySelector('.ecc-new textarea')?.value ?? null;
        }, word);
        const first = await select('velocity');
        t.assert(first === '> velocity\n\n', JSON.stringify(first));
        await t.eval(() => { const b = document.querySelector('.ecc-new textarea'); b.value += 'Is this the right symbol?'; });
        const second = await select('paragraph');
        t.assert(second === '> paragraph\n\nIs this the right symbol?', JSON.stringify(second));
        // With the comments closed, a selection quotes nothing.
        await t.eval(() => document.querySelector('.ec-commentsbtn').click());
        await t.waitFor(() => !document.querySelector('.ec-comments'), null, { what: 'the pane closed' });
        await select('velocity');
        await t.eval(() => { try { localStorage.removeItem('wpaper.card.comments'); } catch (_) {} });
    },
});

tests.push({
    id: 'step-card',
    name: 'stepping the card to the next block opens it under that block at once, not where the last card was',
    async run(t) {
        await openParagraphCard(t);
        // A re-anchor (the live page re-measured) pins the card where it is.
        await t.post({ type: 'editAnchor', editId: 11, rects: paraRows(t), live: true });
        await t.sleep(80);
        // The next block: the equation, further down the page.
        const e = t.word('E');
        const rect = { page: 1, x: e.x, y: e.y, w: 200, h: e.y1 - e.y + 10 };
        const samples = await t.eval(async (m) => {
            window.postMessage(m, '*');
            const tops = [];
            for (let i = 0; i < 20; i++) {
                await new Promise(r => requestAnimationFrame(() => r()));
                const c = document.querySelector('.editcard');
                if (c && c.dataset.edit === '12') tops.push(c.getBoundingClientRect().top);
            }
            return tops;
        }, { type: 'editOpen', editId: 12, label: 'equation', file: 'fx.tex', startLine: 20, endLine: 22,
            text: 'E = mc^2', rects: [rect], stepped: true });
        t.assert(samples.length > 0, 'the stepped card opened');
        const under = (await t.toClient(1, rect.x, rect.y + rect.h)).y;
        t.assert(samples[0] >= under - 1, `the first frame shows it under the new block (card ${samples[0]}, block bottom ${under})`);
        t.near(Math.min(...samples), Math.max(...samples), 1, 'and it does not jump');
    },
});

module.exports = { fixtureTex, tests };

tests.push({
    id:'viewer-mode-fit-once',
    name:'entering viewer-only fits once without enabling responsive Fit or overriding later manual zoom',
    async run(t) {
        const width = () => t.eval(() => document.querySelector('.page').getBoundingClientRect().width);
        const fitted = () => {
            const main = document.querySelector('main'), css = getComputedStyle(main);
            const available = main.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
            return Math.abs(document.querySelector('.page').getBoundingClientRect().width - available) < 2;
        };
        for (const pro of [false,true]) {
            if (pro) await proOn(t);
            await t.post({ type:'fullscreen', mode:'all' });
            await t.page.locator('#zoomout').click();
            await t.page.locator('#zoomout').click();
            await t.sleep(100);
            await t.post({ type:'fullscreen', mode:'viewer' });
            await t.waitFor(fitted, null, { what:'one-shot fit on entering viewer-only' });
            t.assert(await t.page.locator('#fit').getAttribute('aria-pressed') === 'false', 'automatic fit does not enable responsive Fit');
            const fitWidth = await width();
            await t.page.locator('#zoomin').click(); await t.sleep(200);
            const manual = await width();
            t.near(manual, fitWidth * 1.25, 2, 'manual zoom after entering viewer-only works');
            await t.post({ type:'fullscreen', mode:'viewer' }); await t.sleep(100);
            t.near(await width(), manual, 2, 'a repeated layout-state replay does not fit again');
            await t.page.setViewportSize({ width:pro ? 850 : 800, height:800 }); await t.sleep(150);
            t.near(await width(), manual, 2, 'resizing does not turn one-shot Fit into a persistent mode');
        }
        await t.post({ type:'fullscreen', mode:'all' });
        // Entering before a PDF exists must remember the fit until it opens.
        await t.post({ type:'blank' });
        await t.post({ type:'fullscreen', mode:'viewer' });
        await t.open(2);
        await t.waitFor(fitted, null, { what:'deferred Fit when the PDF becomes ready' });
        await t.page.locator('#zoomin').click(); await t.sleep(150);
        const saved = await width();
        await t.post({ type:'fullscreen', mode:'all' });
        await t.post({ type:'fullscreen', mode:'viewer', fit:false }); await t.sleep(150);
        t.near(await width(), saved, 2, 'restoring a saved max layout keeps its remembered zoom');
        await t.page.screenshot({ path:'/tmp/wpaper-viewer-mode-fit.png' });
    },
});

tests.push({
    id:'review-rendered',
    name:'review defaults to authentic rendered snapshots, marks only changed ink, and toggles to numbered source',
    async run(t) {
        const fs = require('fs'), os = require('os'), path = require('path');
        const { ReviewRenderer, marksFor, changedRanges } = require('../../../tex/reviewRender');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-review-browser-'));
        const root = path.join(dir, 'paper.tex');
        const prefix = String.raw`\documentclass{article}
\usepackage{amsmath}
\newcommand{\reviewname}{Authentic}
\begin{document}
`;
        const beforeText = String.raw`The \reviewname{} old result remains useful.
\begin{equation}\boxed{\mathcal{D}_{+}=1}\end{equation}`;
        const afterText = beforeText.replace('old', 'new').replace('}=1', '}=2');
        const before = new Map([[root, prefix + beforeText + '\n\\end{document}\n']]);
        const after = new Map([[root, prefix + afterText + '\n\\end{document}\n']]);
        fs.writeFileSync(root, after.get(root));
        const hunk = { id:'render-hunk', verb:'change', theirText:beforeText, ourText:afterText,
            ourRange:{ startLine:5, endLine:7 }, theirRange:{ startLine:5, endLine:7 } };
        const renderer = new ReviewRenderer();
        try {
            const rendered = await renderer.render({ root, file:root, engine:'pdflatex', before, after, hunk });
            t.assert(!rendered.before.error && !rendered.after.error, 'both versions compile with the real macro');
            const session = { file:root, renderRevision:'fixture-revision', pending:1, focus:hunk.id, generation:1,
                groups:[{ id:'batch', at:1, hunks:[{ ...hunk, startLine:5, beforeLine:5, endLine:7,
                    words:{ ours:changedRanges(hunk,'after'), theirs:changedRanges(hunk,'before') }, rects:paraRows(t) }] }] };
            for (const pro of [false,true]) {
                if (pro) await proOn(t);
                await t.clear();
                await t.post({ type:'review', session:{ ...session, focus:null, renderRevision:`revision-${pro}` } });
                await t.eval(() => {
                    window.__reviewMeasurements = 0;
                    window.__reviewObserver?.disconnect();
                    window.__reviewObserver = new MutationObserver(records => {
                        for (const record of records) for (const node of record.removedNodes)
                            if (node.nodeType === 1 && node.style.position === 'fixed' && node.style.visibility === 'hidden' && node.textContent.includes('Authentic'))
                                window.__reviewMeasurements++;
                    });
                    window.__reviewObserver.observe(document.body, { childList:true });
                });
                await t.post({ type:'reviewPreloaded', file:root, revision:`revision-${pro}`, pdfs:['before','after'].map(side => ({
                    pdfId:`${pro}-${side}`, pdfBase64:rendered[side].pdfBase64, pages:[1] })) });
                await t.waitFor(() => window.__reviewMeasurements === 2, null, { what:'both review documents measured before selection' });
                await t.sleep(100);
                t.assert((await t.posted('reviewRender')).filter(m => m.id).length === 0, 'preloading needs no selected correction');
                await t.post({ type:'review', session:{ ...session, renderRevision:`revision-${pro}` } });
                const request = await t.waitPosted('reviewRender', m => !!m.id);
                t.assert(await count(t, '#reviewdiff .rd-fallback .rd-line') === 4, 'numbered code is visible while the default rendered view loads');
                t.assert(await t.page.locator('[data-reviewmode="rendered"]').getAttribute('aria-pressed') === 'true', 'rendered remains the selected display');
                const response = { ...request, type:'reviewRendered',
                    before:{ pdfId:`${pro}-before`, pdfBase64:rendered.before.pdfBase64, crops:rendered.before.crops },
                    after:{ pdfId:`${pro}-after`, pdfBase64:rendered.after.pdfBase64, crops:rendered.after.crops } };
                await t.post(response);
                const comparisonMarks = {};
                for (const side of ['before','after']) {
                    const message = await t.waitPosted('reviewRenderMap', m => m.side === side);
                    t.assert(message.items.some(it => it.str.includes('Authentic')), 'the preview uses the paper macro, not a generic renderer');
                    const marks = marksFor(rendered[side].detail.snapshot, rendered[side].detail, message.items);
                    comparisonMarks[side] = marks.marks;
                    t.assert(marks.marks.length === 4, `changed word and numeral map to four glyphs (${JSON.stringify(marks)})`);
                    const tags = message.items.filter(it => /^\([0-9]+\)$/.test(it.str));
                    t.assert(marks.marks.every(m => tags.every(tag => m.x + m.w <= tag.x || m.x >= tag.x + tag.w)),
                        'generated equation numbers remain unmarked');
                    await t.post({ type:'reviewRenderedMarks', requestId:request.requestId, side, ...marks });
                }
                await t.waitFor(() => document.querySelectorAll('#reviewdiff .rd-inkmark').length === 4, null,
                    { what:'the continuous changed-word and numeral underlines' });
                const ink = await t.eval(marks => ['before','after'].flatMap(side =>
                    [...document.querySelectorAll(`[data-reviewside="${side}"] .rd-inkmark`)].map(tag => {
                        const crop = tag.parentElement._reviewCrop;
                        const x = parseFloat(tag.style.left) / crop.scale + crop.x;
                        const y = (parseFloat(tag.style.top) - 1) / crop.scale + crop.y;
                        const glyph = marks[side].find(m => m.page === crop.page && Math.abs(m.x - x) < .5);
                        return { side, color:getComputedStyle(tag).borderBottomColor,
                            position:glyph && (y - glyph.y) / glyph.h };
                    })), comparisonMarks);
                for (const mark of ink) {
                    t.near(mark.position, mark.side === 'before' ? .55 : 1, .01,
                        'removed ink is struck through; added ink is underlined');
                    t.assert(mark.color === (mark.side === 'before' ? 'rgb(196, 62, 62)' : 'rgb(39, 132, 71)'),
                        'removals are red and additions green in both modes');
                }
                t.assert(await count(t, '#reviewdiff canvas') === 2, 'both rendered versions are visible');
                t.assert(await t.eval(() => window.__reviewMeasurements) === 2, 'selection reuses the preloaded page measurements and fonts');
                t.assert(await count(t, '#reviewdiff .rd-fallback') === 0, 'ready previews replace the source fallback');
                await t.page.locator('[data-reviewmode="code"]').click();
                await t.waitFor(() => document.querySelectorAll('#reviewdiff .rd-line').length > 0, null, { what:'the code view' });
                const code = await t.eval(() => ({ marks:[...document.querySelectorAll('#reviewdiff mark')].map(m => m.textContent),
                    numbers:[...document.querySelectorAll('#reviewdiff .rd-number')].map(n => n.textContent),
                    bg:getComputedStyle(document.querySelector('#reviewdiff .rd-line')).backgroundColor,
                    signs:[...document.querySelectorAll('#reviewdiff .rd-sign')].map(n => n.textContent) }));
                t.assert(code.marks.includes('1') && code.marks.includes('2'), 'source marks narrow the equation change to its digit');
                t.assert(code.marks.includes('old') && code.marks.includes('new'), 'source marks identify the replacement');
                t.assert(!code.marks.includes('remains') && !code.marks.includes('useful.'), 'unchanged words stay neutral');
                t.assert(code.numbers.includes('5') && code.numbers.includes('6'), 'source line numbers are present');
                t.assert(code.bg === 'rgba(0, 0, 0, 0)', 'the unchanged parts of a changed source line are not washed');
                t.assert(code.signs.includes('−') && code.signs.includes('+'), 'source changes have visible addition/removal signs');
                await t.page.locator('[data-reviewmode="rendered"]').click();
                await t.waitFor(() => document.querySelectorAll('#reviewdiff canvas').length === 2, null, { what:'rendered view restored' });
                t.assert((await t.posted('reviewRender')).filter(m => m.id).length === 1, 'changing display mode reuses the cached snapshots');
                // An old answer from another selection cannot replace this preview.
                await t.post({ type:'reviewRendered', requestId:request.requestId - 1, revision:request.revision, error:'obsolete' });
                await t.sleep(30);
                t.assert(!(await t.eval(() => document.getElementById('reviewdiff').textContent)).includes('obsolete'), 'late results are ignored');
            }
            const grip = await t.page.locator('#rpgrip').boundingBox();
            await t.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await t.page.mouse.down();
            await t.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 160, { steps:5 });
            await t.page.mouse.up();
            await t.page.screenshot({ path:'/tmp/wpaper-rendered-review.png' });
            await t.page.locator('[data-reviewmode="code"]').click();
            await t.page.screenshot({ path:'/tmp/wpaper-review-code.png' });
        } finally { renderer.dispose(); fs.rmSync(dir, { recursive:true, force:true }); }
    },
});

tests.push({
    id:'review-continuous-region',
    name:'fragmented review text becomes a continuous selection-shaped region without internal bracket marks',
    async run(t) {
        const rows = paraRows(t);
        const fragments = rows.flatMap(r => [
            { ...r, w:r.w * .25 },
            { ...r, x:r.x + r.w * .28, w:r.w * .3 },
            { ...r, x:r.x + r.w * .61, w:r.w * .39 },
        ]);
        const session = { file:t.fixture.pdf, renderRevision:'continuous-region', pending:1, focus:'continuous', generation:1,
            groups:[{ id:'continuous', at:1, hunks:[{ id:'continuous', verb:'change', startLine:7,
                rects:fragments, ourText:PARA, theirText:'Old paragraph.' }] }] };
        for (const pro of [false,true]) {
            if (pro) await proOn(t);
            await t.post({ type:'review', session });
            await t.waitFor(() => document.querySelectorAll('.rband').length === 2, null,
                { what:'one merged band per printed row' });
            const shape = await t.eval(() => [...document.querySelectorAll('.rband')].map(b => {
                const rect = b.getBoundingClientRect(), style = getComputedStyle(b);
                return { x:rect.x, y:rect.y, w:rect.width, h:rect.height, fill:style.backgroundColor,
                    shadow:style.boxShadow, border:style.borderLeftWidth, radius:style.borderRadius };
            }));
            const first = await t.toClient(1, rows[0].x, rows[0].y);
            const right = await t.toClient(1, rows[0].x + rows[0].w, rows[0].y);
            t.near(shape[0].x, first.x, .5, 'the region starts at the first fragment');
            t.near(shape[0].x + shape[0].w, right.x, .5, 'the whole row, including spaces between fragments, is covered');
            t.near(shape[0].y + shape[0].h, shape[1].y, .5, 'consecutive rows have no white leading gap');
            t.assert(shape.every(b => b.shadow === 'none' && b.border === '0px'), 'fragment starts have no bracket-like shadows or borders');
            t.assert(shape.every(b => b.radius === '0px'), 'rounded fragment corners cannot leave little white holes');
            t.assert(shape.every(b => b.fill === 'rgba(80, 180, 120, 0.14)'), 'the merged region has one gentle highlight colour');
            t.assert(await count(t,'.rcontour') === 1, 'only the outer region has a focus outline');
            if (!pro) {
                await t.page.locator('#zoomin').click(); await t.sleep(500);
                t.assert(await count(t,'.rband') === 2, 'zoom keeps the fragments merged');
            }
        }
        await t.page.screenshot({path:'/tmp/wpaper-review-continuous-region.png'});
        // A real paragraph gap stays distinct, and deletion seams remain seams.
        await t.post({ type:'review', session:{ ...session, groups:[{ id:'continuous', at:1, hunks:[
            { ...session.groups[0].hunks[0], rects:[rows[0], { ...rows[1], y:rows[1].y + 50 }] },
            { id:'removed', verb:'del', startLine:10, rects:[{ ...rows[0], y:rows[0].y + 100, w:0, caret:true }], theirText:'Removed.' },
        ] }] } });
        await t.waitFor(() => document.querySelectorAll('.rband').length === 3, null, { what:'disconnected regions and a deletion seam' });
        const gap = await t.eval(() => {
            const bands = [...document.querySelectorAll('.rband.change')].map(b => b.getBoundingClientRect());
            const seam = document.querySelector('.rband.del');
            return { gap:bands[1].top - bands[0].bottom, seamHeight:parseFloat(seam.style.height), fill:getComputedStyle(seam).backgroundColor };
        });
        t.assert(gap.gap > 20, 'a genuinely separated paragraph is not covered by a bridge');
        t.assert(gap.seamHeight === 0 && gap.fill === 'rgba(0, 0, 0, 0)', 'removed text leaves a seam instead of a filled region');
    },
});

tests.push({
    id:'review-word-underline',
    name:'main viewer underlines only verified added ink, preserves it through zoom, and rejects stale geometry',
    async run(t) {
        for (const pro of [false,true]) {
            if (pro) await proOn(t);
            const generation = pro ? 2 : 1;
            if (pro) await t.open(generation);
            await t.post({ type:'nativeMapState', generation, available:pro });
            await t.clear();
            const rects = paraRows(t), word = box(t.word('velocity'));
            const session = { file:t.fixture.pdf, renderRevision:`underline-${pro}`, pending:1, focus:'underline', generation,
                groups:[{ id:'underline', at:1, hunks:[{ id:'underline', verb:'change', startLine:7, rects,
                    theirText:PARA.replace('velocity','speed'), ourText:PARA,
                    words:{ ours:[{line:0,col:4,len:8}], theirs:[{line:0,col:4,len:5}] } }] }] };
            await t.post({ type:'review', session });
            const request = await t.waitPosted('reviewPageMap', m => m.id === 'underline');
            t.assert(pro || request.items.some(it => it.str.includes('velocity')), 'standard mode supplies measured printed text');
            t.assert(!pro || request.items.length === 0, 'Pro mode requests exact engine origins');
            t.assert(await count(t,'.runderline') === 0, 'no underline is guessed from a broad source fragment');
            await t.post({ ...request, type:'reviewPageMarks', marks:[word] });
            await t.waitFor(() => !!document.querySelector('.runderline'), null, { what:'the precise added-word underline' });
            const geometry = () => t.eval(() => {
                const wrap = document.querySelector('.page[data-page="1"]'), line = wrap.querySelector('.runderline');
                const b = line.getBoundingClientRect(), p = wrap.getBoundingClientRect();
                return { x:(b.left-p.left)/p.width, y:(b.top-p.top)/p.height, w:b.width/p.width,
                    height:b.height, fill:getComputedStyle(wrap.querySelector('.rband')).backgroundColor };
            });
            const before = await geometry();
            t.near(before.w, word.w / t.fixture.pages[0].width, .003, 'the underline is exactly the added word width');
            t.assert(before.height <= 2.1, 'the new text has a fine underline');
            t.assert(await count(t, '.rinkfill') === 1, 'only the verified new word receives the stronger tint');
            t.assert(before.fill === 'rgba(80, 180, 120, 0.14)', 'the fragment has a quiet continuous region fill');
            await t.page.locator('#zoomin').click(); await t.sleep(500);
            const zoomed = await geometry();
            t.near(zoomed.x, before.x, .002, 'zoom preserves underline placement');
            t.near(zoomed.w, before.w, .002, 'zoom preserves word coverage');
            await t.post({ ...request, type:'reviewPageMarks', revision:'obsolete', marks:rects });
            await t.sleep(20);
            t.near((await geometry()).w, before.w, .002, 'an obsolete broad answer cannot replace the word underline');
            await t.page.screenshot({path:`/tmp/wpaper-review-word-underline-${pro ? 'pro' : 'standard'}.png`});
            await t.open(generation + 1); await t.sleep(100);
            t.assert(await count(t,'.runderline') === 0, 'another PDF generation removes stale ink');
        }
    },
});

tests.push({
    id:'review-code-fallback',
    name:'review source stays readable while loading, on empty or failed previews, and across stale replies',
    async run(t) {
        const session = { file:t.fixture.pdf, pending:1, focus:'fallback-hunk', generation:1,
            groups:[{ id:'fallback-batch', at:1, hunks:[{ id:'fallback-hunk', verb:'change', startLine:7, beforeLine:6,
                theirText:'The old result.', ourText:'The new result.',
                words:{ theirs:[{ line:0, col:4, len:3 }], ours:[{ line:0, col:4, len:3 }] }, rects:paraRows(t) }] }] };
        const readable = async label => {
            const source = await t.eval(() => ({ text:[...document.querySelectorAll('#reviewdiff .rd-source')].map(n => n.textContent),
                marks:[...document.querySelectorAll('#reviewdiff mark')].map(n => n.textContent),
                lines:[...document.querySelectorAll('#reviewdiff .rd-number')].map(n => n.textContent) }));
            t.assert(source.text.join('|') === 'The old result.|The new result.', `${label}: both source versions remain visible`);
            t.assert(source.marks.join('|') === 'old|new', `${label}: precise change marks remain visible`);
            t.assert(source.lines.join('|') === '6|7', `${label}: source line numbers remain visible`);
        };
        let previous;
        const cases = [
            { before:{ error:'This change has no printed content. Use Code to see the source change.' }, after:{ empty:true } },
            { error:'The paper did not compile.' },
            { before:{ pdfBase64:'!', crops:[{ page:1 }] }, after:{ crops:[] } },
            { before:{ pdfBase64:t.fixture.base64, crops:[{ page:999, x:0, y:0, w:100, h:100 }] }, after:{ empty:true } },
        ];
        for (const [i, result] of cases.entries()) {
            await t.clear();
            await t.post({ type:'review', session:{ ...session, renderRevision:`fallback-${i}` } });
            await t.waitFor(() => document.querySelectorAll('#reviewdiff .rd-fallback').length === 2, null, { what:'source fallback' });
            await readable('loading');
            t.assert(await t.eval(() => [...document.querySelectorAll('#reviewdiff [data-reviewside]')]
                .every(holder => holder.firstElementChild?.classList.contains('rd-preview-status'))),
                'loading and failure explanations appear above the source, including long blocks');
            if (previous) await t.post({ ...previous, type:'reviewRendered', error:'obsolete preview' });
            const request = await t.waitPosted('reviewRender', m => !!m.id);
            await t.post({ ...request, ...result, type:'reviewRendered' });
            await t.waitFor(() => [...document.querySelectorAll('#reviewdiff .rd-preview-status')].every(n => n.textContent.startsWith('Showing code.')), null,
                { what:'fallback after unavailable preview' });
            await readable(`unavailable preview ${i}`);
            t.assert(!(await t.eval(() => document.getElementById('reviewdiff').textContent)).includes('Use Code'), 'fallback does not ask users to switch modes to see already visible code');
            t.assert(!(await t.eval(() => document.getElementById('reviewdiff').textContent)).includes('obsolete preview'), 'stale failures cannot replace current content');
            previous = request;
        }
        // A late answer can be cached, but cannot change an explicit Code view.
        await t.page.locator('[data-reviewmode="code"]').click();
        await t.post({ ...previous, type:'reviewRendered', error:'preview failed while Code was selected' });
        await t.sleep(30);
        await readable('explicit Code mode');
        t.assert(await count(t, '#reviewdiff .rd-preview-status') === 0, 'late rendered responses leave explicit Code mode alone');
        await t.page.locator('[data-reviewmode="rendered"]').click();
        await t.waitFor(() => document.querySelector('#reviewdiff .rd-preview-status')?.textContent.includes('preview failed while Code was selected'), null,
            { what:'cached error with readable fallback' });
        await readable('cached rendering failure');
        await t.page.screenshot({ path:'/tmp/wpaper-review-code-fallback.png' });
    },
});

tests.push({
    id:'review-paragraph-location',
    name:'rendered review finds the changed run-in paragraph even when SyncTeX points to an unchanged logarithm',
    async run(t) {
        const fs = require('fs'), os = require('os'), path = require('path');
        const { ReviewRenderer, marksFor, changedRanges } = require('../../../tex/reviewRender');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-review-paragraph-'));
        const root = path.join(dir, 'paper.tex');
        const prefix = String.raw`\documentclass{article}
\usepackage{amsmath,amssymb}
\newcommand{\iV}{\mathsf{v}}
\newcommand{\R}{\mathbb{R}}
\begin{document}
`;
        const beforeText = String.raw`\paragraph{The weight.}  On each interval $\iV$ runs over all of $\R$, so it
vanishes inside $\Sigma$, at $t=\pm\sqrt{ab}$ (from
$(t+b)(t-a)=(t+a)(b-t)$).  With $W=0$, a finite positive weight needs $r$ to vanish
there too.  A simple admissible choice \eqref{eq:gen-admissible} is`;
        const afterText = String.raw`\paragraph{A hidden one-cut structure.}  Besides $t\to-t$, the seed has a
second symmetry: $\sigma:t\to-ab/t$ maps $\Sigma$ onto itself, exchanging the two
intervals.  Its invariant`;
        const tail = String.raw`
\begin{equation}\label{eq:gen-admissible}
\iV(t)=s_0^2\log\left|\frac{(t+b)(t-a)}{(t+a)(t-b)}\right|,
\end{equation}
This unrelated paragraph remains unchanged below the logarithm.
\end{document}
`;
        fs.writeFileSync(root, prefix + afterText + tail);
        const hunk = { id:'paragraph-location', verb:'change', theirText:beforeText, ourText:afterText,
            theirRange:{ startLine:6, endLine:10 }, ourRange:{ startLine:6, endLine:9 } };
        const renderer = new ReviewRenderer();
        try {
            const rendered = await renderer.render({ root, file:root, engine:'pdflatex',
                before:new Map([[root, prefix + beforeText + tail]]), after:new Map([[root, prefix + afterText + tail]]), hunk });
            t.assert(!rendered.before.error && !rendered.after.error, 'both versions compile');
            await t.clear();
            await t.post({ type:'review', session:{ file:root, renderRevision:'paragraph-location', pending:1, focus:hunk.id,generation:1,
                groups:[{ id:'paragraph-location', at:1, hunks:[{ ...hunk, startLine:6, beforeLine:6,
                    words:{ ours:changedRanges(hunk,'after'), theirs:changedRanges(hunk,'before') }, rects:paraRows(t) }] }] } });
            const request = await t.waitPosted('reviewRender', m => !!m.id);
            const wire = {};
            // Reproduce an unreliable SyncTeX anchor at the neighbouring
            // unchanged equation; the printed words must correct it.
            for (const side of ['before','after']) {
                const detail = rendered[side].detail;
                const equation = detail.context.model.objects.find(o => o.kind === 'display-equation');
                const wrong = detail.snapshot.map.objectRenderBoxes(equation).rects;
                detail.rows = detail.crops = wrong;
                wire[side] = { pdfBase64:rendered[side].pdfBase64, crops:wrong };
            }
            await t.post({ ...request, type:'reviewRendered', ...wire });
            for (const side of ['before','after']) {
                const message = await t.waitPosted('reviewRenderMap', m => m.side === side);
                const detail = rendered[side].detail;
                const mapping = marksFor(detail.snapshot, detail, message.items);
                t.assert(!mapping.error, `printed paragraph is verified: ${JSON.stringify(mapping)}`);
                const heading = message.items.find(it => it.str.includes(side === 'before' ? 'The weight' : 'A hidden'));
                t.assert(!!heading, 'the actual heading is available in the full page');
                const finalWord = message.items.find(it => it.str.includes(side === 'before' ? 'choice' : 'invariant'));
                const log = message.items.find(it => it.str === 'log');
                t.assert(mapping.crops.some(c => heading.x >= c.x && heading.y >= c.y && heading.y + heading.h <= c.y + c.h), 'crop contains the run-in heading completely');
                t.assert(mapping.crops.some(c => finalWord.y >= c.y && finalWord.y + finalWord.h <= c.y + c.h), `crop contains the end of the paragraph completely (${side}: ${JSON.stringify({ crops:mapping.crops, finalWord, glyphs:require('../../../tex/glyphAlign').renderedGlyphs(message.items).map(g => g.ch).join('') })})`);
                t.assert(mapping.crops.every(c => c.y + c.h < (log.inkY ?? log.y)), `the unrelated logarithm is excluded (${side}: ${JSON.stringify({ crops:mapping.crops, log })})`);
                t.assert(mapping.marks.every(m => m.y + m.h < (log.inkY ?? log.y)), 'no changed mark lands on the unchanged logarithm');
                t.assert(mapping.marks.length > 30, 'the changed prose is marked, not just a handful of shared symbols');
                // Source stays readable until the verified location arrives.
                t.assert(await count(t, `[data-reviewside="${side}"] .rd-fallback`) === 1, 'unverified crops are never shown');
                await t.post({ type:'reviewRenderedMarks', requestId:request.requestId, side, ...mapping });
            }
            await t.waitFor(() => document.querySelectorAll('#reviewdiff canvas').length === 2 && !document.querySelector('#reviewdiff .rd-fallback'), null,
                { what:'both verified paragraph previews' });
            const grip = await t.page.locator('#rpgrip').boundingBox();
            await t.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await t.page.mouse.down();
            await t.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 160, { steps:5 });
            await t.page.mouse.up();
            await t.page.screenshot({ path:'/tmp/wpaper-review-paragraph-location.png' });
        } finally { renderer.dispose(); fs.rmSync(dir, { recursive:true, force:true }); }
    },
});

// The reported Q_0 constants equation: nested fractions/scripts, macros from
// the actual preamble, a similar formula in preceding prose, and prose below.
tests.push({
    id:'review-complex-equation',
    name:'review renders nested equations at the correct location with pdfTeX and XeTeX, in both viewer modes',
    async run(t) {
        const fs = require('fs'), os = require('os'), path = require('path');
        const { ReviewRenderer, marksFor, changedRanges } = require('../../../tex/reviewRender');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpaper-review-complex-'));
        const root = path.join(dir, 'paper.tex');
        const prefix = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,amssymb,bbm}
\newcommand{\dd}{\mathrm d}
\newcommand{\iV}{\mathbbm v}
\newcommand{\bbs}{\mathbbm s}
\begin{document}
Dividing the $Q_1$ problem gives $Q_1(0)|_{\lambda=0}$ as one more
Cauchy integral. At $t=0$ the principal value vanishes by parity. Altogether,
`;
        const beforeText = String.raw`\begin{equation}
\mathbf{Q}_0(0)\big|_{\lambda=0}=\frac{1}{\sqrt{1+\pi^2m^2\bbs(0)^4\chi(0)^2}},\qquad
\Delta=\mathrm{pv}\!\int_\Sigma\frac{\iV}{t}\,
\frac{\bbs^2\chi\,\dd t}{(1+\pi^2m^2\bbs^4\chi^2)\,\mathbf{Q}_0(t)|_{\lambda=0}} .
\label{eq:abs-Q0-constants}
\end{equation}
Since $m$ is imaginary, these constants remain useful.
At $m=0$ these reduce to $1$ and $\int_\Sigma(\iV/t)\,\bbs^2\chi\,\dd t$.`;
        const afterText = beforeText.replace('\\frac{1}', '\\frac{2}')
            .replace('\\bbs^4', '\\bbs^5').replace('imaginary', 'real');
        const startLine = prefix.split('\n').length;
        const hunk = { id:'complex-equation', verb:'change', theirText:beforeText, ourText:afterText,
            theirRange:{ startLine, endLine:startLine + beforeText.split('\n').length },
            ourRange:{ startLine, endLine:startLine + afterText.split('\n').length } };
        const before = new Map([[root, prefix + beforeText + '\n\\end{document}\n']]);
        const after = new Map([[root, prefix + afterText + '\n\\end{document}\n']]);
        fs.writeFileSync(root, after.get(root));
        const renderer = new ReviewRenderer();
        try {
            for (const engine of ['pdflatex','xelatex']) {
                const rendered = await renderer.render({ root, file:root, engine, before, after, hunk });
                t.assert(!rendered.before.error && !rendered.after.error, `${engine}: authentic snapshots compile`);
                for (const pro of [false,true]) {
                    await t.post({ type:'engine', state:pro ? 'live' : 'off', keyMs:18 });
                    await t.clear();
                    await t.post({ type:'review', session:{ file:root, renderRevision:`complex-${engine}-${pro}`,
                        pending:1, focus:hunk.id, generation:1, groups:[{ id:'complex', hunks:[{
                            ...hunk, startLine, beforeLine:startLine,
                            words:{ ours:changedRanges(hunk,'after'), theirs:changedRanges(hunk,'before') }, rects:paraRows(t),
                        }] }] } });
                    const request = await t.waitPosted('reviewRender', m => !!m.id);
                    await t.post({ ...request, type:'reviewRendered', ...Object.fromEntries(['before','after'].map(side => [side, {
                        pdfId:rendered[side].pdfId, pdfBase64:rendered[side].pdfBase64, crops:rendered[side].crops,
                    }])) });
                    for (const side of ['before','after']) {
                        const message = await t.waitPosted('reviewRenderMap', m => m.side === side);
                        const detail = rendered[side].detail;
                        const mapping = marksFor(detail.snapshot, detail, message.items);
                        t.assert(!mapping.error && mapping.crops.length, `${engine}/${pro}/${side}: nested equation maps (${mapping.error})`);
                        t.assert(mapping.mapped === mapping.changed && mapping.marks.length,
                            `${engine}/${pro}/${side}: the numerator, nested superscript and prose all map`);
                        const tag = message.items.find(it => it.str === '(1)');
                        t.assert(tag && mapping.marks.every(m => m.x + m.w <= tag.x || m.x >= tag.x + tag.w ||
                            m.y + m.h <= (tag.inkY ?? tag.y) || m.y >= (tag.inkY ?? tag.y) + (tag.inkH ?? tag.h)),
                            'the generated equation tag is left unmarked');
                        t.assert(mapping.crops.some(c => c.x <= tag.x && c.x + c.w >= tag.x + tag.w &&
                            c.y <= (tag.inkY ?? tag.y) && c.y + c.h >= (tag.inkY ?? tag.y) + (tag.inkH ?? tag.h)),
                            'an equation tag on its own baseline is rendered completely');
                        const neighbouring = message.items.find(it => it.str.includes('Cauchy'));
                        t.assert(neighbouring && mapping.crops.every(c => c.y > neighbouring.baseline),
                            'the crop starts at the changed equation, below the similar unchanged prose');
                        await t.post({ type:'reviewRenderedMarks', requestId:request.requestId, side, ...mapping });
                    }
                    await t.waitFor(() => document.querySelectorAll('#reviewdiff canvas').length === 2 &&
                        !document.querySelector('#reviewdiff .rd-fallback'), null, { what:`${engine}/${pro}: both real previews replace code` });
                    t.assert(await count(t, '#reviewdiff .rd-inkmark') > 0, 'changed ink is underlined');
                }
            }
            const grip = await t.page.locator('#rpgrip').boundingBox();
            await t.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await t.page.mouse.down();
            await t.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 200, { steps:5 });
            await t.page.mouse.up();
            await t.page.screenshot({ path:'/tmp/wpaper-review-complex-equation.png' });
        } finally { renderer.dispose(); fs.rmSync(dir, { recursive:true, force:true }); }
    },
});
