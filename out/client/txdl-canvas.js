// A browser-side renderer for TXDL pages.
//
// Input is the wire JSON `wlatex_txdl::json::page_json` emits per page, plus
// glyph outlines from `wlatex_txdl::outline_json`. No bundler, no
// dependencies: this is a plain ES module that runs in a VS Code webview and
// under Node (with a fake Canvas2D) for tests.
//
// Coordinates. Everything in the page JSON is an integer of scaled points
// (65536 sp = 1 pt, 72.27 pt = 1 in) in the DVI convention: x grows right, y
// grows *down*, and a glyph's y is its baseline. The page's (0, 0) is the DVI
// reference point, one inch in from the top-left corner of the paper, so the
// renderer offsets every coordinate by one inch before drawing. Glyph outlines
// are in font units with y *up*, which is why glyphs are drawn with a negative
// y scale.
//
// See README.md for the host contract and the list of approximations.

/** Scaled points in one TeX point. */
export const SP_PER_PT = 65536;
/** TeX points in one inch. */
export const PT_PER_INCH = 72.27;
/**
 * The DVI reference point is one inch from the top-left corner of the paper.
 * xdvipdfmx spells the same offset as 72 bp; 72 bp and 72.27 pt are both one
 * true inch, and this module works in TeX pt throughout.
 */
export const ORIGIN_PT = PT_PER_INCH;

/** US Letter, the size used when a page carries no `media_size_sp`. */
const DEFAULT_MEDIA_PT = [8.5 * PT_PER_INCH, 11 * PT_PER_INCH];

/** Scaled points to TeX points. */
export function spToPt(sp) {
  return sp / SP_PER_PT;
}

/** TeX points to scaled points (rounded, as TeX stores integers). */
export function ptToSp(pt) {
  return Math.round(pt * SP_PER_PT);
}

/**
 * A TXDL `rgba` quadruple (floats 0..1) as a CSS colour string.
 * Fully opaque colours come out as `rgb(r, g, b)` so the common case stays
 * comparable and cheap.
 */
export function rgbaToCss(rgba, fallback = '#000') {
  if (!Array.isArray(rgba) || rgba.length < 3) return fallback;
  const channel = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
  const r = channel(rgba[0]);
  const g = channel(rgba[1]);
  const b = channel(rgba[2]);
  const a = rgba.length > 3 && rgba[3] != null ? Number(rgba[3]) : 1;
  if (!(a < 1)) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${Number(Math.max(0, a).toFixed(3))})`;
}

/**
 * Geometry helpers for one page at one zoom level.
 *
 * `scale` is CSS px per TeX pt. The returned `x`/`y` take scaled points in
 * page (DVI) coordinates and give CSS px from the top-left corner of the
 * paper; `len` converts a bare length.
 */
export function pageToCss(page, scale = 1, options = {}) {
  const media = mediaSizePt(page, options.mediaSize);
  const originX = ORIGIN_PT * scale;
  const originY = ORIGIN_PT * scale;
  const len = (sp) => (sp / SP_PER_PT) * scale;
  const x = (sp) => originX + len(sp);
  const y = (sp) => originY + len(sp);
  return {
    scale,
    widthPt: media[0],
    heightPt: media[1],
    width: media[0] * scale,
    height: media[1] * scale,
    originXPt: ORIGIN_PT,
    originYPt: ORIGIN_PT,
    originX,
    originY,
    pt: spToPt,
    len,
    x,
    y,
    /** A TXDL `{x0,y0,x1,y1}` rectangle in sp as a CSS-px `{x,y,width,height}`. */
    rect(r) {
      if (!r) return null;
      const x0 = Math.min(r.x0, r.x1);
      const x1 = Math.max(r.x0, r.x1);
      const y0 = Math.min(r.y0, r.y1);
      const y1 = Math.max(r.y0, r.y1);
      return { x: x(x0), y: y(y0), width: len(x1 - x0), height: len(y1 - y0) };
    },
  };
}

function mediaSizePt(page, override) {
  if (Array.isArray(override) && override.length === 2) {
    return [Number(override[0]), Number(override[1])];
  }
  const sp = page && page.media_size_sp;
  if (Array.isArray(sp) && sp.length === 2 && sp[0] > 0 && sp[1] > 0) {
    return [spToPt(sp[0]), spToPt(sp[1])];
  }
  return DEFAULT_MEDIA_PT.slice();
}

function fontIndex(fonts) {
  const map = new Map();
  for (const font of fonts || []) {
    if (font && typeof font.definition_digest === 'string') {
      map.set(font.definition_digest, font);
    }
  }
  return map;
}

/**
 * The text of one glyph run.
 *
 * Native runs carry their `ActualText`. TFM runs do not carry text at all, but
 * their glyph ids *are* character codes, so codes below 128 are taken as ASCII
 * and everything else answers U+FFFD. This is for word-level highlighting, not
 * transcription — the same claim the Rust `text_items` makes.
 */
export function runText(op) {
  if (typeof op.text === 'string' && op.text.length > 0) return op.text;
  const glyphs = op.glyphs || [];
  if (op.native) return '�'.repeat(glyphs.length);
  let out = '';
  for (const glyph of glyphs) {
    const id = glyph[0];
    out += id < 128 ? String.fromCharCode(id) : '�';
  }
  return out;
}

/**
 * The page's glyph runs as selectable text boxes, in *TeX points* and page
 * (DVI) coordinates — the shape WPaper's highlight code consumes.
 *
 * `x` is the left edge, `baseline` is the run's DVI v, `h` is the font's
 * scaled size and `w` is the run's advance width. The wire JSON drops per
 * glyph advances, so `w` spans the first to the last glyph origin plus the
 * last glyph's advance, which is taken from `options.advance(fontDigest, gid)`
 * in sp when the caller can supply it (the renderer does, from its outline
 * cache) and is otherwise guessed at half the font size.
 */
export function textLayer(page, fonts = page && page.fonts, options = {}) {
  const index = fontIndex(fonts);
  const items = [];
  for (const op of (page && page.ops) || []) {
    if (op.op !== 'glyphs') continue;
    const glyphs = op.glyphs || [];
    if (glyphs.length === 0) continue;
    const font = index.get(op.font) || null;
    const sizeSp = font && font.size_sp > 0 ? font.size_sp : 0;
    const first = glyphs[0];
    const last = glyphs[glyphs.length - 1];
    let advance = null;
    if (typeof options.advance === 'function') {
      const value = options.advance(op.font, last[0]);
      if (typeof value === 'number' && Number.isFinite(value)) advance = value;
    }
    if (advance == null) advance = sizeSp / 2;
    items.push({
      str: runText(op),
      x: spToPt(first[1]),
      baseline: spToPt(first[2]),
      w: spToPt(last[1] - first[1] + advance),
      h: spToPt(sizeSp),
      font: op.font,
      fontName: font ? font.name : null,
      size: spToPt(sizeSp),
      native: !!op.native,
    });
  }
  return items;
}

/**
 * The page's hyperlinks and named destinations, in sp and page (DVI)
 * coordinates (`pageToCss(...).rect` / `.x` / `.y` place them).
 *
 * A `link` op's rectangle is the union of the ink between its `pdf:bann` and
 * `pdf:eann`. dvipdfmx breaks an annotation at each line end, so a link that
 * wraps has one rectangle per line in the PDF, while the union here also
 * covers the unlinked text on both lines. Those links are marked `multiline`
 * (taller than two lines of the text that follows the `bann`) so a caller can
 * leave them out rather than make neighbouring words clickable.
 */
export function linkLayer(page, fonts = page && page.fonts) {
  const index = fontIndex(fonts);
  const ops = (page && page.ops) || [];
  const links = [];
  const dests = [];
  ops.forEach((op, at) => {
    if (op.op === 'dest' && typeof op.name === 'string') {
      dests.push({ name: op.name, x: op.x, y: op.y });
      return;
    }
    if (op.op !== 'link' || !op.rect || typeof op.target !== 'string' || !op.target) return;
    let lineSp = 0;
    for (let next = at + 1; next < ops.length && !lineSp; next++) {
      const font = ops[next].op === 'glyphs' ? index.get(ops[next].font) : null;
      if (font && font.size_sp > 0) lineSp = font.size_sp * 1.2;
    }
    const height = Math.abs(op.rect.y1 - op.rect.y0);
    links.push({
      rect: op.rect,
      target: op.target,
      external: /^[a-z][a-z0-9+.-]*:/i.test(op.target),
      multiline: lineSp > 0 && height > 2 * lineSp,
    });
  });
  return { links, dests };
}

/** Insertion-ordered cache with a hard bound; the oldest entry is evicted. */
class BoundedCache {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  has(key) {
    return this.map.has(key);
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  delete(key) {
    return this.map.delete(key);
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

const PATH_RE = /([MLQCZmlqcz])([^MLQCZmlqcz]*)/g;
const NUMBER_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

/** Replay an SVG path onto a context, for hosts without `Path2D`. */
function replayPath(ctx, d) {
  ctx.beginPath();
  PATH_RE.lastIndex = 0;
  let match;
  while ((match = PATH_RE.exec(d)) !== null) {
    const command = match[1].toUpperCase();
    const numbers = (match[2].match(NUMBER_RE) || []).map(Number);
    switch (command) {
      case 'M':
        for (let i = 0; i + 1 < numbers.length; i += 2) {
          if (i === 0) ctx.moveTo(numbers[i], numbers[i + 1]);
          else ctx.lineTo(numbers[i], numbers[i + 1]);
        }
        break;
      case 'L':
        for (let i = 0; i + 1 < numbers.length; i += 2) {
          ctx.lineTo(numbers[i], numbers[i + 1]);
        }
        break;
      case 'Q':
        for (let i = 0; i + 3 < numbers.length; i += 4) {
          ctx.quadraticCurveTo(numbers[i], numbers[i + 1], numbers[i + 2], numbers[i + 3]);
        }
        break;
      case 'C':
        for (let i = 0; i + 5 < numbers.length; i += 6) {
          ctx.bezierCurveTo(
            numbers[i],
            numbers[i + 1],
            numbers[i + 2],
            numbers[i + 3],
            numbers[i + 4],
            numbers[i + 5],
          );
        }
        break;
      case 'Z':
        ctx.closePath();
        break;
      default:
        break;
    }
  }
}

const DEFAULTS = {
  maxOutlines: 8192,
  maxPaths: 4096,
  maxImages: 64,
  imageDash: [4, 3],
};

/** Scaled points per PostScript point (bp). */
const SP_PER_BP = (65536 * 72.27) / 72;

/** A TXDL image matrix that places the image as it is (XeTeX's identity). */
function identityMatrix(matrix) {
  return !matrix || (matrix[0] === 65536 && matrix[1] === 0 && matrix[2] === 0 && matrix[3] === 65536 && matrix[4] === 0 && matrix[5] === 0);
}

/**
 * Create a renderer.
 *
 * `requestOutlines(fontDigest, gids)` must resolve to an object keyed by glyph
 * id whose values are `outline_json` objects (or null when the engine cannot
 * outline that glyph). It is the only I/O this module performs, and `render`
 * never waits for it: glyphs whose outline is not cached yet are skipped and
 * counted in the result's `pending`, and the host re-renders when `prefetch`
 * resolves.
 *
 * `requestImage(file, page)` (optional) resolves to `{ source, widthBp,
 * heightBp }` — a drawable (`ImageBitmap`, canvas, image) and the image's
 * natural size — or null when it cannot be drawn. Without it an image is a
 * dashed placeholder; with it, images load like outlines (pending, then
 * drawn), and one that cannot be drawn puts the page on the PDF fallback.
 */
export function createTxdlRenderer(options = {}) {
  /** A drawing surface for pattern tiles. */
  const makeCanvas = (w, h) => {
    if (typeof options.createCanvas === 'function') return options.createCanvas(w, h);
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    return null;
  };
  const requestOutlines = options.requestOutlines;
  if (typeof requestOutlines !== 'function') {
    throw new TypeError('createTxdlRenderer needs a requestOutlines(fontDigest, gids) function');
  }
  const settings = { ...DEFAULTS, ...options };
  const outlines = new BoundedCache(settings.maxOutlines);
  const paths = new BoundedCache(settings.maxPaths);
  const requestImage = typeof options.requestImage === 'function' ? options.requestImage : null;
  const images = new BoundedCache(settings.maxImages);
  const imagesInFlight = new Set();
  const imageKey = (op) => `${op.file}#${op.page == null ? 1 : op.page}`;
  // digest -> Set of gids currently being fetched, so prefetch never asks twice.
  const inFlight = new Map();

  const key = (digest, gid) => `${digest}/${gid}`;

  function pathConstructor() {
    return settings.Path2D || globalThis.Path2D || null;
  }

  /** One `Path2D` per (font digest, gid), built once and cached. */
  function cachedPath(digest, gid, outline, Ctor) {
    const id = key(digest, gid);
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    return paths.set(id, new Ctor(outline.path || ''));
  }

  /** Every (font, gid) the page needs, deduplicated, in first-use order. */
  function pageRequests(page) {
    const wanted = new Map();
    for (const op of (page && page.ops) || []) {
      if (op.op !== 'glyphs' || !op.font) continue;
      let set = wanted.get(op.font);
      if (!set) {
        set = new Set();
        wanted.set(op.font, set);
      }
      for (const glyph of op.glyphs || []) set.add(glyph[0]);
    }
    return wanted;
  }

  async function prefetch(page) {
    const wanted = pageRequests(page);
    const jobs = [];
    const result = { requested: 0, resolved: 0, missing: 0, errors: [] };
    for (const [digest, gids] of wanted) {
      let busy = inFlight.get(digest);
      if (!busy) {
        busy = new Set();
        inFlight.set(digest, busy);
      }
      const ask = [];
      for (const gid of gids) {
        if (outlines.has(key(digest, gid))) continue;
        if (busy.has(gid)) continue;
        busy.add(gid);
        ask.push(gid);
      }
      if (ask.length === 0) {
        if (busy.size === 0) inFlight.delete(digest);
        continue;
      }
      result.requested += ask.length;
      jobs.push(
        Promise.resolve()
          .then(() => requestOutlines(digest, ask))
          .then((answer) => {
            for (const gid of ask) {
              const outline = answer ? answer[gid] ?? answer[String(gid)] ?? null : null;
              outlines.set(key(digest, gid), outline || null);
              if (outline) result.resolved += 1;
              else result.missing += 1;
            }
          })
          .catch((error) => {
            // Leave the cache untouched so a later prefetch can retry.
            result.errors.push({ font: digest, gids: ask, error });
          })
          .then(() => {
            for (const gid of ask) busy.delete(gid);
            if (busy.size === 0) inFlight.delete(digest);
          }),
      );
    }
    if (requestImage) {
      for (const op of (page && page.ops) || []) {
        if (op.op !== 'image' || !op.file) continue;
        const id = imageKey(op);
        if (images.has(id) || imagesInFlight.has(id)) continue;
        imagesInFlight.add(id);
        result.requested += 1;
        jobs.push(
          Promise.resolve()
            .then(() => requestImage(op.file, op.page == null ? null : op.page))
            .then((image) => {
              const usable = image && image.source && image.widthBp > 0 && image.heightBp > 0;
              images.set(id, usable ? image : null);
              if (usable) result.resolved += 1;
              else result.missing += 1;
            })
            .catch((error) => {
              result.errors.push({ image: op.file, error });
            })
            .then(() => imagesInFlight.delete(id)),
        );
      }
    }
    await Promise.all(jobs);
    return result;
  }

  function render(page, ctx, opts = {}) {
    const scale = opts.scale == null ? 1 : opts.scale;
    const dpr = opts.dpr == null ? 1 : opts.dpr;
    const ink = opts.ink == null ? '#000' : opts.ink;
    const background = opts.background === undefined ? '#fff' : opts.background;
    const css = pageToCss(page, scale, { mediaSize: opts.mediaSize });
    const fonts = fontIndex(page && page.fonts);
    const Ctor = pathConstructor();

    const result = {
      width: css.width,
      height: css.height,
      pending: 0,
      skipped: 0,
      glyphs: 0,
      rules: 0,
      images: [],
      links: [],
      missing: [],
      fallback: Array.isArray(page && page.unsupported) && page.unsupported.length > 0,
    };
    const missingByFont = new Map();
    const note = (digest, gid) => {
      let set = missingByFont.get(digest);
      if (!set) {
        set = new Set();
        missingByFont.set(digest, set);
      }
      set.add(gid);
    };

    let fill = null;
    const useFill = (value) => {
      if (fill !== value) {
        ctx.fillStyle = value;
        fill = value;
      }
    };

    ctx.save();
    if (dpr !== 1) ctx.scale(dpr, dpr);
    if (background) {
      useFill(background);
      ctx.fillRect(0, 0, css.width, css.height);
    }

    // The colour stack (`color push/pop`) and the paint state a content
    // stream sets (`rg`, `w`, …); Push/Pop save and restore the latter, and a
    // colour-stack change sets fill and stroke, as dvipdfmx does.
    let color = ink;
    const stack = [];
    let gs = { fill: ink, stroke: ink, lineWidth: 1, cap: 0, join: 0, miter: 10, dash: null, fillPattern: null, fillAlpha: 1, strokeAlpha: 1 };
    // Constant opacity (ExtGState `ca`/`CA`), set just before each paint.
    let alphaNow = 1;
    const useAlpha = (a) => {
      if (alphaNow !== a) {
        ctx.globalAlpha = a;
        alphaNow = a;
      }
    };
    // Tiling patterns defined on this page, and their tiles per colour.
    const patterns = new Map();
    const tiles = new Map();
    const saved = [];
    useFill(color);
    // Open transforms (`pdf:btrans`/`x:gsave`); closed at the page's end.
    let transforms = 0;
    // CSS px per bp, for content-stream coordinates.
    const perBp = css.len(SP_PER_BP);

    /**
     * A CanvasPattern for a tiling pattern fill, anchored to the page's PDF
     * space whatever the current transform. One cell is drawn with its
     * neighbours' overflow (PDF cells may overlap their bounding box), in the
     * fill's colour for an uncoloured pattern. Without canvas support (tests)
     * the fill falls back to its colour.
     */
    function patternStyle(fillPattern) {
      const def = patterns.get(fillPattern.name);
      if (!def || typeof ctx.createPattern !== 'function') return null;
      const color = rgbaToCss(fillPattern.color, gs.fill);
      const key = `${def.name}|${color}`;
      let tile = tiles.get(key);
      const s = perBp * dpr;
      if (tile === undefined) {
        const w = Math.max(1, Math.round(def.xstep * s)), h = Math.max(1, Math.round(def.ystep * s));
        const canvas = makeCanvas(w, h);
        const t = canvas && canvas.getContext('2d');
        tile = null;
        if (t) {
          const sx = w / def.xstep, sy = h / def.ystep;
          for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) {
            for (const shape of def.shapes) {
              const X = (u) => (u + i * def.xstep) * sx, Y = (v) => (def.ystep - (v + j * def.ystep)) * sy;
              t.beginPath();
              for (const seg of shape.segments) {
                if (seg[0] === 'm') t.moveTo(X(seg[1]), Y(seg[2]));
                else if (seg[0] === 'l') t.lineTo(X(seg[1]), Y(seg[2]));
                else if (seg[0] === 'c') t.bezierCurveTo(X(seg[1]), Y(seg[2]), X(seg[3]), Y(seg[4]), X(seg[5]), Y(seg[6]));
                else if (seg[0] === 're') t.rect(X(seg[1]), Y(seg[2]), seg[3] * sx, -seg[4] * sy);
                else if (seg[0] === 'h') t.closePath();
              }
              t.fillStyle = color;
              t.strokeStyle = color;
              if (shape.fill) t.fill(shape.fill === 'evenodd' ? 'evenodd' : 'nonzero');
              if (shape.stroke) { t.lineWidth = Math.max(shape.line_width * sx, 1); t.stroke(); }
            }
          }
          const pattern = ctx.createPattern(canvas, 'repeat');
          tile = pattern && { pattern, sx, sy };
        }
        tiles.set(key, tile);
      }
      if (!tile) return null;
      // Tile pixels → pattern space → the page's default space (`matrix`) →
      // CSS px → device, undone by the transform current at this fill.
      if (typeof tile.pattern.setTransform === 'function' && typeof DOMMatrix === 'function' && ctx.getTransform) {
        const [a, b, c, d, e, f] = def.matrix;
        const img = new DOMMatrix([1 / tile.sx, 0, 0, -1 / tile.sy, 0, def.ystep]);
        const toPage = new DOMMatrix([a, b, c, d, e, f]);
        const toCss = new DOMMatrix([perBp, 0, 0, -perBp, 0, css.height]);
        const device = new DOMMatrix([dpr, 0, 0, dpr, 0, 0]).multiply(toCss).multiply(toPage).multiply(img);
        tile.pattern.setTransform(ctx.getTransform().inverse().multiply(device));
      }
      return tile.pattern;
    }

    for (const op of (page && page.ops) || []) {
      switch (op.op) {
        case 'glyphs': {
          const font = fonts.get(op.font);
          if (!font || !(font.size_sp > 0)) {
            result.skipped += (op.glyphs || []).length;
            break;
          }
          const sizePt = spToPt(font.size_sp);
          useFill(gs.fill);
          useAlpha(gs.fillAlpha);
          // XeTeX's synthetic effects (fontspec FakeSlant/FakeStretch/
          // FakeBold, xeCJK's AutoFake*): 16.16 factors, and an outline
          // stroke width in pt for embolden.
          const extend = font.extend ? font.extend / 65536 : 1;
          const slant = font.slant ? font.slant / 65536 : 0;
          const emboldenPt = font.embolden ? font.embolden / 65536 : 0;
          for (const glyph of op.glyphs || []) {
            const [gid, gx, gy] = glyph;
            const id = key(op.font, gid);
            const outline = outlines.get(id);
            if (outline === undefined) {
              result.pending += 1;
              note(op.font, gid);
              continue;
            }
            if (outline === null) {
              // Known to have no outline: drawing it will never succeed, so it
              // is not pending — the host must not keep re-rendering for it.
              result.skipped += 1;
              continue;
            }
            const upem = outline.units_per_em || 1000;
            const unit = (sizePt * scale) / upem;
            ctx.save();
            ctx.translate(css.x(gx), css.y(gy));
            ctx.scale(unit, -unit); // font units are y-up, the page is y-down
            if (extend !== 1) ctx.scale(extend, 1);
            if (slant) ctx.transform(1, 0, slant, 1, 0, 0);
            const glyphPath = Ctor ? cachedPath(op.font, gid, outline, Ctor) : null;
            if (glyphPath) {
              ctx.fill(glyphPath);
            } else {
              replayPath(ctx, outline.path || '');
              ctx.fill();
            }
            if (emboldenPt > 0) {
              ctx.lineWidth = (emboldenPt * upem) / sizePt;
              ctx.lineJoin = 'round';
              ctx.strokeStyle = gs.fill;
              if (glyphPath) ctx.stroke(glyphPath);
              else ctx.stroke();
            }
            ctx.restore();
            result.glyphs += 1;
          }
          break;
        }
        case 'rule': {
          if (!(op.w > 0) || !(op.h > 0)) break; // DVI: only positive rules paint
          useFill(gs.fill);
          useAlpha(gs.fillAlpha);
          // `y` is the rule's bottom edge; it extends up by `h`.
          ctx.fillRect(css.x(op.x), css.y(op.y - op.h), css.len(op.w), css.len(op.h));
          result.rules += 1;
          break;
        }
        case 'color': {
          if (op.action === 'push') {
            stack.push(color);
            color = rgbaToCss(op.rgba, color);
          } else if (op.action === 'pop') {
            color = stack.length > 0 ? stack.pop() : ink;
          } else if (op.action === 'set') {
            color = rgbaToCss(op.rgba, color);
          }
          gs.fill = color;
          gs.stroke = color;
          useFill(color);
          break;
        }
        case 'pattern': {
          patterns.set(op.name, op);
          break;
        }
        case 'shade': {
          // A smooth shading over its form's box, under the current
          // transform and clip (pgf shadings).
          const ox = css.x(op.x), oy = css.y(op.y);
          const P = (u, v) => [ox + perBp * u, oy - perBp * v];
          const c = op.coords || [];
          let gradient = null;
          if (op.kind === 'axial' && c.length === 4 && ctx.createLinearGradient) {
            gradient = ctx.createLinearGradient(...P(c[0], c[1]), ...P(c[2], c[3]));
          } else if (op.kind === 'radial' && c.length === 6 && ctx.createRadialGradient) {
            gradient = ctx.createRadialGradient(...P(c[0], c[1]), c[2] * perBp, ...P(c[3], c[4]), c[5] * perBp);
          }
          if (!gradient) break;
          for (const [t, rgba] of op.stops || []) gradient.addColorStop(Math.max(0, Math.min(1, t)), rgbaToCss(rgba, gs.fill));
          const [x0, y0] = P(op.bbox[0], op.bbox[3]);
          const [x1, y1] = P(op.bbox[2], op.bbox[1]);
          useAlpha(gs.fillAlpha);
          ctx.fillStyle = gradient;
          fill = null;
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          result.shades = (result.shades || 0) + 1;
          break;
        }
        case 'gstate': {
          if (op.reset_color) {
            gs.fill = color;
            gs.stroke = color;
          }
          if (op.fill) gs.fill = rgbaToCss(op.fill, gs.fill);
          if (op.stroke) gs.stroke = rgbaToCss(op.stroke, gs.stroke);
          if (op.line_width != null) gs.lineWidth = op.line_width;
          if (op.line_cap != null) gs.cap = op.line_cap;
          if (op.line_join != null) gs.join = op.line_join;
          if (op.miter_limit != null) gs.miter = op.miter_limit;
          if (op.dash) gs.dash = op.dash;
          if (op.fill_alpha != null) gs.fillAlpha = op.fill_alpha;
          if (op.stroke_alpha != null) gs.strokeAlpha = op.stroke_alpha;
          if (op.fill_pattern) gs.fillPattern = op.fill_pattern;
          else if (op.fill) gs.fillPattern = null;
          break;
        }
        case 'path': {
          const px = (u) => css.x(op.x) + perBp * u;
          const py = (v) => css.y(op.y) - perBp * v;
          ctx.beginPath();
          for (const seg of op.segments || []) {
            if (seg[0] === 'm') ctx.moveTo(px(seg[1]), py(seg[2]));
            else if (seg[0] === 'l') ctx.lineTo(px(seg[1]), py(seg[2]));
            else if (seg[0] === 'c') ctx.bezierCurveTo(px(seg[1]), py(seg[2]), px(seg[3]), py(seg[4]), px(seg[5]), py(seg[6]));
            else if (seg[0] === 're') ctx.rect(px(seg[1]), py(seg[2]), perBp * seg[3], -perBp * seg[4]);
            else if (seg[0] === 'h') ctx.closePath();
          }
          if (op.fill) {
            useAlpha(gs.fillAlpha);
            const style = gs.fillPattern ? patternStyle(gs.fillPattern) : null;
            if (style) {
              ctx.fillStyle = style;
              fill = null;
            } else useFill(gs.fill);
            ctx.fill(op.fill === 'evenodd' ? 'evenodd' : 'nonzero');
          }
          if (op.stroke) {
            useAlpha(gs.strokeAlpha);
            ctx.strokeStyle = gs.stroke;
            // Never thinner than a device pixel (PDF's zero width means that
            // too), as PDF rasterisers draw hairlines such as TikZ's
            // `very thin`.
            ctx.lineWidth = Math.max(gs.lineWidth * perBp, 1 / dpr);
            ctx.lineCap = ['butt', 'round', 'square'][gs.cap] || 'butt';
            ctx.lineJoin = ['miter', 'round', 'bevel'][gs.join] || 'miter';
            ctx.miterLimit = gs.miter;
            if (ctx.setLineDash) {
              ctx.setLineDash(gs.dash ? gs.dash.array.map((x) => x * perBp) : []);
              ctx.lineDashOffset = gs.dash ? gs.dash.phase * perBp : 0;
            }
            ctx.stroke();
          }
          if (op.clip) ctx.clip(op.clip === 'evenodd' ? 'evenodd' : 'nonzero');
          result.paths = (result.paths || 0) + 1;
          break;
        }
        case 'transform': {
          if (op.action === 'push') {
            ctx.save();
            saved.push({ ...gs });
            transforms += 1;
          } else if (op.action === 'pop') {
            if (transforms > 0) {
              ctx.restore();
              gs = saved.pop();
              transforms -= 1;
              fill = null; // the restore reverted the context's fill
              alphaNow = null; // and its alpha
            }
          } else if (op.action === 'set' && Array.isArray(op.matrix)) {
            // The whole transform, as a map of DVI space onto itself (see
            // TXDL `TransformOp::Set`), conjugated into CSS px.
            const [a, b, c, d, e, f] = op.matrix;
            const s = css.len(1);
            const ox = css.originX;
            const oy = css.originY;
            const ce = ox - (a * ox + c * oy) + s * e;
            const cf = oy - (b * ox + d * oy) + s * f;
            ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * ce, dpr * cf);
          } else {
            const ox = css.x(op.x);
            const oy = css.y(op.y);
            ctx.translate(ox, oy);
            if (op.action === 'scale') ctx.scale(op.sx, op.sy);
            else if (op.action === 'rotate') ctx.rotate((-op.degrees * Math.PI) / 180); // PDF angles are counter-clockwise, the page is y-down
            ctx.translate(-ox, -oy);
          }
          break;
        }
        case 'image': {
          if (requestImage) {
            if (!identityMatrix(op.matrix)) {
              result.fallback = true;
              break;
            }
            const image = images.get(imageKey(op));
            if (image === undefined) {
              result.pending += 1;
              result.images.push({ file: op.file, page: op.page == null ? null : op.page, rect: null, pending: true });
              break;
            }
            if (image === null) {
              result.fallback = true;
              break;
            }
            let w = op.w;
            let h = op.h;
            const naturalW = image.widthBp * SP_PER_BP;
            const naturalH = image.heightBp * SP_PER_BP;
            if (!(w > 0 && h > 0)) {
              if (w > 0) h = (w * naturalH) / naturalW;
              else if (h > 0) w = (h * naturalW) / naturalH;
              else {
                w = naturalW;
                h = naturalH;
              }
            }
            const drawn = { x: css.x(op.x), y: css.y(op.y - h), width: css.len(w), height: css.len(h) };
            useAlpha(gs.fillAlpha);
            ctx.drawImage(image.source, drawn.x, drawn.y, drawn.width, drawn.height);
            result.images.push({ file: op.file, page: op.page == null ? null : op.page, rect: drawn });
            break;
          }
          const box =
            op.w > 0 && op.h > 0
              ? {
                  x: css.x(op.x),
                  y: css.y(op.y - op.h),
                  width: css.len(op.w),
                  height: css.len(op.h),
                }
              : null;
          result.images.push({ file: op.file, page: op.page == null ? null : op.page, rect: box });
          if (box) drawPlaceholder(ctx, box, color, settings.imageDash);
          break;
        }
        case 'link': {
          const box = css.rect(op.rect);
          if (box) result.links.push({ rect: box, target: op.target });
          break;
        }
        case 'dest':
        case 'annotation':
        case 'special':
        default:
          break; // no ink here; `unsupported` already set `fallback`
      }
    }

    while (transforms > 0) {
      ctx.restore();
      transforms -= 1;
    }
    ctx.restore();
    for (const [digest, gids] of missingByFont) {
      result.missing.push({ font: digest, gids: [...gids] });
    }
    return result;
  }

  function drawPlaceholder(ctx, box, color, dash) {
    ctx.save();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(0, box.width - 1), Math.max(0, box.height - 1));
    ctx.restore();
  }

  /** `textLayer` with the cache's real advances where they are known. */
  function textLayerFor(page, fonts = page && page.fonts) {
    const index = fontIndex(fonts);
    return textLayer(page, fonts, {
      advance(digest, gid) {
        const outline = outlines.get(key(digest, gid));
        const font = index.get(digest);
        if (!outline || !font || !outline.units_per_em) return null;
        return (outline.advance / outline.units_per_em) * font.size_sp;
      },
    });
  }

  /**
   * The page's text one glyph at a time, in TeX points like `textLayer`:
   * `[{str, x, baseline, w, h}]`. A glyph's character comes from the outline
   * cache (the engine sends what each glyph stands for: the font's cmap
   * reversed, or a TFM font's encoding) — so `prefetch(page)` first. A run
   * with ActualText stays one item with that text; a glyph with no known
   * character is U+FFFD. Gaps between glyphs are where the words break.
   */
  function glyphText(page, fonts = page && page.fonts) {
    const index = fontIndex(fonts);
    const items = [];
    for (const op of (page && page.ops) || []) {
      if (op.op !== 'glyphs') continue;
      const glyphs = op.glyphs || [];
      if (!glyphs.length) continue;
      const font = index.get(op.font) || null;
      const size = font && font.size_sp > 0 ? font.size_sp : 0;
      const advance = gid => {
        const outline = outlines.get(key(op.font, gid));
        return outline && outline.units_per_em ? (outline.advance / outline.units_per_em) * size : size / 2;
      };
      if (typeof op.text === 'string' && op.text.length > 0) {
        const first = glyphs[0], last = glyphs[glyphs.length - 1];
        items.push({ str: op.text, x: spToPt(first[1]), baseline: spToPt(first[2]),
          w: spToPt(last[1] - first[1] + advance(last[0])), h: spToPt(size) });
        continue;
      }
      for (const [gid, x, y] of glyphs) {
        const outline = outlines.get(key(op.font, gid));
        const str = outline && typeof outline.text === 'string' ? outline.text
          : !op.native && gid < 128 ? String.fromCharCode(gid) : '\uFFFD';
        items.push({ str, x: spToPt(x), baseline: spToPt(y), w: spToPt(advance(gid)), h: spToPt(size) });
      }
    }
    return items;
  }

  return {
    render,
    prefetch,
    glyphText,
    textLayer: textLayerFor,
    pageToCss,
    /** Forget loaded figures (the files may have changed on disk). */
    clearImages() {
      images.clear();
    },
    /** Seed the cache directly (the host may already hold outlines). */
    putOutline(digest, gid, outline) {
      outlines.set(key(digest, gid), outline || null);
      paths.delete(key(digest, gid));
    },
    hasOutline(digest, gid) {
      return outlines.has(key(digest, gid));
    },
    pageRequests,
    clearCache() {
      outlines.clear();
      paths.clear();
      inFlight.clear();
    },
    stats() {
      return { outlines: outlines.size, paths: paths.size, inFlight: inFlight.size };
    },
  };
}

export default createTxdlRenderer;
