// tex-viewer.js — Page mode: the compiled paper, rendered, clickable.
//
// Runs INSIDE the VS Code webview. Talks to texViewer.js (extension side) over
// postMessage only; it never touches the file system and never imports vscode.
//
// Everything geometric here rests on Stage 0 Spike C, which measured pdf.js
// against poppler and against its own library:
//
//   * TAKE THE PAGE BOX FROM `page.view`, NEVER THE MEDIABOX. pdf.js measures
//     from the CropBox intersected with the MediaBox; poppler ignores CropBox
//     entirely. On a cropped file the same word sits 70.71 bp apart in the two
//     frames, and every uncropped fixture hides it.
//   * THE OFFSET VIEWPORT IS EXACT. Rendering a clipped region via
//     viewport.clone({offsetX, offsetY}) is pixel-identical to rendering the
//     whole page and cropping — max interior difference 0 — at 1.9 MB against
//     30.6 MB at 4x. Used for the highlight thumbnail.
//   * RENDER IS FRAME-BOUND, NOT RASTER-BOUND. Every render costs exactly one
//     requestAnimationFrame; 1x through 6x all land at 4-9 ms, the same as a
//     24x24 px render. Budget one frame, and do not fear scale.
//   * `render().promise` RESOLVING DOES NOT MEAN THE PIXELS EXIST. Canvas 2D
//     queues draw calls. That bit a benchmark; here it means "rendered" must
//     not be reported before the canvas is actually painted.
//   * A BLOCKED WORKER IS NOT A FAILURE MODE TO DESIGN AROUND. With `Worker`
//     refused, pdf.js's fake-worker fallback shows no measurable penalty on
//     text pages. But the fallback is GLOBAL AND STICKY: after one refusal
//     pdf.js never tries again for the page's lifetime.

const vscode = acquireVsCodeApi();

const state = {
    pdfjs: null,
    doc: null,
    pageCount: 0,
    scale: 1.25,
    rendered: new Map(),      // pageNumber -> {canvas, viewport}
    pending: new Map(),
    highlight: null,          // {page, rects:[{x,y,w,h}], flag}
    followCursor: true,
    pinHighlight: false,
    fullscreen: false,
    generation: null,
    labels: null,             // {generation, items} — the label overlay, cached
    labelsOn: false,          // Shift is down
    labelsPinned: false,      // the toolbar toggle
    labelsAsked: null,        // the generation we have already asked for
};

const el = (id) => document.getElementById(id);
const pagesEl = () => el('pages');

// --- theme -------------------------------------------------------------------
//
// The panel's chrome follows the theme on its own, through the --vscode-*
// variables. THE PAGES DO NOT: a compiled PDF is white paper with black ink,
// and it stays white however dark the editor around it is.
//
// Darkening them is a CSS `filter` on the canvas ELEMENT and never a rewrite of
// its pixels. That is not a stylistic choice: `snapToInk` and the harness both
// read the canvas back with getImageData and decide "this is ink" from
// `red < 140` against white paper. A filter leaves the backing store untouched,
// so word-precise highlighting keeps working in dark mode; inverting the pixels
// would silently invert that test and break every word rect on the page.

/** Apply a theme decision from the extension (or a fallback guess). */
function applyTheme(dark, pages) {
    state.themeDark = !!dark;
    state.pageTheme = pages === 'dark' ? 'dark' : 'light';
    document.body.classList.toggle('wb-dark', state.themeDark);
    document.body.classList.toggle('wb-dark-pages', state.pageTheme === 'dark');
    const b = el('pagetheme');
    if (b) {
        const onDark = state.pageTheme === 'dark';
        b.textContent = onDark ? '☾' : '☀';
        b.title = onDark
            ? 'Pages are darkened — click for white paper' +
              (state.setting === 'auto' ? ' (following the theme)' : '')
            : 'Pages are white — click to darken them' +
              (state.setting === 'auto' ? ' (following the theme)' : '');
        b.setAttribute('aria-pressed', String(onDark));
    }
}

/**
 * What the webview can work out for itself, used only until the extension says
 * otherwise — and in the harness, where there is no extension at all.
 *
 * `prefers-color-scheme` is the OPERATING SYSTEM's preference, not the editor's,
 * so it is the last resort: VS Code stamps the theme kind on the body, and that
 * is what the reader actually chose.
 */
function guessDark() {
    const c = document.body.classList;
    if (c.contains('vscode-dark') || c.contains('vscode-high-contrast')) return true;
    if (c.contains('vscode-light') || c.contains('vscode-high-contrast-light')) return false;
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (_) { return false; }
}

function status(text, kind = '') {
    const s = el('status');
    s.textContent = text;
    s.className = kind;
}

// --- loading ----------------------------------------------------------------

// Phase timings, reported to the extension so a slow first load can be
// diagnosed from the log rather than guessed at. A webview is not the headless
// browser the harness measures: the worker may be refused, fonts arrive over a
// different protocol, and neither shows up in a local http test.
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const T0 = now();
const marks = [];
const mark = (name) => marks.push([name, Math.round(now() - T0)]);
mark('module');

/**
 * A pdf.js worker that a VS Code webview will actually let us construct.
 *
 * THE MEASUREMENT THAT FORCED THIS. A webview runs on `vscode-webview://…`
 * while its resources are served from `https://file+.vscode-resource.vscode-cdn.net`,
 * and a Worker may not be constructed across origins:
 *
 *   Failed to construct 'Worker': Script at 'https://file+.vscode-resource…/
 *   pdf.worker.min.mjs' cannot be accessed from origin 'vscode-webview://…'
 *
 * pdf.js then falls back to running everything on the main thread, and on a
 * real paper that took **30.0 seconds** to parse one 9-page document — the
 * whole of the slow first load. The headless harness never saw it because
 * there the page and the worker share an origin.
 *
 * Fetching the script and constructing the Worker from a BLOB makes it
 * same-origin. The bundle is self-contained — no static imports — so nothing
 * inside it needs to resolve a relative URL. The CSP already allows `blob:`
 * in worker-src.
 */
async function makeWorkerPort(base) {
    try {
        // Outside a webview (the harness, a browser) this just works.
        return { port: new Worker(`${base}/pdf.worker.min.mjs`, { type: 'module' }), how: 'direct worker' };
    } catch (_) { /* cross-origin: fall through to the blob */ }
    try {
        const src = await (await fetch(`${base}/pdf.worker.min.mjs`)).text();
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const port = new Worker(url, { type: 'module' });
        // A blob worker fails ASYNCHRONOUSLY, so give it a moment to complain
        // before trusting it. Half a second once beats thirty seconds always.
        const ok = await new Promise((resolve) => {
            const done = (v) => { port.removeEventListener('error', bad); resolve(v); };
            const bad = () => done(false);
            port.addEventListener('error', bad, { once: true });
            setTimeout(() => done(true), 500);
        });
        if (!ok) { try { port.terminate(); } catch (_) { /* gone */ } return { port: null, how: 'blob worker failed' }; }
        return { port, how: 'blob worker' };
    } catch (e) {
        return { port: null, how: 'NO worker (' + (e && e.message ? e.message : e) + ') — pdf.js runs on the main thread' };
    }
}

async function loadPdfjs(base) {
    if (state.pdfjs) return state.pdfjs;
    const mod = await import(`${base}/pdf.min.mjs`);
    mark('pdfjs imported');
    const w = await makeWorkerPort(base);
    state.workerHow = w.how;
    mark('worker ' + (w.port ? 'ready' : 'unavailable'));
    try {
        if (w.port) mod.GlobalWorkerOptions.workerPort = w.port;
        else mod.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.min.mjs`;
    } catch (_) { /* pdf.js will arm its own fallback */ }
    state.pdfjs = mod;
    return mod;
}

async function openDocument(msg) {
    const pdfjs = await loadPdfjs(msg.base);
    status('loading…');
    // PER-OPEN timing, distinct from the module-level marks above: those
    // measure cold start and are reported once, which meant a LIVE rebuild —
    // the thing that happens hundreds of times in a session — was never timed
    // at all. Cheap enough to leave on: five clock reads and one message.
    const tOpen = now();
    const openMarks = [];
    const omark = (name) => openMarks.push(`${name} ${Math.round(now() - tOpen)}ms`);
    try {
        // Bytes, not a URL: the extension reads the file and posts it, which
        // avoids localResourceRoots and the /var -> /private/var symlink that
        // makes an out-of-tree PDF silently unfetchable.
        //
        // pdf.js TRANSFERS this array to its worker, detaching it — the
        // Uint8Array is length 0 the moment getDocument is called. So it is
        // decoded fresh per open and never reused.
        const raw = atob(msg.pdfBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const task = pdfjs.getDocument({
            data: bytes,
            // Required for this corpus: 164 non-embedded base-14 references
            // across 69 real papers. Without it every glyph box moves.
            standardFontDataUrl: `${msg.base}/standard_fonts/`,
            // Nothing here needs an eval-based font path, and a webview CSP
            // will refuse it anyway.
            isEvalSupported: false,
        });
        const prev = state.doc;
        mark('bytes decoded');
        omark('decode');
        const anchor = scrollAnchor();
        state.doc = await task.promise;
        mark('document parsed');
        omark('parse');
        const samePagination = msg.live && state.pageCount === state.doc.numPages
            && pagesEl().children.length === state.doc.numPages;
        state.pageCount = state.doc.numPages;
        state.generation = msg.generation;
        // Which pages were on screen BEFORE the swap: those are the ones worth
        // repainting immediately. The rest keep their old canvas until the
        // reader scrolls to them, which is both smooth and cheap.
        const wasRendered = samePagination ? [...state.rendered.keys()] : [];
        state.rendered.clear();
        state.pending.clear();
        textCache.clear();
        let placeholders = null;
        if (!samePagination) {
            pagesEl().innerHTML = '';
            placeholders = buildPagePlaceholders();
        }
        el('pagecount').textContent = String(state.pageCount);
        status(`${state.pageCount} pages · gen ${msg.generation}`, 'ok');
        observeVisible();
        // A NEW GENERATION INVALIDATES THE OLD HIGHLIGHT.
        //
        // The rects were computed against the previous compile. After an edit
        // the same object has moved — often onto a different line, sometimes a
        // different page — so repainting them draws a marker over whatever now
        // happens to occupy that spot. Drop it and ask for a fresh one, which
        // the extension answers from the cursor's CURRENT position.
        state.highlight = null;
        for (const box of document.querySelectorAll('.hl')) box.remove();
        // Same argument for the label chips: every anchor was measured against
        // the render that has just been replaced.
        state.labels = null;
        state.labelsAsked = null;
        for (const c of document.querySelectorAll('.lbc')) c.remove();
        el('where').textContent = '';

        if (samePagination) {
            // Repaint what is actually in view first, then the rest of what
            // had been rendered, so the visible part updates soonest.
            const vis = visiblePages();
            await Promise.all(vis.map(renderPage));
            restoreAnchor(anchor);
            omark('visible');
            // Awaited so the rest of the repaint can be timed too. These pages
            // are off screen, so waiting for them costs the reader nothing.
            await Promise.all(wasRendered.filter(n => !vis.includes(n)).map(renderPage));
            omark('offscreen');
            if (state.highlight) paintHighlight();
            if (state.selection) paintSelection(state.selection);
        else if (state.selShape) paintSelectionActions();
        } else {
            // A RECOMPILE MUST NOT SEND THE READER BACK TO PAGE ONE.
            //
            // `samePagination` is only true for a LIVE rebuild, so every
            // compile-on-save fell through to `renderAround(1)` and threw the
            // scroll position away — you saved, and the paper jumped to the
            // top. The anchor is a (page, fraction), which is exactly the form
            // that survives the document growing or shrinking, so it is worth
            // restoring whenever the page it names still exists.
            await placeholders;
            const keep = anchor && anchor.page >= 1 && anchor.page <= state.pageCount
                ? anchor : null;
            if (keep) {
                renderAround(keep.page);
                restoreAnchor(keep);
            } else if (msg.revealPage) {
                goToPage(msg.revealPage, msg.revealRects);
            } else {
                renderAround(1);
            }
        }
        if (prev) { try { await prev.destroy(); } catch (_) { /* already gone */ } }
        omark('total');
        // What this ONE open cost — the number that says whether a live
        // rebuild is quick, and which phase to blame when it is not.
        vscode.postMessage({
            type: 'timing', kind: 'open', generation: msg.generation,
            live: !!msg.live, pages: state.pageCount,
            bytes: msg.pdfBase64 ? msg.pdfBase64.length : 0,
            marks: openMarks,
        });
        // Now that the pages are the new ones, ask for the highlight again.
        vscode.postMessage({ type: 'opened', generation: msg.generation });
        // …and hand over the glyphs, so the extension can align them against
        // the source. Deliberately not awaited: it is not on any critical path.
        sendTextLayer(msg.generation).catch(() => { /* the old path still works */ });

        // Report where the time went, once, on the first document.
        if (!state.reportedTiming) {
            state.reportedTiming = true;
            const waitFirst = async () => {
                for (let i = 0; i < 600; i++) {
                    if (pagesEl().querySelector('.page canvas')) return;
                    await new Promise(r => setTimeout(r, 25));
                }
            };
            await waitFirst();
            mark('first page painted');
            vscode.postMessage({ type: 'timing', marks, worker: state.workerHow });
        }
    } catch (e) {
        status(`could not open the PDF: ${e && e.message ? e.message : e}`, 'err');
    }
}

/** Pages currently intersecting the scroll viewport, top first. */
function visiblePages() {
    const main = document.querySelector('main');
    if (!main) return [];
    const top = main.scrollTop; const bot = top + main.clientHeight;
    const out = [];
    for (const w of pagesEl().children) {
        if (w.offsetTop + w.offsetHeight >= top && w.offsetTop <= bot) out.push(Number(w.dataset.page));
    }
    return out;
}

/**
 * Where the reader is, as a PAGE and a fraction down it.
 *
 * A raw scrollTop is the wrong thing to restore: a recompile can change page
 * heights, and one extra line early in the paper shifts every pixel offset
 * after it. A page plus a fraction survives that.
 */
function scrollAnchor() {
    const main = document.querySelector('main');
    if (!main) return null;
    const top = main.scrollTop;
    for (const w of pagesEl().children) {
        if (w.offsetTop + w.offsetHeight > top) {
            return { page: Number(w.dataset.page), frac: (top - w.offsetTop) / Math.max(1, w.offsetHeight) };
        }
    }
    return null;
}

function restoreAnchor(a) {
    if (!a) return;
    const main = document.querySelector('main');
    const w = pagesEl().querySelector(`.page[data-page="${a.page}"]`);
    if (!main || !w) return;
    main.scrollTop = w.offsetTop + a.frac * w.offsetHeight;
}

/**
 * One placeholder per page, sized correctly up front so the scrollbar is
 * honest and lazy rendering does not make the document jump under the reader.
 */
function buildPagePlaceholders() {
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= state.pageCount; n++) {
        const wrap = document.createElement('div');
        wrap.className = 'page';
        wrap.dataset.page = String(n);
        const num = document.createElement('div');
        num.className = 'pagenum';
        num.textContent = String(n);
        wrap.appendChild(num);
        frag.appendChild(wrap);
    }
    pagesEl().appendChild(frag);
    // Size them from page 1's aspect; TeX papers are uniform. RETURNED, because
    // restoring the reading position needs real heights — against unsized
    // placeholders every page is 0 tall and the restore lands at the top.
    return state.doc.getPage(1).then((p) => {
        const vp = p.getViewport({ scale: state.scale });
        for (const w of pagesEl().children) {
            w.style.width = `${Math.floor(vp.width)}px`;
            w.style.height = `${Math.floor(vp.height)}px`;
        }
    });
}

let observer = null;
function observeVisible() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
            const n = Number(e.target.dataset.page);
            if (e.isIntersecting) renderPage(n);
        }
    }, { root: document.querySelector('main'), rootMargin: '400px 0px' });
    for (const w of pagesEl().children) observer.observe(w);
}

async function renderPage(n) {
    if (state.rendered.has(n) || state.pending.has(n)) return;
    const wrap = pagesEl().querySelector(`.page[data-page="${n}"]`);
    if (!wrap) return;
    const job = (async () => {
        const page = await state.doc.getPage(n);
        const vp = page.getViewport({ scale: state.scale });
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

        wrap.style.width = `${Math.floor(vp.width)}px`;
        wrap.style.height = `${Math.floor(vp.height)}px`;
        // SWAP, DON'T CLEAR-THEN-DRAW. During a live recompile the previous
        // page is already on screen; removing it first and painting the new
        // one a few hundred milliseconds later is a white flash on every
        // pause in typing. Rendering into a detached canvas and replacing the
        // old one in a single operation means the reader never sees a gap.
        const old = wrap.querySelector('canvas');
        if (old) wrap.replaceChild(canvas, old);
        else wrap.appendChild(canvas);
        // `page.view` is the CropBox-aware box; the MediaBox is the wrong frame.
        state.rendered.set(n, { canvas, viewport: vp, view: page.view, rotate: page.rotate });
        if (state.highlight && state.highlight.page === n) paintHighlight();
        if (state.selection) paintSelection(state.selection);
        if (state.diff) paintDiff();
        if (state.labels && labelsVisible()) paintLabels().catch(() => {});
        if (state.moveCaret) paintMoveCaret(state.moveCaret);
        if (state.edit) paintEditCard();
    })().finally(() => state.pending.delete(n));
    state.pending.set(n, job);
    return job;
}

function renderAround(n) {
    for (let i = Math.max(1, n - 1); i <= Math.min(state.pageCount, n + 1); i++) renderPage(i);
}

// --- coordinates -------------------------------------------------------------
// The maths lives in tex-viewer-geom.mjs so the SAME functions can be tested in
// node against an independently-verified reference. Spike C's lesson: a
// round-trip test cannot catch a mirrored map, so correctness needs a referee,
// and a referee needs the code to be importable outside the browser.

import {
    bpToViewport, viewportToBp, bpRectToViewport,
} from './tex-viewer-geom.mjs';

function toViewport(n, xBp, yTopBp) {
    const r = state.rendered.get(n);
    return r ? bpToViewport(r.view, r.viewport, xBp, yTopBp) : null;
}

function fromViewport(n, vx, vy) {
    const r = state.rendered.get(n);
    return r ? viewportToBp(r.view, r.viewport, vx, vy) : null;
}

function rectToViewport(n, rect) {
    const r = state.rendered.get(n);
    return r ? bpRectToViewport(r.view, r.viewport, rect) : null;
}

// --- text layer ---------------------------------------------------------------
// SyncTeX knows the LINE and not the column. The PDF's own text layer knows the
// WORDS and where they are — Spike C measured pdf.js's items against poppler at
// median x-IoU 1.000 with 97.9-98.7% coverage — so the two together give a
// column. This is what makes prose as precise as an equation in both
// directions.

const textCache = new Map();          // page -> [{str, rect}]

/** m1 * m2, the 6-element PDF matrix product. Avoids depending on pdfjs.Util. */
function mul(m1, m2) {
    return [
        m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
}

async function textItems(n) {
    if (textCache.has(n)) return textCache.get(n);
    const r = state.rendered.get(n);
    if (!r) return [];
    const page = await state.doc.getPage(n);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
        if (!it.str || !it.str.trim() || !it.transform) continue;
        const t = mul(r.viewport.transform, it.transform);
        // t[4],t[5] is the baseline-left corner in viewport pixels; the font
        // height comes out of the matrix rather than from item.height, which
        // is 0 for many items.
        const fh = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
        const w = (it.width || 0) * (r.viewport.scale || 1);
        items.push({ str: it.str, x: t[4], y: t[5] - fh, w, h: fh, baseline: t[5] });
    }
    textCache.set(n, items);
    return items;
}

// --- glyph folding & keys ----------------------------------------------------
// A LITERAL COPY of the folding in tex/texWords.js — the webview cannot
// require() the extension module. Keep the two in sync. The PDF reports − ′ 𝒬
// where the source has - ' Q; folding both sides onto one representative is
// what lets a click on an operator meet its source.
const FOLD_ONE = {
    '−': '-', '′': "'", '″': '"', '‘': "'", '’': "'", '“': '"', '”': '"',
    '⋅': '·', '∙': '·', '⁄': '/', '∕': '/',
    'ℂ': 'C', 'ℍ': 'H', 'ℕ': 'N', 'ℙ': 'P', 'ℚ': 'Q', 'ℝ': 'R', 'ℤ': 'Z',
    'ℬ': 'B', 'ℰ': 'E', 'ℱ': 'F', 'ℋ': 'H', 'ℐ': 'I', 'ℒ': 'L', 'ℳ': 'M',
    'ℛ': 'R', 'ℭ': 'C', 'ℌ': 'H', 'ℑ': 'I', 'ℜ': 'R', 'ℨ': 'Z',
    'ℊ': 'g', 'ℯ': 'e', 'ℴ': 'o', 'ı': 'i', 'ȷ': 'j',
};
const MATH_GREEK = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ';
function foldMathAlnum(cp) {
    if (cp < 0x1D400 || cp > 0x1D7FF) return null;
    if (cp <= 0x1D6A3) {
        const k = (cp - 0x1D400) % 52;
        return String.fromCharCode(k < 26 ? 65 + k : 97 + (k - 26));
    }
    if (cp <= 0x1D6A5) return cp === 0x1D6A4 ? 'i' : 'j';
    if (cp >= 0x1D7CE) return String.fromCharCode(48 + (cp - 0x1D7CE) % 10);
    if (cp >= 0x1D6A8 && cp <= 0x1D7CB) return MATH_GREEK[(cp - 0x1D6A8) % 58] || null;
    return null;
}
function foldGlyphs(s) {
    let out = '';
    for (const ch of String(s || '')) out += FOLD_ONE[ch] || foldMathAlnum(ch.codePointAt(0)) || ch;
    return out;
}

// Case-folding is right for prose but WRONG for symbols: Ψ and ψ are different
// letters, and the old lowercase-everything key let a click on one select the
// other. This mirrors texWords.norm() exactly.
/**
 * The whole document's text layer, in the EXTENSION's frame, posted once per
 * generation.
 *
 * WHY THE EXTENSION WANTS THIS. Only the webview can read the PDF's glyphs, and
 * only the extension has the source. Resolution used to happen on whichever
 * side held half the answer, which is why it could only ever match a glyph by
 * NAME inside a single source line — and measured on a real paper that resolved
 * 8.8% of the glyphs in display equations. Handing the glyphs over lets the
 * extension align a whole object's rendered sequence against its projected
 * source sequence, which measured 72.5% on the same paper.
 *
 * Reported in bp with y down from the page box's top — RenderMap's frame — so
 * neither side has to convert, and there is one convention to get wrong instead
 * of two. Done page by page off the critical path: a click that arrives before
 * the layer does simply uses the older per-line resolution.
 */
async function sendTextLayer(generation) {
    if (!state.doc || state.textLayerSent === generation) return;
    state.textLayerSent = generation;
    const tSweep = now();
    for (let n = 1; n <= state.pageCount; n++) {
        if (state.generation !== generation) return;      // a newer compile landed
        let items = [];
        try {
            const page = await state.doc.getPage(n);
            // Scale 1 so viewport units ARE points; `page.view` carries the
            // CropBox offset that separates the two frames.
            const vp = page.getViewport({ scale: 1 });
            const tc = await page.getTextContent();
            for (const it of tc.items) {
                if (!it.str || !it.str.trim() || !it.transform) continue;
                const t = mul(vp.transform, it.transform);
                const fh = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
                // t[4],t[5] is the baseline-left corner in viewport units at
                // scale 1; subtracting the box origin puts it in bp.
                // At scale 1 and rotation 0 pdf.js's own viewport transform is
                // [1,0,0,-1,-x0,y1] — the CropBox origin and the y flip are
                // already in it — so t[4],t[5] ARE the extension's bp frame and
                // nothing further needs converting.
                items.push({
                    str: it.str,
                    x: +t[4].toFixed(3),
                    baseline: +t[5].toFixed(3),
                    y: +(t[5] - fh).toFixed(3),
                    w: +(it.width || 0).toFixed(3),
                    h: +fh.toFixed(3),
                    // The FONT matters as much as the character: TeX's
                    // math-extension font reports its big operators as the
                    // ASCII letter of their slot (the sum as "X"), so the
                    // extension needs to know which font said so.
                    font: it.fontName,
                });
            }
        } catch (_) { items = []; }
        vscode.postMessage({ type: 'textLayer', generation, page: n, items });
        // Yield between pages so a 40-page paper cannot stall the first paint.
        await new Promise(r => setTimeout(r, 0));
    }
    vscode.postMessage({
        type: 'textLayerDone', generation, pages: state.pageCount,
        ms: Math.round(now() - tSweep),
    });
}

const wordKey = (s) => {
    const raw = foldGlyphs(String(s || '').trim());
    if (!raw) return '';
    const t = /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;
    const stripped = t.replace(/[^\p{L}\p{N}]/gu, '');
    return stripped || t;
};

// --- where inside an item a substring actually sits --------------------------
// Dividing the item's width evenly by character count assumes every glyph is
// the same width. In a proportional face they are not: an "i" is about a third
// of an "m", so by the end of a long item the estimate has drifted — which is
// exactly what made a highlight near the end of a line sit to the LEFT of the
// word it named.
//
// Measuring with the browser's own text metrics fixes the RATIOS. The absolute
// widths are still wrong, because the page's real font is not the one being
// measured with, so the whole run is rescaled to the width pdf.js reports. That
// keeps the item's two ends exact and distributes the interior honestly.
const measureCtx = (() => {
    try { return document.createElement('canvas').getContext('2d'); } catch (_) { return null; }
})();
const prefixCache = new WeakMap();

function prefixWidths(it) {
    let p = prefixCache.get(it);
    if (p) return p;
    const n = it.str.length;
    p = new Float64Array(n + 1);
    let ok = false;
    if (measureCtx && it.h > 0) {
        // A serif face: this corpus is Computer Modern, and the point is the
        // ratios between glyphs, which any serif gets far closer than uniform.
        measureCtx.font = `${it.h}px serif`;
        let acc = 0;
        for (let i = 0; i < n; i++) {
            acc += measureCtx.measureText(it.str[i]).width;
            p[i + 1] = acc;
        }
        if (acc > 0) {
            const k = it.w / acc;               // rescale so the ends are exact
            for (let i = 0; i <= n; i++) p[i] *= k;
            ok = true;
        }
    }
    if (!ok) {
        const per = it.w / Math.max(1, n);
        for (let i = 0; i <= n; i++) p[i] = i * per;
    }
    prefixCache.set(it, p);
    return p;
}

/** Split an item into words with their approximate x extents. */
/**
 * @param {boolean} glyphs  Split into SINGLE CHARACTERS instead of words.
 *   Maths has no words: \frac{a}{b} prints `a` and `b`, and asking for "the
 *   word under the pointer" in an equation returns a whole run like `ab`. One
 *   glyph is the addressable unit there, and it is what lets a click on the
 *   numerator land inside the first brace rather than on the equation.
 */
function itemWords(it, glyphs) {
    const out = [];
    // The glyph class is a LITERAL COPY of MATH_GLYPH_RE in tex/texWords.js —
    // letters, digits, and the operators TeX prints (≤ ↑ ∫ = + − → are all
    // category Sm, which the old letters-and-digits class silently excluded,
    // sending every operator click to the nearest letter instead).
    const re = glyphs ? /[-,.\p{L}\p{N}\p{Sm}\p{Sk}·⋅†‡′″‖§¶°√⟨⟩⌈⌉⌊⌋()[\]/]/gu
        : /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
    const p = prefixWidths(it);
    let m;
    while ((m = re.exec(it.str)) !== null) {
        const a = p[m.index];
        const b = p[m.index + m[0].length];
        out.push({ word: m[0], x: it.x + a, w: Math.max(1, b - a), y: it.y, h: it.h });
    }
    return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** The word nearest a click, and how far along its row it sits. */
async function wordAtPoint(n, vx, vy, glyphs) {
    const items = await textItems(n);
    if (!items.length) return null;
    // Rows first: the item whose vertical band contains the click.
    const onRow = items.filter(it => vy >= it.y - 2 && vy <= it.y + it.h + 2);
    const pool = onRow.length ? onRow : items;
    let best = null; let bestD = Infinity;
    for (const it of pool) {
        for (const w of itemWords(it, glyphs)) {
            // Distance to the RECT, not the centre: a centre metric penalises
            // wide words, so a click near the end of a long word could lose to
            // the short word beside it.
            const dx = vx < w.x ? w.x - vx : (vx > w.x + w.w ? vx - (w.x + w.w) : 0);
            const dy = vy < w.y ? w.y - vy : (vy > w.y + w.h ? vy - (w.y + w.h) : 0);
            const d = onRow.length ? dx : Math.hypot(dx, dy);
            if (d < bestD) { bestD = d; best = w; }
        }
    }
    if (!best) return null;
    // A click in blank space is NOT a click on the nearest thing three words
    // away — claiming one silently moved the cursor somewhere surprising. So a
    // word beyond arm's length is reported as FAR rather than as a hit, and the
    // extension uses it only where its alternative was the whole line.
    //
    // That alternative is what made "a bit to the right of the last word"
    // select the entire line, which is never what a click means. The reach is
    // generous — a couple of words — because past that there really is nothing
    // to point at.
    const far = bestD > Math.max(18, (best.h || 10) * 2.5);
    if (far && bestD > Math.max(120, (best.h || 10) * 10)) return null;
    // How far along the printed row the word sits, for tie-breaking a word
    // that occurs several times in one source line.
    const rowItems = pool.filter(it => Math.abs(it.y - best.y) < best.h * 0.6);
    const lo = Math.min(...rowItems.map(it => it.x));
    const hi = Math.max(...rowItems.map(it => it.x + it.w));
    // WHICH occurrence along the row: the n-th same-keyed word left to right.
    // The extension uses this to pick among repeats exactly, instead of
    // comparing a rendered fraction against a macro-skewed source fraction.
    const key = wordKey(best.word);
    let occurrence = 0;
    for (const it of rowItems) {
        for (const w of itemWords(it, glyphs)) {
            if (wordKey(w.word) === key && w.x <= best.x + 0.01) occurrence++;
        }
    }

    // ...AND THE SAME QUESTION ASKED IN A FORM THE EXTENSION CAN ANSWER BETTER.
    //
    // Counting along the printed row is only right when the row and the source
    // line hold the same words, and they routinely do not: TeX fills a row from
    // as many source lines as it needs, so a row often carries the tail of one
    // line and the head of the next. Counted along the row, the second "the" of
    // a sentence could be the FIRST one on its source line — which is exactly
    // the reported bug, two identical words on a line and the wrong one chosen.
    //
    // Only the extension knows where this source line's ink actually sits (it
    // has the SyncTeX rows), so ship it the positions and let it do the
    // counting: every same-keyed word near this row, in page bp, plus which of
    // them was clicked. A window of a few rows covers a wrapped source line
    // without shipping the whole page.
    const spots = [];
    let at = null;
    const near = best.h > 0 ? best.h * 5 : 60;
    for (const it of items) {
        if (Math.abs(it.y - best.y) > near) continue;
        for (const w of itemWords(it, glyphs)) {
            if (wordKey(w.word) !== key) continue;
            const c = fromViewport(n, w.x + w.w / 2, w.y + w.h / 2);
            if (!c) continue;
            const spot = { page: n, x: round2(c.xBp), y: round2(c.yTopBp) };
            spots.push(spot);
            if (w.x === best.x && w.y === best.y && w.word === best.word) at = spot;
        }
    }

    // ...AND THE WORDS EITHER SIDE OF IT, WHICH IS HOW A PERSON WOULD TELL.
    //
    // Positions can only ever be as good as SyncTeX's line attribution, and
    // measured, that attribution is wrong exactly where it hurts: the first
    // word of a continuation row is filed under the line the PARAGRAPH ends on,
    // and a word straddling a row break can carry its neighbour's line number.
    // The printed neighbours have no such problem — they are what the page
    // says — and `kernel` between `the` and `section` is a different `kernel`
    // from the one between `the` and `again`. Reading order, so the context
    // crosses row breaks the way the sentence does.
    const context = readingContext(items, best, glyphs, 4);

    return {
        word: best.word, rect: best, occurrence: Math.max(1, occurrence),
        rowFraction: hi > lo ? (best.x - lo) / (hi - lo) : 0.5,
        spots: at ? spots : [], at, context, far,
    };
}

/**
 * The `count` printed words either side of `best`, in reading order.
 *
 * Rows are recovered by clustering baselines rather than by exact equality: a
 * subscript or a size change puts a word a point or two off its neighbours'
 * baseline, and treating that as its own row would scramble the order.
 */
function readingContext(items, best, glyphs, count) {
    const all = [];
    for (const it of items || []) for (const w of itemWords(it, glyphs)) all.push(w);
    if (!all.length) return null;
    // Cluster into rows FIRST, then order within each. Comparing baselines
    // inside the comparator itself is not a total order — "close enough to be
    // equal" is not transitive — and an intransitive comparator scrambles the
    // sequence this whole idea depends on.
    const band = Math.max(2, (best.h || 10) * 0.6);
    all.sort((a, b) => a.y - b.y || a.x - b.x);
    let row = 0; let refY = all[0].y;
    for (const w of all) {
        if (w.y - refY > band) { row++; refY = w.y; }
        w.row = row;
    }
    all.sort((a, b) => a.row - b.row || a.x - b.x);
    let me = -1;
    for (let i = 0; i < all.length; i++) {
        if (all[i].x === best.x && all[i].y === best.y && all[i].word === best.word) { me = i; break; }
    }
    if (me < 0) return null;
    return {
        before: all.slice(Math.max(0, me - count), me).map(w => w.word),
        after: all.slice(me + 1, me + 1 + count).map(w => w.word),
    };
}

/** Find a source word among the rows a source line produced. */
async function wordInRows(rows, word, occurrence, glyphs) {
    const target = wordKey(word);
    if (!target || !rows.length) return null;
    const hits = [];
    for (const row of rows) {
        const items = await textItems(row.page);
        const v = rectToViewport(row.page, row);
        if (!v) continue;
        for (const it of items) {
            // Only items sitting on this row's band.
            if (it.y + it.h < v.y - 1 || it.y > v.y + v.h + 1) continue;
            if (it.x + it.w < v.x - 2 || it.x > v.x + v.w + 2) continue;
            for (const w of itemWords(it, glyphs)) {
                if (wordKey(w.word) !== target) continue;
                // AND ONLY THE WORDS INSIDE IT. The row rect is this SOURCE
                // LINE's own ink; a pdf.js text item is a run of characters and
                // can straddle the join between two source lines. Filtering
                // whole items therefore let the neighbouring line's words into
                // the count, and the n-th occurrence came out as somebody
                // else's word.
                const cx = w.x + w.w / 2;
                if (cx < v.x - 2 || cx > v.x + v.w + 2) continue;
                hits.push({ page: row.page, ...w });
            }
        }
    }
    if (!hits.length) return null;
    const hit = hits[Math.min(Math.max(1, occurrence || 1), hits.length) - 1];
    return snapToInk(hit) || hit;
}

/**
 * Pull a computed word rect onto the ink it is supposed to be over.
 *
 * Everything up to here is an ESTIMATE: pdf.js reports one width for a whole
 * run of text, and where a particular word sits inside that run is inferred.
 * Measuring glyph ratios narrows the error but does not remove it, and near the
 * end of a long line what is left is still visible as a highlight sitting
 * beside its word rather than on it.
 *
 * The rendered page is the ground truth and it is already in a canvas. Reading
 * the ink columns across the word's own row turns the estimate into the actual
 * extent of the marks — snapping to the run of ink the estimate overlaps most,
 * with words separated by the blank columns of their spaces.
 *
 * Refuses rather than guesses: no canvas, no ink, or a run more than twice the
 * expected width (a maths run with no spaces in it) leaves the estimate alone.
 */
function snapToInk(hit) {
    const r = state.rendered.get(hit.page);
    if (!r || !r.canvas || !(hit.w > 0) || !(hit.h > 0)) return null;
    const cv = r.canvas;
    const dpr = cv.width / Math.max(1, parseFloat(cv.style.width));
    // Look a word-width either side: enough to find the true position, not so
    // much that a different word can win.
    const pad = Math.min(hit.w * 1.2, 120);
    const x0 = Math.max(0, Math.round((hit.x - pad) * dpr));
    const x1 = Math.min(cv.width, Math.round((hit.x + hit.w + pad) * dpr));
    const y0 = Math.max(0, Math.round((hit.y + hit.h * 0.15) * dpr));
    const y1 = Math.min(cv.height, Math.round((hit.y + hit.h * 0.95) * dpr));
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;

    let data;
    try {
        data = cv.getContext('2d', { willReadFrequently: true })
            .getImageData(x0, y0, x1 - x0, y1 - y0).data;
    } catch (_) { return null; }

    const cols = x1 - x0; const rowsN = y1 - y0;
    const inked = new Uint8Array(cols);
    for (let y = 0; y < rowsN; y++) {
        const base = y * cols * 4;
        for (let x = 0; x < cols; x++) if (data[base + x * 4] < 140) inked[x] = 1;
    }
    // A gap only separates words if it is wide enough to be a space.
    const gap = Math.max(2, Math.round(hit.h * 0.22 * dpr));
    const runs = [];
    let start = -1; let blank = 0;
    for (let x = 0; x <= cols; x++) {
        if (x < cols && inked[x]) {
            if (start < 0) start = x;
            blank = 0;
        } else if (start >= 0) {
            blank++;
            if (blank > gap || x === cols) { runs.push([start, x - blank + 1]); start = -1; blank = 0; }
        }
    }
    if (!runs.length) return null;

    const wantA = (hit.x * dpr) - x0; const wantB = ((hit.x + hit.w) * dpr) - x0;
    let best = null; let bestOv = 0;
    for (const [a, b] of runs) {
        const ov = Math.min(b, wantB) - Math.max(a, wantA);
        if (ov > bestOv) { bestOv = ov; best = [a, b]; }
    }
    if (!best || bestOv <= 0) return null;
    const w = (best[1] - best[0]) / dpr;
    if (w > hit.w * 2.2 || w < hit.w * 0.3) return null;   // not our word
    return { ...hit, x: x0 / dpr + best[0] / dpr, w };
}

// --- highlight ---------------------------------------------------------------

// --- the comparison overlay --------------------------------------------------
//
// SEPARATE FROM THE HIGHLIGHT, ON PURPOSE. `paintHighlight` owns `.hl` and
// removes every one of them on each cursor move; a diff sharing that class
// would be erased by the next keystroke. These are `.dh`, they persist until
// the comparison is closed, and there are many at once.

function paintDiff() {
    for (const el of document.querySelectorAll('.dh')) el.remove();
    const d = state.diff;
    if (!d || !d.hunks) return;
    for (const h of d.hunks) {
        for (const rect of (h.rects || [])) {
            const wrap = pagesEl().querySelector(`.page[data-page="${rect.page}"]`);
            if (!wrap || !state.rendered.has(rect.page)) continue;
            const v = rectToViewport(rect.page, rect);
            if (!v) continue;
            const el = document.createElement('div');
            // The KIND says what happened; the CONFIDENCE says how well we know
            // where. A caret is never widened into a wash — it marks a seam
            // where inserted text would go, and it covers nothing.
            el.className = `dh dh-${h.kind} dh-${h.where}` +
                (h.id === d.focus ? ' dh-focus' : '');
            el.style.left = `${v.x}px`;
            el.style.top = `${v.y}px`;
            el.style.width = `${rect.caret ? 0 : v.w}px`;
            el.style.height = `${rect.caret ? 0 : v.h}px`;
            el.title = (h.name ? `${h.name} — ` : '') +
                `${h.kind}${h.why ? ` (${h.why})` : ''}`;
            el.dataset.hunk = h.id;
            wrap.appendChild(el);
        }
    }
}

// --- THE LABEL OVERLAY -------------------------------------------------------
//
// Hold Shift: every \label appears beside the thing it names, every \ref and
// \cite beside the label it points at. Click one and the reference is on the
// clipboard.
//
// A SEPARATE CLASS FROM BOTH `.hl` AND `.dh`, for the reason `.dh` exists:
// `paintHighlight` removes every `.hl` on each cursor move, so chips sharing it
// would be wiped by the next keystroke — and a reader holding Shift while the
// cursor moves is the ordinary case, not an edge one.
//
// The chips are the one overlay that TAKES THE POINTER. Everything else here is
// `pointer-events:none`; a chip has to be clickable, and because Shift-click on
// the page already means "pick the end of a selection", the click must be
// stopped in the CAPTURE phase or it starts a selection on the way past.

function labelsVisible() { return !!(state.labelsOn || state.labelsPinned); }

/**
 * WHERE A REFERENCE'S BADGE BELONGS: on the number it printed.
 *
 * Reported: "next to (6) should be the badge — but it is miles away". A
 * reference prints its number inside the prose, and the extension's own copy of
 * the text layer is a generation behind whenever the page sweep has not
 * finished, so it fell back to the end of the line. The PANEL always has the
 * real text layer, so the search happens here.
 */
async function inkMatching(find, page) {
    if (!find || !find.text) return null;
    const want = String(find.text).replace(/[()[\]\s]/g, '');
    if (!want) return null;
    let items = [];
    try { items = await textItems(page); } catch (_) { return null; }
    if (!items.length) return null;
    const rects = (find.rects || []).filter(r => r.page === page)
        .map(r => rectToViewport(page, r)).filter(Boolean);
    if (!rects.length) return null;
    const inside = (it) => rects.some(v =>
        it.y + it.h > v.y - 2 && it.y < v.y + v.h + 2 &&
        it.x + it.w > v.x - 40 && it.x < v.x + v.w + 40);

    // A BARE NUMBER MATCHES ANY STRAY DIGIT ON THE LINE.
    //
    // The `.aux` records `\ref` numbers without their parentheses — `2`, not
    // `(2)` — and a line of physics is full of loose 2s. Reported: the badge
    // for `\eqref{eq:arrow-switch}` landed in the middle of a sentence, on a
    // digit inside the maths, while its own `(2)` sat at the end of the line.
    //
    // What an `\eqref` actually prints is the number IN PARENTHESES, so a
    // candidate flanked by them is the one — and pdf.js may report `(2)` as one
    // item or as three, so both shapes are scored rather than one being
    // assumed.
    const cands = [];
    for (const it of items) {
        if (!it.str) continue;
        const t = String(it.str).replace(/[()[\]\s]/g, '');
        if (t !== want) continue;
        if (!inside(it)) continue;
        let score = 0;
        if (/^[([]/.test(String(it.str)) && /[)\]]$/.test(String(it.str))) score += 3;
        else {
            const near = (other, side) => items.some(o => o !== it &&
                Math.abs(o.y - it.y) < 3 &&
                (side === 'left'
                    ? Math.abs((o.x + o.w) - it.x) < 4
                    : Math.abs(o.x - (it.x + it.w)) < 4) &&
                other.test(String(o.str)));
            if (near(/[([]\s*$/, 'left')) score += 2;
            if (near(/^\s*[)\]]/, 'right')) score += 1;
        }
        cands.push({ it, score });
    }
    if (!cands.length) return null;
    if (find.parens) {
        const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
        // A reference is printed in parentheses; a candidate with none is very
        // likely a digit that happens to be the same number.
        if (best.score > 0) return best.it;
        return null;
    }
    return cands[0].it;
}

async function paintLabels() {
    for (const el of document.querySelectorAll('.lbc')) el.remove();
    hideChipPreview();
    if (!labelsVisible() || !state.labels || !state.labels.items) return;

    const byPage = new Map();
    for (const c of state.labels.items) {
        const p = c.at && c.at.page;
        if (!p) continue;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p).push(c);
    }
    const pending = [];
    for (const [page, chips] of byPage) {
        const wrap = pagesEl().querySelector(`.page[data-page="${page}"]`);
        if (!wrap || !state.rendered.has(page)) continue;
        const made = [];
        for (const c of chips) {
            const v = rectToViewport(page, { ...c.at, w: c.at.w || 1, h: c.at.h || 8 });
            if (!v) continue;
            const el = document.createElement('div');
            el.className = `lbc lbc-${c.role}${c.approx ? ' lbc-approx' : ''}` +
                (c.broken ? ' lbc-broken' : '');
            // A DECLARATION AND A REFERENCE ARE DIFFERENT CLAIMS, so they read
            // differently: a label states what a thing is CALLED, a reference
            // points AT one. Same information, opposite direction, and telling
            // them apart at a glance is the whole reason for the overlay.
            el.textContent = c.role === 'decl'
                ? (c.printed ? `${c.name} ${c.printed}` : c.name)
                : `→ ${c.name}`;
            el.title = c.broken
                ? `${c.name} — no \\label with that name`
                : 'Click to copy the reference · Alt-click for the bare name';
            el.dataset.name = c.name;
            el.dataset.role = c.role;
            el.dataset.kind = c.kind;
            if (c.cmd) el.dataset.cmd = c.cmd;
            el.style.left = `${v.x}px`;
            el.style.top = `${v.y}px`;
            // A chip anchored in the LEFT margin grows leftwards, or it covers
            // the heading it belongs to — and a chip anchored ABOVE a block
            // must sit ON TOP of that point rather than hang down from it.
            // Without the Y half, a label placed 10 bp above an equation still
            // covered its first row: the anchor is where the chip's BOTTOM
            // belongs, not its top. Reported as labels sitting inside the
            // equations they name.
            const dx = c.side === 'left' ? '-100%' : '0';
            const dy = c.role === 'decl' && c.kind !== 'section' ? '-100%' : '0';
            if (dx !== '0' || dy !== '0') el.style.transform = `translate(${dx}, ${dy})`;
            wrap.appendChild(el);
            made.push(el);
            if (c.find) pending.push({ el, chip: c, page });
            if (c.target && c.target.length) {
                el.addEventListener('mouseenter', () => showChipPreview(c, el));
                el.addEventListener('mouseleave', hideChipPreview);
            }
        }
        deoverlap(made);
    }

    // The references, moved onto the numbers they printed. Done after the
    // first paint so the badges appear at once and then settle, rather than
    // waiting on a text-layer sweep before anything is shown at all.
    for (const { el, chip, page } of pending) {
        // eslint-disable-next-line no-await-in-loop
        const hit = await inkMatching(chip.find, page);
        if (!hit || !el.isConnected) continue;
        el.style.left = `${hit.x}px`;
        el.style.top = `${Math.max(0, hit.y - el.offsetHeight - 1)}px`;
        el.style.transform = '';
        el.classList.remove('lbc-approx');
    }
}

/**
 * Nudge chips off each other, and DROP the ones that still collide.
 *
 * A methods page can carry thirty of these. Pushing one down until it fits
 * would eventually place it beside something it does not belong to, which is
 * worse than not drawing it: a label is an assertion about what a thing is
 * called, and a misplaced one is a wrong answer rather than a missing one.
 */
function deoverlap(els) {
    const placed = [];
    const boxOf = (e) => ({
        x: e.offsetLeft, y: e.offsetTop,
        w: e.offsetWidth, h: e.offsetHeight, el: e,
    });
    const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w &&
        a.y < b.y + b.h && b.y < a.y + a.h;
    const sorted = els.slice().sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft);
    for (const el of sorted) {
        let box = boxOf(el);
        let steps = 0;
        while (steps < 3 && placed.some(p => hits(box, p))) {
            const clash = placed.find(p => hits(box, p));
            const dy = clash.y + clash.h + 1 - box.y;
            el.style.top = `${el.offsetTop + dy}px`;
            box = boxOf(el);
            steps++;
        }
        if (placed.some(p => hits(box, p))) { el.remove(); continue; }
        placed.push(box);
    }
}

function showLabels() {
    if (state.labelsOn) return;
    state.labelsOn = true;
    hintLabels();
    // Ask once per generation; after that the panel already holds them and the
    // press is instant.
    if (!state.labels || state.labels.generation !== state.generation) {
        if (state.labelsAsked !== state.generation) {
            state.labelsAsked = state.generation;
            vscode.postMessage({ type: 'labelsWanted', value: true });
        }
    }
    paintLabels().catch(() => {});
}

function hideLabels() {
    if (!state.labelsOn) return;
    state.labelsOn = false;
    paintLabels().catch(() => {});
    if (state.labelHinted) { el('where').textContent = state.labelHinted.was || ''; state.labelHinted = null; }
}

/**
 * Say what the chips are for, in the bar the reader is already looking at.
 *
 * A gesture nobody is told about is a gesture nobody uses, and the copy formats
 * are the whole point of it. The previous contents of the readout are restored
 * when the chips go away, so this borrows the space rather than taking it.
 */
function hintLabels() {
    const w = el('where');
    if (!w) return;
    if (!state.labelHinted) state.labelHinted = { was: w.textContent };
    const n = state.labels && state.labels.items ? state.labels.items.length : 0;
    w.textContent = n
        ? `${n} label${n === 1 ? '' : 's'} · click to copy \\eqref{…} · ⌥-click for the name`
        : 'labels…';
}

/**
 * WHAT A BADGE POINTS AT, AS IT PRINTS.
 *
 * Hovering a label or a reference shows the thing itself — the equation, the
 * figure — clipped from the compiled page. Deliberately NO source: the editor's
 * hover is where the LaTeX belongs; on the page the reader is looking at the
 * paper and wants the paper's own answer.
 */
let previewSeq = 0;
async function showChipPreview(chip, anchor) {
    const my = ++previewSeq;
    hideChipPreview();
    if (!chip || !chip.target || !chip.target.length) return;
    const page = chip.target[0].page;
    let shot = null;
    try { shot = await cropFragment({ id: 'hover', rects: chip.target, scale: 2, pad: 4 }); }
    catch (_) { shot = null; }
    if (!shot || !shot.dataUrl || my !== previewSeq) return;
    const wrap = pagesEl().querySelector(`.page[data-page="${page}"]`);
    if (!wrap || !anchor.isConnected) return;

    const card = document.createElement('div');
    card.className = 'lbcprev';
    const img = document.createElement('img');
    img.src = shot.dataUrl;
    // Shown at the size it PRINTS, capped so a full-width display does not
    // cover the page it was called from.
    img.style.width = `${Math.min(shot.w || 200, 320)}px`;
    card.appendChild(img);
    const host = anchor.closest('.page') || wrap;
    host.appendChild(card);

    // Beside the badge, flipped when there is no room — never over it.
    const top = anchor.offsetTop + anchor.offsetHeight + 4;
    card.style.left = `${Math.max(2, Math.min(anchor.offsetLeft,
        host.clientWidth - card.offsetWidth - 2))}px`;
    card.style.top = `${top + card.offsetHeight > host.clientHeight
        ? Math.max(2, anchor.offsetTop - card.offsetHeight - 4) : top}px`;
}

function hideChipPreview() {
    for (const el of document.querySelectorAll('.lbcprev')) el.remove();
}

/** Scroll a hunk into view, minimally, and mark it as the current one. */
function focusHunk(id) {
    const d = state.diff;
    if (!d) return;
    const i = d.hunks.findIndex(h => h.id === id);
    if (i < 0) return;
    d.index = i;
    d.focus = id;
    const h = d.hunks[i];
    updateDiffChrome();
    const page = h.page || (h.rects && h.rects[0] && h.rects[0].page);
    if (!page) { paintDiff(); return; }
    renderAround(page);
    paintDiff();
    const el = document.querySelector(`.dh[data-hunk="${id}"]`);
    const main = document.querySelector('main');
    if (!main) return;
    if (el) {
        const mr = main.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        if (er.top < mr.top + 40 || er.bottom > mr.bottom - 40) {
            main.scrollTo({ top: main.scrollTop + (er.top - mr.top) - main.clientHeight * 0.35,
                behavior: 'smooth' });
        }
    } else {
        const wrap = pagesEl().querySelector(`.page[data-page="${page}"]`);
        if (wrap) main.scrollTo({ top: wrap.offsetTop - 20, behavior: 'smooth' });
    }
}

function stepHunk(delta) {
    const d = state.diff;
    if (!d || !d.hunks.length) return;
    const n = d.hunks.length;
    const i = ((d.index ?? -1) + delta + n * 2) % n;
    vscode.postMessage({ type: 'diffFocus', id: d.hunks[i].id });
    focusHunk(d.hunks[i].id);
}

function updateDiffChrome() {
    const bar = el('diffbar');
    const d = state.diff;
    if (!bar) return;
    bar.style.display = d ? 'flex' : 'none';
    document.body.classList.toggle('comparing', !!d);
    if (!d) return;
    const at = (d.index ?? -1) >= 0 ? `${d.index + 1}/${d.hunks.length}` : `${d.hunks.length}`;
    el('diffwhat').textContent = `vs ${d.label}`;
    el('diffcount').textContent = at;
    el('diffcensus').textContent = d.census || '';
}

/**
 * WHERE A DRAGGED SELECTION WOULD LAND — a blue caret.
 *
 * Blue, because amber is "where you are" and red is "what is selected"; a third
 * meaning needs a third colour or it reads as one of the other two. A block
 * lands BETWEEN lines and is drawn as a rule across the row it would push down;
 * a fragment lands at a column and is drawn as a caret.
 */
function paintMoveCaret(msg) {
    for (const el of document.querySelectorAll('.movecaret')) el.remove();
    if (!msg || !msg.rects || !msg.rects.length) return;
    for (const rect of msg.rects) {
        const wrap = pagesEl().querySelector(`.page[data-page="${rect.page}"]`);
        if (!wrap || !state.rendered.has(rect.page)) continue;
        const v = rectToViewport(rect.page, { ...rect, w: rect.w || 1, h: rect.h || 1 });
        if (!v) continue;
        const el = document.createElement('div');
        el.className = 'movecaret' + (msg.block ? ' block' : '');
        el.style.left = `${v.x}px`;
        el.style.top = `${v.y}px`;
        if (msg.block) el.style.width = `${Math.max(20, v.w)}px`;
        else el.style.height = `${Math.max(8, v.h)}px`;
        wrap.appendChild(el);
    }
}

function paintHighlight() {
    for (const box of document.querySelectorAll('.hl')) box.remove();
    const h = state.highlight;
    if (!h || !h.rects || !h.rects.length) return;
    for (const rect of h.rects) {
        const wrap = pagesEl().querySelector(`.page[data-page="${rect.page}"]`);
        if (!wrap || !state.rendered.has(rect.page)) continue;
        const v = rectToViewport(rect.page, rect);
        if (!v) continue;
        const box = document.createElement('div');
        // Re-creating the element restarts the fade animation, which is what
        // makes every cursor move paint a fresh, visible highlight.
        box.className = `hl ${h.flag || ''}${state.pinHighlight ? ' pinned' : ''}`;
        box.style.left = `${v.x}px`;
        box.style.top = `${v.y}px`;
        box.style.width = `${v.w}px`;
        box.style.height = `${v.h}px`;
        if (h.title) box.title = h.title;
        wrap.appendChild(box);
    }
}

// --- THE SELECTED FRAGMENT, MARKED THE WAY A SELECTION IS -------------------
//
// A cursor gets a wash over one word; a RANGE gets the shape a reader already
// knows: an opening mark, the rest of that line, the whole width of the lines
// between, the last line up to the closing mark, and a closing mark. The fill
// is deliberately faint — it has to sit under the type without competing with
// it — while the two brackets are solid, because they are the precise part.
//
// The ends are resolved through the same text-layer narrowing the highlight
// uses (`wordInRows`), so the marks land on the exact glyph the selection
// starts and ends at rather than at the edge of its row.

/** A mark in bp, as viewport pixels on its own page. */
function markToPx(mark) {
    if (!mark) return null;
    const v = rectToViewport(mark.page, { page: mark.page, x: mark.x, y: mark.y, w: 0.5, h: mark.h });
    // `word` travels with it: a mark the TEXT LAYER placed is trustworthy at a
    // line end, where the row's own edge is not — the row may carry the next
    // source line's words too.
    return v ? { x: v.x, y: v.y, h: v.h, word: !!mark.word } : null;
}

/**
 * The printed rows of a page, from the text layer: baselines clustered, each
 * row spanning its own ink.
 *
 * The equation NUMBER is dropped — it sits on the row but belongs to no line of
 * text, and a selection that swallows it looks like it has over-reached.
 */
function inkRows(items) {
    const rows = [];
    for (const it of (items || []).slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
        if (!it.str || !it.str.trim()) continue;
        const last = rows[rows.length - 1];
        if (last && it.y < last.y + last.h * 0.6 && it.y + it.h > last.y + last.h * 0.4) {
            last.x = Math.min(last.x, it.x);
            last.x1 = Math.max(last.x1, it.x + it.w);
            last.h = Math.max(last.h, it.h);
            last.items.push(it);
            continue;
        }
        rows.push({ x: it.x, x1: it.x + it.w, y: it.y, h: it.h, items: [it] });
    }
    for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        const n = r.items.length;
        if (n > 1) {
            const lastItem = r.items[n - 1];
            const prev = r.items[n - 2];
            const gap = lastItem.x - (prev.x + prev.w);
            if (gap > r.h * 3 && /^[([]?[0-9]+[A-Za-z.]*[)\]]?$/.test(lastItem.str.trim())) {
                r.x1 = prev.x + prev.w;
            }
        }
        r.w = r.x1 - r.x;
    }
    return rows.filter(r => r.w > 0);
}

async function paintSelection(span) {
    for (const el of document.querySelectorAll('.selfill, .selbrk, .selact')) el.remove();
    state.selection = span || null;
    // A PENDING START HAS NO ROWS BY DEFINITION — it is one end of a selection
    // that does not exist yet — so the emptiness test must not swallow it.
    if (!span) return;
    if (!span.pendingStart && !(span.rows && span.rows.length)) return;

    for (const r of (span.rows || [])) await renderPage(r.page);
    for (const r of ((span.start && span.start.rects) || [])) await renderPage(r.page);

    const edge = async (anchor, side) => {
        if (!anchor || !anchor.rects || !anchor.rects.length) return null;
        const rowEdge = () => {
            const r = anchor.rects[side === 'start' ? 0 : anchor.rects.length - 1];
            return { page: r.page, x: side === 'start' ? r.x : r.x + r.w, y: r.y, h: r.h, word: false };
        };
        // The very START of a line goes at the row's edge, not at its first
        // WORD: a heading's printed number sits to the left of its title and is
        // part of the line that was selected.
        if (side === 'start' && anchor.atLineStart) return rowEdge();
        // AND NOTHING OF A LINE IS SELECTED WHEN THE RANGE ENDS AT ITS COLUMN 0.
        //
        // The closing mark then belongs at the row's LEFT edge. Without this the
        // anchor's word is the line's FIRST word — `From` of a `\subsection` —
        // and the mark went to its right edge, so the band covered a word the
        // editor had not selected. Reported exactly that way.
        //
        // Only for a line with ink of its OWN: a blank line borrows a
        // neighbour's row, and that row's left edge is somewhere else entirely
        // — there the previous line's end is the honest answer, which is what
        // rowEdge already gives.
        if (side === 'end' && anchor.atLineStart && anchor.own) {
            const r = anchor.rects[0];
            return { page: r.page, x: r.x, y: r.y, h: r.h, word: false };
        }
        let hit = null;
        if (anchor.word) {
            try { hit = await wordInRows(anchor.rects, anchor.word, anchor.occurrence, !!anchor.glyph); }
            catch (_) { hit = null; }
        }
        if (!hit) return rowEdge();
        const a = fromViewport(hit.page, hit.x, hit.y);
        const b = fromViewport(hit.page, hit.x + hit.w, hit.y + hit.h);
        if (!(a && b)) return rowEdge();
        let x = side === 'start' ? a.xBp : b.xBp;
        if (side === 'end' && anchor.atLineEnd) {
            // THE END OF A LINE IS NOT THE END OF ITS ROW.
            //
            // A short continuation line is typeset INTO its predecessor's row —
            // on the reference paper line 90 ends with "is" and line 91's single
            // word "therefore" is printed after it — so ending at the row's edge
            // put the closing bracket a word beyond what was selected. The row
            // edge is still right when this word IS the row's last ink, where it
            // keeps the punctuation that follows it; the test is whether
            // anything else is printed to its right.
            try {
                const rows = inkRows(await textItems(hit.page));
                const mid = hit.y + hit.h / 2;
                const row = rows.find(r => mid >= r.y - 1 && mid <= r.y + r.h + 1);
                const right = row && fromViewport(hit.page, row.x + row.w, hit.y);
                if (right && right.xBp - x < (b.xBp - a.xBp) * 0.6 + 4) x = right.xBp;
            } catch (_) { /* the word's own edge is answer enough */ }
        }
        return { page: hit.page, x, y: a.yTopBp, h: b.yTopBp - a.yTopBp, word: true };
    };

    const from = await edge(span.start, 'start');
    // A SELECTION BEING PICKED HAS ONE END SO FAR. Showing a fill or a closing
    // mark before the second shift-click would claim a range that does not
    // exist yet; the single mark says "from here" and nothing more.
    const to = span.pendingStart ? null : await edge(span.end, 'end');
    if (span.pendingStart) {
        if (from) {
            const wrap = pagesEl().querySelector(`.page[data-page="${from.page}"]`);
            const v = wrap && rectToViewport(from.page, { page: from.page, x: from.x, y: from.y, w: 0.5, h: from.h });
            if (wrap && v) {
                const el = document.createElement('div');
                el.className = 'selbrk start pending';
                el.style.left = `${v.x}px`; el.style.top = `${v.y}px`;
                el.style.height = `${v.h}px`;
                wrap.appendChild(el);
            }
        }
        return;
    }
    // THE BANDS FOLLOW THE INK, NOT THE SYNCTEX ROWS.
    //
    // A row rectangle is built from SyncTeX records, and those under-cover the
    // printed row at BOTH ends: the first record of a row is often misfiled, so
    // the rectangle starts at the second word, and the last record is a POINT at
    // its word's start, so the rectangle stops before that word's ink. Measured
    // (`check-select.mjs`): the first word of a paragraph came out at 0.00
    // coverage, `coordinate-` at 0.03, and a whole last line at 0.00 — which is
    // exactly what was reported, "some bits are not covered at all".
    //
    // The page itself has no such gaps. The rows the reader sees are the rows of
    // the TEXT LAYER, so the shape is built from those: every printed row
    // between the two marks, each spanning its own ink, with the first and last
    // cut at the marks. The SyncTeX rows are still what PLACES the marks; they
    // are simply not what measures the lines.
    const startPx = markToPx(from);
    const endPx = markToPx(to) || startPx;
    if (!startPx || !endPx) return;

    const parts = [];
    const rowsSeen = [];
    for (let p = Math.min(from.page, to.page); p <= Math.max(from.page, to.page); p++) {
        const wrap = pagesEl().querySelector(`.page[data-page="${p}"]`);
        if (!wrap || !state.rendered.has(p)) continue;
        // eslint-disable-next-line no-await-in-loop
        const items = await textItems(p);
        const rows = inkRows(items);
        for (const r of rows) {
            const mid = r.y + r.h / 2;
            if (p === from.page && mid < startPx.y - 1) continue;
            if (p === to.page && mid > endPx.y + endPx.h + 1) continue;
            const isFirst = p === from.page && mid < startPx.y + startPx.h + 1;
            const isLast = p === to.page && mid > endPx.y - 1;
            // AN END THAT IS THE LINE'S OWN EDGE SNAPS TO THE INK. The row
            // rectangle cannot be trusted for it — measured, the first row of a
            // paragraph had its SyncTeX left edge 28 bp inside the first word,
            // so the band began in the middle of "These". Where the selection
            // starts at the start of a line, the answer is simply "this row".
            const x0 = (isFirst && !(span.start && span.start.atLineStart))
                ? Math.max(r.x, Math.min(startPx.x, r.x + r.w)) : r.x;
            // …and the same for the closing end, UNLESS the text layer placed
            // it: a word-resolved mark is the honest edge even at a line end,
            // and it is the only thing that stops the band from running on into
            // the next source line's word on the same row.
            const x1 = (isLast && !(span.end && span.end.atLineEnd && !endPx.word))
                ? Math.min(r.x + r.w, Math.max(endPx.x, r.x)) : r.x + r.w;
            if (x1 <= x0) continue;
            rowsSeen.push({ page: p, x: x0, y: r.y, w: x1 - x0, h: r.h });
        }
    }
    if (!rowsSeen.length) return;

    // AND THE BANDS TILE. Row boxes are the ink's own height, so consecutive
    // ones leave a pale gap between them; a selection is continuous and should
    // look it. Each band reaches down to where the next one starts, unless that
    // is more than a line and a half away — a page break, or a gap the
    // selection genuinely does not cross.
    for (let i = 0; i < rowsSeen.length; i++) {
        const b = rowsSeen[i];
        const next = rowsSeen[i + 1];
        if (next && next.page === b.page && next.y > b.y && next.y - b.y < b.h * 2.2) {
            b.h = next.y - b.y;
        }
        parts.push(b);
    }

    for (const p of parts) {
        const wrap = pagesEl().querySelector(`.page[data-page="${p.page}"]`);
        if (!wrap || !state.rendered.has(p.page) || !(p.w > 0)) continue;
        const el = document.createElement('div');
        el.className = 'selfill';
        el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
        el.style.width = `${p.w}px`; el.style.height = `${p.h}px`;
        wrap.appendChild(el);
    }

    // THE MARKS ARE THE ENDS OF THE SHAPE. Placing them from the anchors
    // separately let them disagree with the fill they bracket — the mark inside
    // the first word while the band began after it. Taking them from the
    // painted parts makes that impossible.
    const brackets = [
        { side: 'start', page: parts[0].page, x: parts[0].x, y: parts[0].y, h: parts[0].h },
        { side: 'end',
            page: parts[parts.length - 1].page,
            x: parts[parts.length - 1].x + parts[parts.length - 1].w,
            y: parts[parts.length - 1].y,
            h: parts[parts.length - 1].h },
    ];
    for (const b of brackets) {
        const wrap = pagesEl().querySelector(`.page[data-page="${b.page}"]`);
        if (!wrap || !state.rendered.has(b.page)) continue;
        const el = document.createElement('div');
        el.className = `selbrk ${b.side}`;
        el.style.left = `${b.x}px`; el.style.top = `${b.y}px`;
        el.style.height = `${b.h}px`;
        wrap.appendChild(el);
    }

    // The shape is remembered so the action bar can be re-placed after a zoom
    // or a re-render without recomputing the whole selection.
    state.selShape = parts.slice();
    paintSelectionActions();

    if (span.reveal !== false && from) {
        state.highlight = null;
        const wrap = pagesEl().querySelector(`.page[data-page="${from.page}"]`);
        const main = document.querySelector('main');
        if (wrap && main) {
            const v = rectToViewport(from.page, { page: from.page, x: from.x, y: from.y, w: 1, h: from.h });
            const top = wrap.offsetTop + (v ? v.y : 0);
            const margin = Math.min(120, main.clientHeight * 0.15);
            if (top < main.scrollTop + margin || top > main.scrollTop + main.clientHeight - margin) {
                main.scrollTo({ top: Math.max(0, top - main.clientHeight * 0.35), behavior: 'smooth' });
            }
        }
    }
}

/**
 * WHAT TO DO WITH THE THING YOU JUST SELECTED.
 *
 * A small bar of four actions — copy, cut, paste, delete — pinned to the
 * selection. It exists because the selection is now a first-class object on the
 * page: you can drag it to move it, so the other four things one does with a
 * fragment should not require going back to the editor either.
 *
 * TWO THINGS MAKE IT WORK RATHER THAN GET IN THE WAY:
 *
 * - It is placed ABOVE the selection's first band, and flips below when there
 *   is no room — never over the text it acts on.
 * - It TAKES THE POINTER, in the capture phase. A press inside a selection now
 *   picks the selection up to move it, so a press on a button that leaked
 *   through would start dragging the very fragment being copied.
 */
const ACTION_ICONS = {
    // Simple, evenly-weighted 16x16 paths on currentColor — a set that reads as
    // one family at 13 px, which emoji do not.
    copy: 'M6 2h6a2 2 0 0 1 2 2v6h-1.5V4a.5.5 0 0 0-.5-.5H6zM3.5 5h6A1.5 1.5 0 0 1 11 6.5v6A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-6A1.5 1.5 0 0 1 3.5 5m0 1.5v6h6v-6z',
    cut: 'M4.5 2 8 7.2 11.5 2h1.7L9 8.4l1 1.5a2.6 2.6 0 1 1-1.2.8L8 9.6l-.8 1.1a2.6 2.6 0 1 1-1.2-.8l1-1.5L2.8 2zM4.6 11.4a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6m6.8 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6',
    paste: 'M6.5 1.5h3a1 1 0 0 1 1 1V3h1.5A1.5 1.5 0 0 1 13.5 4.5v9A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 3h1.5v-.5a1 1 0 0 1 1-1M4 4.5v9h8v-9h-1.5v1h-5v-1zm3-1.5v1h2v-1z',
    delete: 'M6.5 1.5h3a1 1 0 0 1 1 1V3H13v1.5h-1V13a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 13V4.5H3V3h2.5v-.5a1 1 0 0 1 1-1M5.5 4.5V13h5V4.5zM7 6h1.2v5.5H7zm2 0h1.2v5.5H9z',
};
const ACTIONS = [
    { id: 'copy', title: 'Copy the LaTeX (⌘C)' },
    { id: 'cut', title: 'Cut the LaTeX (⌘X)' },
    { id: 'paste', title: 'Replace it with the clipboard (⌘V)' },
    { id: 'delete', title: 'Delete it (⌫)' },
];

function paintSelectionActions() {
    for (const el of document.querySelectorAll('.selact')) el.remove();
    const parts = state.selShape;
    if (!parts || !parts.length || !state.selection) return;
    // A half-made selection is not a fragment yet: offering to cut it would be
    // offering to cut nothing.
    if (state.selection.pendingStart) return;
    // While the hand is carrying the selection, the bar would follow it around
    // under the pointer.
    if (dragMove || dragSel) return;

    const first = parts[0];
    const wrap = pagesEl().querySelector(`.page[data-page="${first.page}"]`);
    if (!wrap || !state.rendered.has(first.page)) return;

    const bar = document.createElement('div');
    bar.className = 'selact';
    for (const a of ACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.action = a.id;
        b.title = a.title;
        b.setAttribute('aria-label', a.title);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '13');
        svg.setAttribute('height', '13');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ACTION_ICONS[a.id]);
        path.setAttribute('fill', 'currentColor');
        svg.appendChild(path);
        b.appendChild(svg);
        if (a.id === 'delete') b.classList.add('danger');
        bar.appendChild(b);
    }
    wrap.appendChild(bar);

    // Placed after appending, because its size is not known until it is in the
    // document — the same lesson the mini-editor's placement taught.
    const h = bar.offsetHeight || 24;
    const w = bar.offsetWidth || 108;
    let top = first.y - h - 6;
    if (top < 2) {                              // no room above: go below
        const last = parts[parts.length - 1];
        top = (last.page === first.page ? last.y + last.h : first.y + first.h) + 6;
    }
    const maxLeft = Math.max(2, wrap.clientWidth - w - 2);
    bar.style.left = `${Math.min(Math.max(2, first.x), maxLeft)}px`;
    bar.style.top = `${Math.max(2, top)}px`;
}

function goToPage(n, rects) {
    const wrap = pagesEl().querySelector(`.page[data-page="${n}"]`);
    if (!wrap) return;
    renderAround(n);
    wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (rects) { state.highlight = { page: n, rects, flag: 'target' }; paintHighlight(); }
}

/**
 * Follow the cursor to the highlight, across pages, without fidgeting.
 *
 * `goToPage` was the wrong tool for this: it scrolls to the TOP of the page, so
 * a highlight low on page 5 left you looking at the header, and it jerked the
 * view back on every keystroke even when the highlight was already in plain
 * sight. It also stamped flag 'target' over the honesty flag.
 *
 * So: paint first, and scroll only when the highlight is actually outside the
 * comfortable middle band of the viewport — then put it there.
 */
function revealHighlight() {
    paintHighlight();
    const h = state.highlight;
    const main = document.querySelector('main');
    if (!h || !main || !h.rects || !h.rects.length) return;
    const page = h.rects[0].page;
    renderAround(page);
    const wrap = pagesEl().querySelector(`.page[data-page="${page}"]`);
    if (!wrap) return;

    // Where the highlight sits in the scroller. Until the page is rendered
    // there is no viewport mapping, so aim at the page itself.
    const v = state.rendered.has(page) ? rectToViewport(page, h.rects[0]) : null;
    const top = wrap.offsetTop + (v ? v.y : 0);
    const height = v ? Math.max(v.h, 8) : Math.min(wrap.offsetHeight, 200);

    const seen0 = main.scrollTop;
    const seen1 = seen0 + main.clientHeight;
    const margin = Math.min(120, main.clientHeight * 0.15);
    if (top >= seen0 + margin && top + height <= seen1 - margin) return;   // already visible

    main.scrollTo({
        top: Math.max(0, top - main.clientHeight * 0.35),
        behavior: 'smooth',
    });
}

// --- interaction -------------------------------------------------------------

pagesEl().addEventListener('click', (ev) => {
    if (state.swallowClick) return;               // the tail of a shift-drag
    const wrap = ev.target.closest('.page');
    if (!wrap) return;
    const n = Number(wrap.dataset.page);
    if (!state.rendered.has(n)) return;
    const r = wrap.getBoundingClientRect();
    const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
    if (!pt) return;
    // A ring where the click landed, so it is obvious what was asked about
    // even when the jump lands somewhere surprising.
    const ping = document.createElement('div');
    ping.className = 'ping';
    ping.style.left = `${ev.clientX - r.left}px`;
    ping.style.top = `${ev.clientY - r.top}px`;
    wrap.appendChild(ping);
    setTimeout(() => ping.remove(), 700);
    sendClick(n, pt, ev.clientX - r.left, ev.clientY - r.top, {
        // WIDENING IS OPT-IN. A plain click always means "this symbol, this
        // word" — that is what a reader wants almost every time, and having
        // repeat clicks silently grow the selection turned an exploratory
        // series of clicks into a whole subsection. Hold Cmd (or Ctrl) to walk
        // out through the enclosing brackets, groups and sections; add Shift to
        // walk back in.
        widen: !!(ev.metaKey || ev.ctrlKey),
        shrink: !!ev.shiftKey,
        // SHIFT ALONE PICKS THE ENDS OF A SELECTION: once for where it starts,
        // once for where it ends. It is free to mean that because shrinking is
        // only ever asked for WITH Cmd — walking back in along a ladder one has
        // walked out of.
        pick: !!ev.shiftKey && !(ev.metaKey || ev.ctrlKey),
    });
});

// --- DRAG SELECTS, AND SHOWS IT WHILE THE HAND IS MOVING ---------------------
//
// Press, move, let go: the two ends are resolved exactly as a click resolves
// one, the span is repainted on every move, and the editor selects it as it
// goes, so the page and the editor are never out of step mid-gesture.
//
// A PLAIN drag does it — nothing else was using it, the page scrolls by wheel
// and scrollbar — and Cmd-drag is left alone for the ladder. A press that never
// moves is still a click, so every other gesture survives untouched. And once
// a range is there, either BRACKET can be taken hold of and moved: that is the
// same drag with the opposite end as its anchor.
let dragSel = null;

// THE ACTION BAR TAKES THE POINTER FIRST OF ALL.
//
// MEASURED by removing this handler: the press falls through to the page,
// `sendClick` resolves whatever word sits under the bar, and the selection the
// button was about to act on is REPLACED by that word — so pressing Copy
// copies something else. And where the bar overlaps the fill (a selection at
// the top of a page, where the bar flips below into the text) the press picks
// the selection up to drag it instead. Capture stops both before any of the
// page's own handlers see it.
pagesEl().addEventListener('mousedown', (ev) => {
    if (ev.target.closest && ev.target.closest('.selact')) {
        ev.preventDefault();
        ev.stopPropagation();
    }
}, true);

pagesEl().addEventListener('click', (ev) => {
    const b = ev.target.closest ? ev.target.closest('.selact button') : null;
    if (!b) return;
    ev.preventDefault();
    ev.stopPropagation();
    vscode.postMessage({ type: 'selectionAction', action: b.dataset.action });
}, true);

// A CHIP TAKES THE POINTER, IN THE CAPTURE PHASE.
//
// Shift-click on the page means "pick the end of a selection", and a chip is
// only ever visible while Shift is down — so a click that leaked past would
// start a selection at whatever glyph sits under the chip. Capture stops it
// before any of the page's own handlers see it: the bracket drag below, the
// plain-drag selection, and sendClick.
pagesEl().addEventListener('mousedown', (ev) => {
    const chip = ev.target.closest ? ev.target.closest('.lbc') : null;
    if (!chip || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
}, true);

pagesEl().addEventListener('click', (ev) => {
    const chip = ev.target.closest ? ev.target.closest('.lbc') : null;
    if (!chip) return;
    ev.preventDefault();
    ev.stopPropagation();
    vscode.postMessage({
        type: 'copyLabel',
        name: chip.dataset.name,
        role: chip.dataset.role,
        kind: chip.dataset.kind,
        cmd: chip.dataset.cmd,
        alt: !!ev.altKey,
    });
    chip.classList.add('lbc-copied');
    setTimeout(() => chip.classList.remove('lbc-copied'), 700);
}, true);

/** Start a drag from a bracket: the other end stays put. */
pagesEl().addEventListener('mousedown', (ev) => {
    const brk = ev.target.closest ? ev.target.closest('.selbrk') : null;
    if (!brk || ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragSel = { moved: false, last: 0, adjusting: true };
    vscode.postMessage({ type: 'selectAdjust', end: brk.classList.contains('end') ? 'end' : 'start' });
}, true);

/**
 * A PRESS INSIDE THE SELECTION PICKS IT UP.
 *
 * Dragging selected text to move it is what every editor does, and it is the
 * one gesture the page was missing: a block of LaTeX can now be carried across
 * pages without leaving the paper. The fill stays `pointer-events:none` on
 * purpose — making it grabbable would stop a click inside your own selection
 * from resolving the word under it — so the press is hit-tested against the
 * painted bands instead, and a press that never moves still falls through to
 * the click handler.
 */
function inPaintedSelection(ev) {
    for (const band of document.querySelectorAll('.selfill')) {
        const r = band.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right &&
            ev.clientY >= r.top && ev.clientY <= r.bottom) return true;
    }
    return false;
}

let dragMove = null;

pagesEl().addEventListener('mousedown', (ev) => {
    if (dragSel || dragMove) return;                       // a bracket already has it
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const wrap = ev.target.closest('.page');
    if (!wrap) return;
    const n = Number(wrap.dataset.page);
    if (!state.rendered.has(n)) return;
    const r = wrap.getBoundingClientRect();
    const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
    if (!pt) return;
    ev.preventDefault();
    if (state.selection && inPaintedSelection(ev)) {
        dragMove = { moved: false, last: 0 };
        document.body.classList.add('moving-sel');
        // The bar is about the selection standing still. While it is being
        // carried it would sit under the pointer, over the page the reader is
        // aiming at — and its buttons would be the thing they dropped onto.
        for (const el of document.querySelectorAll('.selact')) el.remove();
        hideChipPreview();
        return;
    }
    // A PRESS IS NOT YET A DRAG.
    //
    // This used to arm the selection here, on the button going down, and the
    // extension answers an arming pick with `pendingStart` — so the opening red
    // bracket appeared the instant the button touched the page, before the hand
    // had moved at all. Reported: "the left red bracket appears on click before
    // I drag any considerable amount".
    //
    // So the press is only REMEMBERED. The anchor is sent by the first move
    // that travels further than a hand holds still, and it is sent for the
    // point the press started at — the anchor belongs where the gesture began,
    // not where it was noticed.
    dragSel = {
        moved: false, last: 0, armed: false,
        downX: ev.clientX, downY: ev.clientY,
        page: n, pt, ox: ev.clientX - r.left, oy: ev.clientY - r.top,
    };
});

// Far enough that no press meant to be a click will cross it, near enough that
// a deliberate drag arms almost at once. In CSS pixels, squared.
const DRAG_ARM_PX2 = 5 * 5;

window.addEventListener('mousemove', (ev) => {
    if (dragMove) {
        const now = performance.now();
        if (now - dragMove.last < 60) return;      // one round trip per frame or two
        const page = document.elementFromPoint(ev.clientX, ev.clientY);
        const wrap = page && page.closest ? page.closest('.page') : null;
        if (!wrap) return;
        const n = Number(wrap.dataset.page);
        if (!state.rendered.has(n)) return;
        const r = wrap.getBoundingClientRect();
        const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
        if (!pt) return;
        dragMove.last = now;
        dragMove.moved = true;
        vscode.postMessage({ type: 'movePreview', page: n, xBp: pt.xBp, yTopBp: pt.yTopBp });
        return;
    }
    if (!dragSel) return;
    // The gesture becomes a selection only once it has actually travelled. The
    // bracket-adjust drag has no press point of its own — it starts from a
    // bracket that is already on the page — and arms immediately, as it should.
    if (!dragSel.armed && dragSel.pt) {
        const dx = ev.clientX - dragSel.downX;
        const dy = ev.clientY - dragSel.downY;
        if (dx * dx + dy * dy < DRAG_ARM_PX2) return;
        dragSel.armed = true;
        sendClick(dragSel.page, dragSel.pt, dragSel.ox, dragSel.oy, { pick: true });
    }
    const now = performance.now();
    if (now - dragSel.last < 60) return;          // one repaint per frame or two
    const wrap = document.elementFromPoint(ev.clientX, ev.clientY);
    const page = wrap && wrap.closest ? wrap.closest('.page') : null;
    if (!page) return;
    const n = Number(page.dataset.page);
    if (!state.rendered.has(n)) return;
    const r = page.getBoundingClientRect();
    const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
    if (!pt) return;
    dragSel.last = now;
    dragSel.moved = true;
    sendClick(n, pt, ev.clientX - r.left, ev.clientY - r.top, { pick: true, live: true });
});

window.addEventListener('mouseup', (ev) => {
    if (dragMove) {
        const moved = dragMove.moved;
        dragMove = null;
        document.body.classList.remove('moving-sel');
        paintMoveCaret(null);
        // Back when the hand lets go — where the selection now IS, which the
        // extension re-posts, so this only covers the press that never moved.
        if (!moved) paintSelectionActions();
        if (!moved) return;             // a press that did not move is a click
        const page = (ev.target.closest ? ev.target.closest('.page') : null) ||
            pagesEl().querySelector('.page');
        const n = page ? Number(page.dataset.page) : 0;
        if (!page || !state.rendered.has(n)) { vscode.postMessage({ type: 'moveCancel' }); return; }
        const r = page.getBoundingClientRect();
        const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
        if (!pt) { vscode.postMessage({ type: 'moveCancel' }); return; }
        state.swallowClick = true;
        setTimeout(() => { state.swallowClick = false; }, 250);
        vscode.postMessage({ type: 'moveCommit', page: n, xBp: pt.xBp, yTopBp: pt.yTopBp });
        return;
    }
    if (!dragSel) return;
    const moved = dragSel.moved;
    const adjusting = dragSel.adjusting;
    dragSel = null;
    // A press that never moved is a CLICK, and the click handler owns it —
    // except on a bracket, where a click means nothing and must not resolve a
    // word under it.
    if (!moved) {
        if (adjusting) { state.swallowClick = true; setTimeout(() => { state.swallowClick = false; }, 250); }
        return;
    }
    const page = (ev.target.closest ? ev.target.closest('.page') : null) ||
        pagesEl().querySelector('.page');
    if (!page) return;
    const n = Number(page.dataset.page);
    if (!state.rendered.has(n)) return;
    const r = page.getBoundingClientRect();
    const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
    if (!pt) return;
    // The click event that follows a drag must not pick a third end.
    state.swallowClick = true;
    setTimeout(() => { state.swallowClick = false; }, 250);
    sendClick(n, pt, ev.clientX - r.left, ev.clientY - r.top, { pick: true });
});

/**
 * DOUBLE-CLICK MEANS "TAKE ME THERE".
 *
 * A single click is a reading gesture: it selects and focus stays on the page.
 * Double-click is an editing gesture — it puts the cursor in the editor and
 * leaves full screen, because the editor is what you now want to look at.
 */
pagesEl().addEventListener('dblclick', (ev) => {
    const wrap = ev.target.closest ? ev.target.closest('.page') : null;
    if (!wrap) return;
    const n = Number(wrap.dataset.page);
    if (!state.rendered.has(n)) return;
    const r = wrap.getBoundingClientRect();
    const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
    if (!pt) return;
    ev.preventDefault();
    // Nothing to undo any more: the two single clicks before this one each
    // selected the same tightest thing rather than widening.
    sendClick(n, pt, ev.clientX - r.left, ev.clientY - r.top, { takeMe: true });
});

// RIGHT-CLICK MEANS "EDIT THIS, HERE".
//
// The paragraph or equation under the pointer opens in a mini-editor pinned
// below its own rendered block. Everything typed there goes through the real
// text document — same undo stack, same live recompile — so the page and the
// editor never disagree.
pagesEl().addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('.editcard')) return;      // the card owns its own menu
    const wrap = ev.target.closest('.page');
    if (!wrap) return;
    const n = Number(wrap.dataset.page);
    if (!state.rendered.has(n)) return;
    const r = wrap.getBoundingClientRect();
    const pt = fromViewport(n, ev.clientX - r.left, ev.clientY - r.top);
    if (!pt) return;
    ev.preventDefault();
    sendClick(n, pt, ev.clientX - r.left, ev.clientY - r.top, {}, 'editHere');
});

// --- the mini-editor card ----------------------------------------------------

function closeEditCard(notify = true) {
    for (const c of document.querySelectorAll('.editcard')) c.remove();
    if (state.edit && notify) vscode.postMessage({ type: 'editClose', editId: state.edit.id });
    state.edit = null;
}

// --- LaTeX syntax highlighting ----------------------------------------------
//
// A textarea cannot colour its own text. The standard arrangement is a <pre>
// holding the SAME characters marked up, with a transparent-text textarea laid
// exactly on top of it — the caret and selection come from the textarea, the
// colours from the layer behind.
//
// THE INVARIANT THAT MATTERS IS NOT THE COLOURS, IT IS THE CHARACTERS. The two
// layers only stay aligned while the highlighter is character-exact: every
// character in, every character out, none added, none dropped. Drop one and
// every following line wraps differently, so the caret sits somewhere the text
// is not. That is what the harness asserts (`pre.textContent === ta.value`),
// and it is why the escaping goes through one function.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c]);

/**
 * @param {string} src
 * @param {{start:number,end:number}|null} sel  a range to mark, in characters
 * @returns {string} HTML whose textContent is exactly `src`
 */
function highlightLatex(src, sel) {
    const text = String(src == null ? '' : src);
    const pieces = [];
    const push = (from, to, cls) => { if (to > from) pieces.push({ from, to, cls }); };

    // One left-to-right scan. Order matters: a comment cannot start at an
    // escaped `\%` because the `\.` alternative consumes it first.
    const re = /%[^\n]*|\\\\|\\(?:begin|end)\b[ \t]*\{[^}\n]*\}|\\[A-Za-z@]+\*?|\\.|\$\$?|[{}]|&/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        push(last, m.index, '');
        const t = m[0];
        const a = m.index; const b = re.lastIndex;
        if (t[0] === '%') push(a, b, 'x');
        else if (t === '\\\\' || t === '&') push(a, b, 'o');
        else if (/^\\(?:begin|end)\b/.test(t)) {
            // \begin{equation} is two things a reader tracks separately: the
            // structural word, and WHICH environment.
            const br = t.indexOf('{');
            push(a, a + br, 'k');
            push(a + br, a + br + 1, 'b');
            push(a + br + 1, b - 1, 'e');
            push(b - 1, b, 'b');
        } else if (t[0] === '\\' && /[A-Za-z@]/.test(t[1] || '')) push(a, b, 'c');
        else if (t[0] === '\\' || t[0] === '$') push(a, b, 'm');   // \[ \] \( \) $ $$
        else push(a, b, 'b');                                      // { }
        last = b;
    }
    push(last, text.length, '');

    // Split at the selection boundaries so the mark can wrap whole pieces.
    const s = sel && Number.isFinite(sel.start)
        ? { start: Math.max(0, Math.min(sel.start, text.length)),
            end: Math.max(0, Math.min(Math.max(sel.end, sel.start), text.length)) }
        : null;
    const split = [];
    for (const p of pieces) {
        let from = p.from;
        for (const cut of (s ? [s.start, s.end] : [])) {
            if (cut > from && cut < p.to) { split.push({ from, to: cut, cls: p.cls }); from = cut; }
        }
        split.push({ from, to: p.to, cls: p.cls });
    }

    const out = [];
    let open = false;
    let caret = false;
    for (const p of split) {
        if (s && s.end === s.start && !caret && p.from >= s.start) {
            out.push('<mark class="ec-sel ec-caret"></mark>'); caret = true;
        }
        if (s && !open && s.end > s.start && p.from >= s.start && p.from < s.end) {
            out.push('<mark class="ec-sel">'); open = true;
        }
        if (open && p.from >= s.end) { out.push('</mark>'); open = false; }
        const body = esc(text.slice(p.from, p.to));
        out.push(p.cls ? `<span class="t${p.cls}">${body}</span>` : body);
    }
    if (open) out.push('</mark>');
    if (s && s.end === s.start && !caret) out.push('<mark class="ec-sel ec-caret"></mark>');
    // A trailing newline opens no line box of its own in a <pre>, so the layer
    // would come up one line short of the textarea.
    if (text.endsWith('\n')) out.push(' ');
    return out.join('');
}

/** Repaint the highlight layer and match the textarea's height to it. */
function syncHighlight(card) {
    const ta = card.querySelector('textarea');
    const pre = card.querySelector('.ec-hl');
    if (!ta || !pre) return;
    pre.innerHTML = highlightLatex(ta.value, state.edit && state.edit.sel);
    // The layer is the size-driver: the textarea is absolutely positioned over
    // it at the FULL content height and never scrolls itself, so the wrapper
    // scrolls both together and there is no scroll offset to keep in sync.
    ta.style.height = `${pre.offsetHeight}px`;
}

/**
 * DRAG THE CARD BY ITS TITLE BAR.
 *
 * The card is pinned under the block it edits, which is the right DEFAULT and
 * a poor rule: the block it is covering is often the one you want to read while
 * you type. So the header is a handle.
 *
 * The position is remembered as a FRACTION of its page, not as pixels, because
 * everything that repaints the card can also have changed the page's size —
 * zoom, a panel resize, a recompile that reflows the block. Fractions survive
 * all of them; pixels put a moved card somewhere arbitrary after the first
 * zoom. Double-click the header to give it back to the automatic placement.
 */
function makeDraggable(card, handle) {
    handle.style.cursor = 'move';
    handle.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        if (ev.target.closest('button')) return;          // the buttons are not a handle
        const wrap = card.parentElement;
        if (!wrap) return;
        const W = wrap.clientWidth || 600;
        const H = wrap.clientHeight || 800;
        const x0 = ev.clientX; const y0 = ev.clientY;
        const left0 = parseFloat(card.style.left) || 0;
        const top0 = parseFloat(card.style.top) || 0;
        let moved = false;
        // The pointer is captured so the drag survives leaving the header —
        // and so leaving the WINDOW cannot strand the card mid-drag.
        try { handle.setPointerCapture(ev.pointerId); } catch (_) { /* fine */ }
        ev.preventDefault();

        const move = (e2) => {
            const dx = e2.clientX - x0; const dy = e2.clientY - y0;
            if (!moved && Math.hypot(dx, dy) < 3) return;  // a click is not a drag
            moved = true;
            const cw = card.offsetWidth || 320;
            // Always leave a grabbable strip of the card on the page, or it
            // can be dragged somewhere it can never be dragged back from.
            const left = Math.max(-cw * 0.5, Math.min(left0 + dx, W - cw * 0.5));
            const top = Math.max(0, Math.min(top0 + dy, Math.max(0, H - 24)));
            card.style.left = `${left}px`;
            card.style.top = `${top}px`;
            if (state.edit) state.edit.pos = { fx: left / W, fy: top / H };
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            try { handle.releasePointerCapture(ev.pointerId); } catch (_) { /* fine */ }
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
    // Back to the automatic placement under the block.
    handle.addEventListener('dblclick', (ev) => {
        if (ev.target.closest('button')) return;
        if (state.edit) state.edit.pos = null;
        paintEditCard();
    });
}

function buildEditCard(e) {
    const card = document.createElement('div');
    card.className = 'editcard';
    card.dataset.edit = String(e.id);
    // Clicks inside the card are the card's business — they must not fall
    // through to the page's click-to-source handler underneath.
    for (const t of ['click', 'dblclick', 'mousedown', 'contextmenu']) {
        card.addEventListener(t, (ev) => ev.stopPropagation());
    }

    const head = document.createElement('div');
    head.className = 'ec-head';
    const title = document.createElement('span');
    title.className = 'ec-title';
    title.textContent = e.label || 'edit';
    head.title = 'Drag to move · double-click to re-pin under the block';
    const lines = document.createElement('span');
    lines.className = 'ec-lines';
    lines.textContent = `${e.file || ''} · ${e.startLine === e.endLine
        ? 'line ' + e.startLine : 'lines ' + e.startLine + '–' + e.endLine}`;
    const spacer = document.createElement('span');
    spacer.className = 'ec-spacer';
    const btn = (label, tip, fn) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = tip;
        b.addEventListener('click', fn);
        return b;
    };
    const step = (d) => vscode.postMessage({ type: 'editStep', editId: state.edit.id, delta: d });
    head.append(title, lines, spacer,
        btn('‹', 'Previous block (⌥↑)', () => step(-1)),
        btn('›', 'Next block (⌥↓)', () => step(1)),
        btn('↗', 'Open this range in the editor', () =>
            vscode.postMessage({ type: 'editReveal', editId: e.id })),
        btn('save', 'Save the file (⌘S)', () =>
            vscode.postMessage({ type: 'editSave', editId: e.id })),
        btn('✕', 'Close (Esc)', () => closeEditCard()));
    makeDraggable(card, head);

    // The highlight layer sits UNDER a transparent-text textarea; see
    // highlightLatex for why they must hold identical characters.
    const box = document.createElement('div');
    box.className = 'ec-editor';
    const pre = document.createElement('pre');
    pre.className = 'ec-hl';
    pre.setAttribute('aria-hidden', 'true');
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.value = e.text || '';
    box.append(pre, ta);
    let debounce = null;
    ta.addEventListener('input', () => {
        state.edit.text = ta.value;               // survives zoom/generation rebuilds
        state.edit.sel = null;                    // the located range is stale once typed over
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            vscode.postMessage({ type: 'editChange', editId: e.id, text: ta.value });
        }, 250);
        syncHighlight(card);
    });
    ta.addEventListener('keydown', (ev) => {
        ev.stopPropagation();                     // Esc here must not exit full screen
        if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
            ev.preventDefault();
            clearTimeout(debounce);
            // Flush first: stepping replaces the session, and an unsent edit
            // belonging to the OLD block would be applied to the new one.
            vscode.postMessage({ type: 'editChange', editId: e.id, text: ta.value });
            step(ev.key === 'ArrowUp' ? -1 : 1);
            return;
        }
        if (ev.key === 'Escape') { ev.preventDefault(); closeEditCard(); }
        else if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'Enter')) {
            ev.preventDefault();
            clearTimeout(debounce);
            vscode.postMessage({ type: 'editChange', editId: e.id, text: ta.value });
            vscode.postMessage({ type: 'editSave', editId: e.id });
        }
    });

    const hint = document.createElement('div');
    hint.className = 'ec-hint';
    hint.textContent = 'drag the title to move · ⌥↑/⌥↓ previous/next block · click the page to jump here · ⌘S saves · Esc closes';

    card.append(head, box, hint);
    return card;
}

/** Place (or re-place) the card under its block's rendered rows. */
function paintEditCard(focus = false) {
    const e = state.edit;
    for (const c of document.querySelectorAll('.editcard')) {
        if (!e || c.dataset.edit !== String(e.id)) c.remove();
    }
    if (!e) return;
    const rects = e.rects && e.rects.length ? e.rects : null;
    const page = rects ? rects[rects.length - 1].page : e.page;
    const wrap = pagesEl().querySelector(`.page[data-page="${page}"]`);
    if (!wrap || !state.rendered.has(page)) return;

    let bottom = 24; let left = null;
    if (rects) {
        for (const r0 of rects) {
            if (r0.page !== page) continue;
            const v = rectToViewport(page, r0);
            if (!v) continue;
            bottom = Math.max(bottom, v.y + v.h);
            left = left == null ? v.x : Math.min(left, v.x);
        }
    }
    let card = wrap.querySelector('.editcard');
    const fresh = !card;
    if (!card) {
        card = buildEditCard(e);
        wrap.appendChild(card);
        syncHighlight(card);
    }

    // SIZE AND PLACE AGAINST THE VISIBLE BAND, NOT THE PAGE.
    //
    // MEASURED, from the user's own screenshot: at 125% a letter page is
    // ~765 CSS px while the panel beside an editor was ~606, so the page
    // overflows horizontally and `main` scrolls. Sizing the card from
    // `wrap.clientWidth` — the PAGE — made it 720 px wide inside a 606 px
    // window, and both of its edges sat outside the window: the save button
    // off one side, the source text cut off the other.
    //
    // The card is a child of `.page` so it scrolls with the page, but its
    // width and left edge are computed from the intersection of the page with
    // whatever is on screen right now.
    const main = document.querySelector('main');
    const W = wrap.clientWidth || 600;
    const wr = wrap.getBoundingClientRect();
    const mr = main ? main.getBoundingClientRect() : wr;
    const visLeft = Math.max(0, mr.left - wr.left);
    const visRight = Math.min(W, mr.right - wr.left);
    const cw = Math.max(220, Math.min(W - 24, (visRight - visLeft) - 28, 640));
    const lo = Math.max(0, visLeft + 14);
    const hi = Math.max(lo, Math.min(W - cw, visRight - cw - 14));
    const x = Math.max(lo, Math.min(left == null ? 32 : left, hi));
    card.style.width = `${cw}px`;
    if (e.pos) {
        // MOVED BY HAND — the reader's placement outranks the block's. Clamped
        // to the page it lives on, so a resize or a zoom cannot leave it
        // stranded off the edge with nothing left to grab.
        const H = wrap.clientHeight || 800;
        card.style.left = `${Math.max(-cw * 0.5,
            Math.min(e.pos.fx * W, W - cw * 0.5))}px`;
        card.style.top = `${Math.max(0, Math.min(e.pos.fy * H, Math.max(0, H - 24)))}px`;
    } else {
        card.style.left = `${x}px`;
        card.style.top = `${bottom + 8}px`;
    }

    // FOCUS ONLY ONCE THE CARD IS WHERE IT IS GOING TO BE, AND NEVER LET THE
    // BROWSER DO THE SCROLLING.
    //
    // `ta.focus()` used to run at build time — before the width and top were
    // set — and a focus-scroll has no "minimal" semantics: it revealed the
    // element from wherever the unsized card briefly was, which is why opening
    // one so often left the reader looking at the wrong part of the page.
    if (fresh && focus) {
        const ta = card.querySelector('textarea');
        try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }
        revealEditCard(card);
    }
}

/**
 * Scroll the least that shows the card, preferring its TOP.
 *
 * A card taller than the viewport cannot be shown whole, and of the two ends
 * the top is the one worth having: the header says what is being edited and
 * the first lines are where the caret is. So the downward scroll is capped at
 * whatever keeps the top on screen.
 */
function revealEditCard(card) {
    const main = document.querySelector('main');
    if (!main || !card) return;
    const mr = main.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const pad = 12;
    const above = (mr.top + pad) - cr.top;              // >0: the card starts off the top
    const below = cr.bottom - (mr.bottom - pad);        // >0: it runs past the bottom
    let delta = 0;
    if (above > 0) delta = -above;
    else if (below > 0) delta = Math.min(below, Math.max(0, cr.top - (mr.top + pad)));
    if (Math.abs(delta) > 1) main.scrollTo({ top: main.scrollTop + delta, behavior: 'smooth' });
}

/** Put the caret on a range of the open block, and show where it landed. */
function selectInEditCard(msg) {
    const e = state.edit;
    if (!e || e.id !== msg.editId) return;
    const card = document.querySelector('.editcard');
    if (!card) return;
    const ta = card.querySelector('textarea');
    e.sel = { start: msg.start, end: msg.end };
    syncHighlight(card);
    try { ta.setSelectionRange(msg.start, msg.end); } catch (_) { /* out of range */ }
    // preventScroll for the same reason as opening: the reveal below is
    // minimal, a focus-scroll is not.
    if (msg.focus) { try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); } }
    // Scroll through the HIGHLIGHT layer, not the textarea: the textarea never
    // scrolls itself (it is laid out at full content height), so the mark in
    // the layer is the only element that can be revealed.
    const mark = card.querySelector('.ec-sel');
    if (mark && mark.scrollIntoView) mark.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * Resolve the word AND the maths glyph under a point, then tell the extension.
 *
 * Both readings go every time: only the extension knows whether what was
 * clicked is maths, because only it has the document model.
 */
function sendClick(n, pt, cx, cy, extra, type = 'click') {
    const base = { type, page: n, xBp: pt.xBp, yTopBp: pt.yTopBp, ...extra };
    Promise.all([wordAtPoint(n, cx, cy, false), wordAtPoint(n, cx, cy, true)])
        .then(([hit, g]) => vscode.postMessage({
            ...base,
            // A FAR word is not a hit — it is the answer to "what is nearest",
            // kept apart so it can never outrank a real one.
            word: hit && !hit.far ? hit.word : undefined,
            farWord: hit && hit.far ? hit.word : undefined,
            rowFraction: hit ? hit.rowFraction : undefined,
            wordOccurrence: hit ? hit.occurrence : undefined,
            wordSpots: hit && hit.at ? hit.spots : undefined,
            wordAt: hit ? hit.at : undefined,
            wordContext: hit ? hit.context : undefined,
            glyph: g && !g.far ? g.word : undefined,
            glyphFraction: g ? g.rowFraction : undefined,
            glyphOccurrence: g ? g.occurrence : undefined,
            glyphSpots: g && g.at ? g.spots : undefined,
            glyphAt: g ? g.at : undefined,
            glyphContext: g ? g.context : undefined,
        }))
        .catch(() => vscode.postMessage(base));
}

el('zoomin').addEventListener('click', () => setScale(state.scale * 1.25));
el('zoomout').addEventListener('click', () => setScale(state.scale / 1.25));
el('fit').addEventListener('click', () => fitWidth());
el('follow').addEventListener('change', (e) => {
    state.followCursor = e.target.checked;
    vscode.postMessage({ type: 'follow', value: state.followCursor });
});
el('recompile').addEventListener('click', () => vscode.postMessage({ type: 'recompile' }));
el('pin').addEventListener('change', (e) => {
    state.pinHighlight = e.target.checked;
    paintHighlight();
});
// Report where the reader is, so closing and reopening the panel — which is
// the only way to hide a webview — puts them back rather than at page one.
{
    let t = null;
    const main = document.querySelector('main');
    if (main) {
        let lastLeft = main.scrollLeft;
        main.addEventListener('scroll', () => {
            // Only the HORIZONTAL scroll moves the card: it is a child of the
            // page, so it follows vertically on its own, but its width was
            // computed from the visible band and that band has just moved.
            if (state.edit && main.scrollLeft !== lastLeft) {
                lastLeft = main.scrollLeft;
                paintEditCard();
            }
            clearTimeout(t);
            t = setTimeout(() => {
                const a = scrollAnchor();
                if (a) vscode.postMessage({ type: 'viewstate', page: a.page, frac: a.frac });
            }, 300);
        }, { passive: true });
    }
}

// The visible band changes with the panel, so the card is re-fitted with it.
let _resizeT = null;
window.addEventListener('resize', () => {
    if (state.edit) paintEditCard();
    // Fit is a mode: a panel that changes width re-fits to it.
    if (state.fitMode) {
        clearTimeout(_resizeT);
        _resizeT = setTimeout(() => { fitWidth(); }, 120);
    }
});

el('full').addEventListener('click', () => {
    vscode.postMessage({ type: 'fullscreen', value: !state.fullscreen });
});

// THE SUN/MOON IS AN OVERRIDE, AND SAYS SO BY BECOMING ONE.
//
// While the setting is `auto` the button reports what the theme decided; the
// moment it is pressed the reader has an opinion, so it stores the OPPOSITE of
// what is on screen as an explicit choice — including "white paper in a dark
// theme", which is what a reader checking how the paper will PRINT wants.
el('compare').addEventListener('click', () => vscode.postMessage({ type: 'compare' }));
el('diffprev').addEventListener('click', () => stepHunk(-1));
el('diffnext').addEventListener('click', () => stepHunk(1));
el('diffclose').addEventListener('click', () => {
    state.diff = null;
    updateDiffChrome();
    paintDiff();
    vscode.postMessage({ type: 'diffClose' });
});

// The toolbar toggle exists for two reasons: nobody discovers a hold-Shift
// gesture on their own, and a reader who wants to click several chips in a row
// should not have to hold a key while doing it.
el('labels').addEventListener('click', () => {
    state.labelsPinned = !state.labelsPinned;
    el('labels').setAttribute('aria-pressed', String(state.labelsPinned));
    if (state.labelsPinned && (!state.labels || state.labels.generation !== state.generation)) {
        state.labelsAsked = state.generation;
        vscode.postMessage({ type: 'labelsWanted', value: true });
    }
    paintLabels().catch(() => {});
});

el('pagetheme').addEventListener('click', () => {
    const next = state.pageTheme === 'dark' ? 'light' : 'dark';
    state.setting = next;
    applyTheme(state.themeDark, next);          // paint now; the extension confirms
    vscode.postMessage({ type: 'pageTheme', value: next });
});

// Until the extension answers — and permanently in the harness, which has no
// extension — fall back to what the page can see for itself.
applyTheme(guessDark(), guessDark() ? 'dark' : 'light');
try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => { if (!state.themeFromExtension) applyTheme(guessDark(), guessDark() ? 'dark' : 'light'); };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
} catch (_) { /* no matchMedia: the extension's message is the only source */ }
// ESC IS THE ONE KEY EVERYONE ALREADY TRIES, so it undoes the innermost thing
// first and only then the outermost: a half-made drag, then the selection, then
// full screen. Taking full screen away while a selection is still on the page
// would answer a question the reader did not ask, and a second press is cheap.
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.target && e.target.tagName === 'TEXTAREA') return;   // the card owns it

    if (dragMove) {
        dragMove = null;
        document.body.classList.remove('moving-sel');
        paintMoveCaret(null);
        vscode.postMessage({ type: 'moveCancel' });
        e.preventDefault();
        return;
    }
    if (dragSel) { dragSel = null; e.preventDefault(); return; }
    // A selection on the page — `pendingStart` means it is half-made and still
    // waiting for its other end, which Esc must abandon just the same.
    if (state.selection) {
        clearSelectionOverlay();
        vscode.postMessage({ type: 'selectionClear' });
        e.preventDefault();
        return;
    }
    if (state.fullscreen) {
        e.preventDefault();
        vscode.postMessage({ type: 'fullscreen', value: false });
    }
});

/** Take the selection off the page, marks and all. */
function clearSelectionOverlay() {
    state.selection = null;
    for (const el of document.querySelectorAll('.selfill, .selbrk, .selact')) el.remove();
    el('where').textContent = '';
}

// HOLD SHIFT TO SEE THE PAPER'S LABELS.
//
// Shift alone was free: the page's own Shift meaning is on the CLICK (picking
// the ends of a selection), not on the key. Typing in the mini-editor is
// excluded the same way the zoom keys are — a capital letter in an equation is
// not a request to see the cross-references.
//
// Releasing is three events, not one: keyup covers the ordinary case, `blur`
// covers Cmd-Tab away with Shift still down (no keyup ever arrives), and
// visibilitychange covers the panel being hidden. Without those the chips stay
// on the page and the reader has to press Shift twice to clear them.
window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    if (e.key !== 'Shift' || e.repeat || state.labelsOn) return;
    showLabels();
});
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') hideLabels(); });
window.addEventListener('blur', hideLabels);
document.addEventListener('visibilitychange', () => { if (document.hidden) hideLabels(); });

// A KEY EVENT NEEDS FOCUS; A MOUSE EVENT DOES NOT.
//
// Reported: "shift only works when the top panel is in focus, not inside the
// viewer itself". The page area holds nothing focusable, and the drag-selection
// handler calls preventDefault on mousedown — which is exactly what suppresses
// the default focus — so the webview's document often never has the keyboard at
// all and no keydown ever arrives. Focusing it on hover would be worse: it
// would steal the keyboard from the editor the reader is typing in.
//
// Every mouse event carries the modifier state, so the reveal is driven from
// the pointer whenever it is over the pages. Moving the mouse with Shift down
// shows them; letting go — or leaving — puts them away.
const trackShift = (ev) => {
    if (ev.shiftKey && !state.labelsOn) showLabels();
    else if (!ev.shiftKey && state.labelsOn) hideLabels();
};
for (const type of ['pointermove', 'pointerdown', 'pointerenter']) {
    document.querySelector('main').addEventListener(type, trackShift, { passive: true });
}
document.querySelector('main').addEventListener('pointerleave', () => hideLabels(), { passive: true });

function setScale(s, anchor, keepFit) {
    if (!keepFit && state.fitMode) {
        state.fitMode = false;
        document.body.classList.remove('fitted');
    }
    state.scale = Math.max(0.25, Math.min(6, s));
    el('zoom').textContent = `${Math.round(state.scale * 100)}%`;
    for (const w of pagesEl().children) w.innerHTML = '<div class="pagenum">' + w.dataset.page + '</div>';
    state.rendered.clear();
    state.pending.clear();
    textCache.clear();   // item rects are in viewport pixels, so scale invalidates them
    if (state.doc) {
        state.doc.getPage(1).then((p) => {
            const vp = p.getViewport({ scale: state.scale });
            for (const w of pagesEl().children) {
                w.style.width = `${Math.floor(vp.width)}px`;
                w.style.height = `${Math.floor(vp.height)}px`;
            }
            // Zooming must not teleport the reader: keep the same page and
            // fraction under the viewport that was there before the resize.
            if (anchor) restoreAnchor(anchor);
            observeVisible();
        });
    }
}

// Pinch and Ctrl/Cmd+wheel zoom, anchored so the page does not jump. macOS
// trackpad pinches arrive as wheel events with ctrlKey set.
document.querySelector('main').addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const a = scrollAnchor();
    const k = Math.exp(-ev.deltaY * 0.0022);
    setScale(state.scale * Math.max(0.8, Math.min(1.25, k)), a);
}, { passive: false });

window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setScale(state.scale * 1.25, scrollAnchor()); }
    else if (e.key === '-') { e.preventDefault(); setScale(state.scale / 1.25, scrollAnchor()); }
    else if (e.key === '0') { e.preventDefault(); fitWidth(); }
});

/**
 * FIT MEANS FIT: the page spans the whole viewer, edge to edge.
 *
 * The old sum was `main.clientWidth - 48`, a fudge that did not correspond to
 * anything — `clientWidth` already excludes the scrollbar but INCLUDES the
 * padding, so the page ended up inset by the padding plus an arbitrary 48px.
 * Now the horizontal padding is dropped while fitted and the width is measured,
 * so there is nothing left over.
 *
 * It is also a MODE, not a one-off: resizing the panel re-fits, which is what
 * anyone who pressed Fit expects. Any manual zoom leaves the mode.
 */
function fitWidth() {
    if (!state.doc) return;
    state.fitMode = true;
    document.body.classList.add('fitted');
    return state.doc.getPage(1).then((p) => {
        const main = document.querySelector('main');
        const cs = getComputedStyle(main);
        const pad = parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0);
        // clientWidth already excludes a vertical scrollbar, so what is left
        // after the padding is exactly what a page may occupy.
        const avail = main.clientWidth - pad;
        const base = p.getViewport({ scale: 1 });
        if (avail > 0) setScale(avail / base.width, scrollAnchor(), true);
    });
}

// --- CLIPPING A FRAGMENT OUT OF THE PAPER ------------------------------------
//
// A hover over `\eqref{eq:foo}` wants to show the equation as it PRINTS, not
// only as it is written. The panel is the one place that already has the pages
// rasterised, so the extension asks it for a crop rather than shelling out to a
// PDF rasteriser that may not be installed — and what comes back is the exact
// ink the reader is looking at, from the same generation.
//
// Spike C measured the mechanism: rendering a clipped region through
// `viewport.clone({offsetX, offsetY})` is pixel-identical to rendering the whole
// page and cutting it out, at a fraction of the memory.

async function cropFragment(msg) {
    const rects = (msg.rects || []).filter(r => r && Number.isFinite(r.x));
    if (!rects.length || !state.doc) return { id: msg.id, error: 'nothing to crop' };
    const page = rects[0].page;
    // One box around everything on that page, with a little air so the type is
    // not shaved by a rounding error.
    const pad = Number.isFinite(msg.pad) ? msg.pad : 3;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const r of rects) {
        if (r.page !== page) continue;
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    if (!(x1 > x0 && y1 > y0)) return { id: msg.id, error: 'empty box' };
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;

    const p = await state.doc.getPage(page);
    const base = p.getViewport({ scale: 1 });
    // bp -> viewport at scale 1 is where the extension's frame and pdf.js's
    // agree (measured in-browser: the transform is [1,0,0,-1,-x0,y1]).
    const scale = Math.min(msg.scale || 2, 4);
    const vp = p.getViewport({ scale });
    const sx = x0 * scale;
    const sy = y0 * scale;
    const w = Math.max(1, Math.round((x1 - x0) * scale));
    const h = Math.max(1, Math.round((y1 - y0) * scale));
    if (w > 4000 || h > 4000) return { id: msg.id, error: 'too large' };

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    const clipped = vp.clone({ offsetX: -sx, offsetY: -sy });
    await p.render({ canvasContext: ctx, viewport: clipped, canvas }).promise;
    void base;
    return {
        id: msg.id,
        dataUrl: canvas.toDataURL('image/png'),
        // The size the fragment should be SHOWN at: its own bp size, so an
        // equation appears the size it prints rather than the size we happened
        // to rasterise it.
        w: Math.round(x1 - x0),
        h: Math.round(y1 - y0),
        page,
    };
}

// --- messages from the extension ---------------------------------------------

window.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    switch (msg.type) {
        case 'open': await openDocument(msg); break;
        case 'fullscreen':
            state.fullscreen = !!msg.value;
            el('full').textContent = state.fullscreen ? '⤡' : '⛶';
            el('full').title = state.fullscreen
                ? 'Leave full screen (Esc)'
                : 'Full screen (Esc to leave, double-click a word to go there and edit)';
            document.body.classList.toggle('fullscreen', state.fullscreen);
            if (state.fullscreen) window.focus();
            break;
        case 'highlight': {
            let rects = msg.rects || [];
            if (rects.length && msg.word) {
                // Make sure the pages are rendered before asking for their
                // text, then narrow the highlight from the whole typeset row
                // to the single word the cursor is on.
                for (const r of rects) await renderPage(r.page);
                try {
                    // Search the WIDER region the extension supplies: a row
                    // rectangle misses its line's first and last word, and the
                    // n-th occurrence counted inside it is somebody else's.
                    const w = await wordInRows(msg.searchRects && msg.searchRects.length
                        ? msg.searchRects : rects, msg.word, msg.occurrence, !!msg.glyph);
                    if (w) {
                        const back = fromViewport(w.page, w.x, w.y);
                        const far = fromViewport(w.page, w.x + w.w, w.y + w.h);
                        if (back && far) {
                            rects = [{ page: w.page, x: back.xBp, y: back.yTopBp,
                                w: far.xBp - back.xBp, h: far.yTopBp - back.yTopBp }];
                        }
                    }
                } catch (_) { /* keep the row highlight */ }
            }
            state.highlight = rects.length
                ? { page: rects[0].page, rects, flag: msg.flag, title: msg.title }
                : null;
            if (state.highlight && msg.reveal) revealHighlight();
            else paintHighlight();
            if (msg.label) el('where').textContent = msg.label;
            break;
        }
        case 'selection':
            // A range replaces the cursor's wash: the two are answers to
            // different questions and showing both at once reads as neither.
            if (msg.span) {
                for (const box of document.querySelectorAll('.hl')) box.remove();
                state.highlight = null;
            }
            await paintSelection(msg.span ? { ...msg.span, reveal: msg.reveal } : null);
            if (msg.label) el('where').textContent = msg.label;
            break;
        case 'labels':
            state.labels = { generation: msg.generation, items: msg.items || [] };
            state.labelFormat = msg.format || 'command';
            if (labelsVisible()) { paintLabels().catch(() => {}); if (state.labelsOn) hintLabels(); }
            break;
        case 'moveCaret':
            state.moveCaret = msg.rects && msg.rects.length ? msg : null;
            paintMoveCaret(state.moveCaret);
            if (msg.label) el('where').textContent = msg.label;
            break;
        case 'crop': {
            let out;
            try { out = await cropFragment(msg); }
            catch (e) { out = { id: msg.id, error: String((e && e.message) || e) }; }
            vscode.postMessage({ type: 'cropped', ...out });
            break;
        }
        case 'status': status(msg.text, msg.kind || ''); break;
        case 'setFollow': state.followCursor = !!msg.value; el('follow').checked = state.followCursor; break;
        case 'editOpen': {
            // A card the reader has MOVED keeps its place while they step from
            // block to block — the whole point of moving it was to choose where
            // to look. A right-click, which says "edit this one, here", pins it
            // back under the block it names.
            const keepPos = msg.stepped && state.edit ? state.edit.pos : null;
            closeEditCard(false);                  // one session at a time
            state.edit = {
                id: msg.editId, text: msg.text || '', label: msg.label,
                file: msg.file, startLine: msg.startLine, endLine: msg.endLine,
                rects: msg.rects || [], page: (msg.rects && msg.rects[0] && msg.rects[0].page) || 1,
                pos: keepPos || null,
            };
            const page = state.edit.rects.length
                ? state.edit.rects[state.edit.rects.length - 1].page : state.edit.page;
            await renderPage(page);
            paintEditCard(true);
            break;
        }
        case 'editUpdate': {
            const e = state.edit;
            if (!e || e.id !== msg.editId) break;
            e.text = msg.text;
            if (msg.startLine) { e.startLine = msg.startLine; e.endLine = msg.endLine; }
            const card = document.querySelector('.editcard');
            const ta = card && card.querySelector('textarea');
            if (ta && ta.value !== msg.text) {
                // The change came from the text editor. Keep the caret where it
                // was, clamped — the reader is not typing here at this moment.
                const at = ta.selectionStart;
                ta.value = msg.text;
                try { ta.selectionStart = ta.selectionEnd = Math.min(at, msg.text.length); } catch (_) { /* fine */ }
                e.sel = null;
                syncHighlight(card);
            }
            const ln = document.querySelector('.editcard .ec-lines');
            if (ln && msg.startLine) {
                ln.textContent = `${e.file || ''} · ${e.startLine === e.endLine
                    ? 'line ' + e.startLine : 'lines ' + e.startLine + '–' + e.endLine}`;
            }
            break;
        }
        case 'editAnchor':
            if (state.edit && state.edit.id === msg.editId) {
                state.edit.rects = msg.rects || state.edit.rects;
                paintEditCard();
            }
            break;
        case 'theme':
            state.themeFromExtension = true;      // stop listening to the OS guess
            state.setting = msg.setting || 'auto';
            applyTheme(msg.dark, msg.pages);
            break;
        case 'diff':
            state.diff = msg.session
                ? { ...msg.session, index: -1, focus: null }
                : null;
            updateDiffChrome();
            paintDiff();
            if (state.diff && state.diff.hunks.length) stepHunk(1);
            break;
        case 'diffFocus':
            if (state.diff) { state.diff.focus = msg.id; paintDiff(); }
            break;
        case 'editSelect': selectInEditCard(msg); break;
        case 'editClosed': closeEditCard(false); break;
        default: break;
    }
});

vscode.postMessage({ type: 'ready' });

// A measurement hook, not an API: the headless check scores snapToInk against
// the rendered ink. Nothing in the extension reads this.
window.__wbTexViewerTest = { snapToInk, itemWords, prefixWidths, textItems, wordKey, foldGlyphs, wordAtPoint, highlightLatex, fromViewport, rectToViewport };
