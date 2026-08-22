// glyphMap.js — the GlyphMap: the render map READ OFF THE ENGINE.
//
// Pure: no vscode. A RenderMap whose answers come from `resources/tex/wbmap.lua`
// — per printed glyph the exact box (bp), font, char, and the source (file,
// line) that produced it — instead of being inferred from SyncTeX records and
// the PDF's text layer. Everything RenderMap promised still holds (same method
// names, same shapes, same honesty flags, same edit translation); the SyncTeX
// document is kept underneath as the fallback for what carries no glyph — a
// figure's interior, a TikZ picture — and for a generation the hook could not
// instrument.
//
// WHY THIS EXISTS: Internal Docs/wolfbook-tex/GLYPHMAP_PLAN.md. Measured on the
// reference paper (Experiments/wolfbook-tex/h-glyphmap): 1413/1413 glyph boxes
// on page 1 contain their ink to ±0.6 bp; prose and line-by-line display maths
// are attributed to the exact source line; a `\bx` macro's glyph is filed at
// the call site.
//
// WHAT THE ENGINE CANNOT SAY, AND HOW IT IS RECOVERED HERE: anything TeX reads
// ahead as a whole — a multi-line `\caption{}`, `\section{}`, `\boxed{}`, an
// amsmath `align` body — files all of its glyphs under the LAST line of the
// construct; `\maketitle` and `\paragraph` peek one line ahead and file one
// line LATE. Those are "collected constructs": `window()` finds the range of
// glyph-less source lines that ends at a collector line, and `lineMap()` aligns
// the construct's projection against its exact glyph sequence (glyphAlign, fed
// with exact items instead of pdf.js runs). Prose is monotone so that alignment
// is essentially exact; maths reuses the canonical ordering already measured.

const fs = require('fs');
const path = require('path');
const { RenderMap, FLAG } = require('./renderMap');
const { sourceTokens, align, keyOf } = require('./glyphAlign');

// ------------------------------------------------------------- TFM tables ----
//
// A Type1 font loaded through its .tfm reports a SLOT, not a Unicode point.
// These are the standard TeX encodings, enough to give the alignment real
// identity for letters, digits and the common symbols. Anything unmapped
// becomes U+0000 — "unnameable", which glyphAlign already treats as a wildcard
// placed by context (the same mechanism that places a stretched `\bigl(`).

const OT1_LOW = ['Γ', 'Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Υ', 'Φ', 'Ψ', 'Ω', 'ff', 'fi', 'fl', 'ffi', 'ffl',
    'ı', 'ȷ', '`', '´', 'ˇ', '˘', '¯', '˚', '¸', 'ß', 'æ', 'œ', 'ø', 'Æ', 'Œ', 'Ø'];
const OT1_HIGH = { 34: '”', 39: '’', 60: '¡', 62: '¿', 92: '“', 94: 'ˆ', 95: '˙', 123: '–', 124: '—', 125: '˝', 126: '˜', 127: '¨' };
const OT1_TT_HIGH = { 94: 'ˆ', 95: '˙', 126: '˜', 127: '¨' };
const OML = ['Γ', 'Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Υ', 'Φ', 'Ψ', 'Ω',
    // \epsilon 15 → ϵ, \phi 30 → ϕ, \varepsilon 34 → ε, \varphi 39 → φ — the
    // same letters texWords.SYMBOL_GLYPHS gives those commands, or a \phi can
    // never pair with the ϕ it prints.
    'α', 'β', 'γ', 'δ', 'ϵ', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'π', 'ρ', 'σ', 'τ', 'υ', 'ϕ', 'χ', 'ψ', 'ω',
    'ε', 'ϑ', 'ϖ', 'ϱ', 'ς', 'φ', '↼', '↽', '⇀', '⇁', '↪', '↩', '▹', '◃',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', ',', '<', '/', '>', '⋆', '∂'];
const OML_HIGH = { 91: '♭', 92: '♮', 93: '♯', 94: '⌣', 95: '⌢', 96: 'ℓ', 123: 'ı', 124: 'ȷ', 125: '℘', 126: '→', 127: '⁀' };
const OMS = ['−', '·', '×', '∗', '÷', '⋄', '±', '∓', '⊕', '⊖', '⊗', '⊘', '⊙', '○', '∘', '•',
    '≍', '≡', '⊆', '⊇', '≤', '≥', '≼', '≽', '∼', '≈', '⊂', '⊃', '≪', '≫', '≺', '≻',
    '←', '→', '↑', '↓', '↔', '↗', '↘', '≃', '⇐', '⇒', '⇑', '⇓', '⇔', '↖', '↙', '∝',
    '′', '∞', '∈', '∋', '△', '▽', '̸', '↦', '∀', '∃', '¬', '∅', 'ℜ', 'ℑ', '⊤', '⊥', 'ℵ'];
const OMS_HIGH = { 91: '∪', 92: '∩', 93: '⊎', 94: '∧', 95: '∨', 96: '⊢', 97: '⊣', 98: '⌊', 99: '⌋', 100: '⌈', 101: '⌉',
    102: '{', 103: '}', 104: '⟨', 105: '⟩', 106: '|', 107: '∥', 108: '↕', 109: '⇕', 110: '\\', 111: '≀', 112: '√',
    113: '∐', 114: '∇', 115: '∫', 116: '⊔', 117: '⊓', 118: '⊑', 119: '⊒', 120: '§', 121: '†', 122: '‡', 123: '¶',
    124: '♣', 125: '♢', 126: '♡', 127: '♠' };
// cmex: delimiters in four sizes plus the big operators. Everything else is an
// extensible piece with no character of its own.
const OMX = {};
for (const [ch, slots] of [
    ['(', [0, 16, 18, 32, 48]], [')', [1, 17, 19, 33, 49]], ['[', [2, 20, 34, 50]], [']', [3, 21, 35, 51]],
    ['⌊', [4, 22, 36, 52]], ['⌋', [5, 23, 37, 53]], ['⌈', [6, 24, 38, 54]], ['⌉', [7, 25, 39, 55]],
    ['{', [8, 26, 40, 56]], ['}', [9, 27, 41, 57]], ['⟨', [10, 28, 42, 58]], ['⟩', [11, 29, 43, 59]],
    ['|', [12, 30, 44, 60]], ['∥', [13, 31, 45, 61]], ['/', [14, 46]], ['\\', [15, 47]],
    ['∑', [80, 88]], ['∏', [81, 89]], ['∫', [82, 90]], ['⋃', [83, 91]], ['⋂', [84, 92]], ['⊎', [85, 93]],
    ['∧', [86, 94]], ['∨', [87, 95]], ['∐', [96, 97]], ['√', [112, 113, 114, 115, 116]], ['∮', [72, 73]],
    ['⊕', [76, 77]], ['⊗', [78, 79]], ['⊙', [74, 75]], ['↑', [120]], ['↓', [121]], ['⇑', [126]], ['⇓', [127]],
]) for (const s of slots) OMX[s] = ch;

function tfmFamily(name) {
    const n = String(name || '').toLowerCase();
    if (/^cmmi|^cmmib/.test(n)) return 'OML';
    if (/^cmsy|^cmbsy/.test(n)) return 'OMS';
    if (/^cmex/.test(n)) return 'OMX';
    if (/^cm(tt|vtt|itt|sltt|tex)/.test(n)) return 'OT1TT';
    if (/^cm(r|bx|ti|sl|ss|csc|b|u|dunh|fib|ff|fi|ssi|ssbx|ssdc|ssq|ssqi|bxti|bxsl|inch)\d/.test(n)) return 'OT1';
    if (/^msam/.test(n)) return 'AMSA';
    if (/^msbm/.test(n)) return 'AMSB';
    if (/^eu[fsrb][mb]/.test(n) || /^rsfs/.test(n)) return 'LETTERS';
    if (/^(ec|tc|lm|qcs|qpl|qtm|qag|qbk|qhv|pazo|pnc|ptm|phv|pcr|pbk|pag|pzc|put|pl[rs])/.test(n)) return 'T1';
    return 'ASCII';
}

const UNK = '\u0000';   // unnameable: a wildcard the alignment places by context

/** The character a TFM slot prints, or UNK when it has no name here. */
function tfmChar(fontName, slot) {
    const fam = tfmFamily(fontName);
    if (slot >= 32 && slot < 127) {
        if (fam === 'OML') {
            if (slot === 32) return 'ψ';
            if (slot < OML.length) return OML[slot];
            if (slot >= 65 && slot <= 90) return String.fromCharCode(slot);
            if (slot >= 97 && slot <= 122) return String.fromCharCode(slot);
            return OML_HIGH[slot] || UNK;
        }
        if (fam === 'OMS') {
            if (slot < OMS.length) return OMS[slot];
            if (slot >= 65 && slot <= 90) return String.fromCharCode(slot);   // calligraphic → base letter
            return OMS_HIGH[slot] || UNK;
        }
        if (fam === 'OMX') return OMX[slot] || UNK;
        if (fam === 'AMSB') return (slot >= 65 && slot <= 90) ? String.fromCharCode(slot) : UNK;
        if (fam === 'AMSA') return UNK;
        if (fam === 'LETTERS') return (slot >= 65 && slot <= 90) || (slot >= 97 && slot <= 122)
            ? String.fromCharCode(slot) : UNK;
        if (fam === 'OT1') return OT1_HIGH[slot] || String.fromCharCode(slot);
        if (fam === 'OT1TT') return OT1_TT_HIGH[slot] || String.fromCharCode(slot);
        return String.fromCharCode(slot);
    }
    if (slot < 32) {
        if (fam === 'OML') return OML[slot] || UNK;
        if (fam === 'OMS') return OMS[slot] || UNK;
        if (fam === 'OMX') return OMX[slot] || UNK;
        if (fam === 'OT1' || fam === 'OT1TT') return OT1_LOW[slot] || UNK;
        if (fam === 'T1') return ({ 21: '–', 22: '—', 27: 'ff', 28: 'fi', 29: 'fl', 30: 'ffi', 31: 'ffl' })[slot] || UNK;
        return UNK;
    }
    if (fam === 'OML') return OML_HIGH[slot] || UNK;
    if (fam === 'OMS') return OMS_HIGH[slot] || UNK;
    if (fam === 'OMX') return OMX[slot] || UNK;
    if (fam === 'OT1') return OT1_HIGH[slot] || UNK;
    if (fam === 'T1' && slot >= 128) {
        // T1 128+: accented Latin letters. Fold to the base letter the way the
        // projection folds them, since the source spells them as \'e etc.
        try { return String.fromCharCode(slot).normalize('NFD')[0] || UNK; } catch (_) { return UNK; }
    }
    return UNK;
}

// ------------------------------------------------------------ the record -----

const KIND = { TEXT: 0, INLINE: 1, DISPLAY: 2, EQNO: 3, CELL: 4, FURNITURE: 5 };
const LV = { BASE: 0, ABOVE: 1, BELOW: 2 };

/**
 * Read a glyphmap JSONL + meta pair into a plain record. Never throws on a
 * damaged page line — a crash mid-compile leaves earlier pages valid, and
 * those pages are still worth having.
 */
function readGlyphMap(jsonlPath, metaPath) {
    const text = fs.readFileSync(jsonlPath, 'utf8');
    let meta = { files: {}, fonts: {} };
    if (metaPath && fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { /* partial meta */ }
    }
    const pages = new Map();
    const fonts = new Map();
    for (const [id, f] of Object.entries(meta.fonts || {})) {
        const fmt = String(f.format || '').toLowerCase();
        fonts.set(Number(id), {
            id: Number(id), name: f.name || '?', psname: f.psname || null, format: fmt,
            size: Number(f.size) || 0,
            unicode: fmt === 'opentype' || fmt === 'truetype',
            family: (fmt === 'opentype' || fmt === 'truetype') ? 'UNICODE' : tfmFamily(f.name),
        });
    }
    const files = new Map();
    for (const [id, p] of Object.entries(meta.files || {})) files.set(Number(id), p);

    let header = null;
    let seq = 0;
    let furniture = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        if (rec && rec.v && !rec.p) { header = rec; continue; }
        if (!rec || !Number.isFinite(rec.p)) continue;
        const glyphs = [];
        for (const g of rec.g || []) {
            if (!Array.isArray(g) || g.length < 12) continue;
            // Page furniture (kind 5: running heads, page numbers) is not the
            // source's ink; it is counted and dropped.
            if (g[10] === 5) { furniture++; continue; }
            const font = fonts.get(g[5]) || null;
            const code = g[6];
            let str;
            if (g[12]) {
                // A ligature: the component chars, spelled out.
                const parts = String(g[12]).split(',').map(Number).filter(Number.isFinite);
                str = parts.map(c => (font && !font.unicode) ? tfmChar(font.name, c) : safeChar(c)).join('');
            } else {
                str = (font && !font.unicode) ? tfmChar(font ? font.name : '', code) : safeChar(code);
            }
            // THE EM BOX IS WHAT A CLICK MEANS; THE INK BOX IS WHAT A HIGHLIGHT
            // PAINTS. A subscript m is 4 bp of ink, and a hand (or pdf.js's
            // text item, which the browser harness clicks by) aims at the
            // centre of the em box, a few bp below it — measured: with ink-box
            // distances the neighbouring comma won the click. Ascent 0.75 em,
            // descent 0.25 em, from the font's design size.
            const sz = (font && font.size > 0 ? font.size : 10) * (72 / 72.27);
            // AN ACCENT MARK'S BOX IS MOSTLY EMPTY: the dot of `\dot x` sits at
            // the top of a box as tall as an x-height plus the dot, so its "ink
            // centre" lies over the base and a click on the x picked the mark
            // (measured: every base of a \dot answered "\dot"). The mark's hit
            // box is therefore its upper part only — a click on the dot still
            // finds it; a click on the base does not.
            const mark = isAccentMark(font, code, str);
            let emTop = g[1] - 0.75 * sz; let emBottom = g[1] + 0.25 * sz;
            if (mark) emBottom = Math.min(emBottom, g[1] - g[3] * 0.7);
            glyphs.push({
                i: seq++,
                page: rec.p,
                x: g[0], baseline: g[1], w: g[2], h: g[3], d: g[4],
                emTop, emBottom, mark,
                fontId: g[5], code,
                str,
                fileId: g[7], line: g[8],
                row: g[9], kind: g[10], lv: g[11],
            });
        }
        pages.set(rec.p, { page: rec.p, W: rec.W, H: rec.H, glyphs });
    }
    return { header, pages, fonts, files, pageCount: pages.size, furniture };
}

/** Is this glyph an accent mark (printed over a base), by font slot or char? */
const MARK_CHARS = new Set(['˙', 'ˆ', '˜', '¨', '¯', '˘', 'ˇ', '´', '`', '˚', '¸', '˝', '⃗', '\u0302', '\u0303', '\u0307', '\u0308', '\u0304', '\u0306', '\u030C', '\u0301', '\u0300', '\u030A']);
function isAccentMark(font, code, str) {
    if (font && !font.unicode) {
        const fam = font.family;
        if ((fam === 'OT1' || fam === 'OT1TT') && ((code >= 18 && code <= 24) || code === 94 || code === 95 || code === 126 || code === 127)) return true;
        if (fam === 'OML' && code === 126) return true;     // \vec
        if (fam === 'OMX' && (code >= 98 && code <= 103)) return true;   // \widehat \widetilde
        return false;
    }
    return MARK_CHARS.has(str);
}

function safeChar(code) {
    if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return UNK;
    if (code < 32 || (code >= 0xD800 && code <= 0xDFFF)) return UNK;
    try { return String.fromCodePoint(code); } catch (_) { return UNK; }
}

// --------------------------------------------------------------- the map -----

const GRID = 16;   // bp; hit-test cells

class GlyphMap extends RenderMap {
    /**
     * @param {object} o  everything RenderMap takes, plus
     * @param {object} [o.glyphDoc]  a record from readGlyphMap to reuse
     */
    constructor(o = {}) {
        super(o);
        this.gm = null;
        this._byLine = new Map();      // `${fileId}|${line}` -> glyph[] (print order)
        this._grid = new Map();        // page -> Map(cellKey -> glyph[])
        this._fileIdByPath = new Map();
        this._pathByFileId = new Map();
        this._winCache = new Map();
        this._mapCache = new Map();
        this._rowsCache = new Map();

        const gen = this.generation;
        let doc = o.glyphDoc || null;
        if (!doc && gen && gen.glyphMapPath && fs.existsSync(gen.glyphMapPath)) {
            try { doc = readGlyphMap(gen.glyphMapPath, gen.glyphMapMetaPath); }
            catch (e) { this.warnings.push(`glyphmap unreadable: ${e.message}`); doc = null; }
        }
        if (doc && doc.pages.size) {
            this.gm = doc;
            this._index();
            if (!this.pageCount) this.pageCount = doc.pageCount;
        }
    }

    /** Is there any map at all (exact or SyncTeX)? */
    get available() { return !!this.gm || super.available; }
    /** Is the EXACT map present for this generation? */
    get exact() { return !!this.gm; }

    _index() {
        const od = this.generation && this.generation.overlayDir;
        const pd = this.generation && this.generation.projectDir;
        for (const [id, p0] of this.gm.files) {
            let p = p0;
            // The live overlay: SyncTeX/wbmap saw `_wblive/...`; everyone else
            // knows the project path. Mapped once, at the boundary.
            if (od && pd && p.startsWith(od)) p = pd + p.slice(od.length);
            p = path.normalize(p);
            this._pathByFileId.set(id, p);
            this._fileIdByPath.set(p, id);
            // Also by real path, so a symlinked project still resolves.
            try {
                const rp = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
                if (rp && rp !== p && !this._fileIdByPath.has(rp)) this._fileIdByPath.set(rp, id);
            } catch (_) { /* the path may not exist on this machine */ }
        }
        for (const pg of this.gm.pages.values()) {
            const cells = new Map();
            this._grid.set(pg.page, cells);
            for (const g of pg.glyphs) {
                const k = `${g.fileId}|${g.line}`;
                let l = this._byLine.get(k);
                if (!l) { l = []; this._byLine.set(k, l); }
                l.push(g);
                // A glyph may straddle cells; register it in each it touches.
                const cx0 = Math.floor(g.x / GRID); const cx1 = Math.floor((g.x + g.w) / GRID);
                const cy0 = Math.floor(Math.min(g.emTop, g.baseline - g.h) / GRID); const cy1 = Math.floor(Math.max(g.emBottom, g.baseline + g.d) / GRID);
                for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
                    const ck = cx * 100000 + cy;
                    let c = cells.get(ck);
                    if (!c) { c = []; cells.set(ck, c); }
                    c.push(g);
                }
            }
        }
    }

    _fileId(file) {
        if (!this.gm) return null;
        if (this._fileIdByPath.has(file)) return this._fileIdByPath.get(file);
        const n = path.normalize(file);
        if (this._fileIdByPath.has(n)) return this._fileIdByPath.get(n);
        try {
            const rp = fs.realpathSync.native ? fs.realpathSync.native(n) : fs.realpathSync(n);
            if (this._fileIdByPath.has(rp)) return this._fileIdByPath.get(rp);
        } catch (_) { /* fine */ }
        // Basename fallback, like RenderMap._tag: a project moved since compile.
        const base = path.basename(n);
        for (const [p, id] of this._fileIdByPath) if (path.basename(p) === base) return id;
        return null;
    }

    fileOf(fileId) { return this._pathByFileId.get(fileId) || null; }

    /** The glyphs a CURRENT source line produced, in print order. */
    glyphsForLine(file, line) {
        const id = this._fileId(file);
        if (id == null) return [];
        const g = this._toGenerationLine(file, line);
        return this._byLine.get(`${id}|${g.line}`) || [];
    }

    /** The glyphs of a generation line, by file id (internal). */
    _glyphsGen(fileId, genLine) { return this._byLine.get(`${fileId}|${genLine}`) || []; }

    /** A font's record, for callers that want to know what printed. */
    fontOf(glyph) { return (this.gm && this.gm.fonts.get(glyph.fontId)) || null; }

    // ------------------------------------------------------------ hit test --

    /**
     * The glyph nearest a point, and how far (bp). Vertical distance counts
     * double, as in glyphAlign.glyphAtPoint — on a dense page the glyph on the
     * next line is often horizontally closer than the right one.
     */
    glyphAt(page, xBp, yTopBp, opts = {}) {
        if (!this.gm) return { glyph: null, distance: Infinity };
        const cells = this._grid.get(page);
        if (!cells) return { glyph: null, distance: Infinity };
        const reach = Number.isFinite(opts.reach) ? opts.reach : 18;
        const r = Math.ceil(reach / GRID) + 1;
        const cx = Math.floor(xBp / GRID); const cy = Math.floor(yTopBp / GRID);
        let best = null; let bestD = Infinity;
        const seen = new Set();
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
            const c = cells.get((cx + dx) * 100000 + (cy + dy));
            if (!c) continue;
            for (const g of c) {
                if (seen.has(g.i)) continue;
                seen.add(g.i);
                if (opts.skipKinds && opts.skipKinds.has(g.kind)) continue;
                const top = g.emTop; const bottom = g.emBottom;
                const ddx = xBp < g.x ? g.x - xBp : (xBp > g.x + g.w ? xBp - (g.x + g.w) : 0);
                const ddy = yTopBp < top ? top - yTopBp : (yTopBp > bottom ? yTopBp - bottom : 0);
                // Em-box containment first; among the boxes that contain the
                // point, one whose INK contains it (a base under its accent:
                // the mark's box is reduced to the mark) beats one that does
                // not; then the nearest ink centre.
                const inkTop = g.mark ? g.emTop : g.baseline - g.h;
                const inkBottom = g.mark ? g.emBottom : g.baseline + g.d;
                const inkHas = ddx === 0 && yTopBp >= inkTop && yTopBp <= inkBottom;
                const cx = g.x + g.w / 2; const cy = (inkTop + inkBottom) / 2;
                const d = Math.hypot(ddx, ddy * 2) * 10 + (inkHas ? 0 : 5) + Math.hypot(xBp - cx, yTopBp - cy) / 100;
                if (d < bestD) { bestD = d; best = g; }
            }
        }
        // `distance` is the plain em-box distance the callers reason in.
        const dist = best ? bestD / 10 : bestD;
        if (!best || dist > reach) return { glyph: null, distance: dist };
        return { glyph: best, distance: dist };
    }

    // ------------------------------------------------------------- rows -----

    /**
     * The printed rows of a generation line's glyphs: one rect per (page, row
     * id), in bp top-left frame, plus `xs` for column refinement. A row id is
     * what the engine called one stacked box — a paragraph line, a display, an
     * align row — so nothing here estimates a leading.
     */
    _rowsOf(glyphs, opts = {}) {
        const byRow = new Map();
        for (const g of glyphs) {
            // THE EQUATION NUMBER IS THE ENGINE'S INK, NOT THE LINE'S. It sits
            // in the display's row, flush to the margin, so a row union that
            // includes it paints out to the page edge. Left out unless asked.
            if (g.kind === KIND.EQNO && !opts.withTags) continue;
            const k = `${g.page}|${g.row}`;
            let r = byRow.get(k);
            if (!r) {
                r = { page: g.page, row: g.row, x0: Infinity, x1: -Infinity, top: Infinity, bottom: -Infinity, base: g.baseline, xs: [], n: 0 };
                byRow.set(k, r);
            }
            const top = g.baseline - g.h; const bottom = g.baseline + g.d;
            if (g.x < r.x0) r.x0 = g.x;
            if (g.x + g.w > r.x1) r.x1 = g.x + g.w;
            if (top < r.top) r.top = top;
            if (bottom > r.bottom) r.bottom = bottom;
            r.xs.push(g.x, g.x + g.w);
            r.n++;
            // The row's own baseline: the commonest one (the body), not a script's.
            if (g.lv === LV.BASE) r.base = g.baseline;
        }
        return [...byRow.values()]
            .filter(r => r.x1 > r.x0 && r.bottom > r.top)
            .sort((a, b) => a.page - b.page || a.top - b.top || a.x0 - b.x0)
            .map(r => ({
                page: r.page,
                yBaselineBp: r.base,
                x: r.x0, y: r.top, w: r.x1 - r.x0, h: Math.max(0.5, r.bottom - r.top),
                xs: r.xs.sort((a, b) => a - b),
                row: r.row,
                glyphs: r.n,
            }));
    }

    lineRows(file, line) {
        if (!this.gm) return super.lineRows(file, line);
        const id = this._fileId(file);
        if (id == null) return [];
        const g = this._toGenerationLine(file, line);
        const k = `${id}|${g.line}`;
        const hit = this._rowsCache.get(k);
        if (hit) return hit;
        const rows = this._rowsOf(this._glyphsGen(id, g.line));
        this._rowsCache.set(k, rows);
        return rows;
    }

    /** The rows a whole generation-line RANGE printed (the window's rows). */
    rangeRows(file, startLine, endLine) {
        if (!this.gm) return [];
        const id = this._fileId(file);
        if (id == null) return [];
        const all = [];
        for (let n = startLine; n <= endLine; n++) {
            const g = this._toGenerationLine(file, n);
            all.push(...this._glyphsGen(id, g.line));
        }
        return this._rowsOf(all);
    }

    lineAtPoint(page, xBp, yTopBp) {
        if (!this.gm) return super.lineAtPoint(page, xBp, yTopBp);
        // Reach: about one and a half text lines, like the SyncTeX version.
        const { glyph, distance } = this.glyphAt(page, xBp, yTopBp, { reach: 40 });
        if (!glyph) return null;
        const file = this.fileOf(glyph.fileId);
        if (!file) return null;
        const top = glyph.emTop; const bottom = glyph.emBottom;
        const dx = xBp < glyph.x ? glyph.x - xBp : (xBp > glyph.x + glyph.w ? xBp - (glyph.x + glyph.w) : 0);
        const dy = yTopBp < top ? top - yTopBp : (yTopBp > bottom ? yTopBp - bottom : 0);
        const font = this.fontOf(glyph);
        const lead = font && font.size > 0 ? font.size * 1.2 * (72 / 72.27) : 12;
        return {
            file,
            line: this._toCurrentLine(file, glyph.line),
            dx, dy, lead, distance, glyph, exact: true,
        };
    }

    renderToSource(page, xBp, yTopBp, opts = {}) {
        if (!this.gm) return super.renderToSource(page, xBp, yTopBp, opts);
        const { glyph } = this.glyphAt(page, xBp, yTopBp, { reach: 18 });
        if (glyph) {
            const file = this.fileOf(glyph.fileId);
            if (file) {
                const currentLine = this._toCurrentLine(file, glyph.line);
                const object = this.model ? this._objectAt(file, currentLine) : null;
                return {
                    flag: this._baseFlag(),
                    file,
                    line: currentLine,
                    generationLine: glyph.line,
                    box: { page, xBp: glyph.x, yTopBp: glyph.baseline - glyph.h, wBp: glyph.w, hBp: glyph.h + glyph.d, kind: 'glyph', line: glyph.line },
                    object: object || undefined,
                    candidates: 1,
                    exact: true,
                    glyph,
                    reason: object
                        ? (object.approximate
                            ? `no object contains line ${currentLine}; nearest is ${object.linesAway} line(s) away`
                            : undefined)
                        : 'mapped to a line, but this file has no objects',
                };
            }
        }
        // No glyph near the point: a figure, a picture, the margin. SyncTeX's
        // box hierarchy still knows which float that is.
        return super.renderToSource(page, xBp, yTopBp, opts);
    }

    sourceToRender(file, startLine, endLine = startLine) {
        if (!this.gm) return super.sourceToRender(file, startLine, endLine);
        const id = this._fileId(file);
        if (id == null) {
            return { flag: FLAG.UNMAPPED, pages: [], page: null, boxes: [], exact: false, matchedLine: null,
                reason: 'this file is not in the compiled document' };
        }
        const a = this._toGenerationLine(file, startLine);
        const b = this._toGenerationLine(file, endLine);
        const rows = this.rangeRows(file, startLine, endLine);
        if (!rows.length) {
            const sup = super.sourceToRender(file, startLine, endLine);
            // A delimiter line (`\[`, `\begin{equation}`) prints nothing of its
            // own; SyncTeX's neighbourhood answer is the honest fallback and is
            // already marked as such.
            return sup;
        }
        let flag = this._baseFlag();
        if (flag === FLAG.FRESH && (a.shifted || b.shifted)) flag = FLAG.PROBABLY_CURRENT;
        const pages = [...new Set(rows.map(r => r.page))].sort((x, y) => x - y);
        return {
            flag,
            pages,
            page: pages[0],
            boxes: rows.map(r => ({ page: r.page, kind: 'row', line: startLine, xBp: r.x, yTopBp: r.y, wBp: r.w, hBp: r.h })),
            exact: !a.shifted && !b.shifted,
            matchedLine: startLine,
        };
    }

    linesOnPage(page, file) {
        if (!this.gm) return super.linesOnPage(page, file);
        const id = this._fileId(file);
        if (id == null) return [];
        const pg = this.gm.pages.get(page);
        if (!pg) return [];
        const lines = new Set();
        for (const g of pg.glyphs) if (g.fileId === id) lines.add(this._toCurrentLine(file, g.line));
        // Lines SyncTeX knows on this page that printed no glyph (a figure's
        // \includegraphics) still belong to the page.
        try { for (const l of super.linesOnPage(page, file)) lines.add(l); } catch (_) { /* no synctex */ }
        return [...lines].sort((a, b) => a - b);
    }

    pageOccupancy(page) {
        if (!this.gm) return super.pageOccupancy(page);
        const pg = this.gm.pages.get(page);
        if (!pg) return { flag: FLAG.UNMAPPED, page, fill: 0, bars: 0 };
        const rows = this._rowsOf(pg.glyphs).map(r => [r.y, r.y + r.h]).sort((a, b) => a[0] - b[0]);
        let covered = 0; let curA = null; let curB = null;
        for (const [a, b] of rows) {
            if (curA === null) { curA = a; curB = b; continue; }
            if (a <= curB) { if (b > curB) curB = b; continue; }
            covered += curB - curA; curA = a; curB = b;
        }
        if (curA !== null) covered += curB - curA;
        const denom = this._textHeightBp();
        const fill = denom > 0 ? Math.min(1, covered / denom) : 0;
        return {
            flag: this._baseFlag(), page, fill,
            bars: Math.max(0, Math.min(5, Math.round(fill * 5))),
            coveredBp: covered, textHeightBp: denom, rows: rows.length, records: pg.glyphs.length,
        };
    }

    /** The tallest column of glyph rows in the document — the text height. */
    _textHeightBp() {
        if (this._textHBp != null) return this._textHBp;
        let tallest = 0;
        for (const pg of this.gm.pages.values()) {
            let lo = Infinity; let hi = -Infinity;
            for (const g of pg.glyphs) {
                if (g.kind === KIND.EQNO) continue;
                const top = g.baseline - g.h; const bottom = g.baseline + g.d;
                if (top < lo) lo = top;
                if (bottom > hi) hi = bottom;
            }
            if (hi > lo && hi - lo > tallest) tallest = hi - lo;
        }
        this._textHBp = tallest > 0 ? tallest : this.pageSize.heightBp;
        return this._textHBp;
    }

    coverage(file, totalLines) {
        if (!this.gm) return super.coverage(file, totalLines);
        const id = this._fileId(file);
        if (id == null) return { covered: 0, total: totalLines, fraction: 0 };
        let covered = 0;
        for (let n = 1; n <= totalLines; n++) if (this._glyphsGen(id, n).length) covered++;
        return { covered, total: totalLines, fraction: totalLines ? covered / totalLines : 0 };
    }

    // ------------------------------------------------ collected constructs --

    /**
     * THE WINDOW A SOURCE LINE BELONGS TO — the construct whose glyphs all sit
     * on one collector line.
     *
     * A line with glyphs of its own is its own window, widened UPWARD over the
     * glyph-less, non-blank lines directly above it: that is exactly the shape
     * of a multi-line `\caption{`, a `\section{` broken across lines, a
     * `\boxed{` argument, an `align` body, and the `\maketitle` / `\paragraph`
     * that file one line late. The widening stops at a blank line (a paragraph
     * boundary), at a line that has glyphs (somebody else's), or after 120
     * lines. A line WITHOUT glyphs looks forward for its collector and takes
     * that window, provided it is inside it.
     *
     * Lines are CURRENT; the answer is in current lines too.
     *
     * @param {string[]} lines  the file's current text, split
     * @returns {{startLine:number,endLine:number,collector:number}|null}
     */
    window(file, line, lines) {
        if (!this.gm) return null;
        const id = this._fileId(file);
        if (id == null) return null;
        const key = `${id}|${line}|${this._editShift.size}`;
        const hit = this._winCache.get(key);
        if (hit !== undefined) return hit;
        const has = (n) => this._glyphsGen(id, this._toGenerationLine(file, n).line).length > 0;
        const blank = (n) => !lines || n < 1 || n > lines.length || !String(lines[n - 1]).split('%')[0].trim();
        // A PEEKER files its glyphs one line LATE: `\paragraph{…}` and
        // `\maketitle` fetch the next line before typesetting, and a run-in
        // heading's words land in the following paragraph's first row — even
        // across a blank line.
        const peeker = (n) => lines && n >= 1 && n <= lines.length &&
            /^\s*\\(paragraph|subparagraph|maketitle|item|section|subsection|subsubsection|chapter|part)\b/.test(String(lines[n - 1]));
        let collector = null;
        if (has(line)) collector = line;
        else {
            let blanks = 0;
            for (let n = line + 1; n <= line + 120 && (!lines || n <= lines.length); n++) {
                if (has(n)) { collector = n; break; }
                // A blank line ends a construct; the next text is another one —
                // unless the line we asked about is itself the blank line, or a
                // peeker, whose glyphs sit just past the gap.
                if (blank(n) && n !== line && !blank(line)) {
                    blanks++;
                    if (!(peeker(line) && blanks <= 1 && n - line <= 2)) break;
                }
            }
        }
        let win = null;
        if (collector != null) {
            let start = collector;
            for (let n = collector - 1; n >= 1 && collector - n < 120; n--) {
                if (has(n)) break;
                if (blank(n)) break;
                start = n;
            }
            // A collector that is itself blank (the line after `\maketitle`)
            // still owns the non-blank lines above it.
            if (start === collector && blank(collector)) {
                for (let n = collector - 1; n >= 1 && collector - n < 120; n--) {
                    if (has(n) || blank(n)) break;
                    start = n;
                }
            }
            if (line < start && peeker(line) && collector - line <= 3) start = line;
            // A PEEKER JUST ABOVE A LINE THAT HAS ITS OWN GLYPHS still belongs
            // to it: `\paragraph{…}` + blank + text puts the heading's words
            // on the text's first row.
            for (let n = start - 1; n >= 1 && start - n <= 2; n--) {
                if (has(n)) break;
                if (peeker(n)) { start = n; break; }
                if (!blank(n)) break;
            }
            // A CONSTRUCT THAT OPENS ON A LINE WITH INK OF ITS OWN — a
            // `\footnote{` after a sentence — leaves the window with more
            // closing braces than opening ones. Walk up until it balances, even
            // across lines that have glyphs.
            const balanceOf = (a, b) => {
                let bal = 0;
                for (let n = a; n <= b; n++) {
                    const t = String(lines[n - 1] || '').replace(/\\./g, '').split('%')[0];
                    for (const ch of t) { if (ch === '{') bal++; else if (ch === '}') bal--; }
                }
                return bal;
            };
            if (lines) {
                let guard = 0;
                while (balanceOf(start, collector) < 0 && start > 1 && guard++ < 60) start--;
            }
            if (line >= start && line <= collector) win = { startLine: start, endLine: collector, collector };
        }
        this._winCache.set(key, win);
        return win;
    }

    /**
     * The alignment for a window: its source tokens, its exact glyphs, and the
     * correspondence — the same `amap` shape glyphAlign has always produced,
     * so tokenAt / glyphAtPoint / groupAround read it unchanged.
     *
     * @param {object} o
     * @param {string} o.file
     * @param {number} o.line        a CURRENT line inside the window
     * @param {string[]} o.lines     the file's current text
     * @param {Map} [o.macros]
     * @param {boolean} [o.inMath]   the window is a maths object
     * @returns {object|null} amap + {window}
     */
    lineMap(o = {}) {
        if (!this.gm) return null;
        const win = this.window(o.file, o.line, o.lines);
        if (!win) return null;
        const id = this._fileId(o.file);
        const key = `${id}|${win.startLine}-${win.endLine}|${o.inMath ? 'm' : 'p'}|${this._editShift.size}`;
        const hit = this._mapCache.get(key);
        if (hit !== undefined) return hit;
        const items = [];
        for (let n = win.startLine; n <= win.endLine; n++) {
            const g = this._toGenerationLine(o.file, n);
            for (const gl of this._glyphsGen(id, g.line)) {
                // The equation NUMBER is the engine's ink, not the source's.
                if (gl.kind === KIND.EQNO) continue;
                if (gl.str === '' ) continue;
                items.push({
                    str: gl.str, page: gl.page,
                    // y/h: the EM box (what a click is aimed at); inkY/inkH: the
                    // ink (what a highlight paints).
                    x: gl.x, y: gl.emTop, w: gl.w, h: gl.emBottom - gl.emTop,
                    inkY: gl.mark ? gl.emTop : gl.baseline - gl.h,
                    inkH: gl.mark ? gl.emBottom - gl.emTop : gl.h + gl.d,
                    baseline: gl.baseline, font: `f${gl.fontId}`,
                    lv: gl.lv, glyph: gl,
                });
            }
        }
        let built = null;
        if (items.length) {
            try {
                // THE ENGINE'S ORDER IS THE READING ORDER. The hook emits boxes
                // in TeX's own list order — row by row, left to right, with a
                // script pair sub-first and an accent nucleus-first (the
                // projection's canonical order) — so nothing here re-derives
                // rows or scripts from geometry the way the text-layer path had
                // to. Levels come from the engine too (above/below/base).
                const tokens = sourceTokens({
                    lines: o.lines, startLine: win.startLine, endLine: win.endLine,
                    macros: o.macros, inMath: !!o.inMath, order: 'source',
                });
                const glyphs = items.map(it => ({
                    key: keyOf(it.str.length === 1 ? it.str : it.str[0]), ch: it.str,
                    page: it.page, x: it.x, y: it.y, w: it.w, h: it.h, font: it.font,
                    inkY: it.inkY, inkH: it.inkH,
                    baseline: it.baseline,
                    level: it.lv === LV.ABOVE ? 'above' : it.lv === LV.BELOW ? 'below' : 'base',
                }));
                // A ligature prints one glyph for two or three source letters:
                // expand it so every source letter has something to pair with,
                // each piece keeping the ligature's box.
                const expanded = [];
                for (const gl of glyphs) {
                    if (gl.ch.length <= 1) { expanded.push(gl); continue; }
                    const per = gl.w / gl.ch.length;
                    [...gl.ch].forEach((ch, k) => expanded.push({
                        ...gl, key: keyOf(ch), ch, x: gl.x + k * per, w: per,
                    }));
                }
                const { srcToRen, renToSrc, matched } = align(
                    tokens.map(t => t.key), expanded.map(g => g.key), {
                        srcLevels: tokens.map(t => t.level || 'base'),
                        renLevels: expanded.map(g => g.level || 'base'),
                    });
                built = {
                    tokens, glyphs: expanded, srcToRen, renToSrc, matched,
                    confidence: (tokens.length && expanded.length)
                        ? matched / Math.min(tokens.length, expanded.length) : 0,
                    window: win,
                };
            } catch (_) { built = null; }
        }
        this._mapCache.set(key, built);
        return built;
    }

    /** The maps must be rebuilt when the source moves under them. */
    noteEdit(file, fromLine, delta) {
        super.noteEdit(file, fromLine, delta);
        this._winCache.clear(); this._mapCache.clear(); this._rowsCache.clear();
    }
    clearEdits(file) {
        super.clearEdits(file);
        this._winCache.clear(); this._mapCache.clear(); this._rowsCache.clear();
    }
}

module.exports = { GlyphMap, readGlyphMap, tfmChar, tfmFamily, KIND, LV, FLAG };
