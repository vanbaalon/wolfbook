"use strict";
// Wolfbook Copilot Language Model Tools — Phase 4
// Registered in extension.js activate(); declared in package.json contributes.languageModelTools.

const vscode = require("vscode");
const util   = require("util");
const https  = require("https");

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

// ---------------------------------------------------------------------------
// TODO-4a: wolfbook_getNotebookContext
// ---------------------------------------------------------------------------

class GetNotebookContextTool {
    async prepareInvocation(_options, _token) {
        return {};
    }

    async invoke(_options, _token) {
        const editor = vscode.window.activeNotebookEditor;
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
        const expr = options.input?.expression || '(none)';
        return {
            invocationMessage: `Evaluate in kernel: ${expr}`
        };
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

        // Use Block (not Module) for the result-capture wrapper so compound expressions
        // like "x = 1; While[...]" don't trigger Module::lvsym. Block localises $wbR$
        // without requiring a single-expression initialiser.
        // If result is already a String return it raw; otherwise convert via InputForm
        // to avoid double-quoting (e.g. VsCodeSymbolMarkdown returns a String directly).
        const wrappedExpr =
            `Block[{$wbR$}, $wbR$ = (${expression}); If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]`;

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
                    m.replace(/Block\[\{\$wbR\$\},\s*\$wbR\$\s*=\s*\(/g, '(')
                     .replace(/\);\s*If\[StringQ\[\$wbR\$\].*?\]\]/gs, ')')
                );
                output += clean.map(m => `[message] ${m}`).join('\n') + '\n';
            }
            if (result?.result?.type === 'string' && result.result.value) {
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
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Evaluation timed out after ${timeoutSec}s — the kernel has been interrupted.\n` +
                        `If the computation is expected to take longer, retry with a higher timeoutSeconds value.`
                    )
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: ${err.message}`)
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
    async prepareInvocation(options, _token) {
        const kind    = options.input?.kind    || 'code';
        const content = options.input?.content || '';
        const pos     = options.input?.position;
        const posStr  = typeof pos === 'number' ? `at index ${pos}` : pos;
        const preview = content.length > 120 ? content.slice(0, 120) + '…' : content;
        return {
            invocationMessage: `Insert ${kind} cell ${posStr}:\n\`\`\`\n${preview}\n\`\`\``
        };
    }

    async invoke(options, _token) {
        const editor = vscode.window.activeNotebookEditor;
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

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Inserted ${kind} cell at position ${insertIdx} in ${notebook.uri.fsPath.split('/').pop()}.`
            )
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration helper — called from extension.js activate()
// ---------------------------------------------------------------------------

function registerTools(context, getController) {
    const tools = [
        { name: 'wolfbook_getNotebookContext', impl: new GetNotebookContextTool() },
        { name: 'wolfbook_evaluateExpression', impl: new EvaluateExpressionTool(getController) },
        { name: 'wolfbook_lookupSymbol',         impl: new LookupSymbolTool(getController) },
        { name: 'wolfbook_getSymbolWebHelp',    impl: new GetSymbolWebHelpTool() },
        { name: 'wolfbook_insertCell',           impl: new InsertCellTool() },
    ];

    for (const { name, impl } of tools) {
        if (vscode.lm && vscode.lm.registerTool) {
            context.subscriptions.push(vscode.lm.registerTool(name, impl));
        }
    }
}

module.exports = { registerTools, buildTranscript };
