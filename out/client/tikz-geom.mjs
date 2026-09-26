// GEOMETRY OF THE TIKZ PICTURE EDITOR: align, distribute, smart guides.
//
// Ported from wslide's Arrange panel and smart guides (media/wslide-editor.html:
// computeSnap, _alignDelta, distributeBlocks, ARR_ICONS), whose modes follow
// Inkscape's Align & Distribute dialog. Rects are CSS px on the page, y DOWN,
// `{id, left, top, w, h}`; results are deltas in the same px, which the viewer
// converts to the picture's units. PURE: importable from Node for tests.

/** Bounding box of rects: `{L, R, T, B, cx, cy, w, h}`. */
export function bbox(rects) {
    const L = Math.min(...rects.map(r => r.left)), R = Math.max(...rects.map(r => r.left + r.w));
    const T = Math.min(...rects.map(r => r.top)), B = Math.max(...rects.map(r => r.top + r.h));
    return { L, R, T, B, cx: (L + R) / 2, cy: (T + B) / 2, w: R - L, h: B - T };
}

const box = r => ({ L: r.left, R: r.left + r.w, T: r.top, B: r.top + r.h, cx: r.left + r.w / 2, cy: r.top + r.h / 2 });

/**
 * The reference of an Align: `first | last | biggest | smallest | picture |
 * selection` (wslide's "Relative to"). `rects` are in selection order;
 * `picture` is the picture's box. A single object aligns to the picture.
 * Returns `{L, R, T, B, cx, cy, refId?}` — `refId` when an object is the
 * anchor, which then never moves.
 */
export function anchorOf(rects, mode, picture) {
    if (rects.length < 2 || mode === 'picture') return picture ? box(picture) : bbox(rects);
    if (mode === 'selection') return bbox(rects);
    const area = r => r.w * r.h;
    const ref = mode === 'last' ? rects[rects.length - 1]
        : mode === 'biggest' ? rects.reduce((a, b) => (area(b) > area(a) ? b : a))
        : mode === 'smallest' ? rects.reduce((a, b) => (area(b) < area(a) ? b : a))
        : rects[0];
    return { ...box(ref), refId: ref.id };
}

/** Delta moving rect `r` to align with anchor `a` under `mode` (wslide `_alignDelta`). */
export function alignDelta(r, a, mode) {
    let dx = 0, dy = 0;
    switch (mode) {
    case 'l': dx = a.L - r.left; break;
    case 'hc': dx = a.cx - (r.left + r.w / 2); break;
    case 'r': dx = a.R - (r.left + r.w); break;
    case 'l_outL': dx = a.L - (r.left + r.w); break;
    case 'r_outR': dx = a.R - r.left; break;
    case 't': dy = a.T - r.top; break;
    case 'vc': dy = a.cy - (r.top + r.h / 2); break;
    case 'b': dy = a.B - (r.top + r.h); break;
    case 't_outT': dy = a.T - (r.top + r.h); break;
    case 'b_outB': dy = a.B - r.top; break;
    default: break;
    }
    return [dx, dy];
}

/**
 * Align: `[{id, dx, dy}]` for every rect that moves. `asGroup` moves the
 * whole selection by one delta, computed from its bounding box.
 */
export function align(rects, mode, { relative = 'first', picture = null, asGroup = false } = {}) {
    if (!rects.length) return [];
    const a = anchorOf(rects, relative, picture);
    if (asGroup && rects.length > 1) {
        const b = bbox(rects);
        const [dx, dy] = alignDelta({ left: b.L, top: b.T, w: b.w, h: b.h }, a, mode);
        return rects.map(r => ({ id: r.id, dx, dy }));
    }
    return rects.filter(r => !(a.refId != null && r.id === a.refId))
        .map(r => { const [dx, dy] = alignDelta(r, a, mode); return { id: r.id, dx, dy }; });
}

/**
 * Distribute (3+ rects): `h_left|h_center|h_right|h_gap`, `v_top|v_center|
 * v_bottom|v_gap`. The first and last stay; `gap` equalises the gaps between
 * objects, the others space edges or centres evenly (wslide `distributeBlocks`).
 */
export function distribute(rects, mode) {
    if (rects.length < 3) return [];
    const horiz = mode[0] === 'h';
    const key = horiz ? 'left' : 'top', sz = horiz ? 'w' : 'h';
    const out = [];
    const mv = (r, d) => out.push({ id: r.id, dx: horiz ? d : 0, dy: horiz ? 0 : d });
    const list = [...rects];
    if (mode.endsWith('gap')) {
        list.sort((x, y) => x[key] - y[key]);
        const last = list[list.length - 1];
        const span = last[key] + last[sz] - list[0][key];
        const used = list.reduce((s, r) => s + r[sz], 0);
        const gap = (span - used) / (list.length - 1);
        let cursor = list[0][key] + list[0][sz] + gap;
        for (let i = 1; i < list.length - 1; i++) { mv(list[i], cursor - list[i][key]); cursor += list[i][sz] + gap; }
    } else {
        const frac = /left|top/.test(mode) ? 0 : mode.endsWith('center') ? 0.5 : 1;
        const pos = r => r[key] + r[sz] * frac;
        list.sort((x, y) => pos(x) - pos(y));
        const first = pos(list[0]), step = (pos(list[list.length - 1]) - first) / (list.length - 1);
        list.forEach((r, i) => { if (i > 0 && i < list.length - 1) mv(r, first + step * i - pos(r)); });
    }
    return out.filter(d => Math.abs(d.dx) > 1e-9 || Math.abs(d.dy) > 1e-9);
}

/**
 * Smart-guide snap (wslide `computeSnap`): the nearest of the rect's edges and
 * centre to a target within `threshold`, per axis. Returns
 * `{adjX, adjY, guidesX, guidesY}`.
 */
export function computeSnap(rect, xTargets, yTargets, threshold) {
    const edgesX = [rect.left, rect.left + rect.w / 2, rect.left + rect.w];
    const edgesY = [rect.top, rect.top + rect.h / 2, rect.top + rect.h];
    const best = (edges, targets) => {
        let b = { adj: 0, guide: null, d: Infinity };
        for (const e of edges) for (const t of targets) {
            const d = t - e;
            if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(b.d)) b = { adj: d, guide: t, d };
        }
        return b;
    };
    const bx = best(edgesX, xTargets), by = best(edgesY, yTargets);
    return { adjX: bx.guide != null ? bx.adj : 0, adjY: by.guide != null ? by.adj : 0,
        guidesX: bx.guide != null ? [bx.guide] : [], guidesY: by.guide != null ? [by.guide] : [] };
}

/** Snap targets from other objects' edges and centres, plus extra lines (the picture's axes). */
export function snapTargets(others, extra = { x: [], y: [] }) {
    const x = [...(extra.x || [])], y = [...(extra.y || [])];
    for (const r of others) { x.push(r.left, r.left + r.w / 2, r.left + r.w); y.push(r.top, r.top + r.h / 2, r.top + r.h); }
    return { x, y };
}

/**
 * Equal-spacing guides (beyond wslide): when the dragged rect's gap to a
 * neighbour in its row (or column) nearly equals a gap that already exists
 * between two other objects there, snap to it. Returns
 * `{adjX, adjY, marks: [{axis, from, to, at}]}` — `marks` are the equal gaps to
 * draw (the existing one and the new one).
 */
export function spacingSnap(rect, others, threshold) {
    const result = { adjX: 0, adjY: 0, marks: [] };
    for (const axis of ['x', 'y']) {
        const [lo, size, clo, csize] = axis === 'x' ? ['left', 'w', 'top', 'h'] : ['top', 'h', 'left', 'w'];
        const overlaps = r => r[clo] < rect[clo] + rect[csize] && rect[clo] < r[clo] + r[csize];
        const row = others.filter(overlaps).sort((a, b) => a[lo] - b[lo]);
        const gaps = [];
        for (let i = 1; i < row.length; i++) {
            const g = row[i][lo] - (row[i - 1][lo] + row[i - 1][size]);
            if (g > 0) gaps.push({ g, from: row[i - 1][lo] + row[i - 1][size], to: row[i][lo] });
        }
        let best = null;
        for (const n of row) {
            for (const gap of gaps) {
                // To the right of (below) n, or to the left of (above) it.
                for (const target of [n[lo] + n[size] + gap.g, n[lo] - gap.g - rect[size]]) {
                    const d = target - rect[lo];
                    if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) {
                        const after = target > n[lo];
                        best = { d, gap, mark: after ? { from: n[lo] + n[size], to: target } : { from: target + rect[size], to: n[lo] } };
                    }
                }
            }
        }
        if (best) {
            if (axis === 'x') result.adjX = best.d; else result.adjY = best.d;
            const at = axis === 'x' ? rect.top + rect.h / 2 : rect.left + rect.w / 2;
            result.marks.push({ axis, from: best.gap.from, to: best.gap.to, at }, { axis, from: best.mark.from, to: best.mark.to, at });
        }
    }
    return result;
}

/** wslide's Arrange icons: 24×24 specs of grey bars, the anchor, red guides and ticks. */
export const ARR_ICONS = {
    l_outL: { bars: [[2, 4, 13, 4], [7, 10, 8, 4], [4, 16, 11, 4]], guides: [[15, 2, 15, 22]], anchor: [16, 4, 5, 16] },
    l: { bars: [[4, 4, 13, 4], [4, 10, 8, 4], [4, 16, 11, 4]], guides: [[4, 2, 4, 22]] },
    hc: { bars: [[5.5, 4, 13, 4], [8, 10, 8, 4], [6.5, 16, 11, 4]], guides: [[12, 2, 12, 22]] },
    r: { bars: [[7, 4, 13, 4], [12, 10, 8, 4], [9, 16, 11, 4]], guides: [[20, 2, 20, 22]] },
    r_outR: { bars: [[9, 4, 13, 4], [9, 10, 8, 4], [9, 16, 11, 4]], guides: [[9, 2, 9, 22]], anchor: [3, 4, 5, 16] },
    t_outT: { bars: [[4, 2, 4, 13], [10, 7, 4, 8], [16, 4, 4, 11]], guides: [[2, 15, 22, 15]], anchor: [4, 16, 16, 5] },
    t: { bars: [[4, 4, 4, 13], [10, 4, 4, 8], [16, 4, 4, 11]], guides: [[2, 4, 22, 4]] },
    vc: { bars: [[4, 5.5, 4, 13], [10, 8, 4, 8], [16, 6.5, 4, 11]], guides: [[2, 12, 22, 12]] },
    b: { bars: [[4, 7, 4, 13], [10, 12, 4, 8], [16, 9, 4, 11]], guides: [[2, 20, 22, 20]] },
    b_outB: { bars: [[4, 9, 4, 13], [10, 9, 4, 8], [16, 9, 4, 11]], guides: [[2, 9, 22, 9]], anchor: [4, 3, 16, 5] },
    h_left: { bars: [[3, 5, 4, 14], [10, 5, 4, 14], [18, 5, 4, 14]], reds: [[3, 20, 1.5, 3], [10, 20, 1.5, 3], [18, 20, 1.5, 3]] },
    h_center: { bars: [[3, 5, 4, 14], [10, 5, 4, 14], [18, 5, 4, 14]], reds: [[4.25, 20, 1.5, 3], [11.25, 20, 1.5, 3], [19.25, 20, 1.5, 3]] },
    h_right: { bars: [[3, 5, 4, 14], [10, 5, 4, 14], [18, 5, 4, 14]], reds: [[5.5, 20, 1.5, 3], [12.5, 20, 1.5, 3], [20.5, 20, 1.5, 3]] },
    h_gap: { bars: [[2, 5, 4, 14], [10, 5, 4, 14], [18, 5, 4, 14]], reds: [[6, 11, 4, 2], [14, 11, 4, 2]] },
    v_top: { bars: [[5, 3, 14, 4], [5, 10, 14, 4], [5, 18, 14, 4]], reds: [[2, 3, 3, 1.5], [2, 10, 3, 1.5], [2, 18, 3, 1.5]] },
    v_center: { bars: [[5, 3, 14, 4], [5, 10, 14, 4], [5, 18, 14, 4]], reds: [[2, 4.25, 3, 1.5], [2, 11.25, 3, 1.5], [2, 19.25, 3, 1.5]] },
    v_bottom: { bars: [[5, 3, 14, 4], [5, 10, 14, 4], [5, 18, 14, 4]], reds: [[2, 5.5, 3, 1.5], [2, 12.5, 3, 1.5], [2, 20.5, 3, 1.5]] },
    v_gap: { bars: [[5, 2, 14, 4], [5, 10, 14, 4], [5, 18, 14, 4]], reds: [[11, 6, 2, 4], [11, 14, 2, 4]] },
};

/** Tooltips of the Arrange buttons (wslide's wording). */
export const ARR_GROUPS = [
    ['align', [['l_outL', 'Align right edges to the left edge of the anchor'], ['l', 'Align left edges'],
        ['hc', 'Centre on vertical axis'], ['r', 'Align right edges'], ['r_outR', 'Align left edges to the right edge of the anchor']]],
    ['align', [['t_outT', 'Align bottom edges to the top edge of the anchor'], ['t', 'Align top edges'],
        ['vc', 'Centre on horizontal axis'], ['b', 'Align bottom edges'], ['b_outB', 'Align top edges to the bottom edge of the anchor']]],
    ['distribute', [['h_left', 'Make left edges equidistant'], ['h_center', 'Make centres equidistant (horizontal)'],
        ['h_right', 'Make right edges equidistant'], ['h_gap', 'Make horizontal gaps equal']]],
    ['distribute', [['v_top', 'Make top edges equidistant'], ['v_center', 'Make centres equidistant (vertical)'],
        ['v_bottom', 'Make bottom edges equidistant'], ['v_gap', 'Make vertical gaps equal']]],
];

/** An Arrange icon as SVG markup (wslide `_arrIcon`), colours from the theme. */
export function arrIcon(spec) {
    let o = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">';
    if (spec.anchor) o += `<rect x="${spec.anchor[0]}" y="${spec.anchor[1]}" width="${spec.anchor[2]}" height="${spec.anchor[3]}" rx="1" fill="#6366f1"/>`;
    for (const b of spec.bars || []) o += `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" rx="1" fill="currentColor" fill-opacity=".55"/>`;
    for (const r of spec.reds || []) o += `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="#e11d48"/>`;
    for (const g of spec.guides || []) o += `<line x1="${g[0]}" y1="${g[1]}" x2="${g[2]}" y2="${g[3]}" stroke="#e11d48" stroke-width="1.4"/>`;
    return `${o}</svg>`;
}
