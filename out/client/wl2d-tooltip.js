// Wolfbook: hover coordinate callout for 2D plot outputs.
//
// resources/wb2d.wl writes the sampled curves of a Plot next to its SVG/PNG and
// hangs data-wl-plot-src on the <img>. This module redraws what Mathematica's
// own PlotHighlighting shows: a ball snapped to the nearest curve plus an
// "x, y" label. The picture underneath is untouched — if the JSON is missing,
// stale or unfetchable, the image simply behaves the way it always has.
//
// NO DOM ACCESS AT MODULE TOP LEVEL: a bare `import()` of this file must work
// under Node so the smoke test can catch the duplicate-lexical-declaration class
// of bug that `node --check` does not see in ES modules.

const THRESHOLD_PX = 15;   // how close the cursor must come to a curve
const BALL_PX = 9;

// ---------- pure helpers (unit-tested directly) ----------

// Data coordinates -> viewport CSS pixels.
//
// ImagePadding and ImageSize come back from AbsoluteOptions in printer's points,
// and both the SVG (natural size IS points) and the 144-dpi PNG (a uniform 2x)
// scale the whole layout together, so the same map serves either.
//
// Two details, each verified against the coordinates in an exported SVG:
//
//  * The rectangle inside ImagePadding is filled by frameRange — PlotRange
//    widened by PlotRangePadding — NOT by PlotRange itself. For a default Plot
//    the data spans only the middle 96% of it horizontally and 90% vertically.
//  * Scale comes from the WIDTH alone, anchored at the top-left. The SVG canvas
//    is rounded up to whole points (a 220.33 pt tall plot is drawn on a 221 pt
//    canvas, the slack landing at the bottom), so rect.height/imageSize[1] is
//    slightly wrong while the width is exact and the export scales uniformly.
//
// WL measures padding from the bottom, CSS from the top, hence the flip in Y.
export function makeMapper(meta, rect) {
    const W = meta.imageSize[0], H = meta.imageSize[1];
    const pL = meta.imagePadding[0][0], pR = meta.imagePadding[0][1];
    const pB = meta.imagePadding[1][0], pT = meta.imagePadding[1][1];
    const fr = meta.frameRange || meta.plotRange;
    const x0 = fr[0][0], x1 = fr[0][1];
    const y0 = fr[1][0], y1 = fr[1][1];
    const s = rect.width / W;
    const plotW = W - pL - pR, plotH = H - pT - pB;
    const dx = x1 - x0, dy = y1 - y0;
    return {
        X: x => rect.left + (pL + ((x - x0) / dx) * plotW) * s,
        Y: y => rect.top + (pT + (1 - (y - y0) / dy) * plotH) * s,
    };
}

function curveBBox(c) {
    if (c._bb) return c._bb;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const seg of c.segs || []) {
        for (const p of seg) {
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1];
            if (p[1] > y1) y1 = p[1];
        }
    }
    c._bb = { x0, y0, x1, y1 };
    return c._bb;
}

// Nearest point on any curve, in SCREEN space so the threshold is a real visual
// distance regardless of how the axes are scaled. For a line the cursor is
// projected onto each segment; because the data->screen map is affine, the same
// parameter t interpolates in data space — that is Mathematica's
// "InterpolatedBall". Point sets snap to actual data points instead.
export function nearestOnCurves(curves, map, cx, cy, threshold) {
    const lim = threshold === undefined ? THRESHOLD_PX : threshold;
    let best = null, bestD2 = lim * lim;
    for (const c of curves) {
        const bb = curveBBox(c);
        if (bb.x0 === Infinity) continue;
        const sxa = map.X(bb.x0), sxb = map.X(bb.x1);
        const sya = map.Y(bb.y0), syb = map.Y(bb.y1);
        if (cx < Math.min(sxa, sxb) - lim || cx > Math.max(sxa, sxb) + lim ||
            cy < Math.min(sya, syb) - lim || cy > Math.max(sya, syb) + lim) continue;

        const snapOnly = c.kind === 'points';
        for (const seg of c.segs || []) {
            if (!seg.length) continue;
            if (snapOnly || seg.length === 1) {
                for (let i = 0; i < seg.length; i++) {
                    const px = map.X(seg[i][0]), py = map.Y(seg[i][1]);
                    const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
                    if (d2 < bestD2) {
                        bestD2 = d2;
                        best = { x: seg[i][0], y: seg[i][1], sx: px, sy: py, color: c.color };
                    }
                }
                continue;
            }
            let ax = map.X(seg[0][0]), ay = map.Y(seg[0][1]);
            for (let i = 1; i < seg.length; i++) {
                const bx = map.X(seg[i][0]), by = map.Y(seg[i][1]);
                const vx = bx - ax, vy = by - ay;
                const len2 = vx * vx + vy * vy;
                let t = len2 > 0 ? ((cx - ax) * vx + (cy - ay) * vy) / len2 : 0;
                t = t < 0 ? 0 : (t > 1 ? 1 : t);
                const px = ax + t * vx, py = ay + t * vy;
                const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = {
                        x: seg[i - 1][0] + t * (seg[i][0] - seg[i - 1][0]),
                        y: seg[i - 1][1] + t * (seg[i][1] - seg[i - 1][1]),
                        sx: px, sy: py, color: c.color,
                    };
                }
                ax = bx; ay = by;
            }
        }
    }
    return best;
}

// Three significant digits, matching what the notebook front end shows.
export function formatCoord(v) {
    if (!isFinite(v)) return String(v);
    return String(Number(v.toPrecision(3)));
}

function cssColor(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return 'rgb(61,153,204)';
    const b = n => Math.max(0, Math.min(255, Math.round(n * 255)));
    return 'rgb(' + b(rgb[0]) + ',' + b(rgb[1]) + ',' + b(rgb[2]) + ')';
}

// ---------- the shared overlay ----------
// One callout is visible at a time, as in Mathematica. position:fixed keeps it
// independent of every ancestor, so it works the same inside the copy-to-clipboard
// wrapper and inside a .wl-manip-result that has no wrapper at all.

let _ball = null, _label = null, _owner = null, _scrollBound = false;

function ensureOverlay(doc) {
    if (_ball && _ball.ownerDocument === doc) return;
    _ball = doc.createElement('div');
    _ball.className = 'wl2d-ball';
    _ball.style.cssText =
        'position:fixed;pointer-events:none;z-index:10000;display:none;' +
        'width:' + BALL_PX + 'px;height:' + BALL_PX + 'px;border-radius:50%;' +
        'border:1.5px solid var(--vscode-editor-background,#fff);' +
        'box-shadow:0 0 2px rgba(0,0,0,.45);';
    _label = doc.createElement('div');
    _label.className = 'wl2d-callout';
    _label.style.cssText =
        'position:fixed;pointer-events:none;z-index:10000;display:none;' +
        'padding:2px 6px;border-radius:3px;white-space:nowrap;' +
        'font:11px var(--vscode-editor-font-family,monospace);' +
        'color:var(--vscode-editorHoverWidget-foreground,#ddd);' +
        'background:var(--vscode-editorHoverWidget-background,#252526);' +
        'border:1px solid var(--vscode-editorHoverWidget-border,#454545);' +
        'box-shadow:0 2px 6px rgba(0,0,0,.35);';
    doc.body.appendChild(_ball);
    doc.body.appendChild(_label);
}

function hide() {
    if (_ball) _ball.style.display = 'none';
    if (_label) _label.style.display = 'none';
    _owner = null;
}

function show(img, hit) {
    const doc = img.ownerDocument || document;
    ensureOverlay(doc);
    _owner = img;
    const r = BALL_PX / 2;
    _ball.style.left = (hit.sx - r) + 'px';
    _ball.style.top = (hit.sy - r) + 'px';
    _ball.style.background = cssColor(hit.color);
    _ball.style.display = 'block';
    _label.textContent = formatCoord(hit.x) + ', ' + formatCoord(hit.y);
    _label.style.display = 'block';
    // Sit above-right of the ball, but stay INSIDE THE PICTURE. A notebook output
    // renderer is clipped to its own region, so a callout that reaches past the
    // top of the plot is not drawn over the cell above — it is simply cut off.
    // Keeping it within the image is also what the Mathematica front end does.
    const w = _label.offsetWidth, h = _label.offsetHeight;
    const box = img.getBoundingClientRect();
    const PAD = 3;
    let lx = hit.sx + 10, ly = hit.sy - h - 8;
    if (lx + w > box.right - PAD) lx = hit.sx - w - 10;   // flip to the left
    if (lx < box.left + PAD) lx = box.left + PAD;
    if (ly < box.top + PAD) ly = hit.sy + 12;             // flip below the ball
    if (ly + h > box.bottom - PAD) ly = box.bottom - h - PAD;
    if (ly < box.top + PAD) ly = box.top + PAD;           // plot shorter than the label
    _label.style.left = Math.round(lx) + 'px';
    _label.style.top = Math.round(ly) + 'px';

    if (!_scrollBound && doc.defaultView) {
        // Any scroll moves the picture out from under a position:fixed callout.
        doc.defaultView.addEventListener('scroll', hide, true);
        _scrollBound = true;
    }
}

// Called before a Manipulate frame replaces its result region: a callout frozen
// mid-hover would otherwise outlive the <img> it belongs to.
export function hideTooltipsIn(root) {
    if (_owner && root && root.contains && root.contains(_owner)) hide();
}

// ---------- attach ----------

export function attachPlotTooltip(img) {
    if (!img || img.getAttribute('data-wl2d-attached') === '1') return;
    // An interactive-3D image owns its own pointer gestures; never fight them.
    if (img.getAttribute('data-wl-mesh-src')) return;
    const src = img.getAttribute('data-wl-plot-src');
    if (!src) return;
    img.setAttribute('data-wl2d-attached', '1');

    let data = null, loading = false, dead = false;

    const detach = () => {
        img.removeEventListener('pointerenter', onEnter);
        img.removeEventListener('pointermove', onMove);
        img.removeEventListener('pointerleave', onLeave);
        img.removeAttribute('data-wl2d-attached');
        if (_owner === img) hide();
    };

    const load = () => {
        if (data || loading || dead) return;
        loading = true;
        fetch(src)
            .then(r => r.json())
            .then(j => {
                if (!j || !Array.isArray(j.curves) || !j.curves.length) throw new Error('no curves');
                if (!j.plotRange || !j.imageSize || !j.imagePadding) throw new Error('no frame');
                data = j;
            })
            .catch(() => { dead = true; detach(); })
            .then(() => { loading = false; });
    };

    function onEnter() { load(); }

    function onMove(ev) {
        if (!data) { load(); return; }
        if (!img.isConnected) { detach(); return; }
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) { hide(); return; }
        const hit = nearestOnCurves(data.curves, makeMapper(data, rect),
                                    ev.clientX, ev.clientY, THRESHOLD_PX);
        if (hit) show(img, hit); else if (_owner === img) hide();
    }

    function onLeave() { if (_owner === img) hide(); }

    // Passive: the callout never consumes a gesture, so notebook scrolling,
    // text selection and the copy button all behave exactly as before.
    img.addEventListener('pointerenter', onEnter, { passive: true });
    img.addEventListener('pointermove', onMove, { passive: true });
    img.addEventListener('pointerleave', onLeave, { passive: true });
}
