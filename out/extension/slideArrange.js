'use strict';
/**
 * Pure host-side geometry for the `wolfslide_arrange` MCP tool — align & distribute.
 *
 * Mirrors the webview WSLIDE_VERBS align/distribute (media/wslide-editor.html) but runs on
 * the deck JSON host-side (no DOM). Items are `{ id, x, y, w, h }` in model px on the
 * 1920×1080 canvas; align/distribute mutate x/y IN PLACE and return
 * `{ changed:[id…], changelog:[…], error? }`. No `vscode` dependency → unit-testable
 * (test/wslide/arrange-unit.js).
 */
const CW = 1920, CH = 1080;
const round = Math.round;
const ALIGN_EDGES = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'];

function bbox(items) {
  const L = Math.min(...items.map(i => i.x)), R = Math.max(...items.map(i => i.x + i.w));
  const T = Math.min(...items.map(i => i.y)), B = Math.max(...items.map(i => i.y + i.h));
  return { L, R, T, B, cx: (L + R) / 2, cy: (T + B) / 2 };
}

/**
 * align(items, {edge, relativeTo}) — edge ∈ ALIGN_EDGES. Reference is the selection's
 * bounding box, or the 1920×1080 canvas when relativeTo === 'slide'. Mutates x/y.
 */
function align(items, opts = {}) {
  const edge = opts.edge;
  if (ALIGN_EDGES.indexOf(edge) < 0) return { changed: [], changelog: [], error: `align must be one of: ${ALIGN_EDGES.join(', ')}` };
  if (!items.length) return { changed: [], changelog: [] };
  const toSlide = opts.relativeTo === 'slide';
  const ref = toSlide ? { L: 0, R: CW, T: 0, B: CH, cx: CW / 2, cy: CH / 2 } : bbox(items);
  const before = items.map(i => ({ x: i.x, y: i.y }));
  items.forEach(it => {
    switch (edge) {
      case 'left':    it.x = round(ref.L); break;
      case 'right':   it.x = round(ref.R - it.w); break;
      case 'hcenter': it.x = round(ref.cx - it.w / 2); break;
      case 'top':     it.y = round(ref.T); break;
      case 'bottom':  it.y = round(ref.B - it.h); break;
      case 'vcenter': it.y = round(ref.cy - it.h / 2); break;
    }
  });
  const changed = items.filter((it, i) => round(it.x) !== round(before[i].x) || round(it.y) !== round(before[i].y)).map(it => it.id);
  const label = { left: 'left edges', right: 'right edges', hcenter: 'horizontal centres', top: 'top edges', bottom: 'bottom edges', vcenter: 'vertical centres' }[edge];
  return { changed, changelog: [`Aligned ${items.length} block(s) → ${label} (relative to ${toSlide ? 'slide' : 'selection'})`] };
}

/**
 * distribute(items, {axis}) — axis: 'horizontal'|'h' or 'vertical'|'v'. Spaces the blocks'
 * centres evenly along the axis; first & last stay put. Needs 3+ blocks. Mutates x/y.
 */
function distribute(items, opts = {}) {
  const ax = (opts.axis === 'v' || opts.axis === 'vertical') ? 'v'
    : (opts.axis === 'h' || opts.axis === 'horizontal') ? 'h' : null;
  if (!ax) return { changed: [], changelog: [], error: 'distribute must be "horizontal" or "vertical"' };
  if (items.length < 3) return { changed: [], changelog: [], error: `distribute needs 3+ blocks (got ${items.length})` };
  const key = ax === 'h' ? 'x' : 'y', sz = ax === 'h' ? 'w' : 'h';
  const before = items.map(i => ({ x: i.x, y: i.y }));
  const cen = it => it[key] + it[sz] / 2;
  const order = items.slice().sort((a, b) => cen(a) - cen(b));
  const first = cen(order[0]), step = (cen(order[order.length - 1]) - first) / (order.length - 1);
  order.forEach((it, i) => { if (i === 0 || i === order.length - 1) return; it[key] = round(first + step * i - it[sz] / 2); });
  const changed = items.filter((it, i) => round(it.x) !== round(before[i].x) || round(it.y) !== round(before[i].y)).map(it => it.id);
  return { changed, changelog: [`Distributed ${items.length} blocks evenly · ${ax === 'h' ? 'horizontal' : 'vertical'}`] };
}

module.exports = { align, distribute, bbox, ALIGN_EDGES };
