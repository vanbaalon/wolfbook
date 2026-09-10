// texViewer.js — Page mode: the webview panel that shows the compiled paper.
//
// The extension half. The webview half is out/client/tex-viewer.js; the two
// speak postMessage and nothing else.
//
// WHAT MAKES THIS "PAGE MODE" AND NOT A PDF PREVIEW: clicking lands on the
// SEMANTIC OBJECT, not on "approximately line 183". The pipeline is
// RenderMap.renderToSource -> the tightest SyncTeX record -> the object whose
// range contains that line -> a selection over the object's real source range.
// Stage 0 measured the page half of that at 100% on 539 objects of a real
// 89-page paper.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const { FLAG } = require('./renderMap');
const {
    wordAtColumn, findWordInLine, collectMacros, isInMath, mathRegions,
    locateByContext, visibleWords,
} = require('./texWords');
const { selectionLadder, paragraphSpan, CONTAINER_KINDS } = require('./texSelect');
const { buildObjectMap, glyphAtPoint, tokenAt, groupAround, symbolicFonts, caretInRange } = require('./glyphAlign');
const { buildComparison, describeSummary } = require('./texCompare');
const { shipDecision } = require('./livePolicy');
const { balanceRange, closeFor, commentMask } = require('./texBalance');
const { sectionSpans, ADDRESSABLE } = require('./texModel');
const collapse = require('./collapse');
const { MATH_ENVS } = require('./texScanner');
const { readAuxLabels } = require('./auxLabels');
const { buildLabelChips, formatLabelCopy, altFormat,
    blockOf, inColumn, tagRows, rowsOver, CHIP_H } = require('./labelChips');
const { stepAt, satisfies } = require('./tourSteps');
const { graphicxInsertion } = require('./texPaste');
const mmaBlocks = require('./mmaBlocks');
const mmaWrite = require('./mmaWrite');
const { announceAgentEdit } = require('./reviewBus');
const { checkWritable } = require('./diskGuard');
const { TexComputeService } = require('./texCompute');
const { CommentStore, sidecarFor, markdownFor } = require('./commentStore');

/**
 * THE EQUATION NUMBER IS NOT PART OF THE EQUATION.
 *
 * `(18)` sits on the display's own row, so it arrives with the object's ink and
 * joins the sequence being aligned — measured, the rendered side of one
 * fixture ended `… 0 1 2 ( 1 )` against a source that has no such tokens. It
 * costs alignment, and a click on it can only end somewhere arbitrary.
 *
 * It is recognised by the two things that are true of every tag and of nothing
 * else on the row: it is the LAST ink, separated from the equation by a gap
 * several times the line height (TeX sets it flush to the margin), and it reads
 * as a number in parentheses. Removing it leaves a click on the number with no
 * glyph of its own, which resolves to the enclosing equation — the honest
 * answer, and the useful one.
 */
/**
 * HOW MANY TIMES A HINT IS STILL WORTH SHOWING.
 *
 * The label badge's tooltip teaches its local copy gesture and then gets out
 * of the way. General page gestures are taught by the guide, not by a tooltip
 * attached to the entire PDF surface.
 *
 * MODULE-LEVEL ON PURPOSE: the count must survive closing and reopening the
 * paper (that is not a new reader) and reset when the window reloads (that is
 * a new session, and the reminder is fair again). Nothing is written to disk —
 * a hint budget is not worth a setting, and "after each restart" is exactly
 * what the reader asked for.
 */
const TOUR_KEY = 'wolfbook.tex.tour';
const GROUP_KEY = 'wolfbook.tex.reviewGroup';
const HINT_BUDGET = { chip: 3 };
const hintsLeft = { ...HINT_BUDGET };

const TAG_TEXT = /^[([]?[0-9]+[A-Za-z.]*[)\]]?$/;

function dropEquationTags(items) {
    const rows = new Map();
    for (const it of items) {
        const k = `${it.page}|${Math.round((it.baseline ?? it.y) * 2) / 2}`;
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k).push(it);
    }
    for (const row of rows.values()) row.sort((a, b) => a.x - b.x);
    // The object's own ink, so a row that is NOTHING BUT a tag can be told from
    // a row that happens to start with a number. A display whose whole body is
    // a fraction puts its number on the axis, alone on a baseline of its own —
    // there is no gap to measure there, only the fact that it sits to the right
    // of everything else the object printed.
    //
    // Measured per ROW, not per item: pdf.js may report `(18)` as three items,
    // and `(` on its own is not tag-shaped, so an item-wise test counts the
    // tag's own parenthesis as body and the tag then looks flush with it.
    let bodyRight = -Infinity;
    for (const row of rows.values()) {
        const whole = row.map(r => r.str).join('').trim();
        if (!whole || TAG_TEXT.test(whole)) continue;
        for (const it of row) bodyRight = Math.max(bodyRight, it.x + (it.w || 0));
    }

    const drop = new Set();
    for (const row of rows.values()) {
        if (row.length < 2) {
            const t = String(row[0] && row[0].str || '').trim();
            if (t && TAG_TEXT.test(t) && row[0].x > bodyRight + (row[0].h || 10)) drop.add(row[0]);
            continue;
        }
        const whole = row.map(r => r.str).join('').trim();
        if (TAG_TEXT.test(whole) && row[0].x > bodyRight + (row[0].h || 10)) {
            for (const r of row) drop.add(r);
            continue;
        }
        const h = Math.max(...row.map(r => r.h || 0)) || 10;
        // Walk in from the right while the ink still reads as a tag.
        let cut = row.length;
        for (let i = row.length - 1; i > 0; i--) {
            const gap = row[i].x - (row[i - 1].x + (row[i - 1].w || 0));
            const text = row.slice(i, cut).map(r => r.str).join('').trim();
            if (gap > h * 3 && TAG_TEXT.test(text)) { for (let k = i; k < cut; k++) drop.add(row[k]); break; }
            if (gap > h * 3) break;                 // a wide gap that is not a tag
        }
    }
    if (!drop.size) return items;
    for (let i = items.length - 1; i >= 0; i--) if (drop.has(items[i])) items.splice(i, 1);
    return items;
}

/**
 * DROP THE INK THAT IS NOT THE OBJECT — the equation number, and the strays.
 *
 * MEASURED on the reference paper. The rows of one display come back as
 *
 *     L126 \begin{equation}   x=515.9..599.1   y=211.3..224.8
 *     L135 …the equation…      x=160.2..435.0   y=228.5..258.9
 *     L137 \end{equation}      x=512.9..517.2   y=237.3..250.8
 *
 * The first is the equation NUMBER, filed under the `\begin` line and set out
 * in the margin — it even runs past the text measure, to x=599 on a 595 bp
 * page. Highlighting the union of those rows therefore painted a wide amber
 * band in the margin ABOVE the equation, and another sliver beside it: reported
 * as "selects some weird domain" and "the whole equation plus a bit more".
 *
 * A tag is recognised by being both NARROW and entirely to one side of the
 * object's real content — never by its text, which is why this also removes the
 * `\end` sliver and anything else TeX files under a delimiter line.
 */
function dropStrayRows(rects) {
    const byPage = new Map();
    for (const r of rects || []) {
        if (!byPage.has(r.page)) byPage.set(r.page, []);
        byPage.get(r.page).push(r);
    }
    const keep = [];
    for (const rows of byPage.values()) {
        if (rows.length < 2) { keep.push(...rows); continue; }
        const widest = Math.max(...rows.map(r => r.w));
        // The content is what carries the ink; a tag never does.
        const body = rows.filter(r => r.w >= widest * 0.4);
        if (!body.length) { keep.push(...rows); continue; }
        const left = Math.min(...body.map(r => r.x));
        const right = Math.max(...body.map(r => r.x + r.w));
        for (const r of rows) {
            const narrow = r.w < widest * 0.4;
            // TO THE RIGHT, AND ONLY TO THE RIGHT. A tag is set flush to the
            // right margin; a wrapped line's last row continues at the LEFT
            // one. Dropping both sides also deleted the tail row — measured,
            // line 74 of the reference paper prints "Q-operator is" as an 11 bp
            // row of its own, and the selection lost its last line.
            const rightOf = r.x > right + 2;
            if (narrow && rightOf) continue;
            keep.push(r);
        }
        void left;
    }
    return keep;
}

/**
 * ONE BAND PER PRINTED LINE, not one per BASELINE.
 *
 * `lineRows` groups ink by baseline, and a display fraction puts its numerator
 * and denominator on baselines of their own. So a one-line equation containing
 * `\frac{|m|}{2}` came back as three rows, and painting them separately drew a
 * little amber patch over the `|m|`, another under it over the `2`, and a long
 * strip across the rest of the line. Reported with a screenshot: "this looks
 * broken — better highlight nothing than make such a mess".
 *
 * Merging by VERTICAL OVERLAP rather than merging everything is what keeps this
 * honest in the other direction. The stacked pieces of one printed line overlap
 * each other by several points, so they become one band; the successive lines of
 * a paragraph or an `align` merely TILE — they touch and do not overlap — so
 * they stay separate bands and the highlight still follows the text instead of
 * becoming one big box over everything between the first line and the last.
 *
 * (The object's own SyncTeX box is not an option: it includes
 * `\abovedisplayskip`, so it reaches up over the paragraph above the equation.)
 */
/** The honesty flag, as the footer says it. */
function flagWord(flag) {
    return flag === FLAG.FRESH ? 'fresh' : flag === FLAG.STALE ? 'stale' : 'approx';
}

function mergeRows(rects) {
    const byPage = new Map();
    for (const r of rects || []) {
        if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
        if (!byPage.has(r.page)) byPage.set(r.page, []);
        byPage.get(r.page).push(r);
    }
    const out = [];
    const OVERLAP = 1;              // bp: touching rows are not overlapping rows
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
        const rows = byPage.get(page).slice().sort((a, b) => a.y - b.y || a.x - b.x);
        let cur = null;
        for (const r of rows) {
            if (cur && r.y < cur.y1 - OVERLAP) {
                cur.x0 = Math.min(cur.x0, r.x);
                cur.x1 = Math.max(cur.x1, r.x + r.w);
                cur.y1 = Math.max(cur.y1, r.y + r.h);
                continue;
            }
            if (cur) out.push(cur);
            cur = { page, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
        }
        if (cur) out.push(cur);
    }
    return out.map(b => ({ page: b.page, x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
}

/**
 * A SPAN'S INK CANNOT BEGIN BEFORE ITS FIRST LINE OR END AFTER ITS LAST.
 *
 * MEASURED on the reference paper. Selecting the whole of the display at lines
 * 106-114 painted FOUR bands, two of them on the WRONG PAGE:
 *
 *     p2 y=113.9  x=100.9..110.6   (line 106) — the equation
 *     p1 y=61.5   x=0.0..72.0      (line 114) — the top MARGIN of page 1
 *     p1 y=781.9  x=294.9..510.5   (line 114) — prose at the foot of page 1
 *     p2 y=133.8  x=141.4..517.2   (line 114) — the equation
 *
 * Reported as "selecting the entire equation selects some random text around",
 * and that is exactly what it was: SyncTeX files strays under a delimiter line
 * — here `\end{equation}` — and an equation that straddles a page break
 * collects them from the page it did not print on. The same disease as the row
 * repairs in §5e, one level up.
 *
 * The fix is a fact about reading order rather than about SyncTeX: a contiguous
 * range of source runs forwards on the page, so its ink lies between the ink of
 * its FIRST line and the ink of its LAST. Anything outside that interval was
 * misfiled. Rows must carry `.line`; a clip that would empty the set is refused,
 * because a misfiled anchor must degrade to the old behaviour and not to
 * nothing.
 */
function clipToSpan(rows) {
    const all = (rows || []).filter(r => r && Number.isFinite(r.line));
    if (all.length < 2) return rows || [];
    let minLine = Infinity;
    let maxLine = -Infinity;
    for (const r of all) {
        if (r.line < minLine) minLine = r.line;
        if (r.line > maxLine) maxLine = r.line;
    }
    if (minLine === maxLine) return rows;
    // PAGES ONLY, AND THAT IS DELIBERATE.
    //
    // Clipping by position WITHIN a page looked like the same idea and broke a
    // different thing: inside a display, source order is not vertical order.
    // Measured on `eq:SoV-versus-pole-heights`, the last line with any rows is
    // `\end{equation}`, whose only row is a sliver ABOVE the equation's own
    // last line — so a vertical ceiling taken from it cut the equation in half
    // and the hover showed only its top. Ink that is merely out of order on the
    // right page is handled by dropStrayRows and dropDetachedRows, which reason
    // about shape rather than about order.
    let floorPage = Infinity;
    let ceilPage = -Infinity;
    for (const r of all) {
        if (r.line === minLine) floorPage = Math.min(floorPage, r.page);
        if (r.line === maxLine) ceilPage = Math.max(ceilPage, r.page);
    }
    if (!Number.isFinite(floorPage) || !Number.isFinite(ceilPage) || floorPage > ceilPage) return rows;
    const kept = rows.filter(r => !Number.isFinite(r.line) ||
        (r.page >= floorPage && r.page <= ceilPage));
    return kept.length ? kept : rows;
}

/**
 * A NARROW ROW STANDING APART FROM THE BODY IS NOT PART OF IT.
 *
 * `dropStrayRows` removes the equation NUMBER, which is narrow and flush RIGHT.
 * It deliberately keeps narrow rows on the LEFT, because a wrapped line's short
 * tail continues at the left margin (§5l). But a bare `\begin{equation}` line
 * also collects ink from the paragraph ABOVE it, and that lands narrow and on
 * the left:
 *
 *     L252 \begin{equation}   x=107.3..126.5  y=149.6..163.1   w=19.2
 *     L255 …the equation…      x=198.3..431.0  y=177.6..191.1   w=232.7
 *
 * Reported as "the render of the equation for the reference is not correct":
 * the hover's crop unions those rects, so it began 28 bp too high and 90 bp too
 * far left, and showed the tail of the previous paragraph.
 *
 * What separates the two is not the side, it is whether the row TOUCHES the
 * rest of the object. A wrapped tail sits directly under its own line; misfiled
 * ink sits in a band of its own with clear space around it.
 */
function dropDetachedRows(rects) {
    const rows = (rects || []).filter(r => r && Number.isFinite(r.x));
    if (rows.length < 2) return rects || [];
    const widest = Math.max(...rows.map(r => r.w));
    return rows.filter((r) => {
        if (r.w >= widest * 0.4) return true;              // body: always keep
        const gap = Math.min(...rows.map((o) => {
            if (o === r || o.page !== r.page) return Infinity;
            if (o.y + o.h <= r.y) return r.y - (o.y + o.h);
            if (r.y + r.h <= o.y) return o.y - (r.y + r.h);
            return 0;                                       // they overlap
        }));
        return gap <= (r.h || 12) * 0.6;
    });
}

/**
 * ONE OBJECT, ONE PAGE — when the ink says so.
 *
 * MEASURED on `eq:full-Qplus-pole-grid`, which prints at the top of page 3:
 *
 *     p2  x=295..510  y=782..795     <- the last prose line of page 2
 *     p3  x=190..416  y= 90..130     <- the equation
 *
 * The `\begin{equation}` line collected the tail of the paragraph before it,
 * on the PREVIOUS page. A crop takes one rectangle on one page, so it showed
 * the bottom of page 2 — the wrong thing entirely.
 *
 * A display that genuinely straddles a page break puts real ink on both; one
 * stray row does not. So when a single page carries the great majority of the
 * object's ink, that page IS the object.
 */
function dominantPage(rects) {
    const rows = (rects || []).filter(r => r && Number.isFinite(r.x));
    if (rows.length < 2) return rects || [];
    const area = new Map();
    let total = 0;
    for (const r of rows) {
        const a = Math.max(1, r.w) * Math.max(1, r.h);
        area.set(r.page, (area.get(r.page) || 0) + a);
        total += a;
    }
    if (area.size < 2) return rects;
    let best = null;
    for (const [page, a] of area) if (!best || a > best.a) best = { page, a };
    if (!best || best.a < total * 0.7) return rects;      // genuinely spanning
    return rows.filter(r => r.page === best.page);
}

/** Kinds whose whole box is a sensible highlight when nothing finer resolves. */
const BLOCK_KINDS = ['display-equation', 'figure', 'table', 'tabular', 'theorem'];
/** Kinds whose content is maths, and so is addressable glyph by glyph. */
const MATH_KINDS = ['display-equation'];

/**
 * What a PLAIN click is allowed to select.
 *
 * Anything larger is a widening, and widening is opt-in on Cmd/Ctrl. A block
 * the reader clicked INTO — an equation, a figure — is still fair game, because
 * that is the thing under the pointer; a paragraph, a section or the whole file
 * is not.
 */
const PLAIN_CLICK_KINDS = new Set([
    'word', 'glyph', 'sentence', 'group',
    'display-equation', 'figure', 'table', 'tabular', 'theorem',
    'environment', 'align', 'abstract', 'titlepage', 'list', 'itemize', 'enumerate', 'verbatim',
]);

const VIEW_TYPE = 'wolfbook.texViewer';
/** Where the shown paper's root is kept, so a window reload can restore it. */
const ROOT_KEY = 'wolfbook.tex.viewerRoot';
/**
 * Where the reader was in each paper. Older records contain only {page, frac};
 * newer ones also carry exact scroll/zoom, full-screen preference, source
 * cursor and the open mini-editor. Keep the key stable so existing places
 * migrate simply by being read and written again.
 *
 * Switching to a tab that is not a .tex CLOSES the panel — VS Code has no way
 * to hide a webview — so "keep my place" cannot rely on the DOM surviving. It
 * is kept here, per paper, and it outlives a window reload because it is in
 * workspace state rather than in the panel.
 */
const VIEW_KEY = 'wolfbook.tex.viewerPlace';
const VIEW_MAX = 24;               // papers remembered; the oldest simply drops

/**
 * WHERE THE CLICK LANDED, IN THE EDITOR — an outline, not a wash.
 *
 * This used to be a translucent amber fill faked into a fade: seven decoration
 * types at falling alpha, swapped on a timer. It looked wrong, and for two
 * reasons that no amount of tuning fixes. A decoration cannot animate, so the
 * "fade" is a handful of visible steps rather than a fade; and it paints ON TOP
 * of the selection VS Code has already drawn over the same characters, so the
 * two translucent layers muddy each other and the text underneath.
 *
 * So the marker is now a thin rounded BORDER around the range, drawn once and
 * removed once. It says "this is the thing you clicked" without touching the
 * colours of the text inside it, it cannot fight the selection, and there is no
 * intermediate state in which it can look half-broken. It is cleared on the
 * next click, or after `ms`, whichever comes first.
 *
 * The type is created once and reused — creating one per click leaks a
 * renderer-side object every time.
 */
class EditorFlash {
    constructor(ms = 2600) {
        this.ms = ms;
        this._type = null;
        this._timer = null;
        this._active = null;
    }

    _make() {
        if (this._type) return this._type;
        // Read the enum defensively: it is absent in some hosts, and a
        // decoration is decoration — a missing one must never be able to break
        // the jump it decorates. (A test caught exactly that: reading
        // `.Center` off undefined threw out of every single inverse click.)
        const lane = (vscode.OverviewRulerLane && vscode.OverviewRulerLane.Center) ?? 2;
        try {
            this._type = vscode.window.createTextEditorDecorationType({
                border: '1px solid rgba(255,196,0,0.95)',
                borderRadius: '3px',
                // The border alone can be lost against bright syntax colours;
                // a whisper of fill is enough to find it without staining the
                // text the way the old 0.42-alpha wash did.
                backgroundColor: 'rgba(255,196,0,0.10)',
                // The paper scrolls to what you clicked; so should the ruler.
                overviewRulerColor: 'rgba(255,196,0,0.8)',
                overviewRulerLane: lane,
            });
        } catch (_) { this._type = null; }
        return this._type;
    }

    /** Outline `range` in `editor`, and take it away again cleanly. */
    show(editor, range) {
        if (!editor || !range) return;
        this.clear();
        let type = null;
        try { type = this._make(); } catch (_) { return; }
        if (!type) return;
        this._active = editor;
        try { editor.setDecorations(type, [range]); }
        catch (_) { this._active = null; return; }
        this._timer = setTimeout(() => this.clear(), this.ms);
    }

    clear() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._active && this._type) {
            try { this._active.setDecorations(this._type, []); } catch (_) { /* gone */ }
        }
        this._active = null;
    }

    dispose() {
        this.clear();
        try { if (this._type) this._type.dispose(); } catch (_) { /* gone */ }
        this._type = null;
    }
}

class TexViewer {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {import('./renderUi').RenderCoordinator} coord
     * @param {import('./index').Projection} projection
     */
    constructor(context, coord, projection, deps = {}) {
        this.context = context;
        this.coord = coord;
        this.projection = projection;
        // Managed computations. Constructed even when this window has no kernel
        // resolver: a paper viewer that cannot compute must still open, fold,
        // search and edit, so the absence is reported when Run is pressed
        // rather than by refusing to load.
        this.compute = new TexComputeService(deps);
        this._mma = null;          // the open computation card's session
        this._runs = null;         // cellId -> the last result, session-only
        this.panel = null;
        this.root = null;          // the root .tex this panel is showing
        // The generation whose BYTES the webview holds — not simply the newest
        // one. _text.generation and _objMaps are keyed on it, so it may only
        // advance when a document actually crossed into the panel.
        this.shownGeneration = null;
        this.shownPdfHash = null;
        // `shown*` names the last document SENT. pdf.js opens asynchronously,
        // so review coordinates may only trust the separate acknowledgement
        // from the webview below. Otherwise a click during a live rebuild can
        // scroll the old PDF with rectangles measured on the new one.
        this._openedGeneration = null;
        this._openedPdfHash = null;
        // FOLLOW IS TWO THINGS, and conflating them cost the reader a choice
        // they wanted: 'mark' shows where the caret is WITHOUT moving the
        // page, which is what you want while editing prose beside the paper;
        // 'scroll' also brings that place into view; 'off' ignores the editor.
        // The old boolean could only say off-or-both.
        this.followMode = 'scroll';   // 'off' | 'mark' | 'scroll'
        this.shownAnything = false;
        this._ladder = null;       // {page, xBp, yBp, items, index, file}
        this._invertedAt = 0;      // when the reader last clicked IN the PDF
        this._macros = new Map();  // docPath -> {version, table}
        this._fsActions = null;    // the commands that put us in full screen
        this._fsSettling = null;   // disposal may still be undoing those commands
        this._layoutMode = 'all';  // all (source editor + WPaper) | viewer
        this._layoutMaximized = false;
        this._layoutOuterActions = [];
        this._layoutQueue = null;  // serialises quick repeated toolbar clicks
        this._layoutGuardTimer = null; // coalesces VS Code's external-file reload burst
        this._restoringPanel = false; // restored chrome still needs reconciling with VS Code
        this._autoHidden = null;   // closed by us because no .tex was active
        this._viewState = null;    // the persisted reading/editing session for this paper
        this._webviewReady = false;
        this._cursorSaveTimer = null;
        this._cursorPending = null;
        this._edit = null;         // the one live mini-editor session
        this._editSeq = 0;
        this._diff = null;         // the open comparison, if any
        this._text = null;         // {generation, pages: Map<page, items>} from the webview
        this._objMaps = new Map(); // `${generation}|${stableKey}` -> the alignment
        this._docListener = null;
        // The label overlay: built per generation, and only once somebody has
        // actually held Shift. Pushing it on every live rebuild would ship a
        // payload nobody is looking at, several times a minute.
        this._moveTarget = null;   // where a dragged selection would land
        this._editStack = [];      // recent edit places, newest first
        this._editStackAt = 0;     // which one the footer is parked on
        this._crops = new Map();   // `${generation}|${key}` -> {dataUrl,w,h}
        this._cropWaits = new Map();
        this._cropSeq = 0;
        this._chips = null;        // {key, items}
        this._chipModels = null;   // file -> model, for the files of this root
        this._labelsWanted = false;
        this._flash = new EditorFlash();
        this._disposables = [];
        this._viewerProbeSeq = 0;
        this._viewerProbes = new Map();
        this._viewCaptureSeq = 0;
        this._viewCaptures = new Map();
        this._viewerReloading = false;
        this._viewerReloadTimer = null;
        this._reviewFocus = null;
        this._reviewWaiting = false;
        // The source has moved but the webview still holds the preceding PDF.
        // While true, neither direction is allowed to claim a correspondence.
        this._tracePaused = false;
        this._traceSource = null;
        this._traceStateKey = null;
        this._sourceDirtyKey = null;
        this._lastEditCaret = null;
        this._miniApplyingFile = null;
        this._editApplyQueue = null; // orders card edits before stepping/saving
        this._syncPreserveView = false; // a render refresh may redraw without navigating
        this.comments = new CommentStore();
        this._commentAuthorPromise = null;
        this._commentDraft = null;   // extension-owned target for the open composer
        this._commentSeq = 0;
        this._commentPushTimer = null;
    }

    /** A human name stored with new shared comments; Git identity is already
     * the project's collaboration identity, with the OS account as fallback. */
    async _readerCommentAuthor(file) {
        if (this._commentAuthorPromise) return this._commentAuthorPromise;
        this._commentAuthorPromise = new Promise(resolve => {
            execFile('git', ['config', '--get', 'user.name'], {
                cwd: path.dirname(file), timeout: 1500, maxBuffer: 4096, windowsHide: true,
            }, (_error, stdout) => {
                let name = String(stdout || '').trim();
                if (!name) {
                    try { name = String(os.userInfo().username || '').trim(); } catch (_) { /* optional */ }
                }
                resolve(name ? { name } : undefined);
            });
        });
        return this._commentAuthorPromise;
    }

    get visible() { return !!this.panel; }

    /** Does the caret still get a mark on the page? */
    get followCursor() { return this.followMode !== 'off'; }

    /** May the page move itself to show it? */
    _mayScroll() { return this.followMode === 'scroll'; }

    get _webviewOptions() {
        return {
            enableScripts: true,
            retainContextWhenHidden: true,
            // Only our own client assets. The PDF is NOT loaded by URL — see
            // _postPdf below for why.
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'out', 'client'),
            ],
        };
    }

    /** Open (or focus) the viewer for whatever .tex is active. */
    async open(doc, { reveal = true } = {}) {
        const root = this.coord.rootFor(doc);
        if (this.panel) {
            if (reveal) this.panel.reveal(vscode.ViewColumn.Beside, true);
        } else {
            this._wire(vscode.window.createWebviewPanel(
                VIEW_TYPE, 'WPaper',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                this._webviewOptions));
            // KEEP THE COLUMN FOR THE PAPER.
            //
            // Without this, VS Code treats the viewer's group as an ordinary
            // editor group: click a search result or a file in the explorer
            // while the viewer has focus and it opens THERE, on top of the
            // paper. Locking the group makes VS Code route those elsewhere,
            // which is what makes a two-column layout usable rather than a
            // thing you have to keep tidying up.
            this._lockGroup().catch(() => { /* older builds simply do not */ });
        }
        // A DIFFERENT PAPER HAS A DIFFERENT PLACE. Carrying the last one's
        // scroll position into it would open the new paper somewhere arbitrary.
        const switching = this.root !== root;
        if (switching) {
            this._flushCursorState();
            this._viewState = this._viewFor(root);
            // AND NOTHING ON SCREEN BELONGS TO IT.
            //
            // refresh() returns early when the new paper has no PDF, which
            // left the PREVIOUS paper's pages up under the new one's name —
            // reported as "showing old file pdf from the previous tab". Taking
            // them down first means the worst case is an empty viewer saying
            // so, rather than another document shown as though it were this
            // one.
            this._post({ type: 'blank' });
            this.shownGeneration = null;
            this.shownPdfHash = null;
            this._openedGeneration = null;
            this._openedPdfHash = null;
            this.shownAnything = false;
            this._text = null;
            this._objMaps.clear();
            this._chips = null;
            this._chipModels = null;
            this._edit = null;
            this._mma = null;
            this._tracePaused = false;
            this._traceSource = null;
            this._traceStateKey = null;
            this._sourceDirtyKey = null;
            this._lastEditCaret = null;
            this._commentDraft = null;
        }
        this.root = root;
        this._rememberRoot(root);
        this._restoreCursor(this._viewState);
        this._postTheme();
        this._postSourceDirty(true);
        await this.refresh({ force: true });
        if (this._webviewReady) await this._restoreSessionChrome();

        // A PAPER WITH NO PDF SHOULD BUILD ONE, not sit there telling the
        // reader to press a button. Switching tabs is not a request to compile
        // everything in the workspace, so only the paper actually being shown
        // is built, and only when compiling is on at all.
        try {
            const st = this.coord.roots.get(root);
            const off = vscode.workspace.getConfiguration('wolfbook.tex').get('compile', 'onSave') === 'off';
            if (!off && (!st || (!st.generation && !st.compiling))) {
                this._post({ type: 'status', text: 'compiling the paper…', kind: '' });
                await this.coord.build(doc);
                await this.refresh({ force: true });
            }
        } catch (e) {
            this._post({ type: 'status', text: `could not compile: ${e.message}`, kind: 'err' });
        }
    }

    /**
     * Take ownership of a panel — a new one, or one VS Code restored.
     *
     * Everything a live panel needs is here rather than in `open`, because a
     * RELOADED panel needs exactly the same wiring and nothing else. Without
     * it the restored panel is a shell: no HTML, no message handler, no theme
     * listener — an empty grey rectangle that never syncs again, which is what
     * a window reload used to leave behind.
     */
    /**
     * Tell VS Code whether a WPaper viewer is open.
     *
     * The .tex keybindings are gated on this. Without it they were live in
     * EVERY .tex file the moment the extension activated — so Ctrl+V in a paper
     * this extension has nothing to do with went through our smart paste, and
     * Alt+[ / Alt+] were taken from whatever the reader had them bound to.
     * Reported alongside vanbaalon/wolfbook#17: shortcuts leaking into formats
     * we are not being asked to handle.
     *
     * Opening the viewer is the reader saying "this paper is mine to work on",
     * and that is exactly when the shortcuts should exist.
     */
    static _setViewerContext(open) {
        try { vscode.commands.executeCommand('setContext', 'wolfbook.texViewerOpen', !!open); }
        catch (_) { /* context keys are a nicety, never a failure path */ }
    }

    _wire(panel) {
        this.panel = panel;
        this._webviewReady = false;
        // A new webview has not received the last trace state, even when the
        // extension-side value survived a viewer reload.
        this._traceStateKey = null;
        this._sourceDirtyKey = null;
        TexViewer._setViewerContext(true);
        panel.iconPath = undefined;
        // A restored panel arrives with its options and content dropped, so
        // both are re-established rather than assumed.
        try { panel.webview.options = this._webviewOptions; } catch (_) { /* new panel: already set */ }
        panel.webview.html = this._html();
        panel.onDidDispose(() => {
            this._flushCursorState();
            this._cancelViewerProbes('viewer closed');
            for (const done of this._viewCaptures.values()) { try { done(false); } catch (_) {} }
            this._viewCaptures.clear();
            clearTimeout(this._viewerReloadTimer);
            clearTimeout(this._layoutGuardTimer);
            this._layoutGuardTimer = null;
            clearTimeout(this._commentPushTimer);
            this._viewerReloading = false;
            // Closing the panel must not leave the window maximised or the
            // agent side bar hidden with nothing in the focused editor area.
            if (this._fsActions) {
                const undo = [...(this._layoutOuterActions || [])].reverse();
                const restoreGroups = !!this._layoutMaximized;
                this._fsActions = null;
                this._layoutMode = 'all';
                this._layoutMaximized = false;
                this._layoutOuterActions = [];
                this._fsSettling = (async () => {
                    for (const c of undo) {
                        try { await vscode.commands.executeCommand(c); } catch (_) { /* best effort */ }
                    }
                    if (restoreGroups) {
                        try { await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup'); }
                        catch (_) { /* best effort */ }
                    }
                })().finally(() => { this._fsSettling = null; });
            }
            this.panel = null;
            this._webviewReady = false;
            TexViewer._setViewerContext(false);
            this.shownGeneration = null;
            this._openedGeneration = null;
            this._openedPdfHash = null;
            // Results that were never inserted are SESSION-ONLY by design: the
            // .tex is the single source of truth for what this paper contains,
            // and an exploratory result that outlived the panel showing it
            // would be a second, invisible one.
            this._mma = null;
            this._runs = null;
            clearTimeout(this._mmaRefresh);
            this._editStack = [];
            this._editStackAt = 0;
            clearTimeout(this._editStackPost);
            // A future panel is a different webview holding nothing.
            this.shownPdfHash = null;
            this.shownAnything = false;
            this._ladder = null;
            this._edit = null;
            this._docListener = null;
            this._text = null;
            this._diff = null;
            this._chips = null;
            this._chipModels = null;
            this._labelsWanted = false;
            this._tracePaused = false;
            this._traceSource = null;
            this._traceStateKey = null;
            this._sourceDirtyKey = null;
            this._lastEditCaret = null;
            this._miniApplyingFile = null;
            this._crops.clear();
            for (const done of this._cropWaits.values()) { try { done(null); } catch (_) {} }
            this._cropWaits.clear();
            this._objMaps.clear();
            this._flash.dispose();
            for (const d of this._disposables.splice(0)) { try { d.dispose(); } catch (_) {} }
        });
        panel.webview.onDidReceiveMessage((m) => this._onMessage(m));
        // EVERY change to a .tex, not just the one an open card is tracking:
        // the footer's worklist is about where the reader has been working,
        // which is most of the time nowhere near a card. Disposed with the
        // panel, so a closed viewer costs nothing.
        this._disposables.push(vscode.workspace.onDidChangeTextDocument((e) => {
            if (!e || !e.contentChanges || !e.contentChanges.length) return;
            try { this._noteEdit(e.document, e.contentChanges); } catch (_) { /* never fail a keystroke */ }
        }));
        // THE THEME COMES FROM VS CODE, NOT FROM THE WEBVIEW'S GUESS.
        //
        // A webview can read `prefers-color-scheme`, but that is the
        // OPERATING SYSTEM's preference: a light VS Code theme on a dark
        // desktop reports dark, and the pages would inconsistently invert.
        // `activeColorTheme.kind` is the thing the reader actually chose.
        this._disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => this._postTheme()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('wolfbook.tex.pageTheme')) this._postTheme();
            }),
        );
        // Sidecars are shared files. Pulls and collaborator edits should show
        // up without closing the paper, but unrelated papers are ignored.
        try {
            const watcher = vscode.workspace.createFileSystemWatcher('**/*.timeline.comments');
            const changed = (uri) => {
                const wanted = new Set(this._commentFiles().map(sidecarFor));
                if (uri && wanted.has(uri.fsPath)) this._pushComments(80);
            };
            this._disposables.push(watcher,
                watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed));
        } catch (_) { /* a minimal/test host may not expose file watchers */ }
    }

    /** The saved reading/editing session for `root`, or null. */
    _viewFor(root) {
        if (!root) return null;
        try {
            const all = this.context.workspaceState.get(VIEW_KEY) || {};
            const v = all[root];
            if (!v || typeof v !== 'object') return null;
            // `at` belongs to the store's eviction policy, not to the session
            // sent to the viewer. Everything else is forward-compatible: a
            // newer extension may add another small view property without an
            // older one destroying it on the next scroll.
            const out = { ...v };
            delete out.at;
            return Object.keys(out).length ? out : null;
        } catch (_) { return null; }
    }

    /** Merge a small patch into this paper's saved session. */
    _rememberState(root, patch) {
        if (!root || !patch || typeof patch !== 'object') return;
        const current = ((root === this.root || !this.root) && this._viewState)
            || this._viewFor(root) || {};
        const next = { ...current, ...patch };
        if (root === this.root || !this.root) this._viewState = next;
        try {
            const all = { ...(this.context.workspaceState.get(VIEW_KEY) || {}) };
            all[root] = { ...next, at: Date.now() };
            // Oldest out first, so a workspace with many papers cannot grow the
            // stored object without limit.
            const keys = Object.keys(all);
            if (keys.length > VIEW_MAX) {
                keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
                for (const k of keys.slice(0, keys.length - VIEW_MAX)) delete all[k];
            }
            this.context.workspaceState.update(VIEW_KEY, all);
        } catch (_) { /* no workspace state: the place lives for this session only */ }
    }

    /** Note the visible page, exact scroll and magnification. */
    _rememberView(root, page, frac, extra = {}) {
        if (!root || !Number.isFinite(page)) return;
        const patch = { page, frac: Number(frac) || 0 };
        for (const k of ['top', 'left', 'xFrac', 'scale', 'generation']) {
            if (Number.isFinite(extra[k])) patch[k] = Number(extra[k]);
        }
        if (typeof extra.fit === 'boolean') patch.fit = extra.fit;
        if (Number.isFinite(extra.focusPage) && Number.isFinite(extra.focusXBp) &&
            Number.isFinite(extra.focusYTopBp)) {
            patch.viewCell = this._semanticViewCell(extra);
        }
        this._rememberState(root, patch);
    }

    /** The map whose PDF the view-state coordinates were measured against. */
    _mapForViewGeneration(st, generation) {
        const number = (map) => map && map.generation && Number(map.generation.generation);
        const wanted = Number(generation);
        if (!st || !Number.isFinite(wanted)) return st && st.map;
        if (number(st.map) === wanted) return st.map;
        if (number(st.prevMap) === wanted) return st.prevMap;
        return null;
    }

    /** Convert a point in the displayed PDF into a durable source-cell address. */
    _semanticViewCell(extra) {
        const st = this.root && this.coord.roots && this.coord.roots.get(this.root);
        const map = this._mapForViewGeneration(st, extra.generation);
        if (!map || !map.available) return null;
        let row = null;
        try { row = map.lineAtPoint(extra.focusPage, extra.focusXBp, extra.focusYTopBp); }
        catch (_) { return null; }
        if (!row || !row.file || !Number.isFinite(row.line)) return null;
        let object = null;
        try { object = map.objectAtLine(row.file, row.line); } catch (_) { /* line fallback below */ }
        if (!object || object.approximate) return null;
        let full = null;
        try {
            full = map.model && map.model.objects && map.model.objects.find(o =>
                o.objectId === object.objectId && o.sourceRange && o.sourceRange.file === row.file);
        } catch (_) { /* the compact map object is enough */ }
        const start = Number(object.startLine) || Number(full && full.sourceRange.startLine) || row.line;
        return {
            file: row.file,
            objectId: object.objectId || (full && full.objectId) || null,
            stableKey: object.stableKey || (full && full.stableKey) || null,
            kind: object.kind || (full && full.kind) || null,
            label: object.label || (full && full.label) || null,
            sourceHash: full && full.sourceHash || null,
            normalizedHash: full && full.normalizedHash || null,
            lineOffset: Math.max(0, row.line - start),
            viewportFrac: Number.isFinite(extra.focusViewportFrac)
                ? Math.max(0, Math.min(1, Number(extra.focusViewportFrac))) : 0.35,
        };
    }

    /** Ask the live webview, rather than trusting a debounced scroll report. */
    _captureReaderView(timeoutMs = 500) {
        if (!this.panel || !this._webviewReady || !this.shownAnything) return Promise.resolve(false);
        const requestId = `view-${++this._viewCaptureSeq}`;
        return new Promise(resolve => {
            const finish = (ok) => {
                if (!this._viewCaptures.has(requestId)) return;
                this._viewCaptures.delete(requestId);
                clearTimeout(timer);
                resolve(!!ok);
            };
            const timer = setTimeout(() => finish(false), Math.max(50, timeoutMs));
            this._viewCaptures.set(requestId, finish);
            this._post({ type: 'requestViewState', requestId });
        });
    }

    /** Locate a saved source cell in the source/map of the replacement PDF. */
    _viewCellPlacement(cell) {
        if (!cell || !cell.file) return null;
        const objects = this._commentObjects(cell.file).filter(o => o && o.sourceRange);
        let object = objects.find(o => cell.objectId && o.objectId === cell.objectId);
        if (!object) object = objects.find(o => cell.stableKey && o.stableKey === cell.stableKey);
        if (!object) object = objects.find(o => cell.stableKey && o.previousStableKey === cell.stableKey);
        if (!object) object = objects.find(o => cell.label && o.label === cell.label && o.kind === cell.kind);
        if (!object) object = objects.find(o => cell.sourceHash && o.sourceHash === cell.sourceHash &&
            (!cell.kind || o.kind === cell.kind));
        if (!object) object = objects.find(o => cell.normalizedHash && o.normalizedHash === cell.normalizedHash &&
            (!cell.kind || o.kind === cell.kind));
        if (!object) return null;
        const a = object.sourceRange.startLine;
        const b = object.sourceRange.endLine;
        const line = Math.min(b, a + Math.max(0, Number(cell.lineOffset) || 0));
        let rects = this.objectRects(cell.file, line, line);
        if (!rects.length) rects = this.objectRects(cell.file, a, b);
        if (!rects.length) return null;
        return {
            page: rects[0].page,
            rects,
            viewportFrac: Number.isFinite(cell.viewportFrac) ? cell.viewportFrac : 0.35,
        };
    }

    /** Remember an editor selection without opening or focusing an editor. */
    _rememberCursor(doc, selection) {
        if (!this.root || !doc || !doc.uri || !selection || !selection.start || !selection.end) return;
        let root = null;
        try { root = this.coord.rootFor(doc); } catch (_) { root = doc.uri.fsPath; }
        if (root !== this.root) return;
        const pos = (p) => ({ line: Math.max(0, Number(p.line) || 0), character: Math.max(0, Number(p.character) || 0) });
        const cursor = {
            file: doc.uri.fsPath,
            anchor: pos(selection.anchor || selection.start),
            active: pos(selection.active || selection.end),
        };
        // Selection events can arrive for every arrow-key repeat. Update the
        // in-memory session immediately, but coalesce workspace-state writes.
        this._viewState = { ...(this._viewState || this._viewFor(this.root) || {}), cursor };
        this._cursorPending = { root: this.root, cursor };
        clearTimeout(this._cursorSaveTimer);
        this._cursorSaveTimer = setTimeout(() => this._flushCursorState(), 250);
    }

    _flushCursorState() {
        clearTimeout(this._cursorSaveTimer);
        this._cursorSaveTimer = null;
        const pending = this._cursorPending;
        this._cursorPending = null;
        if (pending) this._rememberState(pending.root, { cursor: pending.cursor });
    }

    /** Restore a saved source cursor only when that editor is already visible. */
    _restoreCursor(saved) {
        const c = saved && saved.cursor;
        if (!c || typeof c.file !== 'string') return false;
        const ed = (vscode.window.visibleTextEditors || [])
            .find(e => e.document && e.document.uri && e.document.uri.fsPath === c.file);
        if (!ed || !c.anchor || !c.active) return false;
        try {
            const a = new vscode.Position(c.anchor.line, c.anchor.character);
            const b = new vscode.Position(c.active.line, c.active.character);
            ed.selection = new vscode.Selection(a, b);
            return true;
        } catch (_) { return false; }
    }

    /** Save the open mini-editor and its caret/placement, or explicitly close it. */
    _rememberEditState(extra = {}) {
        if (!this.root) return;
        const s = this._edit;
        if (!s) { this._rememberState(this.root, { edit: null }); return; }
        const old = this._viewState && this._viewState.edit &&
            this._viewState.edit.file === s.file &&
            this._viewState.edit.startOffset === s.startOffset &&
            this._viewState.edit.endOffset === s.endOffset ? this._viewState.edit : {};
        const edit = {
            ...old,
            file: s.file,
            startOffset: s.startOffset,
            endOffset: s.endOffset,
            label: s.label || old.label || 'edit',
            ...extra,
        };
        if (edit.pos && !(Number.isFinite(edit.pos.fx) && Number.isFinite(edit.pos.fy))) delete edit.pos;
        this._rememberState(this.root, { edit });
    }

    /** Remember which paper this panel is showing, across a window reload. */
    _rememberRoot(root) {
        try { this.context.workspaceState.update(ROOT_KEY, root || undefined); }
        catch (_) { /* no workspace state: reload restores nothing, as before */ }
    }

    /**
     * Re-adopt the panel VS Code restored after a window reload.
     *
     * VS Code brings an open webview panel back by itself, but only as a
     * SHELL: without a registered serializer the extension never learns about
     * it, so it has no HTML, no message handler and no root — an empty
     * rectangle that never syncs again. That is what a reload used to leave.
     *
     * The root comes from workspace state, not from the webview: the page
     * cannot know which .tex it belongs to, and making it remember would put
     * the reader's own file path into restored web content.
     */
    async adopt(panel, state) {
        if (this.panel && this.panel !== panel) {
            // A live panel already exists; a second would fight it.
            try { panel.dispose(); } catch (_) { /* fine */ }
            return;
        }
        // Set this BEFORE replacing the webview HTML. Its script may answer
        // `ready` as soon as the event loop is yielded below.
        this._restoringPanel = true;
        this._wire(panel);
        this._autoHidden = null;
        let root = (state && state.root) || null;
        try { root = root || this.context.workspaceState.get(ROOT_KEY) || null; } catch (_) { /* none */ }
        // The webview may hand back its own state; workspace state is the
        // authority, because it survives the webview being dropped entirely.
        const panelState = state && typeof state === 'object' ? { ...state } : null;
        if (panelState) delete panelState.root;
        this._viewState = this._viewFor(root) || panelState;
        if (!root || !fs.existsSync(root)) {
            this._post({ type: 'status', text: 'reopen the paper from a .tex file', kind: 'warn' });
            return;
        }
        this.root = root;
        this._claimRestoredFullScreen();
        this._restoreCursor(this._viewState);
        this._postTheme();
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(root));
            // A reload drops every in-memory compile record, so there may be
            // nothing to show until one is rebuilt. The persisted generation
            // makes that instant whenever the out dir survived.
            const st = this.coord.stateFor(doc);
            if (!st || !st.generation) await this.coord.build(doc);
            await this.refresh({ force: true });
            this.syncFromEditor(vscode.window.activeTextEditor, { instant: true });
        } catch (e) {
            this._post({ type: 'status', text: `could not restore the paper: ${e.message}`, kind: 'err' });
        }
    }

    /**
     * Say that the paper is being rebuilt BECAUSE OF SOMETHING JUST DONE.
     *
     * A live rebuild while typing is deliberately quiet — one marker, no
     * chrome — because it happens hundreds of times a session and the reader
     * did not ask for it. A structural action is the opposite: folding a
     * section, cutting one, pasting into the page. The reader DID ask, the
     * paper is about to change under them, and nothing on screen said so
     * until the new PDF arrived, which on a real paper is seconds away.
     *
     * Cleared by the next refresh, whether it ships a new PDF or decides the
     * ink did not move — a spinner that outlives its work is worse than none.
     */
    _busy(text) {
        this._busyText = text;
        this._post({ type: 'status', text, kind: 'busy' });
    }

    _clearBusy(text, kind = '') {
        if (!this._busyText) return;
        this._busyText = null;
        this._post({ type: 'status', text, kind });
    }

    /** Push the current generation's PDF into the webview. */
    async refresh({ force = false } = {}) {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
        if (st && st.sourceAhead) {
            this._setTracePaused(true, {
                source: this._traceSource || 'editor',
                compiling: !!st.compiling,
            });
        } else if (st && this._tracePaused && st.generation &&
            this.shownGeneration === st.generation.generation) {
            // The source returned to the bytes already on screen (usually an
            // undo before the debounce fired). Nothing will be shipped, so
            // this is the only event that can resume tracing.
            const source = this._traceSource;
            this._setTracePaused(false);
            try { await this._resumeTracing({ instant: true, source }); } catch (_) { /* best effort */ }
        }
        if (!st || !st.generation || !st.generation.pdfPath) {
            this._post({
                type: 'status',
                text: st && st.compiling ? 'compiling the paper…' : 'no compiled PDF yet — press Compile',
                kind: st && st.compiling ? '' : 'err',
            });
            return;
        }
        // THE PAGES ON SCREEN MAY ALREADY BE THIS COMPILE'S PAGES.
        //
        // pdfHash is a CONTENT hash (compileService.pdfContentHash), so it is
        // not fooled by /CreationDate moving on every run. When it matches,
        // shipping would base64 the whole PDF, re-parse it in pdf.js, repaint
        // every visible canvas, sweep every page's text layer and drop every
        // glyph alignment — to arrive at the pixels already displayed. Typing a
        // comment, or a word that does not reflow its line, is exactly this.
        //
        // shownGeneration is deliberately NOT advanced here: it names the
        // generation whose BYTES the webview holds, and _text.generation and
        // _objMaps are keyed on it. Bumping it would invalidate the glyph maps
        // for nothing, which is the cost this branch exists to avoid.
        const decision = shipDecision({
            force,
            shownGeneration: this.shownGeneration,
            shownPdfHash: this.shownPdfHash,
            gen: st.generation,
        });
        if (!decision.ship) {
            if (decision.reason === 'identical pdf') {
                this._log(`generation ${st.generation.generation}: ${decision.reason} — nothing shipped`);
                this._clearBusy('the paper is unchanged');
                // The ink did not move, but the SOURCE did (that is why we
                // recompiled), so the map did. Re-answer from the new map
                // without disturbing the document the webview already holds —
                // this is the round trip the 'opened' handshake would have
                // triggered had we shipped.
                if (!st.sourceAhead) {
                    const source = this._traceSource;
                    this._setTracePaused(false);
                    try { await this._resumeTracing({ instant: true, source }); } catch (_) { /* best effort */ }
                }
                this._postEditAnchor().catch(() => { /* no open card */ });
                // The ink did not move, so the chips are still in the right
                // PLACES — but the source did, so which line each \ref sits on
                // may have changed. Drop the models, keep nothing else.
                this._chipModels = null;
                this._chips = null;
                if (this._labelsWanted) this._postLabels().catch(() => { /* best effort */ });
                this._postSections().catch(() => { /* best effort */ });
                this._pushComments(50);
            }
            return;
        }
        if (!fs.existsSync(st.generation.pdfPath)) {
            this._post({ type: 'status', text: 'the compiled PDF has gone missing', kind: 'err' });
            return;
        }
        const t0 = Date.now();
        // Capture at the last responsible moment. Scroll reports are
        // debounced, and an external editor can finish a compile before the
        // last report arrived. The reply names the OLD displayed generation;
        // _rememberView resolves it through prevMap after the coordinator has
        // already installed the new one.
        await this._captureReaderView();
        // In memory if this panel has been showing the paper; from workspace
        // state if it is being opened again, or after a reload.
        const place = this._viewState || this._viewFor(this.root);
        const semanticReveal = place && this._viewCellPlacement(place.viewCell);
        this.shownGeneration = st.generation.generation;
        this._busyText = null;   // the new pages ARE the answer; the panel says the rest
        this.panel.title = `WPaper · ${path.basename(this.root)}`;
        const w = this.panel.webview;

        // THE PDF GOES ACROSS AS BYTES, NOT AS A URL.
        //
        // Compiles run out-of-tree in os.tmpdir(), and on macOS that is
        // `/var/folders/...` — a symlink to `/private/var/folders/...`. A
        // `localResourceRoots` entry built from `os.tmpdir()` does not match
        // the realpath VS Code resolves the resource to, so `asWebviewUri`
        // produces a URL the webview silently refuses to fetch: no error, no
        // pages, just an empty panel. Handing pdf.js the bytes removes the
        // whole class of problem (roots, symlinks, sandbox rules) and costs one
        // copy per compile, which is nothing beside a 17 s LaTeX run.
        let data = null;
        const tRead = Date.now();
        try { data = fs.readFileSync(st.generation.pdfPath).toString('base64'); }
        catch (e) {
            this._post({ type: 'status', text: `could not read the PDF: ${e.message}`, kind: 'err' });
            return;
        }
        const readMs = Date.now() - tRead;
        this._post({
            type: 'open',
            base: w.asWebviewUri(vscode.Uri.joinPath(
                this.context.extensionUri, 'out', 'client', 'pdfjs')).toString(),
            pdfBase64: data,
            generation: st.generation.generation,
            pdfHash: st.generation.pdfHash || null,
            pages: st.generation.pageCount,
            // WHERE THE READER WAS — the page AND how far down it.
            //
            // Only the page number used to travel, so coming back from another
            // tab, or from a window reload, landed at the TOP of the right page
            // rather than at the paragraph being worked on. Reported as the
            // scroll position not persisting.
            revealPage: place && place.page,
            revealFrac: place && place.frac,
            revealLeft: place && place.left,
            revealXFrac: place && place.xFrac,
            // A raw vertical pixel is exact only against the same PDF
            // generation. For a changed paper the page/fraction address above
            // survives reflow and is therefore the honest fallback.
            revealTop: place && place.generation === st.generation.generation
                ? place.top : undefined,
            semanticReveal,
            restoreView: place ? {
                scale: place.scale,
                fit: place.fit === true,
            } : null,
            // A live rebuild replaces the pages under a reader who did not ask
            // for it, so the viewer keeps their scroll position and swaps each
            // canvas only once its replacement is drawn.
            live: !!st.generation.live && this.shownAnything,
        });
        this.shownAnything = true;
        // What the webview now holds — the key the next refresh compares.
        this.shownPdfHash = st.generation.pdfHash || null;
        this._post({ type: 'setFollow', mode: this.followMode });
        this._postEditStack();
        // SAY WHEN THE PAGE IS ONE PASS BEHIND ITSELF.
        //
        // A new \label prints `??` until the .aux this run wrote has been read
        // by the next one. The background convergence is already scheduled
        // (renderUi._armAuthoritative), but a reader looking at `??` with
        // nothing said cannot tell a lagging reference from a broken one —
        // which is the whole difficulty of the reported bug.
        if (st.generation.rerunWanted || st.generation.passesLimited) {
            this._post({
                type: 'status', kind: '',
                text: 'cross-references are one pass behind — refreshing in the background',
            });
        }
        // WHICH SECTIONS ARE FOLDED AWAY. Not gated on Shift: a section that is
        // simply missing from the paper, with nothing saying so, is the worst
        // thing this feature could do to a reader.
        this._postSections().catch(() => { /* best effort */ });
        this._log(`sent generation ${st.generation.generation} ` +
            `(${(data.length / 1398101).toFixed(2)} MB of PDF) in ${Date.now() - t0} ms ` +
            `· read ${readMs} ms`);
    }

    /**
     * Recompile the paper THIS PANEL is showing.
     *
     * The toolbar's Compile button used to run `wolfbook.tex.compile`, which
     * begins `const doc = vscode.window.activeTextEditor?.document`. Pressing a
     * button inside a webview means focus is in the webview, so there IS no
     * active text editor: the command warned "Open a .tex file first" into the
     * corner of the screen and the button appeared to do nothing at all. Same
     * root cause as the repaint bug — see makePaintRender in index.js.
     *
     * The panel knows which root it is showing, so it asks for that one.
     */
    async rebuild() {
        if (!this.root) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.root));
            this._post({ type: 'status', text: 'compiling the paper…' });
            const st = await this.coord.build(doc, { force: true });
            if (st && st.lastError) {
                this._post({ type: 'status', text: `compile failed: ${st.lastError}`, kind: 'err' });
            } else if (st && st.generation) {
                const g = st.generation;
                this._post({
                    type: 'status',
                    text: `${g.pageCount ?? '?'} pages · ${g.errors} error(s) · ${g.warnings} warning(s)`,
                    kind: g.errors ? 'warn' : 'ok',
                });
            }
            await this.refresh({ force: true });
        } catch (e) {
            this._post({ type: 'status', text: `could not compile: ${e.message}`, kind: 'err' });
        }
    }

    // --- theme ---------------------------------------------------------------

    /** Is the reader's VS Code theme a dark one? */
    _themeIsDark() {
        const K = vscode.ColorThemeKind || {};
        const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
        // Dark = 2, HighContrast = 3 in every published build; HighContrastLight
        // (4) was added later, so it is named rather than assumed absent.
        if (kind === K.Light || kind === 1) return false;
        if (kind === K.HighContrastLight || kind === 4) return false;
        return kind === K.Dark || kind === K.HighContrast || kind === 2 || kind === 3;
    }

    /**
     * How the PAGES should be shown, which is a separate question from how the
     * panel's chrome should be.
     *
     * A paper is a printed artefact and some readers want it to look printed
     * whatever the editor looks like — and darkening works by inverting the
     * rendered image, so a photograph comes out as a negative. Hence three
     * states rather than a boolean, with `auto` following the theme.
     */
    pageTheme() {
        const want = vscode.workspace.getConfiguration('wolfbook.tex').get('pageTheme', 'auto');
        if (want === 'light' || want === 'dark') return want;
        return this._themeIsDark() ? 'dark' : 'light';
    }

    _postTheme() {
        if (!this.panel) return;
        this._post({
            type: 'theme',
            dark: this._themeIsDark(),
            pages: this.pageTheme(),
            setting: vscode.workspace.getConfiguration('wolfbook.tex').get('pageTheme', 'auto'),
        });
    }

    /**
     * The toolbar's sun/moon. It writes the SETTING rather than holding a
     * session-only override: a reader who turns the pages white means it next
     * time too, and one source of truth keeps the Settings UI honest.
     */
    async _setPageTheme(value) {
        const v = ['auto', 'light', 'dark'].includes(value) ? value : 'auto';
        try {
            await vscode.workspace.getConfiguration('wolfbook.tex')
                .update('pageTheme', v, vscode.ConfigurationTarget.Global);
        } catch (e) {
            this._post({ type: 'status', text: `could not save the page theme: ${e.message}`, kind: 'warn' });
        }
        this._postTheme();       // configuration events can lag; say it now
    }

    /**
     * Is the caret inside a `\caption{…}`?
     *
     * Scanned backwards a few lines and brace-matched forward, rather than
     * asked of the model: a caption is not an object, and the float that
     * contains it cannot say which of its lines are prose.
     */
    /**
     * THE BRACED RUN OF PROSE A POSITION IS INSIDE, if it is inside one.
     *
     * A caption, a section title and the paper's title are all the same shape:
     * prose written inside `{...}`, possibly over several source lines, which
     * TeX then typesets as one block and files under a SINGLE line of it. Which
     * line is not predictable — figure 2's eleven-line caption is filed
     * entirely under its LAST line, the one holding the closing brace — so
     * every one of the other lines has no ink of its own and answers "unmapped".
     *
     * MEASURED (check-paper.mjs, page 2 of the reference paper): 38 of the 59
     * failing words posted a highlight with NO RECTANGLES AT ALL. Nothing lit
     * up, which is the reported "caption of figures does not work"; the same
     * fact one step earlier is what made a click select the whole float.
     *
     * So the unit for these is the BLOCK, not the source line: its rows are the
     * region to search, and the word's occurrence is counted across it.
     *
     * @returns {{startLine:number, endLine:number}|null} 1-based, inclusive
     */
    _proseBlock(doc, line, column) {
        try {
            const from = Math.max(1, line - 40);
            const starts = [];
            let text = '';
            for (let n = from; n <= Math.min(doc.lineCount, line + 40); n++) {
                starts[n] = text.length;
                text += doc.lineAt(n - 1).text + '\n';
            }
            if (starts[line] == null) return null;
            const at = starts[line] + Math.max(0, column);
            const mask = commentMask(text);
            const lineOf = (off) => {
                let n = from;
                for (let k = from; k <= Math.min(doc.lineCount, line + 40); k++) {
                    if (starts[k] == null || starts[k] > off) break;
                    n = k;
                }
                return n;
            };
            const re = /\\(caption|title|part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(\[[^\]]*\])?\s*\{/g;
            let m;
            let best = null;
            while ((m = re.exec(text))) {
                const open = m.index + m[0].length - 1;
                if (mask[open]) continue;
                const close = closeFor(text, mask, open);
                if (close < 0) continue;
                if (at <= open || at > close) continue;
                // The TIGHTEST enclosing one, so a \caption inside a figure
                // beats nothing and a nested group beats its parent.
                if (!best || open > best.open) best = { open, close };
            }
            if (!best) return null;
            return { startLine: lineOf(best.open), endLine: lineOf(best.close) };
        } catch (_) { /* a guess that throws is a guess of no */ }
        return null;
    }

    /** Is this position inside a float's caption? Captions are prose. */
    _inCaption(doc, line, column) {
        try {
            const from = Math.max(1, line - 40);
            const starts = [];
            let text = '';
            for (let n = from; n <= Math.min(doc.lineCount, line + 40); n++) {
                starts[n] = text.length;
                text += doc.lineAt(n - 1).text + '\n';
            }
            if (starts[line] == null) return false;
            const at = starts[line] + Math.max(0, column);
            const mask = commentMask(text);
            const re = /\\caption\s*(\[[^\]]*\])?\s*\{/g;
            let m;
            while ((m = re.exec(text))) {
                const open = m.index + m[0].length - 1;
                if (mask[open]) continue;
                const close = closeFor(text, mask, open);
                if (close < 0) continue;
                if (at > open && at <= close) return true;
            }
        } catch (_) { /* a guess that throws is a guess of no */ }
        return false;
    }

    /** Every row printed by the lines of a block, as one search region. */
    _blockRows(st, file, block) {
        const rows = [];
        for (let n = block.startLine; n <= block.endLine; n++) {
            let rs = [];
            try { rs = st.map.lineRows(file, n) || []; } catch (_) { rs = []; }
            for (const r of rs) rows.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, line: n });
        }
        return mergeRows(dropStrayRows(clipToSpan(rows)));
    }
    /**
     * The macro table for a document, rebuilt only when the document changes.
     *
     * Without it the projection cannot see through \bx or \SoV, and a real
     * paper's equations project to almost nothing — which is what made every
     * click in an equation select the whole equation.
     */
    _macrosFor(doc) {
        const key = doc.uri.fsPath;
        const hit = this._macros.get(key);
        if (hit && hit.version === doc.version) return hit.table;
        let table = new Map();
        try { table = collectMacros(doc.getText()); } catch (_) { /* none is fine */ }
        this._macros.set(key, { version: doc.version, table });
        return table;
    }

    _log(msg) { try { if (this.coord && this.coord.log) this.coord.log(msg); } catch (_) { /* fine */ } }

    /** Lock the viewer's editor group so other files cannot open into it. */
    async _lockGroup() {
        if (!this.panel) return;
        if (!vscode.workspace.getConfiguration('wolfbook.tex').get('lockViewerGroup', true)) return;
        const all = new Set(await vscode.commands.getCommands(true));
        const cmd = ['workbench.action.lockEditorGroup', 'workbench.action.toggleEditorGroupLock']
            .find(c => all.has(c));
        if (!cmd) return;
        const back = vscode.window.activeTextEditor;
        this.panel.reveal(this.panel.viewColumn, false);      // lock acts on the ACTIVE group
        try { await vscode.commands.executeCommand(cmd); } catch (_) { /* not fatal */ }
        // Give the keyboard back to whoever had it; the reader asked for a
        // paper next to their text, not a focus change.
        if (back) {
            try { await vscode.window.showTextDocument(back.document, { viewColumn: back.viewColumn, preserveFocus: false }); }
            catch (_) { /* fine */ }
        }
    }

    /**
     * Put the paper away while the reader is not in a .tex, and bring it back
     * when they are.
     *
     * A Page view pinned open beside an unrelated file is just clutter, and it
     * invites exactly the mess this is meant to avoid. Hiding is a real close —
     * VS Code has no way to hide a webview panel — so the scroll position is
     * kept and restored, which is the only part the reader would miss.
     */
    async autoHide() {
        if (!this.panel || this._autoHidden) return;
        this._autoHidden = { root: this.root, at: Date.now() };
        const p = this.panel;
        this.panel = null;                 // dispose() must not run the teardown twice
        this.shownGeneration = null;
        this.shownPdfHash = null;
        try { p.dispose(); } catch (_) { /* already gone */ }
    }

    /** Was this panel closed by us rather than by the reader? */
    get autoHidden() { return !!this._autoHidden; }

    async autoRestore(doc) {
        // ALREADY OPEN ON ANOTHER PAPER IS THE COMMON CASE, and it used to do
        // nothing at all: this returned early whenever a panel existed, so
        // switching from one .tex tab to another left the viewer showing the
        // paper you had just left. Reported as "changing tex files does not
        // switch the viewer to the new source".
        //
        // Re-opening is guarded on the ROOT, not the file: two files of one
        // project share a paper, and re-opening on every tab change within it
        // would throw away the reader's place and recompile for nothing.
        if (this.panel) {
            let root = null;
            try { root = this.coord.rootFor(doc); } catch (e) {
                this._log(`follow: cannot resolve a root for ${path.basename(doc.uri.fsPath)}: ${e.message}`);
                root = null;
            }
            // `this.root` is NOT required to be set. It is null for a panel VS
            // Code restored from a previous window, and requiring it meant the
            // viewer sat there showing a paper it could not name and refusing
            // to follow anything — the switch silently did nothing.
            if (root && root !== this.root) {
                this._log(`follow: ${this.root ? path.basename(this.root) : '(none)'} -> ${path.basename(root)}`);
                await this.open(doc, { reveal: true });
                return;
            }
            // Same paper. Two files of one project SHARE a root, and re-opening
            // between them would throw away the reader's place and recompile
            // for nothing — but the title still names the file being edited.
            this._retitle(doc);
            return;
        }
        if (!this._autoHidden) return;
        this._autoHidden = null;
        await this.open(doc, { reveal: true });
    }

    /**
     * Keep the panel's title on the file the reader is in.
     *
     * Within one project the root does not change as they move between files,
     * so nothing reloads — but a title still naming the file they left is the
     * viewer looking unpaired even when it is showing the right paper.
     */
    _retitle(doc) {
        if (!this.panel || !doc) return;
        try {
            const name = path.basename(doc.uri.fsPath);
            const want = `WPaper · ${name}`;
            if (this.panel.title !== want) this.panel.title = want;
        } catch (_) { /* a title is not worth an exception */ }
    }

    /** Is the Page view actually on screen? Live rebuilds are for it alone. */
    isOpen() { return !!this.panel; }

    // --- the review: what the agent changed, waiting for a verdict -----------
    //
    // The panel draws the list and posts the reader's answers; everything else
    // — the session, the baseline, the decorations, the edits — belongs to
    // tex/reviewUi.js. This class only carries messages, which is what keeps
    // the list identical whether it is answered from the page, the editor's
    // CodeLens, the command palette or the status bar.

    // --- the tour: learned by doing, on the reader's own paper ---------------
    //
    // Opened once, the first time a paper is shown, and never again unless it
    // is asked for. Each step advances when the READER PERFORMS THE GESTURE —
    // the panel already reports every one of them — so a reader who abandons
    // the tour halfway has still done the half they saw.

    get _tourState() {
        const g = this.context && this.context.globalState;
        const v = (g && g.get(TOUR_KEY)) || {};
        return { at: Number(v.at) || 0, done: !!v.done, started: !!v.started };
    }

    _tourSave(next) {
        const g = this.context && this.context.globalState;
        if (!g) return;
        try { g.update(TOUR_KEY, { ...this._tourState, ...next }); } catch (_) { /* not fatal */ }
    }

    /** What this paper can actually demonstrate right now. */
    _tourContext() {
        const st = this.root && this.coord.roots.get(this.root);
        let hasLabels = false;
        let hasSections = false;
        let hasAnchors = false;
        try {
            const model = st && this._modelFor2(this.root);
            const objs = (model && model.objects) || [];
            hasLabels = objs.some(o => o.label || (o.kind === 'label' && o.name));
            hasSections = objs.some(o => o.kind === 'section-heading');
            // A tag hangs on any anchor, and an equation is the commonest one:
            // a paper with no sectioning at all can still have somewhere worth
            // pointing an agent at.
            hasAnchors = hasSections || objs.some(o => o.kind === 'display-equation');
        } catch (_) { /* a paper we cannot model teaches only the gestures */ }
        return {
            hasLabels, hasSections, hasAnchors,
            hasReview: !!(this._review && this._review.sessionFor(this.root)),
        };
    }

    /** Begin (or resume) the tour. `restart` starts it from the top again. */
    startTour(restart = false) {
        if (restart) this._tourSave({ at: 0, done: false, started: true });
        else this._tourSave({ started: true });
        this._tourPost();
    }

    _tourPost() {
        if (!this.panel) return;
        const step = stepAt(this._tourState, this._tourContext());
        this._post({ type: 'tour', step });
        if (!step) this._tourSave({ done: true });
    }

    /**
     * A message came in: if it is what the current step asked for, move on.
     * Called for the panel's own messages and for `{type:'cursor'}`, which the
     * forward sync raises — the editor half of the gesture set has no webview
     * message of its own.
     */
    _tourObserve(ev) {
        const state = this._tourState;
        if (!state.started || state.done || !this.panel) return;
        const step = stepAt(state, this._tourContext());
        if (!step || !satisfies(step, ev)) return;
        this._tourSave({ at: state.at + 1 });
        // A beat, so the reader sees the thing they just did happen before the
        // card moves on to the next one.
        clearTimeout(this._tourTimer);
        this._tourTimer = setTimeout(() => this._tourPost(), 550);
    }

    _tourAction(m) {
        const state = this._tourState;
        if (m.action === 'close') {
            this._tourSave({ done: true });
            this._post({ type: 'tour', step: null });
            this._post({ type: 'status', text: 'the tour is in the palette: "WPaper: Show Me Around"', kind: '' });
            return;
        }
        if (m.action === 'skip' || m.action === 'next') {
            this._tourSave({ at: state.at + 1 });
            this._tourPost();
        }
    }

    /** How the review list is collated: the reader's last choice, or sections. */
    _reviewGroup() {
        try {
            const v = this.context && this.context.globalState && this.context.globalState.get(GROUP_KEY);
            return v === 'arrival' ? 'arrival' : 'section';
        } catch (_) { return 'section'; }
    }

    attachReview(review) { this._review = review; }

    /** Is the reader looking at the list right now? (the toast asks) */
    get reviewVisible() { return !!(this.panel && this.panel.visible && this._reviewShown); }

    /** One full-state message, the pattern the comparison already uses. */
    showReview(payload) {
        this._reviewShown = !!(payload && payload.pending);
        if (!payload || !payload.focus) {
            this._reviewFocus = null;
            if (this._reviewWaiting) {
                this._reviewWaiting = false;
                this.status('', '');
            }
        } else {
            const h = (payload.groups || []).flatMap(g => g.hunks || [])
                .find(x => x.id === payload.focus);
            // A pending click survives the short source -> compile -> pdf.js
            // gap, but its OLD rectangles do not. Replace them from every
            // freshly placed payload and send only when that render is open.
            if (h && this._reviewFocus && this._reviewFocus.pending &&
                this._reviewFocus.id === h.id) {
                this._reviewFocus = {
                    ...h, generation: payload.generation, pending: true,
                };
            }
        }
        this._post({ type: 'review', session: payload || null });
        this._replayReviewFocus();
    }

    /** Bring the paper forward with the list open. */
    async openReview() {
        if (!this.panel) {
            const doc = (vscode.workspace.textDocuments || [])
                .find(d => d.uri && d.uri.fsPath === this.root) ||
                (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
            if (doc) { try { await this.open(doc); } catch (_) { /* it may be mid-open */ } }
        }
        if (this.panel) { try { this.panel.reveal(undefined, true); } catch (_) { /* fine */ } }
        this._post({ type: 'reviewOpen' });
    }

    /** Scroll the page to a change and mark it there. */
    focusReviewHunk(h, generation = null) {
        if (!h) return false;
        // Remember the INTENT, independently of the rectangles. A worker
        // recovery or external compile can legitimately put the click between
        // documents; showReview replaces the geometry before replaying it.
        this._reviewFocus = { ...h, generation, pending: true };
        return this._replayReviewFocus();
    }

    _replayReviewFocus() {
        const h = this._reviewFocus;
        if (!h || !h.pending) return false;
        if (h.generation == null || this._openedGeneration == null ||
            String(h.generation) !== String(this._openedGeneration)) {
            this._reviewWaiting = true;
            this.status('updating the page for this change…', 'busy');
            return false;
        }
        this._post({
            type: 'reviewFocus', id: h.id, page: h.page, rects: h.rects || [],
            generation: h.generation,
        });
        h.pending = false;
        if (this._reviewWaiting) {
            this._reviewWaiting = false;
            this.status('', '');
        }
        return true;
    }

    _cancelViewerProbes(reason) {
        for (const done of this._viewerProbes.values()) {
            try { done({ ok: false, reason }); } catch (_) { /* already settled */ }
        }
        this._viewerProbes.clear();
    }

    _finishViewerProbe(m) {
        const done = this._viewerProbes.get(m && m.requestId);
        if (!done) return;
        this._viewerProbes.delete(m.requestId);
        done(m);
    }

    /** Ask the webview to prove both its document and worker still answer. */
    _probeViewer(page, generation = this._openedGeneration) {
        if (!this.panel) return Promise.resolve({ ok: false, reason: 'viewer is closed' });
        const requestId = `viewer-${Date.now().toString(36)}-${++this._viewerProbeSeq}`;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (answer) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._viewerProbes.delete(requestId);
                resolve(answer);
            };
            const timer = setTimeout(() => finish({ ok: false, reason: 'viewer did not answer' }), 1700);
            this._viewerProbes.set(requestId, finish);
            try {
                const sent = this.panel.webview.postMessage({
                    type: 'viewerProbe', requestId, page: page || 1,
                    // Health and placement both concern what pdf.js has
                    // ACKNOWLEDGED, not a newer document still in flight.
                    generation,
                });
                Promise.resolve(sent).then(ok => {
                    if (ok === false) finish({ ok: false, reason: 'viewer refused the health check' });
                }, () => finish({ ok: false, reason: 'viewer health check failed' }));
            } catch (e) {
                finish({ ok: false, reason: e && e.message ? e.message : String(e) });
            }
        });
    }

    /** Replace the webview document: this terminates the old pdf.js worker. */
    _reloadViewer(reason) {
        if (!this.panel || this._viewerReloading) return;
        this._viewerReloading = true;
        clearTimeout(this._viewerReloadTimer);
        // A malformed PDF may prevent `opened` forever. Do not let one failed
        // recovery disable health checks for the rest of the panel's life.
        this._viewerReloadTimer = setTimeout(() => {
            this._viewerReloading = false;
            this._viewerReloadTimer = null;
        }, 15000);
        if (this._viewerReloadTimer && this._viewerReloadTimer.unref) this._viewerReloadTimer.unref();
        this._cancelViewerProbes('viewer is restarting');
        this._log(`viewer recovery: ${reason || 'health check failed'}`);
        this._post({ type: 'status', text: 'restarting the PDF viewer…', kind: 'busy' });
        // The next `ready` forces the current PDF across. Mark this as a fresh
        // surface so it does not use live-swap assumptions about canvases that
        // belonged to the dead webview.
        this.shownGeneration = null;
        this.shownPdfHash = null;
        this._openedGeneration = null;
        this._openedPdfHash = null;
        this.shownAnything = false;
        this._text = null;
        this._objMaps.clear();
        this._traceStateKey = null;
        try { this.panel.webview.html = this._html(); }
        catch (e) {
            this._viewerReloading = false;
            clearTimeout(this._viewerReloadTimer);
            this._viewerReloadTimer = null;
            this._post({ type: 'status', text: `could not restart the PDF viewer: ${e.message}`, kind: 'err' });
        }
    }

    async _ensureViewerForReview(h, generation = this._openedGeneration) {
        if (!this.panel || this._viewerReloading) return false;
        // A different PDF is already on its way. Probing the old, healthy
        // worker would bless the wrong document; restarting it would only make
        // the race longer. The pending focus is replayed by `opened` instead.
        if (generation == null || this._openedGeneration == null ||
            String(generation) !== String(this._openedGeneration)) {
            this.status('updating the page for this change…', 'busy');
            try { await this.refresh(); } catch (_) { /* compile/open already owns it */ }
            return false;
        }
        const health = await this._probeViewer(h && h.page, generation);
        if (!health || !health.ok) this._reloadViewer(health && health.reason);
        return !!(health && health.ok);
    }

    /** A line in the panel's footer — the review speaks to the reader here. */
    status(text, kind) { this._post({ type: 'status', text, kind: kind || '' }); }

    /**
     * The editor buffer is newer than the PDF currently painted in the panel.
     * Called on EVERY content edit, including same-line typing. The old marker
     * is cleared in the webview by this message, before the selection event
     * produced by that keystroke can try to resolve against stale text.
     */
    noteSourceChanged(doc) {
        if (!this.panel || !doc || !doc.uri || !this.root) return false;
        let root = null;
        try { root = this.coord.rootFor(doc); } catch (_) { root = doc.uri.fsPath; }
        if (root !== this.root) return false;
        this._postSourceDirty();
        const source = this._miniApplyingFile === doc.uri.fsPath ? 'mini-editor' : 'editor';
        const st = this.coord.roots && this.coord.roots.get(this.root);
        this._setTracePaused(true, { source, compiling: !!(st && st.compiling) });
        return true;
    }

    /** Every open, unsaved TeX buffer belonging to the paper on screen. */
    _dirtyPaperDocuments() {
        if (!this.root) return [];
        const out = [];
        for (const doc of vscode.workspace.textDocuments || []) {
            if (!doc || !doc.isDirty || !doc.uri || !/\.tex$/i.test(doc.uri.fsPath || '')) continue;
            let root = null;
            try { root = this.coord.rootFor(doc); } catch (_) { root = doc.uri.fsPath; }
            if (root === this.root) out.push(doc);
        }
        return out;
    }

    /** Report disk persistence separately from whether the PDF has caught up. */
    _postSourceDirty(force = false) {
        if (!this.panel) return;
        const docs = this._dirtyPaperDocuments();
        const files = docs.map(d => path.basename(d.uri.fsPath));
        const key = `${docs.length}:${files.join('|')}`;
        if (!force && key === this._sourceDirtyKey) return;
        this._sourceDirtyKey = key;
        this._post({ type: 'sourceDirty', dirty: docs.length > 0, count: docs.length, files });
    }

    /** Saving one include may still leave another include dirty. Recount all. */
    noteSourceSaved(doc) {
        if (!this.panel || !doc || !doc.uri || !this.root) return false;
        let root = null;
        try { root = this.coord.rootFor(doc); } catch (_) { root = doc.uri.fsPath; }
        if (root !== this.root) return false;
        this._postSourceDirty(true);
        return true;
    }

    /** Save every dirty source buffer in this paper from the viewer badge. */
    async _savePaperSources() {
        const docs = this._dirtyPaperDocuments();
        if (!docs.length) {
            this._postSourceDirty(true);
            this._post({ type: 'status', text: 'source is already saved', kind: 'ok' });
            return true;
        }
        let saved = 0;
        for (const doc of docs) {
            try { if (await doc.save()) saved++; }
            catch (_) { /* report the remaining dirty buffers below */ }
        }
        this._postSourceDirty(true);
        const remaining = this._dirtyPaperDocuments().length;
        if (remaining) {
            this._post({
                type: 'status', kind: 'err',
                text: `could not save ${remaining} source${remaining === 1 ? '' : 's'}`,
            });
            return false;
        }
        this._post({
            type: 'status', kind: 'ok',
            text: `saved ${saved} source${saved === 1 ? '' : 's'} to disk`,
        });
        return true;
    }

    _setTracePaused(paused, { source, compiling } = {}) {
        const next = !!paused;
        if (next && source) this._traceSource = source;
        if (!next) this._traceSource = null;
        this._tracePaused = next;
        const msg = {
            type: 'traceState',
            paused: next,
            source: next ? (this._traceSource || 'editor') : null,
            compiling: next && !!compiling,
        };
        const key = `${msg.paused}:${msg.source || ''}:${msg.compiling}`;
        if (key === this._traceStateKey) return;
        this._traceStateKey = key;
        this._post(msg);
    }

    /** Re-answer from the current caret after the matching page is visible. */
    async _resumeTracing({ instant = true, source = null, preserveView = false } = {}) {
        // A REBUILD IS NOT NAVIGATION.
        //
        // While focus is inside the page's mini-editor, VS Code still reports
        // some ordinary .tex editor as active. It may be another included file
        // with a caret many pages away. Giving that stale caret first refusal
        // after the PDF swap correctly restored the viewport and then promptly
        // scrolled it elsewhere. The source of the edit is remembered while
        // tracing is paused; use the card's own caret when it caused the build,
        // and redraw it without moving the paper.
        if (source === 'mini-editor' && this._lastEditCaret && this._edit &&
            this._lastEditCaret.editId === this._edit.id) {
            await this._onEditCaret(this._lastEditCaret, {
                forceSync: true,
                preserveView: true,
                instant,
            });
            return;
        }
        const ed = vscode.window.activeTextEditor;
        // Preserve the ordinary re-answer even when a webview has focus and
        // VS Code reports no activeTextEditor; syncFromEditor treats that as a
        // harmless no-op, while test/instrumentation hooks can still observe
        // that a refresh requested the answer.
        if (!ed) this.syncFromEditor(ed, { instant, preserveView });
        if (ed && ed.document && /\.tex$/i.test(ed.document.uri.fsPath)) {
            let root = null;
            try { root = this.coord.rootFor(ed.document); } catch (_) { root = ed.document.uri.fsPath; }
            if (root === this.root) {
                this.syncFromEditor(ed, { instant, preserveView });
                return;
            }
        }
        if (this._lastEditCaret && this._edit && this._lastEditCaret.editId === this._edit.id) {
            await this._onEditCaret(this._lastEditCaret);
            return;
        }
        // Full-view mode intentionally has no visible source editor. The
        // source caret is still part of the saved reading session, so a viewer
        // restart must be able to redraw it without exposing or focusing the
        // editor merely to obtain a Selection object.
        const saved = this._viewState && this._viewState.cursor;
        if (saved && saved.file && saved.anchor && saved.active) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(saved.file));
                let root = null;
                try { root = this.coord.rootFor(doc); } catch (_) { root = doc.uri.fsPath; }
                if (root === this.root) {
                    const a = new vscode.Position(saved.anchor.line, saved.anchor.character);
                    const b = new vscode.Position(saved.active.line, saved.active.character);
                    this.syncFromEditor({ document: doc, selection: new vscode.Selection(a, b) },
                        { instant, preserveView });
                }
            } catch (_) { /* the saved file may have been removed */ }
        }
    }

    async _onReviewAction(m) {
        const r = this._review;
        const file = this.root;
        if (!r || !file) return;
        switch (m && m.action) {
            case 'keep': return r.keep(file, m.id);
            case 'keepComment': return r.keepWithComment(file, m.id);
            case 'feedback': return r.exportFeedback(file);
            case 'copyFeedback': {
                if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text); this.status('Review feedback copied', 'ok'); }
                return;
            }
            case 'feedbackDraft': {
                const session = r.sessions.get(file) || r._archived.get(file);
                if (session && typeof m.text === 'string') { session.feedbackDraft = m.text; r.persist(file, session); }
                return;
            }
            case 'history': return r.exportHistory(file);
            case 'undo': return r.undo(file, m.id);
            case 'keepAll': return r.keepAll(file);
            case 'undoAll': return r.undoAll(file);
            case 'keepBatch': return r.keepBatch(file, m.batch);
            case 'keepMany': return r.keepMany(file, m.ids);
            case 'show': {
                const session = r.sessions && r.sessions.get(file);
                const h = session && session.hunks && session.hunks.find(x => x.id === m.id);
                await this._ensureViewerForReview(h, session && session.generation);
                return r.show(file, m.id);
            }
            case 'next': return r.step(file, +1);
            case 'prev': return r.step(file, -1);
            case 'close': return r.close(file);
            default: return undefined;
        }
    }

    // ------------------------------------------------------------- comments --

    /** Every source file represented by the paper currently on screen. */
    _commentFiles() {
        if (!this.root) return [];
        const st = this.coord.roots && this.coord.roots.get(this.root);
        return [...new Set((st && st.files && st.files.length) ? st.files : [this.root])];
    }

    /** Current semantic objects without opening an editor just to read them. */
    _commentObjects(file) {
        try {
            const doc = (vscode.workspace.textDocuments || [])
                .find(d => d.uri && d.uri.fsPath === file && !d.isClosed);
            if (doc) return this.projection.get(doc).model.objects || [];
            const text = fs.readFileSync(file, 'utf8');
            const model = this.projection.fromText(text, file);
            return model && model.objects || [];
        } catch (_) { return []; }
    }

    /**
     * The persistent comment cell containing a source line.
     *
     * Metadata objects (labels, refs, inputs) are not writing units. Prefer a
     * paragraph, otherwise the tightest semantic block. Very short prose that
     * the scanner intentionally omits still gets a paragraph cell synthesized
     * from the same paragraph boundaries the viewer's mini-editor uses.
     */
    _commentObject(doc, line, preferred) {
        const objects = this._commentObjects(doc.uri.fsPath);
        if (preferred && preferred.stableKey) {
            const exact = objects.find(o => o.stableKey === preferred.stableKey);
            if (exact) return exact;
        }
        if (preferred && preferred.sourceHash) {
            const exact = objects.find(o => o.sourceHash === preferred.sourceHash &&
                (!preferred.kind || o.kind === preferred.kind));
            if (exact) return exact;
        }
        const candidates = objects.filter(o => ADDRESSABLE.has(o.kind) && o.sourceRange &&
            line >= o.sourceRange.startLine && line <= o.sourceRange.endLine);
        const priority = o => o.kind === 'paragraph' ? 0
            : ['display-equation', 'figure', 'table', 'tabular', 'theorem'].includes(o.kind) ? 1
                : ['abstract', 'titlepage'].includes(o.kind) ? 2
                    : o.kind === 'environment' ? 4 : 3;
        candidates.sort((a, b) => {
            const ap = priority(a); const bp = priority(b);
            if (ap !== bp) return ap - bp;
            const ar = a.sourceRange.endLine - a.sourceRange.startLine;
            const br = b.sourceRange.endLine - b.sourceRange.startLine;
            return ar - br;
        });
        if (candidates.length) return candidates[0];

        const lines = doc.getText().split(/\r?\n/);
        const span = paragraphSpan(lines, Math.max(1, line));
        const startLine = span ? span.startLine : Math.max(1, line);
        const endLine = span ? span.endLine : startLine;
        const start = new vscode.Position(startLine - 1, 0);
        const last = Math.max(0, Math.min(endLine - 1, doc.lineCount - 1));
        const end = new vscode.Position(last, doc.lineAt(last).text.length);
        return {
            kind: 'paragraph', label: null, stableKey: null, sectionPath: [],
            text: doc.getText(new vscode.Range(start, end)),
            sourceRange: { file: doc.uri.fsPath, startLine, endLine,
                startOffset: doc.offsetAt(start), endOffset: doc.offsetAt(end) },
        };
    }

    /** Disposable PDF geometry for one persistent comment cell. */
    _commentRects(st, item) {
        const block = {
            startLine: item.line,
            endLine: Number.isFinite(item.endLine) ? item.endLine : item.line,
        };
        // SyncTeX sometimes files a section command under the page ship-out
        // record (`x=0`, one margin wide) instead of under its printed title.
        // Treating that as real is what put a mid-paper heading comment at the
        // top of page 1. Other cell kinds keep their old, less opinionated
        // geometry: this filter exists for the measured heading pathology.
        const credible = (rows) => {
            if (item.kind !== 'section-heading') return rows || [];
            const pageWidth = (st.generation && st.generation.pageSize &&
                st.generation.pageSize.widthBp) || 595.276;
            return (rows || []).filter(r => !(r.x <= 2 && r.w <= pageWidth * .2));
        };
        let rects = credible(this._blockRows(st, item.file, block));
        // Environments and macro-expanded front matter can own a render box
        // even when SyncTeX gives none of their source lines a text row.
        if (!rects.length) rects = credible(this.objectRects(
            item.file, block.startLine, block.endLine));

        // A run-in \paragraph prints its heading on the following prose row and
        // may have no trustworthy record of its own. Walk only inside this
        // section, taking the first credible printed source line. This is the
        // same semantic fallback used by the section navigator, but it keeps
        // the comment near the beginning of the unit rather than at its end.
        if (!rects.length && item.kind === 'section-heading') {
            const objects = this._commentObjects(item.file);
            const headings = objects.filter(o => o.kind === 'section-heading' && o.sourceRange)
                .sort((a, b) => a.sourceRange.startLine - b.sourceRange.startLine);
            const here = headings.find(o => item.line >= o.sourceRange.startLine &&
                item.line <= o.sourceRange.endLine) || null;
            const after = headings.find(o => o.sourceRange.startLine > block.endLine);
            const text = this._textOf(item.file);
            const lines = text == null ? [] : text.split(/\r?\n/);
            const from = Math.max(block.endLine + 1,
                here && here.sourceRange ? here.sourceRange.endLine + 1 : block.endLine + 1);
            const to = Math.min(lines.length || from,
                after ? after.sourceRange.startLine - 1 : lines.length || from);
            for (let line = from; line <= to; line++) {
                const source = String(lines[line - 1] || '').replace(/(^|[^\\])%.*/, '$1').trim();
                if (!source || /^\\label\b/.test(source)) continue;
                const found = credible(this._blockRows(st, item.file, {
                    startLine: line, endLine: line,
                }));
                if (found.length) { rects = found; break; }
            }
        }

        // Classes such as JHEP store title and abstract text in preamble
        // commands and typeset it only when `\maketitle` runs. Some engines
        // attribute that ink to the command, others only to `\maketitle`.
        // The durable cell remains the title/abstract command; this is merely
        // its current visual anchor so its bubble cannot disappear.
        if (!rects.length && ['titlepage', 'abstract'].includes(item.kind)) {
            const text = this._textOf(item.file);
            const match = text && /(^|\n)[ \t]*\\maketitle\b/.exec(text);
            if (match) {
                const offset = match.index + (match[1] ? match[1].length : 0);
                const line = text.slice(0, offset).split('\n').length;
                const total = text.split('\n').length;
                rects = this._blockRows(st, item.file, {
                    startLine: line, endLine: Math.min(total, line + 1),
                });
                if (!rects.length) rects = this.objectRects(item.file, line, line);
            }
        }
        return rects;
    }

    /** Import retained review feedback once, so old and new review comments mix. */
    _importReviewComments(file) {
        const session = this._review &&
            (this._review.sessions.get(file) || this._review._archived.get(file));
        if (!session || !session.feedback || !session.feedback.length) return;
        let existing;
        try { existing = this.comments.read(file); } catch (_) { return; }
        const imported = new Set(existing.comments.flatMap(c =>
            c.revision && c.revision.originId ? [String(c.revision.originId)] : []));
        const doc = (vscode.workspace.textDocuments || [])
            .find(d => d.uri && d.uri.fsPath === file && !d.isClosed);
        const objects = this._commentObjects(file);
        for (const feedback of session.feedback) {
            const originId = `review:${feedback.id}:${feedback.at}`;
            if (imported.has(originId)) continue;
            let obj = doc ? this._commentObject(doc, feedback.line, feedback.object) : null;
            if (!obj && feedback.object && feedback.object.stableKey) {
                obj = objects.find(o => o.stableKey === feedback.object.stableKey) || null;
            }
            if (!obj) {
                obj = objects.find(o => ADDRESSABLE.has(o.kind) && o.sourceRange &&
                    feedback.line >= o.sourceRange.startLine && feedback.line <= o.sourceRange.endLine) || null;
            }
            // The source file may not be open and the reviewed unit may since
            // have disappeared. Preserve the feedback as a detached cell using
            // the revision text rather than dropping it during migration.
            if (!obj) obj = {
                kind: feedback.object && feedback.object.kind || 'paragraph',
                label: feedback.object && feedback.object.label || null,
                stableKey: feedback.object && feedback.object.stableKey || null,
                text: feedback.after || feedback.before || '',
                sectionPath: [],
                sourceRange: {
                    file,
                    startLine: Math.max(1, Number(feedback.line) || 1),
                    endLine: Math.max(1, Number(feedback.endLine) || Number(feedback.line) || 1),
                },
            };
            this.comments.add(file, obj, feedback.comment, {
                source: 'revision',
                revision: {
                    originId,
                    changeId: feedback.id,
                    at: feedback.at,
                    author: feedback.author || null,
                    before: feedback.before,
                    after: feedback.after,
                },
            }, objects);
            imported.add(originId);
        }
    }

    /** Send one document-ordered, reconciled view of all comment sidecars. */
    _pushComments(delay = 0) {
        clearTimeout(this._commentPushTimer);
        const run = () => {
            if (!this.panel || !this.root) return;
            const files = this._commentFiles();
            for (const file of files) {
                try { this._importReviewComments(file); } catch (_) { /* migration is best effort */ }
            }
            const result = this.comments.list(files, f => this._commentObjects(f));
            // Contextual comments live beside what they discuss.  The durable
            // address is still the source cell ID; these rectangles are only a
            // disposable projection of that cell into the PDF currently on
            // screen and are regenerated after every compile.
            const st = this.coord.roots && this.coord.roots.get(this.root);
            const generation = st && st.generation && st.generation.generation;
            const items = result.items.map(item => {
                let rects = [];
                if (!item.detached && st && st.map && Number.isFinite(item.line)) {
                    try {
                        rects = this._commentRects(st, item)
                            .map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h }));
                    } catch (_) { rects = []; }
                }
                return { ...item, rects, unplaced: !item.detached && !rects.length };
            });
            this._post({
                type: 'comments', items, errors: result.errors, generation,
                view: this._viewState && this._viewState.comments || null,
            });
        };
        if (delay > 0) this._commentPushTimer = setTimeout(run, delay);
        else run();
    }

    /** The review surface and the ordinary reader share one comment store. */
    async addRevisionComment(feedback) {
        if (!feedback || !feedback.file || !String(feedback.comment || '').trim()) return false;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(feedback.file)); }
        catch (_) { return false; }
        const objects = this._commentObjects(feedback.file);
        const obj = this._commentObject(doc, feedback.line, feedback.object);
        const originId = `review:${feedback.id}:${feedback.at}`;
        try {
            const record = this.comments.read(feedback.file);
            if (!record.comments.some(c => c.revision && c.revision.originId === originId)) {
                this.comments.add(feedback.file, obj, feedback.comment, {
                    source: 'revision',
                    revision: {
                        originId,
                        changeId: feedback.id,
                        at: feedback.at,
                        author: feedback.author || null,
                        before: feedback.before,
                        after: feedback.after,
                    },
                }, objects);
            }
            this._pushComments();
            return true;
        } catch (error) {
            this.status(`could not save the review comment: ${error.message}`, 'err');
            return false;
        }
    }

    async _onCommentAction(m) {
        if (!m || !this.root) return;
        const allowed = new Set(this._commentFiles());
        try {
            if (m.action === 'cancelDraft') {
                this._commentDraft = null;
                return;
            }
            if (m.action === 'add') {
                const draft = this._commentDraft;
                if (!draft || String(m.targetId) !== String(draft.id) ||
                    !String(m.text || '').trim()) return;
                let doc;
                try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(draft.file)); }
                catch (_) { this.status('that paragraph is no longer available', 'warn'); return; }
                const obj = this._commentObject(doc, draft.line, draft.object);
                const author = await this._readerCommentAuthor(draft.file);
                this.comments.add(draft.file, obj, m.text, { author }, this._commentObjects(draft.file));
                this._commentDraft = null;
                this._post({ type: 'commentComposed' });
                this._pushComments();
                this.status('comment saved beside the paper', 'ok');
                return;
            }
            if (m.action === 'update' && allowed.has(m.file)) {
                if (String(m.text || '').trim()) this.comments.update(m.file, m.id, m.text);
                else this.comments.delete(m.file, m.id);
                this._pushComments();
                return;
            }
            if (m.action === 'delete' && allowed.has(m.file)) {
                this.comments.delete(m.file, m.id);
                this._pushComments();
                return;
            }
            if (m.action === 'copy') {
                for (const d of Array.isArray(m.drafts) ? m.drafts : []) {
                    if (!allowed.has(d.file)) continue;
                    if (String(d.text || '').trim()) this.comments.update(d.file, d.id, d.text);
                    else this.comments.delete(d.file, d.id);
                }
                const listed = this.comments.list([...allowed], f => this._commentObjects(f));
                await vscode.env.clipboard.writeText(markdownFor(listed.items, this.root));
                this._pushComments();
                this.status(`copied ${listed.items.length} comment${listed.items.length === 1 ? '' : 's'} with current line numbers`, 'ok');
                return;
            }
            if (m.action === 'clear') {
                const listed = this.comments.list([...allowed], f => this._commentObjects(f));
                if (!listed.items.length) return;
                const answer = await vscode.window.showWarningMessage(
                    `Delete all ${listed.items.length} comments for this paper?`,
                    { modal: true, detail: 'The .timeline.comments sidecars will be removed. Git or another backup can recover them.' },
                    'Delete all',
                );
                if (answer !== 'Delete all') return;
                const n = this.comments.clear([...allowed]);
                this._commentDraft = null;
                this._post({ type: 'commentComposed' });
                this._pushComments();
                this.status(`deleted ${n} comment${n === 1 ? '' : 's'}`, 'ok');
                return;
            }
            if (m.action === 'reveal' && allowed.has(m.file)) {
                const listed = this.comments.list([m.file], f => this._commentObjects(f));
                const item = listed.items.find(x => x.id === m.id);
                if (!item || item.detached) {
                    this.status('that comment is detached from the current source', 'warn');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
                const editor = await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false,
                });
                const line = Math.max(0, Math.min(item.line - 1, doc.lineCount - 1));
                const pos = new vscode.Position(line, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                return;
            }
        } catch (error) {
            this.status(`comments could not be updated: ${error.message}`, 'err');
            this._pushComments();
        }
    }


    /** Forward sync: highlight the object under the cursor. */
    /**
     * @param {object} editor
     * @param {{instant?: boolean}} [opts]  `instant` when this sync is a
     *   RESTORE — the panel re-rendering, a reload, a tab coming back — rather
     *   than an answer to the reader moving the caret. A restore lands where
     *   the reader was and should be THERE when they look, not slide into
     *   place; only a gesture deserves the animation.
     */
    syncFromEditor(editor, opts = {}) {
        this._syncInstant = !!opts.instant;
        this._syncPreserveView = !!opts.preserveView;
        if (!this.panel || !editor) return;
        const doc = editor.document;
        if (!/\.tex$/i.test(doc.uri.fsPath)) return;
        // Cursor recovery is independent of follow mode: turning tracing off
        // must not also make the session forget where the source caret was.
        this._rememberCursor(doc, editor.selection);
        if (!this.followCursor) return;
        const st = this.coord.stateFor(doc);
        // THE PAGE IS A GENERATION, NOT A LIVE MIRROR OF THE BUFFER.
        // Same-line typing used to leave RenderMap._baseFlag() at FRESH, so the
        // old PDF text layer searched for a word that existed only in the new
        // buffer and highlighted a neighbour. Once any content changes, wait
        // for the matching generation to be painted before tracing again.
        if (this._tracePaused || (st && st.sourceAhead)) {
            this._setTracePaused(true, {
                source: this._traceSource || 'editor',
                compiling: !!(st && st.compiling),
            });
            return;
        }
        // NO MAP MEANS NO ANSWER — AND AN OLD ANSWER LEFT ON THE PAGE IS A LIE.
        //
        // A rebuild that fails while the reader types (a half-typed construct,
        // a missing brace) leaves the state with a map that cannot answer, and
        // this used to return in silence — so the span and the marker painted
        // for the PREVIOUS selection stayed on the paper and looked like the
        // answer to the new one. That is exactly the shape of "I select a
        // paragraph and it selects the figure": the figure was the answer to
        // something asked earlier. Clearing is the honest thing to show.
        if (!st || !st.map || !st.map.available) {
            this._post({ type: 'selection', span: null });
            this._post({ type: 'highlight', rects: [], label: 'no render map — the last compile produced none' });
            return;
        }

        // A RANGE IS NOT A CURSOR. Selecting a fragment asks a different
        // question — where does this PIECE of the source sit on the page — and
        // it is answered with a marked span rather than one glyph's wash.
        const sel = editor.selection;
        const ranged = sel && sel.start && sel.end &&
            (sel.start.line !== sel.end.line || sel.start.character !== sel.end.character);
        // A SELECTION THE PAGE ITSELF JUST MADE IS NOT A USER SELECTION.
        //
        // An inverse click selects the word it resolved to — that is the point
        // of it — and a selected word is a non-empty selection, so every click
        // came back as a red RANGE instead of the amber marker for the word
        // under the pointer. Reported: "click on the first The and it selects
        // an interval". The range the click set is remembered and recognised;
        // anything else, including the reader dragging over that same text, is
        // theirs.
        // A selection that has MOVED retires whatever the page last made; one
        // that has not keeps its identity however often we are re-asked.
        this._noteSelection(doc, sel);
        // A caret the READER moved (not one an inverse click just placed) is
        // the forward-sync gesture, and the only one with no panel message.
        const ownNow = sel && sel.start && sel.end && this._isOwnSelection(doc, sel);
        if (!ownNow) {
            try { this._tourObserve({ type: 'cursor' }); } catch (_) { /* never fatal */ }
        }
        if (ranged) {
            const own = this._isOwnSelection(doc, sel);
            // A RANGE WE ARE PAINTING RIGHT NOW NEEDS NOTHING FURTHER: the drag
            // has already posted it, and re-posting on the echo would fight the
            // preview and scroll the page under the moving hand. That silence
            // is for the gesture only — a span made a while ago is still a
            // span, and a later re-sync must REDRAW it against the new
            // geometry rather than either ignoring it or wiping it.
            if (own && this._selfRange.kind === 'drag') {
                if (Date.now() - this._selfRange.at < 2000) return;
                this._postSelection(st, doc, sel);
                return;
            }
            if (!own) { this._postSelection(st, doc, sel); return; }
            // A RANGE THE PAGE ITSELF MADE IS STILL A RANGE. One word is a
            // place and gets the marker (see _postWordMarker); anything wider
            // came from a Cmd-click walking out through the containers, and
            // clearing it here is what made the widened selection visible in
            // the editor and nowhere on the paper.
            if (this._isMultiWord(doc, sel)) { this._postSelection(st, doc, sel); return; }
        }
        this._post({ type: 'selection', span: null });

        // A NON-EMPTY SELECTION IS IDENTIFIED BY ITS START, NOT BY ITS ACTIVE END.
        //
        // MEASURED, and it is the whole of the reported "clicking a symbol puts
        // the cursor in the right place but highlights something else". An
        // inverse click SELECTS the token it resolved, and VS Code puts
        // `active` at the END of that selection. Token containment is half-open
        // — a cursor between `(` and `\bx` belongs to the token that STARTS
        // there, which is what makes clicking a boundary land on the right one
        // — so the forward sync then looked up the token AFTER the one that was
        // clicked and lit up its neighbour.
        //
        // The round-trip census over 243 maths glyphs: 131 landed back on the
        // clicked glyph, 92 landed exactly ONE GLYPH TO THE RIGHT — every one
        // of them with dy=0 and dx of a single character.
        // `ranged` is the guard this function already computed, and it is
        // defensive about a selection that carries only an active position.
        const cur = ranged ? sel.start : editor.selection.active;
        const line = cur.line + 1;
        const column = cur.character;
        // ...BUT THE CARET IS DRAWN WHERE THE CARET ACTUALLY IS.
        //
        // The rule above is about RESOLUTION — which token the selection names —
        // and it has to read the start, or an inverse click lights up the token
        // after the one that was clicked. The in-word caret is a different
        // question: it shows the reader where their cursor sits, and after an
        // inverse click VS Code leaves that at the END of the word it selected.
        // Using the resolution column for both drew the caret at the START of a
        // word whose editor cursor was at the end — reported, and visibly wrong
        // against the editor sitting next to it.
        //
        // Only when `active` is on the line we resolved: for a selection
        // spanning lines there is no position on this line to honour, and a
        // caret invented for it would be worse than the start.
        const caretCol = (sel && sel.active && sel.active.line === cur.line)
            ? sel.active.character : column;
        const { model } = this.projection.get(doc);
        const obj = model.objects
            .filter(o => o.sourceRange.startLine <= line && o.sourceRange.endLine >= line &&
                !['label', 'ref', 'cite', 'include'].includes(o.kind))
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))[0];

        // AN EQUATION IS AN OBJECT; PROSE IS A PLACE ON A LINE.
        //
        // For a display equation or a float the object IS the unit, and its
        // box is the right highlight. For prose it is not: draft.tex line 3086
        // is a 250-character source line that wraps into three typeset lines,
        // so highlighting "the paragraph" says almost nothing about where the
        // cursor is. Prose therefore highlights the typeset ROWS of the
        // current line, and names the word under the cursor so the viewer can
        // narrow to it using the PDF's own text layer.
        // A CAPTION IS PROSE THAT HAPPENS TO LIVE IN A FLOAT.
        //
        // Reported: a cursor in a figure's caption highlighted the WHOLE
        // figure. The float is a block, and for a block the object is the unit
        // — right for the picture, wrong for the sentence underneath it, which
        // is ordinary text a reader points at word by word.
        const objectIsTheUnit = obj && BLOCK_KINDS.includes(obj.kind) &&
            !this._inCaption(doc, line, column);
        const lineSrc = doc.lineAt(Math.max(0, line - 1)).text;
        // A display environment is an object; $E=mc^2$ is not. Both are maths,
        // and answering a cursor inside inline maths with the nearest PROSE
        // word is how a click meant for the formula highlighted the word before
        // it.
        const inMath = (obj && MATH_KINDS.includes(obj.kind)) || isInMath(lineSrc, column);
        const macros = this._macrosFor(doc);

        let rects = [];
        let flag = st.map._baseFlag();
        let word = null;
        let glyph = false;

        // FORWARD AND INVERSE ARE THE SAME TABLE, READ THE OTHER WAY.
        //
        // If the alignment can place the cursor's own token, it also knows the
        // exact rect of the glyph that token printed — so the highlight is that
        // glyph, with no name matching in the webview and no chance of the two
        // directions disagreeing about what corresponds to what.
        if (this._postAlignedGlyph(st, doc, line, column, obj ? obj.stableKey : `line ${line}`, caretCol)) return;

        // MATHS NARROWS TOO. A display equation is an object, but "the whole
        // equation" is a poor answer to where the cursor is in a six-line
        // align. Its letters and digits ARE typeset literally, so the glyph at
        // the cursor is addressable the same way a prose word is; the object
        // box remains the answer only when no glyph resolves (a lone \frac, a
        // Greek letter whose printed shape we cannot predict).
        if (inMath) {
            const g = wordAtColumn(lineSrc, column, { scope: 'math', inMath: true, macros });
            if (g) {
                word = g; glyph = true;
                rects = mergeRows(st.map.lineRows(doc.uri.fsPath, line)
                    .map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h })));
            }
        }
        if (!rects.length && objectIsTheUnit) {
            // KEEP THE GLYPH IF ONE RESOLVED. A display's own content lines
            // usually have NO SyncTeX rows — 71% on the reference paper — so a
            // cursor inside an equation lands here, and clearing the glyph left
            // the panel with nothing to narrow to: the whole equation lit up
            // when the cursor was on a single α. The object's rows are the
            // search REGION; `wordInRows` still finds the glyph inside them.
            // Clearing is right only when nothing resolved — a figure, a table.
            if (!word) { word = null; glyph = false; }
            // THE OBJECT'S ROWS, NOT ITS BOX.
            //
            // A display's SyncTeX box includes \abovedisplayskip, so it reaches
            // up over the paragraph above it — highlighting an equation drew one
            // tall band across the prose as well. The rows its own lines
            // printed are the equation and nothing else. The box stays as the
            // fallback for objects with no character records of their own,
            // like a figure.
            const rows = [];
            for (let n = obj.sourceRange.startLine; n <= obj.sourceRange.endLine; n++) {
                for (const r of st.map.lineRows(doc.uri.fsPath, n)) {
                    rows.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, line: n });
                }
            }
            // The same strays that made a selected equation paint over the
            // previous page would put this highlight there too.
            rows.splice(0, rows.length, ...clipToSpan(rows));
            if (rows.length) {
                // One band per printed LINE, not one per baseline — see mergeRows —
                // and neither the equation number nor the prose the \begin line
                // collected from the paragraph above.
                rects = mergeRows(dropDetachedRows(dropStrayRows(rows)));
            } else {
                const r = st.map.objectRenderBoxes(obj);
                rects = r.rects;
                flag = r.flag || flag;
            }
        } else if (!rects.length) {
            rects = mergeRows(st.map.lineRows(doc.uri.fsPath, line)
                .map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h })));
            word = wordAtColumn(lineSrc, column, { macros });
            // A LINE'S INK IS NOT ALWAYS IN A ROW OF ITS OWN.
            //
            // `\paragraph{…}` is a RUN-IN heading: its text is typeset on the
            // same printed row as the following paragraph's first words, and
            // SyncTeX files that whole row under the FOLLOWING line. Measured
            // on the reference paper, all six \paragraph headings have
            // `lineRows` EMPTY, so the cursor answered "line 338 · unmapped"
            // and nothing lit up at all.
            //
            // The borrow that _selectionAnchor already does is the answer here
            // too: the neighbour's row is the region this line's ink is in, and
            // the word name plus its occurrence is what picks it out of it.
            if (!rects.length) rects = this._neighbourRows(st, doc, line);
            // A CAPTION, A HEADING OR THE TITLE IS FILED UNDER ONE OF ITS OWN
            // LINES, AND NOT NECESSARILY THIS ONE — see _proseBlock. The block's
            // rows are where this word's ink is; the word and its occurrence
            // pick it out of them.
            if (!rects.length) {
                const block = this._proseBlock(doc, line, column);
                if (block) rects = this._blockRows(st, doc.uri.fsPath, block);
            }
        }
        if (!rects.length) {
            this._post({ type: 'highlight', rects: [], label: `line ${line} · unmapped` });
            return;
        }

        // NEVER SCROLL BACK AT SOMEONE WHO JUST CLICKED.
        //
        // An inverse click moves the cursor, which fires this forward sync,
        // which used to reveal — so clicking a symbol scrolled the page out
        // from under the hand that clicked it. The reader is already looking
        // at the right place; only a cursor move that did NOT come from the
        // page deserves a scroll.
        const fromClick = Date.now() - this._invertedAt < 1500;
        const where = word ? `"${word.word}"` : (obj ? shortLabel(obj) : `line ${line}`);
        this._post({
            type: 'highlight',
            rects,
            // WHERE TO LOOK IS NOT WHAT TO PAINT. The row rectangles under-cover
            // their row at both ends, so a search inside them misses the line's
            // first and last word and counts the wrong occurrence — measured,
            // clicking the first `The` of a line lit the `the` on the next one.
            // The wider region is for finding; `rects` stays the honest fallback
            // to paint when nothing is found.
            searchRects: word ? this._searchRows(st, doc.uri.fsPath, line) : undefined,
            word: word ? word.word : undefined,
            // Plus whatever a run-in heading printed onto this row before it.
            occurrence: word
                ? word.occurrence + (glyph ? 0
                    : this._occurrenceShift(st, doc, line, word.word,
                        this._proseBlock(doc, line, column)))
                : undefined,
            glyph,
            flag: flag === FLAG.FRESH ? 'fresh' : flag === FLAG.STALE ? 'stale' : 'approx',
            reveal: !this._syncPreserveView && !fromClick && this._mayScroll(),
            instant: !!this._syncInstant,
            title: obj ? obj.stableKey : `line ${line}`,
            label: `${where} · p.${rects[0].page} · ${flag}`,
        });
    }

    /**
     * WHERE A SELECTED FRAGMENT SITS ON THE PAGE.
     *
     * The two ends are resolved the same way a cursor is — the row(s) of the
     * line, plus the word or glyph at the column, which the panel narrows to an
     * exact rect using the PDF's own text layer. What is new is the SPAN: every
     * row the selection crosses, so the panel can draw the shape a reader
     * expects of a selection — from the opening mark to the end of its line,
     * the whole width of the lines between, and the last line up to the closing
     * mark.
     *
     * The rows are sent as they are, per line: merging them here would lose the
     * page breaks and the first/last row, which are the parts the shape is
     * built from.
     */
    /**
     * Is this selection the one an inverse click just made?
     *
     * IDENTITY, NOT A CLOCK. This used to expire after two seconds, and that
     * is the reported "left red bracket appearing and disappearing in random
     * places when I click".
     *
     * An inverse click SELECTS the token it resolved to, and that selection
     * then just sits in the editor. `syncFromEditor` is re-run for reasons
     * that have nothing to do with the reader: every recompile re-answers
     * through the `opened` handshake and through the identical-PDF branch, a
     * panel restore re-answers, and VS Code emits selection events of its own
     * whenever an edit shifts a range. Every one of those arriving more than
     * two seconds after the click found an unchanged selection and changed its
     * mind about whose it was — so the amber marker for one clicked symbol
     * became a red SPAN across everything between its two ends. In a display
     * equation that span covers the whole equation, which is the same report
     * seen from the other side: "does not recognise separate symbols".
     *
     * Re-asking the same question about the same selection must give the same
     * answer. So the range identity alone decides it, and the record is
     * dropped the moment the selection actually MOVES (`noteSelection` below)
     * — which is what makes the same text selected by hand a minute later the
     * reader's: the caret had to go somewhere else first, and that is an event.
     */
    /** Does this range cover more than one word? (a selection, not a place) */
    _isMultiWord(doc, sel) {
        if (!sel || !doc) return false;
        if (sel.start.line !== sel.end.line) return true;
        let text = '';
        try { text = doc.getText(sel); } catch (_) { return false; }
        return /\S\s+\S/.test(text.trim());
    }

    _isOwnSelection(doc, sel) {
        const r = this._selfRange;
        if (!r || r.file !== doc.uri.fsPath) return false;
        return sel.start.line === r.sl && sel.start.character === r.sc &&
            sel.end.line === r.el && sel.end.character === r.ec;
    }

    /**
     * The selection moved: whatever the page made is no longer on screen.
     *
     * Only a selection we have ALREADY SEEN can be invalidated. `_selfRange` is
     * recorded synchronously, before `editor.selection` is assigned, so the
     * event carrying the reader's PREVIOUS position can still be in flight;
     * clearing on that would resurrect the very bug the record exists to
     * prevent. Once the matching event has arrived, any different range is the
     * reader moving on.
     */
    _noteSelection(doc, sel) {
        const r = this._selfRange;
        if (!r || !sel || !sel.start || !sel.end) return;
        if (r.file !== doc.uri.fsPath) return;
        const same = sel.start.line === r.sl && sel.start.character === r.sc &&
            sel.end.line === r.el && sel.end.character === r.ec;
        if (same) { r.seen = true; return; }
        if (r.seen) this._selfRange = null;
    }

    /**
     * A LINE'S ROWS, WIDENED TO THE LINE'S REAL SHARE OF EACH PRINTED ROW.
     *
     * A row rectangle is built from SyncTeX records and under-covers its row at
     * both ends: the first record is often misfiled, so the rectangle starts at
     * the SECOND word, and the last is a dimensionless point at its word's
     * start, so it stops before that word's ink. The panel searches the text
     * layer INSIDE these rectangles, so the first word of a line is not among
     * the candidates — and the n-th occurrence it counts is then somebody
     * else's. Measured: clicking the first `The` of a line highlighted the
     * `the` on the next.
     *
     * The honest bound is the NEIGHBOURS: this line's share of a printed row
     * runs from where the previous line's ink stops to where the next line's
     * ink starts. Widening to those edges reaches the first and last word and
     * cannot reach into another line's.
     */
    /**
     * A BLANK LINE PRINTS NOTHING, so any row filed under it is misfiled.
     *
     * MEASURED on the reference paper. Line 340 is empty — it is the break
     * between `\end{figure}` and the paragraph after it — and SyncTeX files the
     * paragraph-break records under it:
     *
     *     p2 y= 61.5  x=  0.0..72.0    <- the top MARGIN of page 2
     *     p2 y=781.9  x=294.9..510.5   <- prose at the foot of page 2
     *
     * while the paragraph itself prints on page 3. Selecting from that blank
     * line therefore painted bands across a page the selection never reaches,
     * and the fill between the marks swallowed everything between: reported as
     * "I select this, in viewer the whole section is selected".
     *
     * No rule about shape can rescue those rows, and none is needed — the line
     * is empty, so it has no ink, and that is the end of it.
     */
    _lineIsBlank(doc, line) {
        if (line < 1 || line > doc.lineCount) return true;
        try { return !doc.lineAt(line - 1).text.trim(); } catch (_) { return false; }
    }

    _searchRows(st, file, line) {
        const own = mergeRows(dropStrayRows(st.map.lineRows(file, line)
            .map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h }))));
        if (!own.length) return own;
        const near = (n) => {
            try { return st.map.lineRows(file, n) || []; } catch (_) { return []; }
        };
        const before = near(line - 1);
        const after = near(line + 1);
        const sameRow = (a, b) => a.page === b.page &&
            Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > Math.min(a.h, b.h) * 0.5;
        return own.map((r) => {
            let x0 = r.x - 20;
            let x1 = r.x + r.w + 20;
            for (const p of before) {
                if (sameRow(p, r) && p.x + p.w <= r.x + 2) x0 = Math.max(x0, p.x + p.w + 1);
            }
            for (const n of after) {
                if (sameRow(n, r) && n.x >= r.x + r.w - 2) x1 = Math.min(x1, n.x - 1);
            }
            return { page: r.page, x: Math.min(x0, r.x), y: r.y, w: Math.max(x1, r.x + r.w) - Math.min(x0, r.x), h: r.h };
        });
    }

    /**
     * HOW MANY OF THIS WORD PRINTED ON THIS ROW BEFORE THIS LINE'S OWN INK.
     *
     * MEASURED on the reference paper. `\paragraph{The full two-variable pole
     * grid.}` is a RUN-IN heading: it has NO rows of its own (its characters
     * are filed under the paragraph that follows), so its printed words live
     * inside the next line's row. The panel counts occurrences across that row,
     * the extension counted them within the source LINE, and the two disagree
     * by exactly the words the heading contributed — so a cursor on the `the`
     * of "distinguish the separated" lit up the `The` that opens the heading.
     *
     * `_searchRows` cannot help here: it bounds a row by where the PREVIOUS
     * line's ink stops, and a line with no rows has no ink to stop at.
     *
     * So the words are counted instead, from the projection of the rowless
     * lines that run into this one. Case-folded, because the panel's own key is
     * — `The` and `the` are the same word to it, which is the whole trap.
     */
    _occurrenceShift(st, doc, line, word, block) {
        if (!word) return 0;
        const file = doc.uri.fsPath;
        const want = String(word).toLocaleLowerCase();
        let shift = 0;
        // INSIDE A BLOCK, THE WHOLE BLOCK IS COUNTED.
        //
        // The region the panel searches is the block's rows, so the occurrence
        // must be the n-th in the BLOCK — and a caption is longer than the four
        // lines the general walk-back allows, and its rows may be filed under a
        // line the walk-back would stop at.
        if (block && block.startLine < line) {
            for (let n = block.startLine; n < line; n++) {
                let words = [];
                try { words = visibleWords(doc.lineAt(n - 1).text, { macros: this._macrosFor(doc) }) || []; }
                catch (_) { words = []; }
                for (const w of words) {
                    if (!w.inMath && String(w.word).toLocaleLowerCase() === want) shift++;
                }
            }
            return shift;
        }
        for (let n = line - 1, guard = 0; n >= 1 && guard < 4; n--, guard++) {
            const text = doc.lineAt(n - 1).text;
            if (!text.trim()) break;                       // a paragraph break
            if (/^\s*\\(begin|end)\s*\{/.test(text)) break;
            let rows = [];
            try { rows = st.map.lineRows(file, n) || []; } catch (_) { rows = []; }
            if (rows.length) break;                        // it has ink of its own
            let words = [];
            try { words = visibleWords(text, { macros: this._macrosFor(doc) }) || []; }
            catch (_) { words = []; }
            for (const w of words) {
                if (!w.inMath && String(w.word).toLocaleLowerCase() === want) shift++;
            }
        }
        return shift;
    }

    /**
     * The rows of the nearest line that HAS any, within the same paragraph.
     *
     * Only a neighbour inside the same run of prose will do: a blank line or an
     * environment delimiter ends the paragraph, and past it the ink is somebody
     * else's. Up first — a continuation is typeset into the row its predecessor
     * started — then down, for a first line whose own record was misfiled.
     */
    _neighbourRows(st, doc, line, reach = 4) {
        const file = doc.uri.fsPath;
        const breaks = (n) => {
            if (n < 1 || n > doc.lineCount) return true;
            const t = doc.lineAt(n - 1).text;
            return !t.trim() || /\\(begin|end)\s*\{/.test(t) || /^\s*\\(section|subsection|subsubsection|chapter|item)\b/.test(t);
        };
        for (const step of [-1, 1]) {
            for (let d = 1; d <= reach; d++) {
                const n = line + step * d;
                if (breaks(n)) break;
                const rows = this._searchRows(st, file, n);
                if (rows.length) return rows;
            }
        }
        return [];
    }

    /**
     * Take hold of one END of the selection that is already there.
     *
     * Dragging a bracket is the same gesture as dragging out a new range, with
     * the OTHER end as the anchor — so it goes through exactly the same
     * resolution and there is no second way for it to be wrong. The range it
     * had is remembered by `_postSelection`, which is the only thing that knows
     * what is currently shown.
     */
    _adjustSelection(m) {
        const sel = this._lastSelection;
        if (!sel) return;
        const keep = m.end === 'start' ? sel.end : sel.start;
        this._pickAnchor = { file: sel.file, position: keep, label: 'selection' };
    }

    /** One end of a selection: its row(s), and the word the panel narrows to. */
    _selectionAnchor(st, doc, line, column) {
        const file = doc.uri.fsPath;
        const macros = this._macrosFor(doc);
        const text = doc.lineAt(Math.max(0, Math.min(line - 1, doc.lineCount - 1))).text;
        // WIDENED, BECAUSE A ROW RECTANGLE UNDER-COVERS ITS ROW. It is built
        // from SyncTeX records: the first of a row is often misfiled, so the
        // rectangle starts at the SECOND word, and the last is a point at its
        // word's start, so it stops before that word's ink. Searching the text
        // layer inside such a rectangle cannot find the first or last word of a
        // line — measured, the opening mark of a paragraph landed after its
        // first word every time. A line's worth of slack on each side is enough
        // to reach them and not enough to reach the next line's.
        const block = this._proseBlock(doc, line, column);
        const rows = this._lineIsBlank(doc, line)
            ? [] : this._searchRows(st, file, line);
        // WHOSE INK IS THIS? A line with none of its own borrows a neighbour's
        // row, and a borrowed row cannot be measured against this line's
        // columns — see the end-mark rule in the panel. Block rows are borrowed
        // too: they belong to the caption or heading, not to this line.
        let borrowed = !rows.length;
        // ITS OWN INK FIRST, WHEREVER IT PRINTED. Everything below borrows a
        // neighbour's row, which is a guess about where this line's words are;
        // the exact map does not have to guess (see _lineInkRects).
        if (!rows.length) {
            const ink = this._lineInkRects(st, doc, line);
            if (ink.length) { rows.push(...ink); borrowed = false; }
        }
        // A caption's or heading's own line usually has no rows; the block it
        // belongs to does, and that is the region this word's ink is in.
        if (!rows.length && block) rows.push(...this._blockRows(st, file, block));
        // A DISPLAY'S OWN LINES USUALLY HAVE NO ROWS — 71% of them on the
        // reference paper — so an end of a selection inside one has nothing to
        // be placed against, and the whole span went unpainted. The object it
        // belongs to does have rows.
        if (!rows.length) {
            const model = this._modelFor(doc);
            const obj = ((model && model.objects) || [])
                .filter(o => o.sourceRange && (!o.sourceRange.file || o.sourceRange.file === file) &&
                    o.sourceRange.startLine <= line && o.sourceRange.endLine >= line &&
                    !['label', 'ref', 'cite', 'include'].includes(o.kind))
                .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                    (b.sourceRange.endLine - b.sourceRange.startLine))[0];
            if (obj) {
                const all = [];
                for (let n = obj.sourceRange.startLine; n <= obj.sourceRange.endLine; n++) {
                    for (const r of st.map.lineRows(file, n)) {
                        all.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, line: n });
                    }
                }
                rows.push(...mergeRows(dropStrayRows(clipToSpan(all))));
                borrowed = true;
            }
        }
        // STILL NOTHING? THE ROW THAT CARRIES THIS LINE'S INK BELONGS TO
        // ANOTHER LINE.
        //
        // A short continuation line is typeset INTO the row its predecessor
        // started, and SyncTeX files the whole row under the predecessor. On
        // the reference paper line 91 is the single word `therefore`, printed
        // at the end of line 90's row, and it has no records at all: selecting
        // it painted nothing, and a selection ENDING on it had no mark. The
        // neighbouring line's row is the region its ink is in — the word name
        // and occurrence are what pick the word out of it.
        if (!rows.length) { rows.push(...this._neighbourRows(st, doc, line)); borrowed = true; }

        const inMath = isInMath(text, column);
        const w = wordAtColumn(text, column, { macros, scope: inMath ? 'math' : 'prose', inMath })
            || wordAtColumn(text, column, { macros });
        // AT THE START OF A LINE THE MARK BELONGS AT THE MARGIN, not at the
        // first word: a heading's printed NUMBER sits to the left of its title
        // and is part of the line the reader selected.
        const firstCol = text.search(/\S/);
        return {
            line,
            rects: rows,
            own: !borrowed,
            word: w ? w.word : undefined,
            occurrence: w
                ? w.occurrence + (w.inMath || inMath ? 0
                    : this._occurrenceShift(st, doc, line, w.word, block))
                : undefined,
            glyph: !!(w && w.inMath) || inMath,
            atLineStart: firstCol < 0 || column <= firstCol,
            atLineEnd: column >= text.replace(/\s+$/, '').length,
        };
    }

    /**
     * THE GLYPH THE ALIGNMENT ITSELF NAMES.
     *
     * Forward and inverse are the same table read the other way: if the
     * alignment can place the token at this column it also knows the exact
     * rect of the glyph that token printed — no name matching in the webview,
     * and no chance of the two directions disagreeing about what corresponds
     * to what. Returns false when the column is unaligned, so the caller can
     * fall back to searching the text layer by name.
     */
    _postAlignedGlyph(st, doc, line, column, title, caretCol) {
        const amap = this._alignMap(st, doc, line, null);
        if (!amap) return false;
        const t = tokenAt(amap, line, column);
        if (t.index < 0) return false;
        const gi = amap.srcToRen[t.index];
        if (!(gi >= 0)) return false;
        const g = amap.glyphs[gi];
        const flag = st.map._baseFlag();
        const tok = amap.tokens[t.index];
        // THE UNIT IN PROSE IS THE WORD. The exact map aligns character by
        // character, which is right in maths and one letter too narrow in a
        // sentence — so every glyph of the word at the cursor is collected and
        // painted as one band per printed row, exactly where the engine put it.
        const inkRect = (q) => ({ page: q.page, x: q.x, y: q.inkY != null ? q.inkY : q.y, w: q.w, h: q.inkH != null ? q.inkH : q.h });
        let rects = [inkRect(g)];
        let what = JSON.stringify(tok.ch);
        let glyph = true;
        let word; let occurrence;
        // WHERE IN THE WORD, not just which word.
        //
        // The wash answers "this word"; a reader following their own typing
        // also needs "and I am here in it". The exact map has a box per glyph,
        // so the caret is read off the same table rather than guessed. Default
        // range is the token itself, which is the right unit in maths; prose
        // widens it to the whole word below.
        const caretAt = (caretCol == null) ? column : caretCol;
        let caret = caretInRange(amap, line, caretAt, { start: tok.startCol, end: tok.endCol });
        if (amap.exact && !tok.inMath) {
            const lineSrc = doc.lineAt(Math.max(0, line - 1)).text;
            const run = this._wordFromTokens(amap, t.index, lineSrc, null);
            if (run) {
                // The marker contract: the message names the word and which
                // occurrence, for the panel's own bookkeeping; `exact` tells it
                // the rects are already that word and need no narrowing.
                word = run.word;
                const at = wordAtColumn(lineSrc, column, { macros: this._macrosFor(doc) });
                occurrence = (at && at.word === run.word) ? at.occurrence : 1;
                const parts = [];
                for (let i = 0; i < amap.tokens.length; i++) {
                    const k = amap.tokens[i];
                    if (k.line !== line || k.startCol < run.start || k.startCol >= run.end) continue;
                    const j = amap.srcToRen[i];
                    if (j >= 0) parts.push(inkRect(amap.glyphs[j]));
                }
                if (parts.length) {
                    rects = mergeRows(parts); what = `"${run.word}"`; glyph = false;
                    const c = caretInRange(amap, line, caretAt, run);
                    if (c) caret = c;
                }
            }
        }
        this._post({
            type: 'highlight',
            rects,
            glyph,
            word, occurrence,
            // Only an EXACT map may place a caret. An approximate one is right
            // about the word and has no business claiming a position inside it
            // — a caret two letters out looks like a bug in the editor, not a
            // limit of the map, so it is better not drawn at all.
            caret: amap.exact ? caret : null,
            exact: !!amap.exact,
            flag: flag === FLAG.FRESH ? 'fresh' : flag === FLAG.STALE ? 'stale' : 'approx',
            reveal: !this._syncPreserveView && this._mayScroll() && Date.now() - this._invertedAt >= 1500,
            instant: !!this._syncInstant,
            title,
            label: `${what} · p.${g.page} · ${flag}${amap.exact ? ' · exact' : ''}`,
        });
        return true;
    }


    /**
     * THE WORD A SOURCE TOKEN BELONGS TO, READ OFF THE TOKEN SEQUENCE.
     *
     * The exact alignment names one character; in prose the unit is the word.
     * `wordAtColumn` re-derives words from the line and disagrees with the
     * projection in the corners — a word glued to inline maths (`$\Gamma$-glued`)
     * is not a word to it, so the nearest one ("full") was answered instead.
     * The tokens already carry contiguous source offsets: the word is the run
     * of word-like tokens around the hit whose source ranges touch.
     *
     * `narrowTo`: the word the PANEL saw (split at an en dash, so "upper" out
     * of `upper--upper`); when the run contains it, the span is narrowed to the
     * occurrence nearest the hit, so the editor selects what was clicked.
     *
     * @returns {{start:number,end:number,word:string,line:number}|null}
     */
    _wordFromTokens(amap, ti, lineSrc, narrowTo) {
        const toks = amap && amap.tokens;
        if (!toks || ti < 0 || ti >= toks.length) return null;
        const t0 = toks[ti];
        const wordy = (t) => t && t.line === t0.line && t.endLine === t0.line && !t.inMath &&
            /[\p{L}\p{N}'’\-]/u.test(String(t.ch || ''));
        if (!wordy(t0)) return null;
        let a = ti; let b = ti;
        while (a > 0 && wordy(toks[a - 1]) && toks[a - 1].endCol >= toks[a].startCol) a--;
        while (b + 1 < toks.length && wordy(toks[b + 1]) && toks[b + 1].startCol <= toks[b].endCol) b++;
        let start = toks[a].startCol; let end = toks[b].endCol;
        if (!(end > start)) return null;
        let word = lineSrc.slice(start, end);
        // A DOUBLE HYPHEN IS AN EN DASH: PUNCTUATION BETWEEN WORDS, NOT PART OF
        // ONE. `upper--upper` is two words a reader points at separately, while
        // `half-planes` and `single-valuedness` are one word each — that is
        // TeX's own rule (`--` sets an en dash) and it is the only signal there
        // is. Measured: without this the highlight for a click on the first
        // `upper` named `upper--upper` and washed both halves.
        {
            const anchor = Math.max(0, t0.startCol - start);
            const bnd = /-{2,}|[\u2013\u2014]/g;
            let segFrom = 0; let segTo = word.length; let onDash = false; let mm;
            while ((mm = bnd.exec(word)) !== null) {
                const from = mm.index; const to = mm.index + mm[0].length;
                if (to <= anchor) segFrom = to;
                else if (from > anchor) { segTo = from; break; }
                else { onDash = true; break; }   // the dash itself: the run stands
            }
            if (!onDash && (segFrom > 0 || segTo < word.length)) {
                start += segFrom; end = start + (segTo - segFrom);
                word = lineSrc.slice(start, end);
            }
        }
        // …and a run that begins or ends on punctuation (`$\Gamma$-glued`, whose
        // maths half is not part of the run) is trimmed to its letters.
        while (word.length > 1 && !/[\p{L}\p{N}]/u.test(word[0])) { start++; word = word.slice(1); }
        while (word.length > 1 && !/[\p{L}\p{N}]/u.test(word[word.length - 1])) { end--; word = word.slice(0, -1); }
        if (!(end > start)) return null;
        if (narrowTo && word !== narrowTo && word.includes(narrowTo)) {
            // the occurrence nearest the hit column
            let best = -1; let bestD = Infinity; let from = 0;
            for (;;) {
                const k = word.indexOf(narrowTo, from);
                if (k < 0) break;
                const d = Math.abs(start + k + narrowTo.length / 2 - (t0.startCol + 0.5));
                if (d < bestD) { bestD = d; best = k; }
                from = k + 1;
            }
            if (best >= 0) { start = start + best; end = start + narrowTo.length; word = narrowTo; }
        }
        return { start, end, word, line: t0.line };
    }
    /**
     * THE INK A SOURCE LINE PRINTED, from the engine's own map.
     *
     * A line whose words are typeset into another line's row — a run-in
     * `\paragraph{…}` heading, a caption's first line — has no row of its own,
     * and every fallback below it BORROWS a neighbour's row. Measured after the
     * selection widening shipped: a selection starting on the `\paragraph{`
     * line borrowed the FIGURE CAPTION above it, so the page bracketed the
     * caption while the editor held the paragraph. The exact map knows where
     * that line's glyphs really are; this is that answer, or [] without one.
     */
    _lineInkRects(st, doc, line) {
        if (!st.map || !st.map.exact) return [];
        const am = this._alignMap(st, doc, line, null);
        if (!am) return [];
        const parts = [];
        for (let i = 0; i < am.tokens.length; i++) {
            if (am.tokens[i].line !== line) continue;
            const j = am.srcToRen[i];
            if (!(j >= 0)) continue;
            const q = am.glyphs[j];
            parts.push({ page: q.page, x: q.x, y: q.inkY != null ? q.inkY : q.y, w: q.w, h: q.inkH != null ? q.inkH : q.h });
        }
        return parts.length ? mergeRows(parts) : [];
    }

    /**
     * THE ALIGNMENT THAT ANSWERS FOR A LINE — exact when the engine emitted the
     * map, the text-layer object map otherwise.
     *
     * With a GlyphMap (tex/glyphMap.js) the window is the construct the line
     * belongs to — itself, or the caption/heading/align body whose glyphs all
     * sit on one collector line — and the rendered side is the engine's own
     * glyph sequence for it. Whether it is aligned as maths is read off the
     * glyphs (display/cell ink) or the model's object, never guessed from the
     * nearest object.
     */
    _alignMap(st, doc, line, hintObj) {
        if (st.map && st.map.exact) {
            const file = doc.uri.fsPath;
            const lines = doc.getText().split(/\r?\n/);
            const win = st.map.window(file, line, lines);
            if (!win) return null;
            const obj = hintObj && !hintObj.approximate ? hintObj : st.map.objectAtLine(file, line);
            const objMath = !!(obj && !obj.approximate && (MATH_KINDS.includes(obj.kind) ||
                (obj.envName && MATH_ENVS.has(String(obj.envName).replace(/\*$/, '')))));
            const gl = st.map.glyphsForLine(file, win.collector);
            // DISPLAY INK (kind 2) says maths; CELL ink (kind 4) does not — a
            // TikZ node's multi-line label is set in an \halign too, and
            // reading it as maths answered a click on "upper" with one letter.
            // An align body is told from its source instead.
            const mathInk = gl.filter(g => g.kind === 2).length;
            const winSrc = lines.slice(win.startLine - 1, win.endLine).join('\n');
            // `\\[` must not be read as `\[`: a TikZ node's `\\\\[-1mm]` is a row break.
            const srcMath = /\\begin\{(equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|dmath|split|aligned|gathered|cases)\*?\}|(^|[^\\])\\\[|\$\$/.test(winSrc);
            const inMath = objMath || srcMath || (gl.length > 0 && mathInk > gl.length / 2);
            const am = st.map.lineMap({ file, line, lines, macros: this._macrosFor(doc), inMath });
            if (am) { am.exact = true; am.inMath = inMath; return am; }
            return null;
        }
        return this._objectMap(st, doc, hintObj || this._objectForLine(st, doc, line));
    }

    /**
     * ONE WORD IS A PLACE, NOT A RANGE.
     *
     * Bracketing a single word between two red marks and washing the sliver
     * between them says nothing the marker did not already say, and it says it
     * in three pieces of chrome that then stay on the page. A selection of one
     * word or one symbol therefore gets the same amber marker a click gets —
     * which fades on its own. Returns false when the word cannot be placed, so
     * the span remains the fallback.
     */
    _postWordMarker(st, doc, line, column, caretCol) {
        const file = doc.uri.fsPath;
        if (this._postAlignedGlyph(st, doc, line, column, `line ${line}`, caretCol)) {
            this._lastSelection = null;
            return true;
        }
        const a = this._selectionAnchor(st, doc, line, column);
        if (!a.rects.length || !a.word) return false;
        // Nothing is bracketed, so there is nothing to take hold of.
        this._lastSelection = null;
        const paint = mergeRows(dropStrayRows(st.map.lineRows(file, line)
            .map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h }))));
        const rects = paint.length ? paint : a.rects;
        const flag = st.map._baseFlag();
        this._post({
            type: 'highlight',
            rects,
            searchRects: a.rects,
            word: a.word,
            occurrence: a.occurrence,
            glyph: a.glyph,
            flag: flag === FLAG.FRESH ? 'fresh' : flag === FLAG.STALE ? 'stale' : 'approx',
            reveal: !this._syncPreserveView && this._mayScroll() && Date.now() - this._invertedAt >= 1500,
            instant: !!this._syncInstant,
            title: `line ${line}`,
            label: `"${a.word}" · p.${rects[0].page} · ${flag}`,
        });
        return true;
    }

    _postSelection(st, doc, sel) {
        const file = doc.uri.fsPath;
        const startLine = sel.start.line + 1;
        const endLine = Math.min(sel.end.line + 1, doc.lineCount);

        // A ONE-WORD SELECTION IS MARKED, NOT BRACKETED — see _postWordMarker.
        // The overlay is cleared first: a `highlight` does not replace a span,
        // the two are drawn by different code, and both at once reads as
        // neither.
        const text = doc.getText(sel).trim();
        if (startLine === endLine && text && !/\s/.test(text)) {
            this._post({ type: 'selection', span: null });
            // Same split as syncFromEditor: resolve from the start, draw the
            // caret where the reader's cursor is.
            const wmCaret = (sel.active && sel.active.line === sel.start.line)
                ? sel.active.character : sel.start.character;
            if (this._postWordMarker(st, doc, startLine, sel.start.character, wmCaret)) return;
        }

        const anchorAt = (line, column) => this._selectionAnchor(st, doc, line, column);

        // Every row the selection crosses, in reading order, with the line each
        // came from — the panel needs the first and last separately.
        let rows = [];
        for (let n = startLine; n <= endLine; n++) {
            if (this._lineIsBlank(doc, n)) continue;      // it printed nothing
            // ITS OWN GLYPHS, WHEN THE ENGINE EMITTED THEM. A row rectangle is
            // the whole printed ROW, which routinely carries a neighbouring
            // source line's words too; the glyphs of THIS line are what the
            // reader selected. Rows stay the answer without an exact map.
            let own = this._lineInkRects(st, doc, n);
            if (!own.length) {
                own = mergeRows(dropStrayRows(st.map.lineRows(file, n)
                    .map(x => ({ page: x.page, x: x.x, y: x.y, w: x.w, h: x.h }))));
            }
            for (const r of own) rows.push({ ...r, line: n });
        }
        // A delimiter line collects strays from the page the object did not
        // print on — see clipToSpan. Without this a selected equation painted
        // over the margin and over prose on the previous page.
        rows = clipToSpan(rows);
        const ends = [anchorAt(startLine, sel.start.character), anchorAt(endLine, sel.end.character)];
        if (!rows.length) {
            // Every line of it was typeset into somebody else's row — see
            // _neighbourRows. The ends know which rows those are, and the marks
            // are what cut the band down to the words that were selected.
            const seen = new Set();
            for (const a of ends) {
                for (const r of a.rects) {
                    const key = `${r.page}:${Math.round(r.x)}:${Math.round(r.y)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    rows.push({ ...r, line: a.line });
                }
            }
        }
        if (!rows.length) { this._post({ type: 'selection', span: null }); return; }

        // What is on screen, so a bracket can be taken hold of later.
        this._lastSelection = {
            file,
            start: new vscode.Position(sel.start.line, sel.start.character),
            end: new vscode.Position(sel.end.line, sel.end.character),
        };
        // AND INTO THE CARD, when the selection falls inside the open block.
        //
        // The card already knew how to show a range — that is what an inverse
        // click has always done — but only the inverse click ever told it. A
        // range picked out ON THE PAGE left the card showing whatever it was
        // showing before, so the two halves of one selection disagreed.
        // _postEditSelection ignores a range outside the open block, and does
        // nothing at all when no card is open.
        try {
            // Keep the Selection itself, not a directionless Range. The card
            // needs to know whether its active edge is the left or right one
            // so Shift+Arrow can contract as well as expand.
            this._postEditSelection(doc, sel, false);
        } catch (_) { /* the page's own span is the main event */ }

        this._post({
            type: 'selection',
            span: {
                start: ends[0],
                end: ends[1],
                rows,
                lines: endLine - startLine + 1,
            },
            reveal: !this._syncPreserveView && this._mayScroll() && Date.now() - this._invertedAt >= 1500,
            instant: !!this._syncInstant,
            // THE LABEL IS THE DIAGNOSTIC. A span that lands on the wrong block
            // is reported as a picture, and the only way to tell a wrong
            // ANSWER from a displaced MAP is to say which lines were asked
            // about, which pages answered, and out of which map.
            label: `lines ${startLine}\u2013${endLine} \u00b7 p.${[...new Set(rows.map(r => r.page))].join(',')}` +
                ` \u00b7 ${flagWord(st.map._baseFlag())}${st.map.exact ? ' \u00b7 exact' : ''}`,
        });
    }

    async _onMessage(m) {
        // A health reply is transport bookkeeping, not a reader gesture. Deal
        // with it before the tour and sync-animation machinery observe it.
        if (m && m.type === 'viewerProbeResult') {
            this._finishViewerProbe(m);
            return;
        }
        // The tour watches the SAME messages the panel already sends, so what
        // it teaches and what the reader does are the same event.
        try { this._tourObserve(m); } catch (_) { /* the tour never breaks the panel */ }
        // A MESSAGE FROM THE PANEL IS A GESTURE, so whatever follows it is an
        // answer and animates. Without this a sync could inherit the "instant"
        // of the restore before it and a click's scroll would snap.
        this._syncInstant = false;
        switch (m.type) {
            case 'tourAction': this._tourAction(m); return;
            case 'reviewGroup':
                // The reader's choice of collation outlives the panel.
                if (m.by === 'section' || m.by === 'arrival') {
                    try { this.context.globalState.update(GROUP_KEY, m.by); } catch (_) { /* no state */ }
                }
                return;
            case 'hintShown':
                if (hintsLeft[m.id] > 0) hintsLeft[m.id] -= 1;
                break;
            case 'ready':
                this._webviewReady = true;
                this._postTheme();
                this._postSourceDirty(true);
                this._post({ type: 'hints', left: { ...hintsLeft } });
                this._post({ type: 'reviewGroup', by: this._reviewGroup() });
                // FIRST RUN: the tour opens itself once, after the first page
                // is on screen — a card over a blank panel teaches nothing.
                setTimeout(() => {
                    const t = this._tourState;
                    if (!t.done && !t.started) this.startTour();
                    else if (!t.done && t.started) this._tourPost();
                }, 1200);
                await this.refresh({ force: true });
                await this._restoreSessionChrome();
                // The list survives a panel reopen: the session is the truth,
                // the panel is only its picture.
                if (this._review) this._review.push(this.root);
                this._pushComments();
                break;
            case 'reviewAction': await this._onReviewAction(m); break;
            case 'commentAction': await this._onCommentAction(m); break;
            case 'commentView':
                this._rememberState(this.root, {
                    comments: {
                        open: !!m.open,
                        width: Math.max(220, Math.min(520, Number(m.width) || 276)),
                    },
                });
                break;
            case 'follow':
                this.followMode = ['off', 'mark', 'scroll'].includes(m.mode) ? m.mode
                    : (m.value ? 'scroll' : 'off');
                break;
            // The webview owns responsive-fit geometry. The message exists so
            // the interactive guide observes the real double-click gesture;
            // persistence follows through the ordinary viewstate snapshot.
            case 'fitMode': break;
            case 'recompile': await this.rebuild(); break;
            case 'saveSource': await this._savePaperSources(); break;
            case 'click': await this._jumpToSource(m); break;
            case 'fullscreen': await this.setFullScreen(m.value); break; // old webviews
            case 'layoutCycle': await this.cycleLayoutMode(); break;
            case 'layoutMode': await this.setLayoutMode(m.mode); break;
            case 'viewstate':
                this._rememberView(this.root, m.page, m.frac, m);
                if (m.requestId) {
                    const done = this._viewCaptures.get(m.requestId);
                    if (done) done(!m.unavailable);
                }
                break;
            case 'timing': {
                // The webview is the one place the extension cannot time from
                // the outside, and a VS Code webview is not the headless
                // browser the harness measures — the worker can be refused and
                // fonts arrive over a different protocol.
                // Two kinds arrive here: the once-per-session cold-start marks
                // (arrays), and one report per document opened (strings), which
                // is what makes a LIVE rebuild measurable at all.
                const phases = (m.marks || [])
                    .map((x) => (Array.isArray(x) ? `${x[0]} ${x[1]}ms` : String(x))).join(' · ');
                if (m.kind === 'open') {
                    this._log(`viewer open: gen ${m.generation}${m.live ? ' live' : ''} · ` +
                        `${m.pages} pages · ${((m.bytes || 0) / 1398101).toFixed(2)} MB · ${phases}`);
                } else {
                    this._log(`viewer: ${phases}${m.worker ? ' · ' + m.worker : ''}`);
                }
                break;
            }
            case 'opened':
                this._viewerReloading = false;
                clearTimeout(this._viewerReloadTimer);
                this._viewerReloadTimer = null;
                this._openedGeneration = m.generation;
                this._openedPdfHash = m.pdfHash ||
                    (String(this.shownGeneration) === String(m.generation) ? this.shownPdfHash : null);
                // The pages just changed underneath the reader. Any ladder was
                // built against the old source positions, and the old rects
                // were measured against the old compile, so both are dropped
                // and the highlight is recomputed from where the cursor is now.
                this._ladder = null;
                // Every chip was placed against the OLD render, so a chip left
                // in the panel would name whatever now occupies that spot.
                this._chips = null;
                this._chipModels = null;
                this._crops.clear();
                // The PDF bytes are visible now, but a newer edit may have
                // arrived while pdf.js was opening them. Resume only when this
                // is still the coordinator's current source generation.
                {
                    const st = this.root && this.coord.roots.get(this.root);
                    const current = !!(st && !st.sourceAhead && st.generation &&
                        String(st.generation.generation) === String(m.generation));
                    const source = this._traceSource;
                    this._setTracePaused(!current, {
                        source: this._traceSource || 'editor',
                        compiling: !!(st && st.compiling),
                    });
                    if (current) await this._resumeTracing({ instant: true, source });
                }
                await this._restoreEditSession();
                // The mini-editor's block has new geometry too — move the card.
                this._postEditAnchor().catch(() => {});
                if (this._labelsWanted) this._postLabels().catch(() => {});
                this._postSections().catch(() => {});
                this._pushComments(50);
                // A click made while this PDF was loading can now land. If its
                // payload still names the previous map, refreshPlacement will
                // replace its rectangles and replay it a moment later.
                // A restored webview may reuse the same generation number, but
                // its canvases and scale are new. Re-place every review before
                // allowing a pending click to navigate; showReview() replays
                // that click when the fresh payload arrives.
                if (this._review) {
                    try { this._review.refreshPlacement(); } catch (_) { /* list still works */ }
                } else {
                    this._replayReviewFocus();
                }
                break;
            case 'textLayer': this._onTextLayer(m); break;
            case 'textLayerDone':
                this._log(`text layer complete for generation ${m.generation}: ` +
                    `${m.pages} pages${m.ms != null ? ` in ${m.ms} ms` : ''}`);
                // `opened` necessarily arrives before the asynchronous text
                // sweep. The first cursor answer after a viewer restart is
                // therefore only row-level and has no exact red caret. Rebuild
                // the alignment once the complete layer exists, then answer
                // forward search again without moving the reader's page.
                if (String(m.generation) === String(this._openedGeneration)) {
                    this._objMaps.clear();
                    const st = this.root && this.coord.roots.get(this.root);
                    if (st && !st.sourceAhead && st.generation &&
                        String(st.generation.generation) === String(m.generation)) {
                        await this._resumeTracing({ instant: true, preserveView: true });
                    }
                }
                // A \ref site is placed over its printed NUMBER, which needs the
                // text layer — and the first Shift after a compile can easily
                // beat the sweep. Rebuild now that the ink is known, so those
                // chips stop being approximate.
                if (this._labelsWanted) {
                    this._chips = null;
                    this._postLabels().catch(() => {});
                }
                break;
            case 'pageTheme': await this._setPageTheme(m.value); break;
            case 'diffFocus': await this._focusHunk(m.id); break;
            case 'diffClose': this.closeComparison(); break;
            case 'compare': await this.offerComparison(); break;
            case 'editHere':
                // Open the block, THEN resolve the click inside it. A
                // right-click is still a click: it should land the caret on the
                // symbol under the pointer, in the card and in the editor
                // alike. The order matters — the jump posts its selection into
                // whatever card is open, so the card has to exist first.
                await this._openEditSession(m);
                await this._jumpToSource(m);
                break;
            case 'selectAdjust': this._adjustSelection(m); break;
            case 'labelsWanted':
                // Somebody is holding Shift. From here on a new generation
                // re-pushes; releasing Shift does NOT unsubscribe, because the
                // chips are cached in the panel and the second press has to be
                // instant.
                this._labelsWanted = !!m.value;
                if (m.value) await this._postLabels();
                break;
            case 'copyLabel': await this._copyLabel(m); break;
            case 'sectionFold': await this._onSectionFold(m); break;
            case 'copyAnchor': await this._onCopyAnchor(m); break;
            case 'cropped': this._onCropped(m); break;
            case 'selectionClear':
                // Esc on the page. The selection lives in the EDITOR, so
                // clearing it there too is what keeps the two ends agreeing;
                // it is collapsed to its start rather than moved, so the reader
                // does not lose their place. Stamped as ours, or the collapse
                // comes straight back as a fresh cursor sync.
                this._pickAnchor = null;
                this._moveTarget = null;
                this._post({ type: 'selection', span: null });
                if (this._lastSelection) {
                    const at = this._lastSelection.start;
                    const ed = (vscode.window.visibleTextEditors || [])
                        .find(e => e.document.uri.fsPath === this._lastSelection.file);
                    this._selfRange = {
                        file: this._lastSelection.file, kind: 'drag',
                        sl: at.line, sc: at.character, el: at.line, ec: at.character,
                        at: Date.now(),
                    };
                    if (ed) { try { ed.selection = new vscode.Selection(at, at); } catch (_) {} }
                    this._lastSelection = null;
                }
                break;
            case 'selectionAction': await this._selectionAction(m); break;
            case 'movePreview': await this._moveSelectionPreview(m); break;
            case 'moveCommit': await this._moveSelectionCommit(m); break;
            case 'moveCancel':
                this._moveTarget = null;
                this._post({ type: 'moveCaret', rects: [] });
                break;
            case 'editStep': await this._stepEditSession(m); break;
            case 'editChange': await this._applyEditChange(m); break;
            case 'editCaret': await this._onEditCaret(m); break;
            case 'editView':
                if (this._edit && m.editId === this._edit.id) {
                    const extra = {};
                    if (Number.isFinite(m.start)) extra.caretStart = m.start;
                    if (Number.isFinite(m.end)) extra.caretEnd = m.end;
                    if (m.direction === 'forward' || m.direction === 'backward') {
                        extra.caretDirection = m.direction;
                    }
                    if (Number.isFinite(m.page)) extra.page = m.page;
                    if (m.pos === null || (m.pos && Number.isFinite(m.pos.fx) && Number.isFinite(m.pos.fy))) {
                        extra.pos = m.pos;
                    }
                    this._rememberEditState(extra);
                }
                break;
            case 'editClose':
                this._edit = null;
                this._lastEditCaret = null;
                this._rememberEditState();
                break;
            case 'editSave': await this._saveEditDoc(m); break;
            case 'gitCommit':
                if (await this._saveEditDoc(m)) {
                    await vscode.commands.executeCommand('wolfbook.tex.commitChanges');
                }
                break;
            case 'gitPush': await vscode.commands.executeCommand('wolfbook.tex.pushChanges'); break;
            case 'editReveal': await this._revealEditRange(); break;
            case 'editNav': await this._onEditNav(m); break;
            case 'openExternal':
                // A webview cannot open a browser; this can. Only http(s) and
                // mailto — a PDF is an untrusted document, and `file:` or a
                // command URI in one is somebody else's idea, not the reader's.
                if (m && typeof m.url === 'string' && /^(https?|mailto):/i.test(m.url)) {
                    try { await vscode.env.openExternal(vscode.Uri.parse(m.url)); }
                    catch (e) { this._post({ type: 'status', text: `could not open it: ${e.message}`, kind: 'err' }); }
                } else {
                    this._post({ type: 'status', text: 'that link is not a web address', kind: 'warn' });
                }
                break;
            case 'revealSection':
                // Reviewing a list of changes means wanting to see where they
                // are. Same path the worklist uses, so both scroll the same way
                // — and it scrolls whatever `follow` says, because it was asked
                // for outright.
                if (m && m.line > 0) {
                    await this._gotoEdit({
                        file: m.file || this.root,
                        line: Number(m.line),
                        endLine: Number(m.endLine) || 0,
                        label: 'section',
                    });
                }
                break;
            case 'anchorAction': await this._onAnchorAction(m); break;
            case 'pastePreview': await this._insertPreview(m, 'paste'); break;
            case 'pasteCommit': await this._pasteCommit(m); break;
            case 'insertPreview': await this._insertPreview(m); break;
            case 'insertCommit': await this._insertCommit(m); break;
            case 'insertCancel':
                this._insertTarget = null;
                this._post({ type: 'moveCaret', rects: [] });
                break;
            case 'mmaOpenBlock':
                if (m && m.file && m.blockId) {
                    await this._openMmaSession(m.file, m.blockId, this.root && this.coord.roots.get(this.root), null);
                }
                break;
            case 'mmaKernels': await this._postKernels(); break;
            case 'mmaBindKernel': await this._bindKernel(m); break;
            case 'mmaRun': await this._runMmaCell(m); break;
            case 'mmaInsertOutput': await this._insertOutput(m); break;
            case 'mmaChange': await this._applyMmaChange(m); break;
            case 'mmaSetInclude': await this._setInclude(m); break;
            case 'mmaClose':
                this._mma = null;
                if (this._edit && this._edit.blockId) this._edit = null;
                break;
            default: break;
        }
    }

    // --- the glyph alignment -------------------------------------------------
    //
    // SyncTeX is the COARSE anchor: it says which object a point is in, and
    // which object a cursor is in. Inside that object, the projected source
    // glyphs are aligned against the rendered ones and the alignment answers
    // both directions from one table. See glyphAlign.js for the measurements
    // that forced this — the per-line search it replaces resolved 8.8% of the
    // glyphs in this paper's display equations.

    _onTextLayer(m) {
        if (!this._text || this._text.generation !== m.generation) {
            this._text = { generation: m.generation, pages: new Map(), symbolFonts: new Set() };
            this._objMaps.clear();      // geometry from a previous compile is gone
        }
        this._text.pages.set(m.page, m.items || []);
        // Which fonts lie about their characters is a DOCUMENT-wide judgement:
        // one equation may show a ∑ and no stretched delimiter, which is not
        // enough evidence on its own. A page that adds a new one invalidates
        // the alignments built before it was known.
        let grew = false;
        for (const f of symbolicFonts(m.items || [])) {
            if (!this._text.symbolFonts.has(f)) { this._text.symbolFonts.add(f); grew = true; }
        }
        if (grew) this._objMaps.clear();
    }

    /** Is there a text layer for the generation currently on screen? */
    _textReady() {
        return !!(this._text && this._text.generation === this.shownGeneration &&
            this._text.pages.size);
    }

    /**
     * Every rendered glyph belonging to an object, aligned with its source.
     *
     * The rendered side is collected from the object's own typeset rows and
     * then filtered by the coarse anchor AGAIN, per item: `lineAtPoint` says
     * which source line printed a given piece of ink, and ink from outside the
     * object is dropped. Without that filter the sequence picked up the prose
     * around the equation — measured, the unmatched glyphs came out with the
     * letter frequencies of English — and resolution fell from 72% to 54%.
     */
    _objectMap(st, doc, obj) {
        if (!obj || !this._textReady()) return null;
        const key = `${this.shownGeneration}|${obj.stableKey || `${obj.startLine}-${obj.endLine}`}`;
        const hit = this._objMaps.get(key);
        if (hit !== undefined) return hit;

        const file = doc.uri.fsPath;
        const startLine = obj.startLine ?? obj.sourceRange?.startLine;
        const endLine = obj.endLine ?? obj.sourceRange?.endLine;
        let built = null;
        try {
            // THE OBJECT'S OWN AREA, NOT ITS ROWS ONE BY ONE.
            //
            // A row rect is one text line high, and that height comes from the
            // document's estimated leading — which a maths-heavy document gets
            // wrong: measured on a corpus of displays it came out 4.5 bp
            // against a true 13.6, and every band shrank until the subscripts
            // and the numerator of an equation fell OUTSIDE their own row and
            // were dropped. A dropped glyph cannot be clicked, and nothing in
            // the census says why.
            //
            // A display is not a text line anyway; it is a 2-D box. So the
            // rows are unioned per page and the union collects the ink. What
            // keeps a neighbour's ink out is not the band — it is the OWNER
            // test below, which asks SyncTeX which source line printed that
            // piece of ink and drops everything from outside this object.
            const area = new Map();
            for (let n = startLine; n <= endLine; n++) {
                for (const r of st.map.lineRows(file, n)) {
                    const cur = area.get(r.page);
                    if (!cur) { area.set(r.page, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }); continue; }
                    cur.x0 = Math.min(cur.x0, r.x); cur.y0 = Math.min(cur.y0, r.y);
                    cur.x1 = Math.max(cur.x1, r.x + r.w); cur.y1 = Math.max(cur.y1, r.y + r.h);
                }
            }
            const items = [];
            for (const [page, a] of area) {
                for (const it of (this._text.pages.get(page) || [])) {
                    if (!it.str || !it.str.trim()) continue;
                    if (it.baseline < a.y0 - 2 || it.baseline > a.y1 + 2) continue;
                    if (it.x + it.w < a.x0 - 2 || it.x > a.x1 + 2) continue;
                    const owner = st.map.lineAtPoint(page, it.x + it.w / 2, it.baseline - 1);
                    if (!owner || owner.file !== file || owner.line < startLine || owner.line > endLine) continue;
                    items.push({ ...it, page });
                }
            }
            if (items.length) {
                dropEquationTags(items);
                const lines = doc.getText().split(/\r?\n/);
                built = buildObjectMap({
                    lines, startLine, endLine,
                    macros: this._macrosFor(doc),
                    inMath: MATH_KINDS.includes(obj.kind),
                    symbolFonts: this._text.symbolFonts,
                    items,
                });
                // A sequence that barely corresponds is not a map. Saying so and
                // falling back beats pointing confidently at the wrong token.
                if (built.confidence < 0.35) built = null;
            }
        } catch (e) {
            this._log(`alignment failed: ${e.message}`);
            built = null;
        }
        this._objMaps.set(key, built);
        return built;
    }

    /** The object containing a line, in the shape `_objectMap` expects. */
    /**
     * The object whose GLYPH ALIGNMENT may answer for this line — maths only.
     *
     * The alignment pairs source tokens with printed glyphs and answers with
     * ONE GLYPH. That is the right unit in a formula, where `x` is a thing a
     * reader points at, and the wrong one in prose, where the unit is the word.
     *
     * This used to accept any object containing the line, and every prose line
     * is contained in something — its section at the very least. So the
     * alignment was built for sections and floats, and a click on a prose word
     * came back as a marker one character wide sitting on its first letter.
     * MEASURED in the panel that draws it (check-paper.mjs phase C): "essential"
     * at x=232.7..286.0 was painted at x=232.8..238.7, 5.9 px of a 53 px word.
     *
     * `\begin{align}` is a maths environment whose kind is the generic
     * `environment`, so the kind alone cannot decide it and the environment's
     * NAME is consulted too.
     */
    _objectForLine(st, doc, line) {
        const o = st.map.objectAtLine(doc.uri.fsPath, line);
        if (!o || o.approximate) return null;
        const maths = MATH_KINDS.includes(o.kind) ||
            (o.envName && MATH_ENVS.has(String(o.envName).replace(/\*$/, ''))) ||
            (o.envName && MATH_ENVS.has(String(o.envName)));
        return maths ? o : null;
    }

    /**
     * A point on the page -> {file, line, object, flag}, preferring the printed
     * ROW over the box hierarchy.
     *
     * TWO WAYS TO ASK, AND TEXT NEEDS THE SECOND ONE. renderToSource walks the
     * box hierarchy, which is right for an equation or a float. Prose is not
     * boxed: its characters are recorded as dimensionless POINTS, so a click on
     * a paragraph resolves to whatever vbox encloses it — in practice the
     * display equation below, because `\[` plants a zero-width record on the
     * paragraph's own last baseline. That is how clicking "function" selected
     * the equation. lineAtPoint asks which printed ROW the click landed on
     * instead; it is preferred whenever it lands close to real ink, with the
     * box answer as the fallback (and still the winner for floats).
     */
    /**
     * WHICH occurrence of a repeated word was clicked — counted on the SOURCE
     * LINE, not on the printed row.
     *
     * THE TWO ARE NOT THE SAME SET, and that is the bug this exists to fix. A
     * printed row is a band across the page; a source line is a range of
     * characters. LaTeX fills each row from as many source lines as it needs,
     * so a row routinely carries the tail of one line and the head of the next.
     * The webview can only count along the row it can see — so "the second
     * `the` on this row" was matched against "the second `the` in this source
     * line", and when the row began mid-sentence the two disagreed and the
     * FIRST occurrence won.
     *
     * `lineRows` knows exactly where this source line's own ink sits on each of
     * the rows it printed. Keeping only the spots inside those rectangles, in
     * reading order, gives the occurrence index the source-side search wants.
     *
     * @param {{x:number,y:number}[]} spots  every same-word hit near the click,
     *   in bp, page coordinates — sent by the webview with the click.
     * @param {{x:number,y:number}} at  the one that was clicked.
     * @returns {number} the 1-based occurrence, or 0 when it cannot be told.
     */
    _occurrenceOnLine(st, file, line, spots, at) {
        if (!Array.isArray(spots) || !spots.length || !at) return 0;
        let rows = [];
        try { rows = st.map.lineRows(file, line) || []; } catch (_) { return 0; }
        if (!rows.length) return 0;
        const ordered = rows.slice().sort((a, b) => a.page - b.page || a.y - b.y);
        const PAD = 1;
        const rowOf = (s) => ordered.findIndex(r =>
            (s.page == null || s.page === r.page) &&
            s.x >= r.x - PAD && s.x <= r.x + r.w + PAD &&
            s.y >= r.y - PAD && s.y <= r.y + r.h + PAD);

        const mine = [];
        for (const s2 of spots) {
            const i = rowOf(s2);
            if (i >= 0) mine.push({ ...s2, row: i });
        }
        if (!mine.length) return 0;
        mine.sort((a, b) => a.row - b.row || a.x - b.x);
        // The clicked spot is one OF the spots, so an exact-ish match is
        // expected; without one we have not identified it and must not guess.
        let hit = -1; let bestD = Infinity;
        for (let i = 0; i < mine.length; i++) {
            const d = Math.hypot(mine[i].x - at.x, mine[i].y - at.y);
            if (d < bestD) { bestD = d; hit = i; }
        }
        return (hit >= 0 && bestD < 1.5) ? hit + 1 : 0;
    }

    /**
     * WHAT WAS CLICKED — the printed row, or the box that encloses the point.
     *
     * A CLICK THAT MISSES THE INK MUST STILL LAND ON THE NEAREST LINE. The row
     * answer used to require the point to be inside a row's own band and
     * within 24 bp of its ink; everywhere else the box hierarchy answered, and
     * on prose the box hierarchy answers with the display equation below (see
     * `renderMap.lineAtPoint` — `\[` plants a zero-width record on the
     * paragraph's last baseline). That is the reported bug: a click a few
     * points off a word selected the equation above or below it.
     *
     * So the slack is stated in units of the LEADING, which is the only scale
     * that means anything here:
     *   - vertically, up to nine tenths of a line away from the row's band;
     *   - horizontally, 24 bp — or a whole inch when the point is sitting
     *     squarely on the row, which is the click that lands in the white
     *     space after a short line.
     * Anything further out is genuinely somewhere else, and the box answer —
     * which is the right one for a figure or a table, whose interiors print no
     * characters at all — takes over.
     */
    _resolvePoint(st, m) {
        const row = st.map.lineAtPoint(m.page, m.xBp, m.yTopBp);
        const box = st.map.renderToSource(m.page, m.xBp, m.yTopBp);
        const dy = (row && row.dy) || 0;
        const lead = (row && row.lead > 0) ? row.lead : 12;
        const nearRow = !!row && (row.dx < 24
            ? dy < lead * 0.9
            : (row.dx < 72 && dy < lead * 0.5));
        return nearRow
            ? {
                flag: (box && box.flag) || st.map._baseFlag(),
                file: row.file,
                line: row.line,
                object: st.map.objectAtLine(row.file, row.line) || undefined,
            }
            : box;
    }

    // --- A FRAGMENT OF THE PAPER, AS AN IMAGE -------------------------------
    //
    // The hover over a `\ref` shows the equation's SOURCE; this is what lets it
    // also show the equation as it PRINTS. The panel owns the rasterised pages,
    // so the crop is asked of it rather than of a PDF rasteriser that may not
    // be installed on the reader's machine — and what comes back is the ink
    // from the generation the reader is actually looking at.
    //
    // Answers null rather than waiting when the panel is closed or slow: a
    // hover that hangs is worse than a hover without a picture.

    /**
     * @param {Array<{page,x,y,w,h}>} rects
     * @returns {Promise<{dataUrl:string,w:number,h:number}|null>}
     */
    cropFragment(rects, { timeoutMs = 700, key = null, scale = 2 } = {}) {
        if (!this.panel || !rects || !rects.length) return Promise.resolve(null);
        const cacheKey = key && `${this.shownGeneration}|${key}`;
        if (cacheKey && this._crops.has(cacheKey)) return Promise.resolve(this._crops.get(cacheKey));

        const id = `c${++this._cropSeq}`;
        return new Promise((resolve) => {
            const done = (value) => {
                if (!this._cropWaits.has(id)) return;
                this._cropWaits.delete(id);
                clearTimeout(timer);
                if (cacheKey && value) this._crops.set(cacheKey, value);
                resolve(value);
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            this._cropWaits.set(id, done);
            this._post({ type: 'crop', id, rects, scale });
        });
    }

    _onCropped(m) {
        const done = this._cropWaits.get(m && m.id);
        if (!done) return;
        done(m.dataUrl ? { dataUrl: m.dataUrl, w: m.w, h: m.h } : null);
    }

    /**
     * The rects of an object, as the highlight would paint them.
     *
     * Shared with the hover so a preview shows exactly what clicking the
     * reference would light up — including the clip that keeps a page-spanning
     * equation off the page it did not print on.
     */
    objectRects(file, startLine, endLine) {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) return [];
        const rows = [];
        for (let n = startLine; n <= endLine; n++) {
            for (const r of st.map.lineRows(file, n)) {
                rows.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, line: n });
            }
        }
        const kept = dominantPage(mergeRows(clipToSpan(dropDetachedRows(dropStrayRows(rows)))));
        if (kept.length) return kept;
        try {
            const model = this._modelFor2(file);
            const obj = model && model.objects.find(o => o.sourceRange &&
                o.sourceRange.startLine === startLine && o.sourceRange.endLine === endLine);
            const box = obj && st.map.objectRenderBoxes(obj);
            return (box && box.rects) || [];
        } catch (_) { return []; }
    }

    // --- WHAT TO DO WITH THE SELECTION --------------------------------------
    //
    // Copy, cut, paste, delete, from the bar pinned to the fragment on the
    // page. Every one goes through a WorkspaceEdit, so every one is a single
    // undo in the editor the reader would otherwise have gone back to.

    /** The document and range the page's selection refers to, or null. */
    async _selectionTarget() {
        const sel = this._lastSelection;
        if (!sel) return null;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sel.file));
            return { doc, range: new vscode.Range(sel.start, sel.end), sel };
        } catch (_) { return null; }
    }

    /** Leave the editor showing what just happened, without stealing focus. */
    _afterSelectionEdit(file, start, end, kind) {
        this._selfRange = {
            file, kind: 'drag',
            sl: start.line, sc: start.character, el: end.line, ec: end.character,
            at: Date.now(),
        };
        const ed = (vscode.window.visibleTextEditors || [])
            .find(e => e.document.uri.fsPath === file);
        if (ed) {
            try {
                ed.selection = new vscode.Selection(start, end);
                ed.revealRange(new vscode.Range(start, end),
                    vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            } catch (_) { /* the edit stands regardless */ }
        }
        if (kind === 'gone') {
            this._lastSelection = null;
            this._post({ type: 'selection', span: null });
        } else {
            this._lastSelection = { file, start, end };
        }
    }

    /**
     * copy / cut / delete over one range of one document.
     *
     * Shared by the selection bar and the section anchors, for the invariant in
     * the middle of it: A CUT THAT CANNOT COPY MUST NOT DELETE. That is the one
     * way to lose text with nothing to paste back, and it is too easy to write
     * a second copy of this that gets it wrong.
     *
     * @returns {{ok: true, text: string, changed: boolean} | {ok: false, reason: string}}
     */
    async _applyReaderEdit(doc, edit) {
        const event = { file: doc.uri.fsPath, origin: 'user', source: 'wpaper.viewer' };
        announceAgentEdit({ ...event, phase: 'begin' });
        try { return await vscode.workspace.applyEdit(edit); }
        finally { announceAgentEdit({ ...event, phase: 'end' }); }
    }

    async _rangeAction(doc, range, action) {
        const text = doc.getText(range);
        if (action === 'copy') {
            try { await vscode.env.clipboard.writeText(text); }
            catch (e) { return { ok: false, reason: `could not copy: ${e.message}` }; }
            return { ok: true, text, changed: false };
        }
        if (action !== 'cut' && action !== 'delete') {
            return { ok: false, reason: `unknown action ${action}` };
        }
        if (action === 'cut') {
            try { await vscode.env.clipboard.writeText(text); }
            catch (e) {
                return { ok: false, reason: `could not copy, so nothing was cut: ${e.message}` };
            }
        }
        const edit = new vscode.WorkspaceEdit();
        edit.delete(doc.uri, range);
        let ok = false;
        try { ok = await this._applyReaderEdit(doc, edit); } catch (_) { ok = false; }
        if (!ok) return { ok: false, reason: `the ${action} could not be applied` };
        return { ok: true, text, changed: true };
    }

    async _selectionAction(m) {
        const action = m && m.action;
        const t = await this._selectionTarget();
        if (!t) { this._post({ type: 'status', text: 'nothing is selected', kind: 'warn' }); return; }
        const { doc, range, sel } = t;
        const text = doc.getText(range);

        if (action === 'copy') {
            if (!text) { this._post({ type: 'status', text: 'nothing to copy', kind: 'warn' }); return; }
            try { await vscode.env.clipboard.writeText(text); }
            catch (e) { this._post({ type: 'status', text: `could not copy: ${e.message}`, kind: 'err' }); return; }
            this._post({
                type: 'status', kind: 'ok',
                text: `copied ${text.length} character${text.length === 1 ? '' : 's'}`,
            });
            return;
        }

        if (action === 'cut' || action === 'delete') {
            const r = await this._rangeAction(doc, range, action);
            if (!r.ok) { this._post({ type: 'status', text: r.reason, kind: 'err' }); return; }
            this._afterSelectionEdit(sel.file, sel.start, sel.start, 'gone');
            this._post({
                type: 'status', kind: 'ok',
                text: action === 'cut' ? `cut ${text.length} characters` : `deleted ${text.length} characters`,
            });
            return;
        }

        if (action === 'paste' || action === 'replace') {
            let replacement = action === 'replace' && typeof m.text === 'string' ? m.text : '';
            if (action === 'paste') {
                try { replacement = await vscode.env.clipboard.readText(); } catch (_) { replacement = ''; }
            }
            if (!replacement) {
                // An image in the clipboard is a figure, not a string — the
                // same answer ⌘V gives in the editor.
                this._post({
                    type: 'status',
                    text: action === 'paste' ? 'the clipboard holds no text' : 'nothing to insert',
                    kind: 'warn',
                });
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, range, replacement);
            let ok = false;
            try { ok = await this._applyReaderEdit(doc, edit); } catch (e) { ok = false; }
            if (!ok) {
                this._post({
                    type: 'status',
                    text: `the ${action === 'paste' ? 'paste' : 'typing'} could not be applied`,
                    kind: 'err',
                });
                return;
            }
            const startOff = doc.offsetAt(sel.start);
            const end = doc.positionAt(startOff + replacement.length);
            if (action === 'paste') {
                // Select what was pasted, so it can be moved or replaced again.
                this._afterSelectionEdit(sel.file, sel.start, end, 'kept');
                this._post({ type: 'status', text: `pasted ${replacement.length} characters`, kind: 'ok' });
            } else {
                // Ordinary typing replaces a selection and leaves a caret just
                // after the character, exactly as a text editor does.
                this._afterSelectionEdit(sel.file, end, end, 'gone');
            }
            return;
        }

        this._post({ type: 'status', text: `unknown action ${JSON.stringify(action)}`, kind: 'warn' });
    }

    // --- MOVING A SELECTION BY DRAGGING IT ----------------------------------
    //
    // Drag the middle of a selection (not its brackets) and the LaTeX inside it
    // MOVES to where you let go. While the hand is down a blue caret shows the
    // landing point, on the page and in the editor, and the editor scrolls to
    // it — so a block can be moved across pages without leaving the paper.
    //
    // WHOLE LINES MOVE AS WHOLE LINES. A displayed equation dropped into the
    // middle of a word is not what anybody means: when the selection covers
    // whole lines the landing point snaps to a line boundary, and only a
    // fragment inside one line lands at an exact column.

    /** Does this selection cover whole lines? */
    _isBlockSelection(doc, sel) {
        if (!sel) return false;
        if (sel.start.line !== sel.end.line) return true;
        const text = doc.lineAt(sel.start.line).text;
        return sel.start.character === 0 && sel.end.character >= text.replace(/\s+$/, '').length;
    }

    /**
     * The nearest legal seam to a point — where whole lines would land.
     *
     * THE GAPS ARE THE ANSWER. This replaces "resolve a line, then repair it":
     * the gaps between the blocks printed on this page ARE the places a block
     * may land, and the reader is aiming at one of them. Returns null when the
     * page has nothing to offer — an unmapped region, a page still rendering —
     * and the caller falls back to line-based reasoning.
     *
     * Shared by two gestures: dropping a moved selection, and dropping a new
     * Mathematica computation. They must agree about where a drop lands, so
     * they ask the same function rather than each having an opinion.
     */
    _blockDropTarget(st, m, doc) {
        const bounds = this._dropBoundaries(st, doc, m.page);
        if (!bounds.length) return null;
        let best = null;
        for (const b of bounds) {
            const d = Math.abs(b.y - m.yTopBp);
            if (!best || d < best.d) best = { b, d };
        }
        if (!best) return null;
        const at = Math.max(0, Math.min(doc.lineCount, best.b.line - 1));
        const b = best.b;
        const rects = Number.isFinite(b.x0) && b.x1 > b.x0
            ? [{ page: b.page, x: b.x0, y: b.y, w: b.x1 - b.x0, h: 0 }]
            : this._caretRects(st, doc, at + 1, true);
        return {
            file: doc.uri.fsPath, block: true,
            line: at + 1, column: 0,
            offset: doc.offsetAt(new vscode.Position(at, 0)),
            label: b.label,
            rects,
        };
    }

    /**
     * Where a drop at this point would put the text.
     *
     * @returns {{file:string, offset:number, line:number, column:number,
     *            block:boolean, rects:Array}|null}
     */
    _moveTargetFor(st, m, doc, sel) {
        const hit = this._resolvePoint(st, m);
        if (!hit || hit.flag === FLAG.UNMAPPED || !hit.file) return null;
        if (hit.file !== doc.uri.fsPath) return null;      // one file at a time
        const block = this._isBlockSelection(doc, sel);
        const lineIdx = Math.max(0, Math.min(hit.line - 1, doc.lineCount - 1));

        if (block) {
            const seam = this._blockDropTarget(st, m, doc);
            if (seam) return seam;
        }
        if (block) {
            // BETWEEN lines: above the row the pointer is on, or below it once
            // the pointer is past that row's middle — the same rule a file
            // explorer uses, and the only one that can express "after the last
            // line".
            const rows = this._searchRows(st, doc.uri.fsPath, lineIdx + 1);
            let after = false;
            if (rows.length) {
                const r = rows[0];
                after = m.yTopBp > r.y + r.h * 0.5;
            }
            let at = Math.min(doc.lineCount, lineIdx + (after ? 1 : 0));
            // A DROP MAY NOT LAND INSIDE A DISPLAY.
            //
            // Reported: dragging a paragraph to sit before an equation, and
            // "the insertion always lands inside the equation". It did — the
            // pointer is over the equation's rows, so the target line was one
            // of ITS lines, and `\begin{equation}` … a paragraph …
            // `\end{equation}` is not LaTeX. A drop over any part of a block
            // therefore snaps to its edge: before it in the top half, after it
            // in the bottom.
            const container = this._containerAt(doc, at, block);
            if (container) {
                // BEFORE OR AFTER IS A QUESTION ABOUT THE PAGE, NOT THE SOURCE.
                //
                // MEASURED: every row of `eq:U-m-change` is filed under its
                // `\end{equation}` line, so comparing the resolved LINE against
                // the object's middle line answered "after" everywhere on it —
                // the reader could not drop before an equation by pointing at
                // it at all, and the only spot that worked was a 10 bp sliver
                // in the gap above. The honest test is where the pointer is
                // against the object's own INK: top half means before it.
                const rects = this.objectRects(doc.uri.fsPath,
                    container.startLine, container.endLine);
                let before;
                if (rects.length) {
                    const y0 = Math.min(...rects.map(r => r.y));
                    const y1 = Math.max(...rects.map(r => r.y + r.h));
                    before = m.yTopBp < (y0 + y1) / 2;
                } else {
                    before = at <= (container.startLine + container.endLine) / 2;
                }
                at = before ? Math.max(0, container.startLine - 1)
                    : Math.min(doc.lineCount, container.endLine);
            }
            return {
                file: doc.uri.fsPath, block: true,
                line: at + 1, column: 0,
                offset: doc.offsetAt(new vscode.Position(at, 0)),
                rects: this._caretRects(st, doc, at + 1, true),
            };
        }

        const text = doc.lineAt(lineIdx).text;
        const macros = this._macrosFor(doc);
        const w = wordAtColumn(text, 0, { macros });
        void w;
        // The column is taken from the word the pointer is nearest, which is
        // what the panel already reports for a click.
        const col = Number.isFinite(m.column) ? Math.max(0, Math.min(m.column, text.length))
            : text.length;
        return {
            file: doc.uri.fsPath, block: false,
            line: lineIdx + 1, column: col,
            offset: doc.offsetAt(new vscode.Position(lineIdx, col)),
            rects: this._caretRects(st, doc, lineIdx + 1, false),
        };
    }

    /**
     * EVERY PLACE A BLOCK MAY LEGALLY LAND ON THIS PAGE, and where each one is.
     *
     * Resolving a line and then patching it cannot express "between these two
     * things". Reported twice: between two equations, and between an equation
     * and a section. The pointer is in a GAP, so the resolved line is whatever
     * happens to be nearest — a blank line, a delimiter, the tail of something
     * else — and every rule for repairing that answer is a rule about the wrong
     * question.
     *
     * The right question is which BOUNDARY the pointer is nearest. The blocks
     * printed on a page have gaps between them; those gaps ARE the legal
     * insertion points, and each one has a position on the page. Picking the
     * nearest is both simpler and exactly what the reader is aiming at.
     *
     * @returns {Array<{line:number, y:number, page:number, label:string}>}
     *          `line` is 1-based and means "insert BEFORE this line".
     */
    _dropBoundaries(st, doc, page) {
        const file = doc.uri.fsPath;
        if (!st.map) return [];
        let onPage = [];
        try { onPage = st.map.linesOnPage(page, file) || []; } catch (_) { return []; }
        if (!onPage.length) return [];

        const inkOf = (a, b) => {
            const rects = this.objectRects(file, a, b).filter(r => r.page === page);
            if (!rects.length) return null;
            return {
                y0: Math.min(...rects.map(r => r.y)),
                y1: Math.max(...rects.map(r => r.y + r.h)),
                x0: Math.min(...rects.map(r => r.x)),
                x1: Math.max(...rects.map(r => r.x + r.w)),
            };
        };

        // Keyed by line, so a container's edge and a prose line's own boundary
        // never appear twice; the HIGHEST position wins, which is where the
        // caret belongs when several things claim the same seam.
        const seen = new Map();
        // THE BOUNDARY CARRIES ITS OWN GEOMETRY, because nothing else can
        // recover it. The blue caret used to be built by asking for the rows of
        // the boundary LINE — and a boundary line is a blank line, or a
        // `\begin{equation}` whose only record is a misfiled sliver, so there
        // were none and nothing was drawn. Reported as "the blue indicator does
        // not show when I drop next to the equations". The position is already
        // known here; it just has to be kept.
        const add = (line, y, label, x0, x1) => {
            const n = Math.max(1, Math.min(doc.lineCount + 1, line));
            if (!Number.isFinite(y)) return;
            const had = seen.get(n);
            if (!had || y < had.y) seen.set(n, { line: n, y, page, label, x0, x1 });
        };

        const done = new Set();
        for (const n of onPage) {
            if (n < 1 || n > doc.lineCount) continue;
            // Inside a block? Then the only legal seams are its own edges.
            const c = this._containerAt(doc, n, true);
            if (c) {
                const key = `${c.startLine}-${c.endLine}`;
                if (done.has(key)) continue;
                done.add(key);
                const ink = inkOf(c.startLine, c.endLine);
                if (!ink) continue;
                add(c.startLine, ink.y0 - 2, 'before a block', ink.x0, ink.x1);
                add(c.endLine + 1, ink.y1 + 2, 'after a block', ink.x0, ink.x1);
                continue;
            }
            // Ordinary prose: a seam above each printed line. This is what
            // keeps the list DENSE — most of a paper is not a model object,
            // and a boundary list made only of blocks cannot express "between
            // these two paragraphs", nor even "above the only equation here".
            let rows = [];
            try { rows = (st.map.lineRows(file, n) || []).filter(r => r.page === page); }
            catch (_) { rows = []; }
            if (!rows.length) continue;
            add(n, Math.min(...rows.map(r => r.y)) - 1, 'line',
                Math.min(...rows.map(r => r.x)),
                Math.max(...rows.map(r => r.x + r.w)));
        }
        return [...seen.values()].sort((a, b) => a.y - b.y || a.line - b.line);
    }

    /**
     * The block a line sits inside, if dropping there would break it.
     *
     * Only the kinds whose interior has a grammar — a display, a float, a
     * table, a theorem. Dropping inside a paragraph is ordinary editing and is
     * left alone.
     */
    _containerAt(doc, line, blockOnly = true) {
        if (!blockOnly) return null;
        const model = this._modelFor(doc);
        if (!model) return null;
        // A HEADING IS A CONTAINER TOO. `\subsection{From the … to` /
        // `$q\dot q$ bilinears}` is two source lines, and a drop between them
        // splits the title down the middle. MEASURED: a drop anywhere in the
        // top 14 bp of that heading landed on its second line.
        const KINDS = ['display-equation', 'figure', 'table', 'tabular', 'theorem',
            'align', 'environment', 'list', 'itemize', 'enumerate', 'verbatim',
            'section-heading'];
        return (model.objects || [])
            .filter(o => o.sourceRange && KINDS.includes(o.kind) &&
                o.sourceRange.startLine <= line && o.sourceRange.endLine >= line)
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))
            .map(o => ({ startLine: o.sourceRange.startLine, endLine: o.sourceRange.endLine }))[0] || null;
    }

    /** The bar the panel draws: a rule between lines, or a caret on one. */
    _caretRects(st, doc, line, block) {
        const rows = this._searchRows(st, doc.uri.fsPath, Math.min(line, doc.lineCount));
        if (!rows.length) return [];
        const r = rows[0];
        return block
            ? [{ page: r.page, x: r.x, y: r.y, w: r.w, h: 0 }]
            : [{ page: r.page, x: r.x, y: r.y, w: 0, h: r.h }];
    }

    /** Live feedback while the hand is down. */
    async _moveSelectionPreview(m) {
        const st = this.root && this.coord.roots.get(this.root);
        const sel = this._lastSelection;
        if (!st || !st.map || !st.map.available || !sel) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sel.file)); }
        catch (_) { return; }
        const t = this._moveTargetFor(st, m, doc, sel);
        if (!t) { this._post({ type: 'moveCaret', rects: [] }); return; }
        this._moveTarget = t;
        this._post({
            type: 'moveCaret',
            rects: t.rects,
            block: t.block,
            label: `move here · line ${t.line}`,
        });
        // The editor shows the landing point too, and scrolls to it — that is
        // half of what makes this usable for a move across pages.
        const editor = (vscode.window.visibleTextEditors || [])
            .find(e => e.document.uri.fsPath === sel.file);
        if (editor) {
            const at = new vscode.Position(Math.max(0, t.line - 1), t.column);
            editor.revealRange(new vscode.Range(at, at),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    /**
     * Let go: the text moves.
     *
     * One WorkspaceEdit holds both halves, so it is ONE undo. A drop inside the
     * selection itself is a no-op rather than a self-destructive edit, and the
     * moved text is selected at its new home so the reader can see where it
     * went — and move it again.
     */
    async _moveSelectionCommit(m) {
        const st = this.root && this.coord.roots.get(this.root);
        // Reassignable: the fragment may be widened to something whole before
        // it is cut — see balanceRange below.
        let sel = this._lastSelection;
        this._post({ type: 'moveCaret', rects: [] });
        if (!st || !sel) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sel.file)); }
        catch (_) { return; }
        // BEFORE ANYTHING ELSE: what is actually being moved.
        //
        // A cut inside a construct leaves two broken halves — reported as
        // dragging a run-in paragraph and moving "only the text after the
        // title", because the selection began after `\paragraph{…}` and the
        // command stayed behind. And it must happen HERE, before the target is
        // chosen: whether a fragment covers whole lines decides whether it
        // lands between lines or at a column, and widening it can change that
        // answer.
        const whole = balanceRange(doc.getText(),
            doc.offsetAt(sel.start), doc.offsetAt(sel.end));
        if (whole.widened) {
            sel = {
                file: sel.file,
                start: doc.positionAt(whole.from),
                end: doc.positionAt(whole.to),
            };
            this._post({
                type: 'status', kind: '',
                text: `moving the whole construct — ${whole.reason}`,
            });
        }

        const t = (m && m.page) ? this._moveTargetFor(st, m, doc, sel) : this._moveTarget;
        this._moveTarget = null;
        if (!t) { this._post({ type: 'status', text: 'no place to move it to', kind: 'warn' }); return; }

        const from = doc.offsetAt(sel.start);
        const to = doc.offsetAt(sel.end);
        if (t.offset >= from && t.offset <= to) {
            this._post({ type: 'status', text: 'dropped where it already was', kind: '' });
            return;
        }
        let text = doc.getText(new vscode.Range(sel.start, sel.end));
        if (!text.trim()) return;

        // A BLOCK MOVES AS LINES, so it needs the newline the old place had.
        const block = t.block;
        let cut = { start: sel.start, end: sel.end };
        if (block) {
            const sLine = sel.start.line;
            const eLine = sel.end.line;
            const endsFile = eLine + 1 >= doc.lineCount;
            cut = {
                start: new vscode.Position(sLine, 0),
                end: endsFile ? new vscode.Position(eLine, doc.lineAt(eLine).text.length)
                    : new vscode.Position(eLine + 1, 0),
            };
            text = doc.getText(new vscode.Range(cut.start, cut.end));
            if (!/\n$/.test(text)) text += '\n';
        }
        const cutFrom = doc.offsetAt(cut.start);
        const cutTo = doc.offsetAt(cut.end);
        if (t.offset > cutFrom && t.offset < cutTo) {
            this._post({ type: 'status', text: 'dropped where it already was', kind: '' });
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const uri = doc.uri;
        edit.delete(uri, new vscode.Range(cut.start, cut.end));
        edit.insert(uri, doc.positionAt(t.offset), text);
        let ok = false;
        try { ok = await this._applyReaderEdit(doc, edit); }
        catch (e) { this._post({ type: 'status', text: `move failed: ${e.message}`, kind: 'err' }); return; }
        if (!ok) { this._post({ type: 'status', text: 'the move could not be applied', kind: 'err' }); return; }

        // Where it ended up: everything before the target shifts by the length
        // of what was removed, and only when the cut was BEFORE it.
        const landed = t.offset > cutTo ? t.offset - (cutTo - cutFrom) : t.offset;
        const start = doc.positionAt(landed);
        const end = doc.positionAt(landed + text.length);
        this._lastSelection = { file: sel.file, start, end };
        this._selfRange = {
            file: sel.file, kind: 'drag',
            sl: start.line, sc: start.character, el: end.line, ec: end.character,
            at: Date.now(),
        };
        const editor = (vscode.window.visibleTextEditors || [])
            .find(e => e.document.uri.fsPath === sel.file);
        if (editor) {
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(new vscode.Range(start, end),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        this._post({
            type: 'status',
            text: `moved ${block ? `${sel.end.line - sel.start.line + 1} line(s)` : 'the fragment'} to line ${t.line}`,
            kind: 'ok',
        });
    }

    /** INVERSE SYNC — the thing that makes this Page mode. */
    /**
     * Should a plain inverse click place the caret where the pointer was,
     * rather than selecting the whole word?
     *
     * Off restores the older behaviour — the word selected, caret at its end —
     * which is what you want if you habitually click a word in order to type
     * over it. Double-click still selects either way.
     */
    _inverseClickCaret() {
        try {
            return vscode.workspace.getConfiguration('wolfbook.tex')
                .get('inverseClickCaret', true) !== false;
        } catch (_) { return true; }
    }

    /**
     * Comments name the text row that offered the +, not arbitrary whitespace
     * on the same horizontal band. Try the exact clamped point first, then a
     * few positions inside that verified PDF text box. This fallback is scoped
     * to comments: editing still requires the stricter point correspondence.
     */
    _resolveCommentPoint(st, m) {
        const first = this._resolvePoint(st, m);
        if (first && first.flag !== FLAG.UNMAPPED && first.file) return first;
        const row = m && m.commentRow;
        if (!row || !Number.isFinite(row.x) || !Number.isFinite(row.y) ||
            !(row.w > 0) || !(row.h > 0)) return first;
        const probes = [
            [.5, .5], [.18, .5], [.82, .5], [.36, .5], [.64, .5],
            [.5, .25], [.5, .75],
        ];
        for (const [fx, fy] of probes) {
            const hit = this._resolvePoint(st, {
                ...m,
                xBp: row.x + row.w * fx,
                yTopBp: row.y + row.h * fy,
            });
            if (hit && hit.flag !== FLAG.UNMAPPED && hit.file) return hit;
        }
        return first;
    }

    /** Resolve a comment to a semantic source unit without doing caret work. */
    _postCommentTarget(doc, hit) {
        const obj = this._commentObject(doc, hit.line, hit.object);
        const r = obj.sourceRange || {};
        const id = ++this._commentSeq;
        this._commentDraft = {
            id,
            file: doc.uri.fsPath,
            line: r.startLine || hit.line,
            object: {
                kind: obj.kind,
                stableKey: obj.stableKey || null,
                sourceHash: obj.sourceHash || null,
            },
        };
        this._post({
            type: 'commentTarget',
            target: {
                id,
                file: doc.uri.fsPath,
                line: r.startLine || hit.line,
                endLine: r.endLine || hit.line,
                kind: obj.kind || 'paragraph',
                label: obj.label || obj.title || obj.name || null,
                sectionPath: Array.isArray(obj.sectionPath) ? obj.sectionPath.map(String) : [],
                sourcePreview: String(obj.text || '').trim().slice(0, 2400),
                excerpt: String(obj.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
            },
        });
        this._post({
            type: 'status',
            text: `comment on ${obj.kind || 'paragraph'} at line ${r.startLine || hit.line}`,
            kind: 'ok',
        });
    }

    async _jumpToSource(m) {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) {
            if (m.commentTarget) this._post({
                type: 'commentTarget', target: null,
                reason: 'Comments need a compiled page-to-source map.',
            });
            return;
        }
        if (this._tracePaused || st.sourceAhead) {
            this._setTracePaused(true, {
                source: this._traceSource || 'editor', compiling: !!st.compiling,
            });
            if (m.commentTarget) this._post({
                type: 'commentTarget', target: null,
                reason: 'Wait for the page to catch up before adding a comment.',
            });
            return;
        }
        this._invertedAt = Date.now();

        const hit = m.commentTarget
            ? this._resolveCommentPoint(st, m)
            : this._resolvePoint(st, m);
        if (!hit || hit.flag === FLAG.UNMAPPED || !hit.file) {
            this._ladder = null;
            this._post({ type: 'status', text: hit && hit.reason ? hit.reason : 'nothing there', kind: 'warn' });
            if (m.commentTarget) this._post({
                type: 'commentTarget', target: null,
                reason: hit && hit.reason ? hit.reason : 'That part of the page has no source location.',
            });
            return;
        }

        const uri = vscode.Uri.file(hit.file);
        const doc = await vscode.workspace.openTextDocument(uri);
        // Comments attach to the containing paragraph/equation, not a caret.
        // Stop here: the hundreds of lines below disambiguate an exact printed
        // glyph for editing, which made the + bubble slow and exposed it to
        // unrelated word-resolution failures before it could open a composer.
        if (m.commentTarget) {
            this._postCommentTarget(doc, hit);
            return;
        }
        let lineIdx = Math.max(0, Math.min(hit.line - 1, doc.lineCount - 1));
        let lineSrc = doc.lineAt(lineIdx).text;
        const macros = this._macrosFor(doc);

        // WHICH WORD — DECIDED BY EVIDENCE, NOT BY GUESSING THE MODE FIRST.
        //
        // This used to ask "is this maths?" and then look only that way. The
        // question cannot be answered reliably: `objectAtLine` reports the
        // NEAREST object when none contains the line, so a prose line sitting
        // one line from a display equation came back as that equation
        // (measured: line 60 -> display-equation, approximate, 1 line away).
        // Prose was then read glyph-by-glyph, and clicking "For" selected "F".
        //
        // So both readings are computed and the better-corroborated one wins.
        // An exact prose word beats an exact glyph — a word is the more
        // meaningful unit, and inside real maths the prose reading finds
        // nothing anyway, because every token there is tagged as maths.
        //
        // Occurrence: when the source line typeset as a single row, the
        // viewer's "n-th same glyph on the row" picks among repeats exactly;
        // across wrapped rows the fraction hint stays the tie-break.
        const singleRow = st.map.lineRows(hit.file, hit.line).length === 1;
        // Counted against this line's own printed rectangles when the webview
        // sent the positions to count with; the row-local count is the fallback
        // for an older payload, and only where the line printed as one row.
        const wordOcc = this._occurrenceOnLine(st, hit.file, hit.line, m.wordSpots, m.wordAt)
            || (singleRow ? m.wordOccurrence : 0);
        const glyphOcc = this._occurrenceOnLine(st, hit.file, hit.line, m.glyphSpots, m.glyphAt)
            || (singleRow ? m.glyphOccurrence : 0);
        const proseHit = m.word
            ? findWordInLine(lineSrc, m.word, m.rowFraction ?? 0.5,
                { macros, occurrence: wordOcc })
            : null;
        const mathHit = m.glyph
            ? findWordInLine(lineSrc, m.glyph, m.glyphFraction ?? 0.5,
                { scope: 'math', inMath: true, macros, occurrence: glyphOcc })
            : null;
        let w = (proseHit && proseHit.exact) ? proseHit
            : (mathHit && mathHit.exact) ? mathHit
                : (proseHit || mathHit);

        // THE ALIGNMENT ANSWERS FIRST, WHEN IT HAS AN ANSWER.
        //
        // It knows which glyph was clicked by POSITION rather than by name, so
        // it resolves the glyphs a name-based search never could: a stretched
        // `\bigl(` that the PDF reports as an unnameable control code, a symbol
        // whose command is not in any table, or a character sitting on a line
        // SyncTeX never attributed anything to. Only when it has nothing to say
        // does the older per-line search run.
        const alignObj = hit.object && !hit.object.approximate ? hit.object : null;
        // THE ENGINE'S MAP FIRST. When the compile produced a GlyphMap the
        // window map answers by exact position and exact line; the text-layer
        // object map is the fallback for a generation without one.
        const exactMap = st.map.exact ? this._alignMap(st, doc, hit.line, alignObj) : null;
        const amap = exactMap || this._objectMap(st, doc, alignObj);
        const exactHit = !!exactMap;
        let aligned = null;
        let ambiguous = null;
        let unsourced = false;
        if (amap) {
            const g = glyphAtPoint(amap, m.page, m.xBp, m.yTopBp);
            // A CLICK IN BLANK SPACE STILL NAMES A LINE — THE RIGHT ONE. With an
            // exact map the fallback below is "the whole line", and the line
            // it used was where the glyphs are FILED. For a run-in `\paragraph`
            // heading that is the text line after it, so a drag that started a
            // hair before "Why" selected from the paragraph and left the
            // heading behind (reported). The nearest token's own line is the
            // honest line; the word rung stays unclaimed, so a plain click in
            // blank space still answers with the line, not a word.
            if (exactHit && g.index >= 0 && g.distance >= 12) {
                const ti0 = amap.renToSrc[g.index];
                if (ti0 >= 0 && amap.tokens[ti0].line !== hit.line) {
                    hit.line = amap.tokens[ti0].line;
                    lineIdx = Math.max(0, Math.min(hit.line - 1, doc.lineCount - 1));
                    lineSrc = doc.lineAt(lineIdx).text;
                }
            }
            if (process.env.WB_JUMP_DEBUG) {
                const near = amap.glyphs.map((q, i) => ({ i, ch: q.ch, x: +q.x.toFixed(1), y: +q.y.toFixed(1), w: +q.w.toFixed(1), h: +q.h.toFixed(1), iy: q.inkY != null ? +q.inkY.toFixed(1) : null, ih: q.inkH != null ? +q.inkH.toFixed(1) : null }))
                    .filter(q => q.x - 6 < m.xBp && q.x + q.w + 6 > m.xBp && Math.abs(q.y + q.h / 2 - m.yTopBp) < 14);
                // eslint-disable-next-line no-console
                console.log('[jump:near]', JSON.stringify({ at: [+m.xBp.toFixed(1), +m.yTopBp.toFixed(1)], pick: g.index, d: +g.distance.toFixed(2), near }));
            }
            // 12 bp is about one line of body text: further than that and the
            // click was not really on this object's glyph.
            if (g.index >= 0 && g.distance < 12) {
                const ti = amap.renToSrc[g.index];
                if (ti >= 0) aligned = amap.tokens[ti];
                // PAIRED WITH NOTHING. Some glyphs have no source token at all
                // — a pmatrix's own parentheses, a stretched delimiter the PDF
                // reports as a control code, the dots of an ellipsis. What is
                // certain is the construct they sit in, so that is the answer.
                //
                // MATHS ONLY. In prose there are no constructs to fall back to,
                // so the "smallest certain thing" is the whole paragraph — and
                // answering a click on a word with its entire paragraph is
                // exactly the coarseness this feature exists to avoid. Prose has
                // better fallbacks of its own: the word, then the line.
                else if ((alignObj && MATH_KINDS.includes(alignObj.kind)) || (exactHit && amap.inMath)) {
                    ambiguous = groupAround(amap, g.index);
                }
                // PROSE INK WITH NO SOURCE — "Figure 1:", a section number —
                // still sits beside ink that has one. The honest answer is that
                // neighbour's LINE, never the whole float the ladder would
                // otherwise hand back.
                else if (exactHit) {
                    let nb = -1;
                    for (let k = 1; k < 40 && nb < 0; k++) {
                        if (g.index + k < amap.glyphs.length && amap.renToSrc[g.index + k] >= 0) nb = amap.renToSrc[g.index + k];
                        else if (g.index - k >= 0 && amap.renToSrc[g.index - k] >= 0) nb = amap.renToSrc[g.index - k];
                    }
                    if (nb >= 0) {
                        hit.line = amap.tokens[nb].line;
                        lineIdx = Math.max(0, Math.min(hit.line - 1, doc.lineCount - 1));
                        lineSrc = doc.lineAt(lineIdx).text;
                        unsourced = true;
                    }
                }
            }
        }
        // Set inside the aligned branch below; false until something says prose.
        let hitInProse = false;
        if (aligned) {
            hit.line = aligned.line;
            lineIdx = Math.max(0, Math.min(aligned.line - 1, doc.lineCount - 1));
            lineSrc = doc.lineAt(lineIdx).text;
            const glyphToken = {
                start: aligned.startCol,
                end: aligned.endLine === aligned.line ? aligned.endCol : lineSrc.length,
                word: aligned.ch,
                exact: true,
                occurrence: 1,
                total: 1,
                inMath: !!aligned.inMath,
            };
            // THE UNIT IS DIFFERENT IN PROSE. The alignment works character by
            // character, which is right inside an equation and wrong in a
            // sentence: clicking a word there would select one LETTER of it.
            // In prose the alignment's real contribution is the LINE — which is
            // the part SyncTeX gets wrong — so it fixes the line and the word
            // stays the unit.
            //
            // AND WHEN THE NAME SEARCH FINDS NOTHING, THE CHARACTER IS STILL A
            // POSITION. Falling back to the glyph token there is what put a
            // single letter in the editor when a word was clicked — reported on
            // headings and on the paragraphs the model does treat as objects.
            // The alignment has already said WHICH character; the word is
            // simply the token containing that column.
            const isMath = (alignObj && MATH_KINDS.includes(alignObj.kind)) || aligned.inMath;
            // THE CARET-IN-WORD IDEA IS A PROSE ONE.
            //
            // In maths a click resolves the MACRO that printed the symbol —
            // `\Psi` for a Ψ — and selecting it is the right answer: there is
            // no "middle of the word" to point at, because the reader clicked
            // the symbol, not a letter of its name. Collapsing there would take
            // away a useful selection and answer a question nobody asked.
            hitInProse = !isMath;
            if (isMath) {
                w = glyphToken;
            } else if (exactHit) {
                // The exact map has said WHICH character; the word is the run
                // of tokens around it, narrowed to what the panel saw.
                const ti = amap.tokens.indexOf(aligned);
                const run = this._wordFromTokens(amap, ti, lineSrc, m.word || null);
                w = run ? {
                    start: run.start, end: run.end, word: run.word,
                    exact: true, occurrence: 1, total: 1, inMath: false,
                } : glyphToken;
            } else {
                // The occurrence hint has to come along: recomputing without
                // it threw away the only thing that can tell two identical
                // words on one line apart, and the first one always won.
                const pw = m.word
                    ? findWordInLine(lineSrc, m.word, m.rowFraction ?? 0.5, {
                        macros,
                        occurrence: this._occurrenceOnLine(
                            st, hit.file, hit.line, m.wordSpots, m.wordAt),
                    })
                    : null;
                let around = null;
                if (!(pw && pw.exact)) {
                    const at = wordAtColumn(lineSrc, aligned.startCol, { macros });
                    if (at) {
                        around = {
                            start: at.sourceStart,
                            end: at.sourceEnd,
                            word: at.word,
                            exact: true,
                            occurrence: at.occurrence,
                            total: at.total,
                            inMath: !!at.inMath,
                        };
                    }
                }
                w = (pw && pw.exact) ? pw : (around || pw || glyphToken);
            }
        }

        // THE WORDS AROUND IT OUTRANK EVERY POSITION, BECAUSE THEY CANNOT BE
        // MISFILED.
        //
        // Everything above reasons from SyncTeX's line attribution, and
        // measured (`Experiments/wolfbook-tex/e-viewer/check-occurrence.mjs`)
        // that attribution is wrong at the two places that matter most: the
        // FIRST word of a continuation row is filed under the line the
        // PARAGRAPH ends on, and a word sitting across a row break can carry
        // its neighbour's line number. A source line's first word is nearly
        // always at a row break — which is why "clicking the first word of a
        // line" arrived as a bug report of its own.
        //
        // The printed neighbours have no such problem: they are what the page
        // says. Matching them against the projection of a few lines around the
        // guess pins down the LINE as well as the column, so a misfiled record
        // coming in stops being a wrong selection going out. It answers only
        // when the evidence is unambiguous — a tie returns nothing and the
        // heuristics above stand.
        //
        // PROSE ONLY. In maths the alignment already answers by position, which
        // is stronger than context there: single glyphs repeat constantly and
        // their neighbours are mostly other single glyphs.
        //
        // THE GUARD ASKS WHETHER THE CLICK IS IN MATHS, NOT WHETHER THE WINNING
        // READING CAME FROM A MATH-SCOPED SEARCH. The glyph reading is ALWAYS
        // tagged inMath — it is produced by searching in maths scope — so
        // testing `w.inMath` switched this rescue off every time the glyph
        // reading won, which is exactly when it is needed. Measured
        // (check-occurrence): clicking `single-valued` resolved to the letter
        // `l` of "allowed" on the line ABOVE, because the word is not on the
        // line SyncTeX named, the glyph `l` is, and the context that knew
        // better was never consulted.
        const clickInMaths = !!(aligned && aligned.inMath) ||
            !!(hit.object && !hit.object.approximate && MATH_KINDS.includes(hit.object.kind));
        if (m.word && m.wordContext && !clickInMaths && !(exactHit && aligned)) {
            // HOW FAR TO LOOK: AS FAR AS THE THING THE CLICK IS INSIDE.
            //
            // The default window is two lines either side, which is the right
            // size for prose — a paragraph's words are filed within a line or
            // two of where they print. A CAPTION is not filed that way. TeX
            // hands the whole of it to ONE source line, and that line is the
            // LAST one, the one holding the closing brace.
            //
            // MEASURED on the reference paper (check-paper.mjs, page 2): the
            // nine printed rows of figure 2's caption are all filed under line
            // 220, `for arbitrary $0<s_\alpha<1$.}`, while the word "Adjacent"
            // that was clicked lives on line 216. Four lines away, so the
            // window could not reach it, no word resolved, and the click fell
            // back to the enclosing object — selecting the entire float, lines
            // 159 to 222. Fifty of that page's sixty-three failures were this.
            //
            // So the window becomes the object's own extent whenever the click
            // is inside one: a caption cannot be filed further away than the
            // float it belongs to. Display equations keep the narrow window —
            // they are read glyph by glyph by the alignment, not by context.
            const encl = hit.object;
            const reach = (encl && !encl.approximate && !MATH_KINDS.includes(encl.kind) &&
                Number.isFinite(encl.startLine) && Number.isFinite(encl.endLine))
                ? Math.max(hit.line - encl.startLine, encl.endLine - hit.line)
                : 0;
            const span = Math.min(80, Math.max(2, reach));
            const found = locateByContext(doc.getText().split(/\r?\n/), hit.line,
                m.word, m.wordContext.before, m.wordContext.after, { macros, span });
            if (found) {
                if (found.line !== hit.line) {
                    hit.line = found.line;
                    lineIdx = Math.max(0, Math.min(found.line - 1, doc.lineCount - 1));
                    lineSrc = doc.lineAt(lineIdx).text;
                    hit.object = st.map.objectAtLine(hit.file, found.line) || undefined;
                }
                w = found;
            }
        }

        // A GLYPH THAT IS NOT ON ITS OWN LINE: in a multi-line display, TeX
        // attributes some records to a neighbouring source line (the \end, a
        // continuation), so the clicked symbol's real line may be another line
        // of the SAME equation. Before giving up on an exact match, search the
        // object's other lines, nearest first.
        if (!aligned && m.glyph && !(w && w.exact) && hit.object && !hit.object.approximate &&
            MATH_KINDS.includes(hit.object.kind) &&
            hit.object.endLine - hit.object.startLine < 12) {
            const near = [];
            for (let n = hit.object.startLine; n <= hit.object.endLine; n++) {
                if (n !== hit.line) near.push(n);
            }
            near.sort((a, b) => Math.abs(a - hit.line) - Math.abs(b - hit.line));
            for (const n of near) {
                if (n < 1 || n > doc.lineCount) continue;
                const src2 = doc.lineAt(n - 1).text;
                const g2 = findWordInLine(src2, m.glyph, m.glyphFraction ?? 0.5,
                    { scope: 'math', inMath: true, macros });
                if (g2 && g2.exact) {
                    w = g2;
                    hit.line = n;
                    lineIdx = n - 1;
                    lineSrc = src2;
                    break;
                }
            }
        }

        // AN UNCERTAIN GLYPH SELECTS WHAT IS CERTAIN AROUND IT.
        //
        // Reaching here with an unpaired glyph and no exact name match means
        // every remaining candidate is a guess — and a confident wrong jump is
        // worse than a true coarse one. `groupAround` gives the smallest
        // construct that provably contains the click: the subscript group, the
        // numerator, else the object.
        let groupStep = null;
        if (ambiguous && !(w && w.exact)) {
            const clamp = (ln) => Math.max(0, Math.min(ln - 1, doc.lineCount - 1));
            const s0 = clamp(ambiguous.startLine);
            const s1 = clamp(ambiguous.endLine);
            groupStep = {
                kind: 'group',
                label: ambiguous.depth > 0 ? 'enclosing group' : 'this expression',
                lines: s1 - s0 + 1,
                start: { line: s0 + 1, col: Math.min(ambiguous.startCol, doc.lineAt(s0).text.length) },
                end: { line: s1 + 1, col: Math.min(ambiguous.endCol, doc.lineAt(s1).text.length) },
            };
            w = null;                       // the word rung is not available here
        }

        // NOTHING RESOLVED, BUT SOMETHING WAS NEAREST.
        //
        // The honest fallback used to be the whole LINE, and a click a little to
        // the right of the last word therefore selected the entire line — which
        // is never what a click means. The panel knows which word was nearest;
        // it simply declined to call it a hit. Where the alternative is a whole
        // line, the nearest word is the better answer, and it is still bounded
        // by the spaces either side of it.
        if (!w && m.farWord) {
            const near = findWordInLine(lineSrc, m.farWord, m.rowFraction ?? 0.5, {
                macros,
                occurrence: this._occurrenceOnLine(st, hit.file, hit.line, m.wordSpots, m.wordAt),
            });
            if (near) w = near;
        }

        // WIDENING IS OPT-IN, ON Cmd/Ctrl.
        //
        // It used to happen on any repeat click in the same place, and that was
        // wrong: a plain click means "this symbol" essentially always, so a
        // reader clicking around to explore watched their selection grow from a
        // word to a subsection without asking for it. Now a plain click always
        // lands on the tightest thing, and holding Cmd walks outwards — the
        // first Cmd-click straight to the first container above the word, since
        // asking to widen and getting the word again would do nothing.
        const near = !!m.widen && this._ladder && this._ladder.page === m.page &&
            Math.hypot(m.xBp - this._ladder.xBp, m.yTopBp - this._ladder.yBp) < 36;
        if (near && this._ladder.items.length) {
            this._ladder.index = m.shrink
                ? Math.max(0, this._ladder.index - 1)
                : Math.min(this._ladder.items.length - 1, this._ladder.index + 1);
        } else {
            const model = this._modelFor(doc);
            const lines = doc.getText().split(/\r?\n/);
            let sections = [];
            try {
                sections = model ? sectionSpans(model.objects, lines.length, lines.length) : [];
            } catch (_) { /* the ladder still works without headings */ }
            const items = selectionLadder({
                lines, model, sections, file: hit.file, line: hit.line,
                column: w ? w.start : 0,
                word: w ? { start: w.start, end: w.end } : null,
            });
            this._ladder = {
                page: m.page, xBp: m.xBp, yBp: m.yTopBp, items, file: hit.file,
                index: m.widen ? Math.min(1, Math.max(0, items.length - 1)) : 0,
            };
        }

        let step = this._ladder.items[this._ladder.index];
        // The certain-group answer outranks the ladder's fallback, but only for
        // a plain click: Cmd-click is a request to walk the ladder itself.
        if (groupStep && !m.widen) step = groupStep;
        if (process.env.WB_JUMP_DEBUG) {
            try {
                // eslint-disable-next-line no-console
                console.log('[jump]', JSON.stringify({
                    at: [m.page, +m.xBp.toFixed(1), +m.yTopBp.toFixed(1)], glyph: m.glyph, word: m.word,
                    hit: { line: hit.line, exact: !!hit.exact, obj: hit.object && hit.object.kind },
                    exactHit, window: exactMap && exactMap.window, inMath: exactMap && exactMap.inMath,
                    aligned: aligned && { ch: aligned.ch, line: aligned.line, col: aligned.startCol, inMath: aligned.inMath },
                    w: w && { start: w.start, end: w.end, word: w.word, exact: w.exact },
                    step: step && { kind: step.kind, s: step.start, e: step.end },
                }));
            } catch (_) { /* debug only */ }
        }

        // A PLAIN CLICK NEVER SELECTS MORE THAN THE THING IT LANDED ON.
        //
        // The ladder's first rung is the word — unless no word resolved, in
        // which case the first rung is whatever comes next: the paragraph, or
        // with no paragraph, the SECTION. So a click whose word could not be
        // matched silently selected the whole section, which is what "I clicked
        // a word and got the whole paragraph" looks like from the outside.
        // Widening is opt-in on Cmd, and that has to hold even when the fine
        // resolution failed: the honest fallback is the line that was clicked.
        //
        // The commonest way to reach it is a click that lands BETWEEN words:
        // `wordAtPoint` in the webview refuses rather than claiming a glyph
        // several words away, so no word is sent, nothing resolves, and the
        // rung after `word` used to be taken instead.
        if (!m.widen && step && step.kind !== 'group' && !PLAIN_CLICK_KINDS.has(step.kind)) step = null;
        // Ink without a source token answers with its neighbour's line only.
        if (unsourced && !m.widen && !(w && w.exact)) step = null;
        // A FOCUSED READING LAYOUT MUST SURVIVE A CLICK.
        //
        // Full screen is `toggleMaximizeEditorGroup`: only the viewer's group is
        // on screen. `showTextDocument` in column ONE makes that group visible
        // again, and VS Code cancels the maximize to do it — so every inverse
        // click dropped the reader out of full screen, which is precisely the
        // mode in which the mini-editor is the point.
        //
        // So while full screen: use an editor for this document only if one is
        // ALREADY visible, and otherwise move nothing. The card and the page
        // still get the answer. A double-click means "take me there" and is
        // supposed to restore the editor + viewer layout. Do that
        // BEFORE showTextDocument: recent VS Code builds otherwise try to
        // repair the maximized groups while the right-hand panel also changes.
        if (m.takeMe && this._fsActions) await this.setLayoutMode('all');
        const inFocusedLayout = !!this._fsActions;
        // Picking a comment target belongs wholly to the viewer. Opening or
        // focusing the source editor here would make a quiet annotation
        // gesture rearrange the reader's workspace.
        const editor = m.commentTarget ? null : inFocusedLayout
            ? (vscode.window.visibleTextEditors || [])
                .find(e => e.document && e.document.uri.fsPath === doc.uri.fsPath) || null
            : await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: !m.takeMe,   // reading stays in the PDF; "go there" does not
                preview: false,
            });

        // THE CHARACTER THAT WAS CLICKED, kept beside the word it belongs to.
        //
        // A reader clicks the MIDDLE of a word, and the answer has always been
        // the whole word — right for saying which word, but it threw away the
        // finer thing the exact map already knew. `aligned` is the glyph that
        // was actually hit, so its source column is where the pointer was.
        const hitPos = (aligned && aligned.line === lineIdx + 1 && aligned.startCol != null)
            ? new vscode.Position(lineIdx,
                Math.max(0, Math.min(aligned.startCol, doc.lineAt(lineIdx).text.length)))
            : null;

        let range;
        let what;
        if (step) {
            range = new vscode.Range(
                new vscode.Position(step.start.line - 1, step.start.col),
                new vscode.Position(Math.min(step.end.line - 1, doc.lineCount - 1), step.end.col));
            const more = this._ladder.index < this._ladder.items.length - 1
                ? ` · ${process.platform === 'darwin' ? '⌘' : 'Ctrl+'}click to widen` : '';
            what = step.kind === 'group'
                ? `${step.label} — that symbol has no source token of its own`
                : `${step.label} (line ${step.start.line})${more}`;
        } else {
            // SAY WHY THE ANSWER IS COARSE. This is the honest fallback, and
            // without a reason it reads as the feature simply misbehaving.
            range = doc.lineAt(lineIdx).range;
            what = `line ${hit.line} — ` + (m.word || m.glyph
                ? `no match for ${JSON.stringify(m.glyph || m.word)} here`
                : 'nothing under the pointer');
        }
        // SHIFT-CLICK PICKS THE ENDS OF A SELECTION.
        //
        // The first one remembers where the selection starts and marks it on the
        // page; the second closes the range, selects it in the editor and paints
        // the span. Everything up to here is the ordinary resolution, so the
        // ends land on the same exact token a plain click would have chosen —
        // this gesture adds no new way of being wrong.
        if (m.pick) {
            const anchor = this._pickAnchor;
            if (!anchor || anchor.file !== hit.file) {
                this._pickAnchor = { file: hit.file, position: range.start, label: what };
                this._post({
                    type: 'selection',
                    span: {
                        pendingStart: true,
                        start: this._selectionAnchor(st, doc, hit.line, range.start.character),
                        end: null, rows: [], lines: 1,
                    },
                    reveal: false,
                    label: `selection starts at ${what} · shift-click the other end`,
                });
                this._post({ type: 'status', text: 'selection start — shift-click the other end', kind: 'ok' });
                return;
            }
            const a = anchor.position;
            const b = range.end;
            const forwards = a.line < b.line || (a.line === b.line && a.character <= b.character);
            let from = forwards ? a : b;
            let to = forwards ? b : a;
            // A SELECTION IS WIDENED UNTIL WHOLE, like a moved fragment is: a
            // range that starts inside `\paragraph{…}` and ends in the paragraph
            // after it takes the command along — "impossible to select the
            // paragraph with its title from the viewer" was exactly this, the
            // heading's braces cut by a start on its first word.
            try {
                const whole = balanceRange(doc.getText(), doc.offsetAt(from), doc.offsetAt(to));
                if (whole.widened) { from = doc.positionAt(whole.from); to = doc.positionAt(whole.to); }
            } catch (_) { /* the raw range stands */ }
            const picked = new vscode.Selection(from, to);
            // A DRAG IN PROGRESS SHOWS THE RANGE AT BOTH ENDS. The page repaints
            // it on every move and the editor selects it as it goes, so the two
            // windows are never out of step while the hand is moving. The
            // anchor survives until the button is released.
            if (m.live) {
                this._postSelection(st, doc, picked);
                if (editor) {
                    this._selfRange = {
                        file: doc.uri.fsPath, kind: 'drag',
                        sl: picked.start.line, sc: picked.start.character,
                        el: picked.end.line, ec: picked.end.character,
                        at: Date.now(),
                    };
                    editor.selection = picked;
                }
                return;
            }
            this._pickAnchor = null;
            if (editor) {
                editor.selection = picked;
                editor.revealRange(picked, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
            // Post it directly rather than relying on the editor's own change
            // event: in full screen there may be no visible editor at all, and
            // the page must still show what was picked.
            this._postSelection(st, doc, picked);
            this._post({
                type: 'status',
                text: `selected lines ${from.line + 1}–${to.line + 1}`,
                kind: 'ok',
            });
            return;
        }
        // A plain click abandons a half-made selection: leaving it armed would
        // turn an ordinary click three minutes later into a mystery range.
        this._pickAnchor = null;

        // A CLICK IN THE MIDDLE OF A WORD PUTS THE CARET IN THE MIDDLE OF IT.
        //
        // VS Code's caret is always at one END of a selection, so a selected
        // word can only ever put it before or after — never where the pointer
        // actually was. The word is therefore OUTLINED rather than selected
        // (the decoration this gesture already drew), and the selection
        // collapses to the clicked character. The reader gets both: the word is
        // visibly marked, and typing continues exactly where they pointed.
        //
        // Only for a plain click on a WORD. A widened Cmd-click means "select
        // this group" and a double-click means "take me there to work on it" —
        // both want a real selection, and a double-clicked word stays selected
        // so it can be typed over.
        // Containment computed, not asked for: `Range.contains` is a host method
        // and this must never be able to throw out of the jump — the same rule
        // the flash decoration follows, and a stubbed host caught it doing
        // exactly that. Arithmetic on line/character needs nothing from vscode.
        const inRange = (r, pos) => !!r && !!pos &&
            (pos.line > r.start.line || (pos.line === r.start.line && pos.character >= r.start.character)) &&
            (pos.line < r.end.line || (pos.line === r.end.line && pos.character <= r.end.character));
        // Type-to-edit cannot fall back to replacing the WHOLE word merely
        // because the glyph alignment is not ready yet. pdf.js still gives us
        // the fraction of the printed word that was clicked; map that fraction
        // into the already-resolved source word and use it as a collapsed
        // caret. Exact glyph alignment, when present, remains the first choice.
        const typingInProse = hitInProse ||
            (Number.isFinite(m.typingRequest) && !clickInMaths);
        let typingPos = null;
        if (!hitPos && Number.isFinite(m.typingRequest) && typingInProse &&
            step && step.kind === 'word' && range.start.line === range.end.line) {
            const fraction = Number.isFinite(m.rowFraction)
                ? Math.max(0, Math.min(1, m.rowFraction)) : 0.5;
            const width = Math.max(0, range.end.character - range.start.character);
            typingPos = new vscode.Position(
                range.start.line, range.start.character + Math.round(width * fraction));
        }
        // In genuinely blank paper there may be no nearby word at all. Typing
        // must still collapse to a caret: leaving `typingPos` null here would
        // select the fallback line and replace all of it with the first key.
        // The printed row tells us which END of that source line the blank is
        // nearest to. Between words the `farWord` path above is finer and wins.
        if (!hitPos && !typingPos && Number.isFinite(m.typingRequest) && typingInProse) {
            let rows = [];
            try { rows = (st.map.lineRows(hit.file, hit.line) || []).filter(r => r.page === m.page); }
            catch (_) { rows = []; }
            let row = null; let distance = Infinity;
            for (const r of rows) {
                const dy = m.yTopBp < r.y ? r.y - m.yTopBp
                    : (m.yTopBp > r.y + r.h ? m.yTopBp - (r.y + r.h) : 0);
                if (dy < distance) { distance = dy; row = r; }
            }
            const lineText = doc.lineAt(lineIdx).text;
            const column = row && m.xBp > row.x + row.w / 2 ? lineText.length : 0;
            typingPos = new vscode.Position(lineIdx, column);
        }
        const caretPos = hitPos || typingPos;
        const caretHere = !!caretPos && typingInProse && !m.takeMe && !m.widen &&
            ((!step && Number.isFinite(m.typingRequest)) ||
                (step && step.kind === 'word' && inRange(range, caretPos))) &&
            (Number.isFinite(m.typingRequest) || this._inverseClickCaret());
        const placed = caretHere
            ? new vscode.Selection(caretPos, caretPos)
            : new vscode.Selection(range.start, range.end);
        // Remember what this click is about to select, so the change event it
        // provokes is not mistaken for the reader making a selection. It must
        // record what is ACTUALLY set: recording the word while placing a caret
        // would leave the forward sync unable to recognise its own gesture.
        this._selfRange = {
            file: doc.uri.fsPath, kind: 'click',
            sl: placed.start.line, sc: placed.start.character,
            el: placed.end.line, ec: placed.end.character,
            at: Date.now(),
        };
        if (editor) {
            editor.selection = placed;
            // Reveal the WORD, not the caret: scrolling to a zero-width
            // position can leave the rest of the word off the edge.
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            this._offerSmoothScroll();
            // The page marks where you are with a wash that fades; the editor
            // end of the same gesture now does too, decaying into the ordinary
            // selection rather than just appearing there. With the caret placed
            // inside the word this outline is the ONLY thing naming the word,
            // so it is no longer decoration — it is half the answer.
            this._flash.show(editor, range);
        }
        const _cardWhy = (() => {
            try {
                return this._postEditSelection(
                    doc, range, !m.takeMe, caretHere ? caretPos : null, m.typingRequest);
            }
            catch (_) { return null; }
        })();
        this._post({
            type: 'status',
            // Only worth saying when a card IS open and did not follow — with
            // no card there is nothing to explain.
            text: `→ ${what}` + (this._edit && _cardWhy ? `  · card not moved: ${_cardWhy}` : ''),
            kind: 'ok',
        });

        // WITH A MINI-EDITOR OPEN, THE CARD IS THE EDITING SURFACE.
        //
        // The reader has a block open and clicks its rendered symbol: the caret
        // belongs where they pointed, in the card, not only in the text editor
        // behind it. Focus follows for a plain click (which leaves focus in the
        // webview anyway); a double-click means "take me to the editor", so it
        // must not be stolen back.
        // (The card was told above, together with the status line that reports
        // it when it could not follow. `caretHere` is the decision already made
        // for the editor, so the two surfaces cannot disagree.)

        // MORE THAN ONE WORD IS A SELECTION, AND THE PAGE SAYS SO.
        //
        // A widened Cmd-click selects a group, a sentence, a paragraph or an
        // object in the editor — and the page used to answer with the amber
        // "where you are" wash over whole line rows, which is the wrong colour
        // (amber is the cursor, red is what is selected), the wrong shape (a
        // partial first and last line are covered whole) and the wrong object:
        // nothing could be taken hold of, copied or dragged. It is a selection,
        // so it is drawn as one — with the same word-accurate ends a selection
        // made in the editor gets. A step too large to outline keeps the label.
        if (step && step.kind !== 'word') {
            const sel = new vscode.Selection(range.start, range.end);
            if (this._isMultiWord(doc, sel) && (step.lines || 1) <= 60) {
                this._postSelection(st, doc, sel);
            } else {
                this._showSpan(st, hit.file, step);
            }
        }

        // "Take me there" restored the complete layout before revealing the
        // editor above. There must be no late toggle here: it races VS Code's
        // own group restoration.
    }

    // --- comparing two versions ----------------------------------------------
    //
    // Read-only for now: what differs, named, and marked on the pages already on
    // screen. Accept comes next; see the plan's staged order and, in particular,
    // the four hazards it has to design around (checkWritable's baseline, our
    // own save waking the conflict modal, parking the other version before the
    // first write, and the compile storm).

    /**
     * Ask what to compare against, offering only what is actually available.
     *
     * A paper with no repository must not be shown a git option it cannot use,
     * and a paper identical to its file on disk must not offer that either —
     * an entry that leads to "no differences" is a wasted click.
     */
    async offerComparison() {
        if (!this.root) return;
        try {
            await vscode.commands.executeCommand('wolfbook.tex.compareWith');
        } catch (e) {
            this._post({ type: 'status', text: `could not compare: ${e.message}`, kind: 'err' });
        }
    }

    /** The render map, in the shape texCompare's placement rules expect. */
    _compareMap(st, file) {
        const map = st && st.map;
        if (!map || !map.available) return {};
        return {
            rowsFor: (line) => map.lineRows(file, line),
            objectAtLine: (line) => map.objectAtLine(file, line),
            objectRects: (obj) => {
                // objectRenderBoxes wants the model's own object, and its box
                // includes \abovedisplayskip — so prefer the object's ROWS,
                // exactly as the highlight path learned to.
                const rows = this._editRects(st, file, obj.startLine, obj.endLine);
                if (rows.length) return rows;
                const model = this._modelFor2(file);
                const real = model && model.objects.find(o => o.stableKey === obj.stableKey);
                if (!real) return [];
                const r = map.objectRenderBoxes(real);
                return (r && r.rects) || [];
            },
            locate: (startLine, endLine) => {
                const r = map.sourceToRender(file, startLine, endLine);
                return r ? { page: r.page, exact: r.exact, matchedLine: r.matchedLine } : null;
            },
        };
    }

    /** A compare map that is safe to use for the PDF ACTUALLY open. */
    _reviewMap(st, file) {
        const base = st ? this._compareMap(st, file) : {};
        // The source changed but the installed map still belongs to the old
        // source/PDF pair. Keep semantic object lookup for grouping only; the
        // absence of rowsFor makes texCompare deliberately return no page
        // placement until compilation catches up.
        const geometry = st && st.sourceAhead
            ? { objectAtLine: base.objectAtLine }
            : base;
        let generation = st && !st.sourceAhead && st.generation
            ? st.generation.generation : null;
        // Identical bytes are not shipped again. The refreshed map describes
        // the already-open ink, so name that acknowledged render.
        if (generation != null && this._openedGeneration != null &&
            this._openedPdfHash && st.generation.pdfHash &&
            this._openedPdfHash === st.generation.pdfHash) {
            generation = this._openedGeneration;
        }
        return { ...geometry, generation };
    }

    // --- the label overlay ---------------------------------------------------
    //
    // Hold Shift and the paper shows its own skeleton: every \label beside the
    // thing it names, every \ref and \cite beside the label it points at. It
    // answers the question a writer asks a dozen times an hour — "what is this
    // equation called?" — without leaving the page, and a click puts the
    // reference on the clipboard ready to paste.
    //
    // Built LAZILY and cached per generation. The webview asks the first time
    // Shift goes down; after that a new compile re-pushes only while somebody
    // is still watching.

    /**
     * The model for every file of this root — not only the open ones.
     *
     * `_modelFor2` can see a document only if VS Code has it open, which is the
     * root and nothing else on a split paper. A label declared in `sections/
     * intro.tex` is still a label of this paper, so the files are read from
     * disk when they are not open.
     */
    _projectModels(st) {
        const files = (st && st.files && st.files.length) ? st.files : [this.root];
        const key = files.join('|');
        if (this._chipModels && this._chipModels.key === key) return this._chipModels.models;
        const models = new Map();
        for (const f of files.slice(0, 64)) {
            let model = this._modelFor2(f);
            if (!model) {
                try {
                    const text = fs.readFileSync(f, 'utf8');
                    model = this.projection.fromText(text, f);
                } catch (_) { model = null; }
            }
            if (model) models.set(f, model);
        }
        this._chipModels = { key, models };
        return models;
    }

    /** Every chip for the paper on screen, memoised on the shown generation. */
    _labelChips(st) {
        if (!st || !st.map || !st.map.available) return [];
        const files = (st && st.files && st.files.length) ? st.files : [this.root];
        const key = `${this.shownGeneration}|${files.join('|')}`;
        if (this._chips && this._chips.key === key) return this._chips.items;

        const models = this._projectModels(st);
        const objects = [];
        for (const model of models.values()) objects.push(...(model.objects || []));

        // What LaTeX itself numbered each label as. A capped single-pass live
        // build may not have converged, and a stale number is worse than none —
        // it would be read as fact.
        let aux = { labels: new Map(), cites: new Map() };
        const gen = st.generation;
        if (gen && gen.outDir && !gen.passesLimited) {
            try {
                aux = readAuxLabels(gen.outDir, gen.root || this.root, {
                    readFile: (f) => fs.readFileSync(f, 'utf8'),
                    exists: (f) => fs.existsSync(f),
                });
            } catch (_) { /* chips simply lose their numbers */ }
        }

        // Which names exist, so a \ref to nothing can be shown as broken rather
        // than silently placed.
        const declared = new Set();
        for (const o of objects) {
            if (o.kind === 'label' && o.name) declared.add(o.name);
            else if (o.label) declared.add(o.label);
        }

        let items = [];
        try {
            items = buildLabelChips({
                objects,
                file: this.root,
                rowsFor: (f, line) => st.map.lineRows(f, line),
                boxFor: (o) => st.map.objectRenderBoxes(o),
                printedFor: (n) => aux.labels.get(n) || null,
                citeFor: (n) => aux.cites.get(n) || null,
                inkFor: (page) => (this._textReady() ? this._text.pages.get(page) : null),
                declared,
                // A number is recognised by sitting in the RIGHT MARGIN, which
                // is a question about the page, not about the equation.
                pageWidth: (gen && gen.pageSize && gen.pageSize.widthBp) || 595.276,
            });
        } catch (e) {
            this._log(`label chips failed: ${e.message}`);
            items = [];
        }
        // WHAT EACH BADGE POINTS AT, so hovering one can show the thing itself
        // rendered. A declaration points at its own object; a reference points
        // at the object its label names. Computed once per generation with the
        // rest of the chips — a hover must not start a model walk.
        const byLabel = new Map();
        for (const o of objects) {
            const n = o.kind === 'label' ? o.name : o.label;
            if (n && o.kind !== 'label' && !byLabel.has(n)) byLabel.set(n, o);
        }
        const targets = new Map();
        for (const c of items) {
            if (c.role === 'cite') continue;          // a bibliography entry is not an object
            const owner = byLabel.get(c.name);
            if (!owner || !owner.sourceRange) continue;
            const key2 = owner.stableKey || `${owner.sourceRange.startLine}`;
            if (!targets.has(key2)) {
                targets.set(key2, this.objectRects(
                    owner.sourceRange.file || this.root,
                    owner.sourceRange.startLine, owner.sourceRange.endLine));
            }
            const rects = targets.get(key2);
            if (rects && rects.length) c.target = rects;
        }

        this._chips = { key, items };
        return items;
    }

    /**
     * A badge on every managed computation, shown with the label overlay.
     *
     * WITHOUT THIS THERE IS NO WAY TO TELL. A managed block is a comment, so it
     * prints nothing; what appears on the page is its OUTPUT — an ordinary
     * figure or equation, indistinguishable from one somebody typed. A reader
     * looking at a plot they generated last week has no way to know it is live,
     * let alone how to get back to the code. So the badge sits on the OUTPUT,
     * which is the thing that is actually visible, and clicking it opens the
     * computation that made it (vision §13: "click figure → generating code").
     *
     * A block whose cells are all ephemeral prints nothing at all. It still
     * gets a badge, anchored to the first printed line after it — otherwise a
     * computation you are using as a scratchpad becomes invisible the moment
     * you close its card.
     */
    _mmaChips(st) {
        if (!st || !st.map || !st.map.available) return [];
        const out = [];
        const files = (st && st.files && st.files.length) ? st.files : [this.root];
        for (const file of files) {
            let doc = null;
            try { doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file) || null; }
            catch (_) { doc = null; }
            let text = null;
            if (doc) text = doc.getText();
            else { try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; } }

            let parsed;
            try { parsed = mmaBlocks.parseMmaBlocks(text, { file }); }
            catch (_) { continue; }

            for (const b of parsed.blocks || []) {
                if (!b.blockId) continue;
                const at = this._mmaAnchor(st, file, b, text);
                if (!at) continue;
                const runnable = b.cells.filter(c => c.kind === 'wolfram').length;
                out.push({
                    role: 'mma',
                    kind: 'mathematica-block',
                    name: b.blockId,
                    blockId: b.blockId,
                    file,
                    state: b.state,
                    // What the badge says, and what hovering it explains.
                    text: '∑' + (runnable > 1 ? ` ${runnable}` : ''),
                    title: `Mathematica computation · ${b.state} — ${b.stateReason}`
                        + '\nClick to open it',
                    at,
                    side: 'left',
                });
            }
        }
        return out;
    }

    /**
     * Where a computation's badge goes: on its output's ink when it has one,
     * else beside the first thing printed after it.
     */
    _mmaAnchor(st, file, block, text) {
        const inkOf = (a, b2) => {
            const rects = this.objectRects(file, a, b2);
            if (!rects.length) return null;
            const page = rects[0].page;
            const same = rects.filter(r => r.page === page);
            if (!same.length) return null;
            return {
                page,
                x: Math.min(...same.map(r => r.x)),
                y: Math.min(...same.map(r => r.y)),
                w: 1,
                h: Math.max(...same.map(r => r.y + r.h)) - Math.min(...same.map(r => r.y)),
            };
        };

        let ink = null;
        for (const f of block.outputs || []) {
            ink = inkOf(f.startLine, f.endLine);
            if (ink) break;
        }
        if (!ink) {
            // Nothing printed by this block. Walk forward to the next line that
            // IS printed, so the badge lands where the block sits in the paper
            // rather than nowhere.
            const total = String(text).split('\n').length;
            for (let n = block.endLine + 1; n <= Math.min(total, block.endLine + 40); n++) {
                ink = inkOf(n, n);
                if (ink) break;
            }
        }
        if (!ink) return null;
        return {
            page: ink.page,
            // Just outside the ink, growing leftwards into the margin — the
            // same column discipline the label chips keep, so the two overlays
            // do not fight for the same strip of paper.
            x: Math.max(6, ink.x - 4),
            y: ink.y,
            w: 1,
            h: Math.min(ink.h, 14),
            maxW: Math.max(20, ink.x - 10),
            anchor: 'left',
        };
    }

    /**
     * Where an equation's `≡` tag belongs: the label badges' own column.
     *
     * Level with the PRINTED NUMBER when the equation has one — that is where
     * a reader's eye already goes to identify an equation, and it is where the
     * badge is — and one chip-height below it, so the two never overlap.
     */
    _equationAnchor(st, file, q, fallbackRow) {
        try {
            const gen = st.generation;
            const pageWidth = (gen && gen.pageSize && gen.pageSize.widthBp) || 595.276;
            const rows = rowsOver((f, line) => st.map.lineRows(f, line),
                file, q.sourceRange.startLine, q.sourceRange.endLine);
            if (!rows.length) return null;
            // The printed number's row when there is one, else the first row.
            const tags = tagRows(rows, pageWidth);
            const row = (tags && tags.length) ? tags[0] : rows[0];
            if (!row) return null;
            const block = blockOf(
                (page) => (this._textReady() ? this._text.pages.get(page) : null),
                row.page, pageWidth);
            const at = inColumn(row, 'right', block);
            if (!at) return null;
            // Below the badge when one is there; level with the number when
            // the equation is unlabelled and no badge will be drawn.
            if (q.label) at.y += CHIP_H + 1;
            return at;
        } catch (_) { return null; }
    }

    _copyFormat() {
        return vscode.workspace.getConfiguration('wolfbook.tex')
            .get('labelCopyFormat', 'command');
    }

    // --- folding a section away ---------------------------------------------
    //
    // Hold Shift and every heading offers to collapse; a collapsed one says so
    // on the page whether Shift is held or not, because a section that is
    // simply MISSING from the paper with no explanation is the worst outcome
    // this feature could have.
    //
    // The .tex records only THAT a section is folded, as two comment lines —
    // the content is left out of the temporary copy WPaper compiles, and
    // nowhere else, so the shared paper stays whole (tex/collapse.js).

    /** The text of one of the project's files, buffer first. */
    _textOf(file) {
        const doc = (vscode.workspace.textDocuments || []).find(d => d.uri.fsPath === file && !d.isClosed);
        if (doc) return doc.getText();
        try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
    }

    /**
     * Every ANCHOR on the page: each sectioning unit and each display equation,
     * with where it prints, whether it can be folded, and where it lives in the
     * source.
     *
     * The headings carry the fold; everything here carries a tag that copies
     * `path:line`, which is how a reader hands an agent a place in the paper
     * ("rewrite the equation at SoVMain.tex:412") without describing it in
     * prose or pasting it.
     */
    _sectionControls(st) {
        if (!st || !st.map || !st.map.available) return [];
        const out = [];
        const models = this._projectModels(st);
        for (const [file, model] of models) {
            const text = this._textOf(file);
            if (text == null) continue;
            const lines = text.split('\n');
            const heads = (model.objects || []).filter(o => o.kind === 'section-heading');
            let numbers = new Map();
            try { numbers = (this.sectionNumbers && this.sectionNumbers(file)) || new Map(); }
            catch (_) { numbers = new Map(); }
            const equations = (model.objects || []).filter(o => o.kind === 'display-equation');
            if (!heads.length && !equations.length) continue;
            let spans = [];
            try { spans = sectionSpans(model.objects, lines.length, collapse.bodyEndLine(lines)); }
            catch (_) { spans = []; }
            for (const h of heads) {
                const span = spans.find(sp => sp.startLine === h.sourceRange.startLine);
                const state = collapse.collapseStateAt(lines, h.sourceRange.endLine);
                // WHERE IT PRINTS. The heading's LAST row: a title that wraps
                // gets its control after the end of the title, not floating
                // beside the middle of it.
                let rows = [];
                try { rows = st.map.lineRows(file, h.sourceRange.endLine) || []; } catch (_) { rows = []; }
                if (!rows.length && h.sourceRange.endLine !== h.sourceRange.startLine) {
                    try { rows = st.map.lineRows(file, h.sourceRange.startLine) || []; } catch (_) { rows = []; }
                }
                // A HEADING WITH NO RECORD OF ITS OWN STILL HAS A PLACE.
                //
                // A run-in \paragraph sets its title inside the following
                // paragraph's first line, so the map may file every glyph under
                // that line and leave the heading's own with none. Such an entry
                // used to carry no page at all — which sorted it to the top of
                // the contents, ahead of section 1, and made it unreachable,
                // because going there asks for rows this line does not have.
                // Reported as "what are these things on top? not clickable and
                // no number".
                // ACROSS THE WHOLE UNIT, not a few lines past its heading. A
                // run-in \paragraph can be followed by macro lines, comments or
                // a display before anything is printed, so counting lines finds
                // nothing; the unit's own body always prints something.
                if (!rows.length) {
                    const to = Math.max(h.sourceRange.endLine, span ? span.endLine : h.sourceRange.endLine);
                    try { rows = st.map.rangeRows(file, h.sourceRange.startLine, to) || []; }
                    catch (_) { rows = []; }
                }
                const row = rows.length ? rows[rows.length - 1] : null;
                const skey = h.stableKey || `${file}:${h.sourceRange.startLine}`;
                out.push({
                    key: skey,
                    kind: 'section',
                    foldable: true,
                    line: h.sourceRange.startLine,
                    file,
                    title: h.title || '',
                    // What LaTeX printed beside it, when the last compile knew.
                    // A contents list without these is a flat run of titles in
                    // which a subsection looks exactly like a section.
                    number: numbers.get(skey) || null,
                    level: h.level || 0,
                    headStart: h.sourceRange.startLine,
                    headEnd: h.sourceRange.endLine,
                    spanEnd: span ? span.endLine : h.sourceRange.endLine,
                    collapsed: state.collapsed,
                    hidden: state.hidden,
                    page: row ? row.page : null,
                    x: row ? row.x : 0,
                    y: row ? row.y : 0,
                    w: row ? row.w : 0,
                    h: row ? row.h : 0,
                });
            }
            // AN EQUATION IS THE THING A READER MOST OFTEN WANTS TO POINT AT,
            // and it usually has no heading anywhere near it. It cannot be
            // folded on its own — the fold is a section-sized gesture — so it
            // carries the tag alone.
            for (const q of equations) {
                let rows = [];
                try { rows = st.map.lineRows(file, q.sourceRange.startLine) || []; } catch (_) { rows = []; }
                if (!rows.length) {
                    try { rows = st.map.lineRows(file, q.sourceRange.startLine + 1) || []; } catch (_) { rows = []; }
                }
                const row = rows.length ? rows[0] : null;
                // THE TAG GOES WHERE THE BADGES GO, NOT ON THE EQUATION.
                //
                // The panel places a cluster just past the row it is given —
                // `x + w + 6`. For a heading that is the empty rest of its
                // line; for a DISPLAY EQUATION the first row is a line of
                // maths, so "just past it" is the middle of the formula, and
                // the tag sat on top of the equation it names. Reported with a
                // screenshot of exactly that.
                //
                // The label badges already solved this problem: one column in
                // the right margin, level with the printed number. The tag now
                // uses the SAME column — computed by the same two functions,
                // so the two overlays cannot drift apart — and sits one chip
                // below the badge, which is where there is room precisely
                // because the badge is above it.
                const anchor = this._equationAnchor(st, file, q, row);
                out.push({
                    key: q.stableKey || `${file}:${q.sourceRange.startLine}`,
                    kind: 'equation',
                    foldable: false,
                    line: q.sourceRange.startLine,
                    file,
                    title: q.label || '',
                    level: 0,
                    headStart: q.sourceRange.startLine,
                    headEnd: q.sourceRange.endLine,
                    spanEnd: q.sourceRange.endLine,
                    collapsed: false,
                    hidden: 0,
                    page: anchor ? anchor.page : (row ? row.page : null),
                    x: row ? row.x : 0,
                    y: anchor ? anchor.y : (row ? row.y : 0),
                    w: row ? row.w : 0,
                    h: row ? row.h : 0,
                    // Final x, already in the margin column: the panel uses
                    // this instead of measuring past the row.
                    anchorX: anchor ? anchor.x : undefined,
                    anchorMaxW: anchor ? anchor.maxW : undefined,
                });
            }
        }
        return out;
    }

    /**
     * A place in the paper, on the clipboard — the point of the tags.
     *
     * ALWAYS THE FULL PATH. A relative one is shorter but it is resolved
     * against whatever directory the reader of it happens to be in, and an
     * agent's is rarely the paper's — these papers usually live outside the
     * workspace folder entirely. An absolute path cannot be resolved wrong,
     * and being unambiguous is the whole job of this string.
     *
     * The LINE is what a model can act on; the PAGE is what a person says out
     * loud. So the plain form is `path:line` — paste it at an agent and it can
     * open the file there — and Alt-click adds the page and the name for a
     * human reading the same message.
     */
    _anchorRef(it, { alt = false } = {}) {
        const ref = `${it.file}:${it.line}`;
        if (!alt) return ref;
        const what = it.kind === 'section' ? (it.title || 'section')
            : (it.title ? `\\label{${it.title}}` : 'equation');
        const where = it.page ? `p. ${it.page} · ` : '';
        return `${ref} (${where}${what})`;
    }

    async _onCopyAnchor(m) {
        const st = this.coord.roots.get(this.root);
        const items = st ? this._sectionControls(st) : [];
        const it = items.find(x => x.key === (m && m.key));
        if (!it) { this._post({ type: 'status', text: 'that place is no longer there', kind: 'warn' }); return; }
        const text = this._anchorRef(it, { alt: !!(m && m.alt) });
        try {
            await vscode.env.clipboard.writeText(text);
            this._post({ type: 'status', text: `Copied ${text}`, kind: 'ok' });
        } catch (e) {
            this._post({ type: 'status', text: `could not copy: ${e.message}`, kind: 'err' });
        }
    }

    async _postSections() {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
        if (!st) return;
        let items = [];
        try { items = this._sectionControls(st); }
        catch (e) { this._log(`section controls failed: ${e.message}`); items = []; }
        const gen = st.generation;
        this._post({
            type: 'sections',
            generation: this.shownGeneration,
            items,
            pageWidth: (gen && gen.pageSize && gen.pageSize.widthBp) || 595.276,
        });
    }

    /**
     * Fold a section away, or bring it back.
     *
     * ONE WorkspaceEdit, so it is ONE undo — a fold the reader did not mean is
     * ⌘Z away, which is what makes the gesture safe to try. The recompile is
     * the ordinary one: the file changed, so the paper does.
     */
    async _onSectionFold(m) {
        const st = this.coord.roots.get(this.root);
        const items = st ? this._sectionControls(st) : [];
        const it = items.find(x => x.key === (m && m.key));
        if (!it) { this._post({ type: 'status', text: 'that section is no longer there', kind: 'warn' }); return; }
        const text = this._textOf(it.file);
        if (text == null) { this._post({ type: 'status', text: `could not read ${path.basename(it.file)}`, kind: 'err' }); return; }
        const lines = text.split('\n');
        const r = m.collapse
            ? collapse.collapseSection({ lines, headEnd: it.headEnd, spanEnd: it.spanEnd, title: it.title })
            : collapse.expandSection({ lines, headEnd: it.headEnd });
        if (!r.ok) { this._post({ type: 'status', text: r.reason, kind: 'warn' }); return; }

        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(it.file)); }
        catch (e) { this._post({ type: 'status', text: `could not open ${path.basename(it.file)}: ${e.message}`, kind: 'err' }); return; }
        const e0 = r.edit;
        const startLine = Math.max(0, Math.min(e0.startLine - 1, doc.lineCount));
        const endLine = Math.max(startLine, Math.min(e0.endLine - 1, doc.lineCount));
        const atEof = endLine >= doc.lineCount;
        const start = new vscode.Position(startLine, 0);
        const end = atEof
            ? new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
            : new vscode.Position(endLine, 0);
        let body = e0.lines.join('\n');
        if (body && !atEof) body += '\n';
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, new vscode.Range(start, end), body);
        let ok = false;
        try { ok = await this._applyReaderEdit(doc, we); } catch (_) { ok = false; }
        if (!ok) { this._post({ type: 'status', text: 'the fold could not be applied', kind: 'err' }); return; }
        // The SPINNER is the only thing added here. The words stay exactly as
        // they were: "the .tex keeps every word" is the reassurance the whole
        // fold design rests on, and dropping it to say "rebuilding…" would
        // trade the thing worth saying for the thing already visible.
        this._busy(m.collapse
            ? `folded away ${r.hidden} line${r.hidden === 1 ? '' : 's'} of "${it.title}" — ` +
              'the .tex keeps every word; only WPaper\'s copy leaves it out'
            : `brought back ${r.shown} line${r.shown === 1 ? '' : 's'} of "${it.title}"`);
        // The controls are read from the file, so they are stale the moment it
        // changes; the recompile that follows re-posts them with the geometry.
        await this._postSections();
    }

    async _postLabels() {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
        if (!st) return;
        const items = this._labelChips(st).concat(this._mmaChips(st));
        this._post({
            type: 'labels',
            generation: this.shownGeneration,
            items,
            format: this._copyFormat(),
        });
    }

    /** Clicking a chip: the reference, on the clipboard. */
    async _copyLabel(m) {
        const format = m && m.alt ? altFormat(this._copyFormat()) : this._copyFormat();
        const text = formatLabelCopy(m && m.name, {
            kind: m && m.kind, role: m && m.role, cmd: m && m.cmd, format,
        });
        if (!text) return;
        try {
            await vscode.env.clipboard.writeText(text);
            this._post({ type: 'status', text: `Copied ${text}`, kind: 'ok' });
        } catch (e) {
            this._post({ type: 'status', text: `could not copy: ${e.message}`, kind: 'err' });
        }
    }

    _modelFor2(file) {
        try {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);
            return doc ? this.projection.get(doc).model : null;
        } catch (_) { return null; }
    }

    /**
     * Compare the open paper against another version of it.
     *
     * @param {{text:string, label:string}} other
     */
    async compareWith(other) {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
        if (!st) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.root)); }
        catch (e) {
            this._post({ type: 'status', text: `could not read the paper: ${e.message}`, kind: 'err' });
            return;
        }
        this._diff = {
            file: this.root,
            label: other.label,
            theirText: other.text,
            // WHICH SIDE IS OLDER. Comparing against a git revision, "theirs"
            // is the other version and a line only we have was added by us.
            // Comparing against what the file held BEFORE somebody else wrote
            // to it, the same hunk means they ADDED it. Same diff, opposite
            // reading — so the direction is carried rather than guessed, and
            // the presentation is swapped once, at the boundary.
            invert: !!other.invert,
            hunks: [], summary: {},
        };
        this.refreshComparison(doc.getText());
        const built = this._diff;
        if (!built.hunks.length) {
            this._post({ type: 'status', text: `no differences against ${other.label}`, kind: 'ok' });
        }
    }

    /**
     * Re-place the open comparison against the newest render.
     *
     * The pages move under a comparison: a recompile lands, lines shift, the
     * map is rebuilt. Rects measured against the previous generation would then
     * mark whatever now occupies that spot — the same trap the cursor highlight
     * hit, which is why it drops itself on a new generation. Here the answer is
     * to recompute rather than to discard, because the reader is in the middle
     * of working through a list.
     */
    refreshComparison(text) {
        const d = this._diff;
        if (!d) return;
        const st = this.coord.roots.get(this.root);
        if (!st) return;
        // The caller usually has the text already; otherwise find the open
        // document. If neither, keep the placement we have rather than
        // clearing a list the reader is working through.
        let ourText = typeof text === 'string' ? text : null;
        if (ourText == null) {
            const doc = (vscode.workspace.textDocuments || [])
                .find(x => x && x.uri && x.uri.fsPath === d.file);
            ourText = doc ? doc.getText() : null;
        }
        if (ourText == null) return;
        try {
            const built = buildComparison({
                ourText, theirText: d.theirText,
                map: this._compareMap(st, d.file),
            });
            d.hunks = built.hunks;
            d.summary = built.summary;
            d.baseText = ourText;
            this._postDiff();
        } catch (e) {
            this._log(`comparison failed: ${e.message}`);
        }
    }

    _postDiff() {
        const d = this._diff;
        if (!d) { this._post({ type: 'diff', session: null }); return; }
        // ONE FULL-STATE MESSAGE, not a family of incremental verbs — the
        // pattern the contribution-review panel already uses. The whole payload
        // is small because the hunk count is (a real collaborator revision of a
        // 793-line paper produced 19).
        this._post({
            type: 'diff',
            session: {
                label: d.label,
                file: path.basename(d.file),
                summary: d.summary,
                census: describeSummary(d.summary),
                hunks: d.hunks.map(h => ({
                    id: h.id,
                    // See `invert` above: presented from the reader's point of
                    // view, computed from ours.
                    kind: d.invert ? (h.kind === 'add' ? 'del' : h.kind === 'del' ? 'add' : h.kind) : h.kind,
                    where: h.where, confidence: h.confidence,
                    page: h.page, rects: h.rects, why: h.why,
                    name: h.object ? h.object.name : null,
                    startLine: h.ourRange.startLine,
                    ourText: h.ourText.slice(0, 400),
                    theirText: h.theirText.slice(0, 400),
                })),
            },
        });
    }

    closeComparison() {
        this._diff = null;
        this._post({ type: 'diff', session: null });
    }

    /** Reveal one hunk: scroll the page to it and put the cursor on its line. */
    async _focusHunk(id) {
        const d = this._diff;
        if (!d) return;
        const h = d.hunks.find(x => x.id === id);
        if (!h) return;
        this._post({ type: 'diffFocus', id, rects: h.rects, page: h.page });
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(d.file));
            const line = Math.max(0, Math.min(h.ourRange.startLine - 1, doc.lineCount - 1));
            const endLine = Math.max(0, Math.min(h.ourRange.endLine - 2, doc.lineCount - 1));
            const range = new vscode.Range(
                new vscode.Position(line, 0),
                new vscode.Position(Math.max(line, endLine), doc.lineAt(Math.max(line, endLine)).text.length));
            // While full screen, do not reveal — the same rule as an inverse
            // click, for the same reason.
            const editor = this._fsActions
                ? (vscode.window.visibleTextEditors || []).find(e => e.document && e.document.uri.fsPath === d.file)
                : await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false,
                });
            if (editor) {
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                this._flash.show(editor, range);
            }
        } catch (_) { /* the page marker is the main event */ }
    }

    // --- the mini-editor: a block edited from the page itself ----------------
    //
    // Right-click on the page opens the paragraph or equation under the pointer
    // in a small editor pinned below its own rendered block. Everything typed
    // there is applied to the REAL text document through a WorkspaceEdit — same
    // undo stack, same live recompile, same diagnostics — so the mini-editor
    // and the text editor can never disagree: this class only tracks WHERE the
    // block is (as offsets, adjusted through every document change), never a
    // second copy of its content.

    _ensureDocListener() {
        if (this._docListener) return;
        this._docListener = vscode.workspace.onDidChangeTextDocument((e) => {
            try { this._onEditDocChange(e); } catch (_) { /* never break typing */ }
        });
        this._disposables.push(this._docListener);
    }

    /** The rows a line range printed — the card's anchor on the page. */
    _editRects(st, file, startLine, endLine) {
        const rects = [];
        if (endLine - startLine <= 60) {
            for (let n = startLine; n <= endLine; n++) {
                for (const r of st.map.lineRows(file, n)) {
                    rects.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h });
                }
            }
        }
        return rects;
    }

    /**
     * The CELL at a line: the innermost container object — an equation, a
     * figure, a theorem — else the prose paragraph around it.
     *
     * Shared by opening a card and by stepping one, so ‹ › walk exactly the
     * blocks a right-click would have opened.
     */
    _blockAt(doc, lines, file, line) {
        const model = this._modelFor(doc);
        const objects = (model && model.objects) || [];

        // A HEADING IS A BLOCK, AND ITS BLOCK IS THE WHOLE COMMAND.
        //
        // `section-heading` is not a container kind — the selection ladder
        // deliberately skips it, because a heading annotates the section rather
        // than enclosing it — so the card used to fall through to the paragraph
        // scanner. On a heading that wraps in the SOURCE, which a long title
        // does,
        //
        //     \subsection{A first example: the \texorpdfstring{$J=1$}{J=1} BPS--BPS
        //     overlap}
        //
        // the click resolves to the second line, the paragraph scanner sees one
        // line between two blanks, and the card opens on the fragment
        // `overlap}` — reported, with a screenshot. The heading's own range is
        // in the model, brace-matched across lines, so use it.
        const heading = objects
            .filter(o => o.kind === 'section-heading' && o.sourceRange &&
                (!o.sourceRange.file || o.sourceRange.file === file) &&
                o.sourceRange.startLine <= line && o.sourceRange.endLine >= line)
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))[0];
        if (heading) {
            const title = String(heading.title || '').replace(/\s+/g, ' ').trim();
            return {
                startLine: heading.sourceRange.startLine,
                endLine: heading.sourceRange.endLine,
                label: title
                    ? `${heading.cmd} · ${title.length > 34 ? `${title.slice(0, 33)}…` : title}`
                    : (heading.cmd || 'heading'),
            };
        }

        const obj = objects
            .filter(o => o.sourceRange && CONTAINER_KINDS.has(o.kind) &&
                (!o.sourceRange.file || o.sourceRange.file === file) &&
                o.sourceRange.startLine <= line && o.sourceRange.endLine >= line)
            .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) -
                (b.sourceRange.endLine - b.sourceRange.startLine))[0];
        if (obj && obj.sourceRange.endLine - obj.sourceRange.startLine <= 80) {
            return {
                startLine: obj.sourceRange.startLine,
                endLine: obj.sourceRange.endLine,
                label: obj.label ? `${obj.kind} ${obj.label}` : (obj.envName || obj.kind),
            };
        }
        const para = paragraphSpan(lines, line);
        if (para) return { startLine: para.startLine, endLine: para.endLine, label: 'paragraph' };
        return { startLine: line, endLine: line, label: `line ${line}` };
    }

    /**
     * Move the open card to the block before or after the one it holds.
     *
     * WALKING BY LINE, NOT BY A LIST OF BLOCKS. A "cell" here is whatever a
     * right-click at a line would have opened, and prose paragraphs are not
     * objects in the model at all — so the next cell is found by stepping past
     * the current block's last line to the next line with anything on it, and
     * asking the same question there. Blank lines, `\end{...}` gaps and
     * comment-only lines are skipped, and the walk stops at the ends of the
     * file rather than wrapping: wrapping from the last equation to the title
     * would look like the button did something random.
     */
    async _stepEditSession(m) {
        const s = this._edit;
        const st = this.root && this.coord.roots.get(this.root);
        if (!s || !st || !st.map || m.editId !== s.id) return;
        // The client flushes its block before stepping. Webview message
        // callbacks are asynchronous, so explicitly wait for that edit rather
        // than assuming two posted messages finish in arrival order.
        if (this._editApplyQueue) {
            try { await this._editApplyQueue; } catch (_) { /* its own status explains failure */ }
        }
        if (this._edit !== s) return;
        const delta = m.delta < 0 ? -1 : 1;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
        const lines = doc.getText().split(/\r?\n/);
        const here = {
            start: doc.positionAt(s.startOffset).line + 1,
            end: doc.positionAt(s.endOffset).line + 1,
        };

        const meaningful = (n) => {
            const t = (lines[n - 1] || '').trim();
            return t !== '' && !t.startsWith('%');
        };
        let n = delta > 0 ? here.end + 1 : here.start - 1;
        while (n >= 1 && n <= lines.length && !meaningful(n)) n += delta;
        if (n < 1 || n > lines.length) {
            this._post({
                type: 'status',
                text: delta > 0 ? 'last block in the file' : 'first block in the file',
                kind: 'warn',
            });
            return;
        }
        let block = this._blockAt(doc, lines, s.file, n);
        // A degenerate step — the same block again, which happens when the
        // line we landed on belongs to a container that also holds the current
        // one — would leave the reader pressing a button that does nothing. So
        // keep walking past it, once.
        if (block.startLine === here.start && block.endLine === here.end) {
            n = delta > 0 ? block.endLine + 1 : block.startLine - 1;
            while (n >= 1 && n <= lines.length && !meaningful(n)) n += delta;
            if (n < 1 || n > lines.length) {
                this._post({ type: 'status', text: 'no further block', kind: 'warn' });
                return;
            }
            block = this._blockAt(doc, lines, s.file, n);
        }
        await this._openBlockSession(doc, s.file, block, st);
        this._post({ type: 'status', text: `→ ${block.label} (line ${block.startLine})`, kind: 'ok' });
    }

    /** Recreate the mini-editor that belonged to the saved paper session. */
    async _restoreEditSession() {
        if (this._edit || !this.panel || !this.root) return false;
        const saved = this._viewState && this._viewState.edit;
        if (!saved || typeof saved.file !== 'string' ||
            !Number.isFinite(saved.startOffset) || !Number.isFinite(saved.endOffset)) return false;
        const st = this.coord.roots && this.coord.roots.get(this.root);
        // Its anchor belongs to the matching render. If a newer source edit is
        // still compiling, the next `opened` handshake will try again.
        if (!st || !st.map || !st.map.available || st.sourceAhead) return false;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(saved.file));
            let owner = null;
            try { owner = this.coord.rootFor(doc); } catch (_) { owner = doc.uri.fsPath; }
            if (owner !== this.root) throw new Error('the saved mini-editor belongs to another paper');
            const len = doc.getText().length;
            const startOffset = Math.max(0, Math.min(saved.startOffset, len));
            const endOffset = Math.max(startOffset, Math.min(saved.endOffset, len));
            const a = doc.positionAt(startOffset);
            const b = doc.positionAt(endOffset);
            const s = {
                id: ++this._editSeq,
                file: saved.file,
                startOffset,
                endOffset,
                lastText: doc.getText(new vscode.Range(a, b)),
                label: saved.label || 'edit',
            };
            this._edit = s;
            this._ensureDocListener();
            let rects = this._editRects(st, s.file, a.line + 1, b.line + 1);
            if (!rects.length) {
                try {
                    const r = st.map.sourceToRender(s.file, a.line + 1, b.line + 1);
                    if (r && r.page) rects = [{ page: r.page, x: 72, y: 72, w: 4, h: 4 }];
                } catch (_) { /* the card can use its saved page */ }
            }
            const caretStart = Math.max(0, Math.min(Number(saved.caretStart) || 0, endOffset - startOffset));
            const caretEnd = Math.max(caretStart,
                Math.min(Number(saved.caretEnd) || caretStart, endOffset - startOffset));
            this._post({
                type: 'editOpen', editId: s.id, label: s.label,
                file: path.basename(s.file), startLine: a.line + 1, endLine: b.line + 1,
                text: s.lastText, rects,
                page: Number(saved.page) || (rects[0] && rects[0].page) || 1,
                pos: saved.pos || null,
                caretStart, caretEnd,
                caretDirection: saved.caretDirection === 'backward' ? 'backward' : 'forward',
                restored: true,
            });
            this._rememberEditState({
                caretStart, caretEnd,
                caretDirection: saved.caretDirection === 'backward' ? 'backward' : 'forward',
                pos: saved.pos || null,
            });
            return true;
        } catch (_) {
            this._edit = null;
            this._rememberEditState();
            return false;
        }
    }

    /** Open (or move) the card onto an already-decided block. */
    async _openBlockSession(doc, file, block, st) {
        const lines = doc.getText().split(/\r?\n/);
        const startPos = new vscode.Position(block.startLine - 1, 0);
        const endPos = new vscode.Position(
            block.endLine - 1, (lines[block.endLine - 1] || '').length);
        const s = {
            id: ++this._editSeq,
            file,
            startOffset: doc.offsetAt(startPos),
            endOffset: doc.offsetAt(endPos),
            lastText: doc.getText(new vscode.Range(startPos, endPos)),
            label: block.label,
        };
        this._edit = s;
        this._ensureDocListener();
        this._rememberEditState();
        let rects = this._editRects(st, file, block.startLine, block.endLine);
        if (!rects.length) {
            // No measurable rows (a figure, an unmapped block): anchor on the
            // PAGE at least, or the card would jump the reader back to page 1.
            try {
                const r = st.map.sourceToRender(file, block.startLine, block.endLine);
                if (r && r.page) rects = [{ page: r.page, x: 72, y: 72, w: 4, h: 4 }];
            } catch (_) { /* the card can live without an anchor */ }
        }
        this._post({
            type: 'editOpen',
            editId: s.id,
            label: block.label,
            file: path.basename(file),
            startLine: block.startLine,
            endLine: block.endLine,
            text: s.lastText,
            rects,
            stepped: true,
        });
    }

    async _openEditSession(m) {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) return;
        if (this._tracePaused || st.sourceAhead) return;
        const hit = this._resolvePoint(st, m);
        if (!hit || hit.flag === FLAG.UNMAPPED || !hit.file) {
            this._post({ type: 'status', text: 'nothing editable there', kind: 'warn' });
            return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.file));
        const lines = doc.getText().split(/\r?\n/);
        const line = Math.max(1, Math.min(hit.line, lines.length));

        const { startLine, endLine, label } = this._blockAt(doc, lines, hit.file, line);

        const startPos = new vscode.Position(startLine - 1, 0);
        const endPos = new vscode.Position(endLine - 1, (lines[endLine - 1] || '').length);
        const s = {
            id: ++this._editSeq,
            file: hit.file,
            startOffset: doc.offsetAt(startPos),
            endOffset: doc.offsetAt(endPos),
            lastText: doc.getText(new vscode.Range(startPos, endPos)),
            label,
        };
        this._edit = s;
        this._ensureDocListener();
        this._rememberEditState();
        const rects = this._editRects(st, hit.file, startLine, endLine);
        this._post({
            type: 'editOpen',
            editId: s.id,
            label,
            file: path.basename(hit.file),
            startLine,
            endLine,
            text: s.lastText,
            // With no printed rows to hang off (a figure, an unmapped block),
            // the click point itself anchors the card.
            rects: rects.length ? rects
                : [{ page: m.page, x: m.xBp - 2, y: m.yTopBp - 2, w: 4, h: 4 }],
            typingRequest: Number.isFinite(m.typingRequest) ? m.typingRequest : undefined,
        });
    }

    /**
     * The caret moved in the card — answer as the paper answers the editor.
     *
     * The card is the thing the reader is typing in, and it was the one place
     * the page stopped responding: moving this caret showed nothing, while
     * moving the same caret in the editor behind it lit the word up.
     *
     * The offsets arrive relative to the BLOCK, because that is all the card
     * knows; the block's own start makes them document offsets, and from there
     * it is the ordinary forward-sync — a wash for a caret, a marked span for
     * a range, and `follow` governing whether the page also moves.
     *
     * WHEN THE FILE IS ALREADY OPEN IN A VISIBLE EDITOR, the selection is
     * mirrored there and that editor's own change event does the rest: two
     * halves of one document should not disagree about where the reader is.
     * An editor that is NOT on screen is left alone — asked for explicitly,
     * and right: a card is for editing without opening the file.
     */
    async _onEditCaret(m, opts = {}) {
        const s = this._edit;
        if (!s || !this.panel || !m || m.editId !== s.id) return;
        this._lastEditCaret = { ...m };
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file)); }
        catch (_) { return; }

        const span = Math.max(0, s.endOffset - s.startOffset);
        const lo = Math.max(0, Math.min(Number(m.start) || 0, span));
        const hi = Math.max(lo, Math.min(Number(m.end) || lo, span));
        const backward = m.direction === 'backward' && lo !== hi;
        this._rememberEditState({ caretStart: lo, caretEnd: hi,
            caretDirection: backward ? 'backward' : 'forward',
            ...(m.pos && Number.isFinite(m.pos.fx) && Number.isFinite(m.pos.fy) ? { pos: m.pos } : {}) });
        const from = doc.positionAt(s.startOffset + lo);
        const to = doc.positionAt(s.startOffset + hi);
        const anchor = backward ? to : from;
        const active = backward ? from : to;
        const sel = new vscode.Selection(anchor, active);

        const open = (vscode.window.visibleTextEditors || [])
            .find(e => e.document && e.document.uri.fsPath === s.file);
        if (open && !opts.forceSync) {
            // Setting a selection does not scroll — revealRange would, and the
            // reader did not ask to be taken anywhere in the editor.
            try { open.selection = sel; } catch (_) { /* fall through to the direct sync */ }
            // Its own selection-change event drives the page from here, so
            // syncing again would post the same answer twice.
            //
            // Tempting to sync directly as well, to save a hop through VS
            // Code's event loop — but the MEASURED cause of the reported lag
            // was the card's own 90 ms debounce (now 1 ms), and there is no
            // measurement saying this hop is slow. Breaking a deliberate
            // one-answer-per-movement invariant on a hunch is how a page
            // starts repainting twice for every keystroke.
            return;
        }
        // `active` is where the CARET is — the end of a drag, and the whole
        // position for a plain caret. Spelled out rather than left to the
        // constructor: the forward sync reads it directly, and a selection
        // without it answers about the wrong end of a range.
        this.syncFromEditor({
            document: doc,
            selection: { start: from, end: to, anchor, active, isEmpty: lo === hi },
        }, { instant: !!opts.instant, preserveView: !!opts.preserveView });
    }

    async _applyEditChange(m) {
        const s = this._edit;
        if (!s || m.editId !== s.id || typeof m.text !== 'string') return;
        // VS Code does not await one onDidReceiveMessage callback before
        // starting the next. Serialize edits so Ctrl+S can never overtake a
        // debounce already in flight and write the previous block text.
        const before = this._editApplyQueue || Promise.resolve();
        const work = before.catch(() => {}).then(() => this._applyEditChangeNow(s, m.text));
        this._editApplyQueue = work;
        try { return await work; }
        finally { if (this._editApplyQueue === work) this._editApplyQueue = null; }
    }

    async _applyEditChangeNow(s, text) {
        if (text === s.lastText) return true;
        const previousText = s.lastText;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const range = new vscode.Range(
                doc.positionAt(s.startOffset), doc.positionAt(s.endOffset));
            // Set BEFORE applying: the change event this edit fires must read
            // as our own echo, not as an update to send back to the card.
            s.lastText = text;
            const we = new vscode.WorkspaceEdit();
            we.replace(doc.uri, range, text);
            // The global document-change listener uses this to name the small
            // lag indicator “mini-editor” rather than “editor”. It is set
            // across applyEdit because that is when VS Code emits the event.
            this._miniApplyingFile = s.file;
            const ok = await this._applyReaderEdit(doc, we);
            if (!ok) {
                s.lastText = previousText;
                this._post({ type: 'status', text: 'the edit could not be applied', kind: 'err' });
            }
            return !!ok;
        } catch (e) {
            if (s.lastText === text) s.lastText = previousText;
            this._post({ type: 'status', text: `edit failed: ${e.message}`, kind: 'err' });
            return false;
        } finally {
            this._miniApplyingFile = null;
        }
    }

    /**
     * Every document change — ours or the reader's — moves the tracked block.
     * Offsets are adjusted through each change; if the text inside the block
     * then differs from what the card last saw, the card is updated. Our own
     * applyEdit produces text identical to `lastText`, so it never echoes.
     */
    _onEditDocChange(e) {
        const s = this._edit;
        if (!s || !e || !e.document || e.document.uri.fsPath !== s.file) return;
        for (const c of e.contentChanges || []) {
            const grew = (c.text ? c.text.length : 0);
            const delta = grew - c.rangeLength;
            const cs = c.rangeOffset;
            const ce = c.rangeOffset + c.rangeLength;
            if (ce <= s.startOffset) { s.startOffset += delta; s.endOffset += delta; }
            else if (cs >= s.endOffset) { /* below the block — nothing moves */ }
            else {
                s.startOffset = Math.min(s.startOffset, cs);
                s.endOffset = Math.max(s.endOffset + delta, cs + grew);
            }
        }
        const doc = e.document;
        s.endOffset = Math.min(s.endOffset, doc.getText().length);
        s.startOffset = Math.max(0, Math.min(s.startOffset, s.endOffset));
        this._rememberEditState();
        const a = doc.positionAt(s.startOffset);
        const b = doc.positionAt(s.endOffset);
        const text = doc.getText(new vscode.Range(a, b));
        if (text === s.lastText) return;
        s.lastText = text;
        if (this._mma === s) {
            // The computation card holds CELLS, not raw text, so it is told
            // what the block now parses as rather than being handed the source.
            // Debounced: a keystroke in the .tex fires this on every character
            // and re-parsing per character would be work nobody sees.
            clearTimeout(this._mmaRefresh);
            this._mmaRefresh = setTimeout(() => this._refreshMma().catch(() => {}), 200);
            return;
        }
        this._post({
            type: 'editUpdate', editId: s.id, text,
            startLine: a.line + 1, endLine: b.line + 1,
        });
    }

    /**
     * Mirror an inverse-search hit into the open mini-editor.
     *
     * The card holds the block's text, so the same range expressed relative to
     * the block start is where the caret goes. A hit OUTSIDE the open block is
     * deliberately ignored: moving the card to wherever the reader last clicked
     * would take the block they are editing off the screen. Right-click is how
     * you move it.
     */
    /**
     * Mirror an inverse hit into the open card.
     *
     * `caretPos`, when given, is the CHARACTER that was clicked. The card then
     * behaves like the text editor does: the word is marked, and the caret goes
     * where the pointer was rather than to the end of the word. Without it the
     * whole range is selected, which is still right for a widened Cmd-click or
     * a dragged selection.
     */
    _postEditSelection(doc, range, focus, caretPos, typingRequest) {
        const s = this._edit;
        // WHY THE CARD DID NOT MOVE, when it did not.
        //
        // Every branch below is a silent return, and from the reader's seat all
        // of them look the same: "I clicked and the card ignored me". Reported
        // as exactly that. The reason is returned so the click can say it —
        // a decline that explains itself is diagnosable; a silent one is not.
        if (!s) return 'no mini-editor is open';
        if (!doc || !range) return null;
        if (doc.uri.fsPath !== s.file) {
            return `the card is editing ${require('path').basename(s.file)}, and this is another file`;
        }
        let a; let b;
        try { a = doc.offsetAt(range.start); b = doc.offsetAt(range.end); }
        catch (_) { return null; }
        if (b < s.startOffset || a > s.endOffset) {
            const from = doc.positionAt(s.startOffset).line + 1;
            const to = doc.positionAt(s.endOffset).line + 1;
            return `outside the card's block (it holds lines ${from}\u2013${to})`;
        }
        const clamp = (n) => Math.max(0, Math.min(n, s.endOffset) - s.startOffset);
        const start = clamp(Math.max(a, s.startOffset));
        const end = clamp(Math.max(b, s.startOffset));
        let direction;
        if (range.anchor && range.active && start !== end) {
            try {
                direction = doc.offsetAt(range.active) < doc.offsetAt(range.anchor)
                    ? 'backward' : 'forward';
            } catch (_) { /* a Range has no direction, which is fine */ }
        }
        let caret;
        if (caretPos) {
            try {
                const c = clamp(Math.max(doc.offsetAt(caretPos), s.startOffset));
                // Only inside the marked word: a caret outside it would put the
                // card's cursor somewhere the mark does not cover, which is the
                // confusion this whole change exists to remove.
                if (c >= start && c <= end) caret = c;
            } catch (_) { /* no caret, just the range */ }
        }
        this._post({
            type: 'editSelect', editId: s.id, focus: !!focus,
            start, end, caret, direction,
            typingRequest: Number.isFinite(typingRequest) ? typingRequest : undefined,
        });
        return null;
    }

    /** After a recompile the block has new geometry — move the card to it. */
    async _postEditAnchor() {
        const s = this._edit;
        const st = this.root && this.coord.roots.get(this.root);
        if (!s || !st || !st.map || !st.map.available) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            // A COMPUTATION CARD RE-ANCHORS DIFFERENTLY, because its block has
            // no rows of its own — after a recompile it follows its output,
            // which may well have moved to another page.
            if (this._mma === s) {
                const block = this._findBlock(doc, s.blockId);
                if (!block) return;
                const rects = this._mmaRects(st, s.file, block, doc, null);
                if (rects.length) this._post({ type: 'mmaAnchor', blockId: s.blockId, rects });
                return;
            }
            const a = doc.positionAt(s.startOffset);
            const b = doc.positionAt(s.endOffset);
            const rects = this._editRects(st, s.file, a.line + 1, b.line + 1);
            if (rects.length) this._post({ type: 'editAnchor', editId: s.id, rects });
        } catch (_) { /* keep the old anchor */ }
    }

    async _saveEditDoc(m = {}) {
        const s = this._edit;
        if (!s || (m.editId != null && m.editId !== s.id)) return false;
        try {
            // Ctrl+S carries the textarea's CURRENT value. Apply it through a
            // WorkspaceEdit (preserving undo and any open editor), then save
            // the TextDocument — which writes the complete .tex file, not only
            // the mini-editor's block — to disk.
            if (typeof m.text === 'string') {
                const applied = await this._applyEditChange({ editId: s.id, text: m.text });
                if (!applied) return false;
            } else if (this._editApplyQueue) {
                await this._editApplyQueue;
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const needed = !!doc.isDirty;
            const ok = await doc.save();
            this._post({ type: 'status', text: ok ? `saved ${path.basename(s.file)}` : 'nothing to save', kind: 'ok' });
            return !!ok || !needed;
        } catch (e) {
            this._post({ type: 'status', text: `save failed: ${e.message}`, kind: 'err' });
            return false;
        }
    }

    async _revealEditRange() {
        const s = this._edit;
        if (!s) return;
        // This command explicitly asks to work in the source editor, so return
        // to the complete layout before opening column one. Showing an editor
        // while its group is maximized away makes current VS Code rearrange
        // the Secondary Side Bar implicitly.
        if (this._fsActions) await this.setLayoutMode('all');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
        const range = new vscode.Range(doc.positionAt(s.startOffset), doc.positionAt(s.endOffset));
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false,
        });
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    // =======================================================================
    // MANAGED MATHEMATICA COMPUTATIONS
    // =======================================================================
    //
    // Press the toolbar's ∑+, then click where the computation belongs. The
    // same blue caret that shows where a moved block would land shows where
    // this one will, because it IS the same caret and the same seam-finder —
    // a reader who has learned one gesture has learned both.
    //
    // What lands is a comment: `%Mathematica … %EndMathematica`. The paper
    // still compiles the instant it is inserted, so there is never a moment
    // where the document is half-valid. Only pressing "insert output" puts
    // real LaTeX on the page, and only for the cells that asked for it.

    /**
     * Open a computation from outside the panel — the CodeLens in the .tex.
     *
     * The paper has to be on screen for a card to be pinned to it, so this
     * shows the panel first and says so plainly if it cannot.
     */
    async openComputation(file, blockId) {
        if (!this.panel) {
            await vscode.commands.executeCommand('wolfbook.tex.openViewer');
        }
        if (!this.panel) throw new Error('the paper viewer is not open');
        const st = this.root && this.coord.roots.get(this.root);
        await this._openMmaSession(file, blockId, st, null);
        this.panel.reveal(undefined, true);
    }

    // =======================================================================
    // WHERE YOU WERE LAST WORKING
    // =======================================================================
    //
    // The page used to jump to the caret on every keystroke, which is right
    // when you are reading along and wrong when you are writing — you cannot
    // keep an eye on a figure three pages away while typing about it. With
    // `follow` set to `mark` the page stops moving, and this is what replaces
    // it: a short stack of the places you last edited, walkable from the
    // footer, so getting back to one is a click rather than a hunt.
    //
    // RESOLVING one drops it from the stack and parks on the one before it.
    // That is what makes the stack a WORKLIST rather than a history: the
    // things still on it are the things you have not finished with.

    /** How near in space and time two edits have to be to count as one. */
    static get EDIT_MERGE_LINES() { return 3; }
    static get EDIT_MERGE_MS() { return 8000; }
    static get EDIT_STACK_MAX() { return 20; }

    /**
     * Record a change to a .tex as one entry on the stack.
     *
     * Typing is thousands of changes and a reader means ONE place, so a change
     * near the top entry and soon after it UPDATES that entry instead of
     * pushing a new one. Without the merge the stack would hold twenty entries
     * all inside the same sentence and would be useless for going anywhere.
     */
    _noteEdit(doc, changes) {
        if (!doc || !/\.tex$/i.test(doc.uri.fsPath)) return;
        if (!this.panel) return;
        const file = doc.uri.fsPath;
        // Our own writes are edits too — an inserted computation is exactly the
        // kind of place you want to get back to.
        let line = 0;
        for (const c of changes || []) {
            try { line = Math.max(line, doc.positionAt(c.rangeOffset).line + 1); } catch (_) {}
        }
        if (!line) return;
        const now = Date.now();
        const top = this._editStack[0];
        if (top && top.file === file
            && Math.abs(top.line - line) <= TexViewer.EDIT_MERGE_LINES
            && now - top.at < TexViewer.EDIT_MERGE_MS) {
            top.line = line;
            top.at = now;
            top.label = null;              // recomputed off this path — see below
        } else {
            this._editStack.unshift({
                id: ++this._editSeq, file, line, at: now, label: null,
            });
            this._editStack.length = Math.min(this._editStack.length, TexViewer.EDIT_STACK_MAX);
            // A new edit is the newest thing there is, so that is where the
            // footer parks — anything else would leave it pointing at history
            // while you work.
            this._editStackAt = 0;
        }
        clearTimeout(this._editStackPost);
        this._editStackPost = setTimeout(() => this._postEditStack(), 250);
    }

    /** What to call an edit's place: the thing it is inside. */
    _editLabel(doc, line) {
        const model = this._modelFor(doc);
        const inside = (model && model.objects || []).filter(o => o.sourceRange
            && o.sourceRange.startLine <= line && o.sourceRange.endLine >= line);
        if (inside.length) {
            inside.sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine)
                - (b.sourceRange.endLine - b.sourceRange.startLine));
            const l = shortLabel(inside[0]);
            if (l) return l;
        }
        return `line ${line}`;
    }

    /**
     * NAMING AN EDIT IS NOT KEYSTROKE WORK.
     *
     * `_editLabel` builds the document model to find what the edit is inside,
     * which is ~2.5 ms on an 1,500-line paper. Doing that per change event put
     * it on the typing path for a label the reader may never look at. It is
     * done here instead — inside the 250 ms debounce, once per entry, and the
     * answer is kept on the entry.
     */
    _labelFor(entry) {
        if (entry.label != null) return entry.label;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === entry.file);
        entry.label = doc ? this._editLabel(doc, entry.line) : `line ${entry.line}`;
        return entry.label;
    }

    _postEditStack() {
        if (!this.panel) return;
        this._post({
            type: 'editStack',
            index: this._editStackAt,
            items: this._editStack.map(e => ({
                id: e.id,
                file: path.basename(e.file),
                line: e.line,
                label: this._labelFor(e),
                at: e.at,
            })),
        });
    }

    /** ◀ ▶ ✓ from the footer. */
    async _onEditNav(m) {
        const act = m && m.action;
        if (act === 'resolve') {
            const gone = this._editStack.splice(this._editStackAt, 1)[0];
            if (!gone) return;
            // Park on the one BEFORE it — the next-most-recent — which is where
            // the reader was working before the thing they have just finished.
            this._editStackAt = Math.min(this._editStackAt, Math.max(0, this._editStack.length - 1));
            this._postEditStack();
            if (this._editStack.length) await this._gotoEdit(this._editStack[this._editStackAt]);
            return;
        }
        if (act === 'clear') {
            this._editStack = [];
            this._editStackAt = 0;
            this._postEditStack();
            return;
        }
        if (!this._editStack.length) return;
        if (act === 'prev' || act === 'next') {
            // ▶ walks towards the NEWEST (index 0), ◀ towards the oldest, which
            // is the direction the labels read in.
            const step = act === 'next' ? -1 : +1;
            this._editStackAt = Math.max(0,
                Math.min(this._editStack.length - 1, this._editStackAt + step));
        } else if (act === 'go') {
            const i = this._editStack.findIndex(e => e.id === m.id);
            if (i < 0) return;
            this._editStackAt = i;
        }
        this._postEditStack();
        await this._gotoEdit(this._editStack[this._editStackAt]);
    }

    /** Show an edit's place on the page, scrolling to it whatever `follow` says. */
    async _gotoEdit(entry) {
        if (!entry) return;
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) {
            this._post({ type: 'status', text: 'no render map yet', kind: 'warn' });
            return;
        }
        let rects = this._editRects(st, entry.file, entry.line, entry.line);
        // The line asked for may print nothing of its own — a run-in heading,
        // a `\label` on its own line, a comment. The unit's own BODY does, so
        // the first row anywhere in it is the honest answer to "take me
        // there"; refusing outright is not, since the reader can see the thing
        // in the contents and asked for it by name.
        if (!rects.length && entry.endLine > entry.line) {
            const all = this._editRects(st, entry.file, entry.line,
                Math.min(entry.endLine, entry.line + 60));
            rects = all.slice(0, 1);
        }
        if (!rects.length) {
            this._post({ type: 'status', text: `${entry.label} is not on the page`, kind: 'warn' });
            return;
        }
        // ASKED FOR EXPLICITLY, so it scrolls even in `mark` — the reader
        // pressed a button meaning "take me there". `follow` governs what
        // happens on its own, not what happens when you ask.
        this._post({
            type: 'highlight',
            rects,
            flag: 'approx',
            reveal: true,
            label: `${entry.label} · p.${rects[0].page}`,
        });
    }

    /** Live feedback while an arming gesture is on — insert, or paste. */
    async _insertPreview(m, what = 'computation') {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) return;
        const hit = this._resolvePoint(st, m);
        if (!hit || hit.flag === FLAG.UNMAPPED || !hit.file) {
            this._insertTarget = null;
            this._post({ type: 'moveCaret', rects: [] });
            return;
        }
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.file)); }
        catch (_) { return; }
        const t = this._blockDropTarget(st, m, doc);
        this._insertTarget = t;
        if (!t) { this._post({ type: 'moveCaret', rects: [] }); return; }
        this._post({
            type: 'moveCaret', rects: t.rects, block: true,
            label: `${what} here · line ${t.line}`,
        });
    }

    /**
     * copy / cut / delete a whole sectioning unit, from its tag.
     *
     * The same three actions the selection bar offers, on the thing a reader
     * most often wants to move around: a section, with its body. The span is
     * `headStart..spanEnd` — the heading AND everything under it down to the
     * next heading of the same level or above — because a section without its
     * body is a title, and cutting a title alone would silently orphan pages
     * of prose.
     */
    async _onAnchorAction(m) {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !m || !m.key) return;
        let item = null;
        try { item = this._sectionControls(st).find(i => i.key === m.key) || null; }
        catch (_) { item = null; }
        if (!item) {
            this._post({ type: 'status', text: 'that section is no longer there', kind: 'warn' });
            return;
        }
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file)); }
        catch (_) { return; }

        const lastLine = Math.max(0, Math.min(item.spanEnd - 1, doc.lineCount - 1));
        const start = new vscode.Position(Math.max(0, item.headStart - 1), 0);
        // Whole lines, and the newline that ends the last one — so a cut
        // section leaves no blank gap where it was.
        const end = lastLine + 1 < doc.lineCount
            ? new vscode.Position(lastLine + 1, 0)
            : new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
        const range = new vscode.Range(start, end);
        const lines = item.spanEnd - item.headStart + 1;
        const what = item.title ? `"${item.title}"` : 'the section';

        if (m.action === 'copy') {
            const r = await this._rangeAction(doc, range, 'copy');
            this._post({
                type: 'status', kind: r.ok ? 'ok' : 'err',
                text: r.ok ? `copied ${what} — ${lines} lines` : r.reason,
            });
            return;
        }
        if (m.action !== 'cut' && m.action !== 'delete') return;

        // DELETING A SECTION IS NOT A CLICK TO MAKE BY ACCIDENT. A cut can be
        // pasted back; a delete of forty lines cannot, except by undo, and the
        // button is one pixel from the fold control.
        if (m.action === 'delete' && lines > 3) {
            const yes = await vscode.window.showWarningMessage(
                `Delete ${what} and everything in it?`,
                { modal: true, detail: `${lines} lines. This can be undone with ⌘Z.` },
                'Delete');
            if (yes !== 'Delete') { this._post({ type: 'status', text: 'left alone', kind: '' }); return; }
        }

        const ok = await this._guardedWrite(doc, 'wpaper.sectionAction',
            `${m.action} ${what}`, () => {});
        if (!ok) return;                     // the guard already said why
        const r = await this._rangeAction(doc, range, m.action);
        this._post({
            type: 'status', kind: r.ok ? 'ok' : 'err',
            text: r.ok ? `${m.action === 'cut' ? 'cut' : 'deleted'} ${what} — ${lines} lines` : r.reason,
        });
        if (r.ok) this._busy(`${m.action === 'cut' ? 'cut' : 'deleted'} ${what} — rebuilding…`);
    }

    /**
     * Paste the clipboard at the seam under the pointer.
     *
     * ⌘V on the page cannot mean "replace the selection" — there need not be
     * one — so it asks WHERE, with the same blue caret every other placing
     * gesture uses.
     */
    async _pasteCommit(m) {
        const st = this.root && this.coord.roots.get(this.root);
        this._post({ type: 'moveCaret', rects: [] });
        if (!st) return;
        let clip = '';
        try { clip = await vscode.env.clipboard.readText(); } catch (_) { clip = ''; }
        if (!clip) {
            this._post({ type: 'status', text: 'the clipboard holds no text', kind: 'warn' });
            return;
        }

        let t = this._insertTarget;
        this._insertTarget = null;
        let doc = null;
        if (m && m.page) {
            const hit = this._resolvePoint(st, m);
            if (hit && hit.flag !== FLAG.UNMAPPED && hit.file) {
                try {
                    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.file));
                    t = this._blockDropTarget(st, m, doc) || t;
                } catch (_) { /* the preview's answer stands */ }
            }
        }
        if (!t) { this._post({ type: 'status', text: 'nothing there to paste into', kind: 'warn' }); return; }
        if (!doc || doc.uri.fsPath !== t.file) {
            try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(t.file)); }
            catch (_) { return; }
        }

        // Whole lines land as whole lines: the seam is a line boundary, so
        // text without a trailing newline would weld itself to what follows.
        const text = /\n$/.test(clip) ? clip : `${clip}\n`;
        const ok = await this._guardedWrite(doc, 'wpaper.paste', 'pasted from the clipboard', (we) => {
            we.insert(doc.uri, doc.positionAt(t.offset), text);
        });
        if (!ok) return;
        this._busy(`pasted at line ${t.line} — rebuilding…`);
    }

    /**
     * Drop a new computation at the seam under the pointer.
     *
     * ONE WorkspaceEdit, so one press of undo takes the whole thing back out.
     */
    async _insertCommit(m) {
        const st = this.root && this.coord.roots.get(this.root);
        this._post({ type: 'moveCaret', rects: [] });
        if (!st) return;
        let t = this._insertTarget;
        this._insertTarget = null;
        let doc = null;
        if (m && m.page) {
            const hit = this._resolvePoint(st, m);
            if (hit && hit.flag !== FLAG.UNMAPPED && hit.file) {
                try {
                    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.file));
                    t = this._blockDropTarget(st, m, doc) || t;
                } catch (_) { /* fall back to the preview's answer */ }
            }
        }
        if (!t) {
            this._post({ type: 'status', text: 'nothing there to attach a computation to', kind: 'warn' });
            return;
        }
        if (!doc || doc.uri.fsPath !== t.file) {
            try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(t.file)); }
            catch (_) { return; }
        }

        const before = doc.getText();
        const blockId = this._freshBlockId(before);
        // The dropped cell materialises by default: you put it there to put
        // something on the page. Cells added later in the editor do not — they
        // are working, and working does not belong in a paper.
        const snippet = mmaWrite.buildBlockText({
            blockId,
            cells: [{ kind: 'wolfram', code: '', include: true }],
        }) + '\n';

        if (!(await this._guardedWrite(doc, 'wpaper.insertComputation',
            'new Mathematica computation', (we) => {
                we.insert(doc.uri, doc.positionAt(t.offset), snippet);
            }))) return;

        this._busy(`computation added at line ${t.line} — rebuilding…`);
        await this._openMmaSession(doc.uri.fsPath, blockId, st, m);
    }

    /**
     * An id no other block in this file is using.
     *
     * Two bytes is four hex characters — the shape the design documents use,
     * short enough to read in a fence header. Collisions are checked rather
     * than assumed away, because a duplicate id would silently pair one cell
     * with another cell's output.
     */
    _freshBlockId(text) {
        const crypto = require('crypto');
        for (let i = 0; i < 64; i++) {
            const id = crypto.randomBytes(2).toString('hex');
            if (!new RegExp(`\\b(?:Block|Cell)ID:\\s*${id}\\b`).test(text)) return id;
        }
        return crypto.randomBytes(6).toString('hex');
    }

    /**
     * Every write from the viewer goes through here.
     *
     * Two guards, and neither is optional:
     *
     *  - checkWritable against the bytes ON DISK, because a Dropbox-synced or
     *    collaborator-edited file can have moved under an open buffer, and
     *    writing through the buffer would silently discard their change.
     *  - announceAgentEdit around the edit, because this write goes through the
     *    open buffer and therefore looks exactly like the reader typing. The
     *    review mirrors the reader's typing into its own baseline — so without
     *    the announcement it would agree to this change on their behalf and
     *    leave nothing to review.
     */
    async _guardedWrite(doc, source, note, build) {
        const baseText = doc.getText();
        try {
            const diskText = fs.existsSync(doc.uri.fsPath)
                ? fs.readFileSync(doc.uri.fsPath, 'utf8') : baseText;
            const verdict = checkWritable({
                diskText, baseText, isDirty: doc.isDirty, willSave: false,
            });
            if (!verdict.ok) {
                this._post({
                    type: 'status', kind: 'err',
                    text: `not written — ${verdict.reason}`,
                });
                return false;
            }
        } catch (_) { /* an unreadable file is the editor's problem, not ours */ }

        try { announceAgentEdit({ file: doc.uri.fsPath, baseText, phase: 'begin', source, origin: 'user' }); }
        catch (_) { /* announcing is never worth failing an edit */ }

        const we = new vscode.WorkspaceEdit();
        build(we);
        let ok = false;
        try { ok = await vscode.workspace.applyEdit(we); }
        catch (e) {
            this._post({ type: 'status', text: `edit failed: ${e.message}`, kind: 'err' });
        }

        try { announceAgentEdit({ file: doc.uri.fsPath, baseText, phase: 'end', source, note, origin: 'user' }); }
        catch (_) { /* likewise */ }

        if (!ok) this._post({ type: 'status', text: 'the edit could not be applied', kind: 'err' });
        return ok;
    }

    /** The parsed block with this id, re-read from the document every time. */
    _findBlock(doc, blockId) {
        const parsed = mmaBlocks.parseMmaBlocks(doc.getText(), { file: doc.uri.fsPath });
        return (parsed.blocks || []).find(b => b.blockId === blockId) || null;
    }

    /** Open the computation card on a block. */
    async _openMmaSession(file, blockId, st, m) {
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file)); }
        catch (_) { return; }
        const block = this._findBlock(doc, blockId);
        if (!block) return;
        st = st || (this.root && this.coord.roots.get(this.root));

        const startPos = new vscode.Position(block.startLine - 1, 0);
        const lines = doc.getText().split(/\r?\n/);
        const endPos = new vscode.Position(block.endLine - 1, (lines[block.endLine - 1] || '').length);
        const s = {
            id: ++this._editSeq,
            file,
            blockId,
            startOffset: doc.offsetAt(startPos),
            endOffset: doc.offsetAt(endPos),
            lastText: doc.getText(new vscode.Range(startPos, endPos)),
        };
        // The computation card reuses the text card's session slot on purpose:
        // one tracked range, one offset adjuster. Two independent trackers over
        // the same document would drift apart and neither would say so.
        this._edit = s;
        this._mma = s;
        this._ensureDocListener();

        const rects = this._mmaRects(st, file, block, doc, m);
        this._post({
            type: 'mmaOpen',
            editId: s.id,
            blockId,
            file: path.basename(file),
            startLine: block.startLine,
            endLine: block.endLine,
            cells: block.cells.map(c => this._cellForPanel(c)),
            state: block.state,
            stateReason: block.stateReason,
            // What the LaTeX will be broken to, so the card can show it and
            // let the reader disagree. Measured from the printed page; see
            // TexComputeService.widthFor for the ladder behind it.
            pageWidthEm: this._pageWidthEm(st, file),
            rects,
        });
        await this._postKernels();
    }

    /**
     * Where the computation card is pinned.
     *
     * A MANAGED BLOCK PRINTS NOTHING. It is a run of TeX comments, so asking
     * the render map for its rows returns none — which is why the card first
     * opened at the top of page 1 whatever the reader had clicked. The block's
     * own lines are therefore the LAST thing to try, not the first:
     *
     *   1. the point that was clicked, when there was one. Nothing is more
     *      accurate right after a drop, because the map still describes the
     *      document as it was before the block was inserted;
     *   2. the block's OUTPUT, which is the part of it that really is on the
     *      page — the same anchor its badge uses, so the card opens next to
     *      the figure the badge is attached to;
     *   3. the first printed line after the block, for one that has no output;
     *   4. its own lines, in case a future grammar ever prints something.
     */
    _mmaRects(st, file, block, doc, m) {
        if (m && m.page) return [{ page: m.page, x: m.xBp - 2, y: m.yTopBp - 2, w: 4, h: 4 }];
        if (!st || !st.map || !st.map.available) return [];
        let text = '';
        try { text = doc ? doc.getText() : fs.readFileSync(file, 'utf8'); } catch (_) { text = ''; }
        const at = this._mmaAnchor(st, file, block, text);
        if (at) return [{ page: at.page, x: at.x, y: at.y, w: 4, h: at.h || 4 }];
        return this._editRects(st, file, block.startLine, block.endLine);
    }

    /** One cell, as the panel needs to show it. */
    _cellForPanel(c) {
        return {
            cellId: c.cellId || null,
            kind: c.kind,
            code: c.code,
            include: c.include !== false,
            state: c.state,
            stateReason: c.stateReason,
            hasOutput: c.outputIndex != null,
        };
    }

    /** The kernels this paper could run on. */
    async _postKernels() {
        const svc = this.compute;
        if (!svc || !svc.available()) {
            this._post({ type: 'mmaKernelList', kernels: [], boundId: null, reason: svc ? svc.unavailableReason() : null });
            return;
        }
        const file = this._mma ? this._mma.file : this.root;
        this._post({ type: 'mmaKernelList', ...svc.kernelsFor(file) });
    }

    async _bindKernel(m) {
        const svc = this.compute;
        if (!svc || !svc.available() || !m || !m.kernelId) return;
        const file = this._mma ? this._mma.file : this.root;
        try {
            await svc.bindKernel(file, m.kernelId);
            this._post({ type: 'status', text: 'kernel chosen for this paper', kind: 'ok' });
        } catch (e) {
            this._post({ type: 'status', text: `could not choose that kernel: ${e.message}`, kind: 'err' });
        }
        await this._postKernels();
    }

    /**
     * How wide the LaTeX for this paper may be.
     *
     * Measured from the printed page when it can be: the modal width of the
     * prose rows is the text block, which is exactly the number \textwidth
     * would give. Falls back to a one-column article inside widthFor().
     */
    _pageWidthEm(st, file) {
        let inkWidthBp = 0;
        try {
            const widths = [];
            for (let page = 1; page <= 3; page++) {
                const onPage = st && st.map ? (st.map.linesOnPage(page, file) || []) : [];
                for (const n of onPage) {
                    const rows = (st.map.lineRows(file, n) || []).filter(r => r.page === page);
                    if (!rows.length) continue;
                    const w = Math.max(...rows.map(r => r.x + r.w)) - Math.min(...rows.map(r => r.x));
                    if (w > 0) widths.push(w);
                }
                if (widths.length > 40) break;
            }
            if (widths.length >= 5) {
                // The WIDEST prose rows are the full-measure ones; a median
                // would be dragged down by every short last-line of a
                // paragraph and would under-report the text block.
                widths.sort((a, b) => b - a);
                inkWidthBp = widths[Math.floor(widths.length * 0.1)];
            }
        } catch (_) { inkWidthBp = 0; }
        return this.compute.widthFor({ inkWidthBp }).em;
    }

    /** Run one cell and send the result back to the card. */
    async _runMmaCell(m) {
        const svc = this.compute;
        const reply = (extra) => this._post({ type: 'mmaResult', runId: m && m.runId, ...extra });
        if (!svc || !svc.available()) { reply({ error: svc ? svc.unavailableReason() : 'no kernel' }); return; }
        const s = this._mma;
        if (!s || !m || typeof m.code !== 'string') { reply({ error: 'nothing to run' }); return; }

        const st = this.root && this.coord.roots.get(this.root);
        // THE READER'S NUMBER WINS. The measurement is a good guess about a
        // one-column article and no guess at all about a two-column one, a
        // wide margin note, or a figure the equation has to sit beside — and
        // they can see the result and we cannot.
        const asked = Number(m.pageWidthEm);
        const pageWidthEm = asked > 0 ? Math.round(asked) : this._pageWidthEm(st, s.file);
        this._post({ type: 'status', text: 'running…', kind: '' });

        const out = await svc.run(s.file, m.code, {
            pageWidthEm,
            prefer: m.prefer === 'figure' ? 'figure' : 'auto',
            timeoutSeconds: Number(m.timeoutSeconds) || 60,
            katex: true,
        });

        if (out.busy) {
            const op = out.busy.operation_id ? ` (${out.busy.operation_id})` : '';
            reply({ busy: true, error: `The kernel is busy${op}. Nothing was interrupted — try again when it is free.` });
            this._post({ type: 'status', text: 'kernel busy', kind: 'warn' });
            return;
        }
        if (out.error) {
            reply({ error: out.error });
            this._post({ type: 'status', text: out.error, kind: 'err' });
            return;
        }

        const res = out.result;
        // Held against the CELL SOURCE that produced it. An insert later on
        // compares this hash with the cell as it stands then, so a result can
        // never be filed under code that has moved on since.
        this._runs = this._runs || new Map();
        const key = m.cellId || '#0';
        this._runs.set(key, { result: res, sourceHash: mmaBlocks.sha256(m.code), pageWidthEm });

        reply({
            kind: res.kind,
            html: res.html,
            latex: res.latex,
            text: res.text,
            svg: res.svg,
            base64: res.base64,
            // A figure goes into the paper as a PDF, which a webview cannot
            // draw; the SVG that came back with it is the preview. When even
            // that is missing, say so rather than showing an empty box.
            note: res.note || (res.kind === 'figure' && !res.svg
                ? 'a PDF figure — no preview available, but it will typeset'
                : undefined),
            error: res.kind === 'error' ? res.error : undefined,
            ms: res.ms,
            pageWidthEm,
        });
        this._post({
            type: 'status', kind: res.kind === 'error' ? 'err' : 'ok',
            text: res.kind === 'error' ? res.error : `ran in ${res.ms} ms · broken to ${pageWidthEm} em`,
        });
    }

    /**
     * Put a cell's last result into the paper as managed output.
     *
     * Everything that could make this the wrong thing to do is checked first,
     * and each refusal says what to do instead:
     *   - the document has moved on since the run;
     *   - the existing output was edited by hand.
     */
    async _insertOutput(m) {
        const s = this._mma;
        if (!s || !m) return;
        const run = this._runs && this._runs.get(m.cellId || '#0');
        if (!run) {
            this._post({ type: 'status', text: 'run the cell first', kind: 'warn' });
            return;
        }
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file)); }
        catch (_) { return; }

        // ALWAYS RE-PARSE. The card is holding line numbers that may be several
        // edits old, and writing to a remembered range is how a feature like
        // this corrupts a document.
        const block = this._findBlock(doc, s.blockId);
        if (!block) {
            this._post({ type: 'status', text: 'that computation is no longer in the file', kind: 'err' });
            return;
        }
        const cell = block.cells.find(c => c.cellId && c.cellId === m.cellId)
            || (block.cells.length === 1 ? block.cells[0] : null);
        if (!cell) {
            this._post({ type: 'status', text: 'that cell is no longer in the file', kind: 'err' });
            return;
        }
        if (cell.sourceHash !== run.sourceHash) {
            this._post({
                type: 'status', kind: 'warn',
                text: 'the code changed since this ran — run it again before inserting',
            });
            return;
        }
        if (cell.state === mmaBlocks.BLOCK_STATE.MODIFIED_BY_USER) {
            const choice = await vscode.window.showWarningMessage(
                'This output was edited by hand since it was generated. Replace it?',
                { modal: true, detail: 'Your edits to the output will be lost.' },
                'Replace', 'Keep mine');
            if (choice !== 'Replace') {
                this._post({ type: 'status', text: 'kept your version', kind: '' });
                return;
            }
        }

        // A figure needs a file on disk before it has a body to insert.
        const opts = {
            label: cell.options && cell.options.label,
            caption: cell.options && cell.options.caption,
            name: (cell.options && cell.options.name) || (block.options && block.options.name),
            inFloat: false,
        };
        let built = mmaWrite.bodyForResult(run.result, opts);
        if (built.needsAsset) {
            try {
                const asset = this.compute.writeAsset(s.file, built.needsAsset);
                built = mmaWrite.bodyForResult(run.result, { ...opts, assetRel: asset.rel });
            } catch (e) {
                this._post({ type: 'status', text: `could not write the figure: ${e.message}`, kind: 'err' });
                return;
            }
        }
        if (built.error) {
            this._post({ type: 'status', text: built.error, kind: 'err' });
            return;
        }

        // A cell that is going to be referred to needs an id, and it needs the
        // SAME id every time — that is what makes re-inserting a replacement
        // rather than a second copy.
        let cellId = cell.cellId;
        const text = doc.getText();
        let blockEdit = null;
        if (!cellId) {
            cellId = this._freshCellId(text);
            const dcell = { ...cell, cellId };
            const doc2 = mmaWrite.toDoc(block);
            doc2.cells[cell.index] = {
                kind: dcell.kind, cellId, include: dcell.include !== false,
                code: dcell.code, options: mmaWrite.trimOptions(dcell.options, new Set(['CellID', 'cellId', 'out', 'Out'])),
            };
            blockEdit = mmaWrite.planBlockText(text, block, doc2);
        }

        const plan = mmaWrite.planInsert(text, block, cell.cellId, built.body, {
            blockId: block.blockId,
            // Found by the id it HAS (none, the first time); written with the
            // id it is being given in the very same edit.
            writeCellId: cellId,
        });
        if (plan.error) {
            this._post({ type: 'status', text: plan.error, kind: 'err' });
            return;
        }

        // A FIGURE NEEDS A PACKAGE, and this paper may not load it.
        //
        // Reported: the computation inserted an \includegraphics into a paper
        // with no graphicx, so the compiler could not draw it. The paste path
        // only warns; a GENERATED figure is different — the reader did not
        // choose to write \includegraphics, we did — so the package goes in
        // with it, in the same edit and therefore the same undo.
        const needsPkg = /\\includegraphics/.test(built.body) ? graphicxInsertion(text) : null;

        const ok = await this._guardedWrite(doc, 'wpaper.mathematica',
            `managed output for ${cellId}`, (we) => {
                // The fence is written FIRST because it sits below the block:
                // rewriting the block first would move the offsets the fence
                // plan was computed against. A WorkspaceEdit applies its edits
                // against the original document, but keeping them disjoint and
                // ordered is what makes that safe to rely on.
                we.replace(doc.uri,
                    new vscode.Range(doc.positionAt(plan.startOffset), doc.positionAt(plan.endOffset)),
                    plan.newText);
                if (blockEdit) {
                    we.replace(doc.uri,
                        new vscode.Range(doc.positionAt(blockEdit.startOffset), doc.positionAt(blockEdit.endOffset)),
                        blockEdit.newText);
                }
                // The preamble is ABOVE both of the others, so all three stay
                // disjoint and each is expressed against the document as read.
                if (needsPkg) {
                    we.insert(doc.uri, doc.positionAt(needsPkg.offset), needsPkg.text);
                }
            });
        if (!ok) return;
        if (needsPkg) {
            this._post({
                type: 'status', kind: 'ok',
                text: 'added \\usepackage{graphicx} — this paper did not load it',
            });
        }

        this._post({
            type: 'status', kind: 'ok',
            text: plan.replaced ? 'output updated in the paper' : 'output inserted into the paper',
        });
        await this._refreshMma();
    }

    /**
     * The reader typed in a cell — write it back into the block.
     *
     * The .tex remains the single source of truth: the card holds no state the
     * document does not, so the block is rewritten from the parse plus this one
     * changed cell, and everything else about it — the fences below, the other
     * cells, the header — is reproduced exactly as it was read.
     */
    async _applyMmaChange(m) {
        const s = this._mma;
        if (!s || !m || typeof m.code !== 'string') return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file)); }
        catch (_) { return; }
        const block = this._findBlock(doc, s.blockId);
        if (!block) return;
        const idx = this._cellIndex(block, m.cellId);
        if (idx < 0) return;
        if (block.cells[idx].code === m.code) return;      // our own echo

        const text = doc.getText();
        const bdoc = mmaWrite.toDoc(block);
        bdoc.cells[idx].code = m.code;
        const plan = mmaWrite.planBlockText(text, block, bdoc);
        // Set BEFORE applying: the change event this fires must read as our own
        // echo, not as an update to push back into the card.
        s.lastText = plan.newText.replace(/\n$/, '');
        await this._guardedWrite(doc, 'wpaper.mathematica', 'edited computation', (we) => {
            we.replace(doc.uri,
                new vscode.Range(doc.positionAt(plan.startOffset), doc.positionAt(plan.endOffset)),
                plan.newText);
        });
    }

    /**
     * Turn a cell's output on or off in the paper.
     *
     * Turning it OFF deletes the fence in the same edit that records the choice
     * — so the file never carries an output the reader has just deselected. The
     * result stays on screen: it is still true, it is simply not in the paper.
     */
    async _setInclude(m) {
        const s = this._mma;
        if (!s || !m) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file)); }
        catch (_) { return; }
        const block = this._findBlock(doc, s.blockId);
        if (!block) return;
        const idx = this._cellIndex(block, m.cellId);
        if (idx < 0) return;
        const cell = block.cells[idx];
        const include = !!m.include;
        if ((cell.include !== false) === include) return;

        if (!include && cell.outputIndex != null &&
            cell.state === mmaBlocks.BLOCK_STATE.MODIFIED_BY_USER) {
            const choice = await vscode.window.showWarningMessage(
                'This output was edited by hand. Remove it from the paper?',
                { modal: true, detail: 'Your edits to the output will be lost.' },
                'Remove', 'Keep it');
            if (choice !== 'Remove') { await this._refreshMma(); return; }
        }

        const text = doc.getText();
        const bdoc = mmaWrite.toDoc(block);
        // A cell that is going to be named in a fence needs an id, and a cell
        // whose flag is no longer the default needs a directive to carry it.
        if (!bdoc.cells[idx].cellId) bdoc.cells[idx].cellId = this._freshCellId(text);
        bdoc.cells[idx].include = include;
        const blockPlan = mmaWrite.planBlockText(text, block, bdoc);
        const removal = include ? null : mmaWrite.planRemoveOutput(text, block, cell.cellId);

        await this._guardedWrite(doc, 'wpaper.mathematica',
            include ? 'cell will be materialised' : 'cell no longer materialised', (we) => {
                // The fence sits BELOW the block, so removing it first keeps
                // both edits addressing the document they were computed
                // against — they are disjoint, and ordered lowest-last.
                if (removal) {
                    we.replace(doc.uri,
                        new vscode.Range(doc.positionAt(removal.startOffset), doc.positionAt(removal.endOffset)),
                        removal.newText);
                }
                we.replace(doc.uri,
                    new vscode.Range(doc.positionAt(blockPlan.startOffset), doc.positionAt(blockPlan.endOffset)),
                    blockPlan.newText);
            });
        await this._refreshMma();
    }

    /** Which cell a message is about. A one-cell block needs no id. */
    _cellIndex(block, cellId) {
        if (cellId) {
            const i = block.cells.findIndex(c => c.cellId === cellId);
            if (i >= 0) return i;
        }
        return block.cells.length === 1 ? 0 : -1;
    }

    /** An id no cell in this file is using. */
    _freshCellId(text) {
        const crypto = require('crypto');
        for (let i = 0; i < 64; i++) {
            const id = crypto.randomBytes(2).toString('hex');
            if (!new RegExp(`\\b(?:Block|Cell)ID:\\s*${id}\\b`).test(text)) return id;
        }
        return crypto.randomBytes(6).toString('hex');
    }

    /** Re-read the open block and tell the card what changed. */
    async _refreshMma() {
        const s = this._mma;
        if (!s) return;
        let doc;
        try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file)); }
        catch (_) { return; }
        const block = this._findBlock(doc, s.blockId);
        if (!block) { this._post({ type: 'mmaClosed' }); this._mma = null; return; }
        const startPos = new vscode.Position(block.startLine - 1, 0);
        const lines = doc.getText().split(/\r?\n/);
        const endPos = new vscode.Position(block.endLine - 1, (lines[block.endLine - 1] || '').length);
        s.startOffset = doc.offsetAt(startPos);
        s.endOffset = doc.offsetAt(endPos);
        s.lastText = doc.getText(new vscode.Range(startPos, endPos));
        this._post({
            type: 'mmaUpdate',
            blockId: s.blockId,
            startLine: block.startLine,
            endLine: block.endLine,
            cells: block.cells.map(c => this._cellForPanel(c)),
            state: block.state,
            stateReason: block.stateReason,
        });
    }

    /**
     * The editor SNAPS to the place; VS Code can ease it instead.
     *
     * An extension cannot animate a text editor: `revealRange` is the only
     * lever the API gives, it is one-shot, and stepping it over intermediate
     * lines to fake easing is both janky and a fight with anyone who scrolls
     * mid-flight. What DOES animate it is VS Code's own `editor.smoothScrolling`
     * — an extension reveal is a smooth-type scroll, whose duration that
     * setting sets, and which is zero while it is off.
     *
     * So the honest thing is to say so, ONCE, and offer to turn it on rather
     * than either living with the snap or silently changing a global setting
     * on somebody's behalf. Marked as asked BEFORE the dialog, so a dismissed
     * one does not come back on the next click.
     */
    async _offerSmoothScroll() {
        const KEY = 'wolfbook.tex.smoothScrollOffered';
        try {
            const store = this.context && this.context.globalState;
            if (!store || store.get(KEY)) return;
            const cfg = vscode.workspace.getConfiguration('editor');
            if (cfg.get('smoothScrolling') === true) { await store.update(KEY, true); return; }
            await store.update(KEY, true);
            const yes = await vscode.window.showInformationMessage(
                'The editor jumps straight to the place you clicked. VS Code can scroll there '
                + 'instead — that is one setting, editor.smoothScrolling.',
                'Scroll smoothly', 'Leave it');
            if (yes !== 'Scroll smoothly') return;
            await cfg.update('smoothScrolling', true, vscode.ConfigurationTarget.Global);
            this._post({
                type: 'status', kind: 'ok',
                text: 'the editor will scroll to the place now, rather than jump',
            });
        } catch (_) { /* an offer is never worth an error */ }
    }

    /** Paint a source line range back onto the pages, within reason. */
    _showSpan(st, file, step) {
        const MAX_LINES = 60;      // a whole section is thousands of rows
        const rects = [];
        if (step.lines <= MAX_LINES) {
            const rows = [];
            for (let n = step.start.line; n <= step.end.line; n++) {
                for (const r of st.map.lineRows(file, n)) {
                    rows.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h });
                }
            }
            rects.push(...mergeRows(dropStrayRows(rows)));
        }
        const a = st.map.sourceToRender(file, step.start.line);
        const b = st.map.sourceToRender(file, step.end.line);
        const pages = a.page && b.page && a.page !== b.page ? ` · pp.${a.page}–${b.page}`
            : (a.page ? ` · p.${a.page}` : '');
        this._post({
            type: 'highlight',
            rects,
            flag: 'approx',
            reveal: false,
            label: `${step.label}${pages}` +
                (rects.length ? '' : ' — too large to outline'),
        });
    }

    _modelFor(doc) {
        try { return this.projection.get(doc).model; } catch (_) { return null; }
    }

    /** Restore the saved member of the two-state reading-layout toggle. */
    async _restoreSessionChrome() {
        const saved = this._viewState || this._viewFor(this.root) || {};
        // `viewerAgents` was the retired middle member of the old three-state
        // cycle. Migrate it to the ordinary editor + viewer layout.
        const mode = saved.layoutMode === 'viewer' || saved.fullscreen === true
            ? 'viewer' : 'all';
        if (this._restoringPanel) {
            try {
                await this._queueLayout(() => this._reconcileRestoredLayout(mode));
            } finally { this._restoringPanel = false; }
            return;
        }
        await this.setLayoutMode(mode, { remember: false });
    }

    /**
     * Make the workbench's real group geometry agree with restored WPaper
     * state.
     *
     * Recent VS Code builds can restore a maximized-group context key before
     * their editor grid has finished restoring. Merely claiming that state
     * leaves the source group and WPaper group occupying the same title-bar
     * pixels until another layout action — the overlapping tabs seen after a
     * reload. `evenEditorWidths` is an explicit operation, unlike a toggle:
     * it establishes a known unmaximized baseline whether the old group was
     * maximized or not. The saved member of WPaper's two-state toggle is then
     * applied from that baseline.
     */
    async _reconcileRestoredLayout(mode) {
        if (!this.panel) return;
        const target = mode === 'viewer' ? 'viewer' : 'all';
        const available = await this._availableLayoutCommands();
        const restoredOuter = target === 'viewer' ? [...(this._layoutOuterActions || [])] : [];
        const normalized = await this._runLayoutCommand('workbench.action.evenEditorWidths', available);
        if (!normalized) {
            // Older hosts have no explicit reset. Keep the claimed state so a
            // toggle cannot accidentally reverse a correctly restored layout.
            await this._setLayoutModeNow(target, { remember: false });
            return;
        }

        this._layoutMode = 'all';
        this._layoutMaximized = false;
        this._layoutOuterActions = restoredOuter;
        this._fsActions = null;
        if (target === 'all') {
            try { this.panel.reveal(this.panel.viewColumn, false); } catch (_) { /* disposed meanwhile */ }
            this._postLayout('all');
            return;
        }
        await this._setLayoutModeNow(target, { remember: false, preserveOuter: true });
    }

    /** Extra chrome used only by the WPaper-only member of the cycle. */
    _outerFullScreenCommands() {
        const mode = vscode.workspace.getConfiguration('wolfbook.tex')
            .get('fullScreenMode', 'maximize');
        return mode === 'zen' ? ['workbench.action.toggleZenMode']
            : mode === 'fullScreen' ? ['workbench.action.toggleFullScreen'] : [];
    }

    /**
     * VS Code restores maximized groups and Secondary Side Bar visibility on a
     * window reload. Reclaim that state without firing a toggle which would
     * immediately reverse the layout VS Code just restored.
     */
    _claimRestoredLayout() {
        const saved = this._viewState || this._viewFor(this.root) || {};
        const mode = saved.layoutMode === 'viewer' || saved.fullscreen === true
            ? 'viewer' : 'all';
        if (mode === 'all' || this._fsActions) return false;
        const stored = Array.isArray(saved.layoutOuterActions)
            ? saved.layoutOuterActions
            : Array.isArray(saved.fullscreenActions)
                ? saved.fullscreenActions.filter(x => x !== 'workbench.action.toggleMaximizeEditorGroup')
                : [];
        this._layoutMode = mode;
        this._layoutMaximized = true;
        this._layoutOuterActions = stored.filter(x => typeof x === 'string' && x);
        this._fsActions = ['workbench.action.toggleMaximizeEditorGroup', ...this._layoutOuterActions];
        return true;
    }

    // Kept as a compatibility seam for restored pre-cycle state and tests.
    _claimRestoredFullScreen() { return this._claimRestoredLayout(); }

    async _availableLayoutCommands() {
        try {
            if (typeof vscode.commands.getCommands === 'function') {
                return new Set(await vscode.commands.getCommands(true));
            }
        } catch (_) { /* optimistically try commands on older hosts */ }
        return null;
    }

    async _runLayoutCommand(id, available) {
        if (available && !available.has(id)) return false;
        try { await vscode.commands.executeCommand(id); return true; }
        catch (_) { return false; }
    }

    _rememberLayout(mode) {
        this._rememberState(this.root, {
            layoutMode: mode,
            // Legacy readers understand only viewer-only versus ordinary.
            fullscreen: mode === 'viewer',
            fullscreenActions: this._fsActions ? [...this._fsActions] : [],
            layoutOuterActions: [...(this._layoutOuterActions || [])],
        });
    }

    _postLayout(mode) {
        this._post({ type: 'fullscreen', value: mode !== 'all', mode });
    }

    /**
     * Keep an external file reload from exposing the source editor.
     *
     * VS Code can unmaximize an editor group while it reloads a clean text
     * buffer from disk. Our state still correctly says `viewer`, so simply
     * calling setLayoutMode('viewer') is a no-op. If the reload activated the
     * source group, reactivate and maximize WPaper; if it left WPaper active,
     * touch nothing. Delayed and coalesced because the file watcher and
     * TextDocument reload arrive as one short event burst.
     */
    preserveViewerLayoutAfterExternalChange(delayMs = 180) {
        if (!this.panel || !(this._layoutMode === 'viewer' || this._fsActions)) return false;
        clearTimeout(this._layoutGuardTimer);
        this._layoutGuardTimer = setTimeout(() => {
            this._layoutGuardTimer = null;
            this._queueLayout(() => this._reassertViewerLayoutNow()).catch(() => { /* best effort */ });
        }, Math.max(0, Number(delayMs) || 0));
        return true;
    }

    async _reassertViewerLayoutNow() {
        if (!this.panel || !(this._layoutMode === 'viewer' || this._fsActions)) return false;
        // The common case: VS Code reloaded the buffer without disturbing the
        // active maximized webview. Do absolutely nothing, avoiding even a
        // one-frame flash of the source group.
        if (this.panel.active === true) return true;
        const available = await this._availableLayoutCommands();
        const outer = [...(this._layoutOuterActions || [])];
        if (this.panel.active !== false) {
            // Older host/test doubles do not expose WebviewPanel.active.
            // Establish a known baseline there rather than guessing which way
            // a toggle will go.
            const normalized = await this._runLayoutCommand('workbench.action.evenEditorWidths', available);
            if (!normalized) {
                try { this.panel.reveal(this.panel.viewColumn, false); } catch (_) { /* disposed */ }
                return false;
            }
        }
        // `active === false` is the measured external-reload failure: VS Code
        // activated the reloaded source group and in doing so cancelled the
        // maximize. Go straight back to WPaper and maximize it, without first
        // revealing an even-width source layout.
        this._layoutMode = 'all';
        this._layoutMaximized = false;
        this._layoutOuterActions = outer;
        this._fsActions = null;
        await this._setLayoutModeNow('viewer', { remember: false, preserveOuter: true });
        return this._layoutMode === 'viewer' && this._layoutMaximized;
    }

    /**
     * Set one of two explicit layouts:
     *   viewer — maximized WPaper
     *   all    — source editor beside WPaper
     *
     * The Secondary Side Bar is independent workspace chrome, not a third
     * reading layout. Leave it exactly as the reader had it: maximizing an
     * editor group can hide the source editor without also dismissing Codex,
     * Claude or Chat on the far right.
     */
    _queueLayout(change) {
        const before = this._layoutQueue || Promise.resolve();
        const work = before.catch(() => {}).then(change);
        this._layoutQueue = work;
        return work.finally(() => {
            if (this._layoutQueue === work) this._layoutQueue = null;
        });
    }

    setLayoutMode(want, opts = {}) {
        return this._queueLayout(() => this._setLayoutModeNow(want, opts));
    }

    async _setLayoutModeNow(want, { remember = true, preserveOuter = false } = {}) {
        if (!this.panel) return;
        const target = want === 'viewer' ? 'viewer' : 'all';
        if (this._fsSettling) {
            try { await this._fsSettling; } catch (_) { /* best effort */ }
        }
        // Tests and pre-cycle callers may have populated the old sentinel only.
        if (this._fsActions && this._layoutMode === 'all') {
            this._layoutMode = 'viewer';
            this._layoutMaximized = true;
            this._layoutOuterActions = this._fsActions
                .filter(x => x !== 'workbench.action.toggleMaximizeEditorGroup');
        }
        if (target === this._layoutMode) {
            if (remember) this._rememberLayout(target);
            this._postLayout(target);
            return;
        }
        const panel = this.panel;
        const available = await this._availableLayoutCommands();

        // Leave OS fullscreen/Zen before showing the source editor.
        if (target !== 'viewer' && this._layoutOuterActions.length) {
            for (const c of [...this._layoutOuterActions].reverse()) {
                await this._runLayoutCommand(c, available);
            }
            this._layoutOuterActions = [];
        }

        if (target === 'all') {
            if (this._layoutMaximized) {
                await this._runLayoutCommand('workbench.action.toggleMaximizeEditorGroup', available);
                this._layoutMaximized = false;
            }
            try { panel.reveal(panel.viewColumn, false); } catch (_) { /* disposed meanwhile */ }
        } else {
            if (!this._layoutMaximized) {
                // Maximize acts on the active group, so WPaper must own focus.
                try { panel.reveal(panel.viewColumn, false); } catch (_) { /* continue */ }
                this._layoutMaximized = await this._runLayoutCommand(
                    'workbench.action.toggleMaximizeEditorGroup', available);
                if (!this._layoutMaximized) {
                    this._post({ type: 'status', text: 'this VS Code build cannot maximize WPaper', kind: 'warn' });
                }
            }
            if (!preserveOuter) {
                const done = [];
                for (const c of this._outerFullScreenCommands()) {
                    if (await this._runLayoutCommand(c, available)) done.push(c);
                }
                this._layoutOuterActions = done;
            }
        }
        this._layoutMode = target;
        this._fsActions = target === 'all' ? null
            : ['workbench.action.toggleMaximizeEditorGroup', ...this._layoutOuterActions];
        if (remember) this._rememberLayout(target);
        this._postLayout(target);
    }

    cycleLayoutMode() {
        // Choose the next state inside the queue. Otherwise two fast clicks can
        // both observe the same current state before the first command settles.
        return this._queueLayout(async () => {
            const current = this._layoutMode === 'viewer' || this._fsActions ? 'viewer' : 'all';
            const next = current === 'all' ? 'viewer' : 'all';
            await this._setLayoutModeNow(next);
        });
    }

    async setFullScreen(on, opts = {}) {
        await this.setLayoutMode(on ? 'viewer' : 'all', opts);
    }

    _post(msg) { if (this.panel) this.panel.webview.postMessage(msg); }

    _html() {
        const w = this.panel.webview;
        const script = w.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'out', 'client', 'tex-viewer.js'));
        const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
        // pdf.js needs `wasm-unsafe-eval` for its own decoders; everything else
        // is locked down. `blob:` covers the worker pdf.js may spin up.
        const csp = [
            `default-src 'none'`,
            `img-src ${w.cspSource} blob: data:`,
            `style-src ${w.cspSource} 'unsafe-inline'`,
            `font-src ${w.cspSource} data:`,
            `script-src ${w.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
            `worker-src ${w.cspSource} blob:`,
            `connect-src ${w.cspSource} blob: data:`,
        ].join('; ');

        // The markup lives in its own file so the headless check can serve the
        // SAME bytes. It went unnoticed for a whole feature that the harness
        // was exercising a hand-written page instead of this one.
        const shell = fs.readFileSync(path.join(
            this.context.extensionUri.fsPath, 'out', 'client', 'tex-viewer.shell.html'), 'utf8');

        return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body>
${shell}
<script nonce="${nonce}" type="module" src="${script}"></script>
</body></html>`;
    }
}

const shortLabel = (o) =>
    o.kind === 'display-equation' ? (o.label ? `eq ${o.label}` : 'equation')
        : o.kind === 'section-heading' ? `§ ${o.title || ''}`.trim()
            : o.label ? `${o.kind} ${o.label}` : o.kind;

module.exports = {
    TexViewer, VIEW_TYPE, mergeRows, dropStrayRows, dropEquationTags,
    clipToSpan, dropDetachedRows, dominantPage,
};
