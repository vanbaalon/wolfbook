// The Page-mode viewer's coordinate map.
//
//   node out/extension/kernel/tests/tex-viewer-geom.test.js
//
// Tests the EXACT module the webview runs (out/client/tex-viewer-geom.mjs),
// imported here through dynamic import.
//
// It is compared against an INDEPENDENT reference — a transcription of pdf.js's
// own PageViewport closed forms, which Spike C verified bit-identical against
// the live library in a real browser. That is deliberate: Spike C found the
// extension's rotation branches mirrored (683 bp out against poppler) while a
// round-trip test passed, because a mirrored map is perfectly self-inverse.
// Self-consistency is not correctness.

const assert = require('assert');

let pass = 0; let fail = 0;
const results = [];
const test = (name, fn) => Promise.resolve().then(fn)
    .then(() => { pass++; results.push('  ok   ' + name); })
    .catch((e) => { fail++; results.push('  FAIL ' + name + '\n         ' + String(e && e.message || e).replace(/\n/g, '\n         ')); });

/**
 * A stand-in for pdf.js's PageViewport, built from its closed forms
 * (src/display/display_utils.js), verified against the live library by
 * Experiments/wolfbook-tex/c-pdfjs. This is the referee, not a copy of the
 * code under test.
 */
function makeViewport(view, scale = 1, rotation = 0) {
    const [x0, y0, x1, y1] = view;
    const rot = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    const w = (x1 - x0) * scale;
    const h = (y1 - y0) * scale;
    return {
        width: (rot === 90 || rot === 270) ? h : w,
        height: (rot === 90 || rot === 270) ? w : h,
        convertToViewportPoint(x, y) {
            switch (rot) {
                case 90: return [scale * (y - y0), scale * (x - x0)];
                case 180: return [scale * (x1 - x), scale * (y - y0)];
                case 270: return [scale * (y1 - y), scale * (x1 - x)];
                default: return [scale * (x - x0), scale * (y1 - y)];
            }
        },
        convertToPdfPoint(vx, vy) {
            switch (rot) {
                case 90: return [x0 + vy / scale, y0 + vx / scale];
                case 180: return [x1 - vx / scale, y0 + vy / scale];
                case 270: return [x1 - vy / scale, y1 - vx / scale];
                default: return [x0 + vx / scale, y1 - vy / scale];
            }
        },
    };
}

const A4 = [0, 0, 595.276, 841.89];
const CROPPED = [50, 40, 545.276, 791.89];      // CropBox inset by 50,40
const SHIFTED = [-30, -20, 565.276, 821.89];    // MediaBox origin off zero
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m || ''} expected ${b}, got ${a}`);

async function main() {
    const G = await import('../../../client/tex-viewer-geom.mjs');

    await test('the module the webview runs is importable outside a browser', () => {
        for (const f of ['bpToPdf', 'pdfToBp', 'bpToViewport', 'viewportToBp', 'bpRectToViewport']) {
            assert.strictEqual(typeof G[f], 'function', `${f} is exported`);
        }
    });

    await test('the top-left of the page box is the origin of the extension frame', () => {
        // RenderMap hands out y measured DOWN from the page top; the viewer
        // must put (0,0) at the top-left corner of page.view, not at the
        // PDF origin, which is the bottom-left.
        const vp = makeViewport(A4, 1, 0);
        const o = G.bpToViewport(A4, vp, 0, 0);
        near(o.x, 0, 1e-9); near(o.y, 0, 1e-9);
        const bl = G.bpToViewport(A4, vp, 0, 841.89);
        near(bl.y, 841.89, 1e-9, 'the page bottom is at viewport height');
    });

    await test('round trip is exact at every scale and rotation', () => {
        for (const view of [A4, CROPPED, SHIFTED]) {
            for (const scale of [1, 1.25, 2, 4]) {
                for (const rot of [0, 90, 180, 270]) {
                    const vp = makeViewport(view, scale, rot);
                    for (const [x, y] of [[0, 0], [72, 700], [300.5, 123.25], [495, 751]]) {
                        const v = G.bpToViewport(view, vp, x, y);
                        const back = G.viewportToBp(view, vp, v.x, v.y);
                        near(back.xBp, x, 1e-9, `x view=${view[0]} s=${scale} r=${rot}`);
                        near(back.yTopBp, y, 1e-9, `y view=${view[0]} s=${scale} r=${rot}`);
                    }
                }
            }
        }
    });

    await test('the map is HANDED — y flips at every rotation', () => {
        // The invariant a round trip cannot see. A mirrored map is perfectly
        // self-inverse, which is exactly how the extension shipped a 683 bp
        // error at 90 and 270 before Spike C refereed it.
        for (const rot of [0, 90, 180, 270]) {
            const vp = makeViewport(A4, 1, rot);
            const o = G.bpToViewport(A4, vp, 0, 0);
            const ex = G.bpToViewport(A4, vp, 1, 0);
            const ey = G.bpToViewport(A4, vp, 0, 1);
            const det = (ex.x - o.x) * (ey.y - o.y) - (ex.y - o.y) * (ey.x - o.x);
            assert.ok(det > 0,
                `rotation ${rot}: determinant ${det} — extension frame and viewport are BOTH y-down, ` +
                'so the composition must preserve orientation');
        }
    });

    await test('scale is linear and the origin does not drift', () => {
        for (const s of [1, 1.25, 2, 4]) {
            const vp = makeViewport(A4, s, 0);
            const p = G.bpToViewport(A4, vp, 100, 200);
            near(p.x, 100 * s, 1e-9, `x at scale ${s}`);
            near(p.y, 200 * s, 1e-9, `y at scale ${s}`);
        }
    });

    await test('a CROPPED page measures from the CropBox, not the MediaBox', () => {
        // pdf.js measures from page.view; poppler ignores CropBox entirely.
        // Spike C measured the same word 70.71 bp apart between the two frames.
        const vp = makeViewport(CROPPED, 1, 0);
        const o = G.bpToViewport(CROPPED, vp, 0, 0);
        near(o.x, 0, 1e-9, 'the CropBox corner is the viewport origin');
        near(o.y, 0, 1e-9);
        // and the same bp offset lands in a different PDF place than on A4
        const [px] = G.bpToPdf(CROPPED, 10, 10);
        const [qx] = G.bpToPdf(A4, 10, 10);
        near(px - qx, 50, 1e-9, 'exactly the crop offset');
    });

    await test('a non-zero MediaBox origin shifts the frame and does not vanish', () => {
        const [px, py] = G.bpToPdf(SHIFTED, 0, 0);
        near(px, -30, 1e-9);
        near(py, 821.89, 1e-9);
        const back = G.pdfToBp(SHIFTED, px, py);
        near(back.xBp, 0, 1e-9); near(back.yTopBp, 0, 1e-9);
    });

    await test('a rect maps by BOTH corners, so 90/270 cannot transpose it', () => {
        const r = { x: 100, y: 200, w: 300, h: 50 };
        const v0 = G.bpRectToViewport(A4, makeViewport(A4, 1, 0), r);
        near(v0.x, 100, 1e-9); near(v0.y, 200, 1e-9);
        near(v0.w, 300, 1e-9); near(v0.h, 50, 1e-9);
        const v90 = G.bpRectToViewport(A4, makeViewport(A4, 1, 90), r);
        near(v90.w, 50, 1e-9, 'extents swap at 90');
        near(v90.h, 300, 1e-9);
        for (const rot of [0, 90, 180, 270]) {
            const v = G.bpRectToViewport(A4, makeViewport(A4, 1, rot), r);
            assert.ok(v.w > 0 && v.h > 0, `rotation ${rot} must not collapse the rect`);
        }
    });

    await test('a real SyncTeX-shaped box lands inside the page', () => {
        // The shape RenderMap actually emits: an equation about 1 inch in from
        // the left, a third of the way down an A4 page.
        const vp = makeViewport(A4, 1.25, 0);
        const v = G.bpRectToViewport(A4, vp, { x: 72, y: 240, w: 451, h: 21 });
        assert.ok(v.x >= 0 && v.y >= 0, 'inside the top-left');
        assert.ok(v.x + v.w <= vp.width + 1e-6, 'inside the right edge');
        assert.ok(v.y + v.h <= vp.height + 1e-6, 'inside the bottom edge');
        near(v.x, 90, 1e-6, '72 bp at 1.25x');
        near(v.w, 451 * 1.25, 1e-6);
    });

    console.log('Page-mode viewer geometry\n');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main();
