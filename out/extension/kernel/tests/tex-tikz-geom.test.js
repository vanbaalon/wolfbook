const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.resolve(__dirname, '../../../client/tikz-geom.mjs')).href);
const R = (id, left, top, w, h) => ({ id, left, top, w, h });

test('snapping follows wslide: the nearest edge or centre within the threshold', async () => {
    const g = await load();
    // The same cases as wslide's snap-unit test (threshold 8, canvas targets).
    const xs = [0, 960, 1920], ys = [0, 540, 1080];
    assert.deepEqual(g.computeSnap(R(0, 5, 300, 100, 50), xs, ys, 8), { adjX: -5, adjY: 0, guidesX: [0], guidesY: [] });
    assert.deepEqual(g.computeSnap(R(0, 908, 300, 100, 50), xs, ys, 8).adjX, 2);
    assert.deepEqual(g.computeSnap(R(0, 400, 300, 100, 50), xs, ys, 8), { adjX: 0, adjY: 0, guidesX: [], guidesY: [] });
    const t = g.snapTargets([R('a', 100, 100, 20, 20)], { x: [0], y: [0] });
    assert.deepEqual(t, { x: [0, 100, 110, 120], y: [0, 100, 110, 120] });
});

test('align to the first, last, biggest, the selection or the picture; the anchor object stays', async () => {
    const g = await load();
    const rects = [R('a', 10, 10, 20, 20), R('b', 50, 40, 40, 10), R('c', 100, 0, 10, 60)];
    assert.deepEqual(g.align(rects, 'l'), [{ id: 'b', dx: -40, dy: 0 }, { id: 'c', dx: -90, dy: 0 }]);
    assert.deepEqual(g.align(rects, 'vc', { relative: 'last' }), [{ id: 'a', dx: 0, dy: 10 }, { id: 'b', dx: 0, dy: -15 }]);
    assert.deepEqual(g.align(rects, 'r', { relative: 'biggest' }).map(d => d.id), ['a', 'b']);
    assert.deepEqual(g.align(rects, 't', { relative: 'selection' }), [{ id: 'a', dx: 0, dy: -10 }, { id: 'b', dx: 0, dy: -40 }, { id: 'c', dx: 0, dy: 0 }]);
    assert.deepEqual(g.align([R('a', 10, 10, 20, 20)], 'hc', { picture: R('p', 0, 0, 100, 100) }), [{ id: 'a', dx: 30, dy: 0 }]);
    assert.deepEqual(g.align(rects, 'r_outR'), [{ id: 'b', dx: -20, dy: 0 }, { id: 'c', dx: -70, dy: 0 }]);
    // As a group: one delta for all, from the selection's box.
    assert.deepEqual(g.align(rects, 'l', { picture: R('p', 0, 0, 200, 100), relative: 'picture', asGroup: true }).map(d => d.dx), [-10, -10, -10]);
});

test('distribute centres, edges and gaps; the ends stay', async () => {
    const g = await load();
    const rects = [R('a', 0, 0, 10, 10), R('b', 15, 0, 10, 10), R('c', 100, 0, 30, 10)];
    assert.deepEqual(g.distribute(rects, 'h_center'), [{ id: 'b', dx: 40, dy: 0 }]);
    assert.deepEqual(g.distribute(rects, 'h_left'), [{ id: 'b', dx: 35, dy: 0 }]);
    assert.deepEqual(g.distribute(rects, 'h_gap'), [{ id: 'b', dx: 35, dy: 0 }]);
    assert.deepEqual(g.distribute(rects.slice(0, 2), 'h_gap'), [], 'needs three');
    const col = [R('a', 0, 0, 10, 10), R('b', 0, 12, 10, 10), R('c', 0, 60, 10, 10)];
    assert.deepEqual(g.distribute(col, 'v_center'), [{ id: 'b', dx: 0, dy: 18 }]);
});

test('equal-spacing guides snap to a gap that already exists in the row', async () => {
    const g = await load();
    const others = [R('a', 0, 0, 20, 20), R('b', 50, 0, 20, 20)]; // gap 30
    const moving = R('m', 97, 2, 20, 16);                            // gap to b would be 27
    const s = g.spacingSnap(moving, others, 5);
    assert.equal(s.adjX, 3);
    assert.deepEqual(s.marks.map(m => [m.from, m.to]), [[20, 50], [70, 100]]);
    assert.equal(g.spacingSnap(R('m', 140, 2, 20, 16), others, 5).adjX, 0, 'too far: no snap');
    assert.match(g.arrIcon(g.ARR_ICONS.l_outL), /^<svg[\s\S]*#6366f1[\s\S]*<line/);
});
