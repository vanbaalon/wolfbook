// Wolfbook: drag-to-resize for plot outputs.
//
// A grip in the bottom-right corner of a plot lets the reader override the size
// the kernel chose. Width is the only thing dragged; height follows the original
// aspect ratio, so a plot can never be squashed.
//
// The <img width>/<height> ATTRIBUTES are the source of truth, not just CSS:
// wl3d-viewer's mountViewer reads them when it turns a picture into a live
// canvas, and out/extension/output/renderer.js injectImageDimensions leaves an
// existing width= alone. So writing them back into the stored output HTML is all
// persistence needs — no new metadata schema.
//
// NO DOM ACCESS AT MODULE TOP LEVEL, so a bare import() works under Node.

const MIN_W = 60;
const GRIP_PX = 14;

export function gripCss(visible) {
    return 'position:absolute;right:0;bottom:0;width:' + GRIP_PX + 'px;height:' + GRIP_PX + 'px;' +
        'cursor:nwse-resize;z-index:3;opacity:' + (visible ? '0.55' : '0') + ';transition:opacity .12s;' +
        'background:linear-gradient(135deg,transparent 0 50%,var(--vscode-descriptionForeground,#888) 50% 60%,' +
        'transparent 60% 72%,var(--vscode-descriptionForeground,#888) 72% 82%,transparent 82%);';
}

// Width the plot may grow to without spilling out of the notebook column.
export function availableWidth(box, natW) {
    let el = box.parentElement;
    while (el) {
        // .wl-output-content is the block that actually spans the column; the
        // box itself is inline-block and shrink-wraps, so it cannot be measured.
        const w = el.clientWidth;
        if (w > 1) return Math.max(w, natW || 0);
        el = el.parentElement;
    }
    return Math.max(natW || 0, 2000);
}

export function clampWidth(w, natW, maxW) {
    if (!isFinite(w)) return natW;
    return Math.max(MIN_W, Math.min(w, maxW));
}

/**
 * Add a resize grip to an already-wrapped plot image.
 *
 * @param box    the position:relative wrapper around the <img>
 * @param img    the plot image
 * @param commit called with (width, height) after a drag, or (0, 0) on reset;
 *               omit it for outputs whose size cannot be persisted.
 */
export function makeResizable(box, img, commit) {
    if (!box || !img || box.getAttribute('data-wl-resizable') === '1') return null;
    box.setAttribute('data-wl-resizable', '1');

    const doc = box.ownerDocument || document;
    let natW = 0, natH = 0, aspect = 0;

    const readNatural = () => {
        // The width/height attributes are the kernel's chosen size — or, once a
        // resize has been persisted, the user's. naturalWidth is the fallback for
        // an image the extension could not measure.
        natW = parseFloat(img.getAttribute('data-wl-nat-w')) || 0;
        natH = parseFloat(img.getAttribute('data-wl-nat-h')) || 0;
        if (!natW) {
            natW = parseFloat(img.getAttribute('width')) || img.naturalWidth || 0;
            natH = parseFloat(img.getAttribute('height')) || img.naturalHeight || 0;
            if (natW && natH) {
                // Remember the size we started from so "reset" survives repeated
                // drags within one session.
                img.setAttribute('data-wl-nat-w', String(natW));
                img.setAttribute('data-wl-nat-h', String(natH));
            }
        }
        aspect = natW && natH ? natH / natW : 0;
    };
    readNatural();

    const grip = doc.createElement('div');
    grip.className = 'wl-resize-grip';
    grip.title = 'Drag to resize · double-click to reset';
    grip.style.cssText = gripCss(false);
    box.appendChild(grip);
    box.addEventListener('mouseenter', () => { grip.style.opacity = '0.55'; });
    box.addEventListener('mouseleave', () => { if (!dragging) grip.style.opacity = '0'; });

    const applyWidth = (w) => {
        const h = aspect ? Math.round(w * aspect) : 0;
        box.style.width = Math.round(w) + 'px';
        img.setAttribute('width', String(Math.round(w)));
        if (h) img.setAttribute('height', String(h));
        // A mounted 3D viewer owns its own box; its ResizeObserver re-fits the
        // camera as soon as the host changes width.
        const host = box.querySelector('.wl3d-host');
        if (host) host.style.width = Math.round(w) + 'px';
        return h;
    };

    // Take the width the image already carries (a persisted size, or the
    // kernel's) so the picture never jumps on load.
    if (natW) {
        box.style.width = Math.round(natW) + 'px';
        img.style.width = '100%';
        img.style.height = 'auto';
    } else {
        // Size unknown until the bytes land.
        img.addEventListener('load', () => {
            if (natW) return;
            readNatural();
            if (natW) {
                box.style.width = Math.round(natW) + 'px';
                img.style.width = '100%';
                img.style.height = 'auto';
            }
        }, { once: true });
    }

    let dragging = false, startX = 0, startW = 0, maxW = 0, lastW = 0;

    grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();          // never let a 3D orbit start from the grip
        readNatural();
        dragging = true;
        startX = e.clientX;
        startW = box.getBoundingClientRect().width || natW;
        lastW = startW;
        maxW = availableWidth(box, natW);
        grip.style.opacity = '0.9';
        try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    });

    grip.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        lastW = clampWidth(startW + (e.clientX - startX), natW, maxW);
        applyWidth(lastW);
    });

    const finish = (e) => {
        if (!dragging) return;
        dragging = false;
        grip.style.opacity = '0';
        try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
        const h = applyWidth(lastW);
        if (commit && Math.abs(lastW - startW) >= 1) commit(Math.round(lastW), h);
    };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);

    // Double-click the grip to go back to the size the kernel picked.
    grip.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        readNatural();
        if (!natW) return;
        applyWidth(natW);
        if (commit) commit(0, 0);
    });

    return { applyWidth, grip };
}
