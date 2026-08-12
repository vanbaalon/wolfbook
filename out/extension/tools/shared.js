"use strict";
// Wolfbook Tool Utilities — shared helpers extracted from tools/index.js

const vscode   = require("vscode");
const util     = require("util");
const fs       = require("fs");
const path     = require("path");
const logPaths = require("../utils/log-paths");

// ---------------------------------------------------------------------------
// MCP context flag — set true during MCP tool calls so _confirmSwitch is
// skipped (MCP clients can't respond to VS Code dialog boxes).
// ---------------------------------------------------------------------------
let _mcpCallActive = false;
function setMcpCallActive(v) { _mcpCallActive = v; }

// ---------------------------------------------------------------------------
// Shared: append an entry to the evaluation log for the active notebook.
// The log lives under globalStorage (see utils/log-paths.js), NOT beside the
// notebook — writing it into the notebook folder littered every Dropbox-synced
// project with an img/<nb>/ai_eval_log.md that re-synced on every evaluation.
// Off unless wolfbook.advanced.diagnosticLogs is enabled.
// ---------------------------------------------------------------------------

/**
 * Resolve the eval-log path + notebook name for the active notebook.
 * @returns {{logPath: string, notebookName: string}|null} null when logging is off
 */
function _evalLog() {
    const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
    if (!editor || editor.notebook.uri.scheme !== 'file') return null;
    const notebookPath = editor.notebook.uri.fsPath;
    const logPath = logPaths.notebookLogFile(notebookPath, 'ai_eval_log.md');
    if (!logPath) return null;
    return { logPath, notebookName: path.basename(notebookPath, path.extname(notebookPath)) };
}

// Called from lifecycle.js on every kernel launch — appends a restart marker
// so the full action history is preserved across kernel reboots.
function clearEvalLog() {
    try {
        const log = _evalLog();
        if (!log) return;
        const stamp   = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const isFirst = !fs.existsSync(log.logPath);
        const entry   = isFirst
            ? `# AI Action Log — ${log.notebookName}\n\n## ${stamp} — 🌟 KERNEL START\n\n`
            : `\n---\n\n## ${stamp} — 🔄 KERNEL RESTART\n\n`;
        fs.appendFileSync(log.logPath, entry, 'utf8');
    } catch (_) {}
}

function appendEvalLog(expression, output) {
    try {
        const log = _evalLog();
        if (!log) return;
        const stamp   = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const isFirst = !fs.existsSync(log.logPath);
        const entry = [
            isFirst ? `# AI Evaluation Log — ${log.notebookName}\n` : '',
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
        fs.appendFileSync(log.logPath, entry, 'utf8');
    } catch (_) {
        // Logging is best-effort; never crash the tool
    }
}

// Append a structural action event (insert/edit/delete cell, save, etc.) to the same log.
function appendEventLog(action, detail) {
    try {
        const log = _evalLog();
        if (!log) return;
        const stamp   = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const isFirst = !fs.existsSync(log.logPath);
        const header  = isFirst ? `# AI Action Log — ${log.notebookName}\n\n` : '';
        const body    = detail ? `\n${detail.trim()}\n` : '';
        fs.appendFileSync(log.logPath, `${header}## ${stamp} — ${action}${body}\n`, 'utf8');
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

// Returns true when Collab mode is active (agent works in right-column split editor).
function _isCollabMode() {
    try {
        return !!vscode.workspace.getConfiguration('wolfbook').get('collabMode', false);
    } catch (_) { return false; }
}

/**
 * In collab mode: find or open the right-column split editor for a given notebook.
 * Looks for an existing ViewColumn.Two editor first; if absent, opens ViewColumn.Two
 * (not Beside — Beside can resolve to column 1 when no editor is active).
 */
async function _ensureCollabEditor(notebook) {
    const rightEd = vscode.window.visibleNotebookEditors.find(ed =>
        ed.notebook.uri.toString() === notebook.uri.toString() &&
        ed.viewColumn === vscode.ViewColumn.Two
    );
    if (rightEd) return rightEd;
    try {
        return await vscode.window.showNotebookDocument(notebook, {
            viewColumn: vscode.ViewColumn.Two,
            preserveFocus: true,
        });
    } catch (_) { return null; }
}

// Scroll a notebook cell into view and briefly highlight it so the user sees
// which cell the AI just inserted or edited.
let _cellGlowDeco = null;
async function flashCell(editor, cellIndex) {    try {
        const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
        // Always scroll the rightmost visible editor for this notebook.
        // In collab mode: ensure the right-column editor exists first (open it if absent).
        // In non-collab mode: use whatever rightmost editor is already visible — never force-open one.
        let targetEditor;
        if (_isCollabMode()) {
            const rightEd = await _ensureCollabEditor(editor.notebook);
            if (!rightEd) return; // couldn't open right pane — skip flash
            targetEditor = rightEd;
        } else {
            const visible = vscode.window.visibleNotebookEditors.filter(
                ed => ed.notebook.uri.toString() === editor.notebook.uri.toString()
            );
            if (visible.length === 0) return;
            // Pick the rightmost (highest viewColumn). Falls back to the single editor.
            targetEditor = visible.reduce((best, ed) =>
                (ed.viewColumn ?? 0) >= (best.viewColumn ?? 0) ? ed : best
            );
        }
        // Scroll target editor into view
        targetEditor.revealRange(new RC(cellIndex, cellIndex + 1),
                           vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
        // Apply a brief highlight decoration
        if (!_cellGlowDeco && vscode.notebooks?.createNotebookEditorDecorationType) {
            _cellGlowDeco = vscode.notebooks.createNotebookEditorDecorationType({
                backgroundColor: 'rgba(100, 180, 255, 0.12)',
                borderColor:     'rgba(100, 180, 255, 0.75)',
            });
        }
        if (_cellGlowDeco) {
            targetEditor.setDecorations(_cellGlowDeco, [new RC(cellIndex, cellIndex + 1)]);
            setTimeout(() => {
                try { targetEditor.setDecorations(_cellGlowDeco, []); } catch (_) {}
            }, 1800);
        }
    } catch (_) {}
}

// ---------------------------------------------------------------------------
// Viewport guard for tool-initiated operations.
// When two editors are open for the same notebook, the leftmost one is
// controlled by the user and must not be scrolled by tools.  The rightmost
// one follows agent activity (flashCell).
// When only one editor is open, tools scroll it freely — no guard needed.
// ---------------------------------------------------------------------------

/**
 * Snapshot the LEFT (user-controlled) notebook editor viewport so it can be
 * restored after a tool operation.  Returns null when only one editor is open
 * for this notebook (no guard needed in that case).
 */
function _snapshotViewport(notebook) {
    const uri = notebook.uri.toString();
    const matching = vscode.window.visibleNotebookEditors.filter(
        ed => ed.notebook.uri.toString() === uri
    );
    // Only guard when there are 2+ editors for this notebook.
    if (matching.length < 2) return null;

    // With 2+ editors: protect the leftmost (lowest viewColumn) one.
    const leftEd = matching.reduce((best, ed) =>
        (ed.viewColumn ?? 999) <= (best.viewColumn ?? 999) ? ed : best
    );
    return {
        editor:     leftEd,
        viewport:   leftEd.visibleRanges?.[0] ?? null,
        selections: leftEd.selections ? [...leftEd.selections] : null,
    };
}

/**
 * Restore a previously saved viewport snapshot.
 * Restores both scroll position and cell selection.
 */
function _restoreViewport(snapshot) {
    if (!snapshot) return;
    const { editor, viewport, selections } = snapshot;
    try {
        if (viewport) {
            editor.revealRange(viewport, vscode.NotebookEditorRevealType.AtTop);
        }
        if (selections && selections.length > 0) {
            editor.selections = selections;
        }
    } catch (_) { /* editor may have been disposed */ }
}

// ---------------------------------------------------------------------------
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
        // The primary selection's start is the "current" (focused) cell
        const activeCellIdx = selEditor.selections[0].start;
        if (activeCellIdx >= 0 && activeCellIdx < total) {
            const activeCell = notebook.cellAt(activeCellIdx);
            lines.push(`Current cell: Cell ${activeCellIdx + 1} (cellId: ${getCellToolId(activeCell)})`);
        }
        // Full selection list — only show when more than a single cell is selected
        const hasMultiOrRange = selEditor.selections.some(r => (r.end - r.start) > 1) || selEditor.selections.length > 1;
        if (hasMultiOrRange) {
            lines.push('Selected cell range(s):');
            for (const r of selEditor.selections) {
                const start0 = Math.max(0, Math.min(r.start, Math.max(0, total - 1)));
                const endExclusive0 = Math.max(r.start, Math.min(r.end, total));
                const end0 = Math.max(start0, Math.min(total - 1, endExclusive0 - 1));
                if (start0 >= total) continue;
                if (start0 === end0) {
                    const cell = notebook.cellAt(start0);
                    lines.push(`- Cell ${start0 + 1} (cellId: ${getCellToolId(cell)})`);
                } else {
                    lines.push(`- Cells ${start0 + 1}–${end0 + 1}`);
                    for (let i = start0; i <= end0; i++) {
                        const cell = notebook.cellAt(i);
                        lines.push(`  - Cell ${i + 1} (cellId: ${getCellToolId(cell)})`);
                    }
                }
            }
        }
    } else {
        lines.push('Current cell: (none selected / different notebook)');
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
            // Check for KaTeX rendering errors and flag them so the agent fixes them
            if (src) {
                const katexErrs = checkMarkdownKaTeX(src);
                if (katexErrs.length > 0) {
                    lines.push('');
                    lines.push('⛔ LATEX ERRORS — broken math in this markdown cell (must be fixed):');
                    for (const { display, latex, message } of katexErrs.slice(0, 5)) {
                        const d = display ? '$$' : '$';
                        lines.push(`  ${d}${latex.slice(0, 80)}${d} → ${message}`);
                    }
                }
            }
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

    // Append a minimal activity summary (last 1 hour) so the agent knows whether
    // the user or agent has touched the notebook since the last context read.
    // Only action headers are shown — no code/output — to keep context small.
    try {
        // Read-only: use notebookLogDir (not notebookLogFile) so a context read never
        // creates the log directory. null when diagnostic logs are disabled.
        const logDir  = logPaths.notebookLogDir(notebook.uri.fsPath);
        const logPath = logDir ? path.join(logDir, 'ai_eval_log.md') : null;
        if (logPath && fs.existsSync(logPath)) {
            const logContent = fs.readFileSync(logPath, 'utf8');
            const cutoff     = Date.now() - 60 * 60 * 1000;
            // Extract only the "## timestamp — ACTION" header lines within the last hour
            const headerRe   = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) — (.+)$/gm;
            const events     = [];
            let m;
            while ((m = headerRe.exec(logContent)) !== null) {
                const ts = new Date(m[1].replace(' ', 'T') + 'Z').getTime();
                if (ts > cutoff) events.push(`${m[1]} — ${m[2].trim()}`);
            }
            if (events.length > 0) {
                lines.push('');
                lines.push('---');
                lines.push(`Recent activity (last 1h, ${events.length} event(s)) — user may have evaluated cells manually between agent steps:`);
                lines.push(events.map(e => `  · ${e}`).join('\n'));
            }
        }
    } catch (_) {}

    return lines.join('\n');
}

/** Extract the short cell ID from a vscode-notebook-cell URI (just the fragment). */
function _shortCellId(uriOrId) {
    if (typeof uriOrId === 'string' && uriOrId.startsWith('vscode-notebook-cell:')) {
        const h = uriOrId.lastIndexOf('#');
        if (h >= 0 && h < uriOrId.length - 1) return uriOrId.slice(h + 1);
    }
    return uriOrId;
}

/** Get (or lazily assign) a stable CellId that survives move operations.
 *  Returns only the fragment portion of the vscode-notebook-cell URI — short, unique,
 *  and stable within a session. Old full-URI stored values are migrated on the fly. */
function getCellToolId(cell) {
    const meta = cell?.metadata;
    if (meta?.toolId) return _shortCellId(meta.toolId);
    return _shortCellId(cell?.document?.uri?.toString?.() || '');
}

/** Assign a stable toolId to a cell's metadata if it doesn't already have one.
 *  Returns the assigned/existing toolId (short fragment form). */
async function _ensureCellToolId(notebook, cellIndex) {
    const cell = notebook.cellAt(cellIndex);
    const existing = cell.metadata?.toolId;
    if (existing) return _shortCellId(existing);
    const id = _shortCellId(cell.document.uri.toString());
    const edit = new vscode.WorkspaceEdit();
    const newMeta = { ...(cell.metadata || {}), toolId: id };
    edit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cellIndex, newMeta)]);
    await vscode.workspace.applyEdit(edit);
    return id;
}

function formatCellRef(idx, cell) {
    return `Cell ${idx + 1} (CellId: ${getCellToolId(cell)})`;
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
        // Fallback: agent may have a full vscode-notebook-cell URI from an older context;
        // extract the fragment and try again.
        const frag = _shortCellId(raw);
        if (frag !== raw) {
            for (let i = 0; i < count; i++) {
                if (getCellToolId(notebook.cellAt(i)) === frag) return { idx: i };
            }
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
const NB_EXTS = ['.wb', '.evsnb', '.vsnb'];

// ---------------------------------------------------------------------------
// Copilot auto-target: when a Copilot tool resolves a notebook, notify the
// MCP server so it can set a session target automatically.  The callback is
// wired up by extension.js after the MCP server starts.
// ---------------------------------------------------------------------------
let _onNotebookResolved = null;
/** Called by extension.js to register a one-time auto-target hook. */
function setNotebookResolvedCallback(fn) { _onNotebookResolved = fn; }

/** Return all notebook URIs known to this window:
 *  - notebooks already loaded into memory (notebookDocuments)
 *  - notebooks in open tabs that haven't been loaded yet (tabGroups)
 */
function _allNotebookUris() {
    const map = new Map();  // fsPath → vscode.Uri
    for (const doc of vscode.workspace.notebookDocuments) {
        if (doc.notebookType === 'extended-wolfram-notebook') {
            map.set(doc.uri.fsPath, doc.uri);
        }
    }
    try {
        for (const group of (vscode.window.tabGroups?.all || [])) {
            for (const tab of (group.tabs || [])) {
                const uri = tab.input?.uri || tab.input?.modified;
                if (uri && NB_EXTS.some(ext => uri.fsPath.endsWith(ext))) {
                    map.set(uri.fsPath, uri);
                }
            }
        }
    } catch {}
    return map;
}

/**
 * Resolve (and optionally bring to front) a notebook editor.
 * @param {string}  [targetName]          - filename to match (case-insensitive)
 * @param {object}  [opts]
 * @param {boolean} [opts.skipConfirm]    - skip the switch confirmation dialog (e.g. for explicit switch action)
 * @param {string}  [opts.actionDesc]     - human description of what the agent intends to do (shown in dialog)
 * @returns {vscode.NotebookEditor|null}
 */
async function resolveNotebookEditor(targetName, opts = {}) {
    const activeUri = vscode.window.activeNotebookEditor?.notebook?.uri?.toString();

    /** Show confirmation dialog before switching; returns true if user accepts. */
    async function _confirmSwitch(targetFileName) {
        // Skip dialog when called from MCP (client can't click a VS Code popup)
        // or when the caller explicitly opts out of the confirmation.
        if (_mcpCallActive || opts.skipConfirm) return true;
        const active = vscode.window.activeNotebookEditor?.notebook?.uri?.fsPath?.split('/')?.pop() || 'current notebook';
        if (targetFileName.toLowerCase() === active.toLowerCase()) return true;  // already active, no dialog
        const action = opts.actionDesc ? `\"${opts.actionDesc}\" on` : 'work on';
        const choice = await vscode.window.showInformationMessage(
            `Agent wants to ${action} "${targetFileName}". Switch away from "${active}"?`,
            { modal: false },
            'Switch & Continue',
            'Cancel'
        );
        return choice === 'Switch & Continue';
    }

    // If a specific notebook is requested, find it among all known tabs/docs
    if (targetName) {
        const normTarget = targetName.trim().toLowerCase();

        // 1. Check visible editors first (fast path — already loaded)
        for (const ed of vscode.window.visibleNotebookEditors) {
            const name = ed.notebook.uri.fsPath.split('/').pop().toLowerCase();
            if (name === normTarget) {
                if (ed.notebook.uri.toString() !== activeUri) {
                    if (!await _confirmSwitch(ed.notebook.uri.fsPath.split('/').pop())) return null;
                }
                if (_isCollabMode()) {
                    const collabEd = await _ensureCollabEditor(ed.notebook);
                    _onNotebookResolved?.(ed.notebook.uri.fsPath.split('/').pop());
                    return collabEd || ed;
                }
                try { await vscode.window.showNotebookDocument(ed.notebook, { preserveFocus: false }); } catch (_) {}
                _onNotebookResolved?.(ed.notebook.uri.fsPath.split('/').pop());
                return ed;
            }
        }
        // 2. Check all in-memory notebook documents (loaded but not visible)
        for (const doc of vscode.workspace.notebookDocuments) {
            const name = doc.uri.fsPath.split('/').pop().toLowerCase();
            if (name === normTarget) {
                if (doc.uri.toString() !== activeUri) {
                    if (!await _confirmSwitch(doc.uri.fsPath.split('/').pop())) return null;
                }
                try {
                    if (_isCollabMode()) {
                        const collabEd = await _ensureCollabEditor(doc);
                        _onNotebookResolved?.(doc.uri.fsPath.split('/').pop());
                        return collabEd || await vscode.window.showNotebookDocument(doc, { preserveFocus: true });
                    }
                    const ed = await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
                    _onNotebookResolved?.(doc.uri.fsPath.split('/').pop());
                    return ed;
                } catch (_) {}
            }
        }
        // 3. Check background tabs that haven't been loaded into memory yet.
        //    We must call openNotebookDocument first to load it, then showNotebookDocument.
        //    Use a timeout — openNotebookDocument can hang if VS Code isn't ready.
        const _openWithTimeout = (uri, ms = 8000) => Promise.race([
            vscode.workspace.openNotebookDocument(uri),
            new Promise((_, rej) => setTimeout(() => rej(new Error('openNotebookDocument timed out')), ms)),
        ]);
        const allUris = _allNotebookUris();
        for (const [fsPath, uri] of allUris) {
            const name = fsPath.split('/').pop().toLowerCase();
            if (name === normTarget) {
                if (uri.toString() !== activeUri) {
                    if (!await _confirmSwitch(fsPath.split('/').pop())) return null;
                }
                try {
                    const doc = await _openWithTimeout(uri);
                    if (_isCollabMode()) {
                        const collabEd = await _ensureCollabEditor(doc);
                        _onNotebookResolved?.(fsPath.split('/').pop());
                        return collabEd || await vscode.window.showNotebookDocument(doc, { preserveFocus: true });
                    }
                    const ed  = await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
                    _onNotebookResolved?.(fsPath.split('/').pop());
                    return ed;
                } catch (_) {}
            }
        }
        // 4. Not found — return null so the caller can report the error
        return null;
    }

    // No target specified — use active or first visible
    // In collab mode prefer the col-1 editor as the "primary" so we always route to col-2.
    if (_isCollabMode()) {
        const primaryNb =
            vscode.window.visibleNotebookEditors.find(ed => ed.viewColumn === vscode.ViewColumn.One)?.notebook
            || (vscode.window.activeNotebookEditor?.viewColumn !== vscode.ViewColumn.Two
                ? vscode.window.activeNotebookEditor?.notebook : null)
            || vscode.window.visibleNotebookEditors[0]?.notebook;
        if (!primaryNb) return null;
        _onNotebookResolved?.(primaryNb.uri.fsPath.split('/').pop());
        return await _ensureCollabEditor(primaryNb);
    }
    const active = vscode.window.activeNotebookEditor;
    if (active) {
        _onNotebookResolved?.(active.notebook.uri.fsPath.split('/').pop());
        return active;
    }
    // No active notebook editor — auto-switch to first visible or in-memory wolfbook
    const visibleWb = vscode.window.visibleNotebookEditors.find(
        ed => /\.(wb|evsnb|vsnb)$/.test(ed.notebook.uri.fsPath)
    );
    if (visibleWb) {
        try { await vscode.window.showNotebookDocument(visibleWb.notebook, { preserveFocus: false }); } catch (_) {}
        _onNotebookResolved?.(visibleWb.notebook.uri.fsPath.split('/').pop());
        return visibleWb;
    }
    // Try in-memory wolfbook documents
    for (const doc of vscode.workspace.notebookDocuments) {
        if (/\.(wb|evsnb|vsnb)$/.test(doc.uri.fsPath)) {
            try {
                const ed = await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
                _onNotebookResolved?.(doc.uri.fsPath.split('/').pop());
                return ed;
            } catch (_) {}
        }
    }
    const fallback = vscode.window.visibleNotebookEditors[0];
    if (!fallback) return null;
    try {
        await vscode.window.showNotebookDocument(fallback.notebook, { preserveFocus: false });
    } catch (_) {}
    _onNotebookResolved?.(fallback.notebook.uri.fsPath.split('/').pop());
    return fallback;
}

// ---------------------------------------------------------------------------
// wolfbook_getNotebookContext
// ---------------------------------------------------------------------------

/**
 * Build an actionable "no editor" error message that lists open notebooks
 * so the user knows what to open/focus rather than just seeing a bare error.
 */
function noEditorMsg(targetName) {
    const open = [...(_allNotebookUris?.() ?? new Map()).keys()]
        .map(p => p.split('/').pop())
        .filter(Boolean);
    const openList = open.length ? ` Open notebooks: ${open.join(', ')}.` : ' No Wolfram notebooks are open.';
    const hint = targetName
        ? `Notebook "${targetName}" not found or could not be opened.${openList}`
        : `No Wolfram notebook editor is available.${openList} Open a .wb file and ensure it is visible in VS Code, then retry.`;
    return hint;
}

module.exports = {
    clearEvalLog,
    appendEvalLog,
    appendEventLog,
    normalizeToolContent,
    splitWLIntoStatements,
    checkMarkdownKaTeX,
    _katexWarnings,
    _katexWarningsForCells,
    _isCollabMode,
    _ensureCollabEditor,
    flashCell,
    _snapshotViewport,
    _restoreViewport,
    buildTranscript,
    getCellToolId,
    _ensureCellToolId,
    formatCellRef,
    resolveCellIndex,
    resolveInsertIndex,
    isKernelConnectionError,
    cleanWrapperFromMsg,
    KERNEL_CRASH_MSG,
    NB_EXTS,
    setNotebookResolvedCallback,
    _allNotebookUris,
    resolveNotebookEditor,
    noEditorMsg,
    setMcpCallActive,
};
