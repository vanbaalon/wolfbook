'use strict';
// execution/wb-export.js — handles WBExport[] / WBExport["path"] interception.
// Converts the current notebook to a Mathematica .nb file.

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

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
    const cells = notebook.getCells();
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

/**
 * Handle a WBExport[] or WBExport["path"] sub-expression.
 *
 * @param {string|null}  outputArg        — path from WBExport["..."], or null
 * @param {string}       notebookDir      — directory of the host notebook
 * @param {string}       notebookFsPath   — full path of the host notebook file
 * @param {object}       currentExecution — execution descriptor
 */
async function handleWBExport(outputArg, notebookDir, notebookFsPath, currentExecution) {
    const notebook  = currentExecution.execution.cell.notebook;
    const baseName  = path.basename(notebookFsPath).replace(/\.(wb|evsnb|vsnb)$/i, '');

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
