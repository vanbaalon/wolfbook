// mmaWrite.js — the canonical writer for managed computations in a .tex.
//
// Pure: no vscode, no fs, no kernel, never throws. The reader is mmaBlocks.js;
// these two are separate modules on purpose, so that what a block MEANS and how
// a block is SPELLED cannot quietly drift apart inside one file.
//
// Everything this module emits is a TeX comment except an output fence's body,
// which is ordinary LaTeX. A paper carrying managed computations therefore
// compiles on a plain latexmk with no Wolfbook anywhere — that is the promise,
// and it is the reason the writer is worth having as its own tested unit.
//
// REPRODUCIBILITY IS THE POINT. "Delete an output, recompute, get byte-identical
// content back" is the exit criterion for the whole feature, and it can only
// hold if decoration is deterministic:
//
//   line 'foo'  ->  '% foo'
//   line ''     ->  '%'          (never '% ' — editors and git strip trailing
//                                 whitespace, which would silently change the
//                                 hash of a block nobody touched)
//
// undecorate() strips '%' plus at most one space, so the round trip is exact,
// and a code line that itself begins with '%' is written '% %foo' — which
// matches neither a cell directive nor a fence keyword. The grammar protects
// itself.

const { parseHeader, sha256, RE_CELL } = require('./mmaBlocks');

const OUT_END = '%WolfbookOutputEnd';

/** Decorate one body of source as TeX comment lines. */
function decorate(code) {
    return String(code == null ? '' : code)
        .split('\n')
        .map(l => (l === '' ? '%' : '% ' + l));
}

/** Render an option list back into `[a, k -> v]` form. */
function formatOptions(parts) {
    const kept = parts.filter(p => p != null && p !== '');
    return kept.length ? `[${kept.join(', ')}]` : '';
}

/** Quote an option value only when it needs it. */
function optValue(v) {
    const s = String(v);
    return /^[A-Za-z0-9_.:\-+]*$/.test(s) ? s : JSON.stringify(s);
}

/** Option keys the writer owns; anything else on a cell rides along untouched. */
const CELL_RESERVED = new Set(['CellID', 'cellId', 'out', 'Out', '_positional', '_unparsed']);
const BLOCK_RESERVED = new Set(['BlockID', 'blockId', 'CellID', 'cellId', '_positional', '_unparsed']);

/**
 * Is this cell in the shape that needs no directive at all?
 *
 * One Wolfram cell whose output is wanted and which carries no id of its own is
 * exactly the Stage-1 block, and it is written exactly as Stage 1 wrote it. Any
 * other shape gets an explicit directive, so a round trip through the parser
 * never has to guess at a default.
 */
function isLegacyShape(cells) {
    return cells.length === 1
        && cells[0].kind !== 'markdown'
        && cells[0].include !== false
        && !cells[0].cellId;
}

/** `%%Wolfram[CellID: c1, out -> none, kind -> figure]` */
function buildCellDirective(cell) {
    const word = cell.kind === 'markdown' ? 'Markdown' : 'Wolfram';
    const parts = [];
    if (cell.cellId) parts.push(`CellID: ${cell.cellId}`);
    // Spell the flag out whenever it is not this kind's default, and also
    // whenever the cell carries an id — a materialised cell's intent should be
    // legible in the file without knowing the defaults table.
    const dflt = cell.kind === 'markdown' ? false : true;
    const include = cell.include !== false;
    if (include !== dflt || cell.cellId) parts.push(`out -> ${include ? 'insert' : 'none'}`);
    for (const p of (cell.options && cell.options._positional) || []) parts.push(p);
    for (const [k, v] of Object.entries(cell.options || {})) {
        if (CELL_RESERVED.has(k)) continue;
        parts.push(`${k} -> ${optValue(v)}`);
    }
    return `%%${word}${formatOptions(parts)}`;
}

/**
 * The whole `%Mathematica … %EndMathematica` region, with no trailing newline.
 *
 * @param {{blockId?: string, kind?: string, options?: object,
 *          cells: Array<{kind?: string, cellId?: string, include?: boolean,
 *                        code?: string, options?: object}>}} doc
 */
function buildBlockText(doc = {}) {
    const cells = (doc.cells && doc.cells.length) ? doc.cells : [{ kind: 'wolfram', code: '', include: true }];
    const headParts = [];
    const positional = (doc.options && doc.options._positional) || [];
    for (const p of positional) headParts.push(p);
    if (doc.kind && !positional.length) headParts.push(doc.kind);
    if (doc.blockId) headParts.push(`BlockID: ${doc.blockId}`);
    for (const [k, v] of Object.entries(doc.options || {})) {
        if (BLOCK_RESERVED.has(k)) continue;
        headParts.push(`${k} -> ${optValue(v)}`);
    }

    const lines = [`%Mathematica${formatOptions(headParts)}`];
    const bare = isLegacyShape(cells);
    for (const cell of cells) {
        if (!bare) lines.push(buildCellDirective(cell));
        lines.push(...decorate(cell.code));
    }
    lines.push('%EndMathematica');
    return lines.join('\n');
}

/**
 * One managed-output region, with no trailing newline.
 *
 * The fence records the hash of the SOURCE that produced the body and of the
 * BODY as written, which is what lets the reader tell "the code moved on" from
 * "someone edited the output by hand" with no kernel and no history.
 */
function buildOutputFence(cell, body, opts = {}) {
    const cellId = opts.cellId || cell.cellId;
    const sourceHash = opts.sourceHash || cell.sourceHash || sha256(String(cell.code ?? ''));
    const text = String(body == null ? '' : body).replace(/\n+$/, '');
    const { formatOutputFence } = require('./mmaBlocks');
    return [
        formatOutputFence(cellId, sourceHash, sha256(text), {
            short: opts.short || 8,
            blockId: opts.blockId,
        }),
        text,
        OUT_END,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// What a result looks like as paper LaTeX
// ---------------------------------------------------------------------------
//
// "Nice LaTeX snippet form": a result that goes into a paper should look like
// something a person would have typed. An equation is a numbered display when
// it is worth referring to and an unnumbered one when it is not; a picture is a
// float with a caption and a label, because a picture without a label cannot be
// pointed at from the prose.

/** `eq:` or `fig:` plus something sane, from whatever name is around. */
function labelFrom(prefix, name) {
    const clean = String(name || '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    return clean ? `${prefix}:${clean}` : null;
}

/**
 * An expression result as display maths.
 *
 * A label is what makes the difference between `equation` and `\\[ \\]`: an
 * unlabelled numbered equation adds a number nobody refers to, and LaTeX's own
 * convention is that numbering is for things you cite.
 */
function equationBody(latex, opts = {}) {
    const tex = String(latex == null ? '' : latex).trim();
    const label = opts.label || null;
    if (!label) return ['\\[', tex, '\\]'].join('\n');
    return [
        '\\begin{equation}',
        tex,
        `  \\label{${label}}`,
        '\\end{equation}',
    ].join('\n');
}

/**
 * A graphics result as a figure.
 *
 * Nesting floats is a LaTeX error, so a cell already inside one gets the bare
 * \includegraphics — the same rule, and the same reasoning, as texPaste.
 */
function figureBody(rel, opts = {}) {
    const width = opts.width || '0.8\\linewidth';
    const inc = `\\includegraphics[width=${width}]{${rel}}`;
    if (opts.inFloat) return inc;
    const label = opts.label || labelFrom('fig', opts.name) || null;
    const caption = opts.caption || null;
    const lines = ['\\begin{figure}[htbp]', '  \\centering', '  ' + inc];
    if (caption) lines.push(`  \\caption{${caption}}`);
    if (label) lines.push(`  \\label{${label}}`);
    lines.push('\\end{figure}');
    return lines.join('\n');
}

/** Plain text that is not maths — verbatim, so nothing in it is interpreted. */
function verbatimBody(text) {
    return ['\\begin{verbatim}', String(text == null ? '' : text).replace(/\s+$/, ''), '\\end{verbatim}'].join('\n');
}

/**
 * The body for whatever the kernel returned.
 *
 * @param {object} res   an execution/eval-fragment result
 * @param {{label?, caption?, name?, inFloat?, width?, assetRel?}} opts
 * @returns {{body: string, needsAsset?: {base64?, text?, ext: string}}|{error: string}}
 *
 * A graphics result needs a file written before it has a body, so it says so
 * rather than inventing a path the caller has not agreed to.
 */
function bodyForResult(res, opts = {}) {
    if (!res) return { error: 'no result' };
    if (res.kind === 'error') return { error: res.error || 'evaluation failed' };
    if (res.kind === 'latex') return { body: equationBody(res.latex, opts) };
    if (res.kind === 'figure' || res.kind === 'image') {
        if (!opts.assetRel) {
            // PDF for a figure — vector, and the format \includegraphics
            // actually reads. PNG is the floor when the kernel could not make
            // a PDF; it is raster, but it builds.
            return {
                needsAsset: res.kind === 'figure'
                    ? { base64: res.pdfBase64, ext: 'pdf' }
                    : { base64: res.base64, ext: 'png' },
            };
        }
        return { body: figureBody(opts.assetRel, opts) };
    }
    if (res.kind === 'svg') {
        // REFUSED, deliberately. pdflatex reads PDF, PNG and JPEG; an .svg is
        // "Unknown graphics extension" and the document stops building — so
        // writing one would hand back a paper that no longer compiles. This is
        // unreachable from the paper path (which asks for a PDF and falls back
        // to PNG); it exists so that if it ever happens the answer is a
        // sentence rather than a broken build.
        return {
            error: 'this figure came back only as SVG, which pdflatex cannot include — '
                + 'run it again to get a PDF',
        };
    }
    if (res.kind === 'text') return { body: verbatimBody(res.text) };
    return { error: `cannot put a ${res.kind} result in a paper` };
}

// ---------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------

/** Offset of the first character of 1-based line n. */
function offsetOfLine(text, n) {
    if (n <= 1) return 0;
    let off = 0;
    for (let i = 1; i < n; i++) {
        const nl = text.indexOf('\n', off);
        if (nl < 0) return text.length;
        off = nl + 1;
    }
    return off;
}

/** Offset just past 1-based line n, including its newline when it has one. */
function offsetAfterLine(text, n) {
    const start = offsetOfLine(text, n);
    const nl = text.indexOf('\n', start);
    return nl < 0 ? text.length : nl + 1;
}

/**
 * Where does this cell's output go, and what replaces what?
 *
 * @returns {{startOffset, endOffset, newText, replaced: boolean}|{error: string}}
 *
 * A cell that already has a fence gets that fence REPLACED in place, so its
 * neighbours never move. A cell that has none gets a fence inserted after the
 * block and after every fence belonging to an EARLIER cell, which keeps the
 * fences in cell order without having to renumber anything.
 *
 * `opts.writeCellId` separates the id a cell is FOUND by from the id its fence
 * is WRITTEN with. A cell being materialised for the first time has no id yet:
 * it is looked up as the block's only cell, and the id it is about to be given
 * is what its fence must name — otherwise the fence records `CellID: null` and
 * the pairing that makes re-inserting a replacement stops working.
 */
function planInsert(text, block, cellId, body, opts = {}) {
    if (!block || !Array.isArray(block.cells)) return { error: 'block has no cells' };
    const src = String(text);
    const cell = block.cells.find(c => c.cellId && c.cellId === cellId)
        || (block.cells.length === 1 && !cellId ? block.cells[0] : null);
    if (!cell) return { error: `no cell ${JSON.stringify(cellId)} in this block` };

    const fences = block.outputs || [];
    const fenceText = buildOutputFence(cell, body, {
        cellId: opts.writeCellId || cellId || cell.cellId,
        blockId: opts.blockId || block.blockId,
        short: opts.short,
    });

    if (cell.outputIndex != null && fences[cell.outputIndex]) {
        const f = fences[cell.outputIndex];
        return {
            startOffset: offsetOfLine(src, f.startLine),
            endOffset: offsetAfterLine(src, f.endLine),
            newText: fenceText + '\n',
            replaced: true,
            cellId: opts.writeCellId || cell.cellId,
        };
    }

    // Insert after the last fence of an earlier cell, else right after the block.
    let anchorLine = block.endLine;
    for (const c of block.cells) {
        if (c === cell) break;
        if (c.outputIndex != null && fences[c.outputIndex]) {
            anchorLine = Math.max(anchorLine, fences[c.outputIndex].endLine);
        }
    }
    const at = offsetAfterLine(src, anchorLine);
    return {
        startOffset: at,
        endOffset: at,
        newText: fenceText + '\n',
        replaced: false,
        cellId: opts.writeCellId || cell.cellId,
    };
}

/**
 * Remove a cell's managed output — what "stop putting this in the paper" means
 * on disk. Returns null when there is nothing to remove, so the caller can tell
 * a no-op from a refusal.
 */
function planRemoveOutput(text, block, cellId) {
    if (!block || !Array.isArray(block.cells)) return null;
    const cell = block.cells.find(c => c.cellId && c.cellId === cellId)
        || (block.cells.length === 1 && !cellId ? block.cells[0] : null);
    if (!cell || cell.outputIndex == null) return null;
    const f = (block.outputs || [])[cell.outputIndex];
    if (!f) return null;
    const src = String(text);
    return {
        startOffset: offsetOfLine(src, f.startLine),
        endOffset: offsetAfterLine(src, f.endLine),
        newText: '',
        replaced: true,
        cellId: cell.cellId,
    };
}

/**
 * Rewrite a block's own region (its cells changed in the editor), leaving every
 * fence below it alone.
 */
function planBlockText(text, block, doc) {
    const src = String(text);
    return {
        startOffset: offsetOfLine(src, block.startLine),
        endOffset: offsetAfterLine(src, block.endLine),
        newText: buildBlockText(doc) + '\n',
        replaced: true,
    };
}

/**
 * A block as the editor wants it: the parse, turned back into the shape
 * buildBlockText accepts. Round-tripping through this is what the tests assert.
 *
 * Options are stripped back to the ones the writer does NOT own. An id and an
 * out-flag have dedicated fields, and carrying them in `options` as well would
 * mean two places to change and one of them eventually forgotten; `_positional`
 * and `_unparsed` are parser bookkeeping and are kept only when they hold
 * something, so an untouched block round-trips to exactly what it started as.
 */
function trimOptions(opts, reserved) {
    const out = {};
    for (const [k, v] of Object.entries(opts || {})) {
        // Decided before the reserved check: the writer reserves these names
        // because it emits them positionally rather than as `k -> v`, but the
        // doc still has to carry them or a round trip would lose them.
        if (k === '_positional' || k === '_unparsed') {
            if (v && v.length) out[k] = v;
            continue;
        }
        if (reserved.has(k)) continue;
        out[k] = v;
    }
    return out;
}

function toDoc(block) {
    return {
        blockId: block.blockId || null,
        options: trimOptions(block.options, BLOCK_RESERVED),
        cells: (block.cells || []).map(c => ({
            kind: c.kind,
            cellId: c.cellId || null,
            include: c.include !== false,
            code: c.code || '',
            options: trimOptions(c.options, CELL_RESERVED),
        })),
    };
}

/** Does this text contain a cell directive? Used to spot hand-written `%%`. */
function hasCellDirective(text) {
    return String(text).split('\n').some(l => RE_CELL.test(l));
}

module.exports = {
    buildBlockText,
    trimOptions,
    equationBody,
    figureBody,
    verbatimBody,
    bodyForResult,
    labelFrom,
    buildOutputFence,
    buildCellDirective,
    planInsert,
    planRemoveOutput,
    planBlockText,
    toDoc,
    decorate,
    offsetOfLine,
    offsetAfterLine,
    hasCellDirective,
    isLegacyShape,
};
