"use strict";
// Wolfbook Copilot Language Model Tools — Phase 4
// Registered in extension.js activate(); declared in package.json contributes.languageModelTools.

const vscode = require("vscode");
const util   = require("util");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");

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
        return {};
    }

    async invoke(options, _token) {
        const action = options.input?.action || 'read';

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
            const count = expr.split('\n').filter(l => l.trim()).length;
            return { invocationMessage: `Evaluate ${count} expression${count !== 1 ? 's' : ''} in kernel` };
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

        const timeoutSec = Number(options.input?.timeoutSeconds) || 10;

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
            // Strip lines that are purely WL comments (* ... *) — they evaluate to Null
            // and waste a round-trip; also strip blank lines.
            const lines = expression.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0 && !/^\(\*.*\*\)$/.test(l));
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
            const mkWrapped = (expr, wlSec) =>
                `Block[{$wbR$}, $wbR$ = TimeConstrained[(${expr}), ${wlSec}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;

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
        // If result is already a String return it raw; otherwise convert via InputForm
        // to avoid double-quoting (e.g. VsCodeSymbolMarkdown returns a String directly).
        const wlTimeout = Math.max(1, timeoutSec - 1);
        const wrappedExpr =
            `Block[{$wbR$}, $wbR$ = TimeConstrained[(${expression}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;

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
            return new vscode.NotebookCellData(ck, c.content || '', langId);
        });

        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, cellDatas)]);
        await vscode.workspace.applyEdit(edit);

        // Reveal the inserted block
        try {
            editor.selection = new vscode.NotebookRange(insertIdx, insertIdx + cells.length);
            editor.revealRange(
                new vscode.NotebookRange(insertIdx, insertIdx + 1),
                vscode.NotebookEditorRevealType.Default
            );
        } catch (_) {}

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

        // ── evaluate option: run the last inserted code cell ────────────────
        const evaluate = !!options.input?.evaluate;
        if (evaluate) {
            // Find the last code cell in the inserted block
            let lastCodeIdx = -1;
            for (let i = cells.length - 1; i >= 0; i--) {
                if ((cells[i].kind || 'code') !== 'markdown') { lastCodeIdx = i; break; }
            }
            if (lastCodeIdx >= 0) {
                const controller = this._getController?.();
                if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
                    lines.push('\n[evaluate] Kernel is not running — cells inserted but not evaluated.');
                } else if (controller._evalDispatched) {
                    lines.push('\n[evaluate] Kernel is busy — cells inserted but not evaluated.');
                } else {
                    const evalContent = cells[lastCodeIdx].content || '';
                    const timeoutSec = Number(options.input?.timeoutSeconds) || 15;
                    const wlTimeout  = Math.max(1, timeoutSec - 1);
                    const wrappedExpr =
                        `Block[{$wbR$}, $wbR$ = TimeConstrained[(${evalContent}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;
                    try {
                        const result = await Promise.race([
                            controller.session.evaluate(wrappedExpr, { interactive: false }),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutSec * 1000))
                        ]);
                        let evalOut = '';
                        if (result?.messages?.length) {
                            evalOut += result.messages.map(m => `[message] ${cleanWrapperFromMsg(m)}`).join('\n') + '\n';
                        }
                        if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                            evalOut += `Timed out after ${wlTimeout}s.`;
                        } else if (result?.result?.type === 'string' && result.result.value) {
                            let val = result.result.value.replace(/\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
                            if (val.length > 4096) val = val.slice(0, 4096) + '\n[output truncated]';
                            evalOut += `Out= ${val}`;
                        } else {
                            evalOut += '(no output)';
                        }
                        lines.push('\n[evaluate]\n' + evalOut.trim());
                        appendEvalLog(evalContent, evalOut.trim());
                    } catch (err) {
                        lines.push(`\n[evaluate] ${err.message === 'timeout' ? `Timed out after ${timeoutSec}s.` : `Error: ${err.message}`}`);
                    }
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
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
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
        const newContent = String(options.input?.content ?? cell.document.getText());

        // Use a plain TextEdit on the cell's existing document URI rather than
        // NotebookEdit.replaceCells — the latter replaces the whole cell object
        // which VS Code tracks as a structural notebook change and shows a diff
        // dialog.  A TextEdit on the cell document URI is an in-place text change
        // with no diff tracking.
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
            editor.revealRange(new vscode.NotebookRange(idx, idx + 1), vscode.NotebookEditorRevealType.Default);
        } catch (_) {}

        const editedMsg = `Edited Cell ${cellNumber} (index ${idx}, CellId: ${cellId}) of ${notebook.cellCount} in ${notebook.uri.fsPath.split('/').pop()}.`;
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

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(editedMsg)]);
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
            const stopOnError = options.input?.stopOnError === true;

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
                results.push(`Cell ${n}: ${status} \u2014 ${outs.join(' | ').slice(0, 800) || '(no output)'}`);

                if (stopOnError && hasError) { stopped = `stopped at Cell ${n} (stopOnError=true)`; break; }
            }

            const total  = notebook.cellCount;
            const header = startCell === 1 && endCell === total
                ? `Ran all cells (${codeCount} code cells, ${endCell - startCell + 1 - codeCount} markdown skipped):`
                : `Ran cells ${startCell}\u2013${endCell} (${codeCount} code cells, ${endCell - startCell + 1 - codeCount} markdown skipped):`;
            const lines = [header, ...results.map(r => '  ' + r)];
            if (stopped) lines.push(`  \u26A0\uFE0F ${stopped}`);
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
            resultParts.push(`\n⚠ Kernel messages (${msgOuts.length}):\n${msgOuts.join('\n')}`);
        }

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
        const wlExpr = [
            `Block[{$wbS$=Sort[Names["${safePattern}"]],`,
            `$wbTrunc$=Function[{str,maxLen},If[StringLength[str]>maxLen,StringTake[str,maxLen]<>"...",str]],`,
            // $wbFmt$ uses Function[sym,XXXX[sym],HoldAll]@@ToHeldExpression[s] to bypass HoldFirst
            `$wbFmt$=Function[s,Block[{`,
            `$wbOV$=Function[sym,OwnValues[sym],HoldAll]@@ToHeldExpression[s],`,
            `$wbDV$=Function[sym,DownValues[sym],HoldAll]@@ToHeldExpression[s],`,
            `$wbSV$=Function[sym,SubValues[sym],HoldAll]@@ToHeldExpression[s],`,
            `$wbUV$=Function[sym,UpValues[sym],HoldAll]@@ToHeldExpression[s],`,
            `$wbL$={}},`,
            `Which[`,
            // OwnValues: show the assigned value
            `$wbOV$=!={},`,
            `$wbTrunc$[s<>" = "<>ToString[Symbol[s],InputForm],150],`,
            // DownValues/SubValues/UpValues: show first 3 rules
            `$wbDV$=!={}||$wbSV$=!={}||$wbUV$=!={},`,
            `Block[{$wbLines$={}},`,
            `If[$wbDV$=!={},`,
            `$wbLines$=Join[$wbLines$,Map[$wbTrunc$[ToString[#,InputForm],150]&,Take[$wbDV$,UpTo[3]]]];`,
            `If[Length[$wbDV$]>3,$wbLines$=Append[$wbLines$,"  ... and "<>ToString[Length[$wbDV$]-3]<>" more rule(s)"]]`,
            `];`,
            `If[$wbSV$=!={},`,
            `$wbLines$=Append[$wbLines$,"  + "<>ToString[Length[$wbSV$]]<>" SubValue rule(s)"]`,
            `];`,
            `If[$wbUV$=!={},`,
            `$wbLines$=Append[$wbLines$,"  + "<>ToString[Length[$wbUV$]]<>" UpValue rule(s)"]`,
            `];`,
            `StringJoin[Riffle[$wbLines$,"\\n"]]`,
            `],`,
            `True,Nothing`,
            `]]]},`,
            `If[$wbS$==={},"(no symbols matching ${safePattern})",`,
            `With[{$wbLines$=Map[$wbFmt$,$wbS$]},`,
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
    }

    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'abort';
        if (action === 'restart') {
            return {
                invocationMessage: 'Restart Wolfram kernel',
                confirmationMessages: {
                    title: 'Restart Wolfram Kernel?',
                    message: new vscode.MarkdownString(
                        'This will **terminate the current kernel session** and start a fresh one. ' +
                        'All in-memory definitions and variable values will be lost. ' +
                        'Cell outputs already rendered in the notebook are preserved.'
                    )
                }
            };
        }
        return { invocationMessage: 'Abort current kernel evaluation' };
    }

    async invoke(options, _token) {
        const action = options.input?.action || 'abort';
        const controller = this._getController?.();
        if (!controller) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No kernel controller available.')]);
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

function registerTools(context, getController, debugCtrl) {
    const tools = [
        // Core notebook tools (visible in chat panel)
        { name: 'wolfbook_getNotebookContext', impl: new GetNotebookContextTool() },
        { name: 'wolfbook_evaluateExpression', impl: new EvaluateExpressionTool(getController) },
        { name: 'wolfbook_lookupSymbol',       impl: new LookupSymbolTool(getController) },
        { name: 'wolfbook_insertCells',        impl: new InsertCellsTool(getController) },
        { name: 'wolfbook_editCell',           impl: new EditCellTool(getController) },
        { name: 'wolfbook_runCell',            impl: new RunCellTool() },
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
        // Wolfteam tools
        { name: 'wolfteam_proposePlan',        impl: new ProposePlanTool() },
        { name: 'wolfteam_askDecision',        impl: new AskDecisionTool() },
        { name: 'wolfteam_checkpoint',         impl: new CheckpointTool() },
    ];

    for (const { name, impl } of tools) {
        if (vscode.lm && vscode.lm.registerTool) {
            context.subscriptions.push(vscode.lm.registerTool(name, impl));
        }
    }
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
            'wolfbook_deleteCell', 'wolfbook_restoreDeletedCells',
            'wolfbook_moveCell', 'wolfbook_searchCells', 'wolfbook_getKernelState',
            'wolfbook_kernelControl', 'wolfbook_kernelCrashLog',
            'wolfbook_findPackage', 'wolfbook_debugCell',
            'wolfbook_fileOps', 'wolfbook_runTerminal',
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
            'wolfbook_deleteCell', 'wolfbook_restoreDeletedCells',
            'wolfbook_moveCell', 'wolfbook_searchCells', 'wolfbook_getKernelState',
            'wolfbook_kernelControl', 'wolfbook_kernelCrashLog',
            'wolfbook_findPackage', 'wolfbook_debugCell',
            'wolfbook_fileOps', 'wolfbook_runTerminal',
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
