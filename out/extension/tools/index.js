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

// Rotate (truncate) the eval log at the start of every kernel session.
// Called from lifecycle.js on every kernel launch so the log only contains
// evaluations from the current kernel epoch.
function clearEvalLog() {
    try {
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
        if (!editor) return;
        const notebookPath = editor.notebook.uri.fsPath;
        const notebookDir  = path.dirname(notebookPath);
        const notebookName = path.basename(notebookPath, path.extname(notebookPath));
        const logPath      = path.join(notebookDir, 'img', notebookName, 'ai_eval_log.md');
        if (fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');
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

// ---------------------------------------------------------------------------
// Shared: build an in-memory transcript from the active notebook (TODO-2a / 4a)
// ---------------------------------------------------------------------------

function buildTranscript(notebook) {
    const decoder = new util.TextDecoder();
    const lines   = [];
    const title   = notebook.uri.fsPath.split('/').pop().replace(/\.[^.]+$/, '');
    const total   = notebook.cellCount;
    lines.push(`# ${title}`);
    lines.push(`Notebook: ${total} cell${total !== 1 ? 's' : ''}. Cell numbers are 1-based. To insert after Cell N, pass position=N to wolfbook_insertCell (position=0 inserts before Cell 1).\n`);

    for (let i = 0; i < notebook.cellCount; i++) {
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
// TODO-4a: wolfbook_getNotebookContext
// ---------------------------------------------------------------------------

class GetNotebookContextTool {
    async prepareInvocation(_options, _token) {
        return {};
    }

    async invoke(_options, _token) {
        const editor = vscode.window.activeNotebookEditor
            || vscode.window.visibleNotebookEditors[0];
        if (!editor) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No Wolfram notebook is currently open.')
            ]);
        }
        const notebook = editor.notebook;
        if (notebook.notebookType !== 'extended-wolfram-notebook') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('The active editor is not a Wolfram notebook.')
            ]);
        }
        const transcript = buildTranscript(notebook);
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
                const evalP    = controller.session.evaluate(mkWrapped(ln, wlSec), { interactive: false });
                const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), remaining));
                try {
                    const result = await Promise.race([evalP, timeoutP]);
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

        const evalPromise    = controller.session.evaluate(wrappedExpr, { interactive: false });
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
        const editor = vscode.window.activeNotebookEditor
            || vscode.window.visibleNotebookEditors[0];
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
// wolfbook_deleteCell — remove a cell and save its content to a recovery file
// ---------------------------------------------------------------------------

class DeleteCellTool {
    async prepareInvocation(options, _token) {
        const n = options.input?.cellNumber;
        return { invocationMessage: `Delete Cell ${n} from notebook` };
    }

    async invoke(options, _token) {
        const editor = vscode.window.activeNotebookEditor
            || vscode.window.visibleNotebookEditors[0];
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook   = editor.notebook;
        const cellNumber = Number(options.input?.cellNumber);
        if (!Number.isInteger(cellNumber) || cellNumber < 1 || cellNumber > notebook.cellCount) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Invalid cellNumber ${cellNumber}. Notebook has ${notebook.cellCount} cell(s).`
            )]);
        }

        const idx     = cellNumber - 1;
        const cell    = notebook.cellAt(idx);
        const kindStr = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
        const source  = cell.document.getText();

        // Save to recovery file before deleting (default: true)
        const saveToRecovery = options.input?.saveToRecovery !== false;
        if (saveToRecovery) {
            try {
                const notebookPath = notebook.uri.fsPath;
                const recoveryDir  = path.join(path.dirname(notebookPath), 'img',
                    path.basename(notebookPath, path.extname(notebookPath)));
                const recoveryPath = path.join(recoveryDir, 'ai_deleted_cells.md');
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

        const totalAfter = notebook.cellCount;   // post-deletion
        const preview    = source.trim().slice(0, 80).replace(/\n/g, ' ');
        const recovery   = saveToRecovery ? ' (saved to ai_deleted_cells.md for recovery)' : '';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `Deleted ${kindStr} Cell ${cellNumber}${recovery}. Notebook now has ${totalAfter} cell${totalAfter !== 1 ? 's' : ''}.\nContent was: ${preview}${source.trim().length > 80 ? '…' : ''}`
        )]);
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
        const editor = vscode.window.activeNotebookEditor
            || vscode.window.visibleNotebookEditors[0];
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
        const editor = vscode.window.activeNotebookEditor
            || vscode.window.visibleNotebookEditors[0];
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

        // Collect text/plain output from the (now-updated) cell
        const decoder = new util.TextDecoder();
        const updatedCell = notebook.cellAt(idx);
        const outs = [];
        for (const output of updatedCell.outputs) {
            const plainItem = output.items.find(it => it.mime === 'text/plain');
            if (plainItem) {
                try {
                    const txt = decoder.decode(plainItem.data).trim();
                    if (txt) outs.push(txt);
                } catch (_) {}
            }
        }

        const total  = notebook.cellCount;
        const prefix = timedOut
            ? `Cell ${cellNumber} of ${total} timed out after ${timeoutSec}s (execution may still be running).\n`
            : `Cell ${cellNumber} of ${total} executed.\n`;
        const body = outs.length > 0 ? outs.join('\n') : '(no output)';
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(prefix + body)]);
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
        const editor = vscode.window.activeNotebookEditor
            || vscode.window.visibleNotebookEditors[0];
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
            const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
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
            const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
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
                const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
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
            const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
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
        const editor = vscode.window.activeNotebookEditor || vscode.window.visibleNotebookEditors[0];
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
// Registration helper — called from extension.js activate()
// ---------------------------------------------------------------------------

function registerTools(context, getController, debugCtrl) {
    const tools = [
        { name: 'wolfbook_getNotebookContext', impl: new GetNotebookContextTool() },
        { name: 'wolfbook_evaluateExpression', impl: new EvaluateExpressionTool(getController) },
        { name: 'wolfbook_lookupSymbol',         impl: new LookupSymbolTool(getController) },
        { name: 'wolfbook_getSymbolWebHelp',    impl: new GetSymbolWebHelpTool() },
        { name: 'wolfbook_insertCell',           impl: new InsertCellTool(getController) },
        { name: 'wolfbook_deleteCell',           impl: new DeleteCellTool() },
        { name: 'wolfbook_editCell',             impl: new EditCellTool(getController) },
        { name: 'wolfbook_runCell',              impl: new RunCellTool() },
        { name: 'wolfbook_getKernelState',       impl: new GetKernelStateTool(getController) },
        { name: 'wolfbook_saveNotebook',         impl: new SaveNotebookTool() },
        { name: 'wolfbook_restartKernel',        impl: new RestartKernelTool(getController) },
        { name: 'wolfbook_abortEvaluation',      impl: new AbortEvaluationTool(getController) },
        { name: 'wolfbook_debugCell',            impl: new DebugCellTool(getController, debugCtrl) },
    ];

    for (const { name, impl } of tools) {
        if (vscode.lm && vscode.lm.registerTool) {
            context.subscriptions.push(vscode.lm.registerTool(name, impl));
        }
    }
}

module.exports = { registerTools, buildTranscript, clearEvalLog };
