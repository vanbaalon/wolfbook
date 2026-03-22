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

function buildTranscript(notebook, startCell, endCell) {
    const decoder = new util.TextDecoder();
    const lines   = [];
    const title   = notebook.uri.fsPath.split('/').pop().replace(/\.[^.]+$/, '');
    const total   = notebook.cellCount;
    const from    = Math.max(1, startCell || 1);
    const to      = Math.min(total, endCell || total);
    const isRange = from !== 1 || to !== total;
    lines.push(`# ${title}`);
    const rangeNote = isRange ? ` (showing cells ${from}–${to})` : '';
    lines.push(`Notebook: ${total} cell${total !== 1 ? 's' : ''}${rangeNote}. Cell numbers are 1-based. To insert after Cell N, pass position=N to wolfbook_insertCell (position=0 inserts before Cell 1).\n`);

    for (let i = from - 1; i < to; i++) {
        const cell   = notebook.cellAt(i);
        const cellNo = i + 1;  // 1-based; equals the position value to insert after this cell

        if (cell.kind === vscode.NotebookCellKind.Markup) {
            const src = cell.document.getText().trim();
            lines.push(`### Cell ${cellNo} [markdown]`);
            lines.push(src || '*(empty)*');
            lines.push('');
            continue;
        }

        // Code cell
        const src = cell.document.getText();
        lines.push(`### Cell ${cellNo} [wolfram]`);
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

// Detect kernel crash / WSTP disconnection errors from session.evaluate() rejections.
// These require a kernel restart — further evals will keep failing until the user restarts.
function isKernelConnectionError(msg) {
    return /wstp|connection was lost|send packet|kernel (crashed|disconnected)|lost connection/i.test(msg);
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
// wolfbook_switchNotebook — list open notebooks or switch to a specific one
// ---------------------------------------------------------------------------

class SwitchNotebookTool {
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'list';
        const nb     = options.input?.notebook;
        return { invocationMessage: action === 'list'
            ? 'List open notebooks'
            : `Switch to notebook: ${nb}` };
    }

    async invoke(options, _token) {
        const action   = options.input?.action || 'list';
        const notebook = options.input?.notebook;

        // Collect all open Wolfram notebooks
        const allDocs = vscode.workspace.notebookDocuments
            .filter(d => d.notebookType === 'extended-wolfram-notebook');

        if (action === 'list') {
            if (allDocs.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No Wolfram notebooks are currently open.')
                ]);
            }

            const activeUri = vscode.window.activeNotebookEditor?.notebook.uri.toString();
            const lines = [`**${allDocs.length} open notebook(s):**\n`];
            for (const doc of allDocs) {
                const name       = doc.uri.fsPath.split('/').pop();
                const codeCells  = [];
                const mdCells    = [];
                for (let i = 0; i < doc.cellCount; i++) {
                    const c = doc.cellAt(i);
                    if (c.kind === vscode.NotebookCellKind.Code) codeCells.push(i + 1);
                    else mdCells.push(i + 1);
                }
                const isActive = doc.uri.toString() === activeUri ? ' ← **active**' : '';
                lines.push(`- **${name}** — ${doc.cellCount} cells (${codeCells.length} code, ${mdCells.length} markdown)${isActive}`);
            }
            lines.push('\nTo switch: call wolfbook_switchNotebook with action="switch" and notebook="filename.wb".');
            lines.push('You can also pass notebook="filename.wb" directly to wolfbook_getNotebookContext to read a specific notebook without switching.');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(lines.join('\n'))
            ]);
        }

        // action === 'switch'
        if (!notebook) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('notebook parameter is required for action="switch". Use action="list" to see open notebooks.')
            ]);
        }

        const editor = await resolveNotebookEditor(notebook);
        if (!editor) {
            const available = allDocs.map(d => d.uri.fsPath.split('/').pop()).join(', ');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Notebook "${notebook}" not found among open notebooks. Available: ${available || '(none)'}`
                )
            ]);
        }

        const name       = editor.notebook.uri.fsPath.split('/').pop();
        const cellCount  = editor.notebook.cellCount;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Switched to **${name}** (${cellCount} cells). All tools now target this notebook.`
            )
        ]);
    }
}

// ---------------------------------------------------------------------------
// TODO-4a: wolfbook_getNotebookContext
// ---------------------------------------------------------------------------

class GetNotebookContextTool {
    async prepareInvocation(_options, _token) {
        return {};
    }

    async invoke(_options, _token) {
        const targetName = _options.input?.notebook;
        const editor = await resolveNotebookEditor(targetName);
        if (!editor) {
            const notFoundMsg = targetName
                ? `Notebook "${targetName}" is not open. Use wolfbook_switchNotebook with action:"list" to see open notebooks.`
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
        const startCell = _options.input?.startCell;
        const endCell   = _options.input?.endCell;
        const transcript = buildTranscript(notebook, startCell, endCell);
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
            const cleanMsg = (m) => m
                .replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*TimeConstrained\[\(/g, '(')
                .replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*\(/g, '(')
                .replace(/\);\s*If\[StringQ\[\$wbR\$\].*?\]\]/gs, ')');

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
                    const msgs = (result?.messages ?? []).map(m => `[message] ${cleanMsg(m)}`);
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
                const clean = result.messages.map(m =>
                    m.replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*TimeConstrained\[\(/g, '(')
                     .replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*\(/g, '(')
                     .replace(/\);\s*If\[StringQ\[\$wbR\$\].*?\]\]/gs, ')')
                );
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
// Helper: fetch and strip a Wolfram documentation page
// ---------------------------------------------------------------------------

function fetchWolframDocPage(symbolName) {
    // Sanitise: only allow characters valid in a WL symbol name (security: prevents path traversal)
    const safeName = symbolName.replace(/[^A-Za-z0-9$]/g, '');
    if (!safeName) return Promise.resolve('Invalid symbol name.');
    const url = `https://reference.wolfram.com/language/ref/${safeName}.html`;
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 404) {
                resolve(`No online documentation found for \`${safeName}\`.\n(Only built-in System-context symbols have pages at ${url})`);
                return;
            }
            if (res.statusCode !== 200) {
                resolve(`HTTP ${res.statusCode} from ${url}`);
                return;
            }
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                const text = data
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
                    .replace(/[ \t]+/g, ' ')
                    .replace(/\n[ \t]+/g, '\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                const cap = 10000;
                const out = text.length > cap
                    ? text.slice(0, cap) + `\n\n[...truncated — full page: ${url}]`
                    : text;
                resolve(out);
            });
        });
        req.on('error', (err) => resolve(`Network error: ${err.message}`));
        req.on('timeout', () => { req.destroy(); resolve('Timed out fetching documentation.'); });
    });
}

// ---------------------------------------------------------------------------
// TODO-4c: wolfbook_lookupSymbol
// ---------------------------------------------------------------------------

class LookupSymbolTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        return { invocationMessage: `Look up symbol: ${options.input?.symbol || '?'}` };
    }

    async invoke(options, token) {
        const symbol = (options.input?.symbol || '').trim();
        if (!symbol) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: no symbol name provided.')
            ]);
        }

        const controller = this._getController();
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: kernel is not running.')
            ]);
        }

        if (controller._evalDispatched) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Kernel is busy — a notebook cell is currently evaluating.\n' +
                    'Wait for it to finish or use the Abort button, then try again.'
                )
            ]);
        }

        // longForm (default true): appends a link to the online Wolfram docs for System symbols.
        const longForm = options.input?.longForm !== false;
        // Call VsCodeSymbolMarkdown defined in init.wl — returns formatted markdown
        // with usage (box notation converted to LaTeX), options table, and optional doc link.
        const lf = longForm ? 'True' : 'False';
        const expr = `VsCodeSymbolMarkdown["${symbol.replace(/"/g, '')}", ${lf}]`;

        try {
            const result = await Promise.race([
                controller.session.evaluate(expr, { interactive: false }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
            ]);
            if (token.isCancellationRequested) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('Cancelled.')
                ]);
            }
            const val = result?.result?.type === 'string' ? result.result.value : '(no result)';
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(val)
            ]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: ${err.message}`)
            ]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_getSymbolWebHelp — fetch full Wolfram documentation page
// ---------------------------------------------------------------------------

class GetSymbolWebHelpTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Fetching online docs for: ${options.input?.symbol || '?'}` };
    }

    async invoke(options, _token) {
        const symbol = (options.input?.symbol || '').trim();
        if (!symbol) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: no symbol name provided.')
            ]);
        }
        try {
            const content = await fetchWolframDocPage(symbol);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(content)
            ]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: ${err.message}`)
            ]);
        }
    }
}

// ---------------------------------------------------------------------------
// TODO-4d: wolfbook_insertCell
// ---------------------------------------------------------------------------

class InsertCellTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const kind     = options.input?.kind     || 'code';
        const content  = options.input?.content  || '';
        const pos      = options.input?.position;
        const evaluate = !!options.input?.evaluate;
        const posStr   = typeof pos === 'number' ? `at index ${pos}` : pos;
        const preview  = content.length > 120 ? content.slice(0, 120) + '…' : content;
        const verb     = (evaluate && kind !== 'markdown') ? 'Insert & evaluate' : 'Insert';
        return {
            invocationMessage: `${verb} ${kind} cell ${posStr}:\n\`\`\`\n${preview}\n\`\`\``
        };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor();
        if (!editor) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active notebook editor.')
            ]);
        }

        const notebook = editor.notebook;
        const kind     = options.input?.kind    || 'code';
        const content  = options.input?.content || '';
        const position = options.input?.position;

        // Resolve insertion index
        let insertIdx;
        if (position === 'end') {
            insertIdx = notebook.cellCount;
        } else if (position === 'after-cursor') {
            const sel = editor.selection;
            insertIdx = (sel && sel.start != null) ? sel.start + 1 : notebook.cellCount;
        } else if (typeof position === 'number') {
            insertIdx = Math.max(0, Math.min(position, notebook.cellCount));
        } else {
            insertIdx = notebook.cellCount;
        }

        const cellKind = kind === 'markdown'
            ? vscode.NotebookCellKind.Markup
            : vscode.NotebookCellKind.Code;
        const langId   = kind === 'markdown' ? 'markdown' : 'wolfram';

        const cellData = new vscode.NotebookCellData(cellKind, content, langId);
        const edit     = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, [cellData])]);
        await vscode.workspace.applyEdit(edit);

        // Move selection to the newly inserted cell
        try {
            editor.selection = new vscode.NotebookRange(insertIdx, insertIdx + 1);
            editor.revealRange(
                new vscode.NotebookRange(insertIdx, insertIdx + 1),
                vscode.NotebookEditorRevealType.Default
            );
        } catch (_) {}

        // insertIdx is 0-based; after applyEdit the new cell is at 1-based = insertIdx + 1
        const newCellNumber = insertIdx + 1;
        const totalAfter    = notebook.cellCount;
        const nbName        = notebook.uri.fsPath.split('/').pop();
        const insertedMsg   = `Inserted ${kind} cell as Cell ${newCellNumber} of ${totalAfter} in ${nbName}.`;
        appendEventLog(`📥 INSERT ${kind.toUpperCase()} CELL at position ${newCellNumber}`,
            content.trim().length > 200 ? content.trim().slice(0, 200) + '\u2026' : content.trim() || '*(empty)*');

        // ── evaluate option ─────────────────────────────────────────────────────
        // If evaluate:true and it's a code cell, run the content in the kernel and
        // return the result alongside the insert confirmation.
        const evaluate = !!options.input?.evaluate;
        if (evaluate && kind !== 'markdown' && content.trim()) {
            const controller = this._getController?.();
            if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        insertedMsg + '\n[evaluate] Kernel is not running — cell inserted but not evaluated.'
                    )
                ]);
            }
            if (controller._evalDispatched) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        insertedMsg + '\n[evaluate] Kernel is busy — cell inserted but not evaluated. Wait for the current evaluation to finish.'
                    )
                ]);
            }

            const timeoutSec = Number(options.input?.timeoutSeconds) || 15;
            const dynCount   = controller._dynCells?.size ?? 0;
            // TimeConstrained fires 1 s before JS deadline — WL aborts cleanly.
            const wlTimeout  = Math.max(1, timeoutSec - 1);
            const wrappedExpr =
                `Block[{$wbR$}, $wbR$ = TimeConstrained[(${content}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;

            try {
                const result = await Promise.race([
                    controller.session.evaluate(wrappedExpr, { interactive: false }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutSec * 1000))
                ]);
                if (token.isCancellationRequested) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(insertedMsg + '\n[evaluate] Cancelled.')
                    ]);
                }
                let evalOut = '';
                if (dynCount > 0) evalOut += `[note] ${dynCount} Dynamic widget(s) active\n`;
                if (result?.messages?.length) {
                    const clean = result.messages.map(m =>
                        m.replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*TimeConstrained\[\(/g, '(')
                         .replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*\(/g, '(')
                         .replace(/\);\s*If\[StringQ\[\$wbR\$\].*?\]\]/gs, ')')
                    );
                    evalOut += clean.map(m => `[message] ${m}`).join('\n') + '\n';
                }
                if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                    evalOut += `Timed out after ${wlTimeout}s — kernel is still alive.\n` +
                        `Simplify the expression or increase timeoutSeconds.`;
                } else if (result?.result?.type === 'string' && result.result.value) {
                    let val = result.result.value.replace(
                        /\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))
                    );
                    const MAX = 4096, truncated = val.length > MAX;
                    if (truncated) val = val.slice(0, MAX);
                    evalOut += `Out= ${val}`;
                    if (truncated) evalOut += `\n[output truncated — ${result.result.value.length} chars total]`;
                } else if (result?.result?.type === 'abort') {
                    evalOut += 'Evaluation aborted.';
                } else {
                    evalOut += '(no output)';
                }
                const finalMsg = insertedMsg + '\n\n[evaluate]\n' + evalOut.trim();
                appendEvalLog(content, evalOut.trim());
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(finalMsg)
                ]);
            } catch (err) {
                const errMsg = err.message === 'timeout'
                    ? `Evaluation timed out after ${timeoutSec}s — kernel interrupted.`
                    : isKernelConnectionError(err.message)
                        ? KERNEL_CRASH_MSG
                        : `Evaluation error: ${err.message}`;
                if (err.message === 'timeout' && !controller._evalDispatched) {
                    try { controller.session.abort?.(); } catch (_) {}
                }
                appendEvalLog(content, errMsg);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(insertedMsg + '\n[evaluate] ' + errMsg)
                ]);
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(insertedMsg)
        ]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_insertCells — insert a contiguous block of cells in one operation
// ---------------------------------------------------------------------------

class InsertCellsTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const cells  = options.input?.cells || [];
        const pos    = options.input?.position;
        const posStr = typeof pos === 'number' ? `after Cell ${pos}` : (pos || 'end');
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
        const cells    = options.input?.cells;
        if (!Array.isArray(cells) || cells.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('cells must be a non-empty array of { kind, content } objects.')
            ]);
        }

        const position = options.input?.position;
        let insertIdx;
        if (position === 'end' || position == null) {
            insertIdx = notebook.cellCount;
        } else if (position === 'after-cursor') {
            const sel = editor.selection;
            insertIdx = (sel && sel.start != null) ? sel.start + 1 : notebook.cellCount;
        } else if (typeof position === 'number') {
            insertIdx = Math.max(0, Math.min(position, notebook.cellCount));
        } else {
            insertIdx = notebook.cellCount;
        }

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
            lines.push(`- Cell ${firstNew + i} [${c.kind || 'code'}]: ${preview}${
                (c.content || '').trim().length > 80 ? '\u2026' : ''}`);
        });
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_deleteCell — remove one or more cells; save content to recovery file
// ---------------------------------------------------------------------------

class DeleteCellTool {
    async prepareInvocation(options, _token) {
        const nums = Array.isArray(options.input?.cellNumbers)
            ? options.input.cellNumbers
            : (options.input?.cellNumber != null ? [options.input.cellNumber] : []);
        return { invocationMessage: nums.length === 1
            ? `Delete Cell ${nums[0]} from notebook`
            : `Delete ${nums.length} cells from notebook: [${nums.join(', ')}]` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook = editor.notebook;

        // Accept a single cellNumber or an array cellNumbers
        let cellNums;
        if (Array.isArray(options.input?.cellNumbers) && options.input.cellNumbers.length > 0) {
            cellNums = options.input.cellNumbers.map(Number);
        } else if (options.input?.cellNumber != null) {
            cellNums = [Number(options.input.cellNumber)];
        } else {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Provide cellNumber (single) or cellNumbers (array).'
            )]);
        }

        // Validate all numbers before starting
        const invalid = cellNums.filter(n => !Number.isInteger(n) || n < 1 || n > notebook.cellCount);
        if (invalid.length > 0) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Invalid cell number(s): ${invalid.join(', ')}. Notebook has ${notebook.cellCount} cell(s).`
            )]);
        }

        // Deduplicate; sort descending so each deletion doesn't shift remaining indices
        const sortedDesc = [...new Set(cellNums)].sort((a, b) => b - a);
        const saveToRecovery = options.input?.saveToRecovery !== false;
        const notebookPath  = notebook.uri.fsPath;
        const recoveryDir   = path.join(path.dirname(notebookPath), 'img',
            path.basename(notebookPath, path.extname(notebookPath)));
        const recoveryPath  = path.join(recoveryDir, 'ai_deleted_cells.md');
        const deleted = [];  // collected in descending order, re-sorted for display

        for (const cellNumber of sortedDesc) {
            const idx     = cellNumber - 1;
            const cell    = notebook.cellAt(idx);
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

            deleted.push({ cellNumber, kindStr, source });
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
                `Deleted ${d.kindStr} Cell ${d.cellNumber}${recovery}. Notebook now has ${totalAfter} cell(s).\nContent: ${preview}${d.source.trim().length > 100 ? '\u2026' : ''}`
            )]);
        }

        // Multi-cell summary
        const lines = [`Deleted ${deleted.length} cells${recovery}. Notebook now has ${totalAfter} cell(s).\n`];
        for (const d of deleted) {
            const preview = d.source.trim().slice(0, 100).replace(/\n/g, '\u21b5');
            lines.push(`- Cell ${d.cellNumber} [${d.kindStr}]: ${preview}${d.source.trim().length > 100 ? '\u2026' : ''}`);
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
        let insertIdx;
        if (insertPos == null || insertPos === 'end') {
            insertIdx = notebook.cellCount;
        } else if (typeof insertPos === 'number') {
            insertIdx = Math.max(0, Math.min(Number(insertPos), notebook.cellCount));
        } else {
            insertIdx = notebook.cellCount;
        }

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
            const preview    = e.source.trim().slice(0, 100).replace(/\n/g, '\u21b5');
            lines.push(`- Cell ${newCellNum} [${e.kind}] (was Cell ${e.originalCell} at ${e.timestamp}): ${preview}${e.source.trim().length > 100 ? '\u2026' : ''}`);
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
        const n       = options.input?.cellNumber;
        const content = String(options.input?.content || '');
        const preview = content.length > 100 ? content.slice(0, 100) + '…' : content;
        const evaluate = !!options.input?.evaluate;
        const verb = evaluate ? 'Edit & evaluate' : 'Edit';
        return { invocationMessage: `${verb} Cell ${n}:\n\`\`\`\n${preview}\n\`\`\`` };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook   = editor.notebook;
        const cellNumber = Number(options.input?.cellNumber);
        if (!Number.isInteger(cellNumber) || cellNumber < 1 || cellNumber > notebook.cellCount) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Invalid cellNumber ${cellNumber}. Notebook has ${notebook.cellCount} cell(s).`
            )]);
        }

        const idx        = cellNumber - 1;
        const cell       = notebook.cellAt(idx);
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

        const editedMsg = `Edited Cell ${cellNumber} of ${notebook.cellCount} in ${notebook.uri.fsPath.split('/').pop()}.`;
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
                    const clean = result.messages.map(m =>
                        m.replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*TimeConstrained\[\(/g, '(')
                         .replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*\(/g, '(')
                         .replace(/\);\s*If\[StringQ\[\$wbR\$\].*?\]\]/gs, ')')
                    );
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
        const n = options.input?.cellNumber;
        return { invocationMessage: `Run Cell ${n} in notebook` };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook   = editor.notebook;
        const cellNumber = Number(options.input?.cellNumber);
        if (!Number.isInteger(cellNumber) || cellNumber < 1 || cellNumber > notebook.cellCount) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Invalid cellNumber ${cellNumber}. Notebook has ${notebook.cellCount} cell(s).`
            )]);
        }

        const idx  = cellNumber - 1;
        const cell = notebook.cellAt(idx);
        if (cell.kind === vscode.NotebookCellKind.Markup) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Cell ${cellNumber} is a markdown cell — nothing to run.`
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
            resultParts.push(`Cell ${cellNumber} of ${total} timed out after ${timeoutSec}s (execution may still be running).`);
        } else {
            resultParts.push(`Cell ${cellNumber} of ${total} executed${timingStr}.`);
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
        //   — shows OwnValue (direct value) or rule-count for DownValues/UpValues
        //   — truncates long values to 150 chars
        //   — skips symbols with no definitions at all (pure name slots)
        const wlExpr = [
            `Block[{$wbS$=Sort[Names["${safePattern}"]],`,
            `$wbFmt$=Function[s,Block[{$wbSym$=Symbol[s]},`,
            `Which[`,
            `OwnValues[$wbSym$]=!={},`,
            `With[{v=s<>" = "<>ToString[$wbSym$,InputForm]},`,
            `If[StringLength[v]>150,StringTake[v,150]<>"...",v]`,
            `],`,
            `DownValues[$wbSym$]=!={}||UpValues[$wbSym$]=!={},`,
            `s<>" := <"<>ToString[Length[DownValues[$wbSym$]]+Length[UpValues[$wbSym$]]]<>" rule(s)>",`,
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

class SaveNotebookTool {
    async prepareInvocation(_options, _token) {
        return { invocationMessage: 'Save notebook to disk' };
    }

    async invoke(_options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active notebook editor.')
            ]);
        }
        try {
            await vscode.workspace.save(editor.notebook.uri);
            const name = editor.notebook.uri.fsPath.split('/').pop();
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Saved: ${name}`)
            ]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Save failed: ${err.message}`)
            ]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_restartKernel — restart the Wolfram kernel (asks user confirmation)
// ---------------------------------------------------------------------------

class RestartKernelTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(_options, _token) {
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

    async invoke(_options, _token) {
        const controller = this._getController?.();
        if (!controller) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No kernel controller available.')]);
        }
        try {
            await controller.restartKernel();
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Kernel restarted successfully.')]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Restart failed: ${err.message}`)]);
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_abortEvaluation — abort the currently running kernel evaluation
// ---------------------------------------------------------------------------

class AbortEvaluationTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(_options, _token) {
        return { invocationMessage: 'Abort current kernel evaluation' };
    }

    async invoke(_options, _token) {
        const controller = this._getController?.();
        if (!controller) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No kernel controller available.')]);
        }
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
        const from = options.input?.cellNumber;
        const to   = options.input?.toPosition;
        return { invocationMessage: `Move Cell ${from} to after position ${to}` };
    }

    async invoke(options, _token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook   = editor.notebook;
        const cellNumber = Number(options.input?.cellNumber);
        const toPosition = Number(options.input?.toPosition);  // insert AFTER this 1-based cell (0 = make first)

        if (!Number.isInteger(cellNumber) || cellNumber < 1 || cellNumber > notebook.cellCount) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Invalid cellNumber ${cellNumber}. Notebook has ${notebook.cellCount} cell(s).`
            )]);
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

        const fromIdx  = cellNumber - 1;
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

        const kindStr = kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
        appendEventLog(`\u2195\uFE0F MOVE ${kindStr.toUpperCase()} CELL ${cellNumber} \u2192 position ${newPos}`,
            source.trim().slice(0, 100) || '*(empty)*');
        const posLabel = toPosition === 0 ? 'beginning' : `after Cell ${toPosition}`;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `Moved ${kindStr} Cell ${cellNumber} to position ${newPos} (${posLabel}). Notebook now has ${notebook.cellCount} cell(s).`
        )]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_runAllCells — run a range of cells sequentially and return outputs
// ---------------------------------------------------------------------------

class RunAllCellsTool {
    async prepareInvocation(options, _token) {
        const start = options.input?.startCell;
        const end   = options.input?.endCell;
        if (start || end) return { invocationMessage: `Run cells ${start || 1}\u2013${end || '\u2026'} sequentially` };
        return { invocationMessage: 'Run all cells in notebook sequentially' };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor();
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

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
            if (cell.kind === vscode.NotebookCellKind.Markup) continue;  // skip markdown

            const remaining = deadline - Date.now();
            if (remaining <= 0) { stopped = `global timeout (${timeoutSec}s) reached before Cell ${n}`; break; }

            const prevEndTime = cell.executionSummary?.timing?.endTime ?? 0;
            editor.selection = new vscode.NotebookRange(idx, idx + 1);
            await vscode.commands.executeCommand('notebook.cell.execute');

            // Poll until this cell finishes; cap per-cell at 5 min or global deadline
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

            const outs     = [];
            let   hasError = false;
            for (const output of updatedCell.outputs) {
                const plainItem = output.items.find(it => it.mime === 'text/plain');
                if (plainItem) {
                    try {
                        const txt = decoder.decode(plainItem.data).trim();
                        if (txt) { outs.push(txt); if (txt.includes('[message]')) hasError = true; }
                    } catch (_) {}
                }
            }

            const cellTiming  = updatedCell.executionSummary?.timing;
            const cellTimingStr = (!timedOut && cellTiming?.startTime && cellTiming?.endTime)
                ? ` ${((cellTiming.endTime - cellTiming.startTime) / 1000).toFixed(2)}s`
                : '';
            const status = timedOut ? '\u23F1 timeout' : `\u2713${cellTimingStr}`;
            const outStr = outs.length > 0 ? outs.join(' | ').slice(0, 800) : '(no output)';
            results.push(`Cell ${n}: ${status} \u2014 ${outStr}`);

            if (stopOnError && hasError) {
                stopped = `stopped at Cell ${n} (stopOnError=true, kernel message detected)`;
                break;
            }
        }

        const total  = notebook.cellCount;
        const header = startCell === 1 && endCell === total
            ? `Ran all cells (${codeCount} code cells executed, ${endCell - startCell + 1 - codeCount} markdown skipped):`
            : `Ran cells ${startCell}\u2013${endCell} (${codeCount} code cells, ${endCell - startCell + 1 - codeCount} markdown skipped):`;
        const lines = [header, ...results.map(r => '  ' + r)];
        if (stopped) lines.push(`  \u26A0\uFE0F ${stopped}`);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
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
                matches.push(`Cell ${cellNo} [${cellKind}] (${matchedIn.join('+')}) — ${preview}${src.trim().length > 120 ? '\u2026' : ''}`);
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
// wolfbook_evaluateAndInsert — evaluate expression, then insert as cell if
// the evaluation succeeds (no messages, or result matches expectedOutput)
// ---------------------------------------------------------------------------

class EvaluateAndInsertTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const expr    = options.input?.expression || '(none)';
        const preview = expr.length > 120 ? expr.slice(0, 120) + '…' : expr;
        return { invocationMessage: `Evaluate & insert: ${preview}` };
    }

    async invoke(options, token) {
        const expression = options.input?.expression;
        if (!expression || !expression.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: no expression provided.')
            ]);
        }

        const timeoutSec     = Number(options.input?.timeoutSeconds) || 15;
        const expectedOutput = options.input?.expectedOutput != null
            ? String(options.input.expectedOutput).trim()
            : null;
        const position = options.input?.position ?? 'end';

        const controller = this._getController?.();
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: kernel is not running.')
            ]);
        }
        if (controller._evalDispatched) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Kernel is busy — wait for the current evaluation to finish, then try again.')
            ]);
        }

        // ── Evaluate ─────────────────────────────────────────────────────────
        const wlTimeout   = Math.max(1, timeoutSec - 1);
        const wrappedExpr =
            `Block[{$wbR$}, $wbR$ = TimeConstrained[(${expression}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;

        const singlePrints = [];
        let evalResult;
        try {
            evalResult = await Promise.race([
                controller.session.evaluate(wrappedExpr, {
                    interactive: false,
                    onPrint: p => singlePrints.push(p.replace(/\\012/g, '\n'))
                }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutSec * 1000))
            ]);
        } catch (err) {
            if (err.message === 'timeout') {
                try { controller.session.abort?.(); } catch (_) {}
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Timed out after ${timeoutSec}s — expression not inserted. Simplify or increase timeoutSeconds.`
                    )
                ]);
            }
            if (isKernelConnectionError(err.message)) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Kernel connection lost — ${KERNEL_CRASH_MSG}`)
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Evaluation error: ${err.message}`)
            ]);
        }

        if (token.isCancellationRequested) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Cancelled — expression not inserted.')
            ]);
        }

        // ── Collect result ────────────────────────────────────────────────────
        const cleanMsg = (m) => m
            .replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*TimeConstrained\[\(/g, '(')
            .replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*\(/g, '(')
            .replace(/\);\s*If\[StringQ\[\$wbR\$\].*?\]\]/gs, ')');

        const lines    = [];
        if (singlePrints.length) lines.push(`Print:\n${singlePrints.join('').replace(/\n$/, '')}`);
        const messages = (evalResult?.messages ?? []).map(m => cleanMsg(m));
        if (messages.length) lines.push(messages.map(m => `[message] ${m}`).join('\n'));

        let resultStr = '';
        if (evalResult?.result?.type === 'abort') {
            resultStr = '(aborted)';
        } else if (evalResult?.result?.type === 'string' && evalResult.result.value === '$WBTIMEOUT$') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Timed out after ${wlTimeout}s — expression not inserted. Increase timeoutSeconds.`
                )
            ]);
        } else if (evalResult?.result?.type === 'string' && evalResult.result.value) {
            resultStr = evalResult.result.value.replace(
                /\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))
            );
            if (resultStr.length > 4096) resultStr = resultStr.slice(0, 4096) + '\n[output truncated]';
        } else {
            resultStr = '(no output — likely a definition or suppressed expression)';
        }
        lines.push(`Result: ${resultStr}`);

        // ── Success check ─────────────────────────────────────────────────────
        let success, successReason;
        if (expectedOutput !== null) {
            const match = resultStr.trim() === expectedOutput || resultStr.trim().startsWith(expectedOutput);
            success       = match;
            successReason = match
                ? `output matched expected "${expectedOutput}"`
                : `output "${resultStr.trim().slice(0, 80)}" did not match expected "${expectedOutput}"`;
        } else {
            success       = messages.length === 0 && evalResult?.result?.type !== 'abort';
            successReason = success
                ? 'no kernel error messages'
                : messages.length > 0
                    ? `${messages.length} kernel message(s) — fix them first`
                    : 'evaluation was aborted';
        }

        if (!success) {
            lines.push(`\nNot inserted: ${successReason}.`);
            lines.push('Correct the expression and retry, or use wolfbook_insertCell to insert it manually regardless.');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(lines.join('\n'))
            ]);
        }

        // ── Insert cell ───────────────────────────────────────────────────────
        const editor = await resolveNotebookEditor();
        if (!editor) {
            lines.push('\nEvaluation succeeded but no active notebook editor — cell not inserted.');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(lines.join('\n'))
            ]);
        }

        const notebook = editor.notebook;
        let insertIdx;
        if (position === 'end') {
            insertIdx = notebook.cellCount;
        } else if (position === 'after-cursor') {
            const sel = editor.selection;
            insertIdx = (sel && sel.start != null) ? sel.start + 1 : notebook.cellCount;
        } else if (typeof position === 'number') {
            insertIdx = Math.max(0, Math.min(position, notebook.cellCount));
        } else {
            insertIdx = notebook.cellCount;
        }

        const cellData = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, expression, 'wolfram');
        const edit     = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, [cellData])]);
        await vscode.workspace.applyEdit(edit);

        try {
            editor.selection = new vscode.NotebookRange(insertIdx, insertIdx + 1);
            editor.revealRange(
                new vscode.NotebookRange(insertIdx, insertIdx + 1),
                vscode.NotebookEditorRevealType.Default
            );
        } catch (_) {}

        const newCellNumber = insertIdx + 1;
        const totalAfter    = notebook.cellCount;
        const nbName        = notebook.uri.fsPath.split('/').pop();
        lines.push(`\nInserted as Cell ${newCellNumber} of ${totalAfter} in ${nbName} (${successReason}).`);
        appendEventLog(
            `📥 EVAL+INSERT CODE CELL at position ${newCellNumber}`,
            expression.trim().length > 200 ? expression.trim().slice(0, 200) + '…' : expression.trim()
        );

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n'))
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration helper — called from extension.js activate()
// ---------------------------------------------------------------------------

function registerTools(context, getController, debugCtrl) {
    const tools = [
        { name: 'wolfbook_switchNotebook',       impl: new SwitchNotebookTool() },
        { name: 'wolfbook_getNotebookContext', impl: new GetNotebookContextTool() },
        { name: 'wolfbook_evaluateExpression', impl: new EvaluateExpressionTool(getController) },
        { name: 'wolfbook_evaluateAndInsert',   impl: new EvaluateAndInsertTool(getController) },
        { name: 'wolfbook_lookupSymbol',         impl: new LookupSymbolTool(getController) },
        { name: 'wolfbook_getSymbolWebHelp',    impl: new GetSymbolWebHelpTool() },
        { name: 'wolfbook_insertCell',           impl: new InsertCellTool(getController) },
        { name: 'wolfbook_insertCells',          impl: new InsertCellsTool(getController) },
        { name: 'wolfbook_deleteCell',              impl: new DeleteCellTool() },
        { name: 'wolfbook_restoreDeletedCells',     impl: new RestoreDeletedCellsTool() },
        { name: 'wolfbook_moveCell',             impl: new MoveCellTool() },
        { name: 'wolfbook_editCell',                impl: new EditCellTool(getController) },
        { name: 'wolfbook_runCell',              impl: new RunCellTool() },
        { name: 'wolfbook_runAllCells',          impl: new RunAllCellsTool() },
        { name: 'wolfbook_getKernelState',       impl: new GetKernelStateTool(getController) },
        { name: 'wolfbook_findPackage',          impl: new FindPackageTool(getController) },
        { name: 'wolfbook_saveNotebook',         impl: new SaveNotebookTool() },
        { name: 'wolfbook_restartKernel',        impl: new RestartKernelTool(getController) },
        { name: 'wolfbook_abortEvaluation',      impl: new AbortEvaluationTool(getController) },
        { name: 'wolfbook_kernelCrashLog',       impl: new KernelCrashLogTool() },
        { name: 'wolfbook_debugCell',            impl: new DebugCellTool(getController, debugCtrl) },
        { name: 'wolfbook_searchCells',           impl: new SearchCellsTool() },
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

const WOLFBOOK_SYSTEM_PROMPT = `You are **@wolfbook**, a Wolfram Language expert agent embedded inside a VS Code notebook.

## CRITICAL: You MUST use tools — do not answer from memory alone
- **Before answering any question about the notebook**, call \`#wolfbookContext\` to read the actual cells and outputs.
- **Before writing or editing any code**, call \`#wolfbookContext\` to see what is already defined.
- **Never describe what you would do** — use the tools to actually do it.
- If the user asks you to run something, use \`#wolfbookRunAll\` or \`#wolfbookRun\`.
- If the user asks you to add code, use \`#wolfbookInsertMany\` (2+ cells) or \`#wolfbookInsert\`.
- If the user asks about a symbol, use \`#wolfbookLookup\` or \`#wolfbookEval\`.

## Available tools
| Tool | Use when |
|------|----------|
| \`#wolfbookContext\` | Read all cells + outputs — call this FIRST for any notebook question |
| \`#wolfbookEval\` | Run a WL expression and get the result immediately |
| \`#wolfbookLookup\` | Look up usage, options, docs for any symbol |
| \`#wolfbookWebHelp\` | Fetch full Wolfram reference page for a built-in |
| \`#wolfbookInsertMany\` | Add 2+ cells in one operation (preferred over \`#wolfbookInsert\`) |
| \`#wolfbookInsert\` | Add a single cell |
| \`#wolfbookEdit\` | Replace source of existing cell; set evaluate:true to run immediately |
| \`#wolfbookRun\` | Execute an existing cell (Shift+Enter equivalent) |
| \`#wolfbookRunAll\` | Run a range of cells sequentially, get per-cell output |
| \`#wolfbookDelete\` | Delete cells (content saved for recovery) |
| \`#wolfbookRestore\` | List or re-insert recently deleted cells |
| \`#wolfbookMove\` | Move a cell to a different position |
| \`#wolfbookState\` | List all user-defined symbols + current values |
| \`#wolfbookSaveNotebook\` | Save notebook to disk |
| \`#wolfbookDebug\` | Step-through debugger: analyze, start, step, breakpoints, watch |
| \`#wolfbookRestart\` | Restart kernel (clears all definitions) |
| \`#wolfbookAbort\` | Interrupt a running evaluation |
| \`#wolfbookSwitch\` | List open notebooks or switch active notebook |
| \`#wolfbookCrashLog\` | Read kernel debug/crash logs |
| \`#wolfbookFindPkg\` | Discover packages on Paclet Server + GitHub; result includes ready-to-run \`PacletInstall[]\` commands and GitHub install workflow — run them via \`#wolfbookEval\` with \`timeoutSeconds:120\` |
| \`#wolfbookEvalInsert\` | Evaluate expression; if clean (no errors / output matches expected), append it as a new code cell — combines test + insert in one step |
| \`#wolfbookSearch\` | Search notebook cells for a pattern — returns matching cell numbers and previews |

## Wolfram Language essentials
- \`f[x_] := x^2\` — SetDelayed for function defs (evaluates at call time, not definition time)
- \`f[x_] = expr\` — Set; use only when expr is already fully numeric/symbolic
- \`Module[{vars}, body]\` — local variables; never leak into Global\`
- More specific patterns must come before general: \`f[0]:=…\` before \`f[n_]:=…\`
- \`NumericQ[Pi]\` is True; \`NumberQ[Pi]\` is False — use NumericQ for "has numeric value"
- Protected symbols (Pi, E, I, True, False, etc.) cannot be assigned
- Trailing \`;\` suppresses output; missing it causes unwanted output in multi-statement cells
- Use \`Association\` (not Rule lists) for structured data; \`Lookup\`, \`KeySelect\`, etc.
- For numerical work: set \`WorkingPrecision\`, use \`SetPrecision\`/\`Rationalize\`

## #wolfbookEval pitfall — multiLine:false
- **CRITICAL**: in single-expression mode (multiLine:false, the default), **newline-separated
  subexpressions are treated as multiplication** by the kernel (\`Times\`), NOT as sequential
  statements. \`a\nb\` evaluates to \`a*b\`, not first \`a\` then \`b\`.
- Always join multi-statement code with **semicolons** (\`a; b; c\`) in single-expression mode,
  or set \`multiLine:true\` to fire each line as a separate evaluation.

## #wolfbookRun success vs. output
- A cell that **defines functions** (e.g. \`f[x_]:=x^2\`) or uses trailing \`;\` naturally produces
  **no output** — the tool will say "(no output — definition or suppressed expression)".
  This is **correct and expected** — it does NOT mean the cell failed.
- Check for \`⚠ Kernel messages\` in the result: if present, the kernel emitted warnings or
  errors. Treat these as failures and fix the cell before proceeding.
- To verify a definition took effect, call \`#wolfbookEval\` (e.g. \`?f\`) or \`#wolfbookState\`.

## Cell kinds
- \`kind:"code"\` — Wolfram Language, evaluated by kernel
- \`kind:"markdown"\` — text, headings (\`#\`/\`##\`/\`###\`), LaTeX (\`$E=mc^2$\`) — never sent to kernel

## Long-running cells
- \`#wolfbookRun\` default timeout = **30 s**; \`#wolfbookRunAll\` default = **120 s**.
- Both accept a \`timeoutSeconds\` parameter — increase it when the computation is expected to be slow.
- If the tool returns "timed out … execution may still be running", **the kernel is still busy**.
  - To stop it: call \`#wolfbookAbort\` immediately.
  - To wait longer: call \`#wolfbookRun\` again with a larger \`timeoutSeconds\`.
- Never leave a timed-out cell silently — always abort or retry so the kernel is not left stuck.

## Response style
- Concise and precise. Match WL's terse style.
- When fixing a bug: one sentence of diagnosis, then the fix.
- Prefer \`#wolfbookInsertMany\` over multiple \`#wolfbookInsert\` calls.
`;

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
            'wolfbook_switchNotebook',
            'wolfbook_getNotebookContext', 'wolfbook_evaluateExpression', 'wolfbook_evaluateAndInsert',
            'wolfbook_lookupSymbol', 'wolfbook_getSymbolWebHelp',
            'wolfbook_insertCell', 'wolfbook_insertCells',
            'wolfbook_deleteCell', 'wolfbook_restoreDeletedCells',
            'wolfbook_moveCell', 'wolfbook_editCell', 'wolfbook_runCell',
            'wolfbook_runAllCells', 'wolfbook_getKernelState',
            'wolfbook_findPackage', 'wolfbook_saveNotebook',
            'wolfbook_restartKernel', 'wolfbook_abortEvaluation',
            'wolfbook_kernelCrashLog', 'wolfbook_debugCell',
            'wolfbook_searchCells'
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

module.exports = { registerTools, registerChatParticipant, buildTranscript, clearEvalLog };
