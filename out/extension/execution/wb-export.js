'use strict';
// execution/wb-export.js — handles WBExport[] / WBExport["path"] interception.
// Converts the current notebook to a Mathematica .nb file or PDF.

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const { execFile } = require('child_process');
const util   = require('util');
const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// Build reverse unicode map: Unicode char → \[Name] at module load time.
// Excludes ASCII (codepoint ≤ 0x7F) — those are already valid in WL source.
// ---------------------------------------------------------------------------
let _wlUnicodeMap = new Map();
let _wlUnicodeRx  = null;

try {
    const _mappingPath = path.join(__dirname, '../../../EditorVariation/unicode_mappings_filtered.json');
    const _entries     = JSON.parse(fs.readFileSync(_mappingPath, 'utf8'));
    for (const e of _entries) {
        if (e.unicode && e.unicode.length === 1 &&
            e.codepoint > 0x7F &&
            e.mathematica && e.mathematica.startsWith('\\[')) {
            _wlUnicodeMap.set(e.unicode, e.mathematica);
        }
    }
    if (_wlUnicodeMap.size > 0) {
        // Escape any regex-special chars in the Unicode chars (should be none, but safe)
        const parts = [..._wlUnicodeMap.keys()].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        _wlUnicodeRx = new RegExp(parts.join('|'), 'g');
    }
} catch (_) {
    // Mapping file not available — export will still work, just without \[Name] substitution
}

/**
 * Escape a string for embedding in a Wolfram Language string literal.
 *
 * Order matters:
 *   1. Escape real backslashes and double-quotes (standard WL string escaping).
 *   2. Replace non-ASCII Unicode chars with \[Name] sequences — must come AFTER
 *      step 1 so the \ in \[Alpha] etc. is NOT itself doubled.
 */
function wlEscape(str) {
    let s = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (_wlUnicodeRx) {
        _wlUnicodeRx.lastIndex = 0;
        s = s.replace(_wlUnicodeRx, ch => _wlUnicodeMap.get(ch) || ch);
    }
    return s;
}

// Returns true for code cells whose source contains a WBExport call — skip them in all exports.
function _isWBExportCell(cell) {
    if (cell.kind !== vscode.NotebookCellKind.Code) return false;
    return /WBExport\s*\[/.test(cell.document.getText());
}

/**
 * Convert a single VS Code notebook cell to a Mathematica Cell[...] expression string.
 * Returns null for cells that should be skipped (empty cells).
 */
function cellToNb(cell) {
    const src = cell.document.getText();

    if (cell.kind === vscode.NotebookCellKind.Markup) {
        const trimmed = src.trim();
        if (!trimmed) return null;

        // Map markdown headings to Wolfram cell styles (only if the ENTIRE cell is a heading)
        const h4 = /^####[ \t]+(.+)$/.exec(trimmed);
        if (h4 && trimmed === h4[0]) return `Cell["${wlEscape(h4[1])}", "Subsubsection"]`;
        const h3 = /^###[ \t]+(.+)$/.exec(trimmed);
        if (h3 && trimmed === h3[0]) return `Cell["${wlEscape(h3[1])}", "Subsection"]`;
        const h2 = /^##[ \t]+(.+)$/.exec(trimmed);
        if (h2 && trimmed === h2[0]) return `Cell["${wlEscape(h2[1])}", "Section"]`;
        const h1 = /^#[ \t]+(.+)$/.exec(trimmed);
        if (h1 && trimmed === h1[0]) return `Cell["${wlEscape(h1[1])}", "Title"]`;

        // Pure display-math block: $$...$$ (possibly multiline)
        // Export as DisplayFormula with FormatType->TeXForm so Mathematica renders the LaTeX.
        const dm = /^\$\$([\s\S]+?)\$\$$/.exec(trimmed);
        if (dm && trimmed === dm[0]) {
            const tex = dm[1].trim();
            return `Cell["${wlEscape(tex)}", "DisplayFormula", FormatType -> TeXForm]`;
        }

        // Mixed / plain text cell.
        // Inline $...$ math is kept as-is — Mathematica 14+ renders $...$ in Text cells.
        return `Cell["${wlEscape(trimmed)}", "Text"]`;
    } else {
        // Code cell
        const trimmed = src.trim();
        if (!trimmed) return null;
        return `Cell["${wlEscape(trimmed)}", "Input"]`;
    }
}

/**
 * Build the full .nb file content from the notebook.
 */
function generateNbContent(notebook) {
    const cells = notebook.getCells().filter(c => !_isWBExportCell(c));
    const cellStrs = cells
        .map(c => cellToNb(c))
        .filter(c => c !== null)
        .map(c => c.split('\n').map((l, i) => (i === 0 ? ' ' + l : ' ' + l)).join('\n'));

    const header =
        '(* Content-type: application/vnd.wolfram.mathematica *)\n\n' +
        '(*** Wolfram Notebook File ***)\n' +
        '(* http://www.wolfram.com/nb *)\n\n';

    const body = 'Notebook[{\n' + cellStrs.join(',\n\n') + '\n}]\n';

    return header + body;
}

// ---------------------------------------------------------------------------
// PDF Export
// ---------------------------------------------------------------------------

// Lazy-loaded KaTeX prerender
let _prerenderLatex = null;
function _loadKatex() {
    if (_prerenderLatex) return true;
    try {
        const p = path.join(__dirname, '../../../wllatex-addon/katexPrerender.js');
        _prerenderLatex = require(p).prerenderLatex;
        return true;
    } catch (_) { return false; }
}

// Minimal HTML escaping
function _esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Server-side Wolfram syntax highlighter (mirrors renderer-highlight.js logic)
function _highlightWolfram(code) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const blockRules = [
        { re: /"(?:[^"\\]|\\.)*"/g, cls: 'str' },
        { re: /\(\*[\s\S]*?\*\)/g,  cls: 'cmt' }
    ];
    const leafRules = [
        { re: /\b(\d[\d.]*(?:`\d+)?(?:\*\^[+-]?\d+)?)\b/g, cls: 'num' },
        { re: /\b([A-Z][a-zA-Z0-9$`]*)\b/g,                 cls: 'sym' }
    ];
    // Collect block-level tokens
    const toks = [];
    for (const { re, cls } of blockRules) {
        const r = new RegExp(re.source, re.flags.replace('g', '') + 'g');
        let m;
        while ((m = r.exec(code)) !== null)
            toks.push({ start: m.index, end: m.index + m[0].length, cls });
    }
    toks.sort((a, b) => a.start - b.start);
    const clean = []; let last = 0;
    for (const t of toks) { if (t.start >= last) { clean.push(t); last = t.end; } }
    // Build HTML
    let html = '', pos = 0;
    for (const t of clean) {
        if (t.start > pos) {
            let plain = esc(code.slice(pos, t.start));
            for (const { re, cls } of leafRules)
                plain = plain.replace(re, `<span class="wl-hl-${cls}">$1</span>`);
            html += plain;
        }
        html += `<span class="wl-hl-${t.cls}">${esc(code.slice(t.start, t.end))}</span>`;
        pos = t.end;
    }
    if (pos < code.length) {
        let plain = esc(code.slice(pos));
        for (const { re, cls } of leafRules)
            plain = plain.replace(re, `<span class="wl-hl-${cls}">$1</span>`);
        html += plain;
    }
    return html;
}

// Convert markdown text to HTML with KaTeX math rendering
function _renderMarkdown(text) {
    const hasKatex = _loadKatex();
    // Process line by line, handling headings, paragraphs, inline math
    const lines = text.split('\n');
    let html = '';
    let inParagraph = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (inParagraph) { html += '</p>\n'; inParagraph = false; }
            continue;
        }
        // Headings
        const hm = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (hm) {
            if (inParagraph) { html += '</p>\n'; inParagraph = false; }
            const level = hm[1].length;
            html += `<h${level}>${_inlineMarkdown(hm[2], hasKatex)}</h${level}>\n`;
            continue;
        }
        // Display math block $$...$$
        const dm = /^\$\$([\s\S]*?)\$\$$/.exec(trimmed);
        if (dm) {
            if (inParagraph) { html += '</p>\n'; inParagraph = false; }
            if (hasKatex) {
                html += `<div class="katex-display-block">${_prerenderLatex(dm[1].trim(), true)}</div>\n`;
            } else {
                html += `<pre>${_esc(dm[1].trim())}</pre>\n`;
            }
            continue;
        }
        // Regular text → paragraph
        if (!inParagraph) { html += '<p>'; inParagraph = true; }
        else { html += '<br>'; }
        html += _inlineMarkdown(trimmed, hasKatex);
    }
    if (inParagraph) html += '</p>\n';
    return html;
}

// Process inline markdown: bold, italic, code, inline math, links, images
function _inlineMarkdown(text, hasKatex) {
    // Inline math: $...$  (not $$)
    if (hasKatex) {
        text = text.replace(/\$([^$\n]+?)\$/g, (_, tex) => _prerenderLatex(tex, false));
    }
    // Bold **...**
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic *...*
    text = text.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
    // Inline code `...`
    text = text.replace(/`([^`]+?)`/g, '<code>$1</code>');
    // Images ![alt](src)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;">');
    // Links [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return text;
}

// Resolve image paths in HTML to data URIs for self-contained PDF
function _inlineImages(html, notebookDir) {
    return html.replace(/(<img[^>]+src=")([^"]+)(")/g, (match, pre, src, post) => {
        // Only process relative paths (not data: URIs or http)
        if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) return match;
        const absPath = path.isAbsolute(src) ? src : path.resolve(notebookDir, src);
        try {
            const buf = fs.readFileSync(absPath);
            const ext = path.extname(absPath).toLowerCase();
            const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/jpeg';
            return pre + `data:${mime};base64,${buf.toString('base64')}` + post;
        } catch (_) {
            return match; // keep original if file not found
        }
    });
}

// Also inline SVG elements that reference external files
function _inlineSvgImages(html, notebookDir) {
    // Handle <image href="..."> inside inline SVGs
    return html.replace(/(<image[^>]+href=")([^"]+)(")/g, (match, pre, src, post) => {
        if (src.startsWith('data:') || src.startsWith('http')) return match;
        const absPath = path.isAbsolute(src) ? src : path.resolve(notebookDir, src);
        try {
            const buf = fs.readFileSync(absPath);
            const ext = path.extname(absPath).toLowerCase();
            const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/jpeg';
            return pre + `data:${mime};base64,${buf.toString('base64')}` + post;
        } catch (_) { return match; }
    });
}

/**
 * Generate self-contained HTML for PDF export.
 */
function generatePdfHtml(notebook, notebookDir) {
    const cells = notebook.getCells().filter(c => !_isWBExportCell(c));

    // ---- Collect KaTeX CSS ----
    let katexCss = '';
    try {
        const katexCssPath = path.join(__dirname, '../../../wllatex-addon/node_modules/katex/dist/katex.min.css');
        katexCss = fs.readFileSync(katexCssPath, 'utf8');
        // Replace font URLs with inline data URIs
        const fontsDir = path.join(__dirname, '../../../wllatex-addon/node_modules/katex/dist/fonts');
        katexCss = katexCss.replace(/url\(fonts\/([^)]+)\)/g, (match, fontFile) => {
            try {
                const fontPath = path.join(fontsDir, fontFile);
                const buf = fs.readFileSync(fontPath);
                const ext = path.extname(fontFile).toLowerCase();
                const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : 'font/ttf';
                return `url(data:${mime};base64,${buf.toString('base64')})`;
            } catch (_) { return match; }
        });
    } catch (_) { /* KaTeX CSS not available — math won't render beautifully */ }

    // ---- WL custom element CSS (from renderer-css.js) ----
    const wlCss = `
:root { --fraction-line-width: max(0.08em,1px); --script-font-size: max(71%,8pt); --line-height: 1.1; }
w,wb,wrow,wsub,wsup,wsubsup,wover,wunder,wunderover,wfrac,wsqrt,wgraph,wgrid,wframe,wpane,wunknown,wfailed {
  margin:0;padding:0;border:0;font-size:100%;font:inherit;vertical-align:baseline;
  display:inline-block;white-space:nowrap;line-height:var(--line-height); }
.wexpr { font-family: Consolas, Courier, monospace; line-height: var(--line-height); }
.wexpr.traditional-form { font-family: 'Times New Roman', Times, serif; }
.wexpr > wrow, .wexpr > w, wframe > wrow, wframe > w, wpane > wrow, wpane > w
  { display:inline;white-space:normal;word-break:normal;overflow-wrap:anywhere; }
wrow > wrow, wrow > w { white-space:inherit;word-break:inherit;overflow-wrap:inherit; }
w.italic { font-style:italic; }
wfrac { text-align:center;margin:0 0.2ch;padding:0 0.2ch; }
wfrac > :first-child { display:block; }
wfrac > :last-child { display:grid; }
wfrac > :last-child > :first-child { border-top:solid var(--fraction-line-width);
  height:calc(1em * var(--line-height));margin-top:calc(-0.45em * var(--line-height));
  margin-bottom:calc(-0.4em * var(--line-height));transform:translateY(calc(0.6em * var(--line-height))); }
wfrac > :last-child > :last-child { display:block;z-index:1; }
wsup > :last-child { font-size:var(--script-font-size);vertical-align:1.3ex; }
wsub > :last-child { font-size:var(--script-font-size);vertical-align:-0.7ex; }
pre { font-family: Consolas, Courier, monospace; }
pre > .wl-message { color: #cc0000; }
pre.vscode-wolfram-print-output { font-size:0.85em; margin:0; padding:0; line-height:1.3; }
pre.vscode-wolfram-text-output, pre.vscode-wolfram-tex-source {
  font-family: Consolas, monospace;
  font-size: 13px;
  background: #f8f8f8;
  color: #1e1e1e;
  border: 1px solid #ddd;
  border-radius: 3px; padding: 6px 10px;
  white-space: pre-wrap; overflow-wrap: break-word; line-height: 1.5; margin: 2px 0; }
img.vscode-wolfram-svg-output, img.vscode-wolfram-png-output { background: transparent; max-width: 100%; }
.vscode-wolfram-svg-output > svg > rect:first-child { fill: none !important; }
div.mathml-output { overflow-x:auto; }
div.vscode-wolfram-tex-output { overflow-x:auto; padding: 4px 0; }
.wl-hl-str  { color: #a31515; }
.wl-hl-cmt  { color: #008000; font-style: italic; }
.wl-hl-num  { color: #098658; }
.wl-hl-sym  { color: #267f99; }
.wl-hl-cmd  { color: #0000ff; }
.wl-hl-math { color: #af00db; }
.wl-hl-brk  { color: #b8860b; }
`;

    // ---- Page-level CSS ----
    const pageCss = `
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: #1e1e1e;
    background: #ffffff;
    max-width: 900px;
    margin: 0 auto;
    padding: 20px 40px;
}
h1 { font-size: 2em; margin: 0.8em 0 0.4em; color: #1e1e1e; border-bottom: 1px solid #ccc; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; margin: 0.7em 0 0.3em; color: #1e1e1e; }
h3 { font-size: 1.25em; margin: 0.6em 0 0.3em; color: #1e1e1e; }
h4 { font-size: 1.1em; margin: 0.5em 0 0.2em; color: #1e1e1e; }
p { margin: 0.5em 0; }
code { font-family: Consolas, Courier, monospace; font-size: 0.9em; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
a { color: #0366d6; }
.cell-code {
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    margin: 8px 0;
    overflow: hidden;
}
.cell-code-label {
    font-size: 10px;
    color: #666;
    padding: 2px 8px;
    background: #eef1f5;
    border-bottom: 1px solid #d0d7de;
}
.cell-code pre {
    margin: 0;
    padding: 8px 12px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    color: #1e1e1e;
}
.cell-output {
    margin: 4px 0 12px 0;
    padding: 4px 12px;
}
.cell-output-label {
    font-size: 10px;
    color: #666;
    margin-bottom: 2px;
}
.cell-markdown {
    margin: 8px 0;
}
.katex-display-block {
    overflow-x: auto;
    padding: 8px 0;
}
`;

    // ---- Build cell HTML ----
    let cellsHtml = '';
    let codeIdx = 0;
    for (const cell of cells) {
        const src = cell.document.getText().trim();
        if (!src) continue;

        if (cell.kind === vscode.NotebookCellKind.Markup) {
            // Markdown cell
            cellsHtml += `<div class="cell-markdown">${_renderMarkdown(src)}</div>\n`;
        } else {
            // Code cell
            codeIdx++;
            const highlighted = _highlightWolfram(src);
            cellsHtml += `<div class="cell-code">`;
            cellsHtml += `<div class="cell-code-label">In[${codeIdx}]</div>`;
            cellsHtml += `<pre>${highlighted}</pre>`;
            cellsHtml += `</div>\n`;

            // Outputs
            if (cell.outputs && cell.outputs.length > 0) {
                for (const output of cell.outputs) {
                    if (!output.items || output.items.length === 0) continue;
                    // Find the rich HTML output
                    const htmlItem = output.items.find(it => it.mime === 'x-application/wolfram-language-html');
                    if (htmlItem) {
                        let outHtml;
                        if (htmlItem.data instanceof Uint8Array) {
                            outHtml = new util.TextDecoder().decode(htmlItem.data);
                        } else {
                            outHtml = String(htmlItem.data);
                        }
                        // Strip the wl-output-header div (format buttons etc) — keep content only
                        const contentMatch = outHtml.match(/<div class="wl-output-content">([\s\S]*?)<\/div>\s*<\/div>\s*$/);
                        const content = contentMatch ? contentMatch[1] : outHtml;
                        cellsHtml += `<div class="cell-output">${content}</div>\n`;
                        continue;
                    }
                    // Fallback: text/plain
                    const plainItem = output.items.find(it => it.mime === 'text/plain');
                    if (plainItem) {
                        let plainText;
                        if (plainItem.data instanceof Uint8Array) {
                            plainText = new util.TextDecoder().decode(plainItem.data);
                        } else {
                            plainText = String(plainItem.data);
                        }
                        cellsHtml += `<div class="cell-output"><pre>${_esc(plainText)}</pre></div>\n`;
                    }
                }
            }
        }
    }

    // Inline images as data URIs
    cellsHtml = _inlineImages(cellsHtml, notebookDir);
    cellsHtml = _inlineSvgImages(cellsHtml, notebookDir);

    // ---- Assemble full HTML document ----
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wolfbook Export</title>
<style>${katexCss}</style>
<style>${wlCss}</style>
<style>${pageCss}</style>
</head>
<body>
${cellsHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Markdown Export
// ---------------------------------------------------------------------------

// Extract all <img src="..."> references from HTML, save them into mdImgDir,
// and return the HTML with src replaced by relative markdown image paths.
function _extractAndSaveImages(html, notebookDir, mdImgDir, mdDir) {
    let imgIdx = 0;
    // Handle <img src="..."> tags
    html = html.replace(/<img[^>]+src="([^"]+)"[^>]*>/g, (tag, src) => {
        let buf;
        let ext;
        if (src.startsWith('data:')) {
            // data URI — decode it
            const m = src.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!m) return tag;
            ext = m[1] === 'svg+xml' ? 'svg' : m[1];
            buf = Buffer.from(m[2], 'base64');
        } else if (src.startsWith('http://') || src.startsWith('https://')) {
            return tag; // keep remote URLs as-is in markdown
        } else {
            // relative or absolute file path
            const absPath = path.isAbsolute(src) ? src : path.resolve(notebookDir, src);
            try { buf = fs.readFileSync(absPath); } catch (_) { return tag; }
            ext = path.extname(absPath).replace('.', '') || 'png';
        }
        imgIdx++;
        const fname = `output_${imgIdx}.${ext}`;
        const savePath = path.join(mdImgDir, fname);
        try {
            fs.mkdirSync(mdImgDir, { recursive: true });
            fs.writeFileSync(savePath, buf);
        } catch (_) { return tag; }
        const relFromMd = path.relative(mdDir, savePath);
        return `![output](${relFromMd})`;
    });
    // Handle inline SVGs: convert to .svg files
    html = html.replace(/<svg[\s\S]*?<\/svg>/g, (svgTag) => {
        imgIdx++;
        const fname = `output_${imgIdx}.svg`;
        const savePath = path.join(mdImgDir, fname);
        try {
            fs.mkdirSync(mdImgDir, { recursive: true });
            fs.writeFileSync(savePath, svgTag, 'utf8');
        } catch (_) { return svgTag; }
        const relFromMd = path.relative(mdDir, savePath);
        return `![output](${relFromMd})`;
    });
    return html;
}

// Strip HTML tags (simple) — used for text fallback from output HTML
function _stripHtml(html) {
    return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
}

/**
 * Generate Markdown content from the notebook.
 * Images from outputs are extracted to mdImgDir and referenced relatively.
 */
function generateMarkdownContent(notebook, notebookDir, mdPath) {
    const cells = notebook.getCells().filter(c => !_isWBExportCell(c));
    const mdDir = path.dirname(mdPath);
    const mdBase = path.basename(mdPath, path.extname(mdPath));
    const mdImgDir = path.join(mdDir, mdBase + '_images');
    let globalImgIdx = 0;

    let md = '';
    let codeIdx = 0;

    for (const cell of cells) {
        const src = cell.document.getText().trim();
        if (!src) continue;

        if (cell.kind === vscode.NotebookCellKind.Markup) {
            // Markdown cells pass through directly
            md += src + '\n\n';
        } else {
            // Code cell
            codeIdx++;
            md += '```mathematica\n' + src + '\n```\n\n';

            // Outputs
            if (cell.outputs && cell.outputs.length > 0) {
                for (const output of cell.outputs) {
                    if (!output.items || output.items.length === 0) continue;

                    const htmlItem = output.items.find(it => it.mime === 'x-application/wolfram-language-html');
                    const plainItem = output.items.find(it => it.mime === 'text/plain');

                    if (htmlItem) {
                        let outHtml;
                        if (htmlItem.data instanceof Uint8Array) {
                            outHtml = new util.TextDecoder().decode(htmlItem.data);
                        } else {
                            outHtml = String(htmlItem.data);
                        }
                        // Strip wl-output-header
                        const contentMatch = outHtml.match(/<div class="wl-output-content">([\s\S]*?)<\/div>\s*<\/div>\s*$/);
                        const content = contentMatch ? contentMatch[1] : outHtml;

                        // Check if output has images/graphics
                        const hasGraphics = content.includes('<img ') || content.includes('<svg') ||
                                          content.includes('vscode-wolfram-svg-output') || content.includes('vscode-wolfram-png-output');

                        if (hasGraphics) {
                            // Extract images and save as files
                            // First inline any relative image paths to data URIs, then extract
                            let inlined = _inlineImages(content, notebookDir);
                            inlined = _inlineSvgImages(inlined, notebookDir);

                            // Now extract <img> and <svg> to files
                            const imgResult = _extractAndSaveImages(inlined, notebookDir, mdImgDir, mdDir);
                            // imgResult should now have ![output](...) references
                            md += imgResult + '\n\n';
                        } else if (plainItem) {
                            // Non-graphic output — use plain text
                            let plainText;
                            if (plainItem.data instanceof Uint8Array) {
                                plainText = new util.TextDecoder().decode(plainItem.data);
                            } else {
                                plainText = String(plainItem.data);
                            }
                            if (plainText.trim()) {
                                md += '> ' + plainText.trim().replace(/\n/g, '\n> ') + '\n\n';
                            }
                        } else {
                            // Strip HTML to get text
                            const stripped = _stripHtml(content);
                            if (stripped) {
                                md += '> ' + stripped.replace(/\n/g, '\n> ') + '\n\n';
                            }
                        }
                        continue;
                    }

                    if (plainItem) {
                        let plainText;
                        if (plainItem.data instanceof Uint8Array) {
                            plainText = new util.TextDecoder().decode(plainItem.data);
                        } else {
                            plainText = String(plainItem.data);
                        }
                        if (plainText.trim()) {
                            md += '> ' + plainText.trim().replace(/\n/g, '\n> ') + '\n\n';
                        }
                    }
                }
            }
        }
    }

    return { content: md, imgDir: mdImgDir };
}

// ---------------------------------------------------------------------------
// LaTeX Export
// ---------------------------------------------------------------------------

// Escape special LaTeX characters in plain text
function _texEscape(s) {
    return s
        .replace(/\\/g, '\\textbackslash{}')
        .replace(/&/g, '\\&')
        .replace(/%/g, '\\%')
        .replace(/\$/g, '\\$')
        .replace(/#/g, '\\#')
        .replace(/_/g, '\\_')
        .replace(/\{/g, '\\{')
        .replace(/}/g, '\\}')
        .replace(/~/g, '\\textasciitilde{}')
        .replace(/\^/g, '\\textasciicircum{}');
}

// Convert markdown source to LaTeX.
// Images in markdown (![](...)) become \includegraphics referencing copied files.
function _mdToLatex(text, imgDir, texDir, imgCounter) {
    let tex = '';
    const lines = text.split('\n');
    let paragraphLines = [];

    const flushParagraph = () => {
        if (paragraphLines.length === 0) return;
        tex += paragraphLines.join(' ') + '\n\n';
        paragraphLines = [];
    };

    const inlineLatex = line => {
        // Bold
        line = line.replace(/\*\*(.+?)\*\*/g, (_, t) => `\\textbf{${t}}`);
        // Italic
        line = line.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, (_, t) => `\\textit{${t}}`);
        // Inline code
        line = line.replace(/`([^`]+?)`/g, (_, t) => `\\texttt{${_texEscape(t)}}`);
        // Images ![alt](path)
        line = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
            // Copy image file to imgDir
            let absPath = path.isAbsolute(src) ? src : src; // will resolve later per-context
            return `\\includegraphics[max width=\\linewidth]{${src}}`;
        });
        // Links [text](url)
        line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, url) => `\\href{${url}}{${t}}`);
        return line;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { flushParagraph(); continue; }

        const hm = /^(#{1,6})\s+(.+)$/.exec(trimmed);
        if (hm) {
            flushParagraph();
            const level = hm[1].length;
            const cmd = ['section','subsection','subsubsection','paragraph','subparagraph','subparagraph'][Math.min(level-1,5)];
            tex += `\\${cmd}{${inlineLatex(hm[2])}}\n`;
            continue;
        }
        // Display math $$...$$
        if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
            flushParagraph();
            const mathContent = trimmed.slice(2, -2).trim();
            tex += `\\[\n${mathContent}\n\\]\n`;
            continue;
        }
        paragraphLines.push(inlineLatex(trimmed));
    }
    flushParagraph();
    return tex;
}

/**
 * Generate LaTeX content from the notebook.
 * Images from outputs are extracted to texImgDir and \includegraphics-referenced.
 */
function generateLatexContent(notebook, notebookDir, texPath) {
    const cells = notebook.getCells().filter(c => !_isWBExportCell(c));
    const texDir = path.dirname(texPath);
    const texBase = path.basename(texPath, path.extname(texPath));
    const texImgDir = path.join(texDir, texBase + '_images');
    let imgIdx = 0;

    // Helper: save a buffer to texImgDir, return path relative to texDir
    const saveImg = (buf, ext) => {
        imgIdx++;
        const fname = `output_${imgIdx}.${ext}`;
        const savePath = path.join(texImgDir, fname);
        fs.mkdirSync(texImgDir, { recursive: true });
        fs.writeFileSync(savePath, buf);
        return path.relative(texDir, savePath).replace(/\\/g, '/');
    };

    // Extract images from HTML output, save them, return array of {relPath, isGraphic}
    const extractOutputImages = (html) => {
        const imgs = [];
        // <img src="..."> elements
        html.replace(/<img[^>]+src="([^"]+)"[^>]*>/g, (_, src) => {
            let buf, ext;
            if (src.startsWith('data:')) {
                const m = src.match(/^data:image\/(\w+);base64,(.+)$/);
                if (!m) return;
                ext = m[1] === 'svg+xml' ? 'svg' : m[1];
                buf = Buffer.from(m[2], 'base64');
            } else {
                const absPath = path.isAbsolute(src) ? src : path.resolve(notebookDir, src);
                try { buf = fs.readFileSync(absPath); } catch (_) { return; }
                ext = path.extname(absPath).replace('.', '') || 'png';
            }
            imgs.push(saveImg(buf, ext));
        });
        // Inline <svg>...</svg>
        html.replace(/<svg[\s\S]*?<\/svg>/g, (svgTag) => {
            imgs.push(saveImg(Buffer.from(svgTag, 'utf8'), 'svg'));
        });
        return imgs;
    };

    let body = '';
    let codeIdx = 0;

    for (const cell of cells) {
        const src = cell.document.getText().trim();
        if (!src) continue;

        if (cell.kind === vscode.NotebookCellKind.Markup) {
            body += _mdToLatex(src, texImgDir, texDir, { n: imgIdx }) + '\n';
        } else {
            codeIdx++;
            body += `\\begin{lstlisting}[language=Mathematica,label={in${codeIdx}},caption={In[${codeIdx}]}]\n`;
            body += src + '\n';
            body += `\\end{lstlisting}\n\n`;

            // Outputs
            if (cell.outputs && cell.outputs.length > 0) {
                for (const output of cell.outputs) {
                    if (!output.items || output.items.length === 0) continue;

                    const htmlItem = output.items.find(it => it.mime === 'x-application/wolfram-language-html');
                    const plainItem = output.items.find(it => it.mime === 'text/plain');

                    if (htmlItem) {
                        let outHtml;
                        if (htmlItem.data instanceof Uint8Array) {
                            outHtml = new util.TextDecoder().decode(htmlItem.data);
                        } else {
                            outHtml = String(htmlItem.data);
                        }
                        // Strip header wrapper
                        const cm = outHtml.match(/<div class="wl-output-content">([\s\S]*?)<\/div>\s*<\/div>\s*$/);
                        const content = cm ? cm[1] : outHtml;

                        // Inline relative image references before extracting
                        const inlined = _inlineSvgImages(_inlineImages(content, notebookDir), notebookDir);
                        const imgs = extractOutputImages(inlined);

                        if (imgs.length > 0) {
                            body += `\\begin{figure}[H]\n\\centering\n`;
                            for (const imgRel of imgs) {
                                body += `\\includegraphics[max width=\\linewidth]{${imgRel}}\n`;
                            }
                            body += `\\end{figure}\n\n`;
                        } else if (plainItem) {
                            let pt;
                            if (plainItem.data instanceof Uint8Array) pt = new util.TextDecoder().decode(plainItem.data);
                            else pt = String(plainItem.data);
                            if (pt.trim()) body += `\\begin{verbatim}\n${pt.trim()}\n\\end{verbatim}\n\n`;
                        } else {
                            const stripped = _stripHtml(content);
                            if (stripped) body += `\\begin{verbatim}\n${stripped}\n\\end{verbatim}\n\n`;
                        }
                        continue;
                    }
                    if (plainItem) {
                        let pt;
                        if (plainItem.data instanceof Uint8Array) pt = new util.TextDecoder().decode(plainItem.data);
                        else pt = String(plainItem.data);
                        if (pt.trim()) body += `\\begin{verbatim}\n${pt.trim()}\n\\end{verbatim}\n\n`;
                    }
                }
            }
        }
    }

    const preamble = `\\documentclass[12pt]{article}
\\usepackage[a4paper, margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{listings}
\\usepackage{graphicx}
\\usepackage[export]{adjustbox}
\\usepackage{float}
\\usepackage{hyperref}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\lstdefinelanguage{Mathematica}{
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{blue},
  commentstyle=\\color{green!60!black}\\itshape,
  stringstyle=\\color{orange!80!black},
  morestring=[b]",
  morecomment=[n]{(*}{*)},
  breaklines=true,
  breakatwhitespace=false,
  frame=single,
  framesep=4pt,
  xleftmargin=4pt,
  xrightmargin=4pt,
}
\\begin{document}\n`;

    return { content: preamble + body + `\\end{document}\n`, imgDir: texImgDir };
}

// Locate Chrome/Chromium executable
function _findChrome() {
    const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ];
    for (const c of candidates) {
        try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
    }
    return null;
}

/**
 * Export the notebook as a PDF using Chrome headless.
 */
async function handlePdfExport(pdfPath, notebookDir, notebookFsPath, currentExecution) {
    const notebook = currentExecution.execution.cell.notebook;

    const showOut = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain')
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    // 1. Find Chrome
    const chrome = _findChrome();
    if (!chrome) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport PDF: Chrome/Chromium not found. Please install Google Chrome.</div>`,
            `WBExport PDF: Chrome/Chromium not found.`
        );
        return;
    }

    // 2. Generate HTML
    let htmlContent;
    try {
        htmlContent = generatePdfHtml(notebook, notebookDir);
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport PDF failed: ${_esc(err.message)}</div>`,
            `WBExport PDF failed: ${err.message}`
        );
        return;
    }

    // 3. Write temp HTML
    const tmpHtml = path.join(require('os').tmpdir(), `wolfbook_export_${Date.now()}.html`);
    try {
        fs.writeFileSync(tmpHtml, htmlContent, 'utf8');
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport PDF: could not write temp HTML: ${_esc(err.message)}</div>`,
            `WBExport PDF: could not write temp HTML: ${err.message}`
        );
        return;
    }

    // 4. Convert HTML → PDF via Chrome headless
    try {
        fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
        await execFileAsync(chrome, [
            '--headless',
            '--disable-gpu',
            '--no-sandbox',
            `--print-to-pdf=${pdfPath}`,
            '--no-pdf-header-footer',
            tmpHtml
        ], { timeout: 30000 });
    } catch (err) {
        // Clean up temp file
        try { fs.unlinkSync(tmpHtml); } catch (_) {}
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport PDF: Chrome conversion failed: ${_esc(err.message)}</div>`,
            `WBExport PDF: Chrome conversion failed: ${err.message}`
        );
        return;
    }

    // 5. Clean up temp file
    try { fs.unlinkSync(tmpHtml); } catch (_) {}

    const relPath = path.relative(notebookDir, pdfPath);
    const nCells = notebook.getCells().filter(c => c.document.getText().trim()).length;
    await showOut(
        `<div style="color:#090;font-size:12px;padding:4px 0;">✅ WBExport: saved <code>${_esc(relPath)}</code> (${nCells} cells, PDF)</div>`,
        `WBExport: saved ${relPath} (${nCells} cells, PDF)`
    );
}

/**
 * Export the notebook as a LaTeX file.
 */
async function handleTexExport(texPath, notebookDir, notebookFsPath, currentExecution) {
    const notebook = currentExecution.execution.cell.notebook;

    const showOut = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain')
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    let result;
    try {
        result = generateLatexContent(notebook, notebookDir, texPath);
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport TeX failed: ${_esc(err.message)}</div>`,
            `WBExport TeX failed: ${err.message}`
        );
        return;
    }

    try {
        fs.mkdirSync(path.dirname(texPath), { recursive: true });
        fs.writeFileSync(texPath, result.content, 'utf8');
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport TeX: could not write file: ${_esc(err.message)}</div>`,
            `WBExport TeX: could not write file: ${err.message}`
        );
        return;
    }

    const relPath = path.relative(notebookDir, texPath);
    const nCells = notebook.getCells().filter(c => c.document.getText().trim() && !_isWBExportCell(c)).length;
    let imgNote = '';
    try {
        if (fs.existsSync(result.imgDir) && fs.readdirSync(result.imgDir).length > 0) {
            const imgRelPath = path.relative(notebookDir, result.imgDir);
            imgNote = ` + images in <code>${_esc(imgRelPath)}/</code>`;
        }
    } catch (_) {}
    await showOut(
        `<div style="color:#090;font-size:12px;padding:4px 0;">✅ WBExport: saved <code>${_esc(relPath)}</code> (${nCells} cells, LaTeX)${imgNote}</div>`,
        `WBExport: saved ${relPath} (${nCells} cells, LaTeX)`
    );
}

/**
 * Export the notebook as a Markdown file.
 */
async function handleMdExport(mdPath, notebookDir, notebookFsPath, currentExecution) {
    const notebook = currentExecution.execution.cell.notebook;

    const showOut = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain')
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    let result;
    try {
        result = generateMarkdownContent(notebook, notebookDir, mdPath);
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport MD failed: ${_esc(err.message)}</div>`,
            `WBExport MD failed: ${err.message}`
        );
        return;
    }

    try {
        fs.mkdirSync(path.dirname(mdPath), { recursive: true });
        fs.writeFileSync(mdPath, result.content, 'utf8');
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport MD: could not write file: ${_esc(err.message)}</div>`,
            `WBExport MD: could not write file: ${err.message}`
        );
        return;
    }

    const relPath = path.relative(notebookDir, mdPath);
    const nCells = notebook.getCells().filter(c => c.document.getText().trim()).length;
    // Check if images were saved
    let imgNote = '';
    try {
        if (fs.existsSync(result.imgDir) && fs.readdirSync(result.imgDir).length > 0) {
            const imgRelPath = path.relative(notebookDir, result.imgDir);
            imgNote = ` + images in <code>${_esc(imgRelPath)}/</code>`;
        }
    } catch (_) {}
    await showOut(
        `<div style="color:#090;font-size:12px;padding:4px 0;">✅ WBExport: saved <code>${_esc(relPath)}</code> (${nCells} cells, Markdown)${imgNote}</div>`,
        `WBExport: saved ${relPath} (${nCells} cells, Markdown)`
    );
}

/**
 * Export the notebook as a standalone HTML file.
 */
async function handleHtmlExport(htmlPath, notebookDir, notebookFsPath, currentExecution) {
    const notebook = currentExecution.execution.cell.notebook;

    const showOut = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain')
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    let htmlContent;
    try {
        htmlContent = generatePdfHtml(notebook, notebookDir);
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport HTML failed: ${_esc(err.message)}</div>`,
            `WBExport HTML failed: ${err.message}`
        );
        return;
    }

    try {
        fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
        fs.writeFileSync(htmlPath, htmlContent, 'utf8');
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport HTML: could not write file: ${_esc(err.message)}</div>`,
            `WBExport HTML: could not write file: ${err.message}`
        );
        return;
    }

    const relPath = path.relative(notebookDir, htmlPath);
    const nCells = notebook.getCells().filter(c => c.document.getText().trim()).length;
    await showOut(
        `<div style="color:#090;font-size:12px;padding:4px 0;">✅ WBExport: saved <code>${_esc(relPath)}</code> (${nCells} cells, HTML)</div>`,
        `WBExport: saved ${relPath} (${nCells} cells, HTML)`
    );
}

/**
 * Handle a WBExport[] or WBExport["path"] sub-expression.
 *
 * @param {string|null}  outputArg        — path from WBExport["..."], or null
 * @param {string}       notebookDir      — directory of the host notebook
 * @param {string}       notebookFsPath   — full path of the host notebook file
 * @param {object}       currentExecution — execution descriptor
 */
// ---------------------------------------------------------------------------
// .wl / .wls Export — bare Wolfram Language script
// Code cells → raw source separated by blank lines.
// Markdown headings → (* ===== Title ===== *) banner comments.
// Other markdown cells → (* text *) block comments.
// ---------------------------------------------------------------------------
function generateWlContent(notebook) {
    const cells = notebook.getCells().filter(c => !_isWBExportCell(c));
    const parts = [];
    for (const cell of cells) {
        const src = cell.document.getText();
        const trimmed = src.trim();
        if (!trimmed) continue;

        if (cell.kind === vscode.NotebookCellKind.Markup) {
            // Headings → banner comment
            const h1 = /^#[ \t]+(.+)$/.exec(trimmed);
            if (h1 && trimmed === h1[0]) {
                const title = h1[1].trim();
                const bar = '(* ' + '='.repeat(Math.max(4, 72 - title.length - 7)) + ' ' + title + ' ' + '='.repeat(3) + ' *)';
                parts.push(bar);
                continue;
            }
            const h2 = /^##[ \t]+(.+)$/.exec(trimmed);
            if (h2 && trimmed === h2[0]) {
                const title = h2[1].trim();
                const bar = '(* --- ' + title + ' --- *)';
                parts.push(bar);
                continue;
            }
            const h3 = /^###[ \t]+(.+)$/.exec(trimmed);
            if (h3 && trimmed === h3[0]) {
                const title = h3[1].trim();
                parts.push('(* ' + title + ' *)');
                continue;
            }
            // Other markdown: wrap each line in a block comment
            const lines = trimmed.split('\n').map(l => ' * ' + l).join('\n');
            parts.push('(*\n' + lines + '\n *)');
        } else {
            // Code cell: emit verbatim
            parts.push(trimmed);
        }
    }
    return parts.join('\n\n') + '\n';
}

async function handleWlExport(wlPath, notebookDir, notebookFsPath, currentExecution) {
    const notebook = currentExecution.execution.cell.notebook;

    const showOut = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain')
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    let content;
    try {
        content = generateWlContent(notebook);
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport .wl failed: ${_esc(err.message)}</div>`,
            `WBExport .wl failed: ${err.message}`
        );
        return;
    }

    try {
        fs.mkdirSync(path.dirname(wlPath), { recursive: true });
        fs.writeFileSync(wlPath, content, 'utf8');
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport: could not write file: ${_esc(err.message)}</div>`,
            `WBExport: could not write file: ${err.message}`
        );
        return;
    }

    const nCode = notebook.getCells().filter(c => c.kind === vscode.NotebookCellKind.Code && !_isWBExportCell(c) && c.document.getText().trim()).length;
    const relPath = path.relative(notebookDir, wlPath);
    await showOut(
        `<div style="color:#090;font-size:12px;padding:4px 0;">✅ WBExport: saved <code>${relPath}</code> (${nCode} code cells)</div>`,
        `WBExport: saved ${relPath} (${nCode} code cells)`
    );
}

async function handleWBExport(outputArg, notebookDir, notebookFsPath, currentExecution) {
    const notebook  = currentExecution.execution.cell.notebook;
    const baseName  = path.basename(notebookFsPath).replace(/\.(wb|evsnb|vsnb)$/i, '');

    // ---- PDF export branch ----
    if (outputArg && /\.pdf$/i.test(outputArg)) {
        const pdfPath = path.isAbsolute(outputArg)
            ? outputArg
            : path.resolve(notebookDir, outputArg);
        return handlePdfExport(pdfPath, notebookDir, notebookFsPath, currentExecution);
    }

    // ---- HTML export branch ----
    if (outputArg && /\.html?$/i.test(outputArg)) {
        const htmlPath = path.isAbsolute(outputArg)
            ? outputArg
            : path.resolve(notebookDir, outputArg);
        return handleHtmlExport(htmlPath, notebookDir, notebookFsPath, currentExecution);
    }

    // ---- Markdown export branch ----
    if (outputArg && /\.md$/i.test(outputArg)) {
        const mdPath = path.isAbsolute(outputArg)
            ? outputArg
            : path.resolve(notebookDir, outputArg);
        return handleMdExport(mdPath, notebookDir, notebookFsPath, currentExecution);
    }

    // ---- LaTeX export branch ----
    if (outputArg && /\.tex$/i.test(outputArg)) {
        const texPath = path.isAbsolute(outputArg)
            ? outputArg
            : path.resolve(notebookDir, outputArg);
        return handleTexExport(texPath, notebookDir, notebookFsPath, currentExecution);
    }

    // ---- .wl / .wls export: bare Wolfram Language script ----
    if (outputArg && /\.wls?$/i.test(outputArg)) {
        const wlPath = path.isAbsolute(outputArg)
            ? outputArg
            : path.resolve(notebookDir, outputArg);
        return handleWlExport(wlPath, notebookDir, notebookFsPath, currentExecution);
    }

    // ---- Default: .nb export ----
    const nbPath = outputArg
        ? (path.isAbsolute(outputArg) ? outputArg : path.resolve(notebookDir, outputArg))
        : path.join(notebookDir, baseName + '.nb');

    const showOut = async (html, plain) => {
        const out = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(html, 'x-application/wolfram-language-html'),
            vscode.NotebookCellOutputItem.text(plain, 'text/plain')
        ]);
        if (currentExecution.hasOutput) {
            await currentExecution.execution.appendOutput(out);
        } else {
            currentExecution.hasOutput = true;
            await currentExecution.execution.replaceOutput(out);
        }
    };

    let content;
    try {
        content = generateNbContent(notebook);
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport failed: ${err.message.replace(/</g, '&lt;')}</div>`,
            `WBExport failed: ${err.message}`
        );
        return;
    }

    try {
        fs.mkdirSync(path.dirname(nbPath), { recursive: true });
        fs.writeFileSync(nbPath, content, 'utf8');
    } catch (err) {
        await showOut(
            `<div style="color:#c00;font-size:12px;padding:4px 0;">❌ WBExport: could not write file: ${err.message.replace(/</g, '&lt;')}</div>`,
            `WBExport: could not write file: ${err.message}`
        );
        return;
    }

    const nCells  = notebook.getCells().filter(c => c.document.getText().trim()).length;
    const relPath = path.relative(notebookDir, nbPath);
    await showOut(
        `<div style="color:#090;font-size:12px;padding:4px 0;">✅ WBExport: saved <code>${relPath}</code> (${nCells} cells)</div>`,
        `WBExport: saved ${relPath} (${nCells} cells)`
    );
}

module.exports = { handleWBExport };
