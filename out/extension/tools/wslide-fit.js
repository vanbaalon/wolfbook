"use strict";
// wslide-fit.js — layout analysis for .wslide decks.
//
// Deliberately vscode-free and side-effect-free so it can be unit-tested
// headlessly (kernel/tests/wslide-fit.test.js). Everything here is a pure
// function of (slide tree, measurement payload).
//
// Motivation — field report 2026-08-30 (Tropea deck):
//   "The write path is cheap. The verify path is ruinously expensive. There is
//    nothing in between."
// Answering "does this column overflow 1080px?" cost a JPEG render plus a
// vision read (~1500 tokens) per attempt, ~37 times in one session. The
// renderer already computes the box; it just never reported it. A fit report
// is ~90 tokens and is strictly MORE actionable than the screenshot, because
// it says by how much and which block.

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// A column dominated by fixed-size content (images, eval output) cannot be
// rescued by shrinking its font — say so instead of emitting a hint that
// will not work.
const FIXED_DOMINATES = 0.75;
// Below this fraction of the parent's width a flex child is "shrink-wrapped"
// rather than merely narrow.
const SHRINKWRAP_RATIO = 0.9;
const MIN_SCALE = 0.55;

// A type scale, so a deck keeps a finite vocabulary of sizes.
//
// Field report #2 §5, the second-order effect of shipping the fit report:
// making per-block font nudging cheap and instantly verified turned it into the
// path of least resistance for every overflow. One session produced
//   0.58 0.62 0.63 0.66 0.70 0.71 0.72 0.74 1.05 em
// — nobody chose that sequence; each value is the local answer to "make this
// fit". The tool optimised the metric it reported (fit) at the expense of the
// one it did not (typographic consistency). So the hint now snaps to a scale
// and prefers a value the deck already uses.
const DEFAULT_TYPE_SCALE = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6];

/** The deck's declared scale, else the sizes already in use, else the default. */
function typeScale(deck) {
    const declared = deck && deck.typeScale;
    if (Array.isArray(declared) && declared.length) {
        return [...new Set(declared.map(Number).filter(v => v > 0))].sort((a, b) => b - a);
    }
    return DEFAULT_TYPE_SCALE;
}

/** Every em font size currently used in the deck, most-used first. */
function emSizesInUse(deck) {
    const tally = new Map();
    for (const s of (deck && deck.slides) || []) {
        (function walk(node) {
            for (const b of kidsOf(node)) {
                if (!b || typeof b !== 'object') continue;
                const v = parseEm(b.style?.fontSize ?? b.fontSize);
                if (v) tally.set(v, (tally.get(v) || 0) + 1);
                walk(b);
            }
        })(s);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

/**
 * Largest step of `steps` that is <= want (so it provably fits), else the
 * smallest step. Snapping DOWN is what removes the round trips: the report
 * suggested 0.96, the author tried 0.95 (+1px), then 0.94 (✓) — two calls lost
 * to rounding, because a suggestion that only just fits does not survive it.
 */
function snapDown(want, steps) {
    const sorted = [...steps].sort((a, b) => b - a);
    for (const st of sorted) if (st <= want + 1e-9) return st;
    return sorted[sorted.length - 1];
}

// ── Tree helpers ──────────────────────────────────────────────────────────

/** Children of a block/slide, whichever array carries them. */
function kidsOf(node) {
    if (!node || typeof node !== 'object') return [];
    return node.children || node.items || node.elements || [];
}

/** Flat map id → { block, parent, depth, path } for one slide. */
function indexSlide(slide) {
    const byId = new Map();
    (function walk(node, parent, depth, path) {
        for (const b of kidsOf(node)) {
            if (!b || typeof b !== 'object') continue;
            const p = path.concat(b.id || '?');
            if (b.id) byId.set(b.id, { block: b, parent, depth, path: p });
            walk(b, b, depth + 1, p);
        }
    })(slide, null, 0, []);
    return byId;
}

/** The effective alignItems for a container (block.align is the shorthand). */
function alignOf(block) {
    if (!block) return null;
    return block.align || block.style?.alignItems || null;
}

/** Parse "0.88em" / "0.9" → 0.88. Anything else (px, %, calc) → null. */
function parseEm(v) {
    if (typeof v === 'number') return v > 0 ? v : null;
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^([0-9]*\.?[0-9]+)\s*em$/i);
    if (m) return parseFloat(m[1]);
    const n = v.trim().match(/^([0-9]*\.?[0-9]+)$/);
    return n ? parseFloat(n[1]) : null;
}

/** Blocks whose height does not follow the font size. */
function isFixedHeight(block) {
    if (!block) return false;
    if (block.type === 'image') return true;
    if (block.type === 'eval') return true;
    if (block.type === 'arrow') return true;
    // An explicit pixel height pins the box regardless of type.
    if (typeof block.h === 'number' && block.h > 0) return true;
    return false;
}

// ── Fit computation ───────────────────────────────────────────────────────

/**
 * Analyse one slide against a measurement payload from the webview.
 *
 * @param {object} slide       the slide as stored in the deck
 * @param {object} measurement { blocks: {id:{x,y,w,h,visible,natural?}}, contentBottom, canvas? }
 * @returns {{
 *   canvas:{w:number,h:number}, contentBottom:number, overflow:number,
 *   fits:boolean, columns:Array, offenders:Array, hints:Array, notes:Array
 * }}
 */
function computeFit(slide, measurement, opts = {}) {
    const canvas = {
        w: measurement?.canvas?.w || CANVAS_W,
        h: measurement?.canvas?.h || CANVAS_H,
    };
    const meas = (measurement && measurement.blocks) || {};
    const byId = indexSlide(slide);

    const contentBottom = Math.round(
        measurement?.contentBottom != null
            ? measurement.contentBottom
            : Object.values(meas).reduce((lo, m) => Math.max(lo, (m.y || 0) + (m.h || 0)), 0)
    );
    const overflow = contentBottom - canvas.h;

    // Per-block records enriched with the tree.
    const recs = [];
    for (const [id, m] of Object.entries(meas)) {
        const entry = byId.get(id);
        if (!entry) continue;                       // measured but no longer in the tree
        const bottom = Math.round((m.y || 0) + (m.h || 0));
        const right = Math.round((m.x || 0) + (m.w || 0));
        recs.push({
            id,
            block: entry.block,
            parent: entry.parent,
            depth: entry.depth,
            type: entry.block.type || '?',
            x: Math.round(m.x || 0), y: Math.round(m.y || 0),
            w: Math.round(m.w || 0), h: Math.round(m.h || 0),
            bottom, right,
            visible: m.visible !== false,
            natural: m.natural || null,
            clippedBottom: bottom > canvas.h,
            fullyOut: (m.y || 0) >= canvas.h,
            clippedRight: right > canvas.w,
        });
    }
    const recById = new Map(recs.map(r => [r.id, r]));

    // ── Columns: the top-level blocks, plus the children of a top-level row.
    // These are the units an author actually rescales.
    const columns = [];
    const top = kidsOf(slide).filter(b => b && b.id && recById.has(b.id));
    for (const b of top) {
        const r = recById.get(b.id);
        const isRow = (b.type === 'container') && ((b.layout || 'column') === 'row');
        if (isRow) {
            for (const c of kidsOf(b)) {
                if (c && c.id && recById.has(c.id)) columns.push(recById.get(c.id));
            }
        } else {
            columns.push(r);
        }
    }

    // ── Offenders: blocks that leave the frame.
    const offenders = recs
        .filter(r => r.visible && (r.clippedBottom || r.clippedRight))
        // Report the outermost offender plus its own clipped children, not
        // every descendant of an overflowing column.
        .sort((a, b) => a.depth - b.depth || a.y - b.y);

    // ── Hints: closed-form rescale per overflowing column.
    //
    // Prefer the COMMON PARENT when more than one sibling overflows. One value
    // on the container is one call, one number, and no drift; per-sibling
    // nudges are how a deck ends up with nine different font sizes nobody
    // chose (field report #2 §5).
    const hintOpts = {
        steps: typeScale(opts.deck),
        inUse: emSizesInUse(opts.deck),
    };
    const hints = [];
    const bad = columns.filter(c => c && c.bottom > canvas.h);
    const parentIds = new Set(bad.map(c => c.parent && c.parent.id).filter(Boolean));
    if (bad.length > 1 && parentIds.size === 1) {
        const pid = [...parentIds][0];
        const pr = recById.get(pid);
        if (pr && pr.bottom > canvas.h) {
            hints.push(Object.assign(rescaleHint(pr, recById, canvas, hintOpts), {
                coversSiblings: bad.map(c => c.id),
                note: `one value on the parent #${pid} instead of ${bad.length} separate sibling edits`,
            }));
        }
    }
    if (!hints.length) {
        const seen = new Set();
        for (const col of bad) {
            if (seen.has(col.id)) continue;
            seen.add(col.id);
            hints.push(rescaleHint(col, recById, canvas, hintOpts));
        }
    }
    // A slide can overflow with no single column at fault (e.g. one long
    // top-level text block already covered above, or free-positioned blocks).
    if (!hints.length && overflow > 0) {
        const worst = offenders.filter(o => o.clippedBottom).sort((a, b) => b.bottom - a.bottom)[0];
        if (worst) hints.push(rescaleHint(worst, recById, canvas, hintOpts));
    }

    // ── Notes: measured problems that are not overflow.
    const notes = [];
    for (const r of recs) {
        // Shrink-wrap: a flex child far narrower than its parent, where the
        // parent's alignItems is the cause. Cost me three slides in the field
        // report before the pattern was recognised.
        if (r.parent && r.type !== 'image') {
            const pr = recById.get(r.parent.id);
            const align = alignOf(r.parent);
            const wantsFull = r.block.style?.width === '100%' || r.block.w === '100%';
            if (pr && pr.w > 0 && align && align !== 'stretch' &&
                r.w < pr.w * SHRINKWRAP_RATIO &&
                (wantsFull || r.type === 'container' || r.type === 'raw')) {
                notes.push({
                    blockId: r.id, kind: 'shrink_wrapped',
                    detail: `w=${r.w} of ${pr.w} available in #${r.parent.id}`,
                    cause: `parent #${r.parent.id} has alignItems:"${align}"`,
                    fix: `wolfslide_patchBlock(blockId:"${r.parent.id}", patch:{align:"stretch"})`,
                });
            }
        }
        // A picture drawn at a ratio its source cannot support.
        if (r.type === 'image' && r.natural && r.natural.w > 0 && r.natural.h > 0 && r.w > 0 && r.h > 0) {
            const drawn = r.w / r.h;
            const src = r.natural.w / r.natural.h;
            if (src > 0 && Math.abs(drawn - src) / src > 0.1) {
                notes.push({
                    blockId: r.id, kind: 'aspect_distorted',
                    detail: `drawn ${r.w}×${r.h} (ratio ${drawn.toFixed(2)}) from ${r.natural.w}×${r.natural.h} (ratio ${src.toFixed(2)})`,
                    fix: `set one of w/h and let the other follow, e.g. {w:${r.w}, h:${Math.round(r.w / src)}}`,
                });
            }
        }
    }

    return {
        canvas, contentBottom, overflow,
        fits: overflow <= 0,
        columns, offenders, hints, notes,
        recById,
    };
}

/**
 * Closed-form rescale for one overflowing block.
 * `available / actual`, with the fixed-height content held out of the ratio —
 * shrinking the font does not shrink a PNG.
 */
function rescaleHint(rec, recById, canvas, opts = {}) {
    const avail = canvas.h - rec.y;
    const actual = rec.h;

    // Fixed content inside this block: leaf image/eval/arrow descendants only,
    // so nested containers are not double-counted.
    let fixed = 0;
    (function walk(block) {
        for (const c of kidsOf(block)) {
            if (!c || !c.id) continue;
            const cr = recById.get(c.id);
            const leaf = kidsOf(c).length === 0;
            if (cr && leaf && isFixedHeight(c)) fixed += cr.h;
            else walk(c);
        }
    })(rec.block);
    if (isFixedHeight(rec.block) && kidsOf(rec.block).length === 0) fixed = actual;

    const flexible = actual - fixed;
    const need = avail - fixed;

    if (flexible <= 0 || need <= 0 || fixed >= actual * FIXED_DOMINATES) {
        return {
            blockId: rec.id,
            kind: 'fixed_dominated',
            overflow: rec.bottom - canvas.h,
            fixedPx: Math.round(fixed), totalPx: actual,
            text: `#${rec.id} is ${Math.round(100 * fixed / Math.max(actual, 1))}% fixed-size content ` +
                  `(${Math.round(fixed)}px of ${actual}px) — font scaling will not help. ` +
                  `Shrink the image/eval block, or move content to a new slide.`,
        };
    }

    const rawScale = need / flexible;
    if (rawScale < MIN_SCALE) {
        return {
            blockId: rec.id, kind: 'below_floor',
            scale: rawScale, overflow: rec.bottom - canvas.h, fixedPx: Math.round(fixed),
            text: `#${rec.id} needs ${rawScale.toFixed(2)}em to fit — too small to read. Split the slide instead.`,
        };
    }

    // Compose with a font size the block already carries, so a second pass does
    // not silently reset an earlier reduction, THEN snap the composed value to
    // the deck's scale — snapping the factor instead would drift the moment the
    // block already sits off-scale.
    const existing = parseEm(rec.block.style?.fontSize ?? rec.block.fontSize) || 1;
    const want = existing * rawScale;
    const steps = opts.steps || DEFAULT_TYPE_SCALE;
    const applied = snapDown(want, steps);
    const effective = applied / existing;
    const est = Math.round(rec.y + fixed + flexible * effective);

    const inUse = (opts.inUse || []).find(([v]) => Math.abs(v - applied) < 1e-9);
    const usage = inUse
        ? `  (${applied}em is already used on ${inUse[1]} other block${inUse[1] === 1 ? '' : 's'} — keeps the deck consistent)`
        : '';

    return {
        blockId: rec.id, kind: 'rescale',
        scale: effective, applied, estBottom: est,
        overflow: rec.bottom - canvas.h,
        fixedPx: Math.round(fixed),
        call: `wolfslide_patchBlock(blockId:"${rec.id}", patch:{style:{fontSize:"${applied}em"}})`,
        text: `set #${rec.id} { fontSize: ${applied}em }  → est. ${est}px` +
              (fixed > 0 ? `  (${Math.round(fixed)}px of it is fixed-size content, held out of the scaling)` : '') +
              usage,
    };
}

// ── Rendering ─────────────────────────────────────────────────────────────

/** One line, for folding into a mutation response. ~15 tokens. */
function fitLine(fit) {
    if (!fit) return '';
    if (fit.fits) {
        const slack = fit.canvas.h - fit.contentBottom;
        return `FIT: ${fit.contentBottom}/${fit.canvas.h} ✓${slack > 260 ? `  (${slack}px unused — room for more)` : ''}`;
    }
    const first = fit.hints[0];
    return `FIT: ${fit.contentBottom}/${fit.canvas.h} ⚠ +${fit.overflow}px` +
           (first ? ` — ${first.blockId}` : '') +
           `  · getSlideHtml(format:"fit") for detail`;
}

/**
 * Lint lines for a mutation footer.
 *
 * Severity decides visibility, not arithmetic: an 'error' lint means the slide
 * asserts something other than what it looks like, so every one of those is
 * shown however many there are. Advisory lints are capped, because a footer
 * nobody finishes reading is a footer nobody reads.
 */
function lintFooterLines(lints) {
    const errs = (lints || []).filter(l => l.severity === 'error');
    const rest = (lints || []).filter(l => l.severity !== 'error');
    const out = errs.map(l => `  🔴 ${l.rule} on #${l.blockId}: ${l.detail}` + (l.fix ? `\n       fix: ${l.fix}` : ''));
    out.push(...rest.slice(0, 2).map(l => `  ⚠ ${l.rule} on #${l.blockId}: ${l.detail}`));
    if (rest.length > 2) out.push(`  ⚠ …and ${rest.length - 2} more advisory lint(s) — getSlideHtml(format:"fit")`);
    return out;
}

/**
 * The full report. Replaces a screenshot for the "does it fit" question at
 * roughly 1/16th the tokens, and unlike the screenshot it names the block.
 */
function formatFitReport(slide, slideIndex, fit, lints) {
    const L = [];
    const label = slide.label || slide.meta?.title || '';
    const status = fit.fits
        ? `${fit.contentBottom}px / ${fit.canvas.h}px   ✓ fits`
        : `${fit.contentBottom}px / ${fit.canvas.h}px   ⚠ OVERFLOW +${fit.overflow}px`;
    L.push(`Slide ${slideIndex}${label ? ` "${label}"` : ''}  content ${status}`);

    for (const col of fit.columns) {
        const over = col.bottom > fit.canvas.h;
        const bits = [`  #${col.id.padEnd(12)} y=${col.y}..${col.bottom}  w=${col.w}`];
        if (over) bits.push(`⚠ +${col.bottom - fit.canvas.h}px`);
        L.push(bits.join('  '));
        // Children of an overflowing column that are themselves out of frame.
        if (over) {
            for (const c of kidsOf(col.block)) {
                const cr = c && c.id && fit.recById.get(c.id);
                if (!cr || cr.bottom <= fit.canvas.h) continue;
                L.push(`    #${cr.id.padEnd(12)} y=${cr.y}..${cr.bottom}  ` +
                       (cr.fullyOut ? '⚠ FULLY OUT OF FRAME' : '⚠ CLIPPED (bottom)'));
            }
        }
    }

    const rightClipped = fit.offenders.filter(o => o.clippedRight);
    for (const o of rightClipped) {
        L.push(`  #${o.id.padEnd(12)} x=${o.x}..${o.right}  ⚠ CLIPPED (right, canvas ${fit.canvas.w})`);
    }

    for (const n of fit.notes) {
        L.push(`  #${n.blockId.padEnd(12)} ⚠ ${n.kind.replace(/_/g, ' ')}: ${n.detail}`);
        if (n.cause) L.push(`                 cause: ${n.cause}`);
        if (n.fix)   L.push(`                 fix:   ${n.fix}`);
    }

    for (const l of (lints || [])) {
        const mark = l.severity === 'error' ? '🔴' : '⚠';
        L.push(`  #${String(l.blockId).padEnd(12)} ${mark} ${l.rule}: ${l.detail}`);
        if (l.fix) L.push(`                 fix:   ${l.fix}`);
    }

    for (const h of fit.hints) {
        L.push(`  fit hint: ${h.text}`);
        if (h.note) L.push(`            ${h.note}`);
        if (h.call) L.push(`            ${h.call}`);
    }
    if (fit.fits && !fit.notes.length && !(lints || []).length) {
        L.push('  no layout problems detected');
    }
    return L.join('\n');
}

// ── Static lints (no webview needed) ───────────────────────────────────────

/**
 * Checks that need only the deck JSON, so they run on every mutation and in
 * the deck audit even when no editor is rendering.
 */
function lintSlide(slide) {
    const out = [];
    (function walk(node) {
        for (const b of kidsOf(node)) {
            if (!b || typeof b !== 'object') continue;
            const align = alignOf(b);
            // alignItems anything-but-stretch sizes each child to its CONTENT,
            // so a width:100% anywhere below resolves against that hugged box
            // rather than the column. Measured in a real browser: a 100%-wide
            // element inside a 573px column came out 300px. Nothing errors and
            // nothing looks obviously broken — it cost three slides in the
            // field report before the pattern was recognised.
            //
            // The declaration is usually a DESCENDANT, not a direct child, and
            // often lives inside a raw block's HTML, so scan both.
            if (align && align !== 'stretch') {
                for (const c of kidsOf(b)) {
                    if (!c || typeof c !== 'object') continue;
                    const at = wantsFullWidth(c);
                    if (at) {
                        out.push({
                            blockId: c.id || '?', rule: 'shrinkwrap_risk',
                            detail: `${at} under #${b.id || '?'}, which has alignItems:"${align}" — ` +
                                    `this subtree is sized to its content, so the 100% resolves against ` +
                                    `the hugged box and renders narrower than the column`,
                            fix: `wolfslide_patchBlock(blockId:"${b.id || '?'}", patch:{align:"stretch"})`,
                        });
                    }
                }
            }
            // Markup that renders without error and means something else.
            for (const k of ['content', 'alt']) {
                if (typeof b[k] === 'string' && b[k].includes('$')) {
                    out.push(...lintMathContent(b[k], b.id || '?'));
                }
            }
            // No separate items loop: kidsOf() already descends into `items`,
            // so a list item is visited as a block in its own right and its
            // content is linted by the loop above. Doing both reported twice.
            // A declared w:h that the source image cannot support.
            if (b.type === 'image' && b.natural && b.w > 0 && b.h > 0) {
                const drawn = b.w / b.h, src = b.natural.w / b.natural.h;
                if (src > 0 && Math.abs(drawn - src) / src > 0.1) {
                    out.push({
                        blockId: b.id || '?', rule: 'aspect_distorted',
                        detail: `${b.w}×${b.h} (ratio ${drawn.toFixed(2)}) from a ${b.natural.w}×${b.natural.h} source (ratio ${src.toFixed(2)})`,
                        fix: `{w:${b.w}, h:${Math.round(b.w / src)}}`,
                    });
                }
            }
            walk(b);
        }
    })(slide);
    return out;
}

/**
 * Does this block, or anything under it, ask to fill its container's width?
 * Returns a short description of where, or null.
 */
function wantsFullWidth(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.style?.width === '100%' || block.w === '100%') return 'width:100%';
    if (typeof block.content === 'string' && /width:\s*100%/.test(block.content)) {
        return 'width:100% in the block markup';
    }
    for (const c of kidsOf(block)) {
        const found = wantsFullWidth(c);
        if (found) return `${found} (on #${c.id || '?'}, nested)`;
    }
    return null;
}

/**
 * Compare a declared image size against the real file dimensions.
 * Separate from lintSlide because it needs I/O to read the header.
 */
function aspectWarning(block, natural, tol = 0.1) {
    if (!block || !natural || !natural.w || !natural.h) return null;
    const w = Number(block.w), h = Number(block.h);
    if (!(w > 0) || !(h > 0)) return null;
    const drawn = w / h, src = natural.w / natural.h;
    if (Math.abs(drawn - src) / src <= tol) return null;
    return `#${block.id || '?'} ${w}×${h} distorts source ${natural.w}×${natural.h} ` +
           `(ratio ${drawn.toFixed(2)} vs ${src.toFixed(2)}) — use {w:${w}, h:${Math.round(w / src)}}`;
}

// ── Math lint: markup that renders fine and means something else ──────────
//
// A whole class of defect passes every check this file already performs: the
// JSON looks right, the fit report is ✓, KaTeX raises no error, and the block
// tree — where most inspection happens — shows nothing. Only a human reading
// the rendered slide catches it.
//
// The flagship case, from the field report: \color{#008800}{x} LOOKS scoped
// because of the braces. It is not. \color is a SWITCH — it takes the colour as
// its argument and the following {...} is an ordinary group, so everything to
// the end of the ENCLOSING group is recoloured. On a slide about which terms
// survive into N=4, that made QCD-only terms appear to survive, and an edit
// "adding" colour to an already-bled term was a silent no-op that both the JSON
// diff and the fit report reported as success.

/** Split content into math runs: [{ tex, start, end, display }]. */
function mathRuns(content) {
    const out = [];
    const s = String(content || '');
    const re = /\$\$([\s\S]*?)\$\$|\$([^$\n]*?)\$/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const display = m[1] != null;
        out.push({
            tex: display ? m[1] : m[2],
            start: m.index,
            end: m.index + m[0].length,
            display,
        });
    }
    return out;
}

/** Index of the matching close brace for the `{` at `open`, or -1. */
function matchBrace(tex, open) {
    let depth = 0;
    for (let i = open; i < tex.length; i++) {
        if (tex[i] === '\\') { i++; continue; }        // skip an escaped char
        if (tex[i] === '{') depth++;
        else if (tex[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/**
 * Find every `\color{…}` switch in one TeX string and work out what it bleeds
 * onto — the text from the end of its apparent argument to the end of the
 * enclosing group. Naming the bleed is the difference between a warning and a
 * diagnosis: it shows the author exactly which terms changed meaning.
 *
 * @returns {Array<{index:number, colour:string, scoped:string, bleed:string}>}
 */
function colorSwitches(tex) {
    const out = [];
    const s = String(tex || '');
    // \color but NOT \textcolor / \colorbox / \pagecolor — those take the text
    // as an argument and really are scoped.
    const re = /(^|[^a-zA-Z\\])\\color\s*\{/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const braceAt = m.index + m[0].length - 1;
        const close = matchBrace(s, braceAt);
        if (close === -1) continue;
        const colour = s.slice(braceAt + 1, close);

        // The group the author probably believed was the scope.
        let scoped = '', after = close + 1;
        while (after < s.length && /\s/.test(s[after])) after++;
        if (s[after] === '{') {
            const scopeClose = matchBrace(s, after);
            if (scopeClose !== -1) { scoped = s.slice(after + 1, scopeClose); after = scopeClose + 1; }
        }

        // Everything from there to the end of the ENCLOSING group is also
        // recoloured. Walk forward until the brace depth would go negative.
        let depth = 0, endOfGroup = s.length;
        for (let i = after; i < s.length; i++) {
            if (s[i] === '\\') { i++; continue; }
            if (s[i] === '{') depth++;
            else if (s[i] === '}') { if (depth === 0) { endOfGroup = i; break; } depth--; }
        }
        const bleed = s.slice(after, endOfGroup).trim();
        out.push({ index: m.index, colour, scoped, bleed });
    }
    return out;
}

/** Cap a TeX fragment for a one-line report. */
function ellipsis(str, n) {
    const t = String(str || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * Lint the math inside one block's content.
 * Severity 'error' means it changes what the slide asserts.
 */
function lintMathContent(content, blockId) {
    const out = [];
    for (const run of mathRuns(content)) {
        for (const c of colorSwitches(run.tex)) {
            if (!c.bleed) {
                // The switch reaches a group boundary immediately, so it happens
                // to render correctly — correct BY LUCK, which is exactly the
                // profile of a latent bug: any later edit extends the group.
                out.push({
                    blockId, rule: 'color_switch', severity: 'warn',
                    detail: `\\color{${c.colour}} is a SWITCH, not a scoped command. It renders correctly ` +
                            `here only because the enclosing group ends immediately — any text appended ` +
                            `to this group later will silently take the colour too`,
                    fix: `\\textcolor{${c.colour}}{${ellipsis(c.scoped, 30) || '…'}}`,
                });
                continue;
            }
            out.push({
                blockId, rule: 'color_switch', severity: 'error',
                detail: `\\color{${c.colour}} is a SWITCH — it recolours everything to the end of the ` +
                        `enclosing group, not just the braces after it. Intended: "${ellipsis(c.scoped, 34)}". ` +
                        `ALSO coloured: "${ellipsis(c.bleed, 46)}"`,
                fix: `\\textcolor{${c.colour}}{${ellipsis(c.scoped, 30) || '…'}}  — \\textcolor takes the ` +
                     `text as an argument and really is scoped`,
            });
        }
        // A bare % inside math comments out the rest of the LINE in TeX, so the
        // remainder of the expression silently disappears. Common because "50%"
        // is unremarkable everywhere else in a slide.
        const pct = run.tex.search(/(^|[^\\])%/);
        if (pct !== -1) {
            out.push({
                blockId, rule: 'math_comment', severity: 'error',
                detail: `an unescaped % inside math starts a TeX COMMENT — everything after it on the ` +
                        `line is dropped from the rendered output: "${ellipsis(run.tex.slice(pct), 46)}"`,
                fix: 'write \\% for a literal percent sign',
            });
        }
    }
    return out;
}

// ── Citation extraction ───────────────────────────────────────────────────

// New-style 1234.56789(v3) and old-style hep-th/9711200.
const ARXIV_RE = /\b(?:arXiv:\s*)?((?:\d{4}\.\d{4,5})(?:v\d+)?|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)\b/g;

/** Plain text of a block, tags stripped, for citation scanning. */
function blockText(b) {
    const parts = [b.content || '', b.alt || '', b.input || ''];
    for (const it of (b.items || [])) parts.push(it && it.content || '');
    return parts.join(' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

/**
 * Every arXiv id in the deck, with the slide/block it sits in and the
 * surname-shaped words next to it — the author list is what catches a
 * transposed id, since a wrong id almost always has the wrong authors.
 *
 * @returns {Array<{slide:number, blockId:string, arxivId:string, context:string, names:string[]}>}
 */
function extractCitations(deck) {
    const out = [];
    (deck.slides || []).forEach((s, si) => {
        (function walk(node) {
            for (const b of kidsOf(node)) {
                if (!b || typeof b !== 'object') continue;
                const text = blockText(b);
                if (text) {
                    ARXIV_RE.lastIndex = 0;
                    let m;
                    while ((m = ARXIV_RE.exec(text)) !== null) {
                        const at = m.index;
                        const context = text.slice(Math.max(0, at - 140), at + m[0].length + 40).trim();
                        out.push({
                            slide: si + 1,
                            blockId: b.id || '?',
                            arxivId: m[1].replace(/v\d+$/, ''),
                            context,
                            names: surnamesIn(context),
                        });
                    }
                }
                walk(b);
            }
        })(s);
    });
    // Same id cited on several slides: keep each site, they can differ.
    return out;
}

const NAME_STOPWORDS = new Set([
    'The', 'This', 'That', 'From', 'With', 'And', 'For', 'See', 'Also', 'But',
    'Phys', 'Rev', 'Lett', 'Nucl', 'JHEP', 'Vol', 'No', 'PRL', 'PRD', 'Eq',
    'Fig', 'Table', 'Section', 'Appendix', 'In', 'At', 'By', 'Of', 'To', 'On',
    'New', 'Note', 'Here', 'We', 'It', 'Our', 'These', 'Those', 'Using', 'Via',
]);

/** Capitalised words that look like surnames (incl. O'Brien, Şuvaiala, van der X). */
function surnamesIn(text) {
    const words = text.match(/\b[A-ZÀ-Þ][\p{L}'’-]{1,}\b/gu) || [];
    const seen = new Set();
    const out = [];
    for (const w of words) {
        if (NAME_STOPWORDS.has(w)) continue;
        if (w.length < 3) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        out.push(w);
    }
    return out;
}

/**
 * Decide whether a resolved record matches the names cited beside it.
 * Deliberately lenient: one surname in common is enough. A transposed id
 * normally shares none, which is the signal worth reporting.
 */
function authorVerdict(citedNames, recordAuthors) {
    const rec = (recordAuthors || []).map(a => lastName(a)).filter(Boolean);
    if (!rec.length) return { status: 'unknown', matched: [], missing: citedNames };
    const recSet = new Set(rec.map(s => s.toLowerCase()));
    const matched = citedNames.filter(n => recSet.has(n.toLowerCase()));
    const candidate = citedNames.filter(n => n.length > 2);
    if (!candidate.length) return { status: 'no_names', matched: [], missing: [] };
    if (matched.length) {
        return {
            status: 'ok', matched,
            missing: candidate.filter(n => !recSet.has(n.toLowerCase())),
        };
    }
    return { status: 'mismatch', matched: [], missing: candidate };
}

function lastName(author) {
    if (!author) return '';
    const s = String(author).trim();
    if (s.includes(',')) return s.split(',')[0].trim();          // "Gromov, Nikolay"
    const parts = s.split(/\s+/);
    return parts[parts.length - 1];
}

module.exports = {
    CANVAS_W, CANVAS_H,
    kidsOf, indexSlide, alignOf, parseEm, isFixedHeight,
    computeFit, rescaleHint, fitLine, formatFitReport,
    typeScale, emSizesInUse, snapDown, DEFAULT_TYPE_SCALE,
    lintSlide, lintFooterLines, aspectWarning, wantsFullWidth,
    lintMathContent, mathRuns, colorSwitches, matchBrace,
    extractCitations, surnamesIn, authorVerdict, lastName, blockText,
};
