// texGeometry.js — every coordinate conversion Wolfbook TeX needs, once.
//
// Pure: no vscode, no fs, never throws. Graduated from the Stage 0 spike
// (Experiments/wolfbook-tex/lib/geometry.mjs) with Spike C's two corrections
// already applied — see the comments on the rotation branches and on
// synctexBoxToRectSp, both of which were REAL DEFECTS found by refereeing this
// file against pdf.js and poppler.
//
// The methodological point is worth keeping in view: a round-trip test passed
// while the 90/270 map was mirrored, because a mirrored map is perfectly
// self-inverse. Self-consistency is not correctness. c-pdfjs/pdfjs-viewport.mjs
// is deliberately kept as an independent second implementation, and merging it
// in here would restore exactly the blind spot that missed the bug.

const SP_PER_PT = 65536;        // TeX scaled points per TeX point
const PT_PER_INCH = 72.27;      // TeX point
const BP_PER_INCH = 72;         // PostScript big point == PDF user unit
const BP_PER_PT = BP_PER_INCH / PT_PER_INCH;   // 0.99626401...
const SP_PER_BP = SP_PER_PT / BP_PER_PT;

const spToPt = (sp) => sp / SP_PER_PT;
const ptToSp = (pt) => pt * SP_PER_PT;
const ptToBp = (pt) => pt * BP_PER_PT;
const bpToPt = (bp) => bp / BP_PER_PT;
const spToBp = (sp) => spToPt(sp) * BP_PER_PT;
const bpToSp = (bp) => ptToSp(bpToPt(bp));
const mmToBp = (mm) => (mm / 25.4) * BP_PER_INCH;
const bpToMm = (bp) => (bp / BP_PER_INCH) * 25.4;

/**
 * A SyncTeX box record -> a rectangle in SyncTeX's own space (sp, origin at the
 * page's top-left, y increasing DOWNWARD).
 *
 * MEASURED, not reasoned (SQ_report.synctex, first vbox of page 1):
 *   h = 4736286 sp = 72.27 pt = exactly 1 inch from the left
 *   v = 52685371 sp, H = 47949085 sp  ->  v - H = 72.27 pt = exactly 1 inch
 * so `v` is the BASELINE, measured down from the page top; the box occupies
 * [v - H, v + D] vertically. Getting this backwards puts every box one
 * box-height too low, which reads as "SyncTeX is coarse" when it is not.
 */
function synctexBoxToRectSp(box) {
    const { type, h, v, W = 0, H = 0, D = 0 } = box;
    // KERN AND RULE RECORDS ARE ANCHORED AT THEIR RIGHT EDGE, not their left.
    // Measured by Spike C over 15 papers and 49 000 records: read as
    // left-anchored, 1 639 of 17 219 kern/rule records run off the page — by up
    // to 778 bp. Read as right-anchored, 142. Box records ([, (, h, v) are
    // left-anchored as you would expect; only these two are not.
    const rightAnchored = (type === 'kern' || type === 'rule') && W > 0;
    const yA = v - H;
    const yB = v + D;
    return {
        x: rightAnchored ? h - W : h,
        yTop: Math.min(yA, yB),
        w: Math.abs(W),
        h: Math.abs(yB - yA),
    };
}

/**
 * SyncTeX box -> PDF user space (bp, origin at the MediaBox's bottom-left,
 * y increasing UPWARD) — the space pdf.js's `viewport` consumes.
 *
 * `page` needs { widthBp, heightBp } and optionally { originXBp, originYBp }
 * for a MediaBox whose lower-left corner is not (0,0). A non-zero origin is
 * rare but real (\hoffset, papersize games, cropped PDFs) and silently shifts
 * everything, so it is a parameter rather than an assumption.
 */
function synctexBoxToPdfRect(box, page) {
    const r = synctexBoxToRectSp(box);
    const ox = page.originXBp || 0;
    const oy = page.originYBp || 0;
    const x = ox + spToBp(r.x);
    const w = spToBp(r.w);
    const h = spToBp(r.h);
    const yTopFromPageTop = spToBp(r.yTop);
    // flip: distance from the page BOTTOM to the rect's bottom edge
    const y = oy + page.heightBp - yTopFromPageTop - h;
    return { x, y, w, h };
}

/**
 * PDF user-space point -> pdf.js viewport point (CSS px, origin top-left).
 * Mirrors pdf.js `PageViewport` (src/display/display_utils.js).
 *
 * THE 90/270 BRANCHES WERE WRONG HERE, and how that survived is the point.
 * The original pair rotated WITHOUT the y-flip, producing a map with positive
 * determinant where rotations 0 and 180 correctly have negative — a mirror
 * image, not an offset. Spike C caught it against two external referees: it was
 * **683 bp** out at both 90° and 270° when matched word-by-word against
 * poppler's own rotated output, while a faithful transcription of pdf.js's
 * formulas was 0.000.
 *
 * A ROUND-TRIP TEST CANNOT FIND THIS. The buggy branches are perfectly
 * self-inverse — lib/check-lib.mjs asserted the round trip over 4 rotations x
 * 3 scales and passed, giving false confidence in a mirrored map. Self
 * consistency is not correctness; a coordinate library needs an external
 * referee. (check-lib.mjs now checks handedness too.)
 *
 * `page` may carry either {widthBp, heightBp, originXBp, originYBp} or a
 * `viewBox` [x0,y0,x1,y1]. Prefer viewBox: pdf.js measures from the CropBox
 * intersected with the MediaBox, NOT the MediaBox, and on a cropped file the
 * two differ — Spike C measured the same word 70.71 bp apart between poppler's
 * frame and pdf.js's on a CropBox-inset variant.
 */
function boxOf(page) {
    if (page.viewBox) return page.viewBox;
    const x0 = page.originXBp || 0;
    const y0 = page.originYBp || 0;
    return [x0, y0, x0 + page.widthBp, y0 + page.heightBp];
}

const normRot = (r) => (((Math.round(r / 90) * 90) % 360) + 360) % 360;

function pdfToViewportPoint(x, y, page, scale = 1, rotation = 0) {
    const [x0, y0, x1, y1] = boxOf(page);
    switch (normRot(rotation)) {
        case 90: return [scale * (y - y0), scale * (x - x0)];
        case 180: return [scale * (x1 - x), scale * (y - y0)];
        case 270: return [scale * (y1 - y), scale * (x1 - x)];
        default: return [scale * (x - x0), scale * (y1 - y)];
    }
}

function viewportToPdfPoint(vx, vy, page, scale = 1, rotation = 0) {
    const [x0, y0, x1, y1] = boxOf(page);
    switch (normRot(rotation)) {
        case 90: return [x0 + vy / scale, y0 + vx / scale];
        case 180: return [x1 - vx / scale, y0 + vy / scale];
        case 270: return [x1 - vy / scale, y1 - vx / scale];
        default: return [x0 + vx / scale, y1 - vy / scale];
    }
}

/** Viewport canvas size in CSS px — width and height SWAP at 90/270. */
function viewportSize(page, scale = 1, rotation = 0) {
    const [x0, y0, x1, y1] = boxOf(page);
    const w = (x1 - x0) * scale;
    const h = (y1 - y0) * scale;
    const r = normRot(rotation);
    return (r === 90 || r === 270) ? [h, w] : [w, h];
}

/**
 * A PDF-space rect -> a viewport rect. BOTH corners must be mapped and then
 * re-normalised: at 90/270 the mapping swaps the axes, so scaling w and h
 * directly transposes the box and the highlight comes out lying on its side.
 */
function pdfRectToViewport(r, page, scale = 1, rotation = 0) {
    const a = pdfToViewportPoint(r.x, r.y, page, scale, rotation);
    const b = pdfToViewportPoint(r.x + r.w, r.y + r.h, page, scale, rotation);
    return {
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
        w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]),
    };
}

// --- rectangle algebra -----------------------------------------------------
// Rects are {x, y, w, h}. The caller owns which space they are in; mixing
// spaces is the caller's bug, not something this module can catch.

function rectArea(r) { return Math.max(0, r.w) * Math.max(0, r.h); }

function rectIntersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 <= x || y2 <= y) return null;
    return { x, y, w: x2 - x, h: y2 - y };
}

function iou(a, b) {
    if (!a || !b) return 0;
    const i = rectIntersect(a, b);
    if (!i) return 0;
    const inter = rectArea(i);
    const union = rectArea(a) + rectArea(b) - inter;
    return union > 0 ? inter / union : 0;
}

function rectUnion(rects) {
    const rs = rects.filter(Boolean);
    if (!rs.length) return null;
    const x = Math.min(...rs.map(r => r.x));
    const y = Math.min(...rs.map(r => r.y));
    const x2 = Math.max(...rs.map(r => r.x + r.w));
    const y2 = Math.max(...rs.map(r => r.y + r.h));
    return { x, y, w: x2 - x, h: y2 - y };
}

/** Fraction of `a` that lies inside `b` — the T2 "coarse" test's workhorse. */
function containment(a, b) {
    const i = rectIntersect(a, b);
    return i && rectArea(a) > 0 ? rectArea(i) / rectArea(a) : 0;
}

/** Vertical overlap of two rects as a fraction of `a`'s height. */
function verticalOverlap(a, b) {
    const top = Math.max(a.y, b.y);
    const bot = Math.min(a.y + a.h, b.y + b.h);
    return a.h > 0 ? Math.max(0, bot - top) / a.h : 0;
}

function inflate(r, by) {
    return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

module.exports = {
    SP_PER_PT,
    PT_PER_INCH,
    BP_PER_INCH,
    BP_PER_PT,
    SP_PER_BP,
    spToPt,
    ptToSp,
    ptToBp,
    bpToPt,
    spToBp,
    bpToSp,
    mmToBp,
    bpToMm,
    synctexBoxToRectSp,
    synctexBoxToPdfRect,
    pdfToViewportPoint,
    viewportToPdfPoint,
    viewportSize,
    pdfRectToViewport,
    rectArea,
    rectIntersect,
    iou,
    rectUnion,
    containment,
    verticalOverlap,
    inflate,
};
