// labelChips.js — where every \label and every reference to one SITS ON THE PAGE.
//
// Holding Shift in the Page view reveals the paper's whole cross-reference
// skeleton: each numbered object wears its own label, and each \ref / \eqref /
// \cite site wears the label it points at. Clicking one copies a ready-to-paste
// reference. That is the whole feature; this file answers the only hard part of
// it, which is WHERE each chip goes.
//
// PURE, with every accessor injected — the same discipline as texCompare's
// placement rules, and for the same reason: the answer for an equation is a
// geometric argument about SyncTeX rows, and an argument like that is only
// trustworthy if it can be exercised without a compiler, a webview or a kernel.
//
// THE ONE MEASURED IDEA IN HERE. An equation's chip belongs beside its printed
// NUMBER, not beside its ink: that is where a reader's eye already goes to find
// out what to cite, and it is the one part of the row that is guaranteed to be
// free of type. The number is not part of the equation and the render map
// already knows how to tell it apart — `dropStrayRows` in texViewer.js drops it
// from every highlight, because a row that is NARROW and entirely to the RIGHT
// of the object's real content is a tag and nothing else. Here the same
// classifier is used the other way round: the row it discards is the row this
// file wants. Hence `splitStrayRows`, which returns both halves.

/**
 * Split an object's rows into its content and the tag-like strays beside it.
 *
 * The rule is `dropStrayRows`' rule, and the two must not drift: narrow, and
 * entirely to the RIGHT of the body. Only to the right — a wrapped line's short
 * tail row continues at the LEFT margin, and treating that as a stray deleted
 * the last line of paragraph selections when it was tried.
 *
 * @param {Array<{page:number,x:number,y:number,w:number,h:number}>} rects
 * @returns {{keep: Array, stray: Array}}
 */
function splitStrayRows(rects) {
    const byPage = new Map();
    for (const r of rects || []) {
        if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
        if (!byPage.has(r.page)) byPage.set(r.page, []);
        byPage.get(r.page).push(r);
    }
    const keep = [];
    const stray = [];
    for (const rows of byPage.values()) {
        if (rows.length < 2) { keep.push(...rows); continue; }
        const widest = Math.max(...rows.map(r => r.w));
        const body = rows.filter(r => r.w >= widest * 0.4);
        if (!body.length) { keep.push(...rows); continue; }
        const right = Math.max(...body.map(r => r.x + r.w));
        for (const r of rows) {
            const narrow = r.w < widest * 0.4;
            if (narrow && r.x > right + 2) stray.push(r);
            else keep.push(r);
        }
    }
    return { keep, stray };
}

/**
 * IS THIS ROW THE PRINTED EQUATION NUMBER?
 *
 * MEASURED on the reference paper, and the first rule was wrong. `dropStrayRows`
 * asks whether a narrow row lies entirely to the RIGHT of the object's content,
 * which is right for its own purpose but misses the number whenever the equation
 * is wide: `eq:physical-dotted-sov-towers` prints its number at x=515.9 while a
 * content row reaches x=517.2, so the number fails the test by 1.3 bp. Half the
 * paper's equations are like that.
 *
 * What is actually true of a number and of nothing else is that TeX sets it in
 * the RIGHT MARGIN — it STARTS past the text measure — whereas every content
 * row, however wide, starts near the left one. So the test is on x, against the
 * page, and it does not care where the body ends.
 *
 * @param {{x:number,w:number}} r
 * @param {number} pageWidth  bp
 */
function isTagRow(r, pageWidth) {
    const W = pageWidth > 0 ? pageWidth : 595.276;
    return r.x > W * 0.75 && r.w < W * 0.35;
}

/**
 * The number rows of an object, top to bottom.
 *
 * An `align` prints one per numbered line, which is what lets each `\label` in
 * it find its own. The `\end{equation}` sliver qualifies geometrically too — it
 * is a 4 bp record in the same margin — so the widest row on each baseline
 * wins, which is the number wherever there is one.
 */
function tagRows(rows, pageWidth) {
    const tags = (rows || []).filter(r => isTagRow(r, pageWidth));
    const byBand = new Map();
    for (const r of tags) {
        const k = `${r.page}|${Math.round(r.y / 4)}`;
        const cur = byBand.get(k);
        if (!cur || r.w > cur.w) byBand.set(k, r);
    }
    return [...byBand.values()].sort((a, b) => a.page - b.page || a.y - b.y);
}

/** The rows of a source range, from the injected accessor, flattened. */
function rowsOver(rowsFor, file, startLine, endLine) {
    const out = [];
    const a = Math.max(1, startLine | 0);
    const b = Math.max(a, endLine | 0);
    // A pathological range (a whole file as one "object") must not turn into a
    // thousand accessor calls per chip.
    const last = Math.min(b, a + 400);
    for (let n = a; n <= last; n++) {
        let rows = [];
        try { rows = rowsFor(file, n) || []; } catch (_) { rows = []; }
        for (const r of rows) {
            if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
            out.push({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, line: n });
        }
    }
    return out;
}

/** The topmost, then rightmost, of a set of rows — the tag if there is one. */
function pickTagRow(rows) {
    if (!rows.length) return null;
    return rows.slice().sort((a, b) =>
        a.page - b.page || a.y - b.y || (b.x + b.w) - (a.x + a.w))[0];
}

/** The first row in reading order. */
function firstRow(rows) {
    if (!rows.length) return null;
    return rows.slice().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)[0];
}

/** The last row in reading order — a float's caption prints below its body. */
function lastRow(rows) {
    if (!rows.length) return null;
    return rows.slice().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)[rows.length - 1];
}

const CHIP_H = 11;             // bp: the chip's own nominal height, for stacking
const GAP = 5;                 // bp: how far off the text block a column sits

/**
 * TWO COLUMNS IN THE MARGINS, AND NOTHING ON THE READER'S WORDS.
 *
 * MEASURED on the reference paper before this (h-glyphmap/check-chips.mjs):
 * 87 of 119 badges covered printed glyphs, the 82 declarations used 63
 * different x positions, and 9 overlapped each other — the reported "big,
 * obstructing the text, aligned really randomly". All three are the same
 * mistake: each badge was placed against its own ink (above it, beside it, at
 * a corner), so it landed wherever that ink happened to be, which in prose is
 * always ON another line.
 *
 * A paper has margins, and they are empty by construction. So: declarations in
 * the RIGHT margin, references in the LEFT one, every badge in its column at
 * the same x, vertically level with the row it is about. Two columns also say
 * which kind a badge is before it is read — a declaration names the thing
 * beside it, a reference points away.
 */
function blockOf(inkFor, page, pageWidth) {
    const W = pageWidth > 0 ? pageWidth : 595.276;
    let x0 = Infinity; let x1 = -Infinity;
    let items = null;
    try { items = typeof inkFor === 'function' ? inkFor(page) : null; } catch (_) { items = null; }
    for (const it of items || []) {
        if (!it || !(it.w > 0)) continue;
        if (it.x < x0) x0 = it.x;
        if (it.x + it.w > x1) x1 = it.x + it.w;
    }
    // No text layer yet (the first Shift after a compile can beat the sweep):
    // a printed page's measure is close enough to be a column, and the badges
    // are re-placed on the next paint anyway.
    if (!(x1 > x0)) { x0 = W * 0.133; x1 = W * 0.867; }
    return { x0, x1, W };
}

/**
 * A badge in a margin column, level with the middle of `row`.
 *
 * `maxW` is how much margin there is: a badge is CAPPED to it and elides the
 * rest of its name, so the column stays a column and nothing hangs off the
 * sheet. The full name is one hover away (and in the tooltip), which is the
 * right trade for a badge that is read at a glance and copied by clicking.
 */
function inColumn(row, side, block) {
    if (!row) return null;
    const y = row.y + Math.max(0, (row.h || CHIP_H) - CHIP_H) / 2;
    const x = side === 'left' ? Math.max(2, block.x0 - GAP) : Math.min(block.W - 2, block.x1 + GAP);
    return {
        page: row.page,
        x,
        y: Math.max(0, y),
        w: 0, h: CHIP_H,
        anchor: side,
        maxW: Math.max(24, side === 'left' ? x - 2 : block.W - x - 2),
    };
}

/**
 * Nothing may sit on top of anything else in a column.
 *
 * Vertical only: a column's whole point is one x. Pushing DOWN keeps a badge
 * below the row it belongs to, which is where a reader looks for an afterthought
 * — pushing up would put it beside the row above and assert something false
 * about that row.
 */
function stackColumns(chips) {
    const cols = new Map();
    for (const c of chips) {
        if (!c.at) continue;
        const key = `${c.at.page}|${c.at.anchor || 'right'}`;
        if (!cols.has(key)) cols.set(key, []);
        cols.get(key).push(c);
    }
    for (const list of cols.values()) {
        list.sort((a, b) => a.at.y - b.at.y);
        let floor = -Infinity;
        for (const c of list) {
            if (c.at.y < floor) c.at = { ...c.at, y: floor, nudged: true };
            floor = c.at.y + CHIP_H + 1.5;
        }
    }
    return chips;
}

/** Anchor a chip to the RIGHT of a row. */
function atRight(r) {
    return { page: r.page, x: r.x + r.w + 3, y: r.y, w: 0, h: r.h || CHIP_H };
}

/**
 * Anchor a chip just BEFORE the equation number, growing left.
 *
 * MEASURED: anchoring to the right of the number put chips at x=602 on a
 * 595 bp page — off the paper entirely, because the number is already flush to
 * the margin and there is nothing to its right. The white space that IS
 * reliably there is the gap between the equation's last ink and its number, so
 * the chip goes there and grows leftwards into it.
 */
function atNumber(r) {
    return { page: r.page, x: Math.max(2, r.x - 3), y: r.y, w: 0, h: r.h || CHIP_H };
}

/**
 * ABOVE THE EQUATION'S TOP-RIGHT CORNER.
 *
 * Beside the printed number was the obvious place and it reads badly: the chip
 * lands in the middle of the display's height, level with whatever line of the
 * equation happens to carry the number, and on a multi-line display that is
 * somewhere arbitrary. Reported as "current alignment is not good". A label
 * belongs where a caption would — clear of the ink, at the corner, so it reads
 * as a title for the whole block rather than an annotation on one of its rows.
 */
function atTopRight(rows, pageWidth) {
    if (!rows.length) return null;
    const page = firstRow(rows).page;
    const own = rows.filter(r => r.page === page);
    if (!own.length) return null;
    const W = pageWidth > 0 ? pageWidth : 595.276;
    const y0 = Math.min(...own.map(r => r.y));
    // CLAMPED, because the rows may be the NUMBER's — which is flush to the
    // margin and reaches past the text measure. Measured before the clamp:
    // x=599.1 on a 595 bp page, i.e. off the paper.
    const x1 = Math.min(Math.max(...own.map(r => r.x + r.w)), W - 4);
    return { page, x: x1, y: Math.max(0, y0 - CHIP_H - 2), w: 0, h: CHIP_H };
}

/** Anchor a chip in the LEFT margin, before a heading's own ink. */
function atLeft(r) {
    return { page: r.page, x: Math.max(2, r.x - 6), y: r.y, w: 0, h: r.h || CHIP_H };
}

/** Anchor a chip just ABOVE a row — for ref sites, which sit inside prose. */
function above(r, x) {
    return {
        page: r.page,
        x: Number.isFinite(x) ? x : r.x,
        y: Math.max(0, r.y - (r.h || CHIP_H) * 0.85),
        w: 0, h: r.h || CHIP_H,
    };
}

/**
 * Which of a line's rows carries a given printed string, e.g. "(4)".
 *
 * A `\eqref` prints its number INSIDE the prose, so the honest place for the
 * chip is over that number rather than at the end of the line — but only when
 * the ink can actually be found. `inkFor` may be null (the text layer is swept
 * asynchronously, so the first Shift after a compile can arrive before it), in
 * which case the caller falls back and marks the chip approximate.
 */
function findPrintedInk(inkFor, rows, printed) {
    if (!inkFor || !printed) return null;
    const want = String(printed).replace(/[()[\]]/g, '');
    if (!want) return null;
    for (const r of rows) {
        let items = null;
        try { items = inkFor(r.page); } catch (_) { items = null; }
        if (!items || !items.length) continue;
        for (const it of items) {
            if (!it || !it.str) continue;
            const t = String(it.str).replace(/[()[\]\s]/g, '');
            if (t !== want) continue;
            const bl = it.baseline ?? it.y;
            if (!(bl >= r.y - 2 && bl <= r.y + (r.h || CHIP_H) + 2)) continue;
            if (it.x + (it.w || 0) < r.x - 4 || it.x > r.x + r.w + 4) continue;
            return { row: r, x: it.x, w: it.w || 0 };
        }
    }
    return null;
}

const DECL_KIND = {
    'display-equation': 'equation',
    figure: 'figure',
    table: 'table',
    tabular: 'table',
    theorem: 'theorem',
    'section-heading': 'section',
};

/** What a chip of this kind should copy: \eqref, \cite or plain \ref. */
function commandFor(kind, role) {
    if (role === 'cite') return 'cite';
    return kind === 'equation' ? 'eqref' : 'ref';
}

/**
 * Every chip for one paper, in one pass over its model objects.
 *
 * @param {{
 *   objects: Array<object>,
 *   rowsFor: (file:string, line:number) => Array,
 *   boxFor: (obj:object) => {rects:Array}|null,
 *   printedFor?: (name:string) => {printed?:string, page?:number}|null,
 *   citeFor?: (key:string) => {printed?:string}|null,
 *   inkFor?: (page:number) => Array|null,
 *   declared?: Set<string>,
 *   file?: string,
 * }} deps
 * @returns {Array<object>} chips
 */
function buildLabelChips(deps) {
    const {
        objects = [], rowsFor, boxFor,
        printedFor = null, citeFor = null, inkFor = null,
        declared = null, file = '', pageWidth = 595.276,
    } = deps || {};
    if (typeof rowsFor !== 'function') return [];

    const chips = [];
    const seenDecl = new Set();
    let id = 0;
    const fileOf = (o) => (o.sourceRange && o.sourceRange.file) || file;
    const startOf = (o) => (o.sourceRange ? o.sourceRange.startLine : o.startLine);
    const endOf = (o) => (o.sourceRange ? o.sourceRange.endLine : o.endLine);

    // --- declarations ------------------------------------------------------
    //
    // Two shapes carry a label: an OBJECT that owns one (the common case — the
    // scanner attaches `\label` to the innermost numberable environment), and a
    // standalone `label` object, which is what a `\section{}\label{}` pair and
    // every macro-declared label leave behind. Objects first, so an equation's
    // chip is placed against the equation and not against the line its \label
    // happens to sit on.
    const owners = objects.filter(o => o.label && o.kind !== 'label');
    const standalone = objects.filter(o => o.kind === 'label' && o.name);

    for (const o of owners) {
        const name = o.label;
        if (seenDecl.has(name)) continue;           // a label is declared once
        seenDecl.add(name);
        const kind = DECL_KIND[o.kind] || 'other';
        const f = fileOf(o);
        const rows = rowsOver(rowsFor, f, startOf(o), endOf(o));
        const { keep, stray } = splitStrayRows(rows);
        let at = null;
        const side = 'right';                       // declarations own the right column
        let approx = false;
        let row = null;

        if (kind === 'equation') {
            // THE ROW THAT CARRIES THE NUMBER is the one a reader looks at for
            // "which equation is this" — and on an `align` there is one per
            // line, so each label stays level with its own.
            const tags = tagRows(rows, pageWidth);
            const tag = tags.length ? tags[tags.length - 1] : pickTagRow(stray);
            row = tag || firstRow(keep) || firstRow(rows);
            if (!tag) approx = true;
        } else if (kind === 'figure' || kind === 'table') {
            // The caption prints last, and a caption is where a reader looks
            // for "Figure 3".
            row = lastRow(keep) || lastRow(rows);
        } else {
            row = firstRow(keep) || firstRow(rows);
        }
        if (row) at = inColumn(row, side, blockOf(inkFor, row.page, pageWidth));

        if (!at && typeof boxFor === 'function') {
            // A float's `\includegraphics` line carries no character records at
            // all, so the object's own box is the only thing that knows where
            // the picture went.
            let box = null;
            try { box = boxFor(o); } catch (_) { box = null; }
            const rect = box && box.rects && box.rects[0];
            if (rect) {
                at = inColumn({ ...rect, page: rect.page }, side, blockOf(inkFor, rect.page, pageWidth));
                approx = true;
            }
        }
        if (!at) continue;                          // unmapped: no honest place

        const printed = printedFor ? (printedFor(name) || {}).printed || '' : '';
        chips.push({
            id: `d${id++}`, name, kind, role: 'decl',
            cmd: commandFor(kind, 'decl'),
            printed, at, side, approx,
            line: startOf(o), file: f,
            owner: o.stableKey || null,
        });
    }

    // A LABEL WITH NO INK OF ITS OWN — which is most of them in an `align`.
    //
    // MEASURED: 8 of the reference paper's 82 labels had no chip at all, and
    // every one was a `\label` on its own line inside an align. The scanner
    // writes `target.label = arg` for each, so only the LAST survives on the
    // object and the rest exist only as standalone label objects — whose own
    // line carries no records, because a `\label` prints nothing.
    //
    // The ink they belong to is the enclosing display's. An align prints one
    // number per numbered line, in source order, so the n-th label of a block
    // takes the n-th number: source order and print order are the same order.
    const containerOf = (o) => objects.find(x =>
        x.kind !== 'label' && x.sourceRange &&
        (!x.sourceRange.file || x.sourceRange.file === fileOf(o)) &&
        x.sourceRange.startLine <= startOf(o) && x.sourceRange.endLine >= endOf(o) &&
        DECL_KIND[x.kind]);

    const orphans = standalone.filter(o => !seenDecl.has(o.name));
    const byContainer = new Map();
    for (const o of orphans) {
        const c = containerOf(o);
        const key = c ? (c.stableKey || `${startOf(c)}-${endOf(c)}`) : `~${startOf(o)}`;
        if (!byContainer.has(key)) byContainer.set(key, { container: c, labels: [] });
        byContainer.get(key).labels.push(o);
    }

    for (const { container, labels } of byContainer.values()) {
        labels.sort((a, b) => startOf(a) - startOf(b));
        // Every label of this block, in source order — the object's own one
        // included, because it owns the LAST number and the orphans must not
        // be paired with it.
        const ownName = container && container.label;
        const rows = container
            ? rowsOver(rowsFor, fileOf(container), startOf(container), endOf(container))
            : [];
        const tags = tagRows(rows, pageWidth);
        const kind = container ? (DECL_KIND[container.kind] || 'other') : 'other';

        labels.forEach((o, i) => {
            const name = o.name;
            if (seenDecl.has(name)) return;
            seenDecl.add(name);
            const f = fileOf(o);
            const printed = printedFor ? (printedFor(name) || {}).printed || '' : '';
            let at = null;
            const side = 'right';                   // declarations own the right column
            let approx = true;

            // The n-th label takes the n-th number, with the object's own label
            // holding the last one — each stays level with ITS row, which is
            // what keeps an align's five names from stacking on one spot.
            const wanted = ownName && ownName !== name ? i : tags.length - 1;
            let row = null;
            if (tags.length && wanted >= 0 && wanted < tags.length) {
                row = tags[wanted];
                approx = tags.length !== labels.length + (ownName ? 1 : 0);
            } else {
                const own = rowsOver(rowsFor, f, startOf(o), endOf(o));
                row = firstRow(splitStrayRows(own).keep) || firstRow(own) ||
                    firstRow(splitStrayRows(rows).keep);
            }
            if (row) at = inColumn(row, side, blockOf(inkFor, row.page, pageWidth));
            if (!at) return;
            chips.push({
                id: `d${id++}`, name, kind, role: 'decl',
                cmd: commandFor(kind, 'decl'), printed, at, side,
                approx, line: startOf(o), file: f,
                owner: container ? container.stableKey || null : null,
            });
        });
    }

    // --- reference and citation sites --------------------------------------
    for (const o of objects) {
        if (o.kind !== 'ref' && o.kind !== 'cite') continue;
        const f = fileOf(o);
        const line = startOf(o);
        const rows = rowsOver(rowsFor, f, line, line);
        const { keep } = splitStrayRows(rows);
        const usable = keep.length ? keep : rows;
        if (!usable.length) continue;

        // `\cite{a,b,c}` is three references sharing one command.
        const targets = String(o.target || '').split(',')
            .map(t => t.trim()).filter(Boolean);
        if (!targets.length) continue;

        targets.forEach((name, i) => {
            const isCite = o.kind === 'cite';
            const printed = isCite
                ? (citeFor ? (citeFor(name) || {}).printed || '' : '')
                : (printedFor ? (printedFor(name) || {}).printed || '' : '');
            // A REFERENCE IS MARKED WHERE IT PRINTS AND NAMED IN THE MARGIN.
            //
            // The badge used to be moved on top of the printed number, which in
            // prose means on top of the line above it — the reported
            // obstruction. The number itself is underlined by the panel instead
            // (`find` below), and the name goes in the left column, level with
            // the row it was printed on: nothing is covered, and which line a
            // badge belongs to is still plain.
            let at = null;
            let approx = true;
            let row = null;
            if (!isCite) {
                const hit = findPrintedInk(inkFor, usable, printed);
                if (hit) { row = hit.row; approx = false; }
            }
            if (!row) row = lastRow(usable);
            if (row) at = inColumn(row, 'left', blockOf(inkFor, row.page, pageWidth));
            if (!at) return;
            const broken = !isCite && declared instanceof Set && !declared.has(name);
            chips.push({
                id: `r${id++}`, name,
                kind: isCite ? 'cite' : 'ref',
                role: isCite ? 'cite' : 'ref',
                cmd: isCite ? 'cite' : (o.cmd === 'eqref' ? 'eqref' : 'ref'),
                printed, at, side: 'left', approx, broken,
                // WHAT THE PANEL NEEDS TO PLACE THIS ITSELF.
                //
                // A reference prints its number INSIDE the prose, and that is
                // the only place its badge means anything — reported as "next
                // to (6) should be the badge, but it is miles away". The
                // extension's own copy of the text layer is a generation
                // behind whenever the sweep has not finished, so the search
                // is handed to the panel, which always has the real one.
                find: printed ? {
                    text: printed,
                    // `\eqref` prints its number in PARENTHESES; a bare digit
                    // on the same line is not this reference.
                    parens: !isCite && (o.cmd === 'eqref' || o.cmd === 'ref'),
                    rects: usable.map(r => ({
                        page: r.page, x: r.x, y: r.y, w: r.w, h: r.h,
                    })),
                } : null,
                line, file: f, owner: null,
            });
        });
    }

    return stackColumns(chips);
}

/**
 * What clicking a chip puts on the clipboard.
 *
 * The default is the READY-TO-PASTE form, because that is what the gesture is
 * for: a reader looking at equation (12) on the page wants
 * `\eqref{eq:inversion-transpose}` in their hand, not a name they then have to
 * wrap. Alt-click gives the bare name, which is what you want when the target
 * is a chat message or a note rather than the source.
 *
 * @param {string} name
 * @param {{kind?:string, role?:string, cmd?:string, format?:string}} o
 */
function formatLabelCopy(name, o = {}) {
    const n = String(name || '');
    if (!n) return '';
    const format = o.format || 'command';
    const isCite = o.role === 'cite' || o.kind === 'cite';
    if (format === 'bare') return n;
    if (isCite) return `\\cite{${n}}`;
    if (format === 'ref') return `\\ref{${n}}`;
    if (format === 'eqref') return `\\eqref{${n}}`;
    // 'command': what this reference would normally be written as.
    const cmd = o.cmd === 'eqref' || o.kind === 'equation' ? 'eqref' : 'ref';
    return `\\${cmd}{${n}}`;
}

/** The other of bare/command, for Alt-click. */
function altFormat(format) {
    return format === 'bare' ? 'command' : 'bare';
}

module.exports = {
    buildLabelChips, splitStrayRows, formatLabelCopy, altFormat,
    findPrintedInk, rowsOver, isTagRow, tagRows,
};
