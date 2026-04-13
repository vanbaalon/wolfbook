"use strict";
// Wolfbook Copilot Language Model Tools — Phase 4
// Registered in extension.js activate(); declared in package.json contributes.languageModelTools.

const vscode = require("vscode");
const util   = require("util");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const { decodeWstpText } = require('../utils/encoding');
const paperSearch = require('./paperSearch');

// ---------------------------------------------------------------------------
// Shared: append an entry to the evaluation log next to the active notebook
// Log lives at:  <notebook-dir>/img/<notebook-name>/ai_eval_log.md
// ---------------------------------------------------------------------------

// Called from lifecycle.js on every kernel launch — appends a restart marker
// so the full action history is preserved across kernel reboots.
function clearEvalLog() {
    try {
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
        if (!editor) return;
        const notebookPath = editor.notebook.uri.fsPath;
        const notebookDir  = path.dirname(notebookPath);
        const notebookName = path.basename(notebookPath, path.extname(notebookPath));
        const logDir       = path.join(notebookDir, 'img', notebookName);
        const logPath      = path.join(logDir, 'ai_eval_log.md');
        fs.mkdirSync(logDir, { recursive: true });
        const stamp   = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const isFirst = !fs.existsSync(logPath);
        const entry   = isFirst
            ? `# AI Action Log — ${notebookName}\n\n## ${stamp} — 🌟 KERNEL START\n\n`
            : `\n---\n\n## ${stamp} — 🔄 KERNEL RESTART\n\n`;
        fs.appendFileSync(logPath, entry, 'utf8');
    } catch (_) {}
}

function appendEvalLog(expression, output) {
    try {
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
        if (!editor) return;
        const notebookPath = editor.notebook.uri.fsPath;
        const notebookDir  = path.dirname(notebookPath);
        const notebookName = path.basename(notebookPath, path.extname(notebookPath));
        const logDir       = path.join(notebookDir, 'img', notebookName);
        const logPath      = path.join(logDir, 'ai_eval_log.md');

        // Ensure directory exists
        fs.mkdirSync(logDir, { recursive: true });

        const stamp   = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const isFirst = !fs.existsSync(logPath);
        const entry = [
            isFirst ? `# AI Evaluation Log — ${notebookName}\n` : '',
            `## ${stamp}`,
            '**Input:**',
            '```wolfram',
            expression.trim(),
            '```',
            '**Output:**',
            '```',
            String(output).trim(),
            '```',
            ''
        ].join('\n');
        fs.appendFileSync(logPath, entry, 'utf8');
    } catch (_) {
        // Logging is best-effort; never crash the tool
    }
}

// Append a structural action event (insert/edit/delete cell, save, etc.) to the same log.
function appendEventLog(action, detail) {
    try {
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
        if (!editor) return;
        const notebookPath = editor.notebook.uri.fsPath;
        const notebookDir  = path.dirname(notebookPath);
        const notebookName = path.basename(notebookPath, path.extname(notebookPath));
        const logDir       = path.join(notebookDir, 'img', notebookName);
        const logPath      = path.join(logDir, 'ai_eval_log.md');
        fs.mkdirSync(logDir, { recursive: true });
        const stamp   = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const isFirst = !fs.existsSync(logPath);
        const header  = isFirst ? `# AI Action Log — ${notebookName}\n\n` : '';
        const body    = detail ? `\n${detail.trim()}\n` : '';
        fs.appendFileSync(logPath, `${header}## ${stamp} — ${action}${body}\n`, 'utf8');
    } catch (_) {}
}

// Normalise cell content sent by the LLM, which sometimes double-encodes
// escape sequences (outputting literal \n, \" instead of real newline/quote).
//
// Rule 1 — newlines: if there are NO actual newlines but there ARE literal \n
//   sequences, the whole string was double-encoded → unescape \n, \t, \r.
// Rule 2 — quotes: if EVERY " is escaped as \" (no bare ") → the model
//   over-encoded quotes → unescape \" and \\ together (one pass, left-to-right,
//   so \\\" (\\ then \") correctly becomes \" in WL).
function normalizeToolContent(s) {
    let c = String(s);
    // Rule 1: double-encoded newlines
    if (!c.includes('\n') && c.includes('\\n')) {
        c = c.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '');
    }
    // Rule 2: double-encoded quotes (all " are escaped — no bare " present)
    if (c.includes('\\"') && !/(?<!\\)"/.test(c)) {
        c = c.replace(/\\(["\\])/g, '$1');
    }
    // Rule 3: JavaScript-style \uXXXX unicode escapes → actual character.
    // The model sometimes emits \u2014 (6 chars) instead of — (em-dash), etc.
    // This pattern never appears in valid WL code (WL uses \:2014) or LaTeX
    // (\u is only ever followed by command letters, not exactly 4 hex digits).
    if (c.includes('\\u')) {
        c = c.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    return c;
}

/**
 * Split multi-line Wolfram Language code into individually evaluable statements.
 *
 * Lines are joined together (not split) when any of the following hold:
 *  (a) Bracket depth > 0 — inside unclosed (, [, or {
 *  (b) Inside a string literal "..." or a comment (* ... *)
 *  (c) The line ends with a binary/infix continuation operator
 *
 * Tracked operators that signal continuation (longest-first to avoid prefix matches):
 *   //@  //. //  /.  /@  @@@  @@  &&  ||  <>  ->  :>  ;;  ~~ ^:= :=
 *   +=  -=  *=  /=  ^=  =.  ==  and single chars @  +  -  *  /  |  ~  =
 *
 * Handles: nested comments (* … (* … *) … *), string \" escapes,
 *   [[ Part ]] (counts as 2 bracket levels, balanced correctly).
 *
 * Returns an array of trimmed, non-empty, non-comment-only expression strings.
 */
function splitWLIntoStatements(code) {
    // Trailing-operator regex. Applied to trimmed tail at depth=0.
    // Order: longest alternatives before shorter prefix-of-them.
    const CONT_OP = /(?:\/\/@|\/\/\.|\/\/|\/\.|\/\@|@@@|@@|&&|\|\||<>|->|:>|;;|~~|\^:=|:=|\+=|-=|\*=|\/=|\^=|=\.|==|[@+\-*\/|~=])\s*$/;

    const rawLines = code.split('\n');
    const stmts = [];
    let buf = [];
    let depth = 0;
    let inStr  = false;
    let inCmt  = 0;       // nesting depth of (* ... *)

    for (const line of rawLines) {
        buf.push(line);

        // Update parse-state for every character on this line.
        let i = 0;
        while (i < line.length) {
            const ch   = line[i];
            const next = i + 1 < line.length ? line[i + 1] : '';

            if (inStr) {
                if (ch === '\\' && next) { i += 2; continue; }  // skip escaped char
                if (ch === '"')          { inStr = false; }
                i++; continue;
            }

            if (inCmt > 0) {
                if (ch === '(' && next === '*') { inCmt++; i += 2; continue; }
                if (ch === '*' && next === ')') { inCmt--; i += 2; continue; }
                i++; continue;
            }

            // Normal code
            if      (ch === '"')                        { inStr = true; }
            else if (ch === '(' && next === '*')        { inCmt = 1; i += 2; continue; }
            else if (ch === '<' && next === '|')        { depth++; i += 2; continue; }  // <| Association open
            else if (ch === '|' && next === '>')        { depth = Math.max(0, depth - 1); i += 2; continue; }  // |> Association close
            else if (ch === '(' || ch === '[' || ch === '{') { depth++; }
            else if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); }
            i++;
        }

        // Can we close the current statement here?
        if (depth === 0 && !inStr && inCmt === 0) {
            const combined = buf.join('\n');
            if (!CONT_OP.test(combined.trimEnd())) {
                const stmt = combined.trim();
                if (stmt) stmts.push(stmt);
                buf = [];
            }
        }
    }

    // Flush any remaining content (e.g. unclosed bracket — send as-is so the kernel
    // reports a meaningful error rather than a silent incomplete expression).
    if (buf.length > 0) {
        const stmt = buf.join('\n').trim();
        if (stmt) stmts.push(stmt);
    }

    // Drop statements that are purely comments — they evaluate to Null and waste a round-trip.
    return stmts.filter(s => !/^\(\*[\s\S]*\*\)\s*$/.test(s));
}

// KaTeX validation — lazy-load the katex module (same bundle used by wllatex-addon).
let _katex = null;
function _loadKatexForValidation() {    if (_katex) return _katex;
    try {
        // katex is bundled alongside the wllatex-addon; load it from there.
        const addonDir = path.join(__dirname, '../../../wllatex-addon');
        _katex = require(path.join(addonDir, 'node_modules', 'katex'));
    } catch (_) {}
    return _katex;
}

/**
 * Check all $...$ and $$...$$ spans in a markdown string for KaTeX parse errors.
 * Returns an array of { display: bool, latex: string, message: string } objects.
 * Returns [] when katex is unavailable or no errors are found.
 */
function checkMarkdownKaTeX(content) {
    const katex = _loadKatexForValidation();
    if (!katex) return [];
    const errors = [];

    // Extract display-math blocks first ($$...$$), then inline ($...$).
    // Use a single scan to avoid double-matching.
    const re = /\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        const isDisplay = m[1] !== undefined;
        const latex = (isDisplay ? m[1] : m[2]).trim();
        if (!latex) continue;
        try {
            katex.renderToString(latex, {
                displayMode: isDisplay,
                throwOnError: true,
                strict: false,
                macros: {
                    '\\dd': '\\mathrm{d}',
                    '\\R': '\\mathbb{R}',
                    '\\C': '\\mathbb{C}',
                    '\\N': '\\mathbb{N}',
                },
            });
        } catch (e) {
            errors.push({ display: isDisplay, latex, message: e.message || String(e) });
        }
    }
    return errors;
}

/** Format KaTeX errors from a single markdown string into a warning suffix. */
function _katexWarnings(markdownContent) {
    if (!markdownContent) return '';
    const errs = checkMarkdownKaTeX(markdownContent);
    if (!errs.length) return '';
    const lines = ['\n\n⚠️ KaTeX errors in markdown math:'];
    for (const { display, latex, message } of errs) {
        const delim = display ? '$$' : '$';
        lines.push(`  ${delim}${latex}${delim}\n  → ${message}`);
    }
    return lines.join('\n');
}

/** Format KaTeX errors across all markdown cells in an inserted cells array. */
function _katexWarningsForCells(cells) {
    const all = [];
    for (const c of cells) {
        if ((c.kind || 'code') === 'markdown') {
            const errs = checkMarkdownKaTeX(c.content || '');
            for (const e of errs) all.push(e);
        }
    }
    if (!all.length) return '';
    const lines = ['\n\n⚠️ KaTeX errors in inserted markdown math:'];
    for (const { display, latex, message } of all) {
        const delim = display ? '$$' : '$';
        lines.push(`  ${delim}${latex}${delim}\n  → ${message}`);
    }
    return lines.join('\n');
}

// Scroll a notebook cell into view and briefly highlight it so the user sees
// which cell the AI just inserted or edited.
let _cellGlowDeco = null;
function flashCell(editor, cellIndex) {    try {
        const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
        // Scroll into view
        editor.revealRange(new RC(cellIndex, cellIndex + 1),
                           vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
        // Apply a brief highlight decoration
        if (!_cellGlowDeco && vscode.notebooks?.createNotebookEditorDecorationType) {
            _cellGlowDeco = vscode.notebooks.createNotebookEditorDecorationType({
                backgroundColor: 'rgba(100, 180, 255, 0.12)',
                borderColor:     'rgba(100, 180, 255, 0.75)',
            });
        }
        if (_cellGlowDeco) {
            editor.setDecorations(_cellGlowDeco, [new RC(cellIndex, cellIndex + 1)]);
            setTimeout(() => {
                try { editor.setDecorations(_cellGlowDeco, []); } catch (_) {}
            }, 1800);
        }
    } catch (_) {}
}

// ---------------------------------------------------------------------------
// Shared: build an in-memory transcript from the active notebook (TODO-2a / 4a)
// ---------------------------------------------------------------------------

function buildTranscript(notebook, startCell, endCell, editor) {
    const decoder = new util.TextDecoder();
    const lines   = [];
    const title   = notebook.uri.fsPath.split('/').pop().replace(/\.[^.]+$/, '');
    const total   = notebook.cellCount;
    const from    = Math.max(1, startCell || 1);
    const to      = Math.min(total, endCell || total);
    const isRange = from !== 1 || to !== total;
    lines.push(`# ${title}`);

    // Surface per-notebook copilot instructions stored in metadata
    const instructions = notebook.metadata?.copilotInstructions;
    if (instructions && typeof instructions === 'string' && instructions.trim()) {
        lines.push('');
        lines.push('<!-- notebook instructions -->' );
        lines.push(instructions.trim());
        lines.push('<!-- end notebook instructions -->');
    }
    const rangeNote = isRange ? ` (showing cells ${from}–${to})` : '';
    lines.push(`Notebook: ${total} cell${total !== 1 ? 's' : ''}${rangeNote}. Cell numbers are 1-based (human-facing), while internal notebook indices are 0-based. Each cell also has a stable cellId for tool operations that move/delete/reorder cells. Prefer cellId over cellNumber after any structural edits. To insert after Cell N, pass position=N to wolfbook_insertCell (position=0 inserts before Cell 1).`);

    const selEditor = editor && editor.notebook.uri.toString() === notebook.uri.toString() ? editor : null;
    if (selEditor && Array.isArray(selEditor.selections) && selEditor.selections.length > 0) {
        lines.push('Selected cells in active editor:');
        for (const r of selEditor.selections) {
            const start0 = Math.max(0, Math.min(r.start, Math.max(0, total - 1)));
            const endExclusive0 = Math.max(r.start, Math.min(r.end, total));
            const end0 = Math.max(start0, Math.min(total - 1, endExclusive0 - 1));
            if (start0 >= total) continue;
            if (start0 === end0) {
                const cell = notebook.cellAt(start0);
                lines.push(`- internal index ${start0} => Cell ${start0 + 1}, CellId: ${getCellToolId(cell)}`);
            } else {
                lines.push(`- internal indices ${start0}-${end0} => Cells ${start0 + 1}-${end0 + 1}`);
                for (let i = start0; i <= end0; i++) {
                    const cell = notebook.cellAt(i);
                    lines.push(`  - Cell ${i + 1} (index ${i}), CellId: ${getCellToolId(cell)}`);
                }
            }
        }
    } else {
        lines.push('Selected cells in active editor: (none / different notebook)');
    }
    lines.push('');

    for (let i = from - 1; i < to; i++) {
        const cell   = notebook.cellAt(i);
        const cellNo = i + 1;  // 1-based; equals the position value to insert after this cell
        const cellId = getCellToolId(cell);

        if (cell.kind === vscode.NotebookCellKind.Markup) {
            const src = cell.document.getText().trim();
            lines.push(`### Cell ${cellNo} [markdown]`);
            lines.push(`CellId: ${cellId}`);
            lines.push(src || '*(empty)*');
            lines.push('');
            continue;
        }

        // Code cell
        const src = cell.document.getText();
        lines.push(`### Cell ${cellNo} [wolfram]`);
        lines.push(`CellId: ${cellId}`);
        if (src.trim() === '') {
            lines.push('*(empty)*');
            lines.push('');
            continue;
        }
        lines.push('```wolfram');
        lines.push(src.trimEnd());
        lines.push('```');

        // Collect text/plain outputs — shown directly below the source
        const outs = [];
        for (const output of cell.outputs) {
            const plainItem = output.items.find(it => it.mime === 'text/plain');
            if (plainItem) {
                try {
                    const txt   = decoder.decode(plainItem.data);
                    const mimes = output.items.map(it => it.mime);
                    // Skip the hidden AI-error sentinel (wolfram-html + error MIME combo)
                    const isErrorSentinel = mimes.includes('x-application/wolfram-language-html') &&
                                           mimes.includes('application/vnd.code.notebook.error');
                    if (!isErrorSentinel && txt.trim()) outs.push(txt.trim());
                } catch (_) {}
            }
        }
        if (outs.length > 0) {
            for (const t of outs) lines.push(t);
        } else {
            lines.push('*(not evaluated)*');
        }
        lines.push('');
    }

    return lines.join('\n');
}

function getCellToolId(cell) {
    return cell?.document?.uri?.toString?.() || '';
}

function formatCellRef(idx, cell) {
    return `Cell ${idx + 1} (index ${idx}, CellId: ${getCellToolId(cell)})`;
}

function resolveCellIndex(notebook, ref, fieldName) {
    const count = notebook.cellCount;

    if (typeof ref === 'number' && Number.isInteger(ref)) {
        if (ref < 1 || ref > count) {
            return { error: `Invalid ${fieldName} ${ref}. Notebook has ${count} cell(s).` };
        }
        return { idx: ref - 1 };
    }

    if (typeof ref === 'string') {
        const raw = ref.trim();
        if (!raw) return { error: `Empty ${fieldName} is not valid.` };

        if (/^\d+$/.test(raw)) {
            const n = Number(raw);
            if (n < 1 || n > count) {
                return { error: `Invalid ${fieldName} ${raw}. Notebook has ${count} cell(s).` };
            }
            return { idx: n - 1 };
        }

        for (let i = 0; i < count; i++) {
            const id = getCellToolId(notebook.cellAt(i));
            if (id === raw) return { idx: i };
        }
        return { error: `${fieldName} not found: ${raw}` };
    }

    return { error: `Provide ${fieldName} as a 1-based number or cellId string.` };
}

function resolveInsertIndex(notebook, editor, position, afterCellId, afterCellNum) {
    const isBefore = position === 'before';

    if (typeof afterCellId === 'string' && afterCellId.trim()) {
        const byId = resolveCellIndex(notebook, afterCellId, 'afterCellId');
        if (byId.error) return { error: byId.error };
        return { insertIdx: isBefore ? byId.idx : byId.idx + 1 };
    }

    if (typeof afterCellNum === 'number' && afterCellNum >= 1) {
        // 1-based → 0-based
        const idx = Math.max(0, Math.min(afterCellNum - 1, notebook.cellCount - 1));
        return { insertIdx: isBefore ? idx : idx + 1 };
    }

    if (position === 'end' || position == null) {
        return { insertIdx: notebook.cellCount };
    }
    if (position === 'after') {
        // "after" without a reference cell = end
        return { insertIdx: notebook.cellCount };
    }
    if (position === 'before') {
        // "before" without a reference cell = beginning
        return { insertIdx: 0 };
    }
    if (position === 'after-cursor') {
        const sel = editor.selection;
        return { insertIdx: (sel && sel.start != null) ? sel.start + 1 : notebook.cellCount };
    }
    if (typeof position === 'number') {
        return { insertIdx: Math.max(0, Math.min(position, notebook.cellCount)) };
    }
    if (typeof position === 'string' && /^\d+$/.test(position.trim())) {
        const n = Number(position.trim());
        return { insertIdx: Math.max(0, Math.min(n, notebook.cellCount)) };
    }

    return { insertIdx: notebook.cellCount };
}

// Detect kernel crash / WSTP disconnection errors from session.evaluate() rejections.
// These require a kernel restart — further evals will keep failing until the user restarts.
function isKernelConnectionError(msg) {
    return /wstp|connection was lost|send packet|kernel (crashed|disconnected)|lost connection/i.test(msg);
}

// Clean internal $wbR$/TimeConstrained wrapper artefacts from kernel error messages.
// The wrapper: Block[{$wbR$}, $wbR$ = TimeConstrained[(USER_EXPR), N, "$WBTIMEOUT$"]; If[...]]
// We want just: USER_EXPR
function cleanWrapperFromMsg(m) {
    // Step 1: strip the Block/TimeConstrained preamble (appears when the user expr is not
    // in a string context — rare, but possible for some multi-line message types).
    m = m.replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*TimeConstrained\[\(/g, '');
    // Step 2: strip the TimeConstrained suffix all the way to end-of-string.
    // Handles both standalone messages and ToExpression::sntx messages where the wrapper
    // appears inside a quoted string (e.g. 'Invalid syntax in or before "USER[[[), 9, ...".').
    // The trailing '^' position-marker and any whitespace/period that follow are also stripped.
    m = m.replace(/\),\s*\d+,\s*"\$WBTIMEOUT\$"\];\s*If\[\$wbR\$[\s\S]*$/, '".');
    // Step 3: remove any leftover plain Block wrapper (no TimeConstrained).
    m = m.replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*\(/g, '');
    return m.trim();
}

const KERNEL_CRASH_MSG =
    'Kernel connection lost — the kernel has crashed or disconnected.\n' +
    'Use the Restart button in the Wolfbook toolbar (or run the Restart Kernel command) to relaunch it, then try again.\n' +
    'The expression that caused the crash has been logged.';

// ---------------------------------------------------------------------------
// Shared: resolve the target notebook editor.
// If targetName is provided (e.g. "test.wb"), searches all open notebook documents
// for one whose filename matches, then reveals it.
// Otherwise: returns the active notebook editor, or reveals the first visible one.
// ---------------------------------------------------------------------------
async function resolveNotebookEditor(targetName) {
    // If a specific notebook is requested, find it among all open documents
    if (targetName) {
        const normTarget = targetName.trim().toLowerCase();
        // 1. Check visible editors first (fast path)
        for (const ed of vscode.window.visibleNotebookEditors) {
            const name = ed.notebook.uri.fsPath.split('/').pop().toLowerCase();
            if (name === normTarget) {
                try { await vscode.window.showNotebookDocument(ed.notebook, { preserveFocus: false }); } catch (_) {}
                return ed;
            }
        }
        // 2. Check all open notebook documents (may not be visible)
        for (const doc of vscode.workspace.notebookDocuments) {
            const name = doc.uri.fsPath.split('/').pop().toLowerCase();
            if (name === normTarget) {
                try {
                    const ed = await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
                    return ed;
                } catch (_) {}
            }
        }
        // 3. Not found — return null so the caller can report the error
        return null;
    }

    // No target specified — use active or first visible
    const active = vscode.window.activeNotebookEditor;
    if (active) return active;
    const fallback = vscode.window.visibleNotebookEditors[0];
    if (!fallback) return null;
    try {
        await vscode.window.showNotebookDocument(fallback.notebook, { preserveFocus: false });
    } catch (_) {}
    return fallback;
}

// ---------------------------------------------------------------------------
// wolfbook_getNotebookContext
// ---------------------------------------------------------------------------

class GetNotebookContextTool {
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'read';
        if (action === 'list') return { invocationMessage: 'List open notebooks' };
        if (action === 'switch') return { invocationMessage: `Switch to notebook: ${options.input?.notebook || '?'}` };
        if (action === 'save') return { invocationMessage: 'Save notebook to disk' };
        if (action === 'summary') return { invocationMessage: 'Get notebook summary (brief)' };
        return {};
    }

    async invoke(options, _token) {
        let action = options.input?.action || 'read';

        // "summary" is a natural alias for brief read — treat it as such
        if (action === 'summary') {
            // Force brief mode on via a patched options proxy so the read path picks it up
            options = { ...options, input: { ...(options.input || {}), action: 'read', brief: true } };
            action = 'read';
        }

        // ── action: list ─────────────────────────────────────────────────────
        if (action === 'list') {
            const allDocs = vscode.workspace.notebookDocuments
                .filter(d => d.notebookType === 'extended-wolfram-notebook');
            if (allDocs.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No Wolfram notebooks are currently open.')
                ]);
            }
            const activeUri = vscode.window.activeNotebookEditor?.notebook.uri.toString();
            const lines = [`**${allDocs.length} open notebook(s):**\n`];
            for (const doc of allDocs) {
                const name = doc.uri.fsPath.split('/').pop();
                let codeN = 0, mdN = 0;
                for (let i = 0; i < doc.cellCount; i++) {
                    doc.cellAt(i).kind === vscode.NotebookCellKind.Code ? codeN++ : mdN++;
                }
                const isActive = doc.uri.toString() === activeUri ? ' ← **active**' : '';
                lines.push(`- **${name}** — ${doc.cellCount} cells (${codeN} code, ${mdN} markdown)${isActive}`);
            }
            lines.push('\nTo switch: use action="switch" with notebook="filename.wb".');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(lines.join('\n'))
            ]);
        }

        // ── action: switch ───────────────────────────────────────────────────
        if (action === 'switch') {
            const notebook = options.input?.notebook;
            if (!notebook) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('notebook parameter is required for action="switch". Use action="list" to see open notebooks.')
                ]);
            }
            const allDocs = vscode.workspace.notebookDocuments
                .filter(d => d.notebookType === 'extended-wolfram-notebook');
            const editor = await resolveNotebookEditor(notebook);
            if (!editor) {
                const available = allDocs.map(d => d.uri.fsPath.split('/').pop()).join(', ');
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Notebook "${notebook}" not found. Available: ${available || '(none)'}`
                    )
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Switched to **${editor.notebook.uri.fsPath.split('/').pop()}** (${editor.notebook.cellCount} cells). All tools now target this notebook.`
                )
            ]);
        }

        // ── action: save ─────────────────────────────────────────────────────
        if (action === 'save') {
            const editor = await resolveNotebookEditor();
            if (!editor) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No active notebook editor.')
                ]);
            }
            try {
                await vscode.workspace.save(editor.notebook.uri);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Saved: ${editor.notebook.uri.fsPath.split('/').pop()}`)
                ]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Save failed: ${err.message}`)
                ]);
            }
        }

        // ── action: read (default) ───────────────────────────────────────────
        const targetName = options.input?.notebook;
        const editor = await resolveNotebookEditor(targetName);
        if (!editor) {
            const notFoundMsg = targetName
                ? `Notebook "${targetName}" is not open. Use action="list" to see open notebooks.`
                : 'No Wolfram notebook is currently open.';
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(notFoundMsg)
            ]);
        }
        const notebook = editor.notebook;
        if (notebook.notebookType !== 'extended-wolfram-notebook') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('The active editor is not a Wolfram notebook.')
            ]);
        }
        const startCell = options.input?.startCell;
        const endCell   = options.input?.endCell;

        // Brief mode: compact table of cell numbers, kinds, and first-line previews
        if (options.input?.brief === true) {
            const decoder = new util.TextDecoder();
            const nbName  = notebook.uri.fsPath.split('/').pop();
            const from    = Math.max(1, startCell || 1);
            const to      = Math.min(notebook.cellCount, endCell || notebook.cellCount);
            const lines   = [`**${nbName}** — ${notebook.cellCount} cells${from !== 1 || to !== notebook.cellCount ? ` (showing ${from}–${to})` : ''}`];
            for (let i = from - 1; i < to; i++) {
                const cell   = notebook.cellAt(i);
                const cellId = getCellToolId(cell);
                const kind   = cell.kind === vscode.NotebookCellKind.Markup ? 'md' : 'code';
                const src    = cell.document.getText().trim();
                const firstLine = (src.split('\n')[0] || '').slice(0, 70);
                // Also show output summary for evaluated cells
                let outSummary = '';
                for (const output of cell.outputs) {
                    const mimes = output.items.map(it => it.mime);
                    const isErrSentinel = mimes.includes('x-application/wolfram-language-html') &&
                                         mimes.includes('application/vnd.code.notebook.error');
                    if (isErrSentinel) { outSummary = ' ⚠ msgs'; break; }
                    const plain = output.items.find(it => it.mime === 'text/plain');
                    if (plain) {
                        try {
                            const t = decoder.decode(plain.data).trim().slice(0, 30);
                            if (t) { outSummary = ` → ${t}${t.length >= 30 ? '…' : ''}`; }
                        } catch (_) {}
                        break;
                    }
                }
                lines.push(`Cell ${i + 1} [${kind}] ${cellId} | ${firstLine || '*(empty)*'}${outSummary}`);
            }
            lines.push('\nUse brief=false (default) or omit brief to get full cell source + outputs.');
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        }

        const transcript = buildTranscript(notebook, startCell, endCell, editor);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(transcript)
        ]);
    }
}

// ---------------------------------------------------------------------------
// TODO-4b: wolfbook_evaluateExpression
// ---------------------------------------------------------------------------

class EvaluateExpressionTool {
    constructor(getController) {
        // getController() returns the live WolframNotebookKernel instance
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const expr      = options.input?.expression || '(none)';
        const multiLine = !!options.input?.multiLine;
        if (multiLine) {
            const count = splitWLIntoStatements(expr).length;
            return { invocationMessage: `Evaluate ${count} statement${count !== 1 ? 's' : ''} in kernel` };
        }
        return { invocationMessage: `Evaluate in kernel: ${expr}` };
    }

    async invoke(options, token) {
        const expression = options.input?.expression;
        if (!expression) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: no expression provided.')
            ]);
        }

        const timeoutSec = Number(options.input?.timeoutSeconds) || 30;

        const controller = this._getController();
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: kernel is not running. Launch the kernel first.')
            ]);
        }

        // Safety: if a notebook cell is actively evaluating, do NOT send another
        // evaluate() onto the WSTP link. An abandoned promise (on timeout) would leave
        // a stale result packet on the link that the next real evaluation would read as its own result.
        if (controller._evalDispatched) {
            const dynNote = (controller._dynCells?.size > 0)
                ? ` (${controller._dynCells.size} Dynamic widget(s) also active)`
                : '';
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Kernel is busy — a notebook cell is currently evaluating${dynNote}.\n` +
                    `Wait for it to finish or use the Abort button in the toolbar, then try again.`
                )
            ]);
        }

        // Note any live Dynamic widgets (they use sub() calls in parallel, which is safe,
        // but worth informing the model about).
        const dynCount = controller._dynCells?.size ?? 0;

        // ── multi-line mode ──────────────────────────────────────────────────────
        // When multiLine is true, each non-empty line is sent to the kernel as a
        // separate evaluation (preserving kernel state between lines, like pressing
        // Shift+Enter on a multi-expression cell). Results are returned as Out[1]=,
        // Out[2]=, etc. Lines ending with ; are evaluated but their output suppressed.
        const multiLine = !!options.input?.multiLine;
        if (multiLine) {
            // Split the code into individually complete WL statements.
            // splitWLIntoStatements tracks bracket depth, strings, comments, and
            // trailing infix operators to avoid sntxi "incomplete expression" errors.
            const lines = splitWLIntoStatements(expression);
            if (lines.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Error: no expressions provided.')
                ]);
            }
            const deadlineMs = Date.now() + timeoutSec * 1000;
            const parts = [];
            if (dynCount > 0) parts.push(`[note] ${dynCount} Dynamic widget(s) active`);

            // mkWrapped adds a TimeConstrained shell (wlSec = JS-deadline minus 1 s).
            // If WL hits its own timeout it returns the sentinel "$WBTIMEOUT$" cleanly —
            // the WSTP link is never corrupted.  The JS Promise timeout is kept as a
            // hard backstop in case WL itself freezes.
            // outputForm: wrap the result in Short/TeXForm/MatrixForm/TableForm before ToString.
            const outputForm = (options.input?.outputForm || '').trim();
            const _wrapForm = (varName) => {
                if (outputForm === 'Short')      return `ToString[Short[${varName}, 5], InputForm]`;
                if (outputForm === 'TeXForm')     return `ToString[TeXForm[${varName}]]`;
                if (outputForm === 'MatrixForm')  return `ToString[MatrixForm[${varName}], InputForm]`;
                if (outputForm === 'TableForm')   return `ToString[TableForm[${varName}], InputForm]`;
                return `If[StringQ[${varName}], ${varName}, ToString[${varName}, InputForm]]`;
            };
            const mkWrapped = (expr, wlSec) =>
                `Block[{$wbR$}, $wbR$ = TimeConstrained[(${expr}), ${wlSec}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", ${_wrapForm('$wbR$')}]]`;

            let outIdx = 0;
            for (const ln of lines) {
                if (token.isCancellationRequested) { parts.push('Evaluation cancelled.'); break; }
                outIdx++;
                const label      = `Out[${outIdx}]`;
                const suppressed = ln.trimEnd().endsWith(';');
                const remaining  = deadlineMs - Date.now();
                if (remaining <= 0) {
                    parts.push(`${label}: timed out — deadline exceeded.`);
                    break;
                }
                // WL timeout is 1 s before the JS deadline (minimum 1 s).
                const wlSec = Math.max(1, Math.round(remaining / 1000) - 1);
                const linePrints = [];
                const evalP    = controller.session.evaluate(mkWrapped(ln, wlSec), {
                    interactive: false,
                    onPrint: p => linePrints.push(p.replace(/\\012/g, '\n'))
                });
                const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), remaining));
                try {
                    const result = await Promise.race([evalP, timeoutP]);
                    if (linePrints.length) {
                        const ps = linePrints.join('').replace(/\n$/, '');
                        parts.push(`Print:\n${ps}`);
                    }
                    const msgs = (result?.messages ?? []).map(m => `[message] ${cleanWrapperFromMsg(m)}`);
                    if (msgs.length) parts.push(msgs.join('\n'));
                    if (suppressed) {
                        parts.push(`${label}= (suppressed)`);
                    } else if (result?.result?.type === 'abort') {
                        parts.push(`${label}= (aborted)`);
                        break;
                    } else if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                        parts.push(`${label}: timed out after ${wlSec}s — kernel is still alive. Simplify the expression or increase timeoutSeconds.`);
                        break;
                    } else if (result?.result?.type === 'string' && result.result.value) {
                        let val = result.result.value.replace(
                            /\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))
                        );
                        const MAX = 4096, truncated = val.length > MAX;
                        if (truncated) val = val.slice(0, MAX);
                        let out = `${label}= ${val}`;
                        if (truncated) out += `\n[output truncated — ${result.result.value.length} chars total]`;
                        parts.push(out);
                    } else {
                        parts.push(`${label}= (no output)`);
                    }
                } catch (err) {
                    if (err.message === 'timeout') {
                        if (!controller._evalDispatched) {
                            try { controller.session.abort?.(); } catch (_) {}
                        }
                        parts.push(`${label}: timed out — kernel interrupted. Retry with a higher timeoutSeconds.`);
                    } else if (isKernelConnectionError(err.message)) {
                        parts.push(`${label}: ${KERNEL_CRASH_MSG}`);
                    } else {
                        parts.push(`${label}: Error — ${err.message}`);
                    }
                    break;
                }
            }
            const multiOutput = parts.join('\n');
            appendEvalLog(expression, multiOutput);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(multiOutput)
            ]);
        }

        // Use Block (not Module) for the result-capture wrapper so compound expressions
        // like "x = 1; While[...]" don't trigger Module::lvsym. Block localises $wbR$
        // without requiring a single-expression initialiser.
        // TimeConstrained fires 1 s before the JS deadline — WL aborts cleanly and
        // returns the sentinel "$WBTIMEOUT$" so the WSTP link is never corrupted.
        // If result is already a String return it raw; otherwise convert via the chosen outputForm
        // (defaults to InputForm) to avoid double-quoting.
        const outputForm = (options.input?.outputForm || '').trim();
        const wlTimeout = Math.max(1, timeoutSec - 1);
        const _wrapFormSingle = (varName) => {
            if (outputForm === 'Short')      return `ToString[Short[${varName}, 5], InputForm]`;
            if (outputForm === 'TeXForm')     return `ToString[TeXForm[${varName}]]`;
            if (outputForm === 'MatrixForm')  return `ToString[MatrixForm[${varName}], InputForm]`;
            if (outputForm === 'TableForm')   return `ToString[TableForm[${varName}], InputForm]`;
            return `If[StringQ[${varName}], ${varName}, ToString[${varName}, InputForm]]`;
        };
        const wrappedExpr =
            `Block[{$wbR$}, $wbR$ = TimeConstrained[(${expression}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", ${_wrapFormSingle('$wbR$')}]]`;

        const singlePrints = [];
        const evalPromise    = controller.session.evaluate(wrappedExpr, {
            interactive: false,
            onPrint: p => singlePrints.push(p.replace(/\\012/g, '\n'))
        });
        let   timedOut       = false;
        const timeoutPromise = new Promise((_, rej) =>
            setTimeout(() => { timedOut = true; rej(new Error('timeout')); }, timeoutSec * 1000)
        );

        try {
            const result = await Promise.race([evalPromise, timeoutPromise]);
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Evaluation cancelled.')
                ]);
            }

            let output = '';
            if (dynCount > 0) output += `[note] ${dynCount} Dynamic widget(s) active\n`;

            // Print[] output collected via onPrint callback (fires before result resolves).
            if (singlePrints.length) {
                const printStr = singlePrints.join('').replace(/\n$/, '');
                output += `Print:\n${printStr}\n`;
            }

            // Kernel messages (warnings/errors) from the evaluation.
            // Strip internal $wbR$ wrapper artefacts that can appear in syntax-error messages.
            if (result?.messages?.length) {
                const clean = result.messages.map(m => cleanWrapperFromMsg(m));
                output += clean.map(m => `[message] ${m}`).join('\n') + '\n';
            }
            if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                // WL-level timeout — kernel aborted cleanly, WSTP link is intact
                output += `Timed out after ${wlTimeout}s — kernel is still alive.\n` +
                    `Simplify the expression, wrap it in TimeConstrained manually, or increase timeoutSeconds.`;
            } else if (result?.result?.type === 'string' && result.result.value) {
                // Decode WL unicode escapes: \:03B1 → α
                let val = result.result.value.replace(
                    /\\:([0-9A-Fa-f]{4})/g,
                    (_, h) => String.fromCharCode(parseInt(h, 16))
                );
                // Truncate if enormous (>4 KB)
                const MAX = 4096;
                const truncated = val.length > MAX;
                if (truncated) val = val.slice(0, MAX);
                output += `Out= ${val}`;
                if (truncated) output += `\n[output truncated — ${result.result.value.length} chars total]`;
            } else if (result?.result?.type === 'abort') {
                output += 'Evaluation aborted.';
            } else {
                output += '(no output)';
            }
            appendEvalLog(expression, output.trim());
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(output.trim())
            ]);
        } catch (err) {
            if (err.message === 'timeout') {
                // If a notebook cell didn't start executing during our wait, the kernel is
                // still running our expression. Abort it so the stale result packet doesn't
                // corrupt the next evaluation on the WSTP link.
                if (!controller._evalDispatched) {
                    try { controller.session.abort?.(); } catch (_) {}
                }
                const timeoutMsg =
                    `Evaluation timed out after ${timeoutSec}s — the kernel has been interrupted.\n` +
                    `If the computation is expected to take longer, retry with a higher timeoutSeconds value.`;
                appendEvalLog(expression, timeoutMsg);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(timeoutMsg)
                ]);
            }
            const errMsg = isKernelConnectionError(err.message) ? KERNEL_CRASH_MSG : `Error: ${err.message}`;
            appendEvalLog(expression, errMsg);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(errMsg)
            ]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_lookupSymbol — in-kernel usage + optional full web reference page
// ---------------------------------------------------------------------------

function fetchWolframDocPage(symbolName) {
    const safeName = symbolName.replace(/[^A-Za-z0-9$]/g, '');
    if (!safeName) return Promise.resolve('Invalid symbol name.');
    const url = `https://reference.wolfram.com/language/ref/${safeName}.html`;
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 404) {
                resolve(`No online documentation found for \`${safeName}\`.\n(Only built-in System-context symbols have pages at ${url})`);
                return;
            }
            if (res.statusCode !== 200) { resolve(`HTTP ${res.statusCode} from ${url}`); return; }
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                const text = data
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
                    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n')
                    .replace(/\n{3,}/g, '\n\n').trim();
                const cap = 12000;
                const out = text.length > cap
                    ? text.slice(0, cap) + `\n\n[...truncated — full page: ${url}]`
                    : text + `\n\nSource: ${url}`;
                resolve(out);
            });
        });
        req.on('error', (err) => resolve(`Network error: ${err.message}`));
        req.on('timeout', () => { req.destroy(); resolve('Timed out fetching documentation.'); });
    });
}

class LookupSymbolTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const fw = options.input?.fetchWeb ? ' + web docs' : '';
        return { invocationMessage: `Look up symbol: ${options.input?.symbol || '?'}${fw}` };
    }

    async invoke(options, token) {
        const symbol = (options.input?.symbol || '').trim();
        if (!symbol) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: no symbol name provided.')
            ]);
        }

        const fetchWeb = options.input?.fetchWeb === true;
        const controller = this._getController();

        let localResult = null;

        // Try in-kernel lookup (only if kernel is available and not busy)
        if (controller && controller.session && controller.kernelStatusString === 'resolved' && !controller._evalDispatched) {
            const longForm = options.input?.longForm !== false;
            const lf = longForm ? 'True' : 'False';
            const expr = `VsCodeSymbolMarkdown["${symbol.replace(/"/g, '')}", ${lf}]`;
            try {
                const result = await Promise.race([
                    controller.session.evaluate(expr, { interactive: false }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
                ]);
                if (!token.isCancellationRequested) {
                    localResult = result?.result?.type === 'string' ? result.result.value : null;
                }
            } catch (_) { /* kernel unavailable — fall through */ }
        }

        if (!fetchWeb) {
            const out = localResult
                || (controller && controller.kernelStatusString !== 'resolved'
                    ? `Kernel is not running. Pass fetchWeb:true to fetch documentation from the web instead.`
                    : `No kernel result for "${symbol}".`);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(out)]);
        }

        // Fetch full web reference page
        const webResult = await fetchWolframDocPage(symbol);

        const parts = [];
        if (localResult) {
            parts.push('## In-kernel usage\n' + localResult);
            parts.push('\n\n---\n\n## Full reference page\n' + webResult);
        } else {
            parts.push(webResult);
        }

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(parts.join(''))]);
    }
}

// ---------------------------------------------------------------------------
class InsertCellsTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const cells  = options.input?.cells || (options.input?.kind ? [{ kind: options.input.kind, content: options.input.content || '' }] : []);
        const pos    = options.input?.position;
        const afterId = options.input?.afterCellId;
        const posStr = afterId ? `after cellId ${afterId}` : (typeof pos === 'number' ? `after Cell ${pos}` : (pos || 'end'));
        return { invocationMessage: `Insert ${cells.length} cell(s) ${posStr}` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active notebook editor.')
            ]);
        }

        const notebook = editor.notebook;
        // Support both `cells` array and shorthand top-level `kind`+`content`
        let cells = options.input?.cells;
        if (!Array.isArray(cells) || cells.length === 0) {
            if (options.input?.kind && options.input?.content !== undefined) {
                cells = [{ kind: options.input.kind, content: options.input.content }];
            } else {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Provide either cells=[{kind,content},...] or top-level kind+content for a single cell.')
                ]);
            }
        }

        const position = options.input?.position;
        const afterCellId = options.input?.afterCellId;
        const afterCellNum = options.input?.afterCell != null ? Number(options.input.afterCell) : undefined;
        const idxRes = resolveInsertIndex(notebook, editor, position, afterCellId, afterCellNum);
        if (idxRes.error) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(idxRes.error)
            ]);
        }
        const insertIdx = idxRes.insertIdx;

        const cellDatas = cells.map(c => {
            const ck     = (c.kind === 'markdown') ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
            const langId = (c.kind === 'markdown') ? 'markdown' : 'wolfram';
            return new vscode.NotebookCellData(ck, normalizeToolContent(c.content || ''), langId);
        });

        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, cellDatas)]);
        await vscode.workspace.applyEdit(edit);

        // Reveal the inserted block and flash the first inserted cell
        try {
            editor.selection = new vscode.NotebookRange(insertIdx, insertIdx + cells.length);
        } catch (_) {}
        flashCell(editor, insertIdx);

        const firstNew   = insertIdx + 1;
        const lastNew    = insertIdx + cells.length;
        const totalAfter = notebook.cellCount;
        const nbName     = notebook.uri.fsPath.split('/').pop();

        appendEventLog(
            `\u{1F4E5} BULK INSERT ${cells.length} CELL(S) at positions ${firstNew}\u2013${lastNew}`,
            cells.map((c, i) => {
                const preview = (c.content || '').trim().slice(0, 100).replace(/\n/g, '\u21B5');
                return `${i + 1}. [${c.kind || 'code'}] ${preview}`;
            }).join('\n')
        );

        const lines = [
            `Inserted ${cells.length} cell(s) as Cell${ cells.length > 1 ? 's' : ''} ${
                firstNew}${ cells.length > 1 ? '\u2013' + lastNew : ''} of ${totalAfter} in ${nbName}.\n`
        ];
        cells.forEach((c, i) => {
            const preview = (c.content || '').trim().slice(0, 80).replace(/\n/g, '\u21B5');
            const cellAt = notebook.cellAt(insertIdx + i);
            lines.push(`- ${formatCellRef(insertIdx + i, cellAt)} [${c.kind || 'code'}]: ${preview}${
                (c.content || '').trim().length > 80 ? '\u2026' : ''}`);
        });

        // ── evaluate option: run all inserted code cells through the notebook ──
        // Default true for code cells (pass evaluate:false to suppress)
        const evaluate = options.input?.evaluate !== false;
        if (evaluate) {
            const hasCodeCells = cells.some(c => (c.kind || 'code') !== 'markdown');
            if (hasCodeCells) {
                const timeoutSec  = Number(options.input?.timeoutSeconds) || 30;
                const deadline    = Date.now() + timeoutSec * 1000;
                const decoder     = new util.TextDecoder();
                const evalResults = [];

                for (let i = 0; i < cells.length; i++) {
                    if ((cells[i].kind || 'code') === 'markdown') continue;
                    const idx   = insertIdx + i;
                    const cell  = notebook.cellAt(idx);
                    const prevEndTime = cell.executionSummary?.timing?.endTime ?? 0;

                    editor.selection = new vscode.NotebookRange(idx, idx + 1);
                    await vscode.commands.executeCommand('notebook.cell.execute');

                    const cellDeadline = Math.min(deadline, Date.now() + 300000);
                    await new Promise(resolve => {
                        const poll = () => {
                            const newEnd = notebook.cellAt(idx).executionSummary?.timing?.endTime ?? 0;
                            if (newEnd > prevEndTime || Date.now() >= cellDeadline) resolve();
                            else setTimeout(poll, 300);
                        };
                        setTimeout(poll, 500);
                    });

                    const updatedCell = notebook.cellAt(idx);
                    const timedOut    = (updatedCell.executionSummary?.timing?.endTime ?? 0) <= prevEndTime;
                    const outs = [];
                    let hasError = false;
                    for (const output of updatedCell.outputs) {
                        const mimes     = output.items.map(it => it.mime);
                        const plainItem = output.items.find(it => it.mime === 'text/plain');
                        const isErrSentinel = mimes.includes('x-application/wolfram-language-html') &&
                                              mimes.includes('application/vnd.code.notebook.error');
                        if (plainItem) {
                            try {
                                const txt = decoder.decode(plainItem.data).trim();
                                if (txt) {
                                    outs.push(txt);
                                    if (isErrSentinel || /\w+::\w+:/.test(txt)) hasError = true;
                                }
                            } catch (_) {}
                        }
                    }
                    const cellTiming    = updatedCell.executionSummary?.timing;
                    const cellTimingStr = (!timedOut && cellTiming?.startTime && cellTiming?.endTime)
                        ? ` ${((cellTiming.endTime - cellTiming.startTime) / 1000).toFixed(2)}s` : '';
                    const status  = timedOut ? '⏱ timeout' : `✓${cellTimingStr}`;
                    const outStr  = outs.join(' | ').slice(0, 800) || '(no output)';
                    const cellRef = formatCellRef(idx, updatedCell);
                    evalResults.push(`${cellRef}: ${status} — ${outStr}`);
                    appendEvalLog(cells[i].content || '', outStr);

                    if (Date.now() >= deadline) { evalResults.push('(global timeout reached)'); break; }
                }

                if (evalResults.length) {
                    lines.push('\n[evaluate]\n' + evalResults.join('\n'));
                }
            }
        }

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_deleteCell — remove one or more cells; save content to recovery file
// ---------------------------------------------------------------------------

class DeleteCellTool {
    async prepareInvocation(options, _token) {
        const refs = [];
        if (options.input?.cellId != null) refs.push(options.input.cellId);
        if (options.input?.cellNumber != null) refs.push(options.input.cellNumber);
        if (Array.isArray(options.input?.cellIds)) refs.push(...options.input.cellIds);
        if (Array.isArray(options.input?.cellNumbers)) refs.push(...options.input.cellNumbers);
        return { invocationMessage: refs.length === 1
            ? `Delete cell ${refs[0]} from notebook`
            : `Delete ${refs.length} cells from notebook: [${refs.join(', ')}]` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook = editor.notebook;

        // Accept single/multiple refs by either number or cellId
        const refs = [];
        if (options.input?.cellId != null) refs.push(options.input.cellId);
        if (options.input?.cellNumber != null) refs.push(options.input.cellNumber);
        if (Array.isArray(options.input?.cellIds)) refs.push(...options.input.cellIds);
        if (Array.isArray(options.input?.cellNumbers)) refs.push(...options.input.cellNumbers);
        if (refs.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Provide cellId/cellNumber (single) or cellIds/cellNumbers (array).'
            )]);
        }

        const resolved = [];
        const invalid = [];
        for (const ref of refs) {
            const r = resolveCellIndex(notebook, ref, 'cellRef');
            if (r.error) invalid.push(String(ref));
            else resolved.push(r.idx + 1);
        }
        if (invalid.length) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Invalid cell reference(s): ${invalid.join(', ')}. Notebook has ${notebook.cellCount} cell(s).`
            )]);
        }

        // Deduplicate; sort descending so each deletion doesn't shift remaining indices
        const sortedDesc = [...new Set(resolved)].sort((a, b) => b - a);
        const saveToRecovery = options.input?.saveToRecovery !== false;
        const notebookPath  = notebook.uri.fsPath;
        const recoveryDir   = path.join(path.dirname(notebookPath), 'img',
            path.basename(notebookPath, path.extname(notebookPath)));
        const recoveryPath  = path.join(recoveryDir, 'ai_deleted_cells.md');
        const deleted = [];  // collected in descending order, re-sorted for display

        for (const cellNumber of sortedDesc) {
            const idx     = cellNumber - 1;
            const cell    = notebook.cellAt(idx);
            const cellId  = getCellToolId(cell);
            const kindStr = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
            const source  = cell.document.getText();

            if (saveToRecovery) {
                try {
                    fs.mkdirSync(recoveryDir, { recursive: true });
                    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
                    const fence = kindStr === 'code' ? 'wolfram' : 'markdown';
                    const entry = `## Deleted Cell ${cellNumber} — ${stamp}\n**Kind:** ${kindStr}\n\`\`\`${fence}\n${source}\n\`\`\`\n\n`;
                    fs.appendFileSync(recoveryPath, entry, 'utf8');
                } catch (_) {}
            }

            const edit = new vscode.WorkspaceEdit();
            edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(idx, idx + 1))]);
            await vscode.workspace.applyEdit(edit);

            deleted.push({ cellNumber, idx, cellId, kindStr, source });
        }

        // Re-sort ascending for display
        deleted.sort((a, b) => a.cellNumber - b.cellNumber);

        // Log each deletion
        for (const d of deleted) {
            appendEventLog(`\u{1F5D1}\uFE0F DELETE ${d.kindStr.toUpperCase()} CELL ${d.cellNumber}`,
                d.source.trim().length > 200 ? d.source.trim().slice(0, 200) + '\u2026' : d.source.trim() || '*(empty)*');
        }

        const totalAfter = notebook.cellCount;
        const recovery  = saveToRecovery ? ' (saved to ai_deleted_cells.md — use wolfbook_restoreDeletedCells to undo)' : '';

        if (deleted.length === 1) {
            const d = deleted[0];
            const preview = d.source.trim().slice(0, 100).replace(/\n/g, '\u21b5');
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Deleted ${d.kindStr} Cell ${d.cellNumber} (index ${d.idx}, CellId: ${d.cellId})${recovery}. Notebook now has ${totalAfter} cell(s).\nContent: ${preview}${d.source.trim().length > 100 ? '\u2026' : ''}`
            )]);
        }

        // Multi-cell summary
        const lines = [`Deleted ${deleted.length} cells${recovery}. Notebook now has ${totalAfter} cell(s).\n`];
        for (const d of deleted) {
            const preview = d.source.trim().slice(0, 100).replace(/\n/g, '\u21b5');
            lines.push(`- Cell ${d.cellNumber} [${d.kindStr}] (index ${d.idx}, CellId: ${d.cellId}): ${preview}${d.source.trim().length > 100 ? '\u2026' : ''}`);
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_restoreDeletedCells — list or re-insert recently deleted cells
// ---------------------------------------------------------------------------

class RestoreDeletedCellsTool {
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'list';
        const count  = Number(options.input?.count) || (action === 'list' ? 10 : 1);
        return { invocationMessage: action === 'list'
            ? `List last ${count} deleted cell(s)`
            : `Restore last ${count} deleted cell(s) into notebook` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook     = editor.notebook;
        const notebookPath = notebook.uri.fsPath;
        const recoveryDir  = path.join(path.dirname(notebookPath), 'img',
            path.basename(notebookPath, path.extname(notebookPath)));
        const recoveryPath = path.join(recoveryDir, 'ai_deleted_cells.md');

        if (!fs.existsSync(recoveryPath)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'No recovery file found — no cells have been deleted by AI tools yet.'
            )]);
        }

        // Parse entries: each starts with "## Deleted Cell N — TIMESTAMP"
        const raw = fs.readFileSync(recoveryPath, 'utf8');
        const entries = [];
        const headerRe = /^## Deleted Cell (\d+) — (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\n\*\*Kind:\*\* (code|markdown)\n```(?:wolfram|markdown)\n([\s\S]*?)```/gm;
        let m;
        while ((m = headerRe.exec(raw)) !== null) {
            entries.push({
                originalCell: Number(m[1]),
                timestamp:    m[2],
                kind:         m[3],
                source:       m[4].replace(/\n$/, '')   // strip trailing newline inside fence
            });
        }

        if (entries.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Recovery file exists but contains no parseable entries.'
            )]);
        }

        const action = options.input?.action || 'list';
        const count  = Math.max(1, Math.min(
            Number(options.input?.count) || (action === 'list' ? 10 : 1),
            entries.length
        ));
        const toProcess = entries.slice(-count);  // most recent `count` entries

        // ── List ────────────────────────────────────────────────────────────
        if (action === 'list') {
            const lines = [`**Last ${toProcess.length} deleted cell(s)** (total in log: ${entries.length}):\n`];
            for (let i = 0; i < toProcess.length; i++) {
                const e       = toProcess[i];
                const preview = e.source.trim().slice(0, 120).replace(/\n/g, '\u21b5');
                lines.push(`${i + 1}. [${e.timestamp}] originally Cell ${e.originalCell} [${e.kind}]: ${preview}${e.source.trim().length > 120 ? '\u2026' : ''}`);
            }
            lines.push('\nTo restore, call with action="restore" (and optional count / insertPosition).');
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        }

        // ── Restore ─────────────────────────────────────────────────────────
        const insertPos = options.input?.insertPosition;
        const afterCellId = options.input?.afterCellId;
        const idxRes = resolveInsertIndex(notebook, editor, insertPos, afterCellId);
        if (idxRes.error) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(idxRes.error)]);
        }
        const insertIdx = idxRes.insertIdx;

        const cellDatas = toProcess.map(e => {
            const cellKind = e.kind === 'markdown'
                ? vscode.NotebookCellKind.Markup
                : vscode.NotebookCellKind.Code;
            return new vscode.NotebookCellData(cellKind, e.source, e.kind === 'markdown' ? 'markdown' : 'wolfram');
        });

        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, cellDatas)]);
        await vscode.workspace.applyEdit(edit);

        const totalAfter = notebook.cellCount;
        const firstNew   = insertIdx + 1;
        const lastNew    = insertIdx + toProcess.length;

        appendEventLog(
            `\u21A9\uFE0F RESTORE ${toProcess.length} DELETED CELL(S) at position ${firstNew}${toProcess.length > 1 ? '\u2013' + lastNew : ''}`,
            toProcess.map((e, i) => `${i + 1}. [${e.timestamp}] originally Cell ${e.originalCell} [${e.kind}]`).join('\n')
        );

        const nbName = notebookPath.split('/').pop();
        const lines  = [`Restored ${toProcess.length} cell(s) as Cell${toProcess.length > 1 ? 's' : ''} ${firstNew}${toProcess.length > 1 ? '\u2013' + lastNew : ''} of ${totalAfter} in ${nbName}.\n`];
        for (let i = 0; i < toProcess.length; i++) {
            const e          = toProcess[i];
            const newCellNum = insertIdx + 1 + i;
            const id         = getCellToolId(notebook.cellAt(insertIdx + i));
            const preview    = e.source.trim().slice(0, 100).replace(/\n/g, '\u21b5');
            lines.push(`- Cell ${newCellNum} [${e.kind}] (index ${insertIdx + i}, CellId: ${id}, was Cell ${e.originalCell} at ${e.timestamp}): ${preview}${e.source.trim().length > 100 ? '\u2026' : ''}`);
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n') + _katexWarningsForCells(cells))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_editCell — replace the source of an existing cell
// ---------------------------------------------------------------------------

class EditCellTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const n       = options.input?.cellId || options.input?.cellNumber;
        const content = String(options.input?.content || '');
        const preview = content.length > 100 ? content.slice(0, 100) + '…' : content;
        const evaluate = !!options.input?.evaluate;
        const verb = evaluate ? 'Edit & evaluate' : 'Edit';
        return { invocationMessage: `${verb} cell ${n}:\n\`\`\`\n${preview}\n\`\`\`` };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        if (options.input?.cellId == null && options.input?.cellNumber == null) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'You must provide either cellId (stable identifier, preferred) or cellNumber (1-based integer) to identify the target cell. ' +
                'Call wolfbook_getNotebookContext first to get CellId values.'
            )]);
        }

        const notebook = editor.notebook;
        const by = options.input?.cellId != null ? options.input?.cellId : options.input?.cellNumber;
        const resolved = resolveCellIndex(notebook, by, options.input?.cellId != null ? 'cellId' : 'cellNumber');
        if (resolved.error) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                resolved.error
            )]);
        }

        const idx        = resolved.idx;
        const cellNumber = idx + 1;
        const cell       = notebook.cellAt(idx);
        const cellId     = getCellToolId(cell);

        // Normalise content: fix double-encoded escape sequences (\n, \", \\)
        // that the LLM sometimes emits instead of the real characters.
        // Accept 'newContent' as an alias for 'content' (common model mistake).
        let rawContent = normalizeToolContent(options.input?.content ?? options.input?.newContent ?? cell.document.getText());
        const newContent = rawContent;
        const oldContent = cell.document.getText();

        // Build a compact diff summary for the agent
        const _diffSummary = (() => {
            if (oldContent === newContent) return '\n[no changes detected]';
            const oldLines = oldContent.split('\n');
            const newLines = newContent.split('\n');
            const added   = newLines.filter(l => !oldLines.includes(l));
            const removed = oldLines.filter(l => !newLines.includes(l));
            if (added.length === 0 && removed.length === 0 && oldLines.length === newLines.length)
                return '';  // whitespace-only changes; don't clutter
            const parts = [];
            if (removed.length > 0) parts.push(removed.slice(0, 5).map(l => `- ${l.trim().slice(0, 80)}`).join('\n') + (removed.length > 5 ? `\n  … and ${removed.length - 5} more removed` : ''));
            if (added.length > 0)   parts.push(added.slice(0, 5).map(l => `+ ${l.trim().slice(0, 80)}`).join('\n') + (added.length > 5 ? `\n  … and ${added.length - 5} more added` : ''));
            return parts.length > 0 ? '\n[diff]\n' + parts.join('\n') : '';
        })();

        // Apply the edit via TextEdit on the cell's existing document URI. This is an
        // in-place text change that preserves the cell's VS Code notebook identity
        // (CellId stays the same across the edit). We intentionally do NOT use
        // NotebookEdit.replaceCells here because that creates a brand-new cell with a
        // new internal handle, changing the CellId and breaking subsequent tool calls.
        const cellDoc   = cell.document;
        const fullRange = new vscode.Range(
            0, 0,
            Math.max(0, cellDoc.lineCount - 1),
            cellDoc.lineAt(Math.max(0, cellDoc.lineCount - 1)).text.length
        );
        const edit = new vscode.WorkspaceEdit();
        edit.set(cellDoc.uri, [new vscode.TextEdit(fullRange, newContent)]);
        await vscode.workspace.applyEdit(edit);

        try {
            editor.selection = new vscode.NotebookRange(idx, idx + 1);
        } catch (_) {}
        flashCell(editor, idx);

        const editedMsg = `Edited Cell ${cellNumber} (index ${idx}, CellId: ${cellId}) of ${notebook.cellCount} in ${notebook.uri.fsPath.split('/').pop()}.${_diffSummary}`;
        appendEventLog(`\u270F\uFE0F EDIT CELL ${cellNumber}`,
            newContent.trim().length > 200 ? newContent.trim().slice(0, 200) + '\u2026' : newContent.trim() || '*(empty)*');

        const evaluate = !!options.input?.evaluate;
        if (evaluate && cell.kind !== vscode.NotebookCellKind.Markup && newContent.trim()) {
            const controller = this._getController?.();
            if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    editedMsg + '\n[evaluate] Kernel is not running.'
                )]);
            }
            if (controller._evalDispatched) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    editedMsg + '\n[evaluate] Kernel is busy — cell edited but not evaluated.'
                )]);
            }
            const timeoutSec = Number(options.input?.timeoutSeconds) || 15;
            const wlTimeout  = Math.max(1, timeoutSec - 1);
            const dynCount   = controller._dynCells?.size ?? 0;
            const wrappedExpr =
                `Block[{$wbR$}, $wbR$ = TimeConstrained[(${newContent}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;
            try {
                const result = await Promise.race([
                    controller.session.evaluate(wrappedExpr, { interactive: false }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutSec * 1000))
                ]);
                if (token.isCancellationRequested) {
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(editedMsg + '\n[evaluate] Cancelled.')]);
                }
                let evalOut = '';
                if (dynCount > 0) evalOut += `[note] ${dynCount} Dynamic widget(s) active\n`;
                if (result?.messages?.length) {
                    const clean = result.messages.map(cleanWrapperFromMsg);
                    evalOut += clean.map(m => `[message] ${m}`).join('\n') + '\n';
                }
                if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                    evalOut += `Timed out after ${wlTimeout}s — kernel is still alive. Increase timeoutSeconds.`;
                } else if (result?.result?.type === 'string' && result.result.value) {
                    let val = result.result.value.replace(/\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
                    const MAX = 4096, truncated = val.length > MAX;
                    if (truncated) val = val.slice(0, MAX);
                    evalOut += `Out= ${val}`;
                    if (truncated) evalOut += `\n[output truncated — ${result.result.value.length} chars total]`;
                } else if (result?.result?.type === 'abort') {
                    evalOut += 'Evaluation aborted.';
                } else {
                    evalOut += '(no output)';
                }
                appendEvalLog(newContent, evalOut.trim());
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    editedMsg + '\n\n[evaluate]\n' + evalOut.trim()
                )]);
            } catch (err) {
                const errMsg = err.message === 'timeout'
                    ? `Evaluation timed out after ${timeoutSec}s.`
                    : isKernelConnectionError(err.message) ? KERNEL_CRASH_MSG : `Error: ${err.message}`;
                if (err.message === 'timeout' && !controller._evalDispatched) {
                    try { controller.session.abort?.(); } catch (_) {}
                }
                appendEvalLog(newContent, errMsg);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(editedMsg + '\n[evaluate] ' + errMsg)]);
            }
        }

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            editedMsg + _katexWarnings(cell.kind === vscode.NotebookCellKind.Markup ? newContent : null)
        )]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_runCell — execute an existing notebook cell through the normal
// execution pipeline; waits for completion and returns the text/plain output
// ---------------------------------------------------------------------------

class RunCellTool {
    async prepareInvocation(options, _token) {
        const n = options.input?.cellId || options.input?.cellNumber;
        if (n == null) {
            const s = options.input?.startCell || 1, e = options.input?.endCell || '\u2026';
            return { invocationMessage: `Run cells ${s}\u2013${e} sequentially` };
        }
        return { invocationMessage: `Run cell ${n} in notebook` };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        // ── range mode: no cell target given — run a range of cells ──────────
        const hasCellTarget = options.input?.cellId != null || options.input?.cellNumber != null;
        if (!hasCellTarget) {
            const notebook    = editor.notebook;
            const startCell   = Math.max(1, Number(options.input?.startCell) || 1);
            const endCell     = Math.min(notebook.cellCount, Number(options.input?.endCell) || notebook.cellCount);
            const timeoutSec  = Math.max(10, Number(options.input?.timeoutSeconds) || 120);
            const stopOnError = options.input?.stopOnError !== false;
            const errorsOnly  = options.input?.errorsOnly === true;

            if (startCell > endCell || startCell < 1) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Invalid range ${startCell}\u2013${endCell}. Notebook has ${notebook.cellCount} cell(s).`
                )]);
            }

            const decoder   = new util.TextDecoder();
            const deadline  = Date.now() + timeoutSec * 1000;
            const results   = [];
            let   codeCount = 0;
            let   stopped   = null;

            for (let n = startCell; n <= endCell; n++) {
                if (token.isCancellationRequested) { stopped = `cancelled at Cell ${n}`; break; }
                const idx  = n - 1;
                const cell = notebook.cellAt(idx);
                if (cell.kind === vscode.NotebookCellKind.Markup) continue;

                const remaining = deadline - Date.now();
                if (remaining <= 0) { stopped = `global timeout (${timeoutSec}s) reached before Cell ${n}`; break; }

                const prevEndTime = cell.executionSummary?.timing?.endTime ?? 0;
                editor.selection = new vscode.NotebookRange(idx, idx + 1);
                await vscode.commands.executeCommand('notebook.cell.execute');

                const cellDeadline = Math.min(deadline, Date.now() + 300000);
                await new Promise(resolve => {
                    const poll = () => {
                        if (token.isCancellationRequested) { resolve(); return; }
                        const newEnd = notebook.cellAt(idx).executionSummary?.timing?.endTime ?? 0;
                        if (newEnd > prevEndTime || Date.now() >= cellDeadline) resolve();
                        else setTimeout(poll, 300);
                    };
                    setTimeout(poll, 500);
                });

                const updatedCell = notebook.cellAt(idx);
                const timedOut    = (updatedCell.executionSummary?.timing?.endTime ?? 0) <= prevEndTime;
                codeCount++;

                const outs = [];
                let hasError = false;
                for (const output of updatedCell.outputs) {
                    const mimes     = output.items.map(it => it.mime);
                    const plainItem = output.items.find(it => it.mime === 'text/plain');
                    const isErrSentinel = mimes.includes('x-application/wolfram-language-html') &&
                                          mimes.includes('application/vnd.code.notebook.error');
                    if (plainItem) {
                        try {
                            const txt = decoder.decode(plainItem.data).trim();
                            if (txt) {
                                outs.push(txt);
                                // Detect kernel messages: error sentinel output OR WL message format (Symbol::tag:)
                                if (isErrSentinel || /\w+::\w+:/.test(txt)) hasError = true;
                            }
                        } catch (_) {}
                    }
                }

                const cellTiming    = updatedCell.executionSummary?.timing;
                const cellTimingStr = (!timedOut && cellTiming?.startTime && cellTiming?.endTime)
                    ? ` ${((cellTiming.endTime - cellTiming.startTime) / 1000).toFixed(2)}s` : '';
                const status = timedOut ? '\u23F1 timeout' : `\u2713${cellTimingStr}`;
                const resultLine = `Cell ${n}: ${status} \u2014 ${outs.join(' | ').slice(0, 800) || '(no output)'}`;
                // errorsOnly: only include cells that had messages/warnings
                if (!errorsOnly || hasError || timedOut) {
                    results.push(resultLine);
                }

                if (stopOnError && hasError) { stopped = `stopped at Cell ${n} — error detected (pass stopOnError:false to continue past errors)`; break; }
            }

            const total  = notebook.cellCount;
            const header = startCell === 1 && endCell === total
                ? `Ran all cells (${codeCount} code cells, ${endCell - startCell + 1 - codeCount} markdown skipped)${errorsOnly ? ' — showing only cells with messages' : ''}:`
                : `Ran cells ${startCell}\u2013${endCell} (${codeCount} code cells, ${endCell - startCell + 1 - codeCount} markdown skipped)${errorsOnly ? ' — showing only cells with messages' : ''}:`;
            const lines = [header];
            if (errorsOnly && results.length === 0) {
                lines.push('  \u2713 No cells had kernel messages or warnings.');
            } else {
                lines.push(...results.map(r => '  ' + r));
            }
            if (stopped) lines.push(`  \u26A0\uFE0F ${stopped}`);
            appendEventLog(
                `\u25B6\uFE0F RUN CELLS ${startCell}\u2013${endCell}`,
                results.map(r => r).join('\n') + (stopped ? `\n\u26A0\uFE0F ${stopped}` : '')
            );
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        }

        // ── single-cell mode ───────────────────────────────────────────────
        const notebook = editor.notebook;
        const by = options.input?.cellId != null ? options.input?.cellId : options.input?.cellNumber;
        const resolved = resolveCellIndex(notebook, by, options.input?.cellId != null ? 'cellId' : 'cellNumber');
        if (resolved.error) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                resolved.error
            )]);
        }

        const idx  = resolved.idx;
        const cellNumber = idx + 1;
        const cell = notebook.cellAt(idx);
        const cellId = getCellToolId(cell);
        if (cell.kind === vscode.NotebookCellKind.Markup) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Cell ${cellNumber} (index ${idx}, CellId: ${cellId}) is a markdown cell — nothing to run.`
            )]);
        }

        const timeoutSec = Number(options.input?.timeoutSeconds) || 30;
        // Snapshot timing before triggering so we can detect a fresh completion
        const prevEndTime = cell.executionSummary?.timing?.endTime ?? 0;

        // Select the target cell and trigger execution
        editor.selection = new vscode.NotebookRange(idx, idx + 1);
        await vscode.commands.executeCommand('notebook.cell.execute');

        // Poll every 250 ms until executionSummary.endTime advances (= cell finished)
        const deadline = Date.now() + timeoutSec * 1000;
        await new Promise(resolve => {
            const poll = () => {
                if (token.isCancellationRequested) { resolve(); return; }
                const newEnd = notebook.cellAt(idx).executionSummary?.timing?.endTime ?? 0;
                if (newEnd > prevEndTime || Date.now() >= deadline) {
                    resolve();
                } else {
                    setTimeout(poll, 250);
                }
            };
            setTimeout(poll, 400); // short initial delay so cell starts before first check
        });

        if (token.isCancellationRequested) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Cancelled.')]);
        }

        const timedOut = (notebook.cellAt(idx).executionSummary?.timing?.endTime ?? 0) <= prevEndTime;

        // Collect outputs from the (now-updated) cell.
        // The error sentinel output (wolfram-html-html + vnd.code.notebook.error) is a
        // hidden output whose text/plain item holds all kernel messages (warnings, errors).
        // Regular outputs (results, Print[], graphics) are the non-sentinel ones.
        const decoder = new util.TextDecoder();
        const updatedCell = notebook.cellAt(idx);
        const outs    = [];   // normal result / print output
        const msgOuts = [];   // kernel messages / warnings / errors

        for (const output of updatedCell.outputs) {
            const mimes     = output.items.map(it => it.mime);
            const plainItem = output.items.find(it => it.mime === 'text/plain');
            const isErrSentinel = mimes.includes('x-application/wolfram-language-html') &&
                                  mimes.includes('application/vnd.code.notebook.error');
            if (!plainItem) continue;
            try {
                const txt = decoder.decode(plainItem.data).trim();
                if (!txt) continue;
                if (isErrSentinel) {
                    msgOuts.push(txt);
                } else {
                    outs.push(txt);
                }
            } catch (_) {}
        }

        const total     = notebook.cellCount;
        const timing    = updatedCell.executionSummary?.timing;
        const timingStr = (!timedOut && timing?.startTime && timing?.endTime)
            ? ` (${((timing.endTime - timing.startTime) / 1000).toFixed(2)} s)`
            : '';

        const resultParts = [];
        if (timedOut) {
            resultParts.push(`Cell ${cellNumber} (CellId: ${cellId}) of ${total} timed out after ${timeoutSec}s (execution may still be running).`);
        } else {
            resultParts.push(`Cell ${cellNumber} (CellId: ${cellId}) of ${total} executed${timingStr}.`);
        }

        if (outs.length > 0) {
            resultParts.push(outs.join('\n'));
        } else {
            resultParts.push('(no output — definition or suppressed expression)');
        }

        if (msgOuts.length > 0) {
            resultParts.push(`\n\u26A0 Kernel messages (${msgOuts.length}):\n${msgOuts.join('\n')}`);
        }

        const inputPreview = (cell.document.getText?.() || '').trim().slice(0, 200).replace(/\n/g, '\u21B5') || '(code cell)';
        const outputSummary = timedOut
            ? `TIMEOUT after ${timeoutSec}s`
            : (outs.length > 0 ? outs.join(' | ').slice(0, 300) : '(no output)') +
              (msgOuts.length > 0 ? `  \u26A0 ${msgOuts.join(' | ').slice(0, 200)}` : '');
        appendEventLog(
            `\u25B6\uFE0F RUN CELL ${cellNumber}${timingStr}`,
            `**In [${cellNumber}]:** \`${inputPreview}\`\n**Out:** ${outputSummary}`
        );

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resultParts.join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_getKernelState — list user-defined symbols with values/rule counts
// ---------------------------------------------------------------------------

class GetKernelStateTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const pattern = options.input?.pattern || 'Global`*';
        return { invocationMessage: `Get kernel state (${pattern})` };
    }

    async invoke(options, _token) {
        const controller = this._getController?.();
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Kernel is not running.')]);
        }
        if (controller._evalDispatched) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Kernel is busy — try again after the current evaluation finishes.'
            )]);
        }

        // Sanitise pattern: only allow WL symbol-name characters, backtick, and `*`
        const rawPattern = String(options.input?.pattern || 'Global`*');
        const safePattern = rawPattern.replace(/[^A-Za-z0-9$`*?]/g, '')  || 'Global`*';

        // Build a single-line WL expression that:
        //   — lists all symbols matching the pattern
        //   — shows OwnValue (direct value) for variables
        //   — shows actual DownValues definitions for functions (first 3, truncated)
        //   — shows UpValues/SubValues rule counts
        //   — truncates long values to 150 chars per line
        //   — skips symbols with no definitions at all (pure name slots)
        // IMPORTANT: OwnValues/DownValues/SubValues/UpValues have HoldFirst attribute.
        // Block[{sym=Symbol[s]}, OwnValues[sym]] returns OwnValues of the Block-local
        // variable `sym` itself (which has {HoldPattern[sym]:>Symbol[s]}  — always non-empty!),
        // not the OwnValues of the symbol `sym` points to.
        // Fix: use Function[sym, OwnValues[sym], HoldAll] @@ ToHeldExpression[s]
        // Apply(@@) evaluates ToHeldExpression[s] = HoldComplete[cellA] and calls the
        // HoldAll Function with the unevaluated symbol cellA, so OwnValues[cellA] is correct.
        // Build the WL expression for reading kernel state.
        // KEY: never call Symbol[s] (evaluates the symbol, can cause recursion abort in WE).
        // Instead serialize OwnValues directly—the stored RuleDelayed holds the RHS without
        // re-evaluating it—then strip the "{HoldPattern[...] :> " prefix.
        const wlExpr = [
            `Block[{$wbS$=Sort[Names["${safePattern}"]],`,
            `$wbTrunc$=Function[{str,maxLen},If[StringLength[str]>maxLen,StringTake[str,maxLen]<>"...",str]],`,
            // Strip {HoldPattern[...] :> from OwnValues string, and trailing }
            `$wbExVal$=Function[str,StringReplace[StringReplace[str,`,
            `RegularExpression["^\\\\{HoldPattern\\\\[.+?\\\\] :> "] -> ""],"}"~~EndOfString -> ""]],`,
            // $wbFmt$: Quiet[Check[...,Nothing]] guards against unexpected messages
            `$wbFmt$=Function[s,Quiet[Check[Block[{`,
            `$wbOV$=Function[sym,OwnValues[sym],HoldAll]@@ToHeldExpression[s],`,
            `$wbDV$=Function[sym,DownValues[sym],HoldAll]@@ToHeldExpression[s],`,
            `$wbSV$=Function[sym,SubValues[sym],HoldAll]@@ToHeldExpression[s],`,
            `$wbUV$=Function[sym,UpValues[sym],HoldAll]@@ToHeldExpression[s]},`,
            `Which[`,
            // OwnValues: serialize the stored OwnValues list (held value, no Symbol[s] evaluation)
            `ListQ[$wbOV$]&&$wbOV$=!={},`,
            `$wbTrunc$[s<>" = "<>$wbExVal$[ToString[$wbOV$,InputForm]],150],`,
            // DownValues/SubValues/UpValues: serialize each stored rule directly (also held)
            `(ListQ[$wbDV$]&&$wbDV$=!={})|| (ListQ[$wbSV$]&&$wbSV$=!={}) || (ListQ[$wbUV$]&&$wbUV$=!={} ),`,
            `Block[{$wbLines$={}},`,
            `If[ListQ[$wbDV$]&&$wbDV$=!={},`,
            `$wbLines$=Join[$wbLines$,Map[$wbTrunc$[ToString[#,InputForm],150]&,Take[$wbDV$,UpTo[3]]]];`,
            `If[Length[$wbDV$]>3,$wbLines$=Append[$wbLines$,"  ... and "<>ToString[Length[$wbDV$]-3]<>" more rule(s)"]]`,
            `];`,
            `If[ListQ[$wbSV$]&&$wbSV$=!={},`,
            `$wbLines$=Append[$wbLines$,"  + "<>ToString[Length[$wbSV$]]<>" SubValue rule(s)"]`,
            `];`,
            `If[ListQ[$wbUV$]&&$wbUV$=!={},`,
            `$wbLines$=Append[$wbLines$,"  + "<>ToString[Length[$wbUV$]]<>" UpValue rule(s)"]`,
            `];`,
            `StringJoin[Riffle[$wbLines$,"\\n"]]`,
            `],`,
            `True,Nothing`,
            `]],Nothing]]]},`,
            `If[$wbS$==={},"(no symbols matching ${safePattern})",`,
            `With[{$wbLines$=DeleteCases[Map[$wbFmt$,$wbS$],Nothing|$Failed]},`,
            `If[$wbLines$==={},"(no symbols with definitions matching ${safePattern})",`,
            `StringJoin[Riffle[$wbLines$,"\\n"]]]]]]`
        ].join('');

        const timeoutSec = 10;
        const wlTimeout  = 9;
        const wrapped =
            `Block[{$wbR$}, $wbR$ = TimeConstrained[(${wlExpr}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;

        try {
            const result = await Promise.race([
                controller.session.evaluate(wrapped, { interactive: false }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutSec * 1000))
            ]);
            if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Timed out reading kernel state.')]);
            }
            if (result?.result?.type === 'string' && result.result.value) {
                const val = result.result.value
                    .replace(/\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
                    .replace(/\\012/g, '\n')
                    .replace(/\\n/g, '\n');
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Kernel state (${safePattern}):\n${val}`
                )]);
            }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('(no output from kernel state query)')]);
        } catch (err) {
            const errMsg = isKernelConnectionError(err.message) ? KERNEL_CRASH_MSG : `Error: ${err.message}`;
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errMsg)]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_saveNotebook — save the active notebook to disk
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// wolfbook_kernelControl — restart kernel or abort current evaluation
// ---------------------------------------------------------------------------

class KernelControlTool {
    constructor(getController) {
        this._getController = getController;
        this._checkpointPath = null;  // path of the most recent checkpoint .mx file
    }

    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'abort';
        if (action === 'restart') {
            return {
                invocationMessage: 'Restart Wolfram kernel — clears all definitions and variable values'
            };
        }
        if (action === 'checkpoint') return { invocationMessage: 'Save kernel state checkpoint' };
        if (action === 'restore')    return { invocationMessage: 'Restore kernel state from checkpoint' };
        return { invocationMessage: 'Abort current kernel evaluation' };
    }

    async invoke(options, _token) {
        const action = options.input?.action || 'abort';
        const controller = this._getController?.();
        if (!controller) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No kernel controller available.')]);
        }

        // --- checkpoint: DumpSave all Global` definitions to a temp .mx file ---
        if (action === 'checkpoint') {
            try {
                const tag = options.input?.tag || '';
                const ts = Date.now();
                const safeName = tag ? tag.replace(/[^a-zA-Z0-9_-]/g, '') + '-' : '';
                const path = `/tmp/wolfbook-checkpoint-${safeName}${ts}.mx`;
                const expr = `DumpSave["${path}", "Global\`"]`;
                const result = await controller.session.evaluate(expr, { interactive: false });
                this._checkpointPath = path;
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Checkpoint saved → ${path}\nTo restore later: use action="restore".`)
                ]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Checkpoint failed: ${err.message}`)
                ]);
            }
        }

        // --- restore: ClearAll Global`, then Get the checkpoint file ---
        if (action === 'restore') {
            const restorePath = options.input?.path || this._checkpointPath;
            if (!restorePath) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No checkpoint to restore. Call with action="checkpoint" first, or provide a "path" to an .mx file.')
                ]);
            }
            try {
                const expr = `ClearAll["Global\`*"]; Get["${restorePath}"]; Length[Names["Global\`*"]]`;
                const result = await controller.session.evaluate(expr, { interactive: false });
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Kernel state restored from ${restorePath} — ${result} Global\` symbols loaded.`)
                ]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Restore failed: ${err.message}`)
                ]);
            }
        }

        if (action === 'restart') {
            try {
                await controller.restartKernel();
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Kernel restarted successfully.')]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Restart failed: ${err.message}`)]);
            }
        }
        // action === 'abort'
        if (!controller._evalDispatched) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No evaluation is currently running.')]);
        }
        try {
            controller.abortEvaluation();
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Abort signal sent to kernel.')]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Abort failed: ${err.message}`)]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_debugCell — start/control/analyse step-through debug sessions
// ---------------------------------------------------------------------------

class DebugCellTool {
    constructor(getController, debugCtrl) {
        this._getController = getController;
        this._debugCtrl     = debugCtrl;
    }

    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'analyze';
        const n = options.input?.cellNumber;
        const msgs = {
            analyze:          n ? `Analyse Cell ${n} for debugging` : 'Analyse selected cell for debugging',
            start:            n ? `Start debug session on Cell ${n}` : 'Start debug session on selected cell',
            status:           'Check debug session status',
            stepOver:         'Step over current statement',
            stepInto:         'Step into inner loop',
            stepOut:          'Step out of current loop level',
            continue:         'Continue to next breakpoint',
            runToEnd:         'Run cell to completion',
            stop:             'Stop debug session',
            addBreakpoint:    'Add breakpoint',
            removeBreakpoint: 'Remove breakpoint',
            clearBreakpoints: 'Clear breakpoints',
            listBreakpoints:  'List all breakpoints',
            addWatch:         'Add watch variable',
            removeWatch:      'Remove watch variable',
            listWatch:        'List watch variables',
        };
        return { invocationMessage: msgs[action] || `Debug: ${action}` };
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    _getCell(options, notebook) {
        const cid = options.input?.cellId;
        if (cid != null) {
            const resolved = resolveCellIndex(notebook, cid, 'cellId');
            if (resolved.error) return { error: resolved.error };
            return { cell: notebook.cellAt(resolved.idx) };
        }
        const cn = options.input?.cellNumber;
        if (cn != null) {
            const idx = Number(cn) - 1;
            if (!Number.isInteger(idx) || idx < 0 || idx >= notebook.cellCount) {
                return { error: `Invalid cellNumber ${cn}. Notebook has ${notebook.cellCount} cell(s).` };
            }
            return { cell: notebook.cellAt(idx) };
        }
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
        const sel = editor?.selections;
        if (!sel || sel.length === 0) return { error: 'No cell selected.' };
        return { cell: notebook.cellAt(sel[0].start) };
    }

    _txt(msg) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(msg)]);
    }

    // ── main ───────────────────────────────────────────────────────────────────

    async invoke(options, _token) {
        const action = options.input?.action || 'analyze';
        const dc = this._debugCtrl;

        // ── Step commands (require active session) ─────────────────────────────
        const stepMap = {
            stepOver: 'stepOver',
            stepInto: 'stepInto',
            stepOut:  'stepOut',
            continue: 'continueRun',
            runToEnd: 'runToEnd',
        };
        if (stepMap[action]) {
            if (!dc)          return this._txt('DebugController not available.');
            if (!dc.isActive) return this._txt('No debug session is active. Use action="start" to begin one.');
            await dc[stepMap[action]]();
            await new Promise(r => setTimeout(r, 300));  // let _onDialogBegin fire
            const si = dc._lastStepInfo;
            return this._txt(si
                ? `${action} sent. Now at depth ${si.depth}, step ${si.localStep}.`
                : `${action} command sent.`);
        }

        // ── Stop ───────────────────────────────────────────────────────────────
        if (action === 'stop') {
            if (!dc)          return this._txt('DebugController not available.');
            if (!dc.isActive) return this._txt('No active debug session.');
            await dc.stop();
            return this._txt('Debug session stopped.');
        }

        // ── Breakpoint management ──────────────────────────────────────────────

        if (action === 'listBreakpoints') {
            if (!dc) return this._txt('DebugController not available.');
            const bps = dc._bpMgr.getAllBreakpoints();
            if (bps.length === 0) return this._txt('No breakpoints are currently set.');
            const lines = ['**Breakpoints:**'];
            for (const bp of bps) {
                const lineNums = bp.lines.map(l => l + 1).join(', ');
                lines.push(`- ${bp.cellLabel}: line(s) ${lineNums}`);
            }
            return this._txt(lines.join('\n'));
        }

        if (action === 'addBreakpoint') {
            if (!dc) return this._txt('DebugController not available.');
            const lineNum = options.input?.line;
            if (lineNum == null) return this._txt('Required parameter "line" (1-based line number) is missing.');
            const editor = await resolveNotebookEditor();
            if (!editor) return this._txt('No active notebook editor.');
            const { cell, error } = this._getCell(options, editor.notebook);
            if (error) return this._txt(error);
            const uri = cell.document.uri.toString();
            dc._bpMgr.addBreakpointAt(uri, Number(lineNum) - 1);
            return this._txt(`Breakpoint added at line ${lineNum}.`);
        }

        if (action === 'removeBreakpoint') {
            if (!dc) return this._txt('DebugController not available.');
            const lineNum = options.input?.line;
            if (lineNum == null) return this._txt('Required parameter "line" (1-based line number) is missing.');
            const editor = await resolveNotebookEditor();
            if (!editor) return this._txt('No active notebook editor.');
            const { cell, error } = this._getCell(options, editor.notebook);
            if (error) return this._txt(error);
            const uri = cell.document.uri.toString();
            dc._bpMgr.removeBreakpointLine(uri, Number(lineNum) - 1);
            return this._txt(`Breakpoint at line ${lineNum} removed.`);
        }

        if (action === 'clearBreakpoints') {
            if (!dc) return this._txt('DebugController not available.');
            const cn = options.input?.cellNumber;
            if (cn != null) {
                const editor = await resolveNotebookEditor();
                if (!editor) return this._txt('No active notebook editor.');
                const { cell, error } = this._getCell(options, editor.notebook);
                if (error) return this._txt(error);
                dc._bpMgr.clearBreakpoints(cell);
                return this._txt(`All breakpoints cleared for Cell ${cn}.`);
            }
            dc._bpMgr.clearAllBreakpoints();
            return this._txt('All breakpoints cleared.');
        }

        // ── Watch variable management ──────────────────────────────────────────

        if (action === 'listWatch') {
            if (!dc) return this._txt('DebugController not available.');
            const wl = dc._watchPanel ? dc._watchPanel.getWatchList() : [];
            if (wl.length === 0) return this._txt('Watch list is empty. Add variables with action="addWatch".');
            return this._txt('**Watch list:**\n' + wl.map(v => `- ${v}`).join('\n'));
        }

        if (action === 'addWatch') {
            if (!dc) return this._txt('DebugController not available.');
            const varName = String(options.input?.variableName || '').trim();
            if (!varName) return this._txt('Required parameter "variableName" is missing.');
            const wp = dc._watchPanel;
            if (!wp) return this._txt('Watch panel not available.');
            if (wp._watchList.includes(varName)) return this._txt(`"${varName}" is already in the watch list.`);
            wp._watchList.push(varName);
            if (wp._onAddWatch) wp._onAddWatch(varName);
            return this._txt(`"${varName}" added to watch list. If a debug session is active, its value will appear at the next step pause.`);
        }

        if (action === 'removeWatch') {
            if (!dc) return this._txt('DebugController not available.');
            const varName = String(options.input?.variableName || '').trim();
            if (!varName) return this._txt('Required parameter "variableName" is missing.');
            const wp = dc._watchPanel;
            if (!wp) return this._txt('Watch panel not available.');
            const idx = wp._watchList.indexOf(varName);
            if (idx === -1) return this._txt(`"${varName}" was not in the watch list.`);
            wp._watchList.splice(idx, 1);
            if (wp._onRemoveWatch) wp._onRemoveWatch(varName);
            return this._txt(`"${varName}" removed from watch list.`);
        }

        // ── Status ─────────────────────────────────────────────────────────────
        if (action === 'status') {
            if (!dc || !dc.isActive) {
                return this._txt(
                    'No debug session is currently active.\n\n' +
                    'Use action="analyze" to inspect a cell\'s step structure, ' +
                    'then action="start" to begin a debug session.'
                );
            }
            const si = dc._lastStepInfo;
            const lines = ['**Debug session is active.**'];
            if (si) {
                lines.push(`**Current position:** depth=${si.depth}, step=${si.localStep}`);
                const ivKeys = Object.keys(si.iterVars || {});
                if (ivKeys.length > 0) {
                    lines.push('**Iterator variables:**');
                    for (const k of ivKeys) lines.push(`  - ${k} = ${si.iterVars[k]}`);
                }
            } else {
                lines.push('Session is starting; no step info yet.');
            }
            return this._txt(lines.join('\n'));
        }

        // ── Start ──────────────────────────────────────────────────────────────
        if (action === 'start') {
            if (!dc) return this._txt('DebugController not available.');
            const editor = await resolveNotebookEditor();
            if (!editor) return this._txt('No active notebook editor.');
            const { cell, error } = this._getCell(options, editor.notebook);
            if (error) return this._txt(error);
            if (cell.kind === vscode.NotebookCellKind.Markup) return this._txt('Cannot debug a markdown cell.');
            dc.startDebugCell(cell).catch(err => console.error('[debug tool] startDebugCell:', err));
            return this._txt(
                'Debug session started. The kernel will pause at the first step.\n\n' +
                'Use action="status" to check the current position, then use step commands to advance.'
            );
        }

        // ── Analyze (default) ─────────────────────────────────────────────────
        const editor = await resolveNotebookEditor();
        if (!editor) return this._txt('No active notebook editor.');

        const { cell, error: cellErr } = this._getCell(options, editor.notebook);
        if (cellErr) return this._txt(cellErr);

        if (cell.kind === vscode.NotebookCellKind.Markup) return this._txt('Selected cell is a markdown cell — cannot debug.');

        const code = cell.document.getText();
        if (!code.trim()) return this._txt('Cell is empty.');

        let codeTransformer;
        try {
            codeTransformer = require('../debugger/codeTransformer');
        } catch (err) {
            return this._txt(`Could not load code transformer: ${err.message}`);
        }

        const result = codeTransformer.transformCode(code);
        if (!result) {
            return this._txt('Could not instrument cell (empty or parse error).\n\nCell source:\n```wolfram\n' + code + '\n```');
        }

        const showCode = options.input?.showInstrumentedCode !== false;
        const lines = [];
        lines.push(`## Debug Analysis`);
        lines.push(`**Steps found:** ${result.steps.length} across ${result.maxDepth + 1} depth level(s)`);
        if (result.loopHead) {
            const iterLabel = result.loopVarName && result.loopHead !== 'For' ? `, {${result.loopVarName}, ...}` : '';
            lines.push(`**Outermost loop:** ${result.loopHead}[...${iterLabel}]`);
        }
        lines.push(`**Has nested loops:** ${result.hasLoop}`);
        lines.push('');
        lines.push('### Step Map');
        lines.push('| Depth | LocalStep | Lines | ContainsLoop |');
        lines.push('|-------|-----------|-------|--------------|');
        const sortedSteps = [...result.steps].sort((a, b) => a.depth !== b.depth ? a.depth - b.depth : a.localStep - b.localStep);
        for (const s of sortedSteps) {
            const lineRange = s.startLine === s.endLine ? `${s.startLine + 1}` : `${s.startLine + 1}–${s.endLine + 1}`;
            lines.push(`| ${s.depth} | ${s.localStep} | ${lineRange} | ${s.containsInnerLoop ? 'yes' : 'no'} |`);
        }

        if (result.breakpointMap && Object.keys(result.breakpointMap).length > 0) {
            lines.push('');
            lines.push('### Breakpoint Map');
            for (const [line, id] of Object.entries(result.breakpointMap)) {
                lines.push(`Line ${Number(line) + 1} → depth ${id.depth}, step ${id.localStep}`);
            }
        }

        if (showCode) {
            lines.push('');
            lines.push('### Instrumented Code');
            lines.push('```wolfram');
            lines.push(result.instrumentedCode);
            lines.push('```');
        }

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_moveCell — move a cell from one position to another
// ---------------------------------------------------------------------------

class MoveCellTool {
    async prepareInvocation(options, _token) {
        const from = options.input?.cellId || options.input?.cellNumber;
        const to   = options.input?.afterCellId || options.input?.toPosition;
        return { invocationMessage: `Move cell ${from} to after ${to}` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook = editor.notebook;
        const fromRef = options.input?.cellId != null ? options.input?.cellId : options.input?.cellNumber;
        const fromRes = resolveCellIndex(notebook, fromRef, options.input?.cellId != null ? 'cellId' : 'cellNumber');
        if (fromRes.error) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                fromRes.error
            )]);
        }
        const fromIdx = fromRes.idx;
        const cellNumber = fromIdx + 1;
        const sourceId = getCellToolId(notebook.cellAt(fromIdx));

        let toPosition;
        const afterCellId = options.input?.afterCellId;
        if (typeof afterCellId === 'string' && afterCellId.trim()) {
            const toRes = resolveCellIndex(notebook, afterCellId, 'afterCellId');
            if (toRes.error) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(toRes.error)]);
            toPosition = toRes.idx + 1;
        } else {
            toPosition = Number(options.input?.toPosition);  // insert AFTER this 1-based cell (0 = make first)
        }

        if (!Number.isInteger(toPosition) || toPosition < 0 || toPosition > notebook.cellCount) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Invalid toPosition ${toPosition}. Must be 0 (make first) to ${notebook.cellCount} (make last).`
            )]);
        }
        // No-op: toPosition === cellNumber (insert after self) or cellNumber-1 (insert before self)
        if (toPosition === cellNumber || toPosition === cellNumber - 1) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Cell ${cellNumber} is already at that position — no move needed.`
            )]);
        }

        const cell     = notebook.cellAt(fromIdx);
        const kind     = cell.kind;
        const lang     = cell.document.languageId;
        const source   = cell.document.getText();
        const cellData = new vscode.NotebookCellData(kind, source, lang);

        // Single atomic edit: delete at original index + insert at original toPosition.
        // VS Code applies notebook edits sorted by descending index, so:
        //   moving up  (fromIdx > toPosition): delete first, then insert — both valid
        //   moving down (fromIdx < toPosition): insert first, then delete — both valid
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [
            vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(fromIdx, fromIdx + 1)),
            vscode.NotebookEdit.insertCells(toPosition, [cellData])
        ]);
        await vscode.workspace.applyEdit(edit);

        const newPos = toPosition < cellNumber ? toPosition + 1 : toPosition;
        const newIdx = Math.max(0, newPos - 1);

        const kindStr = kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
        appendEventLog(`\u2195\uFE0F MOVE ${kindStr.toUpperCase()} CELL ${cellNumber} \u2192 position ${newPos}`,
            source.trim().slice(0, 100) || '*(empty)*');
        const posLabel = toPosition === 0 ? 'beginning' : `after Cell ${toPosition}`;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `Moved ${kindStr} Cell ${cellNumber} (index ${fromIdx}, CellId: ${sourceId}) to Cell ${newPos} (index ${newIdx}, ${posLabel}). Notebook now has ${notebook.cellCount} cell(s).`
        )]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_searchCells — find cells containing a pattern
// ---------------------------------------------------------------------------

class SearchCellsTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Search cells for "${options.input?.query || ''}"` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const query = options.input?.query;
        if (!query) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('query parameter is required.')]);

        const notebook   = editor.notebook;
        const isRegex    = options.input?.regex === true;
        const kindFilter = options.input?.kind; // 'code', 'markdown', or undefined for both
        const includeOutput = options.input?.includeOutput !== false;

        let re;
        try {
            re = isRegex ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        } catch (e) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Invalid regex: ${e.message}`)]);
        }

        const decoder = new util.TextDecoder();
        const matches = [];

        for (let i = 0; i < notebook.cellCount; i++) {
            const cell   = notebook.cellAt(i);
            const cellNo = i + 1;
            const isCode = cell.kind === vscode.NotebookCellKind.Code;
            const cellKind = isCode ? 'code' : 'markdown';

            if (kindFilter && cellKind !== kindFilter) continue;

            const src = cell.document.getText();
            let matchedIn = [];
            if (re.test(src)) matchedIn.push('source');

            // Search outputs for code cells
            if (isCode && includeOutput) {
                for (const output of cell.outputs) {
                    const plainItem = output.items.find(it => it.mime === 'text/plain');
                    if (plainItem) {
                        try {
                            const txt = decoder.decode(plainItem.data);
                            if (re.test(txt)) { matchedIn.push('output'); break; }
                        } catch (_) {}
                    }
                }
            }

            if (matchedIn.length > 0) {
                const preview = src.trim().slice(0, 120).replace(/\n/g, '\u21B5');
                const cellId = getCellToolId(cell);
                matches.push(`Cell ${cellNo} [${cellKind}] (index ${i}, CellId: ${cellId}; ${matchedIn.join('+')}) — ${preview}${src.trim().length > 120 ? '\u2026' : ''}`);
            }
        }

        if (matches.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`No cells match "${query}".`)]);
        }
        const header = `Found ${matches.length} cell(s) matching "${query}":`;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart([header, ...matches].join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_findPackage — search Wolfram Paclet server (via kernel) + GitHub
// ---------------------------------------------------------------------------

class FindPackageTool {
    constructor(getController) { this._getController = getController; }

    async prepareInvocation(options, _token) {
        return { invocationMessage: `Search paclets + GitHub for: ${options.input?.query || '?'}` };
    }

    async invoke(options, _token) {
        const rawQuery = (options.input?.query || '').trim();
        if (!rawQuery) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Provide a query string (e.g. "numerical ODE").')]);

        // Sanitise: only allow word chars, spaces, hyphens, dots — prevents URL/WL injection
        const query = rawQuery.replace(/[^\w\s\-\.]/g, '').trim();
        if (!query) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Invalid query — use alphanumeric characters.')]);

        const [gh, wl] = await Promise.all([this._searchGitHub(query), this._searchPaclets(query)]);

        const installGuide = [
            '',
            '## How to install',
            '**Paclet Server packages** — use `wolfbook_evaluateExpression` (set timeoutSeconds ≥ 120, installs download over the network):',
            '  1. `PacletInstall["PackageName"]`  — installs and returns a PacletObject',
            '     If it fails with a lookup error: `PacletSiteUpdate[]; PacletInstall["PackageName"]`',
            '  2. `Needs["PackageName`"]`  — loads the package into kernel',
            '',
            '**GitHub packages** — two cases:',
            '  A) Repo has a `.paclet` file in its GitHub Releases page:',
            '     `PacletInstall["https://github.com/USER/REPO/releases/download/vX.Y/Name-X.Y.paclet"]`',
            '     then `Needs["PackageName`"]`',
            '  B) Repo is plain `.m`/`.wl` files (no .paclet release):',
            '     Step 1 (in kernel): `URLDownload["https://github.com/USER/REPO/archive/refs/heads/main.zip", FileNameJoin[{$TemporaryDirectory, "pkg.zip"}]]`',
            '     Step 2: `ExtractArchive[FileNameJoin[{$TemporaryDirectory, "pkg.zip"}], FileNameJoin[{$TemporaryDirectory, "pkg"}]]`',
            '     Step 3: `AppendTo[$Path, FileNameJoin[{$TemporaryDirectory, "pkg", "REPO-main"}]]`',
            '     Step 4: `Get["MainFile.m"]`  (check repo README for the correct filename)',
            '',
            '**Note**: `PacletInstall` via `wolfbook_evaluateExpression` works but is slow — always use timeoutSeconds ≥ 120.',
            'After any install, restart the kernel is NOT required unless the paclet demands it.',
        ].join('\n');

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart([
            `## Wolfram Paclet Server — "${query}"`,
            wl,
            '',
            `## GitHub repositories — "${query} wolfram language"`,
            gh,
            installGuide
        ].join('\n'))]);
    }

    _searchGitHub(query) {
        const encoded = encodeURIComponent(query + ' wolfram language');
        const url     = `https://api.github.com/search/repositories?q=${encoded}&sort=stars&order=desc&per_page=8`;
        return new Promise(resolve => {
            const req = https.get(url, {
                timeout: 12000,
                headers: { 'User-Agent': 'Wolfbook-VSCode-Extension', 'Accept': 'application/vnd.github.v3+json' }
            }, res => {
                let body = '';
                res.on('data', c => { body += c; });
                res.on('end', () => {
                    try {
                        const d = JSON.parse(body);
                        if (!d.items || d.items.length === 0) { resolve('  (no results)'); return; }
                        const lines = d.items.map(r => {
                            const desc = (r.description || '(no description)').slice(0, 150);
                            const releaseUrl = `https://github.com/${r.full_name}/releases`;
                            return `  \u2022 **${r.full_name}** \u2B50${r.stargazers_count} https://github.com/${r.full_name}\n    ${desc}\n    Releases (check for .paclet): ${releaseUrl}`;
                        });
                        if (d.total_count > 8) lines.push(`  \u2026 and ${d.total_count - 8} more`);
                        resolve(lines.join('\n'));
                    } catch (e) { resolve(`  (parse error: ${e.message})`); }
                });
            });
            req.on('error',   err => resolve(`  (network error: ${err.message})`));
            req.on('timeout', ()  => { req.destroy(); resolve('  (GitHub search timed out)'); });
        });
    }

    async _searchPaclets(query) {
        const controller = this._getController?.();
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved' || controller._evalDispatched) {
            return '  (kernel not available — start the kernel for Wolfram Paclet Server search)';
        }
        // safeQ: only word chars + dots + hyphens, safe to embed in WL string
        const safeQ = query.replace(/[^A-Za-z0-9\s\-\.]/g, '').trim();
        if (!safeQ) return '  (invalid query for paclet search)';
        // Wrap in TimeConstrained (network call can be slow)
        const wlExpr =
            `TimeConstrained[Block[{$r$=Quiet[PacletFindRemote["*${safeQ}*"]]},` +
            `If[ListQ[$r$]&&Length[$r$]>0,` +
            `StringJoin[Riffle[Map[Function[p,` +
            `Block[{$n$=Quiet[p["Name"]],` +
            `$v$=Quiet[ToString[p["Version"]]],` +
            `$d$=Quiet[p["Description"]]},` +
            `"  \\u2022 "<>$n$<>" v"<>$v$<>` +
            `If[StringQ[$d$]&&$d$=!="","\\n    "<>StringTake[$d$,UpTo[120]],""]<>` +
            '"\\n    Install: PacletInstall[\\"" <> $n$ <> "\\"]; Needs[\\"" <> $n$ <> "`\\"]"' +
            `]],Take[$r$,UpTo[10]]],"\\n"]],` +
            `"  (none found on Wolfram Paclet Server)"]],` +
            `20,"  (paclet search timed out after 20s)"]`;
        try {
            const r = await Promise.race([
                controller.session.evaluate(wlExpr, { interactive: false }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 22000))
            ]);
            if (r?.result?.type === 'string' && r.result.value) return r.result.value;
            return '  (no results)';
        } catch (_) { return '  (paclet search error)'; }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_kernelCrashLog — read the kernel debug log and/or macOS crash reports
// ---------------------------------------------------------------------------

class KernelCrashLogTool {
    async prepareInvocation(options, _token) {
        const src = options.input?.source || 'debug';
        return { invocationMessage: `Read Wolfram kernel ${src} log` };
    }

    async invoke(options, _token) {
        const source  = options.input?.source || 'debug';  // 'debug' | 'crash' | 'all'
        const lines   = Math.max(20, Math.min(1000, Number(options.input?.lines) || 150));
        const filter  = options.input?.filter;
        const homeDir = process.env.HOME || '/tmp';

        const parts = [];
        if (source === 'debug' || source === 'all') parts.push(this._readDebugLog(homeDir, lines, filter));
        if (source === 'crash' || source === 'all') parts.push(this._readCrashReports(homeDir, filter));

        const result = parts.join('\n\n');
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    }

    _readDebugLog(homeDir, lines, filter) {
        // Log lives in img/<nbBase>/wolfram-kernel-debug.log next to btl.log
        let logPath = null;
        const ed = vscode.window.activeNotebookEditor;
        if (ed && ed.notebook && ed.notebook.uri.scheme === 'file') {
            const nbFsPath = ed.notebook.uri.fsPath;
            const nbBase   = path.basename(nbFsPath, path.extname(nbFsPath));
            const candidate = path.join(path.dirname(nbFsPath), 'img', nbBase, 'wolfram-kernel-debug.log');
            if (fs.existsSync(candidate)) logPath = candidate;
        }
        // Fallback: scan workspace folders for any img/*/wolfram-kernel-debug.log (most recent)
        if (!logPath) {
            const wsFolders = vscode.workspace.workspaceFolders || [];
            let best = null;
            for (const wsf of wsFolders) {
                const imgRoot = path.join(wsf.uri.fsPath, 'img');
                if (!fs.existsSync(imgRoot)) continue;
                try {
                    for (const sub of fs.readdirSync(imgRoot)) {
                        const candidate = path.join(imgRoot, sub, 'wolfram-kernel-debug.log');
                        if (fs.existsSync(candidate)) {
                            const mtime = fs.statSync(candidate).mtimeMs;
                            if (!best || mtime > best.mtime) best = { path: candidate, mtime };
                        }
                    }
                } catch (_) {}
            }
            if (best) logPath = best.path;
        }
        if (!logPath) {
            return `## Kernel Debug Log\nNot found.\nExpected at: img/<notebookName>/wolfram-kernel-debug.log\n(The log is created fresh each time the kernel starts.)`;
        }
        try {
            const stat    = fs.statSync(logPath);
            const sizeMB  = (stat.size / 1024 / 1024).toFixed(2);
            const modTime = stat.mtime.toISOString().replace('T', ' ').slice(0, 19);

            // Read the tail efficiently: seek to (size - 256 KB) and read to end
            const TAIL_BYTES = 256 * 1024;
            const fd         = fs.openSync(logPath, 'r');
            const readSize   = Math.min(stat.size, TAIL_BYTES);
            const buf        = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
            fs.closeSync(fd);

            let allLines = buf.toString('utf8').split('\n');
            if (stat.size > TAIL_BYTES) allLines = allLines.slice(1);  // drop partial first line

            if (filter) {
                try {
                    const re = new RegExp(filter, 'i');
                    allLines = allLines.filter(l => re.test(l));
                } catch (_) {
                    allLines = allLines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
                }
            }

            const tail   = allLines.slice(-lines);
            const header = filter
                ? `## Kernel Debug Log (${tail.length} matching lines for "${filter}" | ${sizeMB} MB | ${modTime})`
                : `## Kernel Debug Log (last ${tail.length} lines | ${sizeMB} MB | ${modTime})`;
            return header + '\n```\n' + tail.join('\n') + '\n```';
        } catch (err) {
            return `## Kernel Debug Log\nError reading: ${err.message}`;
        }
    }

    _readCrashReports(homeDir, filter) {
        const crashDir = path.join(homeDir, 'Library', 'Logs', 'DiagnosticReports');
        if (!fs.existsSync(crashDir)) {
            return '## macOS Crash Reports\nDiagnosticReports directory not found.';
        }
        try {
            const wolfFiles = fs.readdirSync(crashDir)
                .filter(f => /wolfram|mathematica|wstp/i.test(f) && (f.endsWith('.ips') || f.endsWith('.crash')))
                .map(f => {
                    try { return { name: f, mtime: fs.statSync(path.join(crashDir, f)).mtime }; }
                    catch (_) { return null; }
                })
                .filter(Boolean)
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 5);

            if (wolfFiles.length === 0) {
                return `## macOS Crash Reports\nNo Wolfram crash reports found in ${crashDir}.\n(Good \u2014 no kernel crashes detected.)`;
            }

            const lines = [`## macOS Crash Reports (${wolfFiles.length} most recent)`, 'Recent crash files:'];
            for (const f of wolfFiles) {
                lines.push(`  \u2022 ${f.name} \u2014 ${f.mtime.toISOString().replace('T', ' ').slice(0, 19)}`);
            }

            // Read first 5 KB of the most recent crash report
            const newest    = wolfFiles[0];
            const crashPath = path.join(crashDir, newest.name);
            try {
                const MAX = 5000;
                let   raw = fs.readFileSync(crashPath, 'utf8').slice(0, MAX);
                if (filter) {
                    try {
                        const re = new RegExp(filter, 'i');
                        raw = raw.split('\n').filter(l => re.test(l)).join('\n');
                    } catch (_) {
                        raw = raw.split('\n').filter(l => l.toLowerCase().includes(filter.toLowerCase())).join('\n');
                    }
                }
                lines.push(`\n### Latest crash: ${newest.name}\n\`\`\`\n${raw.slice(0, 4000)}\n\`\`\``);
            } catch (_) { lines.push(`\n(Could not read ${newest.name})`); }

            return lines.join('\n');
        } catch (err) {
            return `## macOS Crash Reports\nError: ${err.message}`;
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_runTerminal — run a shell command, return stdout/stderr
// ---------------------------------------------------------------------------

class RunTerminalTool {
    async prepareInvocation(options, _token) {
        const cmd = options.input?.command || '(no command)';
        return { invocationMessage: `Run: ${cmd.slice(0, 80)}` };
    }

    async invoke(options, _token) {
        const { execSync } = require('child_process');
        const command = options.input?.command;
        if (!command) return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('command is required.')]);
        const timeoutMs = Math.min((Number(options.input?.timeoutSeconds) || 30), 120) * 1000;
        const wsf = vscode.workspace.workspaceFolders;
        const wsRoot = wsf && wsf.length > 0 ? wsf[0].uri.fsPath : (process.env.HOME || '/');
        const cwd = options.input?.cwd || wsRoot;
        try {
            const output = execSync(command, {
                cwd,
                timeout: timeoutMs,
                maxBuffer: 512 * 1024,
                encoding: 'utf8',
                shell: '/bin/zsh',
                env: { ...process.env }
            });
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(output || '(no output)')]);
        } catch (e) {
            const msg = [e.stdout || '', e.stderr || '', e.message || ''].join('\n').trim();
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Command failed:\n${msg}`)]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_fileOps — read, write, or list workspace files
// ---------------------------------------------------------------------------

class FileOpsTool {
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'read';
        const p = options.input?.path || '';
        if (action === 'write') return { invocationMessage: `Write file: ${p}` };
        if (action === 'list') return { invocationMessage: `List files in: ${p || '.'}` };
        return { invocationMessage: `Read file: ${p}` };
    }

    async invoke(options, _token) {
        const action = options.input?.action || 'read';
        const wsf = vscode.workspace.workspaceFolders;
        const wsRoot = wsf && wsf.length > 0 ? wsf[0].uri.fsPath : (process.env.HOME || '/');

        function resolveP(p) {
            if (!p) return wsRoot;
            return path.isAbsolute(p) ? p : path.join(wsRoot, p);
        }

        if (action === 'read') {
            const filePath = options.input?.path;
            if (!filePath) return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('path is required for action="read".')]);
            const resolved = resolveP(filePath);
            try {
                const content = fs.readFileSync(resolved, 'utf8');
                const maxChar = 80000;
                const trunc = content.length > maxChar;
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(trunc ? content.slice(0, maxChar) + '\n[\u2026 truncated]' : content)]);
            } catch (e) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Error reading file: ${e.message}`)]);
            }
        }

        if (action === 'write') {
            const filePath = options.input?.path;
            const content  = options.input?.content;
            if (!filePath) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('path is required for action="write".')]);
            if (content === undefined) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('content is required for action="write".')]);
            const resolved = resolveP(filePath);
            try {
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                fs.writeFileSync(resolved, content, 'utf8');
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Written ${content.length} chars to ${resolved}`)]);
            } catch (e) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Error writing file: ${e.message}`)]);
            }
        }

        if (action === 'list') {
            const inputPath = options.input?.path || '';
            let base = resolveP(inputPath || '');
            if (!fs.existsSync(base)) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Path not found: ${base}`)]);
            }
            const ext      = options.input?.ext;
            const depth    = Math.min(Number(options.input?.depth) || 4, 8);
            const maxFiles = 500;
            const results  = [];
            const walk = (dir, d) => {
                if (d > depth || results.length >= maxFiles) return;
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const e of entries) {
                    if (e.name.startsWith('.')) continue;
                    const full = path.join(dir, e.name);
                    const rel  = path.relative(wsRoot, full);
                    if (e.isDirectory()) { results.push(rel + '/'); walk(full, d + 1); }
                    else if (!ext || e.name.endsWith(ext.startsWith('.') ? ext : '.' + ext)) results.push(rel);
                    if (results.length >= maxFiles) break;
                }
            };
            walk(base, 0);
            const trunc = results.length >= maxFiles;
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                results.join('\n') + (trunc ? '\n[truncated at 500 entries]' : '') || '(empty directory)')]);
        }

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Unknown action "${action}". Use "read", "write", or "list".`)]);
    }
}


// Wolfteam interaction tools — inline user consultation via confirmations
// ---------------------------------------------------------------------------

class ProposePlanTool {
    async prepareInvocation(options, _token) {
        const { planSummary } = options.input;
        return {
            invocationMessage: `📋 Plan: ${(planSummary || '').slice(0, 80)}`,
        };
    }

    async invoke(options, _token) {
        const { planSummary, steps } = options.input;
        const stepItems = (steps || []).map((s, i) => ({ label: `  ${i + 1}. ${s}`, kind: vscode.QuickPickItemKind.Default }));

        const choice = await vscode.window.showQuickPick([
            { label: '$(check) Approve', description: 'Proceed with this plan', value: 'approve' },
            { label: '$(edit) Approve with modifications', description: 'Add directions before proceeding', value: 'approve_note' },
            { label: '$(close) Reject', description: 'Try a different approach', value: 'reject' },
            { label: '$(comment) Reject with feedback', description: 'Explain what to change', value: 'reject_note' },
        ], {
            title: planSummary,
            placeHolder: (steps || []).map((s, i) => `${i + 1}. ${s}`).join('  •  ').slice(0, 120),
            ignoreFocusOut: true,
        });

        if (!choice) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('User closed the dialog without choosing. Ask if they want to continue or try a different approach.'),
            ]);
        }

        if (choice.value === 'approve') {
            const n = (steps || []).length;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Plan approved. ${n} steps to execute. Proceed with step 1.`),
            ]);
        }

        if (choice.value === 'approve_note' || choice.value === 'reject_note') {
            const isApprove = choice.value === 'approve_note';
            const note = await vscode.window.showInputBox({
                title: isApprove ? 'Modifications before proceeding' : 'Feedback on the plan',
                prompt: isApprove
                    ? 'What changes would you like before proceeding?'
                    : 'What should be different about this approach?',
                ignoreFocusOut: true,
            });
            if (note === undefined) {
                // user cancelled the input box — treat as plain approve/reject
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(isApprove
                        ? `Plan approved. Proceed with step 1.`
                        : `Plan rejected. Propose a different approach.`),
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(isApprove
                    ? `Plan approved with modifications: "${note}". Incorporate these changes and proceed.`
                    : `Plan rejected. User feedback: "${note}". Revise the plan accordingly and propose again.`),
            ]);
        }

        // reject
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Plan rejected. Propose a different approach.'),
        ]);
    }
}

class AskDecisionTool {
    async prepareInvocation(options, _token) {
        const { question } = options.input;
        return {
            invocationMessage: `❓ ${question}`,
        };
    }

    async invoke(options, _token) {
        const { question, options: opts, defaultOption, context } = options.input;

        const items = (opts || []).map(o => ({
            label: o === defaultOption ? `$(star) ${o}` : o,
            description: o === defaultOption ? 'recommended' : '',
            value: o,
        }));
        items.push({ label: '$(edit) Other…', description: 'Enter a custom answer', value: '__custom__' });

        const choice = await vscode.window.showQuickPick(items, {
            title: question,
            placeHolder: context || 'Choose an option',
            ignoreFocusOut: true,
        });

        if (!choice) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`User closed the dialog without choosing. Use the default "${defaultOption}" or re-ask if needed.`),
            ]);
        }

        if (choice.value === '__custom__') {
            const custom = await vscode.window.showInputBox({
                title: question,
                prompt: 'Enter your custom answer',
                ignoreFocusOut: true,
            });
            const answer = custom !== undefined ? custom : defaultOption;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`User chose custom answer: "${answer}". Proceed accordingly.`),
            ]);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`User chose: "${choice.value}" for the question "${question}". Proceed accordingly.`),
        ]);
    }
}

class CheckpointTool {
    async prepareInvocation(options, _token) {
        const { stepCompleted, nextStep } = options.input;
        return {
            invocationMessage: `✅ ${stepCompleted} → Next: ${(nextStep || '').slice(0, 60)}`,
        };
    }

    async invoke(options, _token) {
        const { stepCompleted, result, nextStep } = options.input;
        const resultPreview = (result || '').slice(0, 150);

        const choice = await vscode.window.showQuickPick([
            { label: '$(check) Continue', description: nextStep, value: 'continue' },
            { label: '$(comment) Continue with a note', description: 'Add directions before the next step', value: 'continue_note' },
            { label: '$(debug-pause) Pause', description: 'Inspect results — I\'ll tell you what to do next', value: 'pause' },
            { label: '$(refresh) Change approach', description: 'Try something different for this step', value: 'change' },
        ], {
            title: `✅ ${stepCompleted}`,
            placeHolder: resultPreview,
            ignoreFocusOut: true,
        });

        if (!choice) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`User closed the dialog. Step "${stepCompleted}" is done. Summarise the result and wait for further instructions.`),
            ]);
        }

        if (choice.value === 'continue') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`User confirmed. Step "${stepCompleted}" complete. Proceed with: ${nextStep}`),
            ]);
        }

        if (choice.value === 'continue_note') {
            const note = await vscode.window.showInputBox({
                title: 'Additional directions',
                prompt: 'What should be done differently or additionally in the next step?',
                ignoreFocusOut: true,
            });
            const noteText = note ? `User note: "${note}". ` : '';
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`User confirmed with directions. ${noteText}Step "${stepCompleted}" complete. Incorporate the note and proceed with: ${nextStep}`),
            ]);
        }

        if (choice.value === 'pause') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`User wants to pause and inspect. Summarise the result of "${stepCompleted}" clearly — key values, what was found — then stop and wait for the user's next message.`),
            ]);
        }

        // change approach
        const feedback = await vscode.window.showInputBox({
            title: 'Change approach',
            prompt: 'What should be different?',
            ignoreFocusOut: true,
        });
        const feedbackText = feedback ? `User feedback: "${feedback}".` : '';
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`User wants to change approach for this step. ${feedbackText} Reconsider the plan and propose an alternative.`),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration helper — called from extension.js activate()
// ---------------------------------------------------------------------------

// =============================================================================
// Wolfslide tools  —  manipulate .wslide custom editors
// =============================================================================

function _getSlideProvider() {
    try { return require('../slideEditorProvider').SlideEditorProvider.getInstance(); }
    catch (_) { return null; }
}
function _slideResult(text) {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
function _uid() { return Math.random().toString(36).slice(2, 10); }

/** Recursively assign IDs to any block (or slide children) that lacks one. */
function _ensureBlockIds(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(_ensureBlockIds); return; }
    if (node.type && !node.id) node.id = _uid();
    if (node.children) _ensureBlockIds(node.children);
    if (node.items) _ensureBlockIds(node.items);
    if (node.elements) _ensureBlockIds(node.elements);
}

/** Recursively collect all image blocks from a slide (v2 children or v1 elements). */
function _collectImages(node) {
    if (!node) return [];
    const imgs = [];
    function walk(b) {
        if (!b) return;
        if (b.type === 'image') imgs.push(b);
        (b.children || b.items || b.elements || []).forEach(walk);
    }
    (node.children || node.elements || []).forEach(walk);
    return imgs;
}

/** Recursively collect every block in a slide. */
function _collectAllBlocks(node) {
    if (!node) return [];
    const blocks = [];
    function walk(b) {
        if (!b) return;
        blocks.push(b);
        (b.children || b.items || b.elements || []).forEach(walk);
    }
    (node.children || node.elements || []).forEach(walk);
    return blocks;
}

/** Resolve a slide from options (slideId or slideIndex), returning { deck, idx, slide, docUri } or null. */
function _resolveSlide(options) {
    const p = _getSlideProvider();
    if (!p) return null;
    const docUri = options.input?.docUri;
    const deck = p.getDeck(docUri);
    if (!deck) return null;
    let idx;
    const slideId = options.input?.slideId;
    if (slideId) {
        idx = (deck.slides || []).findIndex(s => s.id === slideId);
        if (idx === -1) return { error: `Slide with id="${slideId}" not found. Valid ids: ${deck.slides.map(s => s.id).join(', ')}` };
    } else {
        // Accept 'slideNumber' as an alias for 'slideIndex'
        const raw = options.input?.slideIndex ?? options.input?.slideNumber;
        if (raw != null) {
            idx = Number(raw) - 1;
        } else {
            // Default to the currently visible slide
            const activeEntry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
            idx = activeEntry?.currentSlideIndex ?? 0;
        }
    }
    const slide = deck.slides?.[idx];
    if (!slide) return { error: `Slide ${idx + 1} not found (deck has ${deck.slides?.length ?? 0}).` };
    return { deck, idx, slide, docUri, p };
}

/** Recursively find a block by id in a slide, returning { block, parent, key, index } or null. */
function _findBlockRecursive(blockId, root) {
    if (!root || !blockId) return null;
    const arrays = [
        { key: 'children', arr: root.children },
        { key: 'items',    arr: root.items },
        { key: 'elements', arr: root.elements },
    ];
    for (const { key, arr } of arrays) {
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i].id === blockId) return { block: arr[i], parent: root, key, index: i };
            const found = _findBlockRecursive(blockId, arr[i]);
            if (found) return found;
        }
    }
    return null;
}

/** Deep merge source into target (mutates target). Arrays are replaced, not merged. */
function _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
            && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            _deepMerge(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
}

/** Strip HTML tags and entities from a content string, return plain-text preview. */
function _stripHtml(html) {
    if (!html) return '';
    return (html + '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

/** Short human-readable label for a block. */
function _blockLabel(b) {
    const nameTag = b.name ? ` "${b.name}"` : '';
    switch (b.type) {
        case 'heading':   return `[H${b.level || 2}${nameTag}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'text':      return `[TEXT${nameTag}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'code':      return `[CODE${nameTag} ${b.language || ''}] "${_stripHtml(b.content).slice(0, 80)}"`;
        case 'image':     return `[IMG${nameTag}] alt="${b.alt || '⚠NOT SET'}" src=${(b.src || '').split('/').slice(-2).join('/') || '?'}`;
        case 'list':      return `[LIST${nameTag}] ${(b.items || []).length} items: "${_stripHtml((b.items?.[0]?.content) || '').slice(0, 50)}"…`;
        case 'container': {
            const flex = (b.style?.flex || b.style?.width || '').match(/[\d.]+%/) ? ` flex:${b.style.flex || b.style.width}` : (b.flex ? ` flex:${b.flex}` : '');
            const grid = b.style?.gridTemplateColumns ? ` grid(${b.style.gridTemplateColumns})` : '';
            const cn   = b.className ? ` .${b.className}` : '';
            const ch   = (b.children || []).length;
            return `[CONT${nameTag} ${b.layout || 'col'}${flex}${grid}${cn} children:${ch}]`;
        }
        case 'arrow':     return `[ARROW${nameTag}] (${b.x0},${b.y0})→(${b.x1},${b.y1})`;
        case 'raw':       return `[RAW HTML${nameTag}]`;
        case 'eval': {
            const inp = (b.input || '').slice(0, 60);
            const st = b.output ? (b.output.type === 'image' ? '✓img' : b.output.type === 'error' ? '✗err' : '✓txt') : '⏳';
            return `[EVAL${nameTag} ${st}] "${inp}"`;
        }
        default:          return `[${b.type || '?'}${nameTag}]`;
    }
}

/** Positional/animation annotations for a block. */
function _blockAnno(b) {
    const parts = [];
    if (b.name) parts.push(`name:${b.name}`);
    if (b.fragmentOrder != null) parts.push(`⚡step${b.fragmentOrder}`);
    if (b.offset && (b.offset.dx || b.offset.dy))
        parts.push(`@(${b.offset.dx >= 0 ? '+' : ''}${b.offset.dx},${b.offset.dy >= 0 ? '+' : ''}${b.offset.dy})`);
    if (b.w || b.h) {
        let dimStr = `${b.w || '?'}×${b.h || '?'}px`;
        // Show style constraints that override w/h visually
        const mw = b.style?.maxWidth; const mh = b.style?.maxHeight;
        if (mw || mh) dimStr += ` (capped:${mw ? ' maxW=' + mw : ''}${mh ? ' maxH=' + mh : ''})`;
        parts.push(dimStr);
    }
    if (b.type === 'image' && !b.alt) parts.push('⚠NO-ALT');
    return parts.length ? `  [${parts.join(' ')}]` : '';
}

/**
 * Render an ASCII structural layout diagram of a slide (78 chars wide).
 * Row-containers are rendered as side-by-side columns using box-drawing chars.
 * Flex percentages are used to proportion column widths when present.
 */
function _asciiSlide(slide) {
    const TOTAL_W = 78;
    const lines = [];

    function renderBlock(b, indent, availW) {
        const pfx = ' '.repeat(indent);
        const idTag = b.id ? ` #${b.id.slice(0, 8)}` : '';
        const header = _blockLabel(b) + _blockAnno(b) + idTag;
        lines.push((pfx + header).slice(0, availW));

        const kids = b.type !== 'list' ? (b.children || b.elements || []) : [];
        if (!kids.length) return;

        const isRow = b.type === 'container' &&
            (b.layout === 'row' || (b.style?.display === 'flex' && b.style?.flexDirection !== 'column'));

        if (isRow) {
            // Determine proportional column widths from flex percentages
            const flexVals = kids.map(k => {
                const src = k.style?.flex || k.style?.width || '';
                const m = src.match(/(\d+(?:\.\d+)?)%/);
                return m ? parseFloat(m[1]) : null;
            });
            const allFlex = flexVals.every(v => v !== null);
            const totalFlex = allFlex ? flexVals.reduce((a, v) => a + v, 0) : kids.length;
            const innerW = Math.max(kids.length * 4, availW - indent - 2);
            const rawWidths = flexVals.map((v, i) =>
                Math.max(4, v !== null
                    ? Math.round(v / totalFlex * innerW)
                    : Math.round(innerW / kids.length))
            );
            // Fix rounding so columns sum to innerW; clamp to min 1 to prevent repeat() crash
            const diff = innerW - rawWidths.reduce((a, v) => a + v, 0);
            rawWidths[rawWidths.length - 1] = Math.max(1, rawWidths[rawWidths.length - 1] + diff);
            // Clamp all widths to at least 1
            for (let i = 0; i < rawWidths.length; i++) rawWidths[i] = Math.max(1, rawWidths[i]);

            // Collect content lines for each column (max depth 3 levels)
            const colContents = kids.map((k, ci) => {
                const cw = rawWidths[ci];
                const tmp = [];
                function sub(b2, d) {
                    if (d > 3) return;
                    tmp.push((_blockLabel(b2) + _blockAnno(b2)).slice(0, cw - 2));
                    const kids2 = b2.type !== 'list' ? (b2.children || b2.elements || []) : [];
                    kids2.forEach(k2 => sub(k2, d + 1));
                }
                sub(k, 0);
                return tmp;
            });

            const maxRows = Math.max(1, ...colContents.map(c => c.length));
            const colWstr = rawWidths.map(w => '─'.repeat(w));
            lines.push(pfx + '┌' + colWstr.join('┬') + '┐');
            for (let r = 0; r < maxRows; r++) {
                let row = pfx + '│';
                colContents.forEach((cc, ci) => {
                    const cw = rawWidths[ci];
                    const txt = cc[r] || '';
                    row += txt + ' '.repeat(Math.max(0, cw - txt.length)) + '│';
                });
                lines.push(row);
            }
            lines.push(pfx + '└' + colWstr.join('┴') + '┘');
        } else {
            kids.forEach(k => renderBlock(k, indent + 2, availW));
        }
    }

    const topBlocks = slide.children || slide.elements || [];
    topBlocks.forEach((b, i) => {
        if (i > 0) lines.push('─'.repeat(TOTAL_W));
        renderBlock(b, 0, TOTAL_W);
    });
    return lines.join('\n');
}

// ── Theme presets ─────────────────────────────────────────────────────────
const THEME_PRESETS = {
    'academic-light': {
        label: 'Academic Light',
        description: 'Clean white/light-grey background with navy/blue accents. Good for formal talks.',
        defaultBackground: '#fafcff',
        theme: {
            navy: '#0a244a', blue: '#0064b4', cyan: '#009ac8', accent: '#be1e2d',
            editorCSS: `.gl { color: #f59e0b; } .te { color: #2dd4bf; } .ro { color: #fb7185; } .mu { color: #a78bfa; } .bl { color: #0064b4; } .re { color: #be1e2d; } .cy { color: #009ac8; }`
        }
    },
    'dark-modern': {
        label: 'Dark Modern',
        description: 'Dark #0d1117 background with gold/teal/rose palette. Ideal for tech/science talks.',
        defaultBackground: '#0d1117',
        theme: {
            navy: '#0d1117', blue: '#58a6ff', cyan: '#2dd4bf', accent: '#f59e0b',
            editorCSS: `.gl { color: #f59e0b; } .te { color: #2dd4bf; } .ro { color: #fb7185; } .mu { color: #a78bfa; } .bl { color: #58a6ff; } .re { color: #ff7b72; } .cy { color: #2dd4bf; } h1,h2,h3 { color: #f0f6fc; } p,div,li,span { color: #c9d1d9; }`
        }
    },
    'dark-navy': {
        label: 'Dark Navy',
        description: 'Deep navy #0a1628 background with bright blue/cyan/red accents. Professional & bold.',
        defaultBackground: '#0a1628',
        theme: {
            navy: '#0a1628', blue: '#3b82f6', cyan: '#22d3ee', accent: '#ef4444',
            editorCSS: `.gl { color: #fbbf24; } .te { color: #34d399; } .ro { color: #fb7185; } .mu { color: #a78bfa; } .bl { color: #3b82f6; } .re { color: #ef4444; } .cy { color: #22d3ee; } h1,h2,h3 { color: #e2e8f0; } p,div,li,span { color: #94a3b8; }`
        }
    },
    'solarized-dark': {
        label: 'Solarized Dark',
        description: 'Warm dark #002b36 background with Solarized palette. Easy on the eyes.',
        defaultBackground: '#002b36',
        theme: {
            navy: '#002b36', blue: '#268bd2', cyan: '#2aa198', accent: '#cb4b16',
            editorCSS: `.gl { color: #b58900; } .te { color: #2aa198; } .ro { color: #dc322f; } .mu { color: #6c71c4; } .bl { color: #268bd2; } .re { color: #dc322f; } .cy { color: #2aa198; } h1,h2,h3 { color: #eee8d5; } p,div,li,span { color: #93a1a1; }`
        }
    },
    'high-contrast': {
        label: 'High Contrast',
        description: 'Pure black #000 background, vivid neon accents. Maximum contrast for projectors.',
        defaultBackground: '#000000',
        theme: {
            navy: '#000000', blue: '#4fc3f7', cyan: '#00e5ff', accent: '#ff1744',
            editorCSS: `.gl { color: #fdd835; } .te { color: #69f0ae; } .ro { color: #ff5252; } .mu { color: #b388ff; } .bl { color: #4fc3f7; } .re { color: #ff1744; } .cy { color: #00e5ff; } h1,h2,h3 { color: #ffffff; } p,div,li,span { color: #e0e0e0; }`
        }
    },
    'warm-cream': {
        label: 'Warm Cream',
        description: 'Light warm #fdf6e3 background with earth tones. Soft, friendly aesthetic.',
        defaultBackground: '#fdf6e3',
        theme: {
            navy: '#3e2723', blue: '#1565c0', cyan: '#00838f', accent: '#c62828',
            editorCSS: `.gl { color: #e65100; } .te { color: #00695c; } .ro { color: #c62828; } .mu { color: #6a1b9a; } .bl { color: #1565c0; } .re { color: #c62828; } .cy { color: #00838f; } h1,h2,h3 { color: #3e2723; } p,div,li,span { color: #5d4037; }`
        }
    },
};

class WolfslideGetContextTool {
    prepareInvocation() { return { invocationMessage: 'Getting slide editor context' }; }
    async invoke(_options, _token) {
        const p = _getSlideProvider();
        const openUris = p ? p.listOpenEditors() : [];
        const activeEntry = p ? p.getActiveEntry() : null;
        const activeUri = activeEntry?.document?.uri?.toString() ?? null;

        const lines = [];

        if (openUris.length) {
            lines.push('Open .wslide editors:');
            for (const u of openUris) {
                const d = p.getDeck(u);
                const title = d?.meta?.title || 'Untitled';
                const count = d?.slides?.length ?? 0;
                const marker = u === activeUri ? '  [ACTIVE]' : '';
                lines.push(`  ${u}  [${count} slides, title: "${title}"]${marker}`);
            }
        } else {
            lines.push('No .wslide editors currently open.');
        }

        // Also list workspace .wslide files that are not open in the editor
        try {
            const found = await vscode.workspace.findFiles('**/*.wslide', '**/node_modules/**', 50);
            const openSet = new Set(openUris);
            const closed = found.filter(f => !openSet.has(f.toString()));
            if (closed.length) {
                lines.push('');
                lines.push('Other .wslide files in workspace (not currently open):');
                closed.forEach(f => lines.push(`  ${f.toString()}`));
            }
        } catch (_) { /* workspace.findFiles may fail in some environments */ }

        // ── Currently visible slide ──────────────────────────────────────
        const activeDeck = activeEntry ? p.getDeck(activeUri) : null;
        if (activeDeck) {
            const idx = activeEntry.currentSlideIndex ?? 0;
            const slide = activeDeck.slides?.[idx];
            if (slide) {
                lines.push('');
                lines.push(`Currently visible slide: ${idx + 1} of ${activeDeck.slides.length} — "${slide.label || '(unlabeled)'}"`);
                const ascii = _asciiSlide(slide);
                lines.push('Block tree:');
                lines.push('```');
                lines.push(ascii);
                lines.push('```');
            }
        }

        // ── Current theme ────────────────────────────────────────────────
        if (activeDeck) {
            const t = activeDeck.theme || {};
            lines.push('');
            lines.push('Current theme:');
            lines.push(`  navy=${t.navy||'#0a244a'} blue=${t.blue||'#0064b4'} cyan=${t.cyan||'#009ac8'} accent=${t.accent||'#be1e2d'}`);
            if (t.editorCSS) {
                lines.push(`  editorCSS (${t.editorCSS.length} chars):`);
                lines.push(t.editorCSS);
            }
        }

        // ── Renderer capabilities ────────────────────────────────────────
        lines.push('');
        lines.push('=== Renderer Capabilities ===');
        lines.push('Math: KaTeX supported — use $...$ for inline math, $$...$$ for display math in any text/heading content.');
        lines.push('Animation: add "fragmentOrder": N (integer ≥1) to any block for Reveal.js step-by-step animation within a slide.');
        lines.push('Eval blocks: type "eval" blocks evaluate Mathematica code live. Graphics produce SVG; symbolic expressions produce LaTeX (via KaTeX). Use wolfslide_insertEvalBlock to add, wolfslide_runEvalBlock to re-evaluate.');
        lines.push('  Eval blocks are ideal for: computed plots (Plot, ListPlot, Graphics), formulas (Integrate, Series), tables, and any dynamic Wolfram Language output.');
        lines.push('  The output type is automatic: graphics → crisp SVG, math expressions → beautifully typeset LaTeX, fallback → PNG image.');
        lines.push('CSS color classes available in editorCSS: .gl (gold), .te (teal), .ro (rose), .mu (mauve), .bl (blue), .re (red), .cy (cyan).');
        lines.push('  Usage: <span class="gl">highlighted text</span> inside content strings.');
        lines.push('Theme: set via wolfslide_setTheme. Colors are CSS custom properties: --navy, --blue, --cyan, --accent, --slidebg.');

        // ── Theme presets ────────────────────────────────────────────────
        lines.push('');
        lines.push('Available theme presets (use wolfslide_setTheme with preset name):');
        for (const [key, p2] of Object.entries(THEME_PRESETS)) {
            lines.push(`  "${key}" — ${p2.description}`);
        }

        // ── Best practices ───────────────────────────────────────────────
        lines.push('');
        lines.push('=== Best Practices ===');
        lines.push('• Start with wolfslide_setTheme to set a color preset before building slides.');
        lines.push('• For new decks with many slides, use wolfslide_bulkInsert to insert all slides in one call.');
        lines.push('• Use containers with layout:"row" for side-by-side columns, layout:"column" for vertical stacking.');
        lines.push('• Add flex:"1" to child containers for equal-width columns, or flex:"60%" / flex:"40%" for proportional.');
        lines.push('• Set slide.background for per-slide backgrounds; the theme provides defaults.');
        lines.push('• Use fragmentOrder for narrative builds: 1,2,3… reveals items in order on click/advance.');
        lines.push('• Images support: w, h (pixels), fit ("contain"/"cover"), alt (accessibility text).');
        lines.push('• Font size: block.fontSize (number in px). Headings default to ~48px; body to ~28px.');
        lines.push('• Block positioning: default is flow layout. Set position:"absolute", x, y for pixel-precise placement.');
        lines.push('Inspection workflow: (1) wolfslide_listSlides — overview of all slides with block counts, steps, char counts; pass verbose:true to also get the ASCII block tree for every slide. (2) wolfslide_getSlide — full block tree + raw JSON for one slide; defaults to the currently visible slide when no index given. (3) wolfslide_searchSlides — find blocks by text query, block type, or style property across the whole deck. (4) wolfslide_getSlideHtml — render a single slide to standalone HTML instantly (avoids exporting the full 4MB deck just to check layout).');
        lines.push('• NEVER write JSON directly to .wslide files — always use wolfslide tools to keep the editor in sync.');
        lines.push('• Use eval blocks for computed content: plots, formulas, diagrams — they render as crisp SVG or LaTeX instead of static images.');
        lines.push('• Prefer eval blocks over external image files when the content can be generated by Wolfram Language (e.g., Plot, Graphics, NumberLinePlot).');
        lines.push('• Image layout contract: the image block\'s w and h properties define the wrapper div size. style.maxHeight / style.maxWidth only constrain the wrapper — without explicit w and h, the image still fills the column. Always set w, h, AND style.maxHeight/maxWidth together, OR just use w and h alone. Use wolfslide_getImageDimensions to get pixel dimensions from a local path or URL before inserting.');
        lines.push('• fragmentOrder on containers: setting fragmentOrder on a container block animates the entire container as one unit (all children appear/disappear together). Use this for revealing whole column sections at once.');
        lines.push('• External image URLs (arXiv, web): links work in the editor preview but may be blocked offline or slow to load in exported HTML. Copy images locally with wolfslide_imageAsset({action:"copy",...}) for reliable exports.');

        // ── New-deck onboarding ──────────────────────────────────────────
        if (activeDeck && (activeDeck.slides || []).length === 0) {
            lines.push('');
            lines.push('╔══════════════════════════════════════════════════════════════╗');
            lines.push('║  NEW DECK — AI QUICK-START GUIDE                            ║');
            lines.push('╚══════════════════════════════════════════════════════════════╝');
            lines.push('');
            lines.push('This deck has no slides yet. Here is everything you need to build it efficiently.');
            lines.push('');
            lines.push('── STEP 1: Set theme ──────────────────────────────────────────');
            lines.push('Call wolfslide_setTheme with EITHER:');
            lines.push('  • preset: "dark-modern"  (or any preset name — see list above)');
            lines.push('  • theme: { navy:"#1e3a6a", blue:"#1e5aaa", cyan:"#00bcd4", accent:"#e67820", editorCSS:"..." }');
            lines.push('NEVER use "overrides" — that key is invalid and silently ignored. Use "theme" (object).');
            lines.push('');
            lines.push('── STEP 2: Build slides with wolfslide_bulkInsert ─────────────');
            lines.push('Pass the whole deck in one call. Example slide structure:');
            lines.push('  {');
            lines.push('    "label": "Title Slide",');
            lines.push('    "background": "#0a1628",');
            lines.push('    "layout": "column",');
            lines.push('    "children": [');
            lines.push('      { "type": "heading", "level": 1, "content": "My Talk",');
            lines.push('        "style": { "color": "#e2e8f0", "fontSize": "72px", "textAlign": "center" } },');
            lines.push('      { "type": "text", "content": "Author · Institution · Date",');
            lines.push('        "style": { "color": "#94a3b8", "fontSize": "28px", "textAlign": "center" } }');
            lines.push('    ]');
            lines.push('  }');
            lines.push('');
            lines.push('── KEY LAYOUT RULES ───────────────────────────────────────────');
            lines.push('• Canvas: 1920×1080 px. Use explicit "960px" heights, NOT "100%" for full-screen rows.');
            lines.push('• Side-by-side columns: container with layout:"row", children with style:{flex:"1"} each.');
            lines.push('• Full-height layout: { "type":"container", "layout":"row", "style":{"height":"960px","display":"flex"} }');
            lines.push('• Each visual element = its own block. Do NOT concatenate multiple divs into one text block.');
            lines.push('• Every block gets a unique ID automatically — do not set "id" in bulkInsert (will be overwritten).');
            lines.push('');
            lines.push('── INLINE STYLES ARE MANDATORY ────────────────────────────────');
            lines.push('CSS classes like .prob, .sol, .stepbox only work if they are defined in editorCSS.');
            lines.push('For robust decks: use inline style objects on every block, e.g.:');
            lines.push('  { "type":"text", "content":"...", "style":{"color":"#22d3ee","fontWeight":"bold"} }');
            lines.push('Inline styles never depend on editorCSS and always render correctly.');
            lines.push('');
            lines.push('── ANIMATION / FRAGMENTS ──────────────────────────────────────');
            lines.push('Add "fragmentOrder": N (integer ≥1) to any block to reveal it on click N.');
            lines.push('Fragments must be SEPARATE blocks (one div per step, not one big div with all steps).');
            lines.push('Example: three bullet points revealed one by one:');
            lines.push('  { "type":"text", "content":"Point 1", "fragmentOrder":1, "style":{...} }');
            lines.push('  { "type":"text", "content":"Point 2", "fragmentOrder":2, "style":{...} }');
            lines.push('  { "type":"text", "content":"Point 3", "fragmentOrder":3, "style":{...} }');
            lines.push('');
            lines.push('── TRANSITIONS ────────────────────────────────────────────────');
            lines.push('Slide-level: set "transition":"fade" or "transition":"slide" on each slide object.');
            lines.push('Use "fade" for title/section slides; "slide" for content slides.');
            lines.push('');
            lines.push('── MATH ────────────────────────────────────────────────────────');
            lines.push('KaTeX supported in any text/heading: use $...$ inline, $$...$$ for display.');
            lines.push('Example: { "type":"text", "content":"The formula is $E = mc^2$" }');
            lines.push('');
            lines.push('── IMAGES ─────────────────────────────────────────────────────');
            lines.push('{ "type":"image", "src":"img/deck.wslide/file.png", "w":800, "h":600, "alt":"description" }');
            lines.push('Always set "alt". Use "fit":"contain" or "fit":"cover".');
            lines.push('');
            lines.push('── EVAL BLOCKS (Mathematica) ───────────────────────────────────');
            lines.push('Use wolfslide_insertEvalBlock to add live Wolfram Language code.');
            lines.push('Graphics → SVG, expressions → LaTeX (KaTeX), fallback → PNG.');
            lines.push('');
            lines.push('── EDITING INDIVIDUAL BLOCKS ───────────────────────────────────');
            lines.push('After creating slides, use wolfslide_getSlide to get the ASCII diagram with block IDs (#xxxxxxxx).');
            lines.push('Then use wolfslide_editSlide(action:"editBlock") or wolfslide_block(action:"edit") with the block id.');
            lines.push('');
            lines.push('── VERIFY THEME WAS APPLIED ────────────────────────────────────');
            lines.push('After wolfslide_setTheme, call wolfslide_getContext again — the full editorCSS will appear above.');
            lines.push('Check that the colors and CSS match what you intended before building slides.');
        }

        return _slideResult(lines.join('\n'));
    }
}

class WolfslideListSlidesTool {
    prepareInvocation() { return { invocationMessage: 'Listing slides' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri || undefined;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        const verbose = !!options.input?.verbose;
        const lines = (deck.slides || []).map((s, i) => {
            const label   = s.label || s.meta?.title || '';
            const bg      = s.background || '';
            const hidden  = s.hidden ? '  HIDDEN' : '';
            const topBlocks = s.children || s.elements || [];
            // One-line block list: type + key content/size
            const blockDesc = topBlocks.map(b => {
                let d = _blockLabel(b);
                const ann = _blockAnno(b);
                return ann ? d + ann : d;
            }).join(' | ');
            const imgs   = _collectImages(s);
            const imgInfo = imgs.length
                ? `  images(${imgs.length}): ` + imgs.map(im => {
                    const size = (im.w && im.h) ? `${im.w}×${im.h}` : (im.w ? `w=${im.w}` : '');
                    const alt  = im.alt ? `"${im.alt}"` : '⚠NO-ALT';
                    return [alt, size].filter(Boolean).join(' ');
                }).join(', ')
                : '';
            const allBlocks = _collectAllBlocks(s);
            const fragCount = allBlocks.filter(b => b.fragmentOrder != null && b.fragmentOrder >= 1).length;
            const stepsInfo = fragCount > 0 ? `  steps:${fragCount}` : '';
            // Total text character count
            const charCount = allBlocks.reduce((sum, b) => sum + _stripHtml(b.content || '').length + (b.items || []).reduce((s2, it) => s2 + _stripHtml(it.content || '').length, 0), 0);
            const charsInfo = `  chars:${charCount}`;
            // Inline warnings
            const warnings = [];
            const noAltImgs = imgs.filter(im => !im.alt);
            if (noAltImgs.length) warnings.push('no-alt');
            if (topBlocks.length > 10) warnings.push('dense');
            const warnInfo = warnings.length ? `  ⚠${warnings.join(',')}` : '';
            const summary = `[${i + 1}] id=${s.id}  label="${label}"  bg="${bg}"${hidden}${stepsInfo}${charsInfo}${warnInfo}\n    blocks: ${blockDesc}${imgInfo}`;
            if (verbose) {
                const ascii = _asciiSlide(s);
                return summary + '\n```\n' + ascii + '\n```';
            }
            return summary;
        });
        return _slideResult(`${lines.length} slide(s):\n` + lines.join('\n'));
    }
}

class WolfslideGetSlideTool {
    prepareInvocation(options) {
        const n = options.input?.slideIndex ?? options.input?.slideNumber ?? '?';
        return { invocationMessage: `Getting slide ${n}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        let idx;
        const slideId = options.input?.slideId;
        if (slideId) {
            idx = (deck.slides || []).findIndex(s => s.id === slideId);
            if (idx === -1) return _slideResult(`Slide with id="${slideId}" not found. Valid ids: ${deck.slides.map(s => s.id).join(', ')}`);
        } else {
            // Accept slideNumber as alias; default to currently visible slide
            const raw = options.input?.slideIndex ?? options.input?.slideNumber;
            if (raw != null) {
                idx = Number(raw) - 1;
            } else {
                const activeEntry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
                idx = activeEntry?.currentSlideIndex ?? 0;
            }
        }
        const slide = deck.slides?.[idx];
        if (!slide) return _slideResult(`Slide ${idx + 1} not found (deck has ${deck.slides?.length ?? 0}).`);

        // ASCII structural layout — helps AI "see" the slide composition
        const label  = slide.label || slide.meta?.title || '';
        const hidden = slide.hidden ? '  ⚠ HIDDEN (skipped in presentation)' : '';
        const transition = slide.transition ? `  transition: ${slide.transition}` : '';
        const asciiHeader =
            `## Slide ${idx + 1}: "${label}"  bg: ${slide.background || 'default'}  layout: ${slide.layout || 'column'}${hidden}${transition}\n` +
            `## Canvas: 1920×1080 px  |  blocks at top level: ${(slide.children || slide.elements || []).length}\n`;
        const ascii = _asciiSlide(slide);

        // Speaker notes
        const notesSummary = slide.notes ? `\n\n## Speaker Notes\n${slide.notes}` : '';

        // Image details
        const imgs = _collectImages(slide);
        const imgSummary = imgs.length
            ? '\n\n## Images on this slide\n' + imgs.map((im, n) => {
                const size = (im.w && im.h) ? `size: ${im.w}×${im.h}px` : (im.w ? `w: ${im.w}px` : 'size: unknown');
                const alt  = `alt: "${im.alt || '⚠ NOT SET'}"`;
                const src  = `src: ${(im.src || '').split('/').pop()}`;
                const off  = im.offset ? `offset: (${im.offset.dx},${im.offset.dy})` : '';
                return `  [img ${n + 1}] ${[alt, size, src, off].filter(Boolean).join(' | ')}`;
            }).join('\n')
            : '';

        const output =
            asciiHeader +
            '```\n' + ascii + '\n```' +
            imgSummary +
            notesSummary +
            '\n\n## Raw JSON\n```json\n' + JSON.stringify(slide, null, 2) + '\n```';
        return _slideResult(output);
    }
}

class WolfslideInsertSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Inserting slide at position ${options.input?.afterIndex ?? 'end'}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        const newSlide = options.input?.slide || {
            id: _uid(), label: '', background: '#fafcff', layout: 'column', children: [],
        };
        if (!newSlide.id) newSlide.id = _uid();
        _ensureBlockIds(newSlide.children);
        _ensureBlockIds(newSlide.items);
        _ensureBlockIds(newSlide.elements);
        const afterIndex = options.input?.afterIndex;
        const insertAt = (afterIndex != null) ? Math.min(afterIndex, deck.slides.length) : deck.slides.length;
        deck.slides.splice(insertAt, 0, newSlide);
        await p.applyDeck(deck, docUri);
        return _slideResult(`Inserted slide at position ${insertAt + 1} (id=${newSlide.id}).`);
    }
}

class WolfslideEditSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Editing slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const patch = options.input?.patch || options.input?.updates;
        if (!patch || typeof patch !== 'object') return _slideResult('"patch" (or "updates") object is required.');
        Object.assign(r.slide, patch);
        _ensureBlockIds(r.slide.children);
        _ensureBlockIds(r.slide.items);
        _ensureBlockIds(r.slide.elements);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Slide ${r.idx + 1} (id=${r.slide.id}) updated.`);
    }
}

class WolfslideDeleteSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Deleting slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        if (r.deck.slides.length <= 1) return _slideResult('Cannot delete the last slide.');
        const [removed] = r.deck.slides.splice(r.idx, 1);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Deleted slide ${r.idx + 1} (id=${removed.id}).`);
    }
}

class WolfslideMoveSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Moving slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''} → position ${options.input?.toIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const to = (options.input?.toIndex || 1) - 1;
        const n = r.deck.slides.length;
        if (to < 0 || to >= n) return _slideResult(`toIndex ${to + 1} out of range (deck has ${n} slides).`);
        if (r.idx === to) return _slideResult(`Slide "${r.slide.id}" is already at position ${to + 1}, no change made.`);
        const [slide] = r.deck.slides.splice(r.idx, 1);
        r.deck.slides.splice(to, 0, slide);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Moved slide "${slide.id}" from position ${r.idx + 1} to ${to + 1}.`);
    }
}

class WolfslideUndoTool {
    prepareInvocation() { return { invocationMessage: 'Undoing last change in slide editor' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const entry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
        if (!entry) return _slideResult('No active .wslide editor.');
        entry.webviewPanel.webview.postMessage({ cmd: 'undo' });
        return _slideResult('Undo triggered.');
    }
}

class WolfslideSaveFileTool {
    prepareInvocation() { return { invocationMessage: 'Saving .wslide file' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const entry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
        if (!entry) return _slideResult('No active .wslide editor.');
        await entry.document.save();
        return _slideResult('Saved.');
    }
}

class WolfslideDuplicateSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Duplicating slide ${options.input?.slideId ?? options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const clone = JSON.parse(JSON.stringify(r.slide));
        function reassignIds(b) {
            b.id = _uid();
            (b.children || b.items || b.elements || []).forEach(reassignIds);
        }
        clone.id = _uid();
        (clone.children || clone.elements || []).forEach(reassignIds);
        r.deck.slides.splice(r.idx + 1, 0, clone);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Duplicated slide ${r.idx + 1} → inserted at position ${r.idx + 2} (id=${clone.id}).`);
    }
}

class WolfslideSearchSlidesTool {
    prepareInvocation(options) {
        return { invocationMessage: `Searching slides for "${options.input?.query ?? ''}"` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const deck = p.getDeck(options.input?.docUri);
        if (!deck) return _slideResult('No deck found.');
        const query = (options.input?.query || '').toLowerCase().trim();
        const blockTypeFilter = (options.input?.blockType || '').toLowerCase().trim();
        const styleKey   = (options.input?.styleKey   || '').trim();
        const styleValue = (options.input?.styleValue || '').toLowerCase().trim();
        if (!query && !blockTypeFilter && !styleKey)
            return _slideResult('Provide at least one of: query, blockType, or styleKey.');
        const results = [];
        (deck.slides || []).forEach((s, i) => {
            const allBlocks = _collectAllBlocks(s);
            const matches = [];
            allBlocks.forEach(b => {
                // Type filter
                if (blockTypeFilter && (b.type || '').toLowerCase() !== blockTypeFilter) return;
                // Style key/value filter
                if (styleKey) {
                    const styleObj = b.style || {};
                    const val = (styleObj[styleKey] || '').toString().toLowerCase();
                    if (!val) return;
                    if (styleValue && !val.includes(styleValue)) return;
                }
                // Text content filter
                if (query) {
                    const haystack = [
                        _stripHtml(b.content || ''),
                        b.alt || '', b.src || '', b.label || '',
                        ...(b.items || []).map(it => _stripHtml(it.content || '')),
                    ].join(' ').toLowerCase();
                    if (!haystack.includes(query)) return;
                }
                const preview = _stripHtml(b.content || b.alt || (b.items?.[0]?.content) || '').slice(0, 70);
                const styleHint = styleKey ? `  ${styleKey}=${b.style?.[styleKey]}` : '';
                matches.push(`    block id=${b.id} type=${b.type}${styleHint}: "${preview}"`);
            });
            if (matches.length) {
                results.push(`[${i + 1}] id=${s.id} label="${s.label || ''}":\n${matches.join('\n')}`);
            }
        });
        const desc = [query && `text:"${query}"`, blockTypeFilter && `type:${blockTypeFilter}`, styleKey && `style.${styleKey}${styleValue ? '='+styleValue : ''}`].filter(Boolean).join(', ');
        if (!results.length) return _slideResult(`No matches for [${desc}] across ${deck.slides.length} slide(s).`);
        return _slideResult(`Matches for [${desc}] in ${results.length} slide(s):\n${results.join('\n')}`);
    }
}

// ── Block-level editing tools ─────────────────────────────────────────────

class WolfslideEditBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Editing block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).map(b => b.id);
            return _slideResult(`Block "${blockId}" not found on slide ${r.idx + 1}. Valid ids: ${allIds.join(', ')}`);
        }
        const updates = options.input?.updates || options.input?.patch;
        if (!updates || typeof updates !== 'object') return _slideResult('updates (or patch) object is required.');
        _deepMerge(found.block, updates);
        _ensureBlockIds(found.block.children);
        _ensureBlockIds(found.block.items);
        _ensureBlockIds(found.block.elements);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Block ${blockId} updated on slide ${r.idx + 1}. Keys changed: ${Object.keys(updates).join(', ')}`);
    }
}

class WolfslideInsertBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Inserting block on slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const block = options.input?.block;
        if (!block || typeof block !== 'object') return _slideResult('block object is required.');
        if (!block.id) block.id = _uid();
        // Assign ids to any children that lack them
        function ensureIds(b) {
            if (!b.id) b.id = _uid();
            (b.children || b.items || b.elements || []).forEach(ensureIds);
        }
        ensureIds(block);
        const parentId = options.input?.parentBlockId || null;
        const position = options.input?.position;
        let arr;
        if (parentId) {
            const found = _findBlockRecursive(parentId, r.slide);
            if (!found) return _slideResult(`Parent block "${parentId}" not found.`);
            const parent = found.block;
            if (!parent.children) parent.children = [];
            arr = parent.children;
        } else {
            if (!r.slide.children) r.slide.children = [];
            arr = r.slide.children;
        }
        const pos = (position != null && position >= 0) ? Math.min(position, arr.length) : arr.length;
        arr.splice(pos, 0, block);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Inserted block id=${block.id} type=${block.type || '?'} at position ${pos} on slide ${r.idx + 1}.`);
    }
}

class WolfslideDeleteBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Deleting block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).map(b => b.id);
            return _slideResult(`Block "${blockId}" not found on slide ${r.idx + 1}. Valid ids: ${allIds.join(', ')}`);
        }
        found.parent[found.key].splice(found.index, 1);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Deleted block ${blockId} (type=${found.block.type}) from slide ${r.idx + 1}.`);
    }
}

class WolfslideMoveBlockTool {
    prepareInvocation(options) {
        return { invocationMessage: `Moving block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).map(b => b.id);
            return _slideResult(`Block "${blockId}" not found on slide ${r.idx + 1}. Valid ids: ${allIds.join(', ')}`);
        }
        // Remove from old location
        const [block] = found.parent[found.key].splice(found.index, 1);
        // Insert at new location
        const newParentId = options.input?.newParentId || null;
        const newPosition = options.input?.newPosition;
        let arr;
        if (newParentId) {
            const dest = _findBlockRecursive(newParentId, r.slide);
            if (!dest) return _slideResult(`Destination parent "${newParentId}" not found.`);
            if (!dest.block.children) dest.block.children = [];
            arr = dest.block.children;
        } else {
            if (!r.slide.children) r.slide.children = [];
            arr = r.slide.children;
        }
        const pos = (newPosition != null && newPosition >= 0) ? Math.min(newPosition, arr.length) : arr.length;
        arr.splice(pos, 0, block);
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Moved block ${blockId} to ${newParentId ? 'parent ' + newParentId : 'top-level'} position ${pos} on slide ${r.idx + 1}.`);
    }
}

// ── Deck diagnostics ──────────────────────────────────────────────────────

class WolfslideCheckDeckTool {
    prepareInvocation() { return { invocationMessage: 'Checking deck for issues' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const deck = p.getDeck(options.input?.docUri);
        if (!deck) return _slideResult('No deck found.');
        const issues = [];
        let totalBlocks = 0, totalImages = 0, imagesWithoutAlt = 0, maxBlocks = 0;
        const labelMap = {};
        (deck.slides || []).forEach((s, i) => {
            const sn = i + 1;
            const allBlocks = _collectAllBlocks(s);
            const topBlocks = s.children || s.elements || [];
            totalBlocks += allBlocks.length;
            // Empty slide
            if (topBlocks.length === 0) {
                issues.push({ slide: sn, issue: 'empty_slide', detail: 'no children' });
            }
            // High block count
            if (topBlocks.length > 10) {
                issues.push({ slide: sn, issue: 'high_block_count', count: topBlocks.length, detail: `${topBlocks.length} top-level blocks — likely too dense` });
            }
            if (allBlocks.length > maxBlocks) maxBlocks = allBlocks.length;
            // Images without alt
            allBlocks.forEach(b => {
                if (b.type === 'image') {
                    totalImages++;
                    if (!b.alt) {
                        imagesWithoutAlt++;
                        issues.push({ slide: sn, blockId: b.id, issue: 'no_alt_text', src: (b.src || '').split('/').pop() });
                    }
                }
                // Large negative offset
                if (b.offset && (b.offset.dy < -200 || b.offset.dx < -200)) {
                    issues.push({ slide: sn, blockId: b.id, issue: 'large_negative_offset', dx: b.offset.dx, dy: b.offset.dy, detail: 'large negative offset often means fighting the layout' });
                }
            });
            // Fragment gaps
            const steps = allBlocks.filter(b => b.fragmentOrder != null && b.fragmentOrder >= 1).map(b => b.fragmentOrder).sort((a, b) => a - b);
            if (steps.length > 0) {
                const maxStep = steps[steps.length - 1];
                const missing = [];
                for (let st = 1; st <= maxStep; st++) {
                    if (!steps.includes(st)) missing.push(st);
                }
                if (missing.length) {
                    issues.push({ slide: sn, issue: 'fragment_gap', present: steps, detail: `steps ${missing.join(', ')} missing` });
                }
            }
            // Duplicate labels
            const label = (s.label || '').trim();
            if (label) {
                if (!labelMap[label]) labelMap[label] = [];
                labelMap[label].push(sn);
            }
        });
        // Report duplicate labels
        for (const [label, slides] of Object.entries(labelMap)) {
            if (slides.length > 1) {
                issues.push({ issue: 'duplicate_label', label, slides });
            }
        }
        const slideCount = deck.slides?.length || 0;
        const hiddenCount = (deck.slides || []).filter(s => s.hidden).length;
        const stats = {
            totalBlocks, totalImages, imagesWithoutAlt, maxBlocksPerSlide: maxBlocks,
            avgBlocksPerSlide: slideCount ? +(totalBlocks / slideCount).toFixed(1) : 0,
        };
        const output = { slideCount, hiddenCount, issues, stats };
        return _slideResult(JSON.stringify(output, null, 2));
    }
}

// ── Fragment reordering ───────────────────────────────────────────────────

class WolfslideReorderFragmentsTool {
    prepareInvocation(options) {
        return { invocationMessage: `Reordering fragments on slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const order = options.input?.order;
        if (!Array.isArray(order) || !order.length) return _slideResult('order array is required.');
        // Clear all fragmentOrder on this slide first
        const allBlocks = _collectAllBlocks(r.slide);
        allBlocks.forEach(b => { b.fragmentOrder = null; });
        // Apply new order
        const applied = [];
        order.forEach((entry, i) => {
            const blockId = typeof entry === 'string' ? entry : entry.blockId;
            const step    = typeof entry === 'string' ? i + 1 : (entry.step ?? i + 1);
            const found = _findBlockRecursive(blockId, r.slide);
            if (found) {
                found.block.fragmentOrder = step;
                applied.push(`${blockId}→step${step}`);
            }
        });
        await r.p.applyDeck(r.deck, r.docUri);
        return _slideResult(`Reordered fragments on slide ${r.idx + 1}: ${applied.join(', ')}. All other blocks set to always-visible.`);
    }
}

// ── Layout measurement ────────────────────────────────────────────────────

class WolfslideMeasureSlideTool {
    prepareInvocation(options) {
        return { invocationMessage: `Measuring slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        try {
            const result = await r.p.measureSlide(r.idx, r.docUri);
            // Enrich with block type info from data
            const allBlocks = _collectAllBlocks(r.slide);
            const blockMap = {};
            allBlocks.forEach(b => { blockMap[b.id] = b; });
            const enriched = {};
            for (const [id, meas] of Object.entries(result.blocks || {})) {
                const b = blockMap[id];
                enriched[id] = {
                    type: b?.type || '?',
                    name: b?.name || undefined,
                    requestedSize: { w: b?.w || null, h: b?.h || null },
                    ...meas,
                };
            }
            // Detect issues
            const issues = [];
            for (const [id, m] of Object.entries(enriched)) {
                if (m.overflow?.clippedBottom || m.overflow?.clippedRight) {
                    issues.push({ blockId: id, issue: 'content_overflow', detail: `rendered extends beyond canvas` });
                }
                if (m.requestedSize.h && m.renderedSize.h > m.requestedSize.h + 5) {
                    issues.push({ blockId: id, issue: 'content_overflow', detail: `rendered height ${m.renderedSize.h}px exceeds allocated ${m.requestedSize.h}px` });
                }
                if (m.type === 'image' && blockMap[id] && !blockMap[id].alt) {
                    issues.push({ blockId: id, issue: 'no_alt_text' });
                }
            }
            const output = {
                slideIndex: r.idx + 1,
                canvasSize: { w: 1920, h: 1080 },
                blocks: enriched,
                issues,
                remainingVerticalSpace: result.remainingVerticalSpace,
            };
            return _slideResult(JSON.stringify(output, null, 2));
        } catch (e) {
            return _slideResult(`Measurement failed: ${e.message}`);
        }
    }
}

// ── Single-slide HTML preview ─────────────────────────────────────────────

class WolfslideGetSlideHtmlTool {
    prepareInvocation(options) {
        const n = options.input?.slideIndex ?? options.input?.slideNumber ?? '?';
        return { invocationMessage: `Rendering slide ${n} to HTML` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        try {
            const exporter = require('../slideExporter');
            const section  = exporter.slideToHTML(r.slide);
            const t = r.deck.theme || {};
            const navy   = t.navy   || '#0a244a';
            const blue   = t.blue   || '#0064b4';
            const cyan   = t.cyan   || '#009ac8';
            const accent = t.accent || '#be1e2d';
            const userCSS = t.editorCSS ? `<style>\n${t.editorCSS}\n</style>` : '';
            const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
                `<title>Slide ${r.idx + 1} — ${(r.slide.label || '').replace(/</g,'&lt;')}</title>\n` +
                `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">\n` +
                `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/white.css">\n` +
                `<style>\n:root{--navy:${navy};--blue:${blue};--cyan:${cyan};--accent:${accent};}\n` +
                `html,body{margin:0;padding:0;background:#000;}\n` +
                `.reveal,.reveal *:not(.katex):not(.katex *){font-family:'Helvetica Neue',Helvetica,Arial,sans-serif!important;box-sizing:border-box;}\n` +
                `.reveal{font-size:36px;color:var(--navy);background:#000!important;}\n` +
                `.reveal-viewport{background:#000!important;}\n` +
                `.reveal .slides section{padding:0!important;margin:0!important;top:0!important;text-align:left;overflow:hidden;width:1920px;height:1080px;}\n` +
                `.reveal .slides section h1,.reveal .slides section h2,.reveal .slides section h3{text-transform:none!important;font-weight:700;margin:0;padding:0;}\n` +
                `.reveal .slides section h2{background:var(--navy);color:#fff;padding:14px 36px;font-size:1.1em;width:100%;}\n` +
                `.reveal .slides section img{border:none!important;box-shadow:none!important;}\n` +
                `.wslide-canvas{position:relative;width:1920px;height:1080px;}\n.wel{position:absolute;box-sizing:border-box;}\n</style>\n` +
                `${userCSS}\n</head>\n<body>\n` +
                `<div class="reveal"><div class="slides">\n${section}\n</div></div>\n` +
                `<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>\n` +
                `<script>Reveal.initialize({hash:false,width:1920,height:1080,margin:0.04,minScale:0.1,maxScale:2,transition:'none',center:false,controls:false,progress:false});</script>\n` +
                `</body>\n</html>`;

            const outputPath = options.input?.outputPath;
            if (outputPath) {
                require('fs').writeFileSync(outputPath, html, 'utf8');
                return _slideResult(`Slide ${r.idx + 1} HTML written to ${outputPath} (${html.length} bytes).`);
            }
            return _slideResult(
                `Slide ${r.idx + 1} "${r.slide.label || ''}" HTML (${html.length} bytes):\n\n` +
                `\`\`\`html\n${html}\n\`\`\``
            );
        } catch (e) {
            return _slideResult(`HTML render failed: ${e.message}`);
        }
    }
}

// ── Image dimension helper ────────────────────────────────────────────────

class WolfslideGetImageDimensionsTool {
    prepareInvocation(options) {
        return { invocationMessage: `Reading image dimensions: ${options.input?.src || ''}` };
    }
    async invoke(options, _token) {
        const src = options.input?.src || '';
        if (!src) return _slideResult('Error: "src" is required (local path or http/https URL).');
        try {
            let buf;
            if (/^https?:\/\//i.test(src)) {
                buf = await _fetchImageHeader(src);
            } else {
                // Local path — resolve relative to the active deck if not absolute
                let filePath = src;
                if (!path.isAbsolute(filePath)) {
                    const p2 = _getSlideProvider();
                    const entry = p2 ? p2.getActiveEntry() : null;
                    if (entry) filePath = path.resolve(path.dirname(entry.document.uri.fsPath), filePath);
                }
                const full = require('fs').readFileSync(filePath);
                buf = Buffer.from(full.slice(0, 64));
            }
            const dims = _parseImageHeader(buf);
            if (!dims) return _slideResult(`Could not determine dimensions for "${src}". Format may be unsupported (supports PNG, JPEG, WebP).`);
            return _slideResult(JSON.stringify({ src, width: dims.w, height: dims.h, format: dims.fmt }));
        } catch (e) {
            return _slideResult(`Error reading image "${src}": ${e.message}`);
        }
    }
}

function _fetchImageHeader(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        const req = mod.get(url, { headers: { 'Range': 'bytes=0-511', 'User-Agent': 'WolfslideAgent/1.0' } }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout reading image header')); });
    });
}

function _parseImageHeader(buf) {
    if (!buf || buf.length < 8) return null;
    // PNG: magic \x89PNG\r\n\x1a\n, width at bytes 16-19, height at 20-23
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        if (buf.length < 24) return null;
        return { fmt: 'PNG', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG: SOI = FF D8, then scan for SOF0/SOF1/SOF2 (FF C0/C1/C2)
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
        let i = 2;
        while (i + 8 < buf.length) {
            if (buf[i] !== 0xFF) break;
            const marker = buf[i + 1];
            const len = buf.readUInt16BE(i + 2);
            if (marker >= 0xC0 && marker <= 0xC3) {
                // height at i+5, width at i+7
                const h = buf.readUInt16BE(i + 5);
                const w = buf.readUInt16BE(i + 7);
                return { fmt: 'JPEG', w, h };
            }
            i += 2 + len;
        }
        return { fmt: 'JPEG', w: null, h: null }; // SOF not in first 512 bytes
    }
    // WebP: RIFF????WEBP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        const tag = buf.slice(12, 16).toString('ascii');
        if (tag === 'VP8 ' && buf.length >= 30) {
            const w = (buf.readUInt16LE(26) & 0x3FFF) + 1;
            const h = (buf.readUInt16LE(28) & 0x3FFF) + 1;
            return { fmt: 'WebP', w, h };
        }
        if (tag === 'VP8L' && buf.length >= 30) {
            const bits = buf.readUInt32LE(25);
            const w = (bits & 0x3FFF) + 1;
            const h = ((bits >> 14) & 0x3FFF) + 1;
            return { fmt: 'WebP', w, h };
        }
        if (tag === 'VP8X' && buf.length >= 30) {
            const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
            const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
            return { fmt: 'WebP', w, h };
        }
        return { fmt: 'WebP', w: null, h: null };
    }
    return null;
}

class WolfslideExportHtmlTool {
    prepareInvocation() { return { invocationMessage: 'Exporting slides to HTML' }; }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        try {
            const exporter = require('../slideExporter');
            const html = exporter.exportDeck(deck);
            const destPath = options.input?.outputPath;
            if (destPath) {
                require('fs').writeFileSync(destPath, html, 'utf8');
                return _slideResult(`Exported ${html.length} bytes to ${destPath}.`);
            }
            // No path provided: show save dialog
            const entry = docUri ? p._panels?.get(docUri) : p.getActiveEntry();
            const deckName = entry
                ? require('path').basename(entry.document.uri.fsPath, '.wslide')
                : 'presentation';
            const defaultUri = entry
                ? vscode.Uri.file(
                    require('path').join(
                        require('path').dirname(entry.document.uri.fsPath),
                        deckName + '.html'
                    ))
                : undefined;
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'HTML Presentation': ['html'] },
                title: 'Export Slides as Standalone HTML',
            });
            if (!saveUri) return _slideResult('Export cancelled.');
            require('fs').writeFileSync(saveUri.fsPath, html, 'utf8');
            return _slideResult(`Exported to ${saveUri.fsPath}.`);
        } catch (e) {
            return _slideResult(`Export failed: ${e.message}`);
        }
    }
}

// ── Theme tool ────────────────────────────────────────────────────────────

class WolfslideSetThemeTool {
    prepareInvocation(options) {
        return { invocationMessage: `Setting theme ${options.input?.preset || '(custom)'}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');

        if (!deck.theme) deck.theme = {};
        const presetName = options.input?.preset;

        // Warn about unknown parameters (e.g. "overrides" — a common mistake; the correct key is "theme")
        const knownKeys = new Set(['preset', 'theme', 'docUri', 'applyBackground', 'defaultBackground']);
        const unknownKeys = Object.keys(options.input || {}).filter(k => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
            return _slideResult(
                `⚠ wolfslide_setTheme: unknown parameter(s) "${unknownKeys.join('", "')}" — IGNORED.\n` +
                `Valid parameters: preset (string), theme (object with navy/blue/cyan/accent/editorCSS), defaultBackground, applyBackground, docUri.\n` +
                `Common mistake: "overrides" is not valid — use "theme": { navy:"#...", editorCSS:"..." } instead.`
            );
        }

        if (presetName) {
            const preset = THEME_PRESETS[presetName];
            if (!preset) {
                const available = Object.keys(THEME_PRESETS).join(', ');
                return _slideResult(`Unknown preset "${presetName}". Available: ${available}`);
            }
            // Apply preset theme
            Object.assign(deck.theme, preset.theme);
            // Optionally update all slide backgrounds if requested or if they are default
            if (options.input?.applyBackground !== false) {
                for (const s of deck.slides) {
                    if (!s.background || s.background === '#fafcff' || s.background === '#0d1117'
                        || s.background === '#0a1628' || s.background === '#002b36'
                        || s.background === '#000000' || s.background === '#fdf6e3') {
                        s.background = preset.defaultBackground;
                    }
                }
            }
            await p.applyDeck(deck, docUri);
            return _slideResult(`Applied theme preset "${presetName}" (${preset.label}). Default background: ${preset.defaultBackground}. Colors: navy=${preset.theme.navy} blue=${preset.theme.blue} cyan=${preset.theme.cyan} accent=${preset.theme.accent}.`);
        }

        // Custom theme properties
        const custom = options.input?.theme;
        if (custom && typeof custom === 'object') {
            Object.assign(deck.theme, custom);
            // Update slide backgrounds if provided
            if (options.input?.defaultBackground) {
                for (const s of deck.slides) {
                    if (!s.background || s.background === '#fafcff') {
                        s.background = options.input.defaultBackground;
                    }
                }
            }
            await p.applyDeck(deck, docUri);
            return _slideResult(`Theme updated with custom properties: ${Object.keys(custom).join(', ')}.`);
        }

        return _slideResult('Provide either "preset" (string) or "theme" (object) to set the theme.');
    }
}

// ── Image asset management tool ───────────────────────────────────────────

/**
 * wolfslide_imageAsset — full image asset lifecycle management for .wslide decks.
 *
 * Actions:
 *   list    — list all images in the deck's img/ folder, with usage info
 *   info    — get details for one image (size, used-on slides, annotation)
 *   copy    — copy an external file into the deck's img/ folder
 *   delete  — remove an image file (warns if still referenced)
 *   rename  — rename an image file and update all slide references
 *   annotate — write/update the annotation JSON for an image
 *   insert  — copy an image + immediately add an image block to a slide
 *
 * Annotation sidecar: <imgDir>/<filename>.ann.json
 * Format: { description, source, tags[] }
 */
class WolfslideImageAssetTool {
    prepareInvocation(options) {
        return { invocationMessage: `Image assets: ${options.input?.action || 'list'}` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const entry = p.getActiveEntry();
        if (!entry) return _slideResult('No active .wslide editor found.');
        const document = entry.document;
        const deckDir  = path.dirname(document.uri.fsPath);
        const deckName = path.basename(document.uri.fsPath, '.wslide');
        const imgDir   = path.join(deckDir, 'img', deckName + '.wslide');
        const docUri   = options.input?.docUri;
        const action   = (options.input?.action || 'list').toLowerCase();

        // ── Helper: collect all relative src values from the live deck ───
        function usedSrcs(deck) {
            const usedFiles = new Set();
            const prefix = `img/${deckName}.wslide/`;
            function walk(b) {
                if (!b) return;
                if (typeof b.src === 'string' && b.src.startsWith(prefix))
                    usedFiles.add(b.src.slice(prefix.length));
                (b.children || b.items || b.elements || []).forEach(walk);
            }
            (deck.slides || []).forEach(s => (s.children || s.elements || []).forEach(walk));
            return usedFiles;
        }

        // ── Helper: map filename → slide labels where it is referenced ───
        function usageMap(deck) {
            const map = {};            // filename → [slide label, ...]
            const prefix = `img/${deckName}.wslide/`;
            function walk(b, slideLabel) {
                if (!b) return;
                if (typeof b.src === 'string' && b.src.startsWith(prefix)) {
                    const fname = b.src.slice(prefix.length);
                    (map[fname] = map[fname] || []).push(slideLabel);
                }
                (b.children || b.items || b.elements || []).forEach(c => walk(c, slideLabel));
            }
            (deck.slides || []).forEach((s, i) => {
                const label = s.label || `Slide ${i + 1}`;
                (s.children || s.elements || []).forEach(b => walk(b, label));
            });
            return map;
        }

        // ── Helper: read annotation sidecar ──────────────────────────────
        function readAnn(filename) {
            const annPath = path.join(imgDir, filename + '.ann.json');
            if (!fs.existsSync(annPath)) return null;
            try { return JSON.parse(fs.readFileSync(annPath, 'utf8')); } catch (_) { return null; }
        }

        // ── Helper: write annotation sidecar ─────────────────────────────
        function writeAnn(filename, ann) {
            fs.mkdirSync(imgDir, { recursive: true });
            const annPath = path.join(imgDir, filename + '.ann.json');
            fs.writeFileSync(annPath, JSON.stringify(ann, null, 2), 'utf8');
        }

        // ── Helper: image dimensions (PNG/JPEG/SVG heuristic) ────────────
        function imageDimensions(fpath) {
            try {
                const buf = fs.readFileSync(fpath);
                const ext = path.extname(fpath).toLowerCase();
                if (ext === '.png') {
                    if (buf.length < 24) return null;
                    const w = buf.readUInt32BE(16);
                    const h = buf.readUInt32BE(20);
                    return { w, h };
                }
                if (ext === '.jpg' || ext === '.jpeg') {
                    // Scan for SOF marker
                    let i = 0;
                    while (i < buf.length - 8) {
                        if (buf[i] !== 0xFF) break;
                        const marker = buf[i + 1];
                        if (marker >= 0xC0 && marker <= 0xC3) {
                            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
                        }
                        const segLen = buf.readUInt16BE(i + 2);
                        i += 2 + segLen;
                    }
                    return null;
                }
                if (ext === '.svg') {
                    const text = buf.toString('utf8', 0, Math.min(buf.length, 2000));
                    const wm = text.match(/width=["']?([\d.]+)/);
                    const hm = text.match(/height=["']?([\d.]+)/);
                    if (wm && hm) return { w: parseFloat(wm[1]), h: parseFloat(hm[1]) };
                    const vbm = text.match(/viewBox=["']?([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
                    if (vbm) return { w: parseFloat(vbm[3]), h: parseFloat(vbm[4]) };
                    return null;
                }
            } catch (_) {}
            return null;
        }

        // ── Helper: file size as human-readable string ────────────────────
        function humanSize(bytes) {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1048576).toFixed(2)} MB`;
        }

        // ═══════════════════════════════════════════════════════════════════
        // LIST
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'list') {
            const deck = p.getDeck(docUri);
            if (!deck) return _slideResult('No deck found.');
            if (!fs.existsSync(imgDir)) {
                return _slideResult(
                    `Image folder: img/${deckName}.wslide/\n` +
                    'No images in this deck yet.\n\n' +
                    'To add an image:\n' +
                    `  wolfslide_imageAsset({ action:"copy", srcPath:"/abs/path/to/file.png" })\n` +
                    `  wolfslide_imageAsset({ action:"insert", srcPath:"/abs/path/to/file.png", slideIndex:1, annotation:"..." })`
                );
            }
            const allFiles = fs.readdirSync(imgDir)
                .filter(f => !f.endsWith('.ann.json') && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f));
            if (!allFiles.length) {
                return _slideResult(`Image folder img/${deckName}.wslide/ exists but contains no image files.`);
            }
            const usage = usageMap(deck);
            const lines = [
                `Image folder: img/${deckName}.wslide/  (${allFiles.length} image${allFiles.length !== 1 ? 's' : ''})`,
                '',
                'Filename'.padEnd(40) + 'Size'.padEnd(12) + 'Dimensions'.padEnd(16) + 'Used on',
                '─'.repeat(90),
            ];
            for (const f of allFiles.sort()) {
                const fpath = path.join(imgDir, f);
                const stat = fs.statSync(fpath);
                const dims = imageDimensions(fpath);
                const dimStr = dims ? `${dims.w}×${dims.h}` : '—';
                const slides = usage[f];
                const usedOn = slides ? slides.join(', ') : '⚠ UNUSED';
                const ann = readAnn(f);
                const annNote = ann?.description ? `  [📝 ${ann.description.slice(0, 60)}]` : '';
                lines.push(
                    f.slice(0, 38).padEnd(40) +
                    humanSize(stat.size).padEnd(12) +
                    dimStr.padEnd(16) +
                    usedOn + annNote
                );
            }
            lines.push('');
            lines.push('UNUSED images are not referenced by any block. Remove with action:"delete".');
            lines.push('Image src path format for blocks: "img/' + deckName + '.wslide/<filename>"');
            return _slideResult(lines.join('\n'));
        }

        // ═══════════════════════════════════════════════════════════════════
        // INFO
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'info') {
            const filename = options.input?.filename;
            if (!filename) return _slideResult('Provide "filename" for action:"info".');
            const fpath = path.join(imgDir, filename);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);
            const stat = fs.statSync(fpath);
            const dims = imageDimensions(fpath);
            const deck = p.getDeck(docUri);
            const usage = usageMap(deck || { slides: [] });
            const usedSlides = usage[filename] || [];
            const ann = readAnn(filename);
            const lines = [
                `## Image: ${filename}`,
                `Path on disk:  img/${deckName}.wslide/${filename}`,
                `Block src:     "img/${deckName}.wslide/${filename}"`,
                `Size:          ${humanSize(stat.size)}`,
                `Modified:      ${new Date(stat.mtime).toISOString().slice(0, 16).replace('T', ' ')}`,
                `Dimensions:    ${dims ? `${dims.w} × ${dims.h} px` : 'unknown (unsupported format)'}`,
                `Used on slides: ${usedSlides.length ? usedSlides.join(', ') : '⚠ NOT USED in any block'}`,
                '',
            ];
            if (ann) {
                lines.push('## Annotation');
                if (ann.description) lines.push(`Description: ${ann.description}`);
                if (ann.source)      lines.push(`Source:      ${ann.source}`);
                if (ann.tags?.length) lines.push(`Tags:        ${ann.tags.join(', ')}`);
            } else {
                lines.push('No annotation yet. Add one with action:"annotate".');
            }
            lines.push('');
            lines.push('Rendered block snippet (copy and paste into slide children):');
            const blockW = dims ? Math.min(dims.w, 1600) : 900;
            const blockH = dims ? Math.min(dims.h, 900) : 600;
            lines.push(JSON.stringify({
                type: 'image',
                src: `img/${deckName}.wslide/${filename}`,
                w: blockW, h: blockH,
                fit: 'contain',
                alt: ann?.description || filename,
            }, null, 2));
            return _slideResult(lines.join('\n'));
        }

        // ═══════════════════════════════════════════════════════════════════
        // COPY — import an external file into the deck's img/ folder
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'copy') {
            const srcPath = options.input?.srcPath;
            if (!srcPath) return _slideResult('Provide "srcPath" (absolute path to source image) for action:"copy".');
            if (!fs.existsSync(srcPath)) return _slideResult(`Source file not found: ${srcPath}`);
            fs.mkdirSync(imgDir, { recursive: true });
            let fname = options.input?.filename || path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
            // Avoid collisions
            if (fs.existsSync(path.join(imgDir, fname))) {
                const ext  = path.extname(fname);
                const base = path.basename(fname, ext);
                fname = base + '_' + Date.now() + ext;
            }
            fs.copyFileSync(srcPath, path.join(imgDir, fname));
            const stat = fs.statSync(path.join(imgDir, fname));
            const dims = imageDimensions(path.join(imgDir, fname));

            // Auto-annotate if annotation provided
            const annotation = options.input?.annotation;
            if (annotation) {
                const ann = typeof annotation === 'string'
                    ? { description: annotation, source: srcPath, tags: [] }
                    : { source: srcPath, ...annotation };
                writeAnn(fname, ann);
            }

            const lines = [
                `✅ Copied: ${path.basename(srcPath)} → img/${deckName}.wslide/${fname}`,
                `   Size: ${humanSize(stat.size)}`,
                dims ? `   Dimensions: ${dims.w} × ${dims.h} px` : '',
                '',
                'Block src value to use in slides:',
                `  "src": "img/${deckName}.wslide/${fname}"`,
                '',
                'Ready-to-use image block:',
                JSON.stringify({
                    type: 'image',
                    src: `img/${deckName}.wslide/${fname}`,
                    w: dims ? Math.min(dims.w, 1600) : 900,
                    h: dims ? Math.min(dims.h, 900) : 600,
                    fit: 'contain',
                    alt: annotation && typeof annotation === 'string' ? annotation : (dims ? `${dims.w}×${dims.h} image` : fname),
                }, null, 2),
                '',
                annotation ? `Annotation saved.` : `Tip: add a description with action:"annotate", filename:"${fname}", description:"..."`,
            ].filter(l => l !== '');
            return _slideResult(lines.join('\n'));
        }

        // ═══════════════════════════════════════════════════════════════════
        // DELETE — remove an image file (warns if still referenced)
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'delete') {
            const filename = options.input?.filename;
            if (!filename) return _slideResult('Provide "filename" for action:"delete".');
            const fpath = path.join(imgDir, filename);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);

            const deck = p.getDeck(docUri);
            const usage = usageMap(deck || { slides: [] });
            const usedSlides = usage[filename] || [];
            if (usedSlides.length && !options.input?.force) {
                return _slideResult(
                    `⚠ img/${deckName}.wslide/${filename} is still referenced by: ${usedSlides.join(', ')}.\n` +
                    `Remove the image block(s) from those slides first, or pass force:true to delete anyway.`
                );
            }
            fs.unlinkSync(fpath);
            // Remove annotation sidecar if present
            const annPath = path.join(imgDir, filename + '.ann.json');
            if (fs.existsSync(annPath)) fs.unlinkSync(annPath);
            const warn = usedSlides.length ? `\n⚠ Blocks on [${usedSlides.join(', ')}] now have broken image references — update them.` : '';
            return _slideResult(`🗑  Deleted img/${deckName}.wslide/${filename}${warn}`);
        }

        // ═══════════════════════════════════════════════════════════════════
        // RENAME — rename file and update all block src references in deck
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'rename') {
            const filename  = options.input?.filename;
            const newName   = options.input?.newName;
            if (!filename || !newName) return _slideResult('Provide "filename" and "newName" for action:"rename".');
            const oldPath = path.join(imgDir, filename);
            const newPath = path.join(imgDir, newName);
            if (!fs.existsSync(oldPath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);
            if (fs.existsSync(newPath)) return _slideResult(`Target already exists: img/${deckName}.wslide/${newName}`);

            fs.renameSync(oldPath, newPath);
            // Rename annotation sidecar
            const oldAnn = path.join(imgDir, filename + '.ann.json');
            if (fs.existsSync(oldAnn)) fs.renameSync(oldAnn, path.join(imgDir, newName + '.ann.json'));

            // Update all src references in the deck
            const oldSrc = `img/${deckName}.wslide/${filename}`;
            const newSrc = `img/${deckName}.wslide/${newName}`;
            const deck = p.getDeck(docUri);
            let updateCount = 0;
            function patchSrcs(b) {
                if (!b) return;
                if (b.src === oldSrc) { b.src = newSrc; updateCount++; }
                (b.children || b.items || b.elements || []).forEach(patchSrcs);
            }
            (deck.slides || []).forEach(s => (s.children || s.elements || []).forEach(patchSrcs));
            if (updateCount > 0) {
                await p.applyDeck(deck, docUri);
            }
            return _slideResult(
                `✅ Renamed: ${filename} → ${newName}\n` +
                (updateCount > 0 ? `   Updated ${updateCount} block src reference(s) in the deck.` : '   No block references found (file was unused).')
            );
        }

        // ═══════════════════════════════════════════════════════════════════
        // ANNOTATE — write/update annotation sidecar JSON
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'annotate') {
            const filename = options.input?.filename;
            if (!filename) return _slideResult('Provide "filename" for action:"annotate".');
            const fpath = path.join(imgDir, filename);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${filename}`);

            const existing = readAnn(filename) || {};
            if (options.input?.description !== undefined) existing.description = options.input.description;
            if (options.input?.source      !== undefined) existing.source      = options.input.source;
            if (options.input?.tags        !== undefined) existing.tags        = options.input.tags;
            writeAnn(filename, existing);
            return _slideResult(
                `✅ Annotation saved for img/${deckName}.wslide/${filename}:\n` +
                JSON.stringify(existing, null, 2)
            );
        }

        // ═══════════════════════════════════════════════════════════════════
        // INSERT — copy image + add image block to a slide in one step
        // ═══════════════════════════════════════════════════════════════════
        if (action === 'insert') {
            const srcPath = options.input?.srcPath;
            const filename = options.input?.filename;
            if (!srcPath && !filename) return _slideResult('Provide "srcPath" (external file) or "filename" (already in img/) for action:"insert".');

            let fname = filename;
            // Copy if srcPath provided
            if (srcPath) {
                if (!fs.existsSync(srcPath)) return _slideResult(`Source file not found: ${srcPath}`);
                fs.mkdirSync(imgDir, { recursive: true });
                fname = options.input?.filename || path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
                if (fs.existsSync(path.join(imgDir, fname))) {
                    const ext = path.extname(fname); const base = path.basename(fname, ext);
                    fname = base + '_' + Date.now() + ext;
                }
                fs.copyFileSync(srcPath, path.join(imgDir, fname));
            }

            const fpath = path.join(imgDir, fname);
            if (!fs.existsSync(fpath)) return _slideResult(`File not found: img/${deckName}.wslide/${fname}`);
            const dims = imageDimensions(fpath);

            // Annotate if provided
            const annotation = options.input?.annotation;
            if (annotation) {
                const ann = typeof annotation === 'string'
                    ? { description: annotation, source: srcPath || fname, tags: [] }
                    : { source: srcPath || fname, ...annotation };
                writeAnn(fname, ann);
            }
            const altText = (typeof annotation === 'string' ? annotation : annotation?.description) || fname;

            // Resolve slide
            const deck = p.getDeck(docUri);
            if (!deck) return _slideResult('No deck found.');
            const res = _resolveSlide({ input: { slideIndex: options.input?.slideIndex, slideId: options.input?.slideId } });
            if (!res || res.error) return _slideResult(res?.error || 'Could not find slide.');
            const slide = deck.slides[res.idx];

            // Build block
            const blk = {
                id: _uid(),
                type: 'image',
                src: `img/${deckName}.wslide/${fname}`,
                w: options.input?.w || (dims ? Math.min(dims.w, 1600) : 900),
                h: options.input?.h || (dims ? Math.min(dims.h, 900)  : 600),
                fit: options.input?.fit || 'contain',
                alt: altText,
            };
            if (options.input?.style) blk.style = options.input.style;
            if (options.input?.fragmentOrder != null) blk.fragmentOrder = options.input.fragmentOrder;

            // Insert into target container or root children
            const targetBlockId = options.input?.targetBlockId;
            if (targetBlockId) {
                const found = _findBlockRecursive(targetBlockId, slide);
                if (!found) return _slideResult(`Block id="${targetBlockId}" not found on slide ${res.idx + 1}.`);
                const arr = found.block.children = found.block.children || [];
                arr.push(blk);
            } else {
                (slide.children = slide.children || []).push(blk);
            }

            await p.applyDeck(deck, docUri);
            return _slideResult(
                `✅ Image inserted on slide ${res.idx + 1} ("${slide.label || ''}").\n` +
                (srcPath ? `   Copied: ${path.basename(srcPath)} → img/${deckName}.wslide/${fname}\n` : '') +
                `   Block id: ${blk.id}\n` +
                `   Dimensions: ${dims ? `${dims.w}×${dims.h}` : 'unknown'}  |  displayed at: ${blk.w}×${blk.h}\n` +
                (annotation ? `   Annotation saved.\n` : '') +
                `\nEdit the block later with wolfslide_block({action:"edit", slideIndex:${res.idx + 1}, blockId:"${blk.id}", updates:{...}})`
            );
        }

        return _slideResult(`Unknown action "${action}". Valid actions: list, info, copy, delete, rename, annotate, insert.`);
    }
}

// ── Bulk insert tool ──────────────────────────────────────────────────────

class WolfslideBulkInsertTool {
    prepareInvocation(options) {
        const n = options.input?.slides?.length ?? '?';
        return { invocationMessage: `Bulk inserting ${n} slides` };
    }
    async invoke(options, _token) {
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');

        const slides = options.input?.slides;
        if (!slides || !Array.isArray(slides) || slides.length === 0) {
            return _slideResult('"slides" array is required and must be non-empty.');
        }

        // Assign IDs recursively
        function ensureIds(b) {
            if (!b) return;
            if (!b.id) b.id = _uid();
            (b.children || b.items || b.elements || []).forEach(ensureIds);
        }

        const afterIndex = options.input?.afterIndex;
        const insertAt = (afterIndex != null) ? Math.min(afterIndex, deck.slides.length) : deck.slides.length;

        for (let i = 0; i < slides.length; i++) {
            const s = slides[i];
            if (!s.id) s.id = _uid();
            if (!s.children) s.children = [];
            _ensureBlockIds(s);
            deck.slides.splice(insertAt + i, 0, s);
        }

        // Optionally set theme if provided
        if (options.input?.theme) {
            if (!deck.theme) deck.theme = {};
            if (typeof options.input.theme === 'string' && THEME_PRESETS[options.input.theme]) {
                const preset = THEME_PRESETS[options.input.theme];
                Object.assign(deck.theme, preset.theme);
                for (const s of deck.slides) {
                    if (!s.background || s.background === '#fafcff') s.background = preset.defaultBackground;
                }
            } else if (typeof options.input.theme === 'object') {
                Object.assign(deck.theme, options.input.theme);
            }
        }

        // Optionally set meta
        if (options.input?.meta && typeof options.input.meta === 'object') {
            if (!deck.meta) deck.meta = {};
            Object.assign(deck.meta, options.input.meta);
        }

        await p.applyDeck(deck, docUri);
        return _slideResult(`Bulk-inserted ${slides.length} slides at position ${insertAt + 1}–${insertAt + slides.length}. Deck now has ${deck.slides.length} slides.`);
    }
}

// ── Eval block tools ──────────────────────────────────────────────────────

// Shared kernel expression builder for eval blocks:
// Graphics → SVG (with font→curves attempt); Non-graphics → boxes (BTL → LaTeX); fallback → PNG
// Fixes:
//  1. Syntax errors: ToExpression[..., Hold] detects parse failures before TimeConstrained
//  2. MakeBoxes HoldAllComplete: With[{val=res}, MakeBoxes[val,...]] injects the value
//  3. Timeout sentinel: $wbTO$ is a Block-local symbol, can never collide with a real result
function _buildEvalExpr(escaped, timeout, imgW) {
    return `Block[{$wbRes$, $wbSvg$, $wbImg$, $wbBoxes$, $wbGfx$, $wbParsed$, $wbTO$},
  (* Step 1: parse without evaluating — catches syntax errors before timeout wrapping *)
  $wbParsed$ = Quiet[ToExpression["${escaped}", InputForm, Hold]];
  If[!MatchQ[$wbParsed$, Hold[_]],
    "ERROR:Syntax error in expression",
    (* Step 2: evaluate with timeout; $wbTO$ is Block-local so it can never equal a real result *)
    $wbRes$ = TimeConstrained[ReleaseHold[$wbParsed$], ${timeout}, $wbTO$];
    If[$wbRes$ === $wbTO$,
      "ERROR:Evaluation timed out after ${timeout}s",
      $wbGfx$ = !FreeQ[$wbRes$, _Graphics | _Graphics3D | _Graph | _GeoGraphics | _Legended | _Image | _Image3D];
      If[$wbGfx$,
        (* Graphics: try SVG with text-to-outlines first, fall back to plain SVG, then PNG *)
        $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None, "ConvertTextToOutlines" -> True]];
        If[!StringQ[$wbSvg$] || !StringContainsQ[$wbSvg$, "<svg"],
          $wbSvg$ = Quiet[ExportString[$wbRes$, "SVG", ImageSize -> ${imgW}, Background -> None]]];
        If[StringQ[$wbSvg$] && StringContainsQ[$wbSvg$, "<svg"],
          "SVG:" <> $wbSvg$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ],
        (* Non-graphics: With[] injects the value past MakeBoxes HoldAllComplete *)
        $wbBoxes$ = Quiet[Check[With[{$wbVal$ = $wbRes$}, ToString[MakeBoxes[$wbVal$, TraditionalForm], InputForm]], $Failed]];
        If[StringQ[$wbBoxes$] && StringLength[$wbBoxes$] > 0,
          "BOXES:" <> $wbBoxes$,
          $wbImg$ = Quiet[ExportString[Rasterize[$wbRes$, ImageSize -> ${imgW}, Background -> None], {"Base64", "PNG"}]];
          If[StringQ[$wbImg$], "IMAGE:" <> $wbImg$, "TEXT:" <> ToString[$wbRes$, InputForm]]
        ]
      ]
    ]
  ]
]`;
}

// Shared result parser — converts kernel result string to output object
function _parseEvalResult(resultStr, imgW) {
    const now = new Date().toLocaleTimeString();
    if (resultStr.startsWith('SVG:')) {
        // Decode WSTP octal escapes + un-double backslashes (same as checkout.js)
        let svg = decodeWstpText(resultStr.slice(4));
        // Clip to <svg…</svg> boundaries
        const svgStart = svg.indexOf('<svg');
        if (svgStart > 0) svg = svg.slice(svgStart);
        const svgEnd = svg.toLowerCase().lastIndexOf('</svg>');
        if (svgEnd >= 0) svg = svg.slice(0, svgEnd + 6);
        svg = svg.replace(/[\n\r]/g, '');
        svg = svg.replace(/<font[\s\S]*?<\/font>/gi, '');
        svg = svg.replace(/<font-face[\s\S]*?\/>/gi, '');
        svg = svg.replace(/MathematicaMono-Regular/g, '"Courier New", Courier, monospace');
        svg = svg.replace(/MathematicaSans-Regular/g, 'Arial, Helvetica, sans-serif');
        svg = svg.replace(/Mathematica1-Bold/g, 'serif');
        svg = svg.replace(/Mathematica1/g, 'serif');
        return { type: 'svg', data: svg, evaluatedAt: now };
    } else if (resultStr.startsWith('BOXES:')) {
        // BTL → LaTeX → KaTeX pre-render
        // Decode WSTP octal escapes + un-double backslashes, then encode to base64 in JS
        // (matches checkout.js; avoids Wolfram ExportString encoding mismatch)
        const cleanBoxes = decodeWstpText(resultStr.slice(6));
        const b64boxes = Buffer.from(cleanBoxes).toString('base64');
        try {
            const _btlDir = require('path').join(__dirname, '../../wllatex-addon');
            const _prebuilt = require('path').join(_btlDir, 'prebuilt',
                `wolfbook_btl-${process.platform}-${process.arch}.node`);
            const _fallback = require('path').join(_btlDir, 'wolfbook_btl.node');
            const _fs = require('fs');
            const _addonPath = _fs.existsSync(_prebuilt) ? _prebuilt : _fallback;
            const _addon = require(_addonPath);
            const _prerender = require(require('path').join(_btlDir, 'katexPrerender.js')).prerenderLatex;
            const _namedchars = require('../namedchars').wlUTFtoNames;

            let boxStr = Buffer.from(b64boxes, 'base64').toString('utf8');
            boxStr = _namedchars(boxStr);
            const btlOpts = { trigOmitParens: true, trigPowerForm: true };
            const result = _addon.boxToLatex(boxStr, btlOpts);
            let latex = (result && typeof result === 'object') ? result.latex : String(result);
            const pageWidthEm = Math.max(0, Math.round(imgW / 10));
            if (pageWidthEm > 5 && _addon.lineBreakLatex) {
                try { latex = _addon.lineBreakLatex(latex, { pageWidth: pageWidthEm }); } catch (_) {}
            }
            const html = _prerender(latex, true);
            return { type: 'latex', html, latex, evaluatedAt: now };
        } catch (e) {
            // BTL not available — decode boxes as text
            try {
                const boxStr = Buffer.from(b64boxes, 'base64').toString('utf8');
                return { type: 'text', text: boxStr, evaluatedAt: now };
            } catch (_) {
                return { type: 'text', text: resultStr, evaluatedAt: now };
            }
        }
    } else if (resultStr.startsWith('IMAGE:')) {
        return { type: 'image', data: 'data:image/png;base64,' + resultStr.slice(6), evaluatedAt: now };
    } else if (resultStr.startsWith('TEXT:')) {
        return { type: 'text', text: resultStr.slice(5), evaluatedAt: now };
    } else if (resultStr.startsWith('ERROR:')) {
        return { type: 'error', error: resultStr.slice(6), evaluatedAt: now };
    } else {
        return { type: 'text', text: resultStr, evaluatedAt: now };
    }
}

class WolfslideInsertEvalBlockTool {
    constructor(getController) { this._getController = getController; }
    prepareInvocation(options) {
        return { invocationMessage: `Inserting eval block on slide ${options.input?.slideIndex ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const input = options.input?.input;
        if (!input || typeof input !== 'string') return _slideResult('input (Mathematica expression string) is required.');
        const block = {
            id: _uid(),
            type: 'eval',
            input: input,
        };
        if (options.input?.w) block.w = options.input.w;
        if (options.input?.h) block.h = options.input.h;
        const parentId = options.input?.parentBlockId || null;
        const position = options.input?.position;
        let arr;
        if (parentId) {
            const found = _findBlockRecursive(parentId, r.slide);
            if (!found) return _slideResult(`Parent block "${parentId}" not found.`);
            if (!found.block.children) found.block.children = [];
            arr = found.block.children;
        } else {
            if (!r.slide.children) r.slide.children = [];
            arr = r.slide.children;
        }
        const pos = (position != null && position >= 0) ? Math.min(position, arr.length) : arr.length;
        arr.splice(pos, 0, block);

        // Auto-evaluate if requested (default: true)
        const autoRun = options.input?.autoRun !== false;
        if (autoRun) {
            const evalResult = await this._evalBlockExpr(input, options.input?.w || 800);
            if (evalResult) {
                block.output = evalResult;
            }
        }

        await r.p.applyDeck(r.deck, r.docUri);
        const status = block.output
            ? `Output: ${block.output.type}${block.output.error ? ' — ' + block.output.error : ''}`
            : 'Not evaluated (kernel unavailable or autoRun=false)';
        return _slideResult(`Inserted eval block id=${block.id} at position ${pos} on slide ${r.idx + 1}. ${status}`);
    }

    async _evalBlockExpr(input, imgW) {
        try {
            const controller = this._getController?.();
            if (!controller?.session || controller._evalDispatched) return null;
            const timeout = 30;
            const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const expr = _buildEvalExpr(escaped, timeout, imgW);
            const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
            const evalResult = await Promise.race([
                controller.session.evaluate(expr, { interactive: false }),
                raceTimeout
            ]);
            const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
            return _parseEvalResult(resultStr, imgW);
        } catch (err) {
            return { type: 'error', error: err.message || String(err) };
        }
    }
}

class WolfslideRunEvalBlockTool {
    constructor(getController) { this._getController = getController; }
    prepareInvocation(options) {
        return { invocationMessage: `Running eval block ${options.input?.blockId ?? ''}` };
    }
    async invoke(options, _token) {
        const r = _resolveSlide(options);
        if (!r) return _slideResult('No .wslide editor is open.');
        if (r.error) return _slideResult(r.error);
        const blockId = options.input?.blockId;
        if (!blockId) return _slideResult('blockId is required.');
        const found = _findBlockRecursive(blockId, r.slide);
        if (!found) {
            const allIds = _collectAllBlocks(r.slide).filter(b => b.type === 'eval').map(b => b.id);
            return _slideResult(`Eval block "${blockId}" not found. Eval blocks on this slide: ${allIds.join(', ') || 'none'}`);
        }
        if (found.block.type !== 'eval') return _slideResult(`Block "${blockId}" is type="${found.block.type}", not "eval".`);
        const input = options.input?.input || found.block.input;
        if (options.input?.input) found.block.input = options.input.input; // update input if provided
        if (!input) return _slideResult('Block has no input expression. Provide input parameter or edit the block first.');

        const controller = this._getController?.();
        if (!controller?.session) return _slideResult('Kernel not connected. Start a Wolfram kernel first.');
        if (controller._evalDispatched) return _slideResult('Kernel is busy. Try again shortly.');

        try {
            const imgW = found.block.w || 800;
            const timeout = 30;
            const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const expr = _buildEvalExpr(escaped, timeout, imgW);
            const raceTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (timeout + 10) * 1000));
            const evalResult = await Promise.race([
                controller.session.evaluate(expr, { interactive: false }),
                raceTimeout
            ]);
            const resultStr = (evalResult?.result?.type === 'string' && evalResult.result.value) ? evalResult.result.value : String(evalResult?.result ?? '');
            found.block.output = _parseEvalResult(resultStr, imgW);
            await r.p.applyDeck(r.deck, r.docUri);
            return _slideResult(`Evaluated eval block ${blockId}. Result: ${found.block.output.type}${found.block.output.error ? ' — ' + found.block.output.error : ''}`);
        } catch (err) {
            return _slideResult(`Evaluation failed: ${err.message || err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_getCellOutput — read current output of a single cell by num or ID
// ---------------------------------------------------------------------------

class GetCellOutputTool {
    async prepareInvocation(options, _token) {
        const n = options.input?.cellId || options.input?.cellNumber;
        return { invocationMessage: `Read output of cell ${n}` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook = editor.notebook;
        const by = options.input?.cellId != null ? options.input.cellId : options.input?.cellNumber;
        if (by == null) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Provide cellId or cellNumber to identify the cell.'
            )]);
        }
        const resolved = resolveCellIndex(notebook, by, options.input?.cellId != null ? 'cellId' : 'cellNumber');
        if (resolved.error) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resolved.error)]);
        }

        const idx        = resolved.idx;
        const cell       = notebook.cellAt(idx);
        const cellId     = getCellToolId(cell);
        const cellNumber = idx + 1;
        const decoder    = new util.TextDecoder();
        const outs       = [];
        const msgOuts    = [];

        for (const output of cell.outputs) {
            const mimes     = output.items.map(it => it.mime);
            const plainItem = output.items.find(it => it.mime === 'text/plain');
            const isErrSentinel = mimes.includes('x-application/wolfram-language-html') &&
                                  mimes.includes('application/vnd.code.notebook.error');
            if (!plainItem) continue;
            try {
                const txt = decoder.decode(plainItem.data).trim();
                if (!txt) continue;
                if (isErrSentinel) msgOuts.push(txt);
                else outs.push(txt);
            } catch (_) {}
        }

        if (outs.length === 0 && msgOuts.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Cell ${cellNumber} (CellId: ${cellId}): no output (not evaluated yet or suppressed result).`
            )]);
        }

        const parts = [`Cell ${cellNumber} (CellId: ${cellId}) output:`];
        if (outs.length > 0) parts.push(outs.join('\n'));
        if (msgOuts.length > 0) parts.push(`\n\u26A0 Kernel messages:\n${msgOuts.join('\n')}`);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(parts.join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_validateSyntax — check Wolfram Language syntax in cell(s)
// ---------------------------------------------------------------------------

class ValidateSyntaxTool {
    constructor(getController) { this._getController = getController; }

    async prepareInvocation(options, _token) {
        if (options.input?.cellNumber != null) {
            return { invocationMessage: `Validate syntax of cell ${options.input.cellNumber}` };
        }
        const s = options.input?.startCell || 1, e = options.input?.endCell || '\u2026';
        return { invocationMessage: `Validate syntax of cells ${s}\u2013${e}` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook    = editor.notebook;
        const controller  = this._getController?.();
        const hasKernel   = controller?.session && controller.kernelStatusString === 'resolved' && !controller._evalDispatched;

        let from = 1, to = notebook.cellCount;
        if (options.input?.cellNumber != null) {
            from = to = Math.max(1, Math.min(notebook.cellCount, Number(options.input.cellNumber)));
        } else if (options.input?.startCell != null) {
            from = Math.max(1, Number(options.input.startCell));
            to   = Math.min(notebook.cellCount, Number(options.input.endCell || notebook.cellCount));
        }

        // Helper: escape a WL string literal
        const escWl = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n');

        const errors  = [];
        let checked   = 0;

        for (let n = from; n <= to; n++) {
            const cell = notebook.cellAt(n - 1);
            if (cell.kind === vscode.NotebookCellKind.Markup) continue;
            const src = cell.document.getText().trim();
            if (!src) continue;
            checked++;
            const cellId = getCellToolId(cell);

            if (hasKernel) {
                // SyntaxQ returns True/False; if False, SyntaxLength gives last valid position
                const esc  = escWl(src);
                const expr = `Block[{$wbSrc$="${esc}"}, If[SyntaxQ[$wbSrc$], "OK", "SYNTAX_ERROR at char " <> ToString[SyntaxLength[$wbSrc$] + 1]]]`;
                try {
                    const result = await Promise.race([
                        controller.session.evaluate(expr, { interactive: false }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                    ]);
                    const val = result?.result?.value || '';
                    if (val && val !== 'OK') {
                        errors.push(`Cell ${n} (CellId: ${cellId}): ${val}`);
                    }
                } catch (_) {
                    // Kernel unavailable mid-loop — fall through to text check
                }
            } else {
                // Offline heuristic checks (no kernel)
                // Check for common issues: unmatched brackets, string escapes
                let depth = 0;
                let inStr = false;
                let bad   = false;
                for (let i = 0; i < src.length; i++) {
                    const c = src[i];
                    if (inStr) {
                        if (c === '\\') { i++; continue; }
                        if (c === '"') inStr = false;
                    } else {
                        if (c === '"') { inStr = true; continue; }
                        if (c === '(' || c === '[' || c === '{') depth++;
                        else if (c === ')' || c === ']' || c === '}') depth--;
                        if (depth < 0) { bad = true; break; }
                    }
                }
                if (bad || depth !== 0 || inStr) {
                    errors.push(`Cell ${n} (CellId: ${cellId}): unmatched brackets/string${depth > 0 ? ` (depth=${depth})` : ''}`);
                }
            }
        }

        if (checked === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No code cells found in range.')]);
        }
        if (errors.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `\u2713 Syntax valid for all ${checked} code cell(s) checked (cells ${from}\u2013${to}).` +
                (hasKernel ? '' : '\n[Note: kernel not available — ran offline bracket-matching checks only]')
            )]);
        }
        const note = hasKernel ? '' : '\n[Note: kernel not available — ran offline bracket-matching checks only]';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `${errors.length} syntax issue(s) found in ${checked} code cell(s):\n${errors.join('\n')}${note}`
        )]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_saveLatex — write a .tex file safely (handles large multi-line content)
// ---------------------------------------------------------------------------

class SaveLatexTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Save LaTeX file: ${options.input?.path || '?'}` };
    }

    async invoke(options, _token) {
        let content = options.input?.content;
        const filePath = options.input?.path;
        if (!content || !filePath) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: both content and path are required. Example: { content: "\\\\documentclass{article}...", path: "/abs/path/to/file.tex" }'
            )]);
        }
        // Unescape double-encoded escape sequences (\n, \", \\)
        content = normalizeToolContent(content);
        // Resolve relative paths against the active notebook directory
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            const editor = await resolveNotebookEditor();
            const base   = editor ? path.dirname(editor.notebook.uri.fsPath) : process.cwd();
            absPath = path.join(base, filePath);
        }
        try {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            const lines = content.split('\n').length;
            const bytes = Buffer.byteLength(content, 'utf8');
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Saved: ${absPath}\n${lines} lines, ${bytes} bytes`
            )]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Error writing file: ${err.message}`
            )]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_compileLatex — run latexmk and return structured output
// ---------------------------------------------------------------------------

class CompileLatexTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Compile LaTeX: ${path.basename(options.input?.path || '?')}` };
    }

    async invoke(options, _token) {
        const { execFile } = require('child_process');
        const filePath = options.input?.path;
        if (!filePath) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: path to .tex file is required.'
            )]);
        }
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            const editor = await resolveNotebookEditor();
            const base   = editor ? path.dirname(editor.notebook.uri.fsPath) : process.cwd();
            absPath = path.join(base, filePath);
        }
        if (!fs.existsSync(absPath)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `File not found: ${absPath}`
            )]);
        }
        const engine  = options.input?.engine || 'pdflatex';
        const workDir = path.dirname(absPath);
        const baseFile = path.basename(absPath);
        const timeoutMs = (Number(options.input?.timeoutSeconds) || 60) * 1000;

        return new Promise(resolve => {
            const args   = ['-' + engine, '-interaction=nonstopmode', '-halt-on-error', baseFile];
            const proc   = execFile('latexmk', args, { cwd: workDir, timeout: timeoutMs }, (err, stdout, stderr) => {
                const combined = (stdout || '') + (stderr || '');
                const success  = !err || err.code === 0;
                // Extract key error lines
                const errLines = combined.split('\n')
                    .filter(l => /^!|^l\.\d|latexmk.*Error/i.test(l.trim()))
                    .slice(0, 20)
                    .join('\n');
                const pdfPath = absPath.replace(/\.tex$/, '.pdf');
                const hasPdf  = fs.existsSync(pdfPath);
                let msg;
                if (success || hasPdf) {
                    msg = `\u2713 Compilation succeeded. PDF: ${pdfPath}`;
                    if (errLines) msg += `\nWarnings:\n${errLines}`;
                } else {
                    msg = `\u2717 Compilation failed.\nErrors:\n${errLines || combined.slice(-2000)}`;
                }
                resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(msg)]));
            });
            proc.on('error', procErr => {
                resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Failed to run latexmk: ${procErr.message}\nMake sure latexmk is installed (brew install latexmk or via TeX Live).`
                )]));
            });
        });
    }
}

// ---------------------------------------------------------------------------
// wolfbook_getLatexErrors — parse a .log file for errors and warnings only
// ---------------------------------------------------------------------------

class GetLatexErrorsTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Parse LaTeX log: ${path.basename(options.input?.path || '?')}` };
    }

    async invoke(options, _token) {
        const filePath = options.input?.path;
        if (!filePath) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: path to .log or .tex file is required. For .tex files, the corresponding .log is read automatically.'
            )]);
        }
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            const editor = await resolveNotebookEditor();
            const base   = editor ? path.dirname(editor.notebook.uri.fsPath) : process.cwd();
            absPath = path.join(base, filePath);
        }
        // Auto-detect: if .tex given, read the .log
        if (absPath.endsWith('.tex')) absPath = absPath.replace(/\.tex$/, '.log');
        if (!fs.existsSync(absPath)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Log file not found: ${absPath}\nRun wolfbook_compileLatex first to generate it.`
            )]);
        }
        const raw = fs.readFileSync(absPath, 'utf8');
        const lines = raw.split('\n');
        const errors   = [];
        const warnings = [];

        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            // Hard errors: lines starting with !
            if (/^!/.test(l)) {
                // Grab context: the ! line + next few lines
                const ctx = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
                errors.push(ctx);
                i += 3;
                continue;
            }
            // LaTeX warnings
            if (/^(LaTeX Warning|LaTeX Font Warning|Package \w+ Warning|Overfull|Underfull)/i.test(l)) {
                let ctx = l;
                // Multi-line warnings end with a period or empty line
                let j = i + 1;
                while (j < lines.length && lines[j].trim() && !/^[(!]/.test(lines[j])) {
                    ctx += ' ' + lines[j].trim();
                    j++;
                    if (j - i > 5) break;
                }
                warnings.push(ctx.slice(0, 200));
            }
        }

        const parts = [];
        if (errors.length > 0) {
            parts.push(`**${errors.length} error(s):**\n` + errors.join('\n---\n'));
        }
        if (warnings.length > 0) {
            const shown = warnings.slice(0, 20);
            parts.push(`**${warnings.length} warning(s)${warnings.length > 20 ? ' (showing first 20)' : ''}:**\n` + shown.join('\n'));
        }
        if (parts.length === 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `\u2713 No errors or warnings found in ${absPath}`
            )]);
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(parts.join('\n\n'))]);
    }
}

// ---------------------------------------------------------------------------
// Consolidated tool: wolfbook_latex — save, compile, errors, or full build pipeline
// ---------------------------------------------------------------------------

class LatexTool {
    constructor() {
        this._save = new SaveLatexTool();
        this._compile = new CompileLatexTool();
        this._errors = new GetLatexErrorsTool();
    }
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'build';
        const file = path.basename(options.input?.path || '?');
        return { invocationMessage: `LaTeX ${action}: ${file}` };
    }
    async invoke(options, _token) {
        const action = options.input?.action;
        if (!action) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: action is required. Use "save", "compile", "errors", or "build".'
            )]);
        }
        switch (action) {
            case 'save':
                return this._save.invoke(options, _token);
            case 'compile':
                return this._compile.invoke(options, _token);
            case 'errors':
                return this._errors.invoke(options, _token);
            case 'build': {
                const saveResult = await this._save.invoke(options, _token);
                const saveText = saveResult.content?.map(p => p.value).join('') || '';
                if (saveText.startsWith('Error')) return saveResult;
                const compileResult = await this._compile.invoke(options, _token);
                const compileText = compileResult.content?.map(p => p.value).join('') || '';
                const errorsResult = await this._errors.invoke(options, _token);
                const errorsText = errorsResult.content?.map(p => p.value).join('') || '';
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `--- Save ---\n${saveText}\n\n--- Compile ---\n${compileText}\n\n--- Log ---\n${errorsText}`
                )]);
            }
            default:
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Unknown action "${action}". Use "save", "compile", "errors", or "build".`
                )]);
        }
    }
}

// ---------------------------------------------------------------------------
// Consolidated tool: wolfslide_block — insert, edit, delete, move blocks
// ---------------------------------------------------------------------------

class WolfslideBlockTool {
    constructor() {
        this._edit = new WolfslideEditBlockTool();
        this._insert = new WolfslideInsertBlockTool();
        this._delete = new WolfslideDeleteBlockTool();
        this._move = new WolfslideMoveBlockTool();
    }
    async prepareInvocation(options, _token) {
        const action = options.input?.action || '?';
        if (action === 'bulkEdit') {
            const n = (options.input?.edits || []).length;
            return { invocationMessage: `Slide block bulkEdit (${n} edit${n !== 1 ? 's' : ''})` };
        }
        return { invocationMessage: `Slide block ${action}` };
    }
    async invoke(options, _token) {
        const action = options.input?.action;
        if (!action) {
            return _slideResult('Error: action is required. Use "insert", "edit", "delete", "move", or "bulkEdit".');
        }
        switch (action) {
            case 'insert':   return this._insert.invoke(options, _token);
            case 'edit':     return this._edit.invoke(options, _token);
            case 'delete':   return this._delete.invoke(options, _token);
            case 'move':     return this._move.invoke(options, _token);
            case 'bulkEdit': return this._bulkEdit(options, _token);
            default:
                return _slideResult(`Unknown action "${action}". Use "insert", "edit", "delete", "move", or "bulkEdit".`);
        }
    }
    async _bulkEdit(options, _token) {
        const edits = options.input?.edits;
        if (!Array.isArray(edits) || edits.length === 0)
            return _slideResult('Error: edits array is required and must be non-empty.');
        const p = _getSlideProvider();
        if (!p) return _slideResult('No .wslide editor is open.');
        const docUri = options.input?.docUri;
        const deck = p.getDeck(docUri);
        if (!deck) return _slideResult('No deck found.');
        const applied = [];
        const failed  = [];
        for (const edit of edits) {
            const { blockId, updates, patch, slideId, slideIndex } = edit;
            const mergeProps = updates || patch;
            if (!blockId || !mergeProps || typeof mergeProps !== 'object') {
                failed.push(`  missing blockId or updates/patch: ${JSON.stringify(edit).slice(0, 80)}`);
                continue;
            }
            // Resolve slide
            let slideObj;
            if (slideId) {
                slideObj = deck.slides.find(s => s.id === slideId);
            } else if (slideIndex != null) {
                slideObj = deck.slides[slideIndex - 1];
            } else {
                // Search all slides for the block
                for (const s of deck.slides) {
                    if (_findBlockRecursive(blockId, s)) { slideObj = s; break; }
                }
            }
            if (!slideObj) { failed.push(`  block ${blockId}: slide not found`); continue; }
            const found = _findBlockRecursive(blockId, slideObj);
            if (!found) { failed.push(`  block ${blockId}: not found on slide "${slideObj.label || slideObj.id}"`); continue; }
            _deepMerge(found.block, mergeProps);
            applied.push(`  block ${blockId} on slide "${slideObj.label || slideObj.id}": ${Object.keys(mergeProps).join(', ')}`);
        }
        if (applied.length === 0 && failed.length > 0)
            return _slideResult('All edits failed:\n' + failed.join('\n'));
        await p.applyDeck(deck, docUri);
        const lines = [`Applied ${applied.length} / ${edits.length} block edit(s):`];
        lines.push(...applied);
        if (failed.length) { lines.push(`Failed ${failed.length}:`); lines.push(...failed); }
        return _slideResult(lines.join('\n'));
    }
}

// ---------------------------------------------------------------------------
// Consolidated tool: wolfslide_advanced — duplicate, check, reorderFragments, measure
// ---------------------------------------------------------------------------

class WolfslideAdvancedTool {
    constructor() {
        this._duplicate = new WolfslideDuplicateSlideTool();
        this._check = new WolfslideCheckDeckTool();
        this._reorder = new WolfslideReorderFragmentsTool();
        this._measure = new WolfslideMeasureSlideTool();
    }
    async prepareInvocation(options, _token) {
        const action = options.input?.action || '?';
        return { invocationMessage: `Slide advanced: ${action}` };
    }
    async invoke(options, _token) {
        const action = options.input?.action;
        if (!action) {
            return _slideResult('Error: action is required. Use "duplicate", "check", "reorderFragments", or "measure".');
        }
        switch (action) {
            case 'duplicate':        return this._duplicate.invoke(options, _token);
            case 'check':            return this._check.invoke(options, _token);
            case 'reorderFragments': return this._reorder.invoke(options, _token);
            case 'measure':          return this._measure.invoke(options, _token);
            default:
                return _slideResult(`Unknown action "${action}". Use "duplicate", "check", "reorderFragments", or "measure".`);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_paperSearch — search academic papers via INSPIRE-HEP / arXiv / Semantic Scholar
// ---------------------------------------------------------------------------

class PaperSearchTool {
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'search';
        const id = options.input?.identifier || options.input?.title || '';
        return { invocationMessage: `Paper ${action}: ${id}`.slice(0, 120) };
    }

    async invoke(options, _token) {
        const action = options.input?.action || 'search';
        try {
            switch (action) {
                case 'search':     return await this._search(options);
                case 'bibtex':     return await this._bibtex(options);
                case 'bibitem':    return await this._bibitem(options);
                case 'references': return await this._references(options);
                case 'citations':  return await this._citations(options);
                default:
                    return this._result(`Unknown action "${action}". Use: search, bibtex, bibitem, references, citations.`);
            }
        } catch (e) {
            return this._result(`Error: ${e.message}`);
        }
    }

    async _search(options) {
        const params = {};
        if (options.input?.title)      params.title    = options.input.title;
        if (options.input?.author)     params.author   = options.input.author;
        if (options.input?.abstract)   params.abstract = options.input.abstract;
        if (options.input?.identifier) {
            const id = options.input.identifier;
            if (/^\d{4}\.\d{4,5}/.test(id) || /^[a-z-]+\/\d+/.test(id)) params.eprint = id;
            else if (/^[A-Za-z]+:\d{4}[a-z]{2,}$/.test(id)) params.texkey = id;
            else params.query = id;
        }
        if (options.input?.query) params.query = options.input.query;

        const maxResults = Math.min(options.input?.maxResults || 5, 20);
        const includeAbstract = options.input?.includeAbstract !== false;

        const { source, papers } = await paperSearch.searchPapers(params, maxResults);
        if (papers.length === 0) return this._result(`No papers found (searched ${source}).`);

        const formatter = includeAbstract ? paperSearch.formatPaperFull : paperSearch.formatPaperShort;
        const lines = [`**${papers.length} result(s) from ${source}:**\n`];
        papers.forEach((p, i) => lines.push(formatter(p, i + 1)));

        return this._result(lines.join('\n\n'));
    }

    async _bibtex(options) {
        const id = options.input?.identifier;
        if (!id) return this._result('Error: provide an identifier (arXiv ID, texkey, or INSPIRE ID).');
        const bib = await paperSearch.getInspireBibtex(id);
        return this._result('```bibtex\n' + bib.trim() + '\n```');
    }

    async _bibitem(options) {
        const id = options.input?.identifier;
        if (!id) return this._result('Error: provide an identifier (arXiv ID, texkey, or INSPIRE ID).');
        const latex = await paperSearch.getInspireLatexUS(id);
        return this._result('```latex\n' + latex.trim() + '\n```');
    }

    async _references(options) {
        const id = options.input?.identifier;
        if (!id) return this._result('Error: provide an identifier (arXiv ID, texkey, or INSPIRE ID).');

        const includeContexts = !!options.input?.includeContexts;
        let contextMap = {};

        const refs = await paperSearch.getInspireReferences(id);

        if (includeContexts) {
            const arxivId = /^\d{4}\.\d{4,5}/.test(id) ? id : null;
            if (arxivId) {
                try {
                    const ctxs = await paperSearch.getReferenceContexts(arxivId, 50);
                    for (const c of ctxs) {
                        if (c.arxivId) contextMap[c.arxivId] = c.contexts;
                    }
                } catch (_) { /* S2 rate limited — continue without contexts */ }
            }
        }

        if (refs.length === 0) return this._result('No references found.');

        const lines = [`**${refs.length} reference(s):**\n`];
        refs.forEach((r, i) => {
            lines.push(paperSearch.formatReference(r, i + 1));
            if (includeContexts && r.arxivEprint && contextMap[r.arxivEprint]) {
                for (const ctx of contextMap[r.arxivEprint]) {
                    lines.push(`    > ${ctx}`);
                }
            }
        });

        return this._result(lines.join('\n'));
    }

    async _citations(options) {
        const id = options.input?.identifier;
        if (!id) return this._result('Error: provide an arXiv ID.');

        const limit = Math.min(options.input?.maxResults || 10, 50);
        const ctxs = await paperSearch.getCitationContexts(id, limit);

        if (ctxs.length === 0) return this._result('No citation data found (Semantic Scholar may not have this paper).');

        const lines = [`**${ctxs.length} citing paper(s) with context:**\n`];
        ctxs.forEach((c, i) => lines.push(paperSearch.formatCitationContext(c, i + 1)));

        return this._result(lines.join('\n\n'));
    }

    _result(text) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }
}

function registerTools(context, getController, debugCtrl) {
    const tools = [
        // Core notebook tools (visible in chat panel)
        { name: 'wolfbook_getNotebookContext', impl: new GetNotebookContextTool() },
        { name: 'wolfbook_evaluateExpression', impl: new EvaluateExpressionTool(getController) },
        { name: 'wolfbook_lookupSymbol',       impl: new LookupSymbolTool(getController) },
        { name: 'wolfbook_insertCells',        impl: new InsertCellsTool(getController) },
        { name: 'wolfbook_editCell',           impl: new EditCellTool(getController) },
        { name: 'wolfbook_runCell',            impl: new RunCellTool() },
        { name: 'wolfbook_getCellOutput',      impl: new GetCellOutputTool() },
        { name: 'wolfbook_validateSyntax',     impl: new ValidateSyntaxTool(getController) },
        { name: 'wolfbook_latex',              impl: new LatexTool() },
        { name: 'wolfbook_deleteCell',         impl: new DeleteCellTool() },
        { name: 'wolfbook_searchCells',        impl: new SearchCellsTool() },
        { name: 'wolfbook_getKernelState',     impl: new GetKernelStateTool(getController) },
        // Agent-only tools (not shown in chat panel)
        { name: 'wolfbook_moveCell',           impl: new MoveCellTool() },
        { name: 'wolfbook_restoreDeletedCells',impl: new RestoreDeletedCellsTool() },
        { name: 'wolfbook_kernelControl',      impl: new KernelControlTool(getController) },
        { name: 'wolfbook_kernelCrashLog',     impl: new KernelCrashLogTool() },
        { name: 'wolfbook_findPackage',        impl: new FindPackageTool(getController) },
        { name: 'wolfbook_debugCell',          impl: new DebugCellTool(getController, debugCtrl) },
        { name: 'wolfbook_fileOps',            impl: new FileOpsTool() },
        { name: 'wolfbook_runTerminal',        impl: new RunTerminalTool() },
        { name: 'wolfbook_paperSearch',        impl: new PaperSearchTool() },
        // Wolfteam tools
        { name: 'wolfteam_proposePlan',        impl: new ProposePlanTool() },
        { name: 'wolfteam_askDecision',        impl: new AskDecisionTool() },
        { name: 'wolfteam_checkpoint',         impl: new CheckpointTool() },
        // Wolfslide tools
        { name: 'wolfslide_getContext',      impl: new WolfslideGetContextTool() },
        { name: 'wolfslide_listSlides',      impl: new WolfslideListSlidesTool() },
        { name: 'wolfslide_getSlide',        impl: new WolfslideGetSlideTool() },
        { name: 'wolfslide_getSlideHtml',    impl: new WolfslideGetSlideHtmlTool() },
        { name: 'wolfslide_getImageDimensions', impl: new WolfslideGetImageDimensionsTool() },
        { name: 'wolfslide_insertSlide',     impl: new WolfslideInsertSlideTool() },
        { name: 'wolfslide_editSlide',       impl: new WolfslideEditSlideTool() },
        { name: 'wolfslide_deleteSlide',     impl: new WolfslideDeleteSlideTool() },
        { name: 'wolfslide_duplicateSlide',  impl: new WolfslideDuplicateSlideTool() },
        { name: 'wolfslide_moveSlide',       impl: new WolfslideMoveSlideTool() },
        { name: 'wolfslide_searchSlides',    impl: new WolfslideSearchSlidesTool() },
        { name: 'wolfslide_block',           impl: new WolfslideBlockTool() },
        { name: 'wolfslide_advanced',        impl: new WolfslideAdvancedTool() },
        { name: 'wolfslide_undo',            impl: new WolfslideUndoTool() },
        { name: 'wolfslide_saveFile',        impl: new WolfslideSaveFileTool() },
        { name: 'wolfslide_exportHtml',      impl: new WolfslideExportHtmlTool() },
        { name: 'wolfslide_setTheme',        impl: new WolfslideSetThemeTool() },
        { name: 'wolfslide_bulkInsert',      impl: new WolfslideBulkInsertTool() },
        { name: 'wolfslide_imageAsset',      impl: new WolfslideImageAssetTool() },
        { name: 'wolfslide_insertEvalBlock', impl: new WolfslideInsertEvalBlockTool(getController) },
        { name: 'wolfslide_runEvalBlock',    impl: new WolfslideRunEvalBlockTool(getController) },
    ];

    for (const { name, impl } of tools) {
        if (vscode.lm && vscode.lm.registerTool) {
            context.subscriptions.push(vscode.lm.registerTool(name, impl));
        }
    }

    // Build and return tool map for MCP server use
    const toolMap = new Map(tools.map(({ name, impl }) => [name, impl]));
    return toolMap;
}

// ---------------------------------------------------------------------------
// @wolfbook chat participant
// ---------------------------------------------------------------------------

const WOLFBOOK_SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, 'wolfbook-system-prompt.md'), 'utf8');

function registerChatParticipant(context, getController) {
    // Guard: chat API may not be available in older VS Code versions
    if (!vscode.chat || !vscode.chat.createChatParticipant) return;

    const participant = vscode.chat.createChatParticipant('wolfbook.wolfbook', async (request, ctx, stream, token) => {
        // ── Clear stale Copilot Edits session state ──────────────────────────
        // VS Code's Copilot Edits session tracks WorkspaceEdit changes made by
        // tools.  If the panel was closed without accepting, those tracked edits
        // persist and appear as "diff noise" (with a non-functional Keep button)
        // the next time the panel is opened.  To avoid this:
        //   1. At the start of every NEW conversation, save all dirty wolfram
        //      notebooks so VS Code's diff baseline equals the current saved
        //      state — clearing any leftover stale tracking.
        //   2. Tool calls below do NOT pass toolInvocationToken, so VS Code does
        //      not enroll our WorkspaceEdits into a Copilot Edits session at all.
        if (ctx.history.length === 0) {
            for (const ed of vscode.window.visibleNotebookEditors) {
                if (ed.notebook.notebookType === 'extended-wolfram-notebook' && ed.notebook.isDirty) {
                    try { await vscode.workspace.save(ed.notebook.uri); } catch (_) {}
                }
            }
            // Also try to accept any pending edits from a previous session.
            try { await vscode.commands.executeCommand('chatEditing.acceptAllFiles'); } catch (_) {}
        }
        // ── State header ────────────────────────────────────────────────────
        const controller = getController?.();
        const stateLines = [];
        if (controller) {
            const busy = controller._evalDispatched ? ' (currently evaluating)' : '';
            stateLines.push(`Kernel: ${controller.kernelStatusString || 'unknown'}${busy}`);
            if (controller._dynCells?.size > 0) stateLines.push(`Dynamic widgets active: ${controller._dynCells.size}`);
        } else {
            stateLines.push('Kernel: not connected');
        }
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
        if (editor) {
            const nb     = editor.notebook;
            const nbName = nb.uri.fsPath.split('/').pop();
            let codeN = 0, mdN = 0;
            for (let i = 0; i < nb.cellCount; i++) {
                nb.cellAt(i).kind === vscode.NotebookCellKind.Code ? codeN++ : mdN++;
            }
            stateLines.push(`Active notebook: ${nbName} — ${nb.cellCount} cells (${codeN} code, ${mdN} markdown)`);
            stateLines.push('Cell numbering note: tools use 1-based cellNumber; internal notebook indices are 0-based. Prefer CellId for stable targeting after reordering.');
            const sels = editor.selections || [];
            if (sels.length > 0) {
                stateLines.push('Selected cells:');
                for (const r of sels) {
                    const start0 = Math.max(0, Math.min(r.start, Math.max(0, nb.cellCount - 1)));
                    const endExclusive0 = Math.max(r.start, Math.min(r.end, nb.cellCount));
                    const end0 = Math.max(start0, Math.min(nb.cellCount - 1, endExclusive0 - 1));
                    if (start0 >= nb.cellCount) continue;
                    if (start0 === end0) {
                        const c = nb.cellAt(start0);
                        stateLines.push(`- index ${start0} => Cell ${start0 + 1}, CellId: ${getCellToolId(c)}`);
                    } else {
                        stateLines.push(`- indices ${start0}-${end0} => Cells ${start0 + 1}-${end0 + 1}`);
                    }
                }
            }
            stateLines.push('Call #wolfbookContext to read the notebook contents before answering questions about it.');
        } else {
            stateLines.push('No notebook is currently open.');
        }

        // ── Slash command hint ──────────────────────────────────────────────
        let cmdHint = '';
        if (request.command === 'run') {
            cmdHint = '\nTask: Run cells. Use #wolfbookRunAll or #wolfbookRun. Report per-cell results.';
        } else if (request.command === 'explain') {
            cmdHint = '\nTask: Explain the notebook. Call #wolfbookContext first, then explain what the code does.';
        } else if (request.command === 'debug') {
            cmdHint = '\nTask: Debug errors. Call #wolfbookContext, identify problem cells, use #wolfbookEval or #wolfbookDebug.';
        } else if (request.command === 'insert') {
            cmdHint = '\nTask: Insert cells. Use #wolfbookInsertMany for 2+ cells. kind="code" for WL, kind="markdown" for text/headings.';
        }

        // ── Build message list ──────────────────────────────────────────────
        const sysMsg = WOLFBOOK_SYSTEM_PROMPT +
            '\n\n## Current state\n' + stateLines.join('\n') +
            (cmdHint ? '\n\n## Task\n' + cmdHint.trim() : '');

        const messages = [vscode.LanguageModelChatMessage.User(sysMsg)];

        // Conversation history
        for (const turn of ctx.history) {
            if (turn instanceof vscode.ChatResponseTurn) {
                const md = turn.response
                    .filter(p => p instanceof vscode.ChatResponseMarkdownPart)
                    .map(p => p.value.value).join('');
                if (md) messages.push(vscode.LanguageModelChatMessage.Assistant(md));
            } else if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            }
        }
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        // ── Model + tools ───────────────────────────────────────────────────
        // Use the model selected in the chat UI; fall back to gpt-4o
        let model = request.model;
        if (!model) {
            const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
            model = models[0];
        }
        if (!model) {
            stream.markdown('No language model available. Make sure GitHub Copilot is active.');
            return;
        }

        const toolNames = [
            'wolfbook_getNotebookContext',
            'wolfbook_evaluateExpression', 'wolfbook_lookupSymbol',
            'wolfbook_insertCells', 'wolfbook_editCell', 'wolfbook_runCell',
            'wolfbook_getCellOutput', 'wolfbook_validateSyntax',
            'wolfbook_deleteCell', 'wolfbook_restoreDeletedCells',
            'wolfbook_moveCell', 'wolfbook_searchCells', 'wolfbook_getKernelState',
            'wolfbook_kernelControl', 'wolfbook_kernelCrashLog',
            'wolfbook_findPackage', 'wolfbook_debugCell',
            'wolfbook_fileOps', 'wolfbook_runTerminal',
            'wolfbook_paperSearch',
            'wolfbook_saveLatex', 'wolfbook_compileLatex', 'wolfbook_getLatexErrors',
        ];
        const tools = vscode.lm.tools.filter(t => toolNames.includes(t.name));

        const options = {
            justification: 'Wolfbook chat participant needs tool access to operate on the notebook and kernel.',
            tools,
        };

        // ── Agentic loop: handle tool calls until the model stops calling ───
        let rounds = 0;
        const MAX_ROUNDS = 20;  // guard against runaway loops

        while (rounds++ < MAX_ROUNDS && !token.isCancellationRequested) {
            const response = await model.sendRequest(messages, options, token);

            // Collect all parts from this response
            const toolCalls  = [];
            const textParts  = [];

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                    stream.markdown(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            // If no tool calls, the model is done — exit the loop
            if (toolCalls.length === 0) break;

            // Add assistant message (text + tool calls) to history
            const assistantContent = [];
            if (textParts.length > 0) {
                assistantContent.push(new vscode.LanguageModelTextPart(textParts.join('')));
            }
            assistantContent.push(...toolCalls);
            messages.push(vscode.LanguageModelChatMessage.Assistant(assistantContent));

            // Execute each tool and collect results
            const toolResultParts = [];
            for (const tc of toolCalls) {
                const label = tc.name.replace('wolfbook_', '#wolfbook');
                stream.progress(`Using ${label}…`);
                try {
                    const result = await vscode.lm.invokeTool(tc.name, {
                        input: tc.input,
                        // Do NOT pass toolInvocationToken — doing so enrolls our
                        // WorkspaceEdits into VS Code's Copilot Edits session, which
                        // produces confusing diff noise + a non-functional Keep button
                        // the next time the panel is opened.
                        toolInvocationToken: undefined,
                    }, token);
                    toolResultParts.push(
                        new vscode.LanguageModelToolResultPart(tc.callId, result.content)
                    );
                } catch (err) {
                    toolResultParts.push(
                        new vscode.LanguageModelToolResultPart(tc.callId, [
                            new vscode.LanguageModelTextPart(`Tool error: ${err.message}`)
                        ])
                    );
                }
            }

            // Feed results back as a user message and continue the loop
            messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
        }
    });

    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'wolfbook_file_icon.png');

    context.subscriptions.push(participant);
}

// ---------------------------------------------------------------------------
// inferMode — determine result mode from tool call history (no LLM self-reporting)
// ---------------------------------------------------------------------------
function inferMode(toolNames, hadErrors) {
    if (hadErrors) return 'error';
    if (toolNames.length === 0) return 'idle';
    if (toolNames.some(n => n && n.startsWith('wolfbook'))) return 'reviewing';
    return 'idle';
}

// ---------------------------------------------------------------------------
// registerWolfteamParticipant — @wolfteam collaborative research partner
// ---------------------------------------------------------------------------
function registerWolfteamParticipant(context, getController) {
    if (!vscode.chat || !vscode.chat.createChatParticipant) return;

    // Load system prompt once at registration time
    let WOLFTEAM_SYSTEM_PROMPT;
    try {
        WOLFTEAM_SYSTEM_PROMPT = fs.readFileSync(
            path.join(__dirname, 'wolfteam-system-prompt.md'), 'utf8');
    } catch {
        WOLFTEAM_SYSTEM_PROMPT = 'You are Wolfteam, a collaborative Wolfram Language research partner.';
    }

    const participant = vscode.chat.createChatParticipant('wolfbook.team', async (request, ctx, stream, token) => {

        // ── Clear stale Copilot Edits state on fresh conversation ───────────
        if (ctx.history.length === 0) {
            for (const ed of vscode.window.visibleNotebookEditors) {
                if (ed.notebook.notebookType === 'extended-wolfram-notebook' && ed.notebook.isDirty) {
                    try { await vscode.workspace.save(ed.notebook.uri); } catch (_) {}
                }
            }
            try { await vscode.commands.executeCommand('chatEditing.acceptAllFiles'); } catch (_) {}
        }

        // ── Kernel / notebook state header ──────────────────────────────────
        const controller = getController?.();
        const stateLines = [];
        if (controller) {
            const busy = controller._evalDispatched ? ' (currently evaluating)' : '';
            stateLines.push(`Kernel: ${controller.kernelStatusString || 'unknown'}${busy}`);
            if (controller._dynCells?.size > 0) stateLines.push(`Dynamic widgets active: ${controller._dynCells.size}`);
        } else {
            stateLines.push('Kernel: not connected');
        }
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
        if (editor) {
            const nb     = editor.notebook;
            const nbName = nb.uri.fsPath.split('/').pop();
            let codeN = 0, mdN = 0;
            for (let i = 0; i < nb.cellCount; i++) {
                nb.cellAt(i).kind === vscode.NotebookCellKind.Code ? codeN++ : mdN++;
            }
            stateLines.push(`Active notebook: ${nbName} — ${nb.cellCount} cells (${codeN} code, ${mdN} markdown)`);
            stateLines.push('Cell numbering note: tools use 1-based cellNumber; internal notebook indices are 0-based. Prefer CellId for stable targeting after reordering.');
            const sels = editor.selections || [];
            if (sels.length > 0) {
                stateLines.push('Selected cells:');
                for (const r of sels) {
                    const start0 = Math.max(0, Math.min(r.start, Math.max(0, nb.cellCount - 1)));
                    const endExclusive0 = Math.max(r.start, Math.min(r.end, nb.cellCount));
                    const end0 = Math.max(start0, Math.min(nb.cellCount - 1, endExclusive0 - 1));
                    if (start0 >= nb.cellCount) continue;
                    if (start0 === end0) {
                        const c = nb.cellAt(start0);
                        stateLines.push(`- index ${start0} => Cell ${start0 + 1}, CellId: ${getCellToolId(c)}`);
                    } else {
                        stateLines.push(`- indices ${start0}-${end0} => Cells ${start0 + 1}-${end0 + 1}`);
                    }
                }
            }
            stateLines.push('Call #wolfbookContext to read the notebook contents before answering questions about it.');
        } else {
            stateLines.push('No notebook is currently open.');
        }

        // ── Slash command overlay ────────────────────────────────────────────
        const cmdOverlays = {
            plan:     '\n\n## Task focus\nPresent a numbered plan for the requested calculation. Wait for the user to explicitly approve before executing anything.',
            check:    '\n\n## Task focus\nSanity-check the current results: dimensional consistency, symmetry properties, special limits, unexpected zeros or sign errors.',
            summarise:'\n\n## Task focus\nSummarise what has been computed so far, the key results, and what was tried and abandoned.',
            clean:    '\n\n## Task focus\nClean up the notebook: remove failed/scratch cells, reorder cells for narrative flow, tidy outputs.',
            export:   '\n\n## Task focus\nProduce a clean minimal ordered cell sequence that reproduces the key results, removing scaffolding.',
            back:     '\n\n## Task focus\nIdentify the last decision branch point in the notebook. Delete cells created after that branch on the abandoned path. Resume from that point with the alternative approach.',
        };
        const cmdOverlay = cmdOverlays[request.command] || '';

        // ── Build system message ─────────────────────────────────────────────
        const sysMsg = WOLFTEAM_SYSTEM_PROMPT + cmdOverlay +
            '\n\n## Current state\n' + stateLines.join('\n');

        const messages = [vscode.LanguageModelChatMessage.User(sysMsg)];

        // ── Thread conversation history ──────────────────────────────────────
        for (const turn of ctx.history) {
            if (turn instanceof vscode.ChatResponseTurn) {
                const md = turn.response
                    .filter(p => p instanceof vscode.ChatResponseMarkdownPart)
                    .map(p => p.value.value).join('');
                if (md) messages.push(vscode.LanguageModelChatMessage.Assistant(md));
            } else if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            }
        }
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        // ── Model selection ──────────────────────────────────────────────────
        let model = request.model;
        if (!model) {
            const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
            model = models[0];
        }
        if (!model) {
            stream.markdown('No language model available. Make sure GitHub Copilot is active.');
            return { metadata: { mode: 'idle' } };
        }

        // ── Tool set (full wolfbook set + wolfteam interaction tools) ────────
        const toolNames = [
            'wolfbook_getNotebookContext',
            'wolfbook_evaluateExpression', 'wolfbook_lookupSymbol',
            'wolfbook_insertCells', 'wolfbook_editCell', 'wolfbook_runCell',
            'wolfbook_getCellOutput', 'wolfbook_validateSyntax',
            'wolfbook_deleteCell', 'wolfbook_restoreDeletedCells',
            'wolfbook_moveCell', 'wolfbook_searchCells', 'wolfbook_getKernelState',
            'wolfbook_kernelControl', 'wolfbook_kernelCrashLog',
            'wolfbook_findPackage', 'wolfbook_debugCell',
            'wolfbook_fileOps', 'wolfbook_runTerminal',
            'wolfbook_paperSearch',
            'wolfbook_saveLatex', 'wolfbook_compileLatex', 'wolfbook_getLatexErrors',
            // Wolfteam interaction tools — inline confirmations
            'wolfteam_proposePlan', 'wolfteam_askDecision', 'wolfteam_checkpoint',
        ];
        const tools = vscode.lm.tools.filter(t => toolNames.includes(t.name));
        const options = {
            justification: 'Wolfteam collaborative agent needs tool access to operate on the notebook and kernel.',
            tools,
        };

        // ── Agentic loop ─────────────────────────────────────────────────────
        const teamTurns = ctx.history.filter(h => h instanceof vscode.ChatResponseTurn).length;
        let rounds = 0;
        const MAX_ROUNDS = 50;
        const allToolNames = [];
        const toolCallRounds = []; // [{name, input}] per round — for contextual follow-ups
        let hadErrors = false;
        let resultMetadata = { mode: 'idle', turnCount: teamTurns + 1 };

        while (rounds++ < MAX_ROUNDS && !token.isCancellationRequested) {
            const response = await model.sendRequest(messages, options, token);

            const toolCalls = [];
            const textParts = [];

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            const fullText = textParts.join('');

            if (toolCalls.length === 0) {
                // Final response — stream directly (no STATUS tag to strip)
                if (fullText) stream.markdown(fullText);
                resultMetadata = { mode: inferMode(allToolNames, hadErrors), turnCount: teamTurns + 1, toolCallRounds };
                break;
            }

            // Intermediate response — stream directly
            if (fullText) stream.markdown(fullText);

            const assistantContent = [];
            if (fullText) assistantContent.push(new vscode.LanguageModelTextPart(fullText));
            assistantContent.push(...toolCalls);
            messages.push(vscode.LanguageModelChatMessage.Assistant(assistantContent));

            const toolResultParts = [];
            for (const tc of toolCalls) {
                const label = tc.name.replace('wolfbook_', '#wolfbook').replace('wolfteam_', '#wolfteam');
                stream.progress(`Using ${label}…`);
                // wolfteam interaction tools NEED the invocation token so the
                // confirmation UI renders inline in the chat stream.
                // wolfbook tools must NOT get it — they make WorkspaceEdits which
                // would create unwanted Copilot Edits diff noise.
                const isInteractionTool = tc.name.startsWith('wolfteam_');
                try {
                    const result = await vscode.lm.invokeTool(tc.name, {
                        input: tc.input,
                        toolInvocationToken: isInteractionTool ? request.toolInvocationToken : undefined,
                    }, token);
                    allToolNames.push(tc.name);
                    toolCallRounds.push({ name: tc.name, input: tc.input });
                    toolResultParts.push(
                        new vscode.LanguageModelToolResultPart(tc.callId, result.content)
                    );
                } catch (err) {
                    hadErrors = true;
                    const isDenial = err.message?.includes('denied') ||
                                     err.message?.includes('cancelled') ||
                                     err.code === 'Cancelled';
                    const msg = isDenial
                        ? `User declined this action. Ask what they'd like to change or try a different approach.`
                        : `Tool error: ${err.message}`;
                    toolResultParts.push(
                        new vscode.LanguageModelToolResultPart(tc.callId, [
                            new vscode.LanguageModelTextPart(msg)
                        ])
                    );
                }
            }

            messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
        }

        return { metadata: resultMetadata };
    });

    // ── Follow-up provider ───────────────────────────────────────────────────
    participant.followupProvider = {
        provideFollowups(result, _ctx, _token) {
            const meta = result.metadata;
            if (!meta) return [];

            // Find the last checkpoint to extract its nextStep for a contextual follow-up
            const rounds = meta.toolCallRounds || [];
            let lastCheckpointNext;
            for (let i = rounds.length - 1; i >= 0; i--) {
                if (rounds[i].name === 'wolfteam_checkpoint' && rounds[i].input?.nextStep) {
                    lastCheckpointNext = rounds[i].input.nextStep;
                    break;
                }
            }

            function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s; }

            switch (meta.mode) {
                case 'reviewing': {
                    const followups = [];
                    if (lastCheckpointNext) {
                        followups.push({ prompt: lastCheckpointNext, label: `→ ${trunc(lastCheckpointNext, 60)}` });
                    }
                    followups.push(
                        { prompt: 'Save the notebook and summarise what we did', label: '💾 Save & summarise' },
                        { prompt: "Let's work on something else",                label: '🆕 New task' },
                    );
                    return followups;
                }
                case 'error':
                    return [
                        { prompt: 'Try a different approach',  label: '↻ Different approach' },
                        { prompt: 'Debug this step',           label: '🔍 Debug' },
                    ];
                default:
                    return [
                        { prompt: "What's currently in my notebook?", label: '📓 Show notebook' },
                        { prompt: 'Help me with a calculation',        label: '🧮 New calculation' },
                    ];
            }
        },
    };

    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'wolfbook_file_icon.png');
    context.subscriptions.push(participant);
}

module.exports = { registerTools, registerChatParticipant, registerWolfteamParticipant, buildTranscript, clearEvalLog };
