'use strict';
/**
 * nbModel.js — Mathematica .nb AST  ->  wolfbook notebook cell model.
 *
 * No vscode, no fs: every environment-dependent capability is injected, so the
 * whole conversion is unit-testable with plain node.
 *
 *   deps = {
 *     boxToLatex:     (boxString, opts) => {latex, error} | string | null,
 *     prerenderLatex: (latex, displayMode) => htmlString,
 *     wlUTFtoNames:   (s) => s,       // Unicode -> \[Name]  (BTL input)
 *     namedChars:     { Alpha: 0x3b1, ... },   // name -> codepoint table
 *   }
 *
 * importNb() NEVER throws — a broken file still yields a readable notebook.
 */

const { parseNotebookSource, printInputForm } = require('./wlParser');
const { graphicsFileName, graphicsOutput, imgTag } = require('./graphicsRender');

// ---------------------------------------------------------------------------
// Style tables

const HEADING_PREFIX = {
    Title:             '# ',
    Subtitle:          '## ',
    Chapter:           '## ',
    Section:           '## ',
    Subchapter:        '### ',
    Subsection:        '### ',
    Subsubsection:     '#### ',
    Subsubsubsection:  '##### ',
};

const CODE_STYLES   = new Set(['Input', 'Code', 'Program', 'InitializationCell']);
const OUTPUT_STYLES = new Set(['Output', 'Print', 'Echo', 'Message', 'MSG']);
const ITEM_STYLES   = {
    Item: '- ', Subitem: '  - ', Subsubitem: '    - ',
    ItemNumbered: '1. ', SubitemNumbered: '   1. ', SubsubitemNumbered: '      1. ',
    ItemParagraph: '', SubitemParagraph: '', BulletedText: '- ',
};
// Prose styles that become plain markdown cells.
const TEXT_STYLES = new Set([
    'Text', 'SmallText', 'Caption', 'Abstract', 'Author', 'Institution',
    'Affiliation', 'Department', 'Subtitle', 'Subsubtitle', 'CodeText',
]);

// Static pictures: a kernel can rasterise these to PNG (graphicsRender.js).
const RENDERABLE_GFX_HEADS = new Set([
    'GraphicsBox', 'Graphics3DBox', 'GraphicsGridBox', 'RasterBox', 'ImageBox',
    'Image3DBox', 'SurfaceGraphicsBox', 'ContourGraphicsBox', 'DensityGraphicsBox',
    'LegendedBox', 'GeoGraphicsBox', 'GraphBox',
]);

// Live widgets: there is nothing static to render, so these stay placeholders.
const WIDGET_HEADS = new Set([
    'DynamicBox', 'DynamicModuleBox', 'AnimatorBox', 'ManipulateBox',
    'SliderBox', 'Slider2DBox', 'TabViewBox', 'PaneSelectorBox', 'OpenerBox',
    'InputFieldBox', 'PopupMenuBox', 'SetterBox', 'RadioButtonBox',
    'LocatorPaneBox', 'ColorSetterBox', 'ActionMenuBox', 'ToggleSwitchBox',
]);

const GFX_HEADS = new Set([...RENDERABLE_GFX_HEADS, ...WIDGET_HEADS]);

// Placeholder left in a markdown cell where an image belongs; the caller swaps
// it for the real <img> tag once the PNG exists (it needs the notebook's
// directory, which the serializer never sees). An HTML comment renders as
// nothing, so the reader never sees the marker itself.
const IMG_TOKEN_RX = /<!--WBIMG:([A-Za-z0-9_]+)-->/g;
function imgToken(id) { return '<!--WBIMG:' + id + '-->'; }

// Above this, do not bother BTL — the LaTeX would be unusable anyway.
const MAX_BTL_INPUT = 200000;

// ---------------------------------------------------------------------------
// Detection

/** Cheap sniff: is this the source of a Mathematica .nb file? */
function isNbSource(text) {
    if (!text) return false;
    const head = text.slice(0, 4000);
    const firstNonWs = head.search(/\S/);
    if (firstNonWs === -1) return false;
    if (head.indexOf('Content-type: application/vnd.wolfram.mathematica') !== -1) return true;
    // A .wb/.vsnb is JSON and always starts with '{'.
    if (head[firstNonWs] === '{') return false;
    return /(^|\n)\s*Notebook\s*\[/.test(head);
}

// ---------------------------------------------------------------------------
// Small AST helpers

function isCall(n, head)  { return !!n && n.t === 'call' && n.head === head; }
function argAt(n, i)      { return n && n.args ? n.args[i] : undefined; }
function strValue(n)      { return n && n.t === 'str' ? n.value : null; }

/** Collect Name -> node from the trailing option rules of a Cell[...]. */
function cellOptions(cellNode) {
    const out = {};
    if (!cellNode || !cellNode.args) return out;
    for (let i = 1; i < cellNode.args.length; i++) {
        const a = cellNode.args[i];
        if (a && a.t === 'rule' && a.lhs && a.lhs.t === 'sym') out[a.lhs.name] = a.rhs;
    }
    return out;
}

function containsHead(node, headSet, depth) {
    if (!node || typeof node !== 'object' || (depth || 0) > 200) return false;
    if (node.t === 'call') {
        if (headSet.has(node.head)) return true;
        for (const a of node.args) if (containsHead(a, headSet, (depth || 0) + 1)) return true;
        return false;
    }
    if (node.t === 'list') {
        for (const it of node.items) if (containsHead(it, headSet, (depth || 0) + 1)) return true;
        return false;
    }
    for (const k of ['lhs', 'rhs', 'arg', 'fn']) {
        if (node[k] && containsHead(node[k], headSet, (depth || 0) + 1)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Box -> code text

/**
 * Flatten a box expression to Wolfram source text.
 * ctx: { warn(kind), unknown: Set }
 */
function flattenBoxToCode(node, ctx, depth) {
    depth = depth || 0;
    if (!node || depth > 300) return '';

    switch (node.t) {
        case 'str':  return decodeNames(node.value, ctx.deps);
        case 'num':  return node.raw;
        case 'sym':  return node.name;
        case 'raw':  return node.text;
        case 'list':
            // BoxData[{expr1, expr2, ...}] — one statement per line. Separator
            // items (\[IndentingNewLine]) flatten to whitespace; dropping them
            // keeps exactly one newline between statements.
            return node.items
                .map(x => flattenBoxToCode(x, ctx, depth + 1))
                .filter(s => s.trim() !== '')
                .join('\n');
        case 'call': break;
        default:     return printInputForm(node);
    }

    const a = node.args;
    const f = (x) => flattenBoxToCode(x, ctx, depth + 1);

    switch (node.head) {
        case 'BoxData':
        case 'FormBox':
        case 'TagBox':
        case 'StyleBox':
        case 'AdjustmentBox':
        case 'PaneBox':
        case 'ButtonBox':
        case 'TooltipBox':
        case 'ItemBox':
        case 'TemplateBox':
            // Display wrapper — the first argument carries the content.
            // A TemplateBox's display form is not its source, so the result is
            // only an approximation: flag it for the kernel-assist pass.
            if (node.head === 'TemplateBox') { ctx.warn('unknownBoxes', node.head); ctx.approx = true; }
            return f(a[0]);

        case 'InterpretationBox':
            return f(a[0]);

        case 'RowBox':
            if (a[0] && a[0].t === 'list') return a[0].items.map(f).join('');
            return f(a[0]);

        case 'SuperscriptBox':   return f(a[0]) + '^' + wrapAtom(f(a[1]));
        case 'SubscriptBox':     return 'Subscript[' + f(a[0]) + ', ' + f(a[1]) + ']';
        case 'SubsuperscriptBox':return 'Subsuperscript[' + f(a[0]) + ', ' + f(a[1]) + ', ' + f(a[2]) + ']';
        case 'OverscriptBox':    return 'Overscript[' + f(a[0]) + ', ' + f(a[1]) + ']';
        case 'UnderscriptBox':   return 'Underscript[' + f(a[0]) + ', ' + f(a[1]) + ']';
        case 'UnderoverscriptBox':
            return 'Underoverscript[' + f(a[0]) + ', ' + f(a[1]) + ', ' + f(a[2]) + ']';
        case 'FractionBox':      return '(' + f(a[0]) + ')/(' + f(a[1]) + ')';
        case 'SqrtBox':          return 'Sqrt[' + f(a[0]) + ']';
        case 'RadicalBox':       return 'Surd[' + f(a[0]) + ', ' + f(a[1]) + ']';
        case 'CheckboxBox':
        case 'ErrorBox':         return f(a[0]);

        case 'GridBox': {
            // Best-effort: rows of a matrix-like grid.
            ctx.warn('unknownBoxes', 'GridBox');
            ctx.approx = true;
            const rows = a[0];
            if (rows && rows.t === 'list') {
                const body = rows.items.map(r =>
                    (r && r.t === 'list') ? '{' + r.items.map(f).join(', ') + '}' : f(r)
                ).join(', ');
                return '{' + body + '}';
            }
            return printInputForm(node);
        }

        default:
            ctx.warn('unknownBoxes', node.head);
            ctx.approx = true;
            return printInputForm(node);
    }
}

/** Parenthesise a superscript operand unless it is already atomic. */
function wrapAtom(s) {
    return /^[A-Za-z0-9_.$\\[\]]+$/.test(s) ? s : '(' + s + ')';
}

// ---------------------------------------------------------------------------
// TextData -> markdown

function textDataToMarkdown(node, ctx, deps, depth) {
    depth = depth || 0;
    if (!node || depth > 100) return '';

    if (node.t === 'str')  return decodeNames(node.value, deps);
    if (node.t === 'list') return node.items.map(x => textDataToMarkdown(x, ctx, deps, depth + 1)).join('');

    if (node.t === 'call') {
        const a = node.args;
        switch (node.head) {
            case 'TextData':
            case 'BoxData':
                return textDataToMarkdown(a[0], ctx, deps, depth + 1);

            case 'StyleBox': {
                const inner = textDataToMarkdown(a[0], ctx, deps, depth + 1);
                const opts = {};
                for (let i = 1; i < a.length; i++) {
                    const o = a[i];
                    if (o && o.t === 'rule' && o.lhs && o.lhs.t === 'sym') opts[o.lhs.name] = strValue(o.rhs);
                    else if (o && o.t === 'str') opts['_style'] = o.value;
                }
                let s = inner;
                if (opts.FontWeight === 'Bold' || opts._style === 'Bold') s = '**' + s + '**';
                if (opts.FontSlant === 'Italic' || opts._style === 'Italic') s = '*' + s + '*';
                if (opts._style === 'Input' || opts.FontFamily === 'Courier') s = '`' + s + '`';
                return s;
            }

            case 'ButtonBox': {
                const label = textDataToMarkdown(a[0], ctx, deps, depth + 1);
                const url = findUrl(node);
                return url ? '[' + label + '](' + url + ')' : label;
            }

            case 'Cell': {
                // Inline typeset formula — or an inline picture — inside prose.
                const content = a[0];
                if (isCall(content, 'BoxData')) {
                    const inner = content.args[0];
                    if (containsHead(inner, RENDERABLE_GFX_HEADS) && !containsHead(inner, WIDGET_HEADS)) {
                        const task = queueGraphics(inner, ctx);
                        ctx.warn('graphicsOutputs');
                        if (task.hit) return imgTag(task.hit.absPath, task.hit.relPath, task.hit.size);
                        ctx.pendingCellGfx.push({ id: task.id, file: task.file, target: 'value' });
                        return imgToken(task.id);
                    }
                    const latex = boxesToLatex(inner, ctx, deps);
                    if (latex) return '$' + latex + '$';
                    return '`' + flattenBoxToCode(content, ctx) + '`';
                }
                return textDataToMarkdown(content, ctx, deps, depth + 1);
            }

            case 'RowBox':
                if (a[0] && a[0].t === 'list') {
                    return a[0].items.map(x => textDataToMarkdown(x, ctx, deps, depth + 1)).join('');
                }
                return textDataToMarkdown(a[0], ctx, deps, depth + 1);

            default:
                return flattenBoxToCode(node, ctx);
        }
    }
    return flattenBoxToCode(node, ctx);
}

/** Dig a URL out of a ButtonBox's options. */
function findUrl(node) {
    let found = null;
    (function walk(n, d) {
        if (found || !n || typeof n !== 'object' || d > 40) return;
        if (n.t === 'call' && n.head === 'URL' && n.args[0] && n.args[0].t === 'str') { found = n.args[0].value; return; }
        if (n.t === 'call') n.args.forEach(x => walk(x, d + 1));
        else if (n.t === 'list') n.items.forEach(x => walk(x, d + 1));
        else ['lhs', 'rhs', 'arg', 'fn'].forEach(k => n[k] && walk(n[k], d + 1));
    })(node, 0);
    return found;
}

// ---------------------------------------------------------------------------
// Boxes -> LaTeX (via the BTL native addon)

function boxesToLatex(boxNode, ctx, deps) {
    if (!deps || !deps.boxToLatex) { ctx.warn('latexUnavailable'); return null; }
    let boxStr;
    try {
        boxStr = printInputForm(boxNode);
    } catch (_) { return null; }
    if (!boxStr || boxStr.length > MAX_BTL_INPUT) return null;
    try {
        const input = deps.wlUTFtoNames ? deps.wlUTFtoNames(boxStr) : boxStr;
        const res = deps.boxToLatex(input, {});
        const latex = (res && typeof res === 'object') ? res.latex : res;
        if (!latex) return null;
        return latex;
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Output fabrication
//
// Mirrors the live pipeline's HTML (execution/checkout.js) with two deliberate
// omissions: data-session-epoch (the renderer deletes elements whose epoch does
// not match the current kernel session) and data-output-id (no live output
// registry exists for an imported file, so the format buttons stay inert).

function escapeHtmlAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function outputHtml(outN, latex, katexHtml) {
    const b64 = Buffer.from(latex, 'utf8').toString('base64');
    return '<div class="wl-output-block">' +
        '<div class="wl-output-header" style="display:flex;align-items:center;gap:6px;width:100%;min-height:22px;" ' +
        'data-out-n="' + escapeHtmlAttr(outN) + '" data-sub-idx="0" data-output-format="WLLatex" ' +
        'data-output-is-graphics="0">' +
        '<span style="font-size:10px;color:#888;margin-right:8px;">Out[' + escapeHtmlAttr(outN) + ']=</span>' +
        '</div>' +
        '<div class="wl-output-content">' +
        '<div class="vscode-wolfram-wllatex-prerendered" data-page-width-em="0" data-latex-b64="' + b64 + '">' +
        katexHtml +
        '</div></div></div>';
}

/**
 * Build a notebook output for one .nb Output cell.
 * Returns {items:[{data,mime}], id} — item.data are plain strings.
 */
function fabricateOutput(contentNode, outN, ctx, deps) {
    const inner = isCall(contentNode, 'BoxData') ? contentNode.args[0] : contentNode;
    const id = 'nbimport-' + (ctx.outputSeq++);

    // Live widgets have no static form to recover.
    if (containsHead(inner, WIDGET_HEADS)) {
        ctx.warn('dynamicOutputs');
        const msg = 'Out[' + outN + ']= (dynamic output — re-evaluate the input cell to regenerate it)';
        return { items: [{ data: msg, mime: 'text/plain' }], id };
    }

    // A picture: use the rendered PNG if it already exists, else queue it.
    if (containsHead(inner, RENDERABLE_GFX_HEADS)) {
        const task = queueGraphics(inner, ctx);
        ctx.warn('graphicsOutputs');
        if (task.hit) return graphicsOutput(outN, task.hit.absPath, task.hit.relPath, task.hit.size, id);
        const msg = 'Out[' + outN + ']= (graphics — rendering to ' + task.file + ')';
        return {
            items: [{ data: msg, mime: 'text/plain' }],
            id,
            _gfx: { id: task.id, file: task.file, target: 'output', outN },
        };
    }

    const latex = boxesToLatex(inner, ctx, deps);
    if (latex && deps.prerenderLatex) {
        let katexHtml;
        try { katexHtml = deps.prerenderLatex(latex, true); }
        catch (_) { katexHtml = ''; }
        if (katexHtml) {
            return {
                items: [
                    { data: outputHtml(outN, latex, katexHtml), mime: 'x-application/wolfram-language-html' },
                    { data: 'Out[' + outN + ']= ' + latex, mime: 'text/plain' },
                ],
                id,
            };
        }
    }

    // No LaTeX engine (or BTL refused): keep the result as readable text.
    ctx.warn('plainOutputs');
    const text = flattenBoxToCode(inner, ctx);
    return { items: [{ data: 'Out[' + outN + ']= ' + text, mime: 'text/plain' }], id };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Graphics queue

/**
 * Resolve a graphics box to an image.
 *
 * PNG names are content hashes, so when the caller knows the notebook's image
 * folder (`deps.resolveImage`) an already-rendered graphic is emitted as its
 * final <img> straight away — no placeholder, no patching, no flash. Otherwise
 * it is queued for the kernel and stands in as a hidden token.
 *
 * @returns {{id, file, hit: {absPath, relPath, size}|null}}
 */
function queueGraphics(boxNode, ctx) {
    const boxSource = printInputForm(boxNode);
    const id = 'g' + (ctx.gfxSeq++);
    const file = graphicsFileName(boxSource);
    let hit = null;
    if (ctx.deps && typeof ctx.deps.resolveImage === 'function') {
        try { hit = ctx.deps.resolveImage(file) || null; } catch (_) { hit = null; }
    }
    if (!hit) ctx.graphicsTasks.push({ id, file, boxSource });
    return { id, file, hit };
}

/** Record graphics placeholders on a cell so the patcher can find them later. */
function noteGraphics(cell, entries) {
    if (!entries || !entries.length) return;
    cell.metadata.nbImport = Object.assign({}, cell.metadata.nbImport, { graphics: entries });
}

// ---------------------------------------------------------------------------
// Named characters whose Wolfram codepoint lives in the private-use area render
// as invisible garbage in a plain text editor (this is what made the old
// converter's output unreadable). Operators get their ASCII spelling; spacing
// characters collapse; everything else PUA-mapped stays as \[Name], which is
// always valid Wolfram input.
const NAME_ASCII = {
    Rule: ' -> ', RuleDelayed: ' :> ', TwoWayRule: ' <-> ',
    Equal: ' == ', NotEqual: ' != ', LessEqual: ' <= ', GreaterEqual: ' >= ',
    And: ' && ', Or: ' || ', Not: '!', Implies: ' \\[Implies] ',
    LeftAssociation: '<|', RightAssociation: '|>',
    IndentingNewLine: '\n', NewLine: '\n', RawNewline: '\n', LineSeparator: '\n',
    RawTab: '\t', Tab: '\t',
    InvisibleSpace: '', InvisibleApplication: '', InvisibleComma: ',',
    InvisibleTimes: ' ', NegativeThinSpace: '', NegativeMediumSpace: '',
    NegativeThickSpace: '', NegativeVeryThinSpace: '',
    ThinSpace: ' ', MediumSpace: ' ', ThickSpace: ' ', VeryThinSpace: ' ',
    NonBreakingSpace: ' ', SpanFromLeft: '', SpanFromAbove: '', SpanFromBoth: '',
    AlignmentMarker: '', NoBreak: '', AutoLeftMatch: '', AutoRightMatch: '',
    ImplicitPlus: ' + ',
};

const PUA_LO = 0xE000, PUA_HI = 0xF8FF;

/** Decode \[Name], \:hhhh and \.hh escapes to readable text. */
function decodeNames(s, deps) {
    if (!s) return '';
    let out = s;
    if (out.indexOf('\\[') !== -1) {
        const table = (deps && deps.namedChars) || null;
        out = out.replace(/\\\[([A-Za-z][A-Za-z0-9]*)\]/g, (m, name) => {
            if (Object.prototype.hasOwnProperty.call(NAME_ASCII, name)) return NAME_ASCII[name];
            const cp = table ? table[name] : undefined;
            if (typeof cp !== 'number') return m;
            if (cp >= PUA_LO && cp <= PUA_HI) return m;   // invisible in an editor — keep \[Name]
            return String.fromCodePoint(cp);
        });
    }
    if (out.indexOf('\\:') !== -1) {
        out = out.replace(/\\:([0-9a-fA-F]{4})/g, (m, h) => {
            const cp = parseInt(h, 16);
            return (cp >= PUA_LO && cp <= PUA_HI) ? m : String.fromCodePoint(cp);
        });
    }
    if (out.indexOf('\\.') !== -1) {
        out = out.replace(/\\\.([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return out;
}

/**
 * wb-export writes .nb files by prefixing EVERY line of the file with one
 * space, which lands inside multi-line cell strings. Undo that, but only for
 * files in the simple wolfbook dialect — a genuine Mathematica .nb (which has a
 * NotebookDataPosition header) must keep its indentation byte-for-byte.
 */
function dedent(text, ctx) {
    if (!ctx.simpleDialect || !text || text.indexOf('\n') === -1) return text;
    const lines = text.split('\n');
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] !== '' && lines[i][0] !== ' ') return text;
    }
    return lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('\n');
}

function mkMarkup(value)  { return { kind: 1, value, languageId: 'markdown', outputs: [], metadata: {} }; }
function mkCode(value)    { return { kind: 2, value, languageId: 'wolfram',  outputs: [], metadata: {} }; }

// ---------------------------------------------------------------------------
// Main conversion

/**
 * @param {string} source  raw .nb file text
 * @param {object} deps    injected capabilities (see file header)
 * @param {object} opts    { mode: 'view'|'save', sourceName?: string }
 * @returns {{cells: Array, metadata: object, warnings: object}}
 */
function importNb(source, deps, opts) {
    deps = deps || {};
    opts = opts || {};
    const mode = opts.mode === 'save' ? 'save' : 'view';

    const ctx = {
        deps,
        counts: Object.create(null),
        unknownHeads: new Set(),
        graphicsTasks: [],
        pendingCellGfx: [],
        gfxSeq: 1,
        outputSeq: 1,
        approx: false,
        // A genuine Mathematica .nb always carries a NotebookDataPosition header;
        // files written by wolfbook's own WBExport do not.
        simpleDialect: !/NotebookDataPosition\[/.test(source.slice(0, 2000)),
        warn(kind, detail) {
            ctx.counts[kind] = (ctx.counts[kind] || 0) + 1;
            if (kind === 'unknownBoxes' && detail) ctx.unknownHeads.add(detail);
        },
    };

    let parsed;
    try {
        parsed = parseNotebookSource(source);
    } catch (e) {
        parsed = { ok: false, error: { message: String(e && e.message || e), line: 1 } };
    }

    if (!parsed.ok || !parsed.ast || !parsed.ast.args || !parsed.ast.args[0]) {
        return failureNotebook(source, parsed && parsed.error, opts);
    }

    const cellList = parsed.ast.args[0];
    const items = cellList.t === 'list' ? cellList.items : [cellList];

    const cells = [];
    const state = { lastCodeIdx: -1, outCounter: 0 };

    try {
        for (const item of items) emitCell(item, cells, state, ctx, deps, 0);
    } catch (e) {
        ctx.warn('cellErrors');
    }

    if (parsed.recoveries) ctx.counts.parseRecoveries = parsed.recoveries;

    const warnings = Object.assign({}, ctx.counts);
    if (ctx.unknownHeads.size) warnings.unknownHeadList = [...ctx.unknownHeads].slice(0, 12);

    const banner = buildBanner(warnings, mode, opts);
    if (banner) cells.unshift(mkMarkup(banner));

    const metadata = {
        wolfbookNbImport: {
            version: 1,
            warnings,
            importId: 'nbi_' + (++_importSeq) + '_' + Math.random().toString(36).slice(2, 10),
            approxCells: cells.filter(c => c.metadata && c.metadata.nbImport && c.metadata.nbImport.approx).length,
            // Kept so serializeNotebook can write the file back byte-identically
            // instead of destroying it with .wb JSON. Dropped from the .wb copy.
            source,
        },
    };
    if (opts.sourceName) metadata.wolfbookNbImport.sourceName = opts.sourceName;

    return { cells, metadata, warnings, graphicsTasks: ctx.graphicsTasks };
}

let _importSeq = 0;

/** Append a markdown cell, carrying over any inline image placeholders the
 *  conversion of this cell produced. */
function pushMarkup(cells, value, ctx) {
    const cell = mkMarkup(value);
    noteGraphics(cell, ctx.pendingCellGfx.splice(0));
    cells.push(cell);
    return cell;
}

/** Convert one Cell[...] (or CellGroupData) node, appending to `cells`. */
function emitCell(node, cells, state, ctx, deps, depth) {
    if (!node || depth > 60) return;
    ctx.pendingCellGfx.length = 0;

    if (!isCall(node, 'Cell')) {
        if (node.t === 'list') { node.items.forEach(x => emitCell(x, cells, state, ctx, deps, depth + 1)); }
        return;
    }

    const content = argAt(node, 0);

    // Cell[CellGroupData[{...}, Open]]
    if (isCall(content, 'CellGroupData')) {
        const grp = content.args[0];
        if (grp && grp.t === 'list') grp.items.forEach(x => emitCell(x, cells, state, ctx, deps, depth + 1));
        return;
    }
    // Stylesheet definitions carry no user content.
    if (isCall(content, 'StyleData')) return;

    const style = strValue(argAt(node, 1)) || '';
    const opts  = cellOptions(node);

    try {
        // ---- output cells -------------------------------------------------
        if (OUTPUT_STYLES.has(style)) {
            if (state.lastCodeIdx < 0) { ctx.warn('orphanOutputs'); return; }
            let outN = ++state.outCounter;
            const label = strValue(opts.CellLabel);
            const m = label && /Out\[(\d+)\]/.exec(label);
            if (m) outN = parseInt(m[1], 10);
            const out = fabricateOutput(content, outN, ctx, deps);
            if (!out) return;
            const owner = cells[state.lastCodeIdx];
            const gfx = out._gfx;
            delete out._gfx;
            owner.outputs.push(out);
            if (gfx) {
                const entries = (owner.metadata.nbImport && owner.metadata.nbImport.graphics) || [];
                entries.push(Object.assign({ outputIndex: owner.outputs.length - 1 }, gfx));
                noteGraphics(owner, entries);
            }
            return;
        }

        // ---- code cells ---------------------------------------------------
        if (CODE_STYLES.has(style)) {
            // A GraphicsBox inside an Input cell is a stored picture (a pasted
            // image, usually with Evaluatable->False), not code — flattening it
            // would yield pages of box source.
            if (containsHead(content, RENDERABLE_GFX_HEADS) && !containsHead(content, WIDGET_HEADS)) {
                const task = queueGraphics(unwrapBoxData(content), ctx);
                ctx.warn('graphicsOutputs');
                if (task.hit) {
                    cells.push(mkMarkup(imgTag(task.hit.absPath, task.hit.relPath, task.hit.size)));
                    return;
                }
                const cell = mkMarkup(imgToken(task.id));
                noteGraphics(cell, [{ id: task.id, file: task.file, target: 'value' }]);
                cells.push(cell);
                return;
            }
            const before = ctx.approx;
            ctx.approx = false;
            const text = dedent(flattenBoxToCode(content, ctx), ctx).trim();
            const isApprox = ctx.approx;
            ctx.approx = before;
            if (!text) return;
            const cell = mkCode(text);
            if (isApprox) {
                // Marked for the optional kernel-assist refinement pass.
                cell.metadata.nbImport = { approx: true, boxSource: printInputForm(unwrapBoxData(content)) };
                ctx.warn('approxCells');
            }
            cells.push(cell);
            state.lastCodeIdx = cells.length - 1;
            return;
        }

        // ---- display formula ----------------------------------------------
        if (style === 'DisplayFormula' || style === 'DisplayFormulaNumbered' || style === 'EquationNumbered') {
            const asString = strValue(content);
            if (asString !== null) {                       // wb-export writes TeX directly
                cells.push(mkMarkup('$$\n' + asString.trim() + '\n$$'));
                return;
            }
            const latex = boxesToLatex(isCall(content, 'BoxData') ? content.args[0] : content, ctx, deps);
            if (latex) { cells.push(mkMarkup('$$\n' + latex + '\n$$')); return; }
            const text = flattenBoxToCode(content, ctx).trim();
            if (text) cells.push(mkCode(text));
            return;
        }

        // ---- headings ------------------------------------------------------
        const prefix = HEADING_PREFIX[style];
        if (prefix) {
            const text = cellText(content, ctx, deps).replace(/\s*\n\s*/g, ' ').trim();
            if (text) pushMarkup(cells, prefix + text, ctx);
            return;
        }

        // ---- items ---------------------------------------------------------
        if (Object.prototype.hasOwnProperty.call(ITEM_STYLES, style)) {
            const text = cellText(content, ctx, deps).trim();
            if (text) pushMarkup(cells, ITEM_STYLES[style] + text, ctx);
            return;
        }

        // ---- prose ---------------------------------------------------------
        const isProse = TEXT_STYLES.has(style) || strValue(content) !== null || isCall(content, 'TextData');
        if (isProse) {
            const text = cellText(content, ctx, deps).trim();
            if (text) pushMarkup(cells, text, ctx);
            return;
        }

        // ---- anything else --------------------------------------------------
        ctx.warn('skippedCells', style || '(no style)');
    } catch (e) {
        ctx.warn('cellErrors');
        try {
            cells.push(mkCode(printInputForm(node)));
            state.lastCodeIdx = cells.length - 1;
        } catch (_) { /* give up on this cell */ }
    }
}

function unwrapBoxData(n) { return isCall(n, 'BoxData') ? n.args[0] : n; }

/** Cell content -> display text (markdown for prose, flattened for boxes). */
function cellText(content, ctx, deps) {
    const s = strValue(content);
    if (s !== null) return dedent(decodeNames(s, deps), ctx);
    if (isCall(content, 'TextData')) return dedent(textDataToMarkdown(content, ctx, deps), ctx);
    return dedent(flattenBoxToCode(content, ctx), ctx);
}

/**
 * Swap graphics placeholders for the rendered PNGs.
 *
 * Called once the notebook's directory is known (the serializer never sees a
 * URI), so it works on the plain cell model and on live NotebookDocument cells
 * alike — the caller decides how to apply `changedCells`.
 *
 * @param {Array} cells        wolfbook cell objects (mutated in place)
 * @param {Object} rendered    id -> {absPath, size} from renderGraphics()
 * @param {string} imgRel      e.g. 'img/MyNotebook'
 * @returns {{changed:number[], applied:number, missing:number}}
 */
function applyGraphics(cells, rendered, imgRel) {
    const changed = [];
    let applied = 0, missing = 0;

    cells.forEach((cell, idx) => {
        const entries = cell.metadata && cell.metadata.nbImport && cell.metadata.nbImport.graphics;
        if (!entries || !entries.length) return;
        let touched = false;
        const unresolved = [];

        for (const e of entries) {
            const r = rendered && rendered[e.id];
            if (!r) { missing++; unresolved.push(e); continue; }
            const rel = imgRel + '/' + e.file;

            if (e.target === 'output') {
                const old = cell.outputs && cell.outputs[e.outputIndex];
                if (!old) { unresolved.push(e); continue; }
                const fresh = graphicsOutput(e.outN, r.absPath, rel, r.size, old.id);
                cell.outputs[e.outputIndex] = fresh;
                touched = true; applied++;
            } else {
                const tag = imgTag(r.absPath, rel, r.size);
                const next = cell.value.split(imgToken(e.id)).join(tag);
                if (next !== cell.value) { cell.value = next; touched = true; applied++; }
            }
        }

        // Drop what succeeded; keep the rest so a later pass can retry.
        if (unresolved.length) cell.metadata.nbImport.graphics = unresolved;
        else if (cell.metadata.nbImport) {
            delete cell.metadata.nbImport.graphics;
            if (!Object.keys(cell.metadata.nbImport).length) delete cell.metadata.nbImport;
        }
        if (touched) changed.push(idx);
    });

    return { changed, applied, missing };
}

/** Replace any still-unrendered placeholder with honest prose. */
function clearGraphicsPlaceholders(cells) {
    for (const cell of cells) {
        if (cell.kind !== 1 || typeof cell.value !== 'string') continue;
        if (cell.value.indexOf('<!--WBIMG:') === -1) continue;
        cell.value = cell.value.replace(IMG_TOKEN_RX, '*(image could not be rendered)*');
    }
}

// ---------------------------------------------------------------------------
// Banner + failure path

function buildBanner(w, mode, opts) {
    const lines = [];
    const notes = [];

    if (w.skippedCells)     notes.push('`' + w.skippedCells + '` cell(s) of an unsupported style were skipped');
    if (w.dynamicOutputs)   notes.push('`' + w.dynamicOutputs + '` dynamic output(s) replaced by a placeholder — re-run the cell to regenerate');
    if (w.latexUnavailable) notes.push('the LaTeX renderer is unavailable, so outputs are shown as plain text');
    else if (w.plainOutputs) notes.push('`' + w.plainOutputs + '` output(s) could not be typeset and are shown as plain text');
    if (w.unknownBoxes)     notes.push('`' + w.unknownBoxes + '` unsupported box expression(s) kept as raw source' +
                                       (w.unknownHeadList ? ' (' + w.unknownHeadList.join(', ') + ')' : ''));
    if (w.approxCells)      notes.push('`' + w.approxCells + '` input cell(s) are approximate — run **Wolfbook: Refine .nb import with kernel** for exact code');
    if (w.orphanOutputs)    notes.push('`' + w.orphanOutputs + '` output(s) had no matching input cell and were dropped');
    if (w.cellErrors)       notes.push('`' + w.cellErrors + '` cell(s) failed to convert and are shown as raw source');

    if (mode === 'view') {
        lines.push('> ⚠️ **Imported Mathematica notebook — read-only view.**');
        lines.push('> This is a live conversion of a `.nb` file and cannot be saved in place.');
        lines.push('> Run **Wolfbook: Save .nb copy as .wb** to get an editable, runnable copy.');
    } else if (notes.length) {
        lines.push('> ⚠️ **Converted from a Mathematica `.nb` file.**');
    } else {
        return null;                                   // clean save-mode import: no banner
    }

    if (notes.length) {
        lines.push('>');
        lines.push('> Not fully converted:');
        for (const nte of notes) lines.push('> - ' + nte);
    }
    return lines.join('\n');
}

function failureNotebook(source, error, opts) {
    const where = error && error.line ? ' near line ' + error.line : '';
    const why   = error && error.message ? error.message : 'unrecognised file format';
    const banner =
        '> ❌ **Could not parse this Mathematica notebook.**\n' +
        '> ' + why + where + '.\n' +
        '> The raw file contents are shown below so nothing is lost.';
    const warnings = { parseFailed: 1 };
    return {
        cells: [ mkMarkup(banner), mkCode(source) ],
        metadata: {
            wolfbookNbImport: {
                version: 1, failed: true, error: why, warnings,
                importId: 'nbi_fail_' + (++_importSeq),
                sourceName: opts && opts.sourceName,
                source,
            },
        },
        warnings,
        graphicsTasks: [],
    };
}

module.exports = {
    importNb,
    isNbSource,
    applyGraphics,
    clearGraphicsPlaceholders,
    // exported for tests
    flattenBoxToCode,
    textDataToMarkdown,
    fabricateOutput,
    buildBanner,
    HEADING_PREFIX,
    GFX_HEADS,
    RENDERABLE_GFX_HEADS,
    WIDGET_HEADS,
};
