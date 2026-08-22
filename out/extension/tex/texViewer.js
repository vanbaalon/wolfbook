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

const { FLAG } = require('./renderMap');
const {
    wordAtColumn, findWordInLine, collectMacros, isInMath, mathRegions,
    locateByContext, visibleWords,
} = require('./texWords');
const { selectionLadder, paragraphSpan, CONTAINER_KINDS } = require('./texSelect');
const { buildObjectMap, glyphAtPoint, tokenAt, groupAround, symbolicFonts } = require('./glyphAlign');
const { buildComparison, describeSummary } = require('./texCompare');
const { shipDecision } = require('./livePolicy');
const { balanceRange, closeFor, commentMask } = require('./texBalance');
const { sectionSpans } = require('./texModel');
const { MATH_ENVS } = require('./texScanner');
const { readAuxLabels } = require('./auxLabels');
const { buildLabelChips, formatLabelCopy, altFormat } = require('./labelChips');
const { stepAt, satisfies } = require('./tourSteps');

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
 * The panel's two long tooltips — what a click does on the page, what clicking
 * a label badge copies — teach the gestures once and then cover the text they
 * describe. Reported as "kind of annoying". Each gets three showings and is
 * then taken off the element.
 *
 * MODULE-LEVEL ON PURPOSE: the count must survive closing and reopening the
 * paper (that is not a new reader) and reset when the window reloads (that is
 * a new session, and the reminder is fair again). Nothing is written to disk —
 * a hint budget is not worth a setting, and "after each restart" is exactly
 * what the reader asked for.
 */
const TOUR_KEY = 'wolfbook.tex.tour';
const GROUP_KEY = 'wolfbook.tex.reviewGroup';
const HINT_BUDGET = { pages: 3, chip: 3 };
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
    'environment', 'align', 'abstract', 'list', 'itemize', 'enumerate', 'verbatim',
]);

const VIEW_TYPE = 'wolfbook.texViewer';
/** Where the shown paper's root is kept, so a window reload can restore it. */
const ROOT_KEY = 'wolfbook.tex.viewerRoot';

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
    constructor(context, coord, projection) {
        this.context = context;
        this.coord = coord;
        this.projection = projection;
        this.panel = null;
        this.root = null;          // the root .tex this panel is showing
        // The generation whose BYTES the webview holds — not simply the newest
        // one. _text.generation and _objMaps are keyed on it, so it may only
        // advance when a document actually crossed into the panel.
        this.shownGeneration = null;
        this.shownPdfHash = null;
        this.followCursor = true;
        this.shownAnything = false;
        this._ladder = null;       // {page, xBp, yBp, items, index, file}
        this._invertedAt = 0;      // when the reader last clicked IN the PDF
        this._macros = new Map();  // docPath -> {version, table}
        this._fsActions = null;    // the commands that put us in full screen
        this._autoHidden = null;   // closed by us because no .tex was active
        this._viewState = null;    // {page, frac} so hide/restore keeps the place
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
        this._crops = new Map();   // `${generation}|${key}` -> {dataUrl,w,h}
        this._cropWaits = new Map();
        this._cropSeq = 0;
        this._chips = null;        // {key, items}
        this._chipModels = null;   // file -> model, for the files of this root
        this._labelsWanted = false;
        this._flash = new EditorFlash();
        this._disposables = [];
    }

    get visible() { return !!this.panel; }

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
        this.root = root;
        this._rememberRoot(root);
        this._postTheme();
        await this.refresh({ force: true });
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
    _wire(panel) {
        this.panel = panel;
        panel.iconPath = undefined;
        // A restored panel arrives with its options and content dropped, so
        // both are re-established rather than assumed.
        try { panel.webview.options = this._webviewOptions; } catch (_) { /* new panel: already set */ }
        panel.webview.html = this._html();
        panel.onDidDispose(() => {
            // Closing the panel must not leave the window maximised with
            // nothing in it.
            if (this._fsActions) {
                const undo = [...this._fsActions].reverse();
                this._fsActions = null;
                (async () => {
                    for (const c of undo) {
                        try { await vscode.commands.executeCommand(c); } catch (_) { /* best effort */ }
                    }
                })();
            }
            this.panel = null;
            this.shownGeneration = null;
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
            this._crops.clear();
            for (const done of this._cropWaits.values()) { try { done(null); } catch (_) {} }
            this._cropWaits.clear();
            this._objMaps.clear();
            this._flash.dispose();
            for (const d of this._disposables.splice(0)) { try { d.dispose(); } catch (_) {} }
        });
        panel.webview.onDidReceiveMessage((m) => this._onMessage(m));
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
        this._wire(panel);
        this._autoHidden = null;
        let root = (state && state.root) || null;
        try { root = root || this.context.workspaceState.get(ROOT_KEY) || null; } catch (_) { /* none */ }
        if (state && Number.isFinite(state.page)) {
            this._viewState = { page: state.page, frac: state.frac };
        }
        if (!root || !fs.existsSync(root)) {
            this._post({ type: 'status', text: 'reopen the paper from a .tex file', kind: 'warn' });
            return;
        }
        this.root = root;
        this._postTheme();
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(root));
            // A reload drops every in-memory compile record, so there may be
            // nothing to show until one is rebuilt. The persisted generation
            // makes that instant whenever the out dir survived.
            const st = this.coord.stateFor(doc);
            if (!st || !st.generation) await this.coord.build(doc);
            await this.refresh({ force: true });
            this.syncFromEditor(vscode.window.activeTextEditor);
        } catch (e) {
            this._post({ type: 'status', text: `could not restore the paper: ${e.message}`, kind: 'err' });
        }
    }

    /** Push the current generation's PDF into the webview. */
    async refresh({ force = false } = {}) {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
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
                // The ink did not move, but the SOURCE did (that is why we
                // recompiled), so the map did. Re-answer from the new map
                // without disturbing the document the webview already holds —
                // this is the round trip the 'opened' handshake would have
                // triggered had we shipped.
                try { this.syncFromEditor(vscode.window.activeTextEditor); } catch (_) { /* best effort */ }
                this._postEditAnchor().catch(() => { /* no open card */ });
                // The ink did not move, so the chips are still in the right
                // PLACES — but the source did, so which line each \ref sits on
                // may have changed. Drop the models, keep nothing else.
                this._chipModels = null;
                this._chips = null;
                if (this._labelsWanted) this._postLabels().catch(() => { /* best effort */ });
            }
            return;
        }
        if (!fs.existsSync(st.generation.pdfPath)) {
            this._post({ type: 'status', text: 'the compiled PDF has gone missing', kind: 'err' });
            return;
        }
        const t0 = Date.now();
        this.shownGeneration = st.generation.generation;
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
            pages: st.generation.pageCount,
            // Restoring after an auto-hide should land where the reader was.
            revealPage: this._viewState && this._viewState.page,
            // A live rebuild replaces the pages under a reader who did not ask
            // for it, so the viewer keeps their scroll position and swaps each
            // canvas only once its replacement is drawn.
            live: !!st.generation.live && this.shownAnything,
        });
        this.shownAnything = true;
        // What the webview now holds — the key the next refresh compares.
        this.shownPdfHash = st.generation.pdfHash || null;
        this._post({ type: 'setFollow', value: this.followCursor });
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
        if (this.panel || !this._autoHidden) return;
        this._autoHidden = null;
        await this.open(doc, { reveal: true });
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
        try {
            const model = st && this._modelFor2(this.root);
            hasLabels = !!(model && model.objects.some(o => o.label || (o.kind === 'label' && o.name)));
        } catch (_) { hasLabels = false; }
        return { hasLabels, hasReview: !!(this._review && this._review.sessionFor(this.root)) };
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
        this._post({ type: 'review', session: payload || null });
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
    focusReviewHunk(h) {
        if (!h) return;
        this._post({ type: 'reviewFocus', id: h.id, page: h.page, rects: h.rects || [] });
    }

    /** A line in the panel's footer — the review speaks to the reader here. */
    status(text, kind) { this._post({ type: 'status', text, kind: kind || '' }); }

    async _onReviewAction(m) {
        const r = this._review;
        const file = this.root;
        if (!r || !file) return;
        switch (m && m.action) {
            case 'keep': return r.keep(file, m.id);
            case 'undo': return r.undo(file, m.id);
            case 'keepAll': return r.keepAll(file);
            case 'undoAll': return r.undoAll(file);
            case 'keepBatch': return r.keepBatch(file, m.batch);
            case 'keepMany': return r.keepMany(file, m.ids);
            case 'show': return r.show(file, m.id);
            case 'next': return r.step(file, +1);
            case 'prev': return r.step(file, -1);
            case 'close': return r.close(file);
            default: return undefined;
        }
    }


    /** Forward sync: highlight the object under the cursor. */
    syncFromEditor(editor) {
        if (!this.panel || !this.followCursor || !editor) return;
        const doc = editor.document;
        if (!/\.tex$/i.test(doc.uri.fsPath)) return;
        const st = this.coord.stateFor(doc);
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
        if (this._postAlignedGlyph(st, doc, line, column, obj ? obj.stableKey : `line ${line}`)) return;

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
            reveal: !fromClick,
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
    _postAlignedGlyph(st, doc, line, column, title) {
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
                if (parts.length) { rects = mergeRows(parts); what = `"${run.word}"`; glyph = false; }
            }
        }
        this._post({
            type: 'highlight',
            rects,
            glyph,
            word, occurrence,
            exact: !!amap.exact,
            flag: flag === FLAG.FRESH ? 'fresh' : flag === FLAG.STALE ? 'stale' : 'approx',
            reveal: Date.now() - this._invertedAt >= 1500,
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
    _postWordMarker(st, doc, line, column) {
        const file = doc.uri.fsPath;
        if (this._postAlignedGlyph(st, doc, line, column, `line ${line}`)) {
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
            reveal: Date.now() - this._invertedAt >= 1500,
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
            if (this._postWordMarker(st, doc, startLine, sel.start.character)) return;
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
        this._post({
            type: 'selection',
            span: {
                start: ends[0],
                end: ends[1],
                rows,
                lines: endLine - startLine + 1,
            },
            reveal: Date.now() - this._invertedAt >= 1500,
            // THE LABEL IS THE DIAGNOSTIC. A span that lands on the wrong block
            // is reported as a picture, and the only way to tell a wrong
            // ANSWER from a displaced MAP is to say which lines were asked
            // about, which pages answered, and out of which map.
            label: `lines ${startLine}\u2013${endLine} \u00b7 p.${[...new Set(rows.map(r => r.page))].join(',')}` +
                ` \u00b7 ${flagWord(st.map._baseFlag())}${st.map.exact ? ' \u00b7 exact' : ''}`,
        });
    }

    async _onMessage(m) {
        // The tour watches the SAME messages the panel already sends, so what
        // it teaches and what the reader does are the same event.
        try { this._tourObserve(m); } catch (_) { /* the tour never breaks the panel */ }
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
                this._postTheme();
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
                // The list survives a panel reopen: the session is the truth,
                // the panel is only its picture.
                if (this._review) this._review.push(this.root);
                break;
            case 'reviewAction': await this._onReviewAction(m); break;
            case 'follow': this.followCursor = !!m.value; break;
            case 'recompile': await this.rebuild(); break;
            case 'click': await this._jumpToSource(m); break;
            case 'fullscreen': await this.setFullScreen(m.value); break;
            case 'viewstate':
                this._viewState = { page: m.page, frac: m.frac };
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
                this.syncFromEditor(vscode.window.activeTextEditor);
                // The mini-editor's block has new geometry too — move the card.
                this._postEditAnchor().catch(() => {});
                if (this._labelsWanted) this._postLabels().catch(() => {});
                break;
            case 'textLayer': this._onTextLayer(m); break;
            case 'textLayerDone':
                this._log(`text layer complete for generation ${m.generation}: ` +
                    `${m.pages} pages${m.ms != null ? ` in ${m.ms} ms` : ''}`);
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
            case 'editClose': this._edit = null; break;
            case 'editSave': await this._saveEditDoc(); break;
            case 'editReveal': await this._revealEditRange(); break;
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
            if (action === 'cut') {
                try { await vscode.env.clipboard.writeText(text); }
                catch (e) {
                    // A cut that cannot copy must not delete: that is the one
                    // way to lose the text with nothing to paste back.
                    this._post({ type: 'status', text: `could not copy, so nothing was cut: ${e.message}`, kind: 'err' });
                    return;
                }
            }
            const edit = new vscode.WorkspaceEdit();
            edit.delete(doc.uri, range);
            let ok = false;
            try { ok = await vscode.workspace.applyEdit(edit); } catch (e) { ok = false; }
            if (!ok) { this._post({ type: 'status', text: `the ${action} could not be applied`, kind: 'err' }); return; }
            this._afterSelectionEdit(sel.file, sel.start, sel.start, 'gone');
            this._post({
                type: 'status', kind: 'ok',
                text: action === 'cut' ? `cut ${text.length} characters` : `deleted ${text.length} characters`,
            });
            return;
        }

        if (action === 'paste') {
            let clip = '';
            try { clip = await vscode.env.clipboard.readText(); } catch (_) { clip = ''; }
            if (!clip) {
                // An image in the clipboard is a figure, not a string — the
                // same answer ⌘V gives in the editor.
                this._post({ type: 'status', text: 'the clipboard holds no text', kind: 'warn' });
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, range, clip);
            let ok = false;
            try { ok = await vscode.workspace.applyEdit(edit); } catch (e) { ok = false; }
            if (!ok) { this._post({ type: 'status', text: 'the paste could not be applied', kind: 'err' }); return; }
            // Select what was pasted, so it can be moved or replaced again.
            const startOff = doc.offsetAt(sel.start);
            const end = doc.positionAt(startOff + clip.length);
            this._afterSelectionEdit(sel.file, sel.start, end, 'kept');
            this._post({ type: 'status', text: `pasted ${clip.length} characters`, kind: 'ok' });
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
            // THE NEAREST LEGAL BOUNDARY, when the page can offer one.
            //
            // This replaces "resolve a line, then repair it": the gaps between
            // the blocks printed on this page ARE the places a block may land,
            // and the reader is aiming at one of them. Falls through to the
            // older line-based reasoning when the page has nothing to offer —
            // an unmapped region, a page still rendering.
            const bounds = this._dropBoundaries(st, doc, m.page);
            if (bounds.length) {
                let best = null;
                for (const b of bounds) {
                    const d = Math.abs(b.y - m.yTopBp);
                    if (!best || d < best.d) best = { b, d };
                }
                if (best) {
                    const at2 = Math.max(0, Math.min(doc.lineCount, best.b.line - 1));
                    const b = best.b;
                    const rects = Number.isFinite(b.x0) && b.x1 > b.x0
                        ? [{ page: b.page, x: b.x0, y: b.y, w: b.x1 - b.x0, h: 0 }]
                        : this._caretRects(st, doc, at2 + 1, true);
                    return {
                        file: doc.uri.fsPath, block: true,
                        line: at2 + 1, column: 0,
                        offset: doc.offsetAt(new vscode.Position(at2, 0)),
                        rects,
                    };
                }
            }
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
        try { ok = await vscode.workspace.applyEdit(edit); }
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
    async _jumpToSource(m) {
        const st = this.root && this.coord.roots.get(this.root);
        if (!st || !st.map || !st.map.available) return;
        this._invertedAt = Date.now();

        const hit = this._resolvePoint(st, m);
        if (!hit || hit.flag === FLAG.UNMAPPED || !hit.file) {
            this._ladder = null;
            this._post({ type: 'status', text: hit && hit.reason ? hit.reason : 'nothing there', kind: 'warn' });
            return;
        }

        const uri = vscode.Uri.file(hit.file);
        const doc = await vscode.workspace.openTextDocument(uri);
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
        // FULL SCREEN MUST SURVIVE A CLICK.
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
        // supposed to leave full screen, so it still reveals.
        const inFullScreen = !!this._fsActions && !m.takeMe;
        const editor = inFullScreen
            ? (vscode.window.visibleTextEditors || [])
                .find(e => e.document && e.document.uri.fsPath === doc.uri.fsPath) || null
            : await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: !m.takeMe,   // reading stays in the PDF; "go there" does not
                preview: false,
            });

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

        // Remember what this click is about to select, so the change event it
        // provokes is not mistaken for the reader making a selection.
        this._selfRange = {
            file: doc.uri.fsPath, kind: 'click',
            sl: range.start.line, sc: range.start.character,
            el: range.end.line, ec: range.end.character,
            at: Date.now(),
        };
        if (editor) {
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            // The page marks where you are with a wash that fades; the editor
            // end of the same gesture now does too, decaying into the ordinary
            // selection rather than just appearing there.
            this._flash.show(editor, range);
        }
        this._post({ type: 'status', text: `→ ${what}`, kind: 'ok' });

        // WITH A MINI-EDITOR OPEN, THE CARD IS THE EDITING SURFACE.
        //
        // The reader has a block open and clicks its rendered symbol: the caret
        // belongs where they pointed, in the card, not only in the text editor
        // behind it. Focus follows for a plain click (which leaves focus in the
        // webview anyway); a double-click means "take me to the editor", so it
        // must not be stolen back.
        this._postEditSelection(doc, range, !m.takeMe);

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

        // "Take me there": leave full screen, because the editor is what the
        // reader now wants to look at.
        if (m.takeMe && this._fsActions) await this.setFullScreen(false);
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

    _copyFormat() {
        return vscode.workspace.getConfiguration('wolfbook.tex')
            .get('labelCopyFormat', 'command');
    }

    async _postLabels() {
        if (!this.panel || !this.root) return;
        const st = this.coord.roots.get(this.root);
        if (!st) return;
        const items = this._labelChips(st);
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
        };
        this._edit = s;
        this._ensureDocListener();
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
        };
        this._edit = s;
        this._ensureDocListener();
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
        });
    }

    async _applyEditChange(m) {
        const s = this._edit;
        if (!s || m.editId !== s.id || typeof m.text !== 'string') return;
        if (m.text === s.lastText) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const range = new vscode.Range(
                doc.positionAt(s.startOffset), doc.positionAt(s.endOffset));
            // Set BEFORE applying: the change event this edit fires must read
            // as our own echo, not as an update to send back to the card.
            s.lastText = m.text;
            const we = new vscode.WorkspaceEdit();
            we.replace(doc.uri, range, m.text);
            const ok = await vscode.workspace.applyEdit(we);
            if (!ok) this._post({ type: 'status', text: 'the edit could not be applied', kind: 'err' });
        } catch (e) {
            this._post({ type: 'status', text: `edit failed: ${e.message}`, kind: 'err' });
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
        const a = doc.positionAt(s.startOffset);
        const b = doc.positionAt(s.endOffset);
        const text = doc.getText(new vscode.Range(a, b));
        if (text === s.lastText) return;
        s.lastText = text;
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
    _postEditSelection(doc, range, focus) {
        const s = this._edit;
        if (!s || !doc || !range || doc.uri.fsPath !== s.file) return;
        let a; let b;
        try { a = doc.offsetAt(range.start); b = doc.offsetAt(range.end); }
        catch (_) { return; }
        if (b < s.startOffset || a > s.endOffset) return;
        const clamp = (n) => Math.max(0, Math.min(n, s.endOffset) - s.startOffset);
        this._post({
            type: 'editSelect', editId: s.id, focus: !!focus,
            start: clamp(Math.max(a, s.startOffset)),
            end: clamp(Math.max(b, s.startOffset)),
        });
    }

    /** After a recompile the block has new geometry — move the card to it. */
    async _postEditAnchor() {
        const s = this._edit;
        const st = this.root && this.coord.roots.get(this.root);
        if (!s || !st || !st.map || !st.map.available) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const a = doc.positionAt(s.startOffset);
            const b = doc.positionAt(s.endOffset);
            const rects = this._editRects(st, s.file, a.line + 1, b.line + 1);
            if (rects.length) this._post({ type: 'editAnchor', editId: s.id, rects });
        } catch (_) { /* keep the old anchor */ }
    }

    async _saveEditDoc() {
        const s = this._edit;
        if (!s) return;
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
            const ok = await doc.save();
            this._post({ type: 'status', text: ok ? `saved ${path.basename(s.file)}` : 'nothing to save', kind: 'ok' });
        } catch (e) {
            this._post({ type: 'status', text: `save failed: ${e.message}`, kind: 'err' });
        }
    }

    async _revealEditRange() {
        const s = this._edit;
        if (!s) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.file));
        const range = new vscode.Range(doc.positionAt(s.startOffset), doc.positionAt(s.endOffset));
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false,
        });
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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

    /**
     * Full screen, reversed by exactly the commands that produced it.
     *
     * VS Code offers several ways to get there and they are not all present in
     * every build, so the ones that exist are discovered at runtime and the
     * list of what actually ran is kept — undoing a toggle we never fired
     * would leave the window in a state the reader did not ask for.
     */
    async setFullScreen(on) {
        if (!this.panel) return;
        if (!!on === !!this._fsActions) return;
        if (on) {
            const mode = vscode.workspace.getConfiguration('wolfbook.tex')
                .get('fullScreenMode', 'maximize');
            const want = mode === 'zen' ? ['workbench.action.toggleZenMode']
                : mode === 'fullScreen'
                    ? ['workbench.action.toggleMaximizeEditorGroup', 'workbench.action.toggleFullScreen']
                    : ['workbench.action.toggleMaximizeEditorGroup'];
            const all = new Set(await vscode.commands.getCommands(true));
            // Maximising acts on the ACTIVE group, so the panel has to be it.
            this.panel.reveal(this.panel.viewColumn, false);
            const done = [];
            for (const c of want) {
                if (!all.has(c)) continue;
                try { await vscode.commands.executeCommand(c); done.push(c); } catch (_) { /* skip */ }
            }
            this._fsActions = done.length ? done : null;
            if (!this._fsActions) {
                this._post({ type: 'status', text: 'this VS Code build has no full-screen command', kind: 'warn' });
            }
        } else {
            for (const c of [...this._fsActions].reverse()) {
                try { await vscode.commands.executeCommand(c); } catch (_) { /* best effort */ }
            }
            this._fsActions = null;
        }
        this._post({ type: 'fullscreen', value: !!this._fsActions });
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
