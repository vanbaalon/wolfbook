// synctexParse.js — .synctex.gz -> the full box tree, in pure node.
//
// Pure: no vscode, never throws on malformed content. Graduated from the
// Stage 0 spike (Experiments/wolfbook-tex/lib/synctex-parse.mjs), where it was
// measured against the `synctex` CLI on 15 papers: 100% page agreement,
// geometry to 8.4e-5 bp, 24 ms for a 1.29 MB inflated file, zero warnings.
//
// WHY OWN THIS rather than shell out: the CLI answers ONE query per process
// (~30 ms of fork each), hands back only a union of records rather than the
// tree, and — measured — sometimes returns boxes that cannot exist (off the
// left edge of the paper, wider than the page). The file has more in it than
// the CLI will tell you.

const fs = require('fs');
const zlib = require('zlib');

const BOX_OPEN = { '[': 'vbox', '(': 'hbox' };
const BOX_CLOSE = { ']': 'vbox', ')': 'hbox' };
const VOID_BOX = { h: 'void_hbox', v: 'void_vbox' };
const POINT_REC = { g: 'glue', x: 'char', $: 'math', k: 'kern' };

/**
 * @param {string} file  path to .synctex or .synctex.gz
 * @returns {{version, output, magnification, unit, xOffset, yOffset,
 *            inputs: Map<number,string>, pages: Map<number,object>,
 *            warnings: string[], bytes: number, sourceFile: string}}
 * Never throws on malformed content — an unparseable line becomes a warning and
 * is skipped. A half-written .synctex from a killed compile is a normal thing to
 * meet, and losing the other 40 000 records over it would be absurd.
 */
function parseSynctex(file) {
    const raw = fs.readFileSync(file);
    const buf = file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
    return parseSynctexText(buf.toString('binary'), { bytes: buf.length, sourceFile: file });
}

function parseSynctexText(text, meta = {}) {
    const out = {
        version: null, output: null, magnification: 1000, unit: 1,
        xOffset: 0, yOffset: 0,
        inputs: new Map(), pages: new Map(), warnings: [],
        bytes: meta.bytes ?? text.length, sourceFile: meta.sourceFile ?? null,
    };

    const lines = text.split('\n');
    let inContent = false;
    /** @type {object[]} */ let stack = [];
    let page = null;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) continue;

        // Input: records appear both before Content: and interleaved after it
        // (SQ_report puts tag 67, its own .aux, right at the end).
        if (line.startsWith('Input:')) {
            const c = line.indexOf(':', 6);
            if (c > 0) {
                const tag = Number(line.slice(6, c));
                if (Number.isFinite(tag)) out.inputs.set(tag, line.slice(c + 1));
            }
            continue;
        }

        if (!inContent) {
            if (line === 'Content:') { inContent = true; continue; }
            const c = line.indexOf(':');
            if (c < 0) continue;
            const key = line.slice(0, c);
            const val = line.slice(c + 1);
            if (key === 'SyncTeX Version') out.version = Number(val);
            else if (key === 'Output') out.output = val;
            else if (key === 'Magnification') out.magnification = Number(val) || 1000;
            else if (key === 'Unit') out.unit = Number(val) || 1;
            else if (key === 'X Offset') out.xOffset = Number(val) || 0;
            else if (key === 'Y Offset') out.yOffset = Number(val) || 0;
            continue;
        }

        const c0 = line[0];

        if (c0 === '!') continue;                       // offset hint
        if (line.startsWith('Postamble:')) break;

        if (c0 === '{') {
            const n = Number(line.slice(1));
            page = { page: n, boxes: [], root: null, records: 0 };
            const root = { type: 'sheet', tag: 0, line: 0, h: 0, v: 0, W: 0, H: 0, D: 0, children: [], page: n };
            page.root = root;
            stack = [root];
            out.pages.set(n, page);
            continue;
        }
        if (c0 === '}') {
            if (stack.length > 1) out.warnings.push(`page ${page?.page}: ${stack.length - 1} box(es) unclosed at page end`);
            page = null; stack = [];
            continue;
        }

        if (!page) continue;                            // stray record outside a sheet

        if (BOX_CLOSE[c0] && line.length === 1) {
            if (stack.length > 1) stack.pop();
            else out.warnings.push(`line ${i + 1}: '${c0}' with no open box`);
            continue;
        }

        const kind = BOX_OPEN[c0] || VOID_BOX[c0] || POINT_REC[c0] || (c0 === 'r' ? 'rule' : null);
        if (!kind) { out.warnings.push(`line ${i + 1}: unknown record '${c0}'`); continue; }

        const rec = parseRecord(line, kind);
        if (!rec) { out.warnings.push(`line ${i + 1}: malformed ${kind}: ${line.slice(0, 60)}`); continue; }

        rec.page = page.page;
        page.records++;
        const parent = stack[stack.length - 1];
        (parent.children || (parent.children = [])).push(rec);
        page.boxes.push(rec);
        if (BOX_OPEN[c0]) { rec.children = []; stack.push(rec); }
    }

    return out;
}

/**
 * `Xtag,line:h,v` | `Xtag,line:h,v:W,H,D` | `Xtag,line:h,v:width`
 * The tag/line pair may carry a column as `tag,line,col` in some writers, so it
 * is tolerated rather than assumed absent.
 */
function parseRecord(line, kind) {
    const body = line.slice(1);
    const parts = body.split(':');
    if (parts.length < 2) return null;

    const idParts = parts[0].split(',');
    const tag = Number(idParts[0]);
    const ln = Number(idParts[1]);
    const col = idParts.length > 2 ? Number(idParts[2]) : -1;
    if (!Number.isFinite(tag) || !Number.isFinite(ln)) return null;

    const hv = parts[1].split(',');
    const h = Number(hv[0]);
    const v = Number(hv[1]);
    if (!Number.isFinite(h) || !Number.isFinite(v)) return null;

    const rec = { type: kind, tag, line: ln, column: col, h, v, W: 0, H: 0, D: 0 };

    if (parts.length >= 3) {
        const dims = parts[2].split(',');
        if (kind === 'kern') {
            rec.W = Number(dims[0]) || 0;
        } else {
            rec.W = Number(dims[0]) || 0;
            rec.H = Number(dims[1]) || 0;
            rec.D = Number(dims[2]) || 0;
        }
    }
    return rec;
}

// --- queries ---------------------------------------------------------------

/** Records whose source line falls in [startLine, endLine] of `tag`. */
function recordsForLines(doc, tag, startLine, endLine = startLine) {
    const hits = [];
    for (const page of doc.pages.values()) {
        for (const b of page.boxes) {
            if (b.tag === tag && b.line >= startLine && b.line <= endLine) hits.push(b);
        }
    }
    return hits;
}

/** Tag number for a source path — exact, then basename, then suffix match. */
function tagForPath(doc, filePath) {
    for (const [tag, p] of doc.inputs) if (p === filePath) return tag;
    const norm = (s) => s.replace(/\/\.\//g, '/');
    for (const [tag, p] of doc.inputs) if (norm(p) === norm(filePath)) return tag;
    const base = filePath.split('/').pop();
    const cands = [...doc.inputs].filter(([, p]) => p.split('/').pop() === base);
    if (cands.length === 1) return cands[0][0];
    // Prefer a path that ends with the whole relative name we were given.
    const ends = cands.filter(([, p]) => norm(p).endsWith(norm(filePath)));
    if (ends.length === 1) return ends[0][0];
    return cands.length ? cands[0][0] : null;
}

/**
 * Which page is a source line on, and what boxes back that answer?
 *
 * MEASURED on SQ_report: only 70.9% of source lines (752 of 1061) carry ANY
 * SyncTeX record. Blank lines, comment lines, and lines whose material TeX
 * attributed to a neighbour simply are not in the file. The `synctex` CLI hides
 * this by silently searching outward and reporting the neighbour's box as
 * though it were yours — which is a large part of SyncTeX's "coarse"
 * reputation. We do the same search, but we say so: `exact: false` plus the
 * line we actually landed on. That distinction is what the RenderMap's
 * fresh/probably-current honesty flag is built out of.
 *
 * Boxes are sorted by area ASCENDING — tightest first. This also beats the CLI,
 * which returns the ENCLOSING box: for line 301 of SQ_report the CLI reports
 * h=75.45 W=444.98 H=15.54 while the file holds h=78.84 W=441.59 H=8.37. The
 * tighter box is right there in the data; only the CLI's query throws it away.
 */
function locate(doc, tag, startLine, endLine = startLine, opts = {}) {
    const { maxSearch = 8 } = opts;
    const usable = (b) => b.W > 0 || b.H > 0 || b.type === 'math' || b.type === 'char';

    let hits = recordsForLines(doc, tag, startLine, endLine).filter(usable);
    let exact = hits.length > 0;
    let matchedLine = exact ? startLine : null;

    // Nothing on those lines: search outward, nearest line wins, ties go DOWN
    // the file (the material after a blank line is what the user meant).
    for (let d = 1; !hits.length && d <= maxSearch; d++) {
        for (const cand of [endLine + d, startLine - d]) {
            if (cand < 1) continue;
            const got = recordsForLines(doc, tag, cand).filter(usable);
            if (got.length) { hits = got; matchedLine = cand; break; }
        }
    }
    if (!hits.length) return null;

    const byPage = new Map();
    for (const b of hits) {
        if (!byPage.has(b.page)) byPage.set(b.page, []);
        byPage.get(b.page).push(b);
    }
    const pages = [...byPage.keys()].sort((a, b) => a - b);
    const boxes = [...hits].sort((a, b) => (a.W * (a.H + a.D)) - (b.W * (b.H + b.D)));
    return { pages, page: pages[0], boxes, byPage, exact, matchedLine };
}

/** Fraction of a file's source lines that carry any record — a coverage census. */
function lineCoverage(doc, tag, totalLines) {
    const seen = new Set();
    for (const page of doc.pages.values()) {
        for (const b of page.boxes) if (b.tag === tag) seen.add(b.line);
    }
    return { covered: seen.size, total: totalLines, fraction: totalLines ? seen.size / totalLines : 0, lines: seen };
}

/** Inverse: the deepest boxes on `page` containing the point (h, v) in sp. */
function boxesAtPoint(doc, pageNo, h, v) {
    const page = doc.pages.get(pageNo);
    if (!page) return [];
    return page.boxes
        .filter(b => (b.W > 0 || b.H > 0) &&
            h >= b.h && h <= b.h + b.W &&
            v >= b.v - b.H && v <= b.v + b.D)
        .sort((a, b) => (a.W * (a.H + a.D)) - (b.W * (b.H + b.D)));
}

/** Every distinct source line that contributed to a page. */
function linesOnPage(doc, pageNo) {
    const page = doc.pages.get(pageNo);
    if (!page) return [];
    const seen = new Set();
    for (const b of page.boxes) seen.add(`${b.tag}:${b.line}`);
    return [...seen].map(s => {
        const [tag, line] = s.split(':').map(Number);
        return { tag, line };
    });
}

module.exports = {
    parseSynctex,
    parseSynctexText,
    recordsForLines,
    tagForPath,
    locate,
    lineCoverage,
    boxesAtPoint,
    linesOnPage,
};
