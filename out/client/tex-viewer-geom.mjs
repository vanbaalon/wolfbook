// tex-viewer-geom.mjs — the viewer's coordinate map, as pure functions.
//
// An ES module with no DOM and no pdf.js import, so the SAME code the webview
// runs can be tested in node (kernel/tests/tex-viewer-geom.test.js) against an
// independently-verified reference. Spike C's lesson applies directly here:
// a round-trip test cannot catch a mirrored map, so the test compares against
// a second implementation rather than only against itself.
//
// THE TWO FRAMES
//   Extension side: bp, origin at the page box's TOP-left, y DOWN. That is
//     SyncTeX's convention, normalised once in tex/texGeometry.js, and it is
//     what RenderMap hands out.
//   pdf.js side:    PDF user space (y UP from the box's bottom-left) fed
//     through `viewport.convertToViewportPoint` to reach CSS pixels.
//
// `view` is `page.view` — the CropBox intersected with the MediaBox — NOT the
// MediaBox. Spike C measured the same word 70.71 bp apart between poppler's
// frame (which ignores CropBox) and pdf.js's (which does not); every uncropped
// fixture hides the difference.

/** {xBp, yTopBp} in the extension's frame -> PDF user space. */
export function bpToPdf(view, xBp, yTopBp) {
    const [x0, , , y1] = view;
    return [x0 + xBp, y1 - yTopBp];
}

/** PDF user space -> {xBp, yTopBp} in the extension's frame. */
export function pdfToBp(view, pdfX, pdfY) {
    const [x0, , , y1] = view;
    return { xBp: pdfX - x0, yTopBp: y1 - pdfY };
}

/** Extension frame -> viewport CSS pixels, through pdf.js's own transform. */
export function bpToViewport(view, viewport, xBp, yTopBp) {
    const [px, py] = bpToPdf(view, xBp, yTopBp);
    const [vx, vy] = viewport.convertToViewportPoint(px, py);
    return { x: vx, y: vy };
}

/** Viewport CSS pixels -> extension frame. */
export function viewportToBp(view, viewport, vx, vy) {
    const [px, py] = viewport.convertToPdfPoint(vx, vy);
    return pdfToBp(view, px, py);
}

/**
 * A rect in the extension's frame -> a viewport rect.
 *
 * BOTH corners are mapped and then re-normalised. At 90/270 the transform
 * swaps the axes, so scaling width and height directly transposes the box and
 * the highlight comes out lying on its side.
 */
export function bpRectToViewport(view, viewport, r) {
    const a = bpToViewport(view, viewport, r.x, r.y);
    const b = bpToViewport(view, viewport, r.x + r.w, r.y + r.h);
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
    };
}
