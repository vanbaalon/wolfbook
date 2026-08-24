"use strict";
// Wolfbook Copilot Language Model Tools — Phase 4
// Registered in extension.js activate(); declared in package.json contributes.languageModelTools.

const vscode = require("vscode");
const util   = require("util");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { decodeWstpText, cleanPrintLine, setBoxToLatexProvider } = require('../utils/encoding');
const paperSearch = require('./paperSearch');
const { readCommittedOutputs, runCellViaPipeline } = require('./cell-pipeline');
const { CELL_STATE, stateLabel, stateRemedy, isConfirmed } = require('./cell-state');
const { SelfTestTool } = require('./self-test');
const { projectNotebook, ContentAddressedRenderCache } = require('../claude-mcp/output-projection');
const { resolveJsonPath, describeJson } = require('../kernel/json-path');

// Wire up the BTL (box-to-LaTeX) C++ addon so cleanPrintLine can convert BoxData → LaTeX.
// Uses the same platform-aware loading strategy as output/renderer.js.
// Runs once at module load; failures are silent (cleanPrintLine falls back to [formula]).
;(function _setupBtlProvider() {
    const _BTL_DIR = path.join(__dirname, '../../../wllatex-addon');
    let _btlAddon = null;
    function _loadBtl() {
        if (_btlAddon) return _btlAddon;
        try {
            const _prebuilt = path.join(_BTL_DIR, 'prebuilt',
                `wolfbook_btl-${process.platform}-${process.arch}.node`);
            const _fallback = path.join(_BTL_DIR, 'wolfbook_btl.node');
            _btlAddon = require(fs.existsSync(_prebuilt) ? _prebuilt : _fallback);
            return _btlAddon;
        } catch (_) { return null; }
    }
    const { wlUTFtoNames } = require('../namedchars');
    const { decodeWolframOctal } = require('../utils/encoding');
    setBoxToLatexProvider(rawBox => {
        if (!rawBox.startsWith('BoxData[') || !rawBox.endsWith(']')) return null;
        const btl = _loadBtl();
        if (!btl) return null;
        // Strip BoxData[ … ], un-double WSTP backslashes, strip WL line-fold markers,
        // decode octal byte sequences to Unicode, then map Unicode → \[Name] for BTL.
        const inner   = rawBox.slice(8, -1);
        const unesc   = inner.replace(/\\\\/g, '\\');
        const clean   = unesc.replace(/\n\s*>?\s*/g, ' ');
        const decoded = decodeWolframOctal(clean);
        const wlNamed = wlUTFtoNames(decoded);
        try {
            const result = btl.boxToLatex(wlNamed, { trigOmitParens: false, maxRows: 0 });
            if (!result) return null;
            const latex = typeof result === 'string' ? result : result.latex;
            return (latex && !result.error) ? latex : null;
        } catch (_) { return null; }
    });
})();
const {
    clearEvalLog, appendEvalLog, appendEventLog,
    normalizeToolContent,
    normalizeMarkdownMath, prepareCellContent, _canonCellId, splitWLIntoStatements,
    checkMarkdownKaTeX, _katexWarnings, _katexWarningsForCells,
    _isCollabMode, _ensureCollabEditor, flashCell,
    _snapshotViewport, _restoreViewport,
    buildTranscript, getCellToolId, _ensureCellToolId,
    formatCellRef, resolveCellIndex, resolveInsertIndex,
    isKernelConnectionError, cleanWrapperFromMsg, KERNEL_CRASH_MSG,
    NB_EXTS, setNotebookResolvedCallback, _allNotebookUris,
    resolveNotebookEditor, resolveNotebookDocument, noEditorMsg,
    acquireKernelForAgent, releaseKernelForAgent, trackedKernelEvaluate,
} = require('./shared');
const trackedEvaluate = trackedKernelEvaluate;
const kernelScopedInput = options => ({ ...(options?.input || {}), _kernelOnly: true });
// Operation-first controller resolution: an operation id already identifies its
// kernel (each controller has its own OperationRegistry), so look the id up
// across ALL kernels in this window before demanding kernel_id.  Falls back to
// kernel-scoped resolution; a resolve() throw is returned as {error} (the
// manager's message names every live kernel — actionable, never a bare demand).
const resolveControllerForOperation = (getController, options, operationId) => {
    const manager = getController?.manager;
    const byOp = operationId ? manager?.findControllerByOperation?.(operationId) : null;
    if (byOp) return { controller: byOp };
    try {
        return { controller: getController?.(kernelScopedInput(options)) };
    } catch (err) {
        return { controller: null, error: err };
    }
};
const {
    WolfslideGetContextTool, WolfslideListSlidesTool, WolfslideGetSlideTool,
    WolfslideInsertSlideTool, WolfslideReplaceSlideTool, WolfslideEditSlideTool, WolfslideDeleteSlideTool, WolfslideDeleteSlidesTool,
    WolfslideMoveSlideTool, WolfslideUndoTool, WolfslideReloadTool, WolfslideSaveFileTool,
    WolfslideDuplicateSlideTool, WolfslideSearchSlidesTool,
    WolfslideEditBlockTool, WolfslideInsertBlockTool,
    WolfslideDeleteBlockTool, WolfslideMoveBlockTool,
    WolfslideCheckDeckTool, WolfslideReorderFragmentsTool,
    WolfslideMeasureSlideTool, WolfslideGetSlideHtmlTool,
    WolfslideGetImageDimensionsTool, WolfslideExportHtmlTool,
    WolfslideSetThemeTool, WolfslideImageAssetTool,
    WolfslideBulkInsertTool, WolfslideCopySlides, WolfslideInsertEvalBlockTool,
    WolfslideRunEvalBlockTool, WolfslideBlockTool, WolfslidePatchBlockTool, WolfslideAdvancedTool,
    WolfslideArrangeTool,
    GetCellOutputTool, ValidateSyntaxTool, LatexTool,
} = require('./wolfslide-tools');

// Wolfbook TeX (Stage 1): structural projection of .tex + guarded edits.
const {
    PaperGetOutlineTool, PaperGetObjectTool, PaperGetSectionTool,
    PaperFindReferencesTool, PaperMathematicaBlocksTool,
    PaperPreviewEditTool, PaperApplyEditTool,
    // `PaperSearchTool` is already taken in this file by the LITERATURE search
    // (wolfbook_paperSearch, Semantic Scholar/arXiv). Ours searches the open
    // paper's own objects, so it is aliased rather than renamed upstream.
    PaperSearchTool: PaperSearchObjectsTool,
} = require('./tex-tools');

function mutationConflict(cell, input = {}) {
    const source = cell.document.getText();
    const id = getCellToolId(cell);
    const kind = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const mismatch = (input.expected_cell_id != null && _canonCellId(input.expected_cell_id) !== _canonCellId(id)) ||
        (input.expected_kind != null && String(input.expected_kind).toLowerCase() !== kind) ||
        (input.expected_source_prefix != null && !source.startsWith(String(input.expected_source_prefix))) ||
        (input.expected_source_hash != null && String(input.expected_source_hash).toLowerCase() !== hash);
    if (!mismatch) return null;
    return { state: 'conflict', cell_id: id, kind, source_hash: hash, first_line: source.split('\n')[0].slice(0, 200) };
}

function mutationIdentityText(cell) {
    const source = cell.document.getText();
    const id = getCellToolId(cell);
    const kind = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
    return `CellId: ${id}; kind: ${kind}; first line: ${JSON.stringify(source.split('\n')[0].slice(0, 200))}`;
}

// ---------------------------------------------------------------------------
// summariseEvalOutputs(outs, hasError)
//   Converts a list of plain-text kernel outputs into a compact string for
//   the agent, applying smarter truncation when the total is long or when
//   there are errors/warnings (which tend to be the most verbose).
//
//   Strategy:
//   - No outputs → "(no output)"
//   - Total ≤ 400 chars → full join
//   - Any error/warning present → show each message capped at 200 chars,
//     summarise count: "3 messages: <first 200>... [2 more: <tags>]"
//   - Otherwise → join + truncate to 400 chars with an ellipsis
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// summariseMsgs(messages)
//   Formats kernel messages (warnings/errors) for agent consumption.
//   Each message is capped at MSG_CAP chars. If the same tag repeats
//   (e.g. three N::meprec), we show the first instance in full and
//   collapse the rest to "[N::meprec ×2 suppressed]".
// ---------------------------------------------------------------------------
const MSG_CAP = 200;
function summariseMsgs(messages) {
    if (!messages || !messages.length) return [];
    const tagCount = {};   // tag → count of shown messages
    const lines = [];
    for (const m of messages) {
        const tagMatch = m.match(/^(\w+::\w+):/);
        const tag = tagMatch ? tagMatch[1] : null;
        if (tag) {
            tagCount[tag] = (tagCount[tag] || 0) + 1;
            if (tagCount[tag] > 1) {
                // Update (or add) a suppression note for this tag
                const suppIdx = lines.findIndex(l => l.startsWith(`[message] [${tag}`));
                if (suppIdx >= 0) {
                    lines[suppIdx] = `[message] [${tag} ×${tagCount[tag] - 1} more suppressed — first instance shown above]`;
                } else {
                    lines.push(`[message] [${tag} ×${tagCount[tag] - 1} more suppressed — first instance shown above]`);
                }
                continue;
            }
        }
        const truncated = m.length > MSG_CAP;
        lines.push(`[message] ${m.slice(0, MSG_CAP)}${truncated ? `… [${m.length} chars]` : ''}`);
    }
    return lines;
}


function summariseEvalOutputs(outs, hasError) {
    if (!outs.length) return '(no output)';
    const joined = outs.join(' | ');
    if (joined.length <= 400) return joined;

    if (hasError) {
        // Split: separate normal results from WL message lines (Symbol::tag: …)
        const msgLines = outs.filter(o => /\w+::\w+:/.test(o));
        const valLines = outs.filter(o => !/\w+::\w+:/.test(o));
        const parts = [];
        if (msgLines.length) {
            const first = msgLines[0].slice(0, 200);
            const ellipsis = msgLines[0].length > 200 ? '…' : '';
            parts.push(`${msgLines.length} kernel message${msgLines.length > 1 ? 's' : ''}: ${first}${ellipsis}`);
            if (msgLines.length > 1) {
                // Show just the message tags for the rest: General::stop, Syntax::sntxf, …
                const restTags = msgLines.slice(1).map(m => {
                    const match = m.match(/(\w+::\w+):/);
                    return match ? match[1] : m.slice(0, 30);
                });
                parts.push(`[also: ${restTags.join(', ')}]`);
            }
        }
        if (valLines.length) {
            const valStr = valLines.join(' | ').slice(0, 200);
            parts.push(`result: ${valStr}${valLines.join(' | ').length > 200 ? '…' : ''}`);
        }
        return parts.join(' ');
    }

    // Normal long output: truncate with char count hint
    return joined.slice(0, 400) + `… [${joined.length} chars total]`;
}

function classifyCellOutputs(cell) {
    const outputs = Array.isArray(cell?.outputs) ? cell.outputs : [];
    let hasErrors = false;
    for (const output of outputs) {
        const mimes = (output.items || []).map(item => item.mime);
        if (mimes.includes('x-application/wolfram-language-html') &&
            mimes.includes('application/vnd.code.notebook.error')) hasErrors = true;
    }
    return { has_output: outputs.length > 0, has_errors: hasErrors };
}


class NewNotebookTool {
    constructor(getController) { this._manager = getController?.manager; }
    async prepareInvocation(options, _token) {
        const target = options.input?.path || options.input?.filename || 'new notebook';
        return { invocationMessage: `Open or create Wolfbook notebook: ${path.basename(target)}` };
    }

    _resolveNotebookPath(input) {
        const raw = String(input?.path || input?.filename || '').trim();
        if (!raw) throw new Error('Required: path (absolute or workspace-relative .wb filename).');
        const withExt = NB_EXTS.some(ext => raw.toLowerCase().endsWith(ext)) ? raw : `${raw}.wb`;
        if (path.isAbsolute(withExt)) return path.normalize(withExt);

        const baseDir =
            input?.directory ? String(input.directory)
            : vscode.window.activeNotebookEditor?.notebook?.uri?.fsPath ? path.dirname(vscode.window.activeNotebookEditor.notebook.uri.fsPath)
            : vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (!baseDir) throw new Error('Relative notebook paths require an open workspace or an active notebook.');
        return path.resolve(baseDir, withExt);
    }

    _cellToJson(cell) {
        const kindName = String(cell?.kind || 'code').toLowerCase();
        const isMarkdown = kindName === 'markdown' || kindName === 'markup';
        const prepared = prepareCellContent({
            content: cell?.content ?? cell?.value ?? '',
            kind: isMarkdown ? 'markdown' : 'code',
            encoding: cell?.content_encoding,
        });
        return {
            kind: isMarkdown ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
            value: prepared.text,
            languageId: isMarkdown ? 'markdown' : 'wolfram',
            outputs: [],
            metadata: {},
        };
    }

    async _openWithTimeout(uri, ms) {
        return Promise.race([
            vscode.workspace.openNotebookDocument(uri),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`openNotebookDocument timed out after ${ms} ms`)), ms)),
        ]);
    }

    async _waitUntilVisible(uri, ms) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const ed = vscode.window.visibleNotebookEditors.find(e => e.notebook.uri.toString() === uri.toString());
            if (ed && ed.notebook.notebookType === 'extended-wolfram-notebook') return ed;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
    }

    async invoke(options, _token) {
        const input = options.input || {};
        let nbPath;
        try {
            nbPath = this._resolveNotebookPath(input);
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Cannot create notebook: ${err.message}`)]);
        }

        if (!NB_EXTS.some(ext => nbPath.toLowerCase().endsWith(ext))) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Notebook path must end in .wb, .evsnb, or .vsnb.')]);
        }

        const overwrite = !!input.overwrite;
        const waitMs = Math.max(1000, Math.min(Number(input.waitMs || 10000), 60000));
        let cells;
        try {
            cells = Array.isArray(input.cells) ? input.cells.map(c => this._cellToJson(c)) : [];
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(err.message)]);
        }
        const notebookJson = {
            cells,
            metadata: {
                ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
                createdBy: 'wolfbook_newNotebook',
                createdAt: new Date().toISOString(),
            },
        };

        const existed = fs.existsSync(nbPath);
        try {
            // Existing files are opened safely by default. overwrite:true keeps
            // the original explicit replacement semantics for callers that
            // intentionally supplied replacement cells/metadata.
            if (!existed || overwrite) {
                fs.mkdirSync(path.dirname(nbPath), { recursive: true });
                fs.writeFileSync(nbPath, JSON.stringify(notebookJson, null, 1), 'utf8');
            }
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Failed to write notebook: ${err.message}`)]);
        }

        const uri = vscode.Uri.file(nbPath);
        try {
            const doc = await this._openWithTimeout(uri, waitMs);
            await vscode.window.showNotebookDocument(doc, { preserveFocus: false, viewColumn: vscode.ViewColumn.Active });
            const ed = await this._waitUntilVisible(uri, waitMs);
            if (!ed) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Created ${path.basename(nbPath)}, but VS Code did not make the notebook editor visible within ${waitMs} ms.`
                )]);
            }

            // Agent-created notebooks must be immediately routable. Persist an
            // explicit default-slot association before exposing the notebook as
            // the MCP target; this remains VS Code workspace state, never .wb
            // metadata.
            const defaultKernel = this._manager?.defaultEntry;
            if (defaultKernel && !this._manager.explicitBindingFor(nbPath)) {
                await this._manager.bind(nbPath, defaultKernel.id);
            }

            // Select the VS Code controller for this notebook NOW.  manager.bind()
            // only records workspace state; without a real controller selection
            // createNotebookCellExecution throws "not associated" and the first
            // runs are silently dropped (the phantom-run bug).
            const boundEntry = this._manager?.bindingFor?.(nbPath) || defaultKernel;
            let assocLine = 'Kernel: no kernel available to associate.';
            if (boundEntry?.controller) {
                const { associateNotebook } = require('../kernel/association');
                const assoc = await associateNotebook(boundEntry.controller, ed.notebook, { restoreActive: false });
                const label = boundEntry.label || boundEntry.id || 'kernel';
                assocLine = assoc.associated
                    ? `Kernel: ${label} — controller selected for this notebook ✓`
                    : `Kernel: ${label} — binding recorded, but VS Code did not confirm controller selection (${assoc.method}); the first run will retry the association.`;
            }

            // Reuse the shared resolver so Copilot/in-editor targeting hooks see
            // the new active notebook too.
            try { await resolveNotebookEditor(nbPath, { skipConfirm: true }); } catch (_) {}

            // Optional: evaluate the initial code cells through the evidence-gated
            // pipeline.  Default OFF — stated explicitly in the response so nobody
            // has to guess whether initial cells ran.
            let evalLines = '';
            if (input.evaluate === true && boundEntry?.controller) {
                const _ctrl = boundEntry.controller;
                if (_ctrl.kernelStatusString !== 'resolved') {
                    evalLines = '\nEvaluate: kernel is not running — initial cells were NOT evaluated.';
                } else {
                    const timeoutSec = Math.max(5, Number(input.timeoutSeconds) || 60);
                    const deadline = Date.now() + timeoutSec * 1000;
                    const parts = [];
                    for (let idx = 0; idx < ed.notebook.cellCount; idx++) {
                        if (ed.notebook.cellAt(idx).kind === vscode.NotebookCellKind.Markup) continue;
                        if (Date.now() >= deadline) { parts.push('(global timeout reached)'); break; }
                        const pipeline = await runCellViaPipeline(_ctrl, ed, idx, {
                            timeoutMs: Math.max(1, deadline - Date.now()), token: _token || { isCancellationRequested: false },
                            snapshotViewport: _snapshotViewport, getCellId: getCellToolId,
                        });
                        const ok = isConfirmed(pipeline.state);
                        parts.push(`Cell ${idx + 1}: ${ok ? '✓' : `⚠ ${stateLabel(pipeline.state)}`} — ${
                            ok ? (pipeline.plain?.slice(0, 200) || stateLabel(CELL_STATE.EVALUATED_NO_OUTPUT)) : stateRemedy(pipeline.state)}`);
                        if (!ok) break;
                    }
                    evalLines = parts.length ? '\nEvaluate:\n' + parts.map(p => '  ' + p).join('\n') : '';
                }
            } else if (cells.some(c => c.kind === vscode.NotebookCellKind.Code)) {
                evalLines = '\nNote: initial cells are NOT evaluated by default — pass evaluate:true, or use wolfbook_runCells.';
            }

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `${existed && !overwrite ? 'Opened existing' : 'Created and opened'} **${path.basename(nbPath)}**.\n` +
                `Path: ${nbPath}\n` +
                `Ready: notebook editor is visible (${ed.notebook.cellCount} cells).\n` +
                assocLine + '\n' +
                `Target: this notebook is ready for subsequent Wolfbook MCP editing and evaluation tools.` +
                evalLines
            )]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Created ${path.basename(nbPath)}, but failed to open it as a Wolfbook notebook: ${err.message}`
            )]);
        }
    }
}


class GetNotebookContextTool {
    constructor(getController, context) { this._getController = getController; this._context = context; }
    _kernelInfo(notebook) {
        try {
            const ctrl = this._getController?.({ notebook });
            const status = ctrl?.arbiter?.status(ctrl) || {};
            return `[${ctrl?.kernelIdentity?.label || 'unbound'} · ${ctrl?.kernelIdentity?.kernel_id || 'none'} · ${status.lifecycle || 'offline'}]`;
        } catch (_) { return '[unbound]'; }
    }
    async prepareInvocation(options, _token) {
        const action = options.input?.action || 'read';
        if (action === 'list') return { invocationMessage: 'List open notebooks' };
        if (action === 'switch') return { invocationMessage: `Switch to notebook: ${options.input?.notebook || '?'}` };
        if (action === 'save') return { invocationMessage: 'Save notebook to disk' };
        if (action === 'summary' || action === 'brief') return { invocationMessage: 'Get notebook summary (brief)' };
        return {};
    }

    async invoke(options, _token) {
        let action = options.input?.action || 'read';

        // "summary" and "brief" are both natural aliases for brief read — treat them as such
        if (action === 'summary' || action === 'brief') {
            // Force brief mode on via a patched options proxy so the read path picks it up
            options = { ...options, input: { ...(options.input || {}), action: 'read', brief: true } };
            action = 'read';
        }

        const _USAGE = 'Valid actions: "read" (full cell source + outputs, default), "summary"/"brief" (compact cell list), "list" (open notebooks), "switch" (with notebook="file.wb"), "save". Use brief=true with action="read" for a compact view.';

        // Unknown action — return usage guidance
        if (!['list', 'switch', 'save', 'read'].includes(action)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Unknown action "${action}". ${_USAGE}`)
            ]);
        }

        // ── action: list ─────────────────────────────────────────────────────
        if (action === 'list') {
            // Merge loaded documents + unloaded tab URIs
            const allUris = _allNotebookUris();
            if (allUris.size === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No Wolfram notebooks are currently open.')
                ]);
            }
            const activeUri  = vscode.window.activeNotebookEditor?.notebook.uri.toString();
            const loadedDocs = new Map(
                vscode.workspace.notebookDocuments
                    .filter(d => d.notebookType === 'extended-wolfram-notebook')
                    .map(d => [d.uri.fsPath, d])
            );
            const lines = [`**${allUris.size} open notebook(s):**\n`];
            for (const [fsPath, uri] of allUris) {
                const name = fsPath.split('/').pop();
                const doc  = loadedDocs.get(fsPath);
                const isActive = uri.toString() === activeUri ? ' ← **active**' : '';
                if (doc) {
                    let codeN = 0, mdN = 0;
                    for (let i = 0; i < doc.cellCount; i++) {
                        doc.cellAt(i).kind === vscode.NotebookCellKind.Code ? codeN++ : mdN++;
                    }
                    lines.push(`- **${name}** ${this._kernelInfo(fsPath)} — ${doc.cellCount} cells (${codeN} code, ${mdN} markdown)${isActive}`);
                } else {
                    lines.push(`- **${name}** ${this._kernelInfo(fsPath)} — (background tab, not yet loaded)${isActive}`);
                }
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
            // Explicit switch action — user already expressed intent, skip confirmation
            const editor = await resolveNotebookEditor(notebook, { skipConfirm: true });
            if (!editor) {
                const available = [..._allNotebookUris().keys()].map(p => p.split('/').pop()).join(', ');
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Notebook "${notebook}" not found. Available: ${available || '(none)'}`
                    )
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Switched to **${editor.notebook.uri.fsPath.split('/').pop()}** ${this._kernelInfo(editor.notebook.uri.fsPath)} (${editor.notebook.cellCount} cells). All tools now target this notebook.`
                )
            ]);
        }

        // ── action: save (deprecated — delegates to the ONE save path) ──────
        // wolfbook_saveNotebook is canonical: both now return bytes+mtime+SHA-256
        // so a save is verified, never merely claimed.
        if (action === 'save') {
            try {
                return await new SaveNotebookTool().invoke(options, _token);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Save failed: ${err.message}`)
                ]);
            }
        }

        // ── action: read (default) ───────────────────────────────────────────
        const targetName = options.input?.notebook;
        // Reads are ROUTING-NEUTRAL: resolve the document without showing it,
        // changing the active editor, or setting the Copilot session target
        // (a read that shifts execution routing was feedback bug §3.3).
        const notebook = await resolveNotebookDocument(targetName);
        if (!notebook) {
            const notFoundMsg = targetName
                ? `Notebook "${targetName}" is not open. Use action="list" to see open notebooks.`
                : noEditorMsg(targetName);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(notFoundMsg)
            ]);
        }
        // Editor (if this notebook happens to be visible) — read-only peek at the
        // user's selection; never shown/focused from here.
        const editor = vscode.window.visibleNotebookEditors.find(e => e.notebook === notebook) || null;
        if (notebook.notebookType !== 'extended-wolfram-notebook') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('The active editor is not a Wolfram notebook.')
            ]);
        }
        const startCell = options.input?.startCell;
        const endCell   = options.input?.endCell;
        if (options.input?.output_projection === 'canonical' || options.input?._mcpProjection === true) {
            const cache = new ContentAddressedRenderCache(
                this._context?.globalStorageUri?.fsPath ? path.join(this._context.globalStorageUri.fsPath, 'mcp-render-cache-v1') : null,
                options.input?._mcpCache === true
            );
            const projection = projectNotebook(notebook, {
                from: Math.max(0, Number(startCell || 1) - 1),
                to: Math.min(notebook.cellCount, Number(endCell || notebook.cellCount)),
                previewChars: 1000, getCellId: getCellToolId, cache,
            });
            projection.kernel = (() => {
                const ctrl = this._getController?.({ notebook: notebook.uri.fsPath, kernel_id: options.input?.kernel_id });
                const status = ctrl?.arbiter?.status(ctrl) || {};
                return { kernel_id: ctrl?.kernelIdentity?.kernel_id || null, kernel_label: ctrl?.kernelIdentity?.label || null, lifecycle: status.lifecycle || 'offline' };
            })();
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(projection, null, 2))]);
        }

        // Brief mode: compact table of cell numbers, kinds, and first-line previews
        if (options.input?.brief === true) {
            const decoder     = new util.TextDecoder();
            const nbName      = path.basename(notebook.uri.fsPath);
            const from        = Math.max(1, startCell || 1);
            const to          = Math.min(notebook.cellCount, endCell || notebook.cellCount);
            // previewChars: how many chars of source to show per cell (default 100, max 500)
            const previewCap  = Math.min(500, Math.max(20, Number(options.input?.previewChars) || 100));
            // Coerce string booleans ("true"/"false") — clients with a stale
            // schema stringify undeclared params, which silently no-opped the
            // strict typeof check.
            const _boolParam = (v) => v === true || v === 'true' ? true
                : v === false || v === 'false' ? false : undefined;
            const _hasOutput = _boolParam(options.input?.has_output);
            const _hasErrors = _boolParam(options.input?.has_errors);
            const candidates = [];
            for (let i = from - 1; i < to; i++) {
                const cell = notebook.cellAt(i);
                const kind = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
                const outputState = classifyCellOutputs(cell);
                if (options.input?.kind && options.input.kind !== kind) continue;
                if (_hasOutput !== undefined && _hasOutput !== outputState.has_output) continue;
                if (_hasErrors !== undefined && _hasErrors !== outputState.has_errors) continue;
                candidates.push({ i, cell, kind, outputState });
            }
            const filtered = options.input?.kind != null || options.input?.has_output != null || options.input?.has_errors != null;
            const rangeCount = Math.max(0, to - from + 1);
            const filterNote = filtered ? ` (showing ${candidates.length} of ${rangeCount} in range after filters)`
                : (from !== 1 || to !== notebook.cellCount ? ` (showing ${from}–${to})` : '');
            const lines = [`**${nbName}** ${this._kernelInfo(notebook.uri.fsPath)} — ${notebook.cellCount} cells${filterNote}`,
                `Path: ${notebook.uri.fsPath} · version ${notebook.version} · ${notebook.isDirty ? 'UNSAVED CHANGES' : 'saved'}`];
            // Surface the active (focused) cell so the agent knows where the user is
            if (editor && Array.isArray(editor.selections) && editor.selections.length > 0) {
                const activeIdx = editor.selections[0].start;
                if (activeIdx >= 0 && activeIdx < notebook.cellCount) {
                    const activeCell = notebook.cellAt(activeIdx);
                    lines.push(`Current cell: Cell ${activeIdx + 1} (cellId: ${getCellToolId(activeCell)})`);
                }
            }
            for (const candidate of candidates) {
                const { i, cell } = candidate;
                const cellId = getCellToolId(cell);
                const kind   = cell.kind === vscode.NotebookCellKind.Markup ? 'md' : 'code';
                const src    = cell.document.getText().trim();
                // Show up to previewCap chars of source, collapsing newlines to ↵ for compactness
                const preview = src.slice(0, previewCap).replace(/\n/g, '\u21B5') + (src.length > previewCap ? '\u2026' : '');
                const firstLine = preview || '*(empty)*';
                // Show evaluation state and output summary
                let evalState = '';
                let outSummary = '';
                if (cell.outputs.length === 0) {
                    evalState = kind === 'code' ? ' [?]' : '';
                } else {
                    let hasError = candidate.outputState.has_errors;
                    for (const output of cell.outputs) {
                        const mimes = output.items.map(it => it.mime);
                        if (hasError && mimes.includes('application/vnd.code.notebook.error')) {
                            outSummary = ' ⚠ msgs';
                            break;
                        }
                        const plain = output.items.find(it => it.mime === 'text/plain');
                        if (plain) {
                            try {
                                const t = decoder.decode(plain.data).trim().slice(0, 30);
                                if (t) { outSummary = ` → ${t}${t.length >= 30 ? '…' : ''}`; }
                            } catch (_) {}
                        }
                    }
                    evalState = hasError ? ' [err]' : ' [ok]';
                }
                lines.push(`Cell ${i + 1} [${kind}]${evalState} ${cellId} | ${firstLine}${outSummary}`);
            }
            lines.push(`\nUse brief=false (default) or omit brief to get full cell source + outputs. Use previewChars=N (default 100, max 500) to control source preview length.`);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
        }

        const transcript = `${this._kernelInfo(notebook.uri.fsPath)}\n${buildTranscript(notebook, startCell, endCell, editor)}`;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(transcript)
        ]);
    }
}

// ---------------------------------------------------------------------------
// TODO-4b: wolfbook_evaluateExpression
// ---------------------------------------------------------------------------

// Shared outputForm → WL string-producing wrapper.  'json' exports via
// ExportString with a SILENT InputForm fallback (symbolic/held expressions and
// exotic keys fail JSON export; the fallback is labelled, never an error).
function _buildOutputFormWrapper(outputForm, varName) {
    if (outputForm === 'Short')      return `ToString[Short[${varName}, 5], OutputForm]`;
    if (outputForm === 'TeXForm')     return `ToString[TeXForm[${varName}]]`;
    if (outputForm === 'MatrixForm')  return `ToString[MatrixForm[${varName}], OutputForm]`;
    if (outputForm === 'TableForm')   return `ToString[TableForm[${varName}], OutputForm]`;
    if (outputForm === 'json')        return `Quiet[Check[ExportString[${varName}, "JSON", "Compact" -> True], ` +
        `"$WBJSONFAIL$" <> If[StringQ[${varName}], ${varName}, ToString[${varName}, InputForm]]]]`;
    return `If[StringQ[${varName}], ${varName}, ToString[${varName}, InputForm]]`;
}

// expect → kernel-side check over $wbR$ (one round trip, no second evaluation).
// Returns null when no kernel-side check applies (freeOfMessages is JS-side).
function _buildExpectCheck(expect) {
    if (!expect || typeof expect !== 'object') return null;
    const clauses = [];
    if (typeof expect.equals === 'string' && expect.equals.trim()) {
        const v = `(${expect.equals.trim()})`;
        clauses.push(`(SameQ[$wbR$, ${v}] || (NumericQ[$wbR$] && NumericQ[${v}] && $wbR$ == ${v}))`);
    }
    if (typeof expect.matches === 'string' && expect.matches.trim()) {
        clauses.push(`MatchQ[$wbR$, ${expect.matches.trim()}]`);
    }
    if (expect.numeric && typeof expect.numeric === 'object' && expect.numeric.value != null) {
        const v = `(${String(expect.numeric.value).trim()})`;
        const tol = String(expect.numeric.tolerance || '10^-10').trim();
        clauses.push(`(NumericQ[N[$wbR$]] && Abs[N[($wbR$) - ${v}]] <= (${tol}))`);
    }
    if (expect.isTrue === true) clauses.push('TrueQ[$wbR$]');
    return clauses.length ? clauses.join(' && ') : null;
}

// Describe the expectation for the ASSERT line.
function _describeExpect(expect) {
    if (!expect || typeof expect !== 'object') return '';
    const bits = [];
    if (expect.equals != null) bits.push(`equals ${expect.equals}`);
    if (expect.matches != null) bits.push(`matches ${expect.matches}`);
    if (expect.numeric?.value != null) bits.push(`≈ ${expect.numeric.value} (tol ${expect.numeric.tolerance || '10^-10'})`);
    if (expect.isTrue === true) bits.push('is True');
    if (expect.freeOfMessages === true) bits.push('no kernel messages');
    return bits.join(', ');
}

// Split the "$WBA$<outcome>$WBSEP$<value>" prefix a checked evaluation returns.
function _parseAssertPrefix(value) {
    if (typeof value !== 'string' || !value.startsWith('$WBA$')) return { outcome: null, value };
    const sep = value.indexOf('$WBSEP$');
    if (sep < 0) return { outcome: null, value };
    return { outcome: value.slice(5, sep), value: value.slice(sep + 7) };
}

// Strip the silent JSON-export fallback marker; returns { value, jsonFellBack }.
function _stripJsonFallback(value) {
    if (typeof value === 'string' && value.startsWith('$WBJSONFAIL$')) {
        return { value: value.slice('$WBJSONFAIL$'.length), jsonFellBack: true };
    }
    return { value, jsonFellBack: false };
}

function _captureStructuredResult(controller, operationId, value, label) {
    if (!operationId || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1048576) return;
    try {
        const parsed = JSON.parse(value);
        const op = controller.operations?.get?.(operationId);
        if (!op) return;
        op.structuredJson = value;
        op.structured = parsed;
        if (label) op.structuredJsonLabel = label;
    } catch (_) {}
}

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

        const controller = this._getController(options?.input || {});
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: kernel is not running. Launch the kernel first.')
            ]);
        }

        const claim = await acquireKernelForAgent(controller, {
            operationId: options.input?._operationId,
            owner: 'mcp', kind: 'scratch-evaluation',
            caption: options.input?.caption || `Evaluate: ${expression.slice(0, 100)}`,
            policyOverride: options.input?.busyPolicy,
            sourcePreview: expression.slice(0, 160),
        });
        if (claim.result) return claim.result;
        const lease = claim.lease;

        try {
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
            const _wrapForm = (varName) => _buildOutputFormWrapper(outputForm, varName);
            const _mlCheck = _buildExpectCheck(options.input?.expect);
            const mkWrapped = (expr, wlSec, checkWL) =>
                `Block[{$wbR$, $wbA$}, $wbR$ = TimeConstrained[(${expr}), ${wlSec}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", ${
                    checkWL
                        ? `($wbA$ = Quiet[Check[If[TrueQ[${checkWL}], "PASS", "FAIL"], "ERROR"]]; "$WBA$" <> $wbA$ <> "$WBSEP$" <> (${_wrapForm('$wbR$')}))`
                        : _wrapForm('$wbR$')
                }]]`;

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
                // expect applies to the LAST statement only (documented in schema).
                const isLast = outIdx === lines.length;
                const evalP    = trackedEvaluate(controller, mkWrapped(ln, wlSec, isLast ? _mlCheck : null), {
                    interactive: false,
                    onPrint: p => linePrints.push(cleanPrintLine(p))
                });
                const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), remaining));
                try {
                    const result = await Promise.race([evalP, timeoutP]);
                    if (linePrints.length) {
                        const ps = linePrints.join('\n').replace(/\n$/, '');
                        parts.push(`Print:\n${ps}`);
                    }
                    const msgs = summariseMsgs((result?.messages ?? []).map(cleanWrapperFromMsg));
                    if (msgs.length) parts.push(msgs.join('\n'));
                    if (suppressed) {
                        parts.push(`${label}= (suppressed)`);
                    } else if (result?.result?.type === 'abort') {
                        parts.push(`${label}= (aborted)`);
                        break;
                    } else if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                        // Report the REQUEST budget, not the per-statement remainder
                        // (a "timed out after 7s" on a 30 s request read as a bug).
                        parts.push(`${label}: timed out — ${(remaining / 1000).toFixed(1)}s of the ${timeoutSec}s request budget remained for this statement; kernel is still alive. Simplify the expression or increase timeoutSeconds.`);
                        break;
                    } else if (result?.result?.type === 'string' && result.result.value) {
                        let val = result.result.value.replace(
                            /\\:([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))
                        );
                        const parsedAssert = _parseAssertPrefix(val);
                        val = parsedAssert.value;
                        const jsonInfo = _stripJsonFallback(val);
                        val = jsonInfo.value;
                        if (outputForm === 'json' && !jsonInfo.jsonFellBack) {
                            _captureStructuredResult(controller, options.input?._operationId, val, label);
                        }
                        if (parsedAssert.outcome != null) {
                            const desc = _describeExpect(options.input?.expect);
                            parts.unshift(parsedAssert.outcome === 'PASS'
                                ? `ASSERT PASS — ${desc}`
                                : parsedAssert.outcome === 'FAIL'
                                ? `ASSERT FAIL — expected ${desc}; actual ${label} below.`
                                : `ASSERT ERROR — the check expression itself failed (${desc}).`);
                            const op = options.input?._operationId ? controller.operations?.get?.(options.input._operationId) : null;
                            if (op) op.assertion = { expect: options.input.expect, outcome: parsedAssert.outcome, ts: Date.now() };
                        }
                        if (jsonInfo.jsonFellBack) parts.push('[outputForm:json unavailable — returned InputForm]');
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
        const _wrapFormSingle = (varName) => _buildOutputFormWrapper(outputForm, varName);
        // expect: evaluate and check in ONE round trip — the check runs kernel-side
        // over $wbR$ and rides back as a "$WBA$PASS/FAIL/ERROR$WBSEP$" prefix.
        const _expectCheck = _buildExpectCheck(options.input?.expect);
        const wrappedExpr =
            `Block[{$wbR$, $wbA$}, $wbR$ = TimeConstrained[(${expression}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", ${
                _expectCheck
                    ? `($wbA$ = Quiet[Check[If[TrueQ[${_expectCheck}], "PASS", "FAIL"], "ERROR"]]; "$WBA$" <> $wbA$ <> "$WBSEP$" <> (${_wrapFormSingle('$wbR$')}))`
                    : _wrapFormSingle('$wbR$')
            }]]`;

        const singlePrints = [];
        const evalPromise    = trackedEvaluate(controller, wrappedExpr, {
            interactive: false,
            onPrint: p => singlePrints.push(cleanPrintLine(p))
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
                const printStr = singlePrints.join('\n').replace(/\n$/, '');
                output += `Print:\n${printStr}\n`;
            }

            // Kernel messages (warnings/errors) from the evaluation.
            // Strip internal $wbR$ wrapper artefacts that can appear in syntax-error messages.
            if (result?.messages?.length) {
                const clean = result.messages.map(m => cleanWrapperFromMsg(m));
                output += summariseMsgs(clean).join('\n') + '\n';
            }
            if (result?.result?.type === 'string' && result.result.value === '$WBTIMEOUT$') {
                // WL-level timeout — kernel aborted cleanly, WSTP link is intact.
                // Report the REQUESTED timeout; the internal WL budget is 1 s
                // shorter to leave room for a clean abort (saying "after 2s" on a
                // 3 s request read as a bug in the field).
                output += `Timed out after ${timeoutSec}s (internal WL budget ${wlTimeout}s, 1s reserved for a clean abort) — kernel is still alive.\n` +
                    `Simplify the expression, wrap it in TimeConstrained manually, or increase timeoutSeconds.`;
            } else if (result?.result?.type === 'string' && result.result.value) {
                // Decode WL unicode escapes: \:03B1 → α
                let val = result.result.value.replace(
                    /\\:([0-9A-Fa-f]{4})/g,
                    (_, h) => String.fromCharCode(parseInt(h, 16))
                );
                // Assertion prefix (expect) and silent JSON-export fallback marker.
                const parsedAssert = _parseAssertPrefix(val);
                let assertOutcome = parsedAssert.outcome;
                val = parsedAssert.value;
                const jsonInfo = _stripJsonFallback(val);
                val = jsonInfo.value;
                if (outputForm === 'json' && !jsonInfo.jsonFellBack) {
                    _captureStructuredResult(controller, options.input?._operationId, val);
                }
                // freeOfMessages is a JS-side clause of the assertion.
                if (options.input?.expect?.freeOfMessages === true) {
                    const clean = (result?.messages?.length || 0) === 0;
                    if (assertOutcome == null) assertOutcome = clean ? 'PASS' : 'FAIL';
                    else if (assertOutcome === 'PASS' && !clean) assertOutcome = 'FAIL';
                }
                // Truncate if enormous (>4 KB)
                const MAX = 4096;
                const truncated = val.length > MAX;
                if (truncated) val = val.slice(0, MAX);
                let assertLine = '';
                if (assertOutcome != null) {
                    const desc = _describeExpect(options.input?.expect);
                    assertLine = assertOutcome === 'PASS'
                        ? `ASSERT PASS — ${desc}\n`
                        : assertOutcome === 'FAIL'
                        ? `ASSERT FAIL — expected ${desc}; actual below.\n`
                        : `ASSERT ERROR — the check expression itself failed (${desc}); actual result below.\n`;
                    const op = options.input?._operationId ? controller.operations?.get?.(options.input._operationId) : null;
                    if (op) op.assertion = { expect: options.input.expect, outcome: assertOutcome, ts: Date.now() };
                }
                output = assertLine + output;
                if (jsonInfo.jsonFellBack) output += '[outputForm:json unavailable for this expression — returned InputForm]\n';
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
        } finally {
            controller.arbiter?.release(lease, 'completed');
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

// De-TeX the usage strings VsCodeSymbolMarkdown emits ($...$ runs produced by
// TeXForm over usage boxes).  Plain text is 3-4× cheaper in tokens and just as
// useful to an agent; format:"tex" keeps the raw LaTeX (feedback §5 economy).
function _deTexUsage(text) {
    if (typeof text !== 'string' || !text.includes('$')) return text;
    const unwrapFonts = (t) => {
        // Innermost-first, iterated to a fixpoint — \text{\textit{x}} nests.
        let prev;
        do {
            prev = t;
            t = t.replace(/\\(?:text|textit|textbf|mathrm|mathbf|mathit)\s*\{([^{}]*)\}/g, '$1');
        } while (t !== prev);
        return t;
    };
    const detexRun = (tex) => unwrapFonts(tex)
        .replace(/\\left\s*/g, '').replace(/\\right\s*/g, '')
        .replace(/\\ldots|\\dots|\\cdots/g, '...')
        .replace(/\\infty/g, 'Infinity')
        .replace(/\\times/g, '*')
        .replace(/\\,|\\;|\\!|\\ /g, ' ')
        .replace(/_\{([^{}]*)\}/g, '$1')
        .replace(/\^\{([^{}]*)\}/g, '^$1')
        .replace(/\\([A-Za-z]+)/g, '$1')
        .replace(/[{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Replace inline $...$ runs (non-greedy, no nested $).
    return text.replace(/\$([^$\n]+)\$/g, (_, tex) => detexRun(tex));
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
        // A symbol lookup works from any kernel: fall back to the default entry
        // instead of failing on the multi-kernel guard.
        let controller = null;
        try {
            controller = this._getController(kernelScopedInput(options));
        } catch (_) {
            controller = this._getController?.manager?.defaultEntry?.controller || null;
        }

        let localResult = null;

        // Try in-kernel lookup (only if kernel is available and not busy)
        if (controller && controller.session && controller.kernelStatusString === 'resolved') {
            const longForm = options.input?.longForm !== false;
            const lf = longForm ? 'True' : 'False';
            const expr = `VsCodeSymbolMarkdown["${symbol.replace(/"/g, '')}", ${lf}]`;
            let lease;
            try {
                const claim = await acquireKernelForAgent(controller, {
                    owner: 'wolfbook_lookupSymbol', kind: 'symbol-lookup', caption: `Look up ${symbol}`
                });
                if (!claim.lease) {
                    if (!fetchWeb) return claim.error;
                } else lease = claim.lease;
                if (!lease) throw new Error('kernel busy');
                const result = await Promise.race([
                    trackedEvaluate(controller, expr, { interactive: false }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
                ]);
                if (!token.isCancellationRequested) {
                    localResult = result?.result?.type === 'string' ? result.result.value : null;
                }
            } catch (_) { /* kernel unavailable — fall through */ }
            finally { releaseKernelForAgent(controller, lease); }
        }

        // Default 'text': strip the TeX that VsCodeSymbolMarkdown embeds in usage
        // strings.  'tex'/'markdown' keep it for callers that actually render.
        const format = String(options.input?.format || 'text');
        if (localResult && format === 'text') localResult = _deTexUsage(localResult);

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

    async invoke(options, token) {
        const editor = await resolveNotebookEditor(options.input?.notebook, { skipConfirm: true });
        if (!editor) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(noEditorMsg(options.input?.notebook))
            ]);
        }

        const notebook = editor.notebook;
        // Support both `cells` array and shorthand top-level `kind`+`content`
        let cells = options.input?.cells;
        // Handle case where cells arrives as a JSON string (MCP serialization artifact)
        if (typeof cells === 'string') {
            try { cells = JSON.parse(cells); } catch (_) { cells = null; }
        }
        if (!Array.isArray(cells) || cells.length === 0) {
            if (options.input?.kind && options.input?.content !== undefined) {
                cells = [{ kind: options.input.kind, content: options.input.content,
                    content_encoding: options.input.content_encoding }];
            } else {
                const received = options.input?.cells !== undefined
                    ? ` (received cells=${JSON.stringify(options.input.cells).slice(0, 120)})`
                    : ' (cells parameter not provided)';
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Provide either cells=[{kind,content},...] ("type" is also accepted as an alias for "kind") or top-level kind+content for a single cell.${received}`)
                ]);
            }
        }

        const position = options.input?.position;
        const afterCellId = options.input?.afterCellId;
        const afterCellNum = options.input?.afterCell != null ? Number(options.input.afterCell)
                           : options.input?.afterCellNumber != null ? Number(options.input.afterCellNumber)
                           : undefined;
        const idxRes = resolveInsertIndex(notebook, editor, position, afterCellId, afterCellNum);
        if (idxRes.error) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(idxRes.error)
            ]);
        }
        const insertIdx = idxRes.insertIdx;

        let _mathConverted = false;
        let cellDatas;
        const preparedTexts = [];   // decoded content — previews must show this, not raw base64
        try {
            cellDatas = cells.map(c => {
                const kindVal = c.kind || c.type || 'code';
                const ck = kindVal === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
                const langId = kindVal === 'markdown' ? 'markdown' : 'wolfram';
                const prepared = prepareCellContent({
                    content: c.content || '', kind: kindVal,
                    encoding: c.content_encoding ?? options.input?.content_encoding,
                });
                if (prepared.converted) _mathConverted = true;
                preparedTexts.push(prepared.text);
                return new vscode.NotebookCellData(ck, prepared.text, langId);
            });
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(err.message)]);
        }

        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertIdx, cellDatas)]);

        // Snapshot left editor viewport BEFORE the insert so we can restore it.
        const _vpSnapshot = _snapshotViewport(notebook);

        await vscode.workspace.applyEdit(edit);

        // Reveal the inserted block and flash the first inserted cell.
        // In collab mode: flash in the *right* editor only, skip selection on left.
        // Non-collab: skip selection + flash entirely.
        if (_isCollabMode()) {
            await flashCell(editor, insertIdx);
        }

        // Restore left editor scroll position — the insert scrolled it to the new cell.
        // Evaluation is silent so no further scroll will happen.
        _restoreViewport(_vpSnapshot);

        const firstNew   = insertIdx + 1;
        const lastNew    = insertIdx + cells.length;
        const totalAfter = notebook.cellCount;
        const nbName     = notebook.uri.fsPath.split('/').pop();

        appendEventLog(
            `\u{1F4E5} BULK INSERT ${cells.length} CELL(S) at positions ${firstNew}\u2013${lastNew}`,
            cells.map((c, i) => {
                const preview = (preparedTexts[i] ?? c.content ?? '').trim().slice(0, 100).replace(/\n/g, '\u21B5');
                return `${i + 1}. [${c.kind || c.type || 'code'}] ${preview}`;
            }).join('\n')
        );

        const lines = [
            `Inserted ${cells.length} cell(s) as Cell${ cells.length > 1 ? 's' : ''} ${
                firstNew}${ cells.length > 1 ? '\u2013' + lastNew : ''} of ${totalAfter} in ${nbName}.\n`
        ];
        // Teach the convention once, at the moment it is relevant: the content
        // was silently corrected, so say so briefly rather than let the author
        // keep producing a form that only renders after conversion.
        if (_mathConverted) {
            lines.push('Note: converted LaTeX math delimiters to `$…$` / `$$…$$` — use those in .wb markdown (they render everywhere, including GitHub).\n');
        }
        cells.forEach((c, i) => {
            const decoded = preparedTexts[i] ?? c.content ?? '';
            const preview = decoded.trim().slice(0, 80).replace(/\n/g, '\u21B5');
            const cellAt = notebook.cellAt(insertIdx + i);
            lines.push(`- ${formatCellRef(insertIdx + i, cellAt)} [${c.kind || c.type || 'code'}]: ${preview}${
                decoded.trim().length > 80 ? '\u2026' : ''}`);
        });

        // ── evaluate option: run all inserted code cells through the notebook ──
        // Default true for code cells (pass evaluate:false to suppress)
        const evaluate = options.input?.evaluate !== false;
        if (evaluate) {
            const hasCodeCells = cells.some(c => (c.kind || c.type || 'code') !== 'markdown');
            if (hasCodeCells) {
                const timeoutSec  = Number(options.input?.timeoutSeconds) || 30;
                const deadline    = Date.now() + timeoutSec * 1000;
                const decoder     = new util.TextDecoder();
                const evalResults = [];

                const _ctrl = this._getController?.({ ...(options?.input || {}), notebook: notebook.uri.fsPath });
                if (!_ctrl || typeof _ctrl.execute !== 'function') {
                    lines.push('\n[evaluate] No controller available — cells inserted but not evaluated.');
                } else if (_ctrl.kernelStatusString !== 'resolved') {
                    lines.push('\n[evaluate] Kernel is not running — cells inserted but not evaluated.');
                } else {
                    const claim = await acquireKernelForAgent(_ctrl, {
                        operationId: options.input?._operationId,
                        owner: 'mcp', kind: 'insert-and-evaluate',
                        caption: options.input?.caption || `Evaluate ${cells.length} inserted cell(s)`,
                        notebook: notebook.uri.fsPath,
                        policy: options.input?.busyPolicy
                    });
                    if (!claim.lease) {
                        lines.push('\n[evaluate] Cells were inserted, but evaluation was not started because the kernel is busy. Use wolfbook_kernelStatus, then retry explicitly.');
                        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
                    }
                    try {
                        for (let i = 0; i < cells.length; i++) {
                            if ((cells[i].kind || cells[i].type || 'code') === 'markdown') continue;
                            const idx  = insertIdx + i;

                            const cellDeadline = Math.min(deadline, Date.now() + 300000);
                            const pipeline = await runCellViaPipeline(_ctrl, editor, idx, {
                                timeoutMs: Math.max(1, cellDeadline - Date.now()), token,
                                snapshotViewport: _snapshotViewport, getCellId: getCellToolId,
                            });
                            const updatedCell = pipeline.cell;
                            const outs = [...pipeline.outputs, ...pipeline.messages];
                            const hasError = pipeline.failed || pipeline.aborted ||
                                ['failed', 'aborted', 'stale'].includes(pipeline.provenance?.status);
                            const hasMessages = pipeline.messages.length > 0;
                            const state = pipeline.state;
                            const confirmed = isConfirmed(state);
                            const timedOut = state === CELL_STATE.TIMEOUT;
                            // "✓" requires evidence the cell actually ran (see cell-state.js).
                            const status   = timedOut ? '⏱ timeout'
                                : !confirmed ? `⚠ ${stateLabel(state)}`
                                : hasError ? '✗'
                                : '✓';
                            const outStr   = (confirmed || timedOut)
                                ? summariseEvalOutputs(outs, hasError)
                                : stateRemedy(state);
                            const cellRef  = formatCellRef(idx, updatedCell);
                            // Detect Syntax:: messages — surface prominently so the agent knows
                            // definitions may be stale (e.g. Get[file] with a bad string escape).
                            const hasSyntaxMsg = outs.some(t => /Syntax::\w+:/.test(t));
                            let resultLine = `${cellRef}: ${status} — ${outStr}`;
                            if (hasSyntaxMsg) resultLine += '\n⚠️ SYNTAX MESSAGE DETECTED — definitions loaded before this error may be stale. Fix the syntax issue and reload.';
                            evalResults.push(resultLine);
                            appendEvalLog(cells[i].content || '', outStr);

                            // Stop on error OR on an unconfirmed dispatch: do not evaluate
                            // subsequent cells when this one failed or cannot be proven to
                            // have run — later cells may depend on its definitions.
                            if (hasError || hasSyntaxMsg || timedOut || !confirmed) {
                                evalResults.push(`⛔ Evaluation stopped at cell ${idx + 1} — ${!confirmed && !timedOut ? stateLabel(state) : 'fix the error above before continuing'}. Remaining cells were NOT evaluated.`);
                                break;
                            }

                            if (Date.now() >= deadline) { evalResults.push('(global timeout reached)'); break; }
                        }
                    } finally {
                        releaseKernelForAgent(_ctrl, claim.lease, { state: 'finished' });
                    }

                    if (evalResults.length) {
                        lines.push('\n[evaluate]\n' + evalResults.join('\n'));
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
        const editor = await resolveNotebookEditor(options.input?.notebook, { skipConfirm: true });
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        const notebook = editor.notebook;

        // Accept single/multiple refs by either number or cellId
        const refs = [];
        if (options.input?.cellId != null) refs.push(options.input.cellId);
        if (options.input?.cellNumber != null) refs.push(options.input.cellNumber);
        if (Array.isArray(options.input?.cellIds)) refs.push(...options.input.cellIds);
        if (Array.isArray(options.input?.cellNumbers)) refs.push(...options.input.cellNumbers);
        if (refs.length === 0) {
            if (options.input?.cellIndex != null) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    'Unknown parameter "cellIndex". Use cellId (string) or cellNumber (integer) for a single cell, or cellIds/cellNumbers arrays for multiple. Example: { cellId: "c3a2" } or { cellNumbers: [3, 5, 7] }'
                )]);
            }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Required: cellId (string) or cellNumber (integer) for one cell, or cellIds (string[]) / cellNumbers (integer[]) for multiple. Example: { cellId: "c3a2" } or { cellNumbers: [3, 5, 7] }'
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
        if (sortedDesc.length === 1) {
            const conflict = mutationConflict(notebook.cellAt(sortedDesc[0] - 1), options.input || {});
            if (conflict) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(conflict, null, 2))]);
        }
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
                `Deleted ${d.kindStr} Cell ${d.cellNumber} (CellId: ${d.cellId}; kind: ${d.kindStr}; first line: ${JSON.stringify(d.source.split('\n')[0].slice(0, 200))})${recovery}. Notebook now has ${totalAfter} cell(s).\nContent: ${preview}${d.source.trim().length > 100 ? '\u2026' : ''}`
            )]);
        }

        // Multi-cell summary
        const lines = [`Deleted ${deleted.length} cells${recovery}. Notebook now has ${totalAfter} cell(s).\n`];
        for (const d of deleted) {
            const preview = d.source.trim().slice(0, 100).replace(/\n/g, '\u21b5');
            lines.push(`- Cell ${d.cellNumber} (CellId: ${d.cellId}; kind: ${d.kindStr}; first line: ${JSON.stringify(d.source.split('\n')[0].slice(0, 200))}): ${preview}${d.source.trim().length > 100 ? '\u2026' : ''}`);
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
        if (!['list', 'restore'].includes(action)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Unknown action "${action}". Valid: "list" (default) — preview deleted cells; "restore" — insert them back at optional insertPosition/afterCellId.`
            )]);
        }
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
            lines.push(`- Cell ${newCellNum} [${e.kind}] (CellId: ${id}, was Cell ${e.originalCell} at ${e.timestamp}): ${preview}${e.source.trim().length > 100 ? '\u2026' : ''}`);
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n') + _katexWarningsForCells(cellDatas))]);
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
        if (Array.isArray(options.input?.cells)) {
            const count    = options.input.cells.length;
            const evaluate = options.input?.evaluate !== false;  // default true
            const verb     = evaluate ? 'Edit & evaluate' : 'Edit';
            return { invocationMessage: `${verb} ${count} cell(s) in notebook` };
        }
        const n       = options.input?.cellId || options.input?.cellNumber;
        const content = String(options.input?.content || '');
        const preview = content.length > 100 ? content.slice(0, 100) + '…' : content;
        const evaluate = !!options.input?.evaluate;
        const verb = evaluate ? 'Edit & evaluate' : 'Edit';
        return { invocationMessage: `${verb} cell ${n}:\n\`\`\`\n${preview}\n\`\`\`` };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor(options.input?.notebook, { skipConfirm: true });
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No active notebook editor.')]);

        // ── Batch mode: cells array ───────────────────────────────────────────────
        if (Array.isArray(options.input?.cells)) {
            const items      = options.input.cells;
            if (items.length === 0) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('cells array is empty.')]);
            }
            const notebook    = editor.notebook;
            const nbName      = notebook.uri.fsPath.split('/').pop();
            // evaluate defaults true — run each cell through the real pipeline after editing
            const doEval      = options.input?.evaluate !== false;
            const timeoutSec  = Math.max(5, Number(options.input?.timeoutSeconds) || 30);
            const decoder     = new util.TextDecoder();
            const results     = [];
            let errorCount    = 0;
            let evalErrorCount = 0;

            // Prepare controller once before the loop
            const _ctrl = doEval ? this._getController?.({ ...(options?.input || {}), notebook: notebook.uri.fsPath }) : null;
            const useCtrl = doEval && _ctrl && typeof _ctrl.execute === 'function' && _ctrl.kernelStatusString === 'resolved';
            let _toolLease = null;
            if (useCtrl) {
                const claim = await acquireKernelForAgent(_ctrl, {
                    operationId: options.input?._operationId,
                    owner: 'mcp', kind: 'edit-and-evaluate',
                    caption: options.input?.caption || `Edit and evaluate ${items.length} cell(s)`,
                    notebook: notebook.uri.fsPath,
                    policy: options.input?.busyPolicy
                });
                if (!claim.lease) return claim.error;
                _toolLease = claim.lease;
            }

            const _vpSnapshot = _snapshotViewport(notebook);

            try {
            for (const item of items) {
                if (token.isCancellationRequested) {
                    results.push('⊘ Cancelled.');
                    break;
                }
                if (item == null || (item.cellId == null && item.cellNumber == null)) {
                    results.push(`⚠ Skipped: missing cellId and cellNumber`);
                    errorCount++;
                    continue;
                }
                if (item.content == null) {
                    results.push(`⚠ ${item.cellId ?? item.cellNumber}: missing content`);
                    errorCount++;
                    continue;
                }

                const by = item.cellId != null ? item.cellId : item.cellNumber;
                const resolved = resolveCellIndex(notebook, by, item.cellId != null ? 'cellId' : 'cellNumber');
                if (resolved.error) {
                    results.push(`⚠ ${by}: ${resolved.error}`);
                    errorCount++;
                    continue;
                }

                const idx        = resolved.idx;
                const cellNumber = idx + 1;
                const cell       = notebook.cellAt(idx);
                const conflict = mutationConflict(cell, item);
                if (conflict) { results.push(`⚠ ${by}: ${JSON.stringify(conflict)}`); errorCount++; continue; }
                const cellId     = getCellToolId(cell);
                const isCode     = cell.kind === vscode.NotebookCellKind.Code;
                let newContent;
                try {
                    newContent = prepareCellContent({
                        content: item.content,
                        kind: isCode ? 'code' : 'markdown',
                        encoding: item.content_encoding ?? options.input?.content_encoding,
                    }).text;
                } catch (err) {
                    results.push(`⚠ ${by}: ${err.message}`);
                    errorCount++;
                    continue;
                }
                const oldContent = cell.document.getText();

                // Compact diff summary (3 lines max each side)
                const _ds = (() => {
                    if (oldContent === newContent) return ' [no changes]';
                    const oldLines = oldContent.split('\n');
                    const newLines = newContent.split('\n');
                    const added   = newLines.filter(l => !oldLines.includes(l));
                    const removed = oldLines.filter(l => !newLines.includes(l));
                    const parts = [];
                    if (removed.length > 0) parts.push(removed.slice(0, 3).map(l => `- ${l.trim().slice(0, 60)}`).join('\n') + (removed.length > 3 ? `\n  … +${removed.length - 3} more` : ''));
                    if (added.length > 0)   parts.push(added.slice(0, 3).map(l => `+ ${l.trim().slice(0, 60)}`).join('\n') + (added.length > 3 ? `\n  … +${added.length - 3} more` : ''));
                    return parts.length > 0 ? '\n' + parts.join('\n') : ' [whitespace only]';
                })();

                // ── Apply text edit ───────────────────────────────────────────
                const cellDoc   = cell.document;
                const fullRange = new vscode.Range(
                    0, 0,
                    Math.max(0, cellDoc.lineCount - 1),
                    cellDoc.lineAt(Math.max(0, cellDoc.lineCount - 1)).text.length
                );
                const edit = new vscode.WorkspaceEdit();
                edit.set(cellDoc.uri, [new vscode.TextEdit(fullRange, newContent)]);
                await vscode.workspace.applyEdit(edit);
                appendEventLog(`✏️ EDIT CELL ${cellNumber} [batch]`,
                    newContent.trim().length > 200 ? newContent.trim().slice(0, 200) + '…' : newContent.trim() || '*(empty)*');

                // ── Evaluate via real kernel pipeline ─────────────────────────
                const shouldEval = doEval && (item.evaluate !== false) && isCode && newContent.trim();
                if (!shouldEval) {
                    results.push(`✓ Cell ${cellNumber} (${mutationIdentityText(notebook.cellAt(idx))})${_ds}`);
                    continue;
                }

                if (!useCtrl) {
                    results.push(`✓ Cell ${cellNumber} (${mutationIdentityText(notebook.cellAt(idx))})${_ds}\n  ⚠ Kernel not running — edit applied but not evaluated.`);
                    evalErrorCount++;
                    continue;
                }

                const pipeline = await runCellViaPipeline(_ctrl, editor, idx, {
                    timeoutMs: timeoutSec * 1000, token,
                    snapshotViewport: _snapshotViewport, getCellId: getCellToolId,
                });
                const timedOut = pipeline.state === CELL_STATE.TIMEOUT;
                const updCell = pipeline.cell;
                const outs = pipeline.outputs;
                const msgOuts = pipeline.messages;

                const outSummary = summariseEvalOutputs(outs, msgOuts.length > 0);
                let evalStatus;
                if (timedOut) {
                    evalStatus = `  ⏱ timed out after ${timeoutSec}s`;
                    evalErrorCount++;
                } else if (!isConfirmed(pipeline.state)) {
                    evalStatus = `  ⚠ ${stateLabel(pipeline.state)} — ${stateRemedy(pipeline.state)}`;
                    evalErrorCount++;
                } else if (['failed', 'aborted', 'stale'].includes(pipeline.provenance?.status)) {
                    evalStatus = `  ⛔ ${pipeline.provenance.status}`;
                    evalErrorCount++;
                } else if (msgOuts.length > 0) {
                    const msgSummary = summariseEvalOutputs(msgOuts, true);
                    evalStatus = `  ⚠ ${msgSummary}` + (outs.length > 0 ? `\n  Out= ${outSummary}` : '');
                    evalErrorCount++;
                } else {
                    evalStatus = `  Out= ${outSummary}`;
                }

                const timing = updCell.executionSummary?.timing;
                const timingStr = (!timedOut && timing?.startTime && timing?.endTime)
                    ? ` (${((timing.endTime - timing.startTime) / 1000).toFixed(2)}s)` : '';
                appendEvalLog(newContent, evalStatus.trim());
                results.push(`✓ Cell ${cellNumber} (${mutationIdentityText(notebook.cellAt(idx))})${timingStr}${_ds}\n${evalStatus}`);
            }
            } finally {
            releaseKernelForAgent(_ctrl, _toolLease, { state: 'finished' });
            }

            _restoreViewport(_vpSnapshot);
            const ok = items.length - errorCount;
            const evalNote = doEval && useCtrl
                ? (evalErrorCount > 0 ? ` — ${evalErrorCount} cell(s) had errors/warnings` : ' — all cells evaluated OK')
                : (doEval && !useCtrl ? ' — kernel not running, edits applied without evaluation' : '');
            const summary = `Batch-edited ${ok}/${items.length} cell(s) in ${nbName}${evalNote}.`;
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(summary + '\n' + results.join('\n'))]);
        }

        // ── Single-cell mode ──────────────────────────────────────────────────
        if (options.input?.cellId == null && options.input?.cellNumber == null) {
            // Detect common wrong parameter names and give a clear error
            const _CELL_USAGE = 'Correct parameters: cellId (stable string, preferred) or cellNumber (1-based integer). Call wolfbook_getNotebookContext first to get CellId values. For batch edits, use the "cells" array parameter.';
            if (options.input?.cellIndex != null) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Unknown parameter "cellIndex". ${_CELL_USAGE}`
                )]);
            }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `You must provide either cellId (stable identifier, preferred) or cellNumber (1-based integer) to identify the target cell, or a "cells" array for batch edits. ${_CELL_USAGE}`
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
        const conflict = mutationConflict(cell, options.input || {});
        if (conflict) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(conflict, null, 2))]);
        const cellId     = getCellToolId(cell);

        // Preserve parsed tool content verbatim by default. Explicit "auto"
        // remains available for old clients that send double-escaped payloads.
        // Accept 'newContent' as an alias for 'content' (common model mistake).
        let newContent;
        try {
            newContent = prepareCellContent({
                content: options.input?.content ?? options.input?.newContent ?? cell.document.getText(),
                kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
                encoding: options.input?.content_encoding,
            }).text;
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(err.message)]);
        }
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

        // In collab mode skip selection — prevents right-column editor stealing focus.
        // ── Viewport guard: save scroll position before any mutation.
        if (!_isCollabMode()) {
            // Skip selection + flash in non-collab mode — viewport guard restores later.
        } else {
            await flashCell(editor, idx);
        }
        const _vpSnapshot = _snapshotViewport(notebook);

        const editedMsg = `Edited Cell ${cellNumber} (${mutationIdentityText(notebook.cellAt(idx))}) of ${notebook.cellCount} in ${notebook.uri.fsPath.split('/').pop()}.${_diffSummary}`;
        appendEventLog(`\u270F\uFE0F EDIT CELL ${cellNumber}`,
            newContent.trim().length > 200 ? newContent.trim().slice(0, 200) + '\u2026' : newContent.trim() || '*(empty)*');

        const evaluate = !!options.input?.evaluate;
        if (evaluate && cell.kind !== vscode.NotebookCellKind.Markup && newContent.trim()) {
            const controller = this._getController?.({ ...(options?.input || {}), notebook: notebook.uri.fsPath });
            if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    editedMsg + '\n[evaluate] Kernel is not running.'
                )]);
            }
            const claim = await acquireKernelForAgent(controller, {
                operationId: options.input?._operationId,
                owner: 'mcp', kind: 'edit-and-evaluate',
                caption: options.input?.caption || `Edit and evaluate Cell ${cellNumber}`,
                notebook: notebook.uri.fsPath, cellId, cellNumber,
                sourcePreview: newContent.slice(0, 160), policy: options.input?.busyPolicy
            });
            if (!claim.lease) return claim.error;
            const timeoutSec = Number(options.input?.timeoutSeconds) || 15;
            try {
                const pipeline = await runCellViaPipeline(controller, editor, idx, {
                    timeoutMs: timeoutSec * 1000, token,
                    snapshotViewport: _snapshotViewport, getCellId: getCellToolId,
                });
                const evalOut = pipeline.state === CELL_STATE.TIMEOUT
                    ? `Timed out after ${timeoutSec}s; operation ${claim.lease.operationId} is still running.`
                    : !isConfirmed(pipeline.state)
                    ? `⚠ ${stateLabel(pipeline.state)}. ${stateRemedy(pipeline.state)}`
                    : (pipeline.provenance?.status === 'stale'
                        ? `Stale-result conflict: Cell ${cellNumber} changed during evaluation. Output was retained only in operation ${claim.lease.operationId}.`
                        : (pipeline.plain || `(${stateLabel(CELL_STATE.EVALUATED_NO_OUTPUT)})`));
                appendEvalLog(newContent, evalOut.trim());
                _restoreViewport(_vpSnapshot);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    editedMsg + '\n\n[evaluate]\n' + evalOut.trim()
                )]);
            } catch (err) {
                const errMsg = isKernelConnectionError(err.message) ? KERNEL_CRASH_MSG : `Error: ${err.message}`;
                appendEvalLog(newContent, errMsg);
                _restoreViewport(_vpSnapshot);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(editedMsg + '\n[evaluate] ' + errMsg)]);
            } finally {
                releaseKernelForAgent(controller, claim.lease, { state: 'finished' });
            }
        }

        _restoreViewport(_vpSnapshot);
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
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const n = options.input?.cellId || options.input?.cellNumber;
        if (n == null) {
            const s = options.input?.startCell || 1, e = options.input?.endCell || '\u2026';
            return { invocationMessage: `Run cells ${s}\u2013${e} sequentially` };
        }
        return { invocationMessage: `Run cell ${n} in notebook` };
    }

    async invoke(options, token) {
        const editor = await resolveNotebookEditor(options.input?.notebook, { skipConfirm: true });
        if (!editor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(noEditorMsg(options.input?.notebook))]);

        const _claimCtrl = this._getController?.({ ...(options?.input || {}), notebook: editor.notebook.uri.fsPath });
        const claim = await acquireKernelForAgent(_claimCtrl, {
            operationId: options.input?._operationId,
            owner: 'mcp', kind: options.input?.cellId || options.input?.cellNumber ? 'cell-evaluation' : 'range-evaluation',
            caption: options.input?.caption || 'Run notebook cell(s)',
            policyOverride: options.input?.busyPolicy,
            notebook: editor.notebook.uri.fsPath,
            cellId: options.input?.cellId || null,
            cellNumber: options.input?.cellNumber || null,
        });
        if (claim.result) return claim.result;
        const _toolLease = claim.lease;
        try {

        // ── detect wrong parameter names ──────────────────────────────────────
        const _CELL_USAGE = 'Correct parameters: cellId (stable string, preferred) or cellNumber (1-based integer) for a single cell; startCell/endCell for a range.';
        if (options.input?.cellIndex != null || options.input?.cell_index != null) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Unknown parameter "cellIndex". ${_CELL_USAGE}`
            )]);
        }
        if (options.input?.index != null && options.input?.cellId == null && options.input?.cellNumber == null) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Unknown parameter "index". ${_CELL_USAGE}`
            )]);
        }

        // ── range mode: no cell target given — run a range of cells ──────────
        const hasCellTarget = options.input?.cellId != null || options.input?.cellNumber != null;
        if (!hasCellTarget) {
            const notebook    = editor.notebook;
            const startCell   = Math.max(1, Number(options.input?.startCell) || 1);
            const endCell     = Math.min(notebook.cellCount, Number(options.input?.endCell) || notebook.cellCount);
            const timeoutSec  = Math.max(10, Number(options.input?.timeoutSeconds) || 120);
            const stopOnFailure = options.input?.stop_on_failure !== false && options.input?.stopOnError !== false;
            const messagePolicy = options.input?.message_policy === 'stop' ? 'stop' : 'collect';
            const errorsOnly  = options.input?.errorsOnly === true;

            if (startCell > endCell || startCell < 1) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Invalid range ${startCell}\u2013${endCell}. Notebook has ${notebook.cellCount} cell(s).`
                )]);
            }

            const deadline  = Date.now() + timeoutSec * 1000;
            const results   = [];
            let   codeCount = 0;
            let   stopped   = null;

            const _ctrl = this._getController?.({ ...(options?.input || {}), notebook: notebook.uri.fsPath });
            const useSilent = _ctrl && typeof _ctrl.execute === 'function' && _ctrl.kernelStatusString === 'resolved';

            for (let n = startCell; n <= endCell; n++) {
                if (token.isCancellationRequested) { stopped = `cancelled at Cell ${n}`; break; }
                const idx  = n - 1;
                const cell = notebook.cellAt(idx);
                if (cell.kind === vscode.NotebookCellKind.Markup) continue;

                const remaining = deadline - Date.now();
                if (remaining <= 0) { stopped = `global timeout (${timeoutSec}s) reached before Cell ${n}`; break; }

                let pipeline = null;
                let fbUnconfirmed = null;   // fallback path: unconfirmed/timeout state
                if (useSilent) {
                    pipeline = await runCellViaPipeline(_ctrl, editor, idx, {
                        timeoutMs: Math.min(deadline - Date.now(), 300000), token,
                        snapshotViewport: _snapshotViewport, getCellId: getCellToolId,
                    });
                } else {
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
                    // Evidence for the fallback path: the VS Code execution record.
                    // An unchanged endTime means we CANNOT claim the cell ran.
                    const newEnd = notebook.cellAt(idx).executionSummary?.timing?.endTime ?? 0;
                    if (!(newEnd > prevEndTime)) {
                        fbUnconfirmed = Date.now() >= cellDeadline
                            ? CELL_STATE.TIMEOUT : CELL_STATE.DISPATCHED_UNCONFIRMED;
                    }
                }

                const updatedCell = pipeline?.cell || notebook.cellAt(idx);
                codeCount++;

                const committed = pipeline || readCommittedOutputs(updatedCell);
                const outs = [...committed.outputs, ...committed.messages];
                const hasError = committed.failed || committed.aborted ||
                    ['failed', 'aborted', 'stale'].includes(committed.provenance?.status);
                const hasMessages = committed.messages.length > 0;
                const state = pipeline ? pipeline.state
                    : (fbUnconfirmed || (hasError ? CELL_STATE.FAILED
                        : hasMessages ? CELL_STATE.EVALUATED_WITH_MESSAGES
                        : committed.outputs.length > 0 ? CELL_STATE.EVALUATED_WITH_OUTPUT
                        : CELL_STATE.EVALUATED_NO_OUTPUT));
                const confirmed = isConfirmed(state);
                const timedOut = state === CELL_STATE.TIMEOUT;

                // "\u2713" requires evidence that the cell actually ran (provenance or an
                // advanced execution record) \u2014 mere absence of activity never earns it.
                const status = timedOut ? '\u23F1 timeout'
                    : !confirmed ? `\u26A0 ${stateLabel(state)}`
                    : hasError ? '\u2717'
                    : '\u2713';
                const outStr = (confirmed || timedOut)
                    ? summariseEvalOutputs(outs, hasError)
                    : stateRemedy(state);
                // Detect Syntax:: messages — surface prominently so the agent knows
                // definitions may be stale (e.g. Get[file] with a bad string escape).
                const hasSyntaxMsg = outs.some(t => /Syntax::\w+:/.test(t));
                let resultLine = `Cell ${n}: ${status} \u2014 ${outStr}`;
                if (hasSyntaxMsg) resultLine += '\n  \u26A0\uFE0F SYNTAX MESSAGE DETECTED \u2014 definitions loaded before this error may be stale.';
                // errorsOnly: only include cells that had messages/warnings
                if (!errorsOnly || hasError || hasMessages || timedOut || !confirmed) {
                    results.push(resultLine);
                }

                if (stopOnFailure && hasError) { stopped = `stopped at Cell ${n} — evaluation failed (pass stop_on_failure:false to continue)`; break; }
                if (!confirmed && !timedOut) { stopped = `stopped at Cell ${n} — ${stateLabel(state)}; later cells were not run`; break; }
                if (messagePolicy === 'stop' && hasMessages) { stopped = `stopped at Cell ${n} — message_policy is stop`; break; }
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
                `Cell ${cellNumber} (CellId: ${cellId}) is a markdown cell — nothing to run.`
            )]);
        }

        const timeoutSec = Number(options.input?.timeoutSeconds) || 30;

        const _ctrl = this._getController?.({ ...(options?.input || {}), notebook: notebook.uri.fsPath });
        let pipeline = null;
        let fbUnconfirmed = null;   // fallback path: unconfirmed/timeout state
        if (_ctrl && typeof _ctrl.execute === 'function' && _ctrl.kernelStatusString === 'resolved') {
            pipeline = await runCellViaPipeline(_ctrl, editor, idx, {
                timeoutMs: timeoutSec * 1000, token, snapshotViewport: _snapshotViewport,
                flashCell, getCellId: getCellToolId,
            });
        } else {
            // Fallback: no controller available
            editor.selection = new vscode.NotebookRange(idx, idx + 1);
            await vscode.commands.executeCommand('notebook.cell.execute');
            const deadline = Date.now() + timeoutSec * 1000;
            const prevEndTime = cell.executionSummary?.timing?.endTime ?? 0;
            await new Promise(resolve => {
                const poll = () => {
                    if (token.isCancellationRequested) { resolve(); return; }
                    const newEnd = notebook.cellAt(idx).executionSummary?.timing?.endTime ?? 0;
                    if (newEnd > prevEndTime || Date.now() >= deadline) resolve();
                    else setTimeout(poll, 250);
                };
                setTimeout(poll, 400);
            });
            // Evidence for the fallback path: the VS Code execution record.
            const newEnd = notebook.cellAt(idx).executionSummary?.timing?.endTime ?? 0;
            if (!(newEnd > prevEndTime)) {
                fbUnconfirmed = Date.now() >= deadline
                    ? CELL_STATE.TIMEOUT : CELL_STATE.DISPATCHED_UNCONFIRMED;
            }
        }

        if (token.isCancellationRequested) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Cancelled.')]);
        }

        // Collect outputs from the (now-updated) cell.
        // The error sentinel output (wolfram-html-html + vnd.code.notebook.error) is a
        // hidden output whose text/plain item holds all kernel messages (warnings, errors).
        // Regular outputs (results, Print[], graphics) are the non-sentinel ones.
        const updatedCell = pipeline?.cell || notebook.cellAt(idx);
        const committed = pipeline || readCommittedOutputs(updatedCell);
        const outs = committed.outputs;
        const msgOuts = committed.messages;

        // Evidence-based state: "executed" is claimed only when provenance or the
        // VS Code execution record confirms it (see tools/cell-state.js).
        const state = pipeline ? pipeline.state
            : (fbUnconfirmed || (committed.failed ? CELL_STATE.FAILED
                : msgOuts.length > 0 ? CELL_STATE.EVALUATED_WITH_MESSAGES
                : outs.length > 0 ? CELL_STATE.EVALUATED_WITH_OUTPUT
                : CELL_STATE.EVALUATED_NO_OUTPUT));
        const confirmed = isConfirmed(state);
        const timedOut = state === CELL_STATE.TIMEOUT;

        const total     = notebook.cellCount;
        const timing    = updatedCell.executionSummary?.timing;
        const timingStr = (confirmed && timing?.startTime && timing?.endTime)
            ? ` (${((timing.endTime - timing.startTime) / 1000).toFixed(2)} s)`
            : '';

        const resultParts = [];
        if (committed.provenance?.status === 'stale') {
            resultParts.push(`Cell ${cellNumber} (CellId: ${cellId}) changed during evaluation; the stale result was not attached. See operation ${_toolLease.operationId}.`);
        } else if (timedOut) {
            resultParts.push(`Cell ${cellNumber} (CellId: ${cellId}) of ${total} timed out after ${timeoutSec}s (execution may still be running).`);
        } else if (!confirmed) {
            resultParts.push(`Cell ${cellNumber} (CellId: ${cellId}) of ${total}: ${stateLabel(state)}.`);
            resultParts.push(stateRemedy(state, { kernelLabel: _ctrl?.kernelIdentity?.label }));
        } else {
            resultParts.push(`Cell ${cellNumber} (CellId: ${cellId}) of ${total} executed${timingStr}.`);
        }

        if (outs.length > 0) {
            resultParts.push(outs.join('\n'));
        } else if (confirmed) {
            resultParts.push(`(${stateLabel(CELL_STATE.EVALUATED_NO_OUTPUT)})`);
        }

        if (msgOuts.length > 0) {
            resultParts.push(`\n\u26A0 Kernel messages (${msgOuts.length}):\n${msgOuts.join('\n')}`);
        }
        // Also flag if any normal outputs contain inline Mathematica messages (Symbol::tag: pattern)
        // that didn't come through the error sentinel \u2014 these can otherwise be missed.
        if (msgOuts.length === 0) {
            const inlineMsgs = outs.filter(o => /\b\w+::\w+:/.test(o));
            if (inlineMsgs.length > 0) {
                resultParts.push(`\n\u26A0 Output contains kernel messages (check above output carefully):\n${inlineMsgs.join('\n')}`);
            }
        }

        const inputPreview = (cell.document.getText?.() || '').trim().slice(0, 200).replace(/\n/g, '\u21B5') || '(code cell)';
        const outputSummary = timedOut
            ? `TIMEOUT after ${timeoutSec}s`
            : !confirmed
            ? `\u26A0 ${stateLabel(state)}`
            : (outs.length > 0 ? outs.join(' | ').slice(0, 300) : '(no output)') +
              (msgOuts.length > 0 ? `  \u26A0 ${msgOuts.join(' | ').slice(0, 200)}` : '');
        appendEventLog(
            `\u25B6\uFE0F RUN CELL ${cellNumber}${timingStr}`,
            `**In [${cellNumber}]:** \`${inputPreview}\`\n**Out:** ${outputSummary}`
        );

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(resultParts.join('\n'))]);
        } finally {
            releaseKernelForAgent(_claimCtrl, _toolLease, 'completed');
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_inspectSymbols (canonical; wolfbook_getKernelState is a deprecated
// alias) — list user-defined symbols with values/rule counts.  NOTE: this tool
// EVALUATES in the kernel — it is not a side-effect-free status probe; use
// wolfbook_status for that.
// ---------------------------------------------------------------------------

class InspectSymbolsTool {
    constructor(getController) {
        this._getController = getController;
    }

    async prepareInvocation(options, _token) {
        const pattern = options.input?.pattern || 'Global`*';
        return { invocationMessage: `Get kernel state (${pattern})` };
    }

    async invoke(options, _token) {
        let controller;
        try {
            controller = this._getController?.(kernelScopedInput(options));
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(String(err.message))]);
        }
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Kernel is not running.')]);
        }
        const claim = await acquireKernelForAgent(controller, {
            operationId: options.input?._operationId,
            owner: 'mcp', kind: 'symbol-inspection',
            caption: `Inspect symbols ${options.input?.pattern || 'Global`*'}`,
            policyOverride: options.input?.busyPolicy,
        });
        if (claim.result) return claim.result;
        const lease = claim.lease;

        try {
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
        // Filter Wolfbook plumbing by default: init.wl deliberately interns
        // ~21 VsCode*/WB* symbols into Global` (plus the tools' own $wb* Block
        // locals), which otherwise head every Global`* dump (feedback §4.5).
        const includeInternal = options.input?.includeInternal === true;
        const namesOnly = options.input?.namesOnly === true;
        const symLimit = Math.max(1, Math.min(1000, Number(options.input?.limit) || 100));
        const internalFilter = includeInternal ? '' :
            `$wbS$=Select[$wbS$,!StringMatchQ[#,("VsCode*"|"WB*"|"$wb*"|"$WB*"|"*\`VsCode*"|"*\`WB*"|"*\`$wb*"|"$setKernelConfig"|"ClearGlobals"|"*\`$setKernelConfig"|"*\`ClearGlobals")]&];`;
        if (namesOnly) {
            const namesExpr =
                `Block[{$wbS$=Sort[Names["${safePattern}"]]},${internalFilter}` +
                `If[$wbS$==={},"(no symbols matching ${safePattern})",` +
                `StringJoin[Riffle[Take[$wbS$,UpTo[${symLimit}]],"\\n"]]<>If[Length[$wbS$]>${symLimit},"\\n... and "<>ToString[Length[$wbS$]-${symLimit}]<>" more",""]]]`;
            try {
                const result = await Promise.race([
                    trackedEvaluate(controller, `Block[{$wbR$}, $wbR$ = TimeConstrained[(${namesExpr}), 9, "$WBTIMEOUT$"]; If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]`, { interactive: false }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
                ]);
                const val = result?.result?.type === 'string' ? result.result.value : '(no output)';
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Symbols (${safePattern}${includeInternal ? '' : ', internals hidden'}):\n${val.replace(/\\n/g, '\n')}`
                )]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Error: ${err.message}`)]);
            }
        }
        const wlExpr = [
            `Block[{$wbS$=Sort[Names["${safePattern}"]]},${internalFilter}Block[{$wbS2$=Take[$wbS$,UpTo[${symLimit}]],`,
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
            `If[$wbS2$==={},"(no symbols matching ${safePattern})",`,
            `With[{$wbLines$=DeleteCases[Map[$wbFmt$,$wbS2$],Nothing|$Failed]},`,
            `If[$wbLines$==={},"(no symbols with definitions matching ${safePattern})",`,
            `StringJoin[Riffle[$wbLines$,"\\n"]]<>If[Length[$wbS$]>${symLimit},"\\n... limited to ${symLimit} of "<>ToString[Length[$wbS$]]<>" symbols (pass limit to raise)",""]]]]]]`
        ].join('');

        const timeoutSec = 10;
        const wlTimeout  = 9;
        const wrapped =
            `Block[{$wbR$}, $wbR$ = TimeConstrained[(${wlExpr}), ${wlTimeout}, "$WBTIMEOUT$"]; If[$wbR$ === "$WBTIMEOUT$", "$WBTIMEOUT$", If[StringQ[$wbR$], $wbR$, ToString[$wbR$, InputForm]]]]`;

        try {
            const result = await Promise.race([
                trackedEvaluate(controller, wrapped, { interactive: false }),
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
                    `Kernel state (${safePattern}${includeInternal ? '' : '; Wolfbook internals hidden — includeInternal:true to show'}):\n${val}`
                )]);
            }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('(no output from kernel state query)')]);
        } catch (err) {
            const errMsg = isKernelConnectionError(err.message) ? KERNEL_CRASH_MSG : `Error: ${err.message}`;
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(errMsg)]);
        }
        } finally {
            controller.arbiter?.release(lease, 'completed');
        }
    }
}

// ---------------------------------------------------------------------------
// wolfbook_status — ONE side-effect-free status surface (feedback §4.1/§5).
// scope: kernels | operations | notebook | all.  'clients' (and the clients
// section of 'all') is rendered by the MCP primary's transport intercept —
// only it owns the cross-window table.  Never touches controller.session,
// never shows an editor, never takes a lease.
// ---------------------------------------------------------------------------
class StatusTool {
    constructor(getController) {
        this._getController = getController;
        this._manager = getController?.manager;
    }

    _kernelLines() {
        const manager = this._manager;
        if (!manager) return ['(no kernel manager)'];
        const notebooks = _allNotebookUris ? [..._allNotebookUris().keys()] : [];
        const rows = manager.list ? manager.list(notebooks) : [];
        if (!rows.length) return ['(no kernels)'];
        return rows.map(k => {
            const nb = (k.notebooks || []).map(p => String(p).split('/').pop()).join(', ');
            return `${k.kernel_label || '?'} ${k.kernel_id} · ${k.lifecycle || '?'}${k.remote ? ' · remote' : ''}${nb ? ` · ${nb}` : ''}`;
        });
    }

    _operationLines(controller) {
        const journal = controller?.operations?.journal?.(5) || [];
        if (!journal.length) return ['(no recent operations)'];
        return journal.map(op => {
            const mark = op.state === 'failed' ? '✗' : op.state === 'completed' ? '✓' : '·';
            const when = (op.started_at || '').replace(/^.*T/, '').replace(/\..*$/, '');
            return `${mark} ${when} ${op.tool || '?'} ${String(op.caption || '').slice(0, 40)} [${op.state}]`;
        });
    }

    async _notebookLines(input) {
        const doc = await resolveNotebookDocument(input?.notebook);
        if (!doc) return ['(no notebook resolved)'];
        const binding = this._manager?.bindingFor?.(doc.uri.fsPath);
        return [
            `${doc.uri.fsPath.split('/').pop()} · ${doc.cellCount} cells · ${doc.isDirty ? 'DIRTY' : 'saved'} · v${doc.version}`,
            `path: ${doc.uri.fsPath}`,
            `kernel binding: ${binding ? `${binding.label} ${binding.id}` : '(none)'}`,
        ];
    }

    async invoke(options, _token) {
        const input = options.input || {};
        // Legacy shape: wolfbook_kernelStatus alias emits the raw arbiter JSON.
        if (input._legacyShape) {
            let controller = null;
            try { controller = this._getController?.(kernelScopedInput(options)); }
            catch (err) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(String(err.message))]);
            }
            const status = controller?.arbiter?.status(controller) || {
                lifecycle: controller?.kernelStatusString === 'resolved' ? 'idle' : 'offline',
                busy: !!controller?._evalDispatched,
                queueDepth: controller?.executionQueue?.queueLength?.() || 0,
            };
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(status, null, 2))]);
        }
        const scope = input.scope || 'all';
        let controller = null;
        try { controller = this._getController?.({ notebook: input.notebook, kernel_id: input.kernel_id }); } catch (_) {}
        if (!controller) controller = this._manager?.defaultEntry?.controller || null;
        const sections = [];
        if (scope === 'kernels' || scope === 'all') sections.push('Kernels:', ...this._kernelLines().map(l => '  ' + l));
        if (scope === 'operations' || scope === 'all') sections.push('Recent operations:', ...this._operationLines(controller).map(l => '  ' + l));
        if (scope === 'notebook' || scope === 'all') sections.push('Notebook:', ...(await this._notebookLines(input)).map(l => '  ' + l));
        if (!sections.length) sections.push(`Unknown scope "${scope}". Use clients | kernels | operations | notebook | all.`);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(sections.join('\n'))]);
    }
}

// Memory-only lifecycle snapshot. This must never touch controller.session.
class KernelStatusTool {
    constructor(getController) { this._getController = getController; }
    async invoke(options, _token) {
        let controller;
        try {
            controller = this._getController?.(kernelScopedInput(options));
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(String(err.message))]);
        }
        const status = controller?.arbiter?.status(controller) || {
            lifecycle: controller?.kernelStatusString === 'resolved' ? 'idle' : 'offline',
            busy: !!controller?._evalDispatched,
            queueDepth: controller?.executionQueue?.queueLength?.() || 0,
        };
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(status, null, 2))
        ]);
    }
}

class OperationStatusTool {
    constructor(getController) { this._getController = getController; }
    async invoke(options, _token) {
        const id = String(options.input?.operation_id || '').trim();
        const { controller, error } = resolveControllerForOperation(this._getController, options, id);
        if (!controller) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                error ? `Unknown operation_id: ${id || '(missing)'} — and no kernel could be resolved. ${error.message}`
                      : `Unknown operation_id: ${id || '(missing)'}`
            )]);
        }
        const waitSeconds = Math.max(0, Math.min(300, Number(options.input?.wait_seconds) || 0));
        if (waitSeconds && controller?.operations) {
            await controller.operations.wait(id, waitSeconds * 1000);
        }
        const snapshot = controller?.operations?.snapshot(id, {
            includeProgress: options.input?.include_progress !== false,
            afterSequence: options.input?.after_sequence,
        });
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            snapshot ? JSON.stringify(snapshot, null, 2) : `Unknown operation_id: ${id || '(missing)'}`
        )]);
    }
}

class SaveNotebookTool {
    async invoke(options, _token) {
        // Saving needs only the document — never shows/focuses the notebook.
        const notebook = await resolveNotebookDocument(options.input?.notebook);
        if (!notebook) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(noEditorMsg(options.input?.notebook))]);
        const filePath = notebook.uri.fsPath;
        if (!filePath || /\.nb$/i.test(filePath)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'This document cannot be saved in place. Use Save As and choose .wb, .evsnb, or .vsnb.'
            )]);
        }
        const saved = await notebook.save();
        if (!saved) throw new Error(`VS Code did not save ${filePath}`);
        const bytes = await fs.promises.readFile(filePath);
        const stat = await fs.promises.stat(filePath);
        const result = {
            path: path.resolve(filePath), bytes: bytes.length,
            mtime: stat.mtime.toISOString(), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            dirty: notebook.isDirty, version: notebook.version,
        };
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    }
}

class GetResultTool {
    constructor(getController) { this._getController = getController; }
    async invoke(options, _token) {
        const id = String(options.input?.handle || options.input?.operation_id || '').trim();
        const { controller, error } = resolveControllerForOperation(this._getController, options, id);
        if (!controller && error) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Unknown result handle: ${id || '(missing)'} — and no kernel could be resolved. ${error.message}`
            )]);
        }
        const op = controller?.operations?.get(id);
        if (!op) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `Unknown result handle: ${id || '(missing)'}. Operations are kept per kernel (last 50) and are invalidated when that kernel restarts.`
        )]);
        const hasPath = Object.prototype.hasOwnProperty.call(options.input || {}, 'path');
        if (hasPath) {
            let structured = op.structured;
            if (structured == null && typeof op.structuredJson === 'string') {
                try { structured = JSON.parse(op.structuredJson); } catch (_) {}
            }
            if (structured == null && typeof op.result === 'string') {
                const candidate = op.result.replace(/^\s*Out(?:\[\d+\])?=\s*/, '');
                try { structured = JSON.parse(candidate); } catch (_) {}
            }
            if (structured == null) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
                    error: 'No structured JSON result is available for this operation.',
                    hint: 'Re-run the evaluation with outputForm:"json".'
                }, null, 2))]);
            }
            const resolved = resolveJsonPath(structured, options.input.path);
            if (resolved.error) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(resolved, null, 2))]);
            if (resolved.root) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
                handle: op.id, path: [], manifest: resolved.manifest
            }, null, 2))]);
            const value = JSON.stringify(resolved.value, null, 2);
            const offset = Math.max(0, Number(options.input?.offset) || 0);
            const limit = Math.max(1, Math.min(65536, Number(options.input?.limit) || 8192));
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
                handle: op.id, path: options.input.path, manifest: resolved.manifest,
                offset, limit, total: value.length,
                next_offset: offset + limit < value.length ? offset + limit : null,
                data: value.slice(offset, offset + limit)
            }, null, 2))]);
        }
        const format = options.input?.format === 'json' ? 'json' : 'text';
        let value = typeof op.result === 'string' ? op.result : JSON.stringify(op.result ?? '');
        if (format === 'json') {
            try { value = JSON.stringify(typeof op.result === 'string' ? JSON.parse(op.result) : op.result, null, 2); }
            catch (_) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Result is not valid JSON.')]); }
        }
        const offset = Math.max(0, Number(options.input?.offset) || 0);
        const limit = Math.max(1, Math.min(65536, Number(options.input?.limit) || 8192));
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
            handle: op.id, kernel_id: controller?.kernelIdentity?.kernel_id || op.kernelId || null,
            format, offset, limit, total: value.length,
            next_offset: offset + limit < value.length ? offset + limit : null,
            data: value.slice(offset, offset + limit)
        }, null, 2))]);
    }
}

/** ~20-line post-compaction re-orientation digest.  Memory-only: derived from
 *  OperationRegistry.journal() + arbiter.status(); never touches the kernel.
 *  Exported as a pure function for headless tests. */
function renderJournalDigest(controller) {
    const kid = controller?.kernelIdentity || {};
        const status = controller?.arbiter?.status?.(controller) || {};
        const journal = controller?.operations?.journal(50) || [];
        const lines = [];
        lines.push(`Kernel ${kid.label || '?'} ${kid.kernel_id || ''} · ${status.lifecycle || 'unknown'}` +
            (status.queueDepth ? ` · queue ${status.queueDepth}` : '') +
            ` · ${journal.length} operation(s) retained`);
        const notebooks = new Map();
        for (const op of journal) {
            if (!op.notebook) continue;
            const base = String(op.notebook).split('/').pop();
            notebooks.set(base, (notebooks.get(base) || 0) + 1);
        }
        if (notebooks.size) {
            lines.push('Notebooks touched: ' + [...notebooks.entries()].map(([n, c]) => `${n} (${c} op${c === 1 ? '' : 's'})`).join(', '));
        }
        const failures = journal.filter(op => op.state === 'failed' || op.error);
        const assertions = journal.filter(op => op.assertion);
        const aborts = journal.filter(op => op.cancellation);
        lines.push('Last operations:');
        for (const op of journal.slice(0, 5)) {
            const mark = op.state === 'failed' ? '✗' : op.state === 'completed' ? '✓' : '·';
            const when = (op.started_at || '').replace(/^.*T/, '').replace(/\..*$/, '');
            const what = op.caption || op.tool || '?';
            const preview = (op.result_preview || '').replace(/\s+/g, ' ').slice(0, 60);
            const assertNote = op.assertion ? ` ASSERT ${op.assertion.outcome}` : '';
            lines.push(`  ${mark} ${when}  ${what.slice(0, 40)}  ${(op.elapsed_ms / 1000).toFixed(1)}s${assertNote}${preview ? `  ${preview}` : ''}`);
        }
        lines.push(`Failures: ${failures.length} · Assertions: ${assertions.filter(o => o.assertion.outcome === 'PASS').length} pass / ${assertions.filter(o => o.assertion.outcome !== 'PASS').length} fail · Aborts: ${aborts.length}`);
        const lastErr = failures[0];
        if (lastErr) lines.push(`Latest error: ${String(lastErr.error || lastErr.result_preview || '').slice(0, 120)} (operation ${String(lastErr.operation_id).slice(0, 8)}…)`);
        if (controller?.operations?.hasRestarted) lines.push('Note: the kernel restarted this session — earlier operations were invalidated.');
        return lines.join('\n');
}

function filterJournal(journal, filters = {}) {
    const all = Array.isArray(journal) ? journal : [];
    let items = all;
    if (filters.tool) {
        const needle = String(filters.tool).toLowerCase();
        items = items.filter(op => String(op.tool || '').toLowerCase().includes(needle));
    }
    if (filters.state != null) {
        const states = (Array.isArray(filters.state) ? filters.state : [filters.state]).map(v => String(v).toLowerCase());
        items = items.filter(op => states.includes(String(op.state || '').toLowerCase()));
    }
    if (filters.caption_contains) {
        const needle = String(filters.caption_contains).toLowerCase();
        items = items.filter(op => String(op.caption || '').toLowerCase().includes(needle));
    }
    if (filters.notebook) {
        const needle = String(filters.notebook).toLowerCase();
        items = items.filter(op => {
            const full = String(op.notebook || '').toLowerCase();
            return full === needle || path.basename(full) === path.basename(needle);
        });
    }
    return items;
}

function _journalFilters(input = {}) {
    // The MCP transport injects the SESSION TARGET's notebook into args when the
    // caller passed none (routing convenience). Treating that injection as a
    // journal FILTER silently hid every other notebook's operations — a call
    // with no explicit filters reported "matched 4 of 10". Only an
    // explicitly-passed notebook filters (the transport marks its injection).
    const notebook = input._notebookInjected ? undefined : input.notebook;
    return { tool: input.tool, state: input.state, caption_contains: input.caption_contains, notebook };
}

function renderSessionReport(controller, { journal, notebook } = {}) {
    const operations = Array.isArray(journal) ? journal : controller?.operations?.journal?.(50) || [];
    const identity = controller?.kernelIdentity || {};
    const status = controller?.arbiter?.status?.(controller) || {};
    const lines = [
        '# Wolfbook session report', '',
        `Generated: ${new Date().toISOString()}`,
        `Kernel: ${identity.label || '?'} · ${identity.kernel_id || 'unknown'} · ${status.lifecycle || 'unknown'}`,
    ];
    if (controller?.operations?.hasRestarted) lines.push('', '> Warning: the kernel restarted during this retained session; earlier operations may have been invalidated.');
    const notebooks = [...new Set(operations.map(op => op.notebook).filter(Boolean))];
    if (notebook && !notebooks.includes(notebook)) notebooks.unshift(notebook);
    lines.push('', '## Notebooks touched', '', ...(notebooks.length ? notebooks.map(item => `- ${item}`) : ['- None recorded.']));
    lines.push('', '## Operations', '', '| # | time | tool | caption | state | elapsed | assertion |',
        '|---:|---|---|---|---|---:|---|');
    operations.slice(0, 50).forEach((op, index) => {
        const esc = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
        lines.push(`| ${index + 1} | ${esc(op.started_at)} | ${esc(op.tool)} | ${esc(op.caption)} | ${esc(op.state)} | ${Number(op.elapsed_ms || 0)} ms | ${esc(op.assertion?.outcome || '')} |`);
    });
    const failures = operations.filter(op => op.state === 'failed' || op.error);
    lines.push('', '## Failures', '');
    if (!failures.length) lines.push('None.');
    for (const op of failures) {
        lines.push(`### ${op.operation_id} — ${op.caption || op.tool}`, '', String(op.error || 'Operation failed.'), '', '```text', String(op.result_preview || '').slice(0, 400), '```', '');
    }
    const abandoned = operations.filter(op => op.state === 'aborted' || op.cancellation || ['pending', 'running'].includes(op.state));
    lines.push('', '## Aborted / abandoned', '');
    if (!abandoned.length) lines.push('None.');
    for (const op of abandoned) lines.push(`- ${op.operation_id}: ${['pending', 'running'].includes(op.state) ? 'still open' : op.state} — ${JSON.stringify(op.cancellation || {})}`);
    const artifactText = operations.map(op => `${op.result_preview || ''}\n${op.error || ''}`).join('\n');
    const paths = artifactText.match(/(?:\/[\w. -]+){2,}/g) || [];
    const hashes = artifactText.match(/\b[a-fA-F0-9]{64}\b/g) || [];
    lines.push('', '## Saved artifacts (best-effort — extracted from result previews)', '');
    const artifacts = [...new Set([...paths, ...hashes])].slice(0, 100);
    lines.push(...(artifacts.length ? artifacts.map(item => `- ${item}`) : ['- None detected in retained previews.']));
    lines.push('', '## Kernel', '', '```json', JSON.stringify(status, null, 2), '```', '');
    return lines.join('\n');
}

class EvaluationJournalTool {
    constructor(getController) { this._getController = getController; }

    async invoke(options, _token) {
        let controller;
        try {
            controller = this._getController?.(kernelScopedInput(options));
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(String(err.message))]);
        }
        if ((options.input?.action || '') === 'digest') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(renderJournalDigest(controller))
            ]);
        }
        const all = controller?.operations?.journal(50) || [];
        const filters = _journalFilters(options.input);
        const hasFilters = Object.values(filters).some(value => value != null && value !== '');
        const matched = filterJournal(all, filters);
        const limit = Math.max(1, Math.min(50, Number(options.input?.limit) || 20));
        const journal = matched.slice(0, limit);
        if ((options.input?.action || '') === 'export') {
            const markdown = renderSessionReport(controller, { journal: matched, notebook: options.input?.notebook });
            const os = require('os');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const base = path.join(os.tmpdir(), `wolfbook-session-report-${stamp}`);
            let reportPath = null;
            for (let i = 1; i <= 20; i++) {
                const candidate = `${base}${i === 1 ? '' : `-${i}`}.md`;
                if (!fs.existsSync(candidate)) { reportPath = candidate; break; }
            }
            try {
                if (!reportPath) throw new Error('all 20 collision-safe report filenames already exist');
                fs.writeFileSync(reportPath, markdown, 'utf8');
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
                    path: path.resolve(reportPath), operations: matched.length,
                    bytes: Buffer.byteLength(markdown), preview: markdown.slice(0, 1500)
                }, null, 2))]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    `Could not write session report: ${err.message}\n\nINLINE REPORT\n\n${markdown}`
                )]);
            }
        }
        const payload = hasFilters ? { filtered: true, matched: matched.length, of: all.length, operations: journal } : journal;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))
        ]);
    }
}

class CancelOperationTool {
    constructor(getController) { this._getController = getController; }

    async prepareInvocation(options) {
        const mode = options.input?.mode || 'abort';
        return { invocationMessage: mode === 'discard-result'
            ? 'Discard an operation result without interrupting the kernel'
            : 'Cancel a Wolfbook operation' };
    }

    async invoke(options) {
        const id = String(options.input?.operation_id || '').trim();
        if (!id) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('operation_id is required.')]);
        const resolved = resolveControllerForOperation(this._getController, options, id);
        if (!resolved.controller) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `Unknown operation_id: ${id}${resolved.error ? ` — ${resolved.error.message}` : ''}`
        )]);
        const controller = resolved.controller;
        const op = controller.operations?.get?.(id);
        if (!op) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Unknown operation_id: ${id}`)]);
        if (!['pending', 'running'].includes(op.state)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
                operation_id: id, cancelled: false, already: op.state
            }, null, 2))]);
        }
        const mode = options.input?.mode === 'discard-result' ? 'discard-result' : 'abort';
        const reason = options.input?.reason || `wolfbook_cancelOperation ${mode}`;
        let arbiterResult = null;
        if (mode === 'discard-result') {
            controller.operations.abort(id, { requestedBy: 'mcp', reason, mode, ts: Date.now() });
        } else {
            try {
                arbiterResult = await controller.arbiter?.abort?.(controller, {
                    operationId: id, requestedBy: 'mcp', reason
                }) || null;
            } catch (err) {
                arbiterResult = { aborted: false, error: err.message };
            } finally {
                // Even a queued-but-undispatched operation, an operation mismatch,
                // or a kernel-side abort exception must settle in the registry.
                controller.operations.abort(id, { requestedBy: 'mcp', reason, mode, ts: Date.now() });
            }
        }
        let note = mode === 'discard-result'
            ? 'Result discarded; the kernel may still be computing.'
            : 'Operation cancelled and registry settled.';
        if (arbiterResult?.uncertain) note = 'Kernel abort is uncertain; poll wolfbook_status.';
        if (arbiterResult?.reason === 'operation-mismatch') note = 'Kernel is running a different operation; this operation will never run.';
        const registryState = controller.operations?.get?.(id)?.state || null;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
            operation_id: id, mode,
            kernel_id: controller.kernelIdentity?.kernel_id || op.kernelId || null,
            arbiter: arbiterResult, registry_state: registryState, note
        }, null, 2))]);
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

    // Checkpoint files live in the OS temp dir; forward slashes so the path is
    // valid inside a WL string on every platform.
    _newCheckpointPath(tag) {
        const safeName = tag ? String(tag).replace(/[^a-zA-Z0-9_-]/g, '') + '-' : '';
        return path.join(require('os').tmpdir(), `wolfbook-checkpoint-${safeName}${Date.now()}.mx`)
            .replace(/\\/g, '/');
    }

    async invoke(options, _token) {
        const action = options.input?.action || 'abort';
        let controller;
        try {
            // An abort that names an operation should hit the kernel that OWNS the
            // operation, not whichever kernel the input/notebook would resolve to.
            const opId = String(options.input?.operation_id || '').trim();
            const resolved = resolveControllerForOperation(this._getController, options, action === 'abort' ? opId : null);
            if (resolved.error) throw resolved.error;
            controller = resolved.controller;
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(String(err.message))]);
        }
        if (!controller) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No kernel controller available.')]);
        }

        // --- checkpoint: DumpSave all Global` definitions to a temp .mx file ---
        if (action === 'checkpoint') {
            let lease;
            try {
                const claim = await acquireKernelForAgent(controller, {
                    owner: 'wolfbook_kernelControl', kind: 'checkpoint', caption: 'Save kernel checkpoint'
                });
                if (!claim.lease) return claim.error;
                lease = claim.lease;
                const checkpointPath = this._newCheckpointPath(options.input?.tag || '');
                const expr = `DumpSave["${checkpointPath}", "Global\`"]`;
                await trackedEvaluate(controller, expr, { interactive: false });
                this._checkpointPath = checkpointPath;
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Checkpoint saved → ${checkpointPath}\nTo restore later: use action="restore".`)
                ]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Checkpoint failed: ${err.message}`)
                ]);
            } finally { releaseKernelForAgent(controller, lease); }
        }

        // --- restore: ClearAll Global`, then Get the checkpoint file ---
        if (action === 'restore') {
            const restorePath = options.input?.path || this._checkpointPath;
            if (!restorePath) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No checkpoint to restore. Call with action="checkpoint" first, or provide a "path" to an .mx file.')
                ]);
            }
            let lease;
            try {
                const claim = await acquireKernelForAgent(controller, {
                    owner: 'wolfbook_kernelControl', kind: 'restore', caption: 'Restore kernel checkpoint'
                });
                if (!claim.lease) return claim.error;
                lease = claim.lease;
                const expr = `ClearAll["Global\`*"]; Get["${restorePath}"]; Length[Names["Global\`*"]]`;
                const result = await trackedEvaluate(controller, expr, { interactive: false });
                // session.evaluate resolves to { result: {type, value}, messages } —
                // reach the .value or the message renders "[object Object]".
                const symCount = result?.result?.value ?? result?.value
                    ?? (typeof result === 'object' ? '' : result);
                // Every prior result handle/provenance entry refers to wiped state.
                controller.operations?.invalidateAll?.('kernel state restored from checkpoint');
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Kernel state restored from ${restorePath}` +
                        (symCount !== '' && symCount != null ? ` — ${symCount} Global\` symbols loaded.` : '.') +
                        '\nEarlier operation results were invalidated (they referred to the pre-restore state).')
                ]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Restore failed: ${err.message}`)
                ]);
            } finally { releaseKernelForAgent(controller, lease); }
        }

        if (action === 'restart') {
            // Auto-checkpoint before wiping Global` — restart becomes reversible
            // when the kernel is healthy.  DumpSave needs a RESPONSIVE kernel
            // (exactly what a stuck restart lacks), so: 'if-idle' (default) only
            // checkpoints an idle healthy kernel, hard 10 s cap, NEVER blocks the
            // restart, and the response says truthfully what happened.
            const cpMode = options.input?.checkpoint_before_restart || 'if-idle';
            let cpNote = '';
            if (cpMode !== 'never') {
                const busy = controller.arbiter?.status?.(controller)?.busy || controller._evalDispatched;
                const healthy = controller.kernelStatusString === 'resolved';
                if (!healthy || (busy && cpMode !== 'always')) {
                    cpNote = `\nCheckpoint skipped — kernel was ${!healthy ? 'not responsive' : 'busy'} (checkpoint_before_restart: "${cpMode}").`;
                } else {
                    const checkpointPath = this._newCheckpointPath('pre-restart');
                    try {
                        await Promise.race([
                            trackedEvaluate(controller, `DumpSave["${checkpointPath}", "Global\`"]`, { interactive: false }),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('checkpoint timed out after 10s')), 10000)),
                        ]);
                        this._checkpointPath = checkpointPath;
                        cpNote = `\nPre-restart checkpoint saved → ${checkpointPath} (action="restore" to load it into the fresh kernel).`;
                    } catch (cpErr) {
                        cpNote = `\nCheckpoint skipped — ${cpErr.message}.`;
                    }
                }
            }
            try {
                controller.arbiter?.invalidate('kernel restart requested by MCP');
                controller.operations?.invalidateAll('kernel restart requested by MCP');
                await controller.restartKernel();
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Kernel restarted successfully.' + cpNote)]);
            } catch (err) {
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Restart failed: ${err.message}${cpNote}`)]);
            }
        }
        // action === 'abort'
        if (!controller._evalDispatched && !controller.isAborting) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No evaluation is currently running.')]);
        }
        try {
            await controller.arbiter.abort(controller, {
                operationId: options.input?.operation_id,
                requestedBy: 'mcp',
                reason: options.input?.reason || 'explicit wolfbook_kernelControl abort'
            });
            if (options.input?.operation_id) {
                controller.operations?.abort(options.input.operation_id, {
                    requestedBy: 'mcp', reason: options.input?.reason || 'explicit abort', ts: Date.now()
                });
            }
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Abort signal sent to kernel.')]);
        } catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Abort failed: ${err.message}`)]);
        }
    }
}

class KernelManagerTool {
    constructor(getController) { this._manager = getController?.manager; }
    async invoke(options, _token) {
        const manager = this._manager;
        if (!manager) throw new Error('Kernel manager is unavailable.');
        const input = options.input || {};
        const action = input.action || 'list';
        const notebooks = _allNotebookUris ? [..._allNotebookUris().keys()] : [];
        let result;
        if (action === 'list') result = { kernels: manager.list(notebooks) };
        else if (action === 'create') {
            if (input.acknowledge_resource_cost !== true) throw new Error('Creating another Wolfram process may consume memory and a license seat; retry with acknowledge_resource_cost=true.');
            const entry = await manager.create({ label: input.label });
            result = input.notebook
                ? await manager.bind(input.notebook, entry.id)
                : manager.describe(entry, null);
        }
        else if (action === 'bind' || action === 'select') result = await manager.bind(input.notebook, input.kernel_id);
        else if (action === 'default') result = await manager.bind(input.notebook, manager.defaultEntry.id);
        else if (action === 'unbind') result = await manager.unbind(input.notebook);
        else if (action === 'rename') result = manager.rename(input.kernel_id, input.label);
        else if (action === 'stop') { await manager.stop(input.kernel_id); result = { stopped: input.kernel_id }; }
        else throw new Error(`Unknown kernel manager action: ${action}`);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
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
// wolfbook_moveCell — move (or copy) a cell within or between notebooks
// ---------------------------------------------------------------------------

class MoveCellTool {
    async prepareInvocation(options, _token) {
        const from      = options.input?.cellId || options.input?.cellNumber;
        const to        = options.input?.afterCellId || options.input?.toPosition;
        const isCopy    = options.input?.copy === true;
        const srcNb     = options.input?.sourceNotebook;
        const dstNb     = options.input?.targetNotebook || options.input?.notebook;
        const verb      = isCopy ? 'Copy' : 'Move';
        const crossNote = srcNb || dstNb ? ` (${srcNb || 'active'} → ${dstNb || 'active'})` : '';
        return { invocationMessage: `${verb} cell ${from} to after ${to}${crossNote}` };
    }

    async invoke(options, _token) {
        const isCopy      = options.input?.copy === true;
        const srcNbName   = options.input?.sourceNotebook || options.input?.notebook;
        const dstNbName   = options.input?.targetNotebook;

        // ── resolve source notebook ──────────────────────────────────────────
        const srcEditor = await resolveNotebookEditor(srcNbName, { skipConfirm: true });
        if (!srcEditor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            srcNbName ? `Source notebook "${srcNbName}" not found. Use wolfbook_getNotebookContext(action:"list") to see open notebooks.`
                      : 'No active notebook editor.'
        )]);

        const srcNotebook = srcEditor.notebook;
        const fromRef = options.input?.cellId != null ? options.input?.cellId : options.input?.cellNumber;
        if (fromRef == null) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Required: cellId (stable string, preferred) or cellNumber (1-based integer) to identify the source cell. Example: { cellId: "c3a2", toPosition: 5 } or { cellNumber: 3, afterCellId: "c5b1" }'
            )]);
        }
        const fromRes = resolveCellIndex(srcNotebook, fromRef, options.input?.cellId != null ? 'cellId' : 'cellNumber');
        if (fromRes.error) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(fromRes.error)]);

        const fromIdx    = fromRes.idx;
        const cellNumber = fromIdx + 1;
        const cell       = srcNotebook.cellAt(fromIdx);
        const conflict = mutationConflict(cell, options.input || {});
        if (conflict) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(conflict, null, 2))]);
        const kind       = cell.kind;
        const lang       = cell.document.languageId;
        const source     = cell.document.getText();
        const stableId   = await _ensureCellToolId(srcNotebook, fromIdx);
        const kindStr    = kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';

        // ── resolve destination notebook ─────────────────────────────────────
        const dstEditor = dstNbName
            ? await resolveNotebookEditor(dstNbName, { skipConfirm: true })
            : srcEditor;
        if (!dstEditor) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
            `Target notebook "${dstNbName}" not found. Use wolfbook_getNotebookContext(action:"list") to see open notebooks.`
        )]);

        const dstNotebook  = dstEditor.notebook;
        const crossNotebook = dstNotebook.uri.toString() !== srcNotebook.uri.toString();

        // ── resolve destination position ─────────────────────────────────────
        let toPosition;
        const afterCellId = options.input?.afterCellId;
        if (typeof afterCellId === 'string' && afterCellId.trim()) {
            const toRes = resolveCellIndex(dstNotebook, afterCellId, 'afterCellId');
            if (toRes.error) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(toRes.error)]);
            toPosition = toRes.idx + 1;
        } else {
            toPosition = options.input?.toPosition != null ? Number(options.input.toPosition) : NaN;
        }

        if (isNaN(toPosition)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Required: afterCellId (stable cellId in the target notebook) or toPosition (0 = beginning, ${dstNotebook.cellCount} = end). Example: { cellId: "c3a2", targetNotebook: "other.wb", toPosition: 5 }`
            )]);
        }
        // clamp toPosition to valid range
        toPosition = Math.max(0, Math.min(dstNotebook.cellCount, Math.round(toPosition)));

        // Within same notebook: no-op check
        if (!crossNotebook && (toPosition === cellNumber || toPosition === cellNumber - 1)) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Cell ${cellNumber} is already at that position — no move needed.`
            )]);
        }

        // ── build cell data to insert ─────────────────────────────────────────
        const cellData = new vscode.NotebookCellData(kind, source, lang);
        cellData.metadata = { ...(cell.metadata || {}), toolId: stableId };

        // ── apply edits ───────────────────────────────────────────────────────
        if (crossNotebook) {
            // Two separate edits: insert into destination, then (if move) delete from source
            const insertEdit = new vscode.WorkspaceEdit();
            insertEdit.set(dstNotebook.uri, [vscode.NotebookEdit.insertCells(toPosition, [cellData])]);
            await vscode.workspace.applyEdit(insertEdit);

            if (!isCopy) {
                const deleteEdit = new vscode.WorkspaceEdit();
                deleteEdit.set(srcNotebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(fromIdx, fromIdx + 1))]);
                await vscode.workspace.applyEdit(deleteEdit);
            }
        } else {
            // Same notebook: atomic delete + re-insert
            const edit = new vscode.WorkspaceEdit();
            edit.set(srcNotebook.uri, [
                vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(fromIdx, fromIdx + 1)),
                vscode.NotebookEdit.insertCells(toPosition, [cellData])
            ]);
            await vscode.workspace.applyEdit(edit);
        }

        // ── compute new position label ────────────────────────────────────────
        const newPos = crossNotebook ? toPosition + 1
                     : (toPosition < cellNumber ? toPosition + 1 : toPosition);
        const posLabel   = toPosition === 0 ? 'beginning' : `after position ${toPosition}`;
        const srcNbLabel = srcNotebook.uri.fsPath.split('/').pop();
        const dstNbLabel = dstNotebook.uri.fsPath.split('/').pop();
        const verb       = isCopy ? 'Copied' : 'Moved';

        const logAction = isCopy
            ? `📋 COPY ${kindStr.toUpperCase()} CELL ${cellNumber} → ${dstNbLabel}`
            : crossNotebook
                ? `↔️ CROSS-NB MOVE ${kindStr.toUpperCase()} CELL ${cellNumber} ${srcNbLabel} → ${dstNbLabel}`
                : `↕️ MOVE ${kindStr.toUpperCase()} CELL ${cellNumber} → position ${newPos}`;
        appendEventLog(logAction, source.trim().slice(0, 100) || '*(empty)*');

        const summary = crossNotebook
            ? `${verb} ${kindStr} Cell ${cellNumber} (CellId: ${stableId}; kind: ${kindStr}; first line: ${JSON.stringify(source.split('\n')[0].slice(0, 200))}) from ${srcNbLabel} to Cell ${newPos} (${posLabel}) of ${dstNbLabel}.`
            : `${verb} ${kindStr} Cell ${cellNumber} (CellId: ${stableId}; kind: ${kindStr}; first line: ${JSON.stringify(source.split('\n')[0].slice(0, 200))}) to Cell ${newPos} (${posLabel}). Notebook now has ${srcNotebook.cellCount} cell(s).`;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(summary)]);
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
        // Routing-neutral read: never shows or focuses the notebook.
        const notebook = await resolveNotebookDocument(options.input?.notebook);
        if (!notebook) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(noEditorMsg(options.input?.notebook))]);

        const query = options.input?.query;
        if (!query) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('query parameter is required.')]);

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
                matches.push(`Cell ${cellNo} [${cellKind}] (CellId: ${cellId}; ${matchedIn.join('+')}) — ${preview}${src.trim().length > 120 ? '\u2026' : ''}`);
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
        const controller = this._getController?.(options?.input || {});
        if (!controller || !controller.session || controller.kernelStatusString !== 'resolved') {
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
        let lease;
        try {
            const claim = await acquireKernelForAgent(controller, {
                owner: 'wolfbook_findPackage', kind: 'paclet-search', caption: `Search paclets for ${query}`
            });
            if (!claim.lease) return '  (kernel busy — the running evaluation was not interrupted)';
            lease = claim.lease;
            const r = await Promise.race([
                trackedEvaluate(controller, wlExpr, { interactive: false }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 22000))
            ]);
            if (r?.result?.type === 'string' && r.result.value) return r.result.value;
            return '  (no results)';
        } catch (_) { return '  (paclet search error)'; }
        finally { releaseKernelForAgent(controller, lease); }
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
        // The log lives under globalStorage (see utils/log-paths.js), not beside the
        // notebook, and only exists when wolfbook.advanced.diagnosticLogs is enabled.
        const logPaths = require('../utils/log-paths');
        if (!logPaths.diagnosticsEnabled()) {
            return `## Kernel Debug Log\nDisabled.\nEnable \`wolfbook.advanced.diagnosticLogs\` in settings, restart the kernel, and reproduce the issue to capture a log.`;
        }

        let logPath = null;
        const ed = vscode.window.activeNotebookEditor;
        if (ed && ed.notebook && ed.notebook.uri.scheme === 'file') {
            const candidate = logPaths.notebookLogFile(ed.notebook.uri.fsPath, 'wolfram-kernel-debug.log');
            if (candidate && fs.existsSync(candidate)) logPath = candidate;
        }
        // Fallback: most recently written kernel log across all notebooks
        // (e.g. the kernel crashed with no notebook focused).
        if (!logPath) {
            const nbRoot = path.join(logPaths.logRoot(), 'notebooks');
            let best = null;
            try {
                for (const sub of fs.readdirSync(nbRoot)) {
                    const candidate = path.join(nbRoot, sub, 'wolfram-kernel-debug.log');
                    if (fs.existsSync(candidate)) {
                        const mtime = fs.statSync(candidate).mtimeMs;
                        if (!best || mtime > best.mtime) best = { path: candidate, mtime };
                    }
                }
            } catch (_) {}
            if (best) logPath = best.path;
        }
        if (!logPath) {
            return `## Kernel Debug Log\nNot found.\nExpected under: ${path.join(logPaths.logRoot(), 'notebooks', '<notebook>')}/wolfram-kernel-debug.log\n(The log is created fresh each time the kernel starts.)`;
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
// wolfbook_showImage — return a base64 thumbnail of a local image file
// ---------------------------------------------------------------------------

class ShowImageTool {
    async prepareInvocation(options, _token) {
        const p = options.input?.path || '?';
        return { invocationMessage: `Show image: ${path.basename(p)}` };
    }

    async invoke(options, _token) {
        const imgPath = options.input?.path;
        if (!imgPath) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('path is required.')]);
        if (!fs.existsSync(imgPath)) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`File not found: ${imgPath}`)]);

        const ext = path.extname(imgPath).toLowerCase();
        const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
        const mime = mimeMap[ext] || 'image/png';

        const maxBytes = 512 * 1024; // 512 KB cap — avoid flooding context
        const stat = fs.statSync(imgPath);
        if (stat.size > 4 * 1024 * 1024) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `File too large to inline (${(stat.size / 1024 / 1024).toFixed(1)} MB). Use wolfbook_runTerminal to inspect it or resize first.`
            )]);
        }

        const buf = fs.readFileSync(imgPath);
        const b64 = buf.slice(0, maxBytes).toString('base64');
        const truncated = buf.length > maxBytes;

        const dims = (() => {
            try {
                // Quick PNG/JPEG dimension read without external deps
                if (ext === '.png' && buf.length >= 24) {
                    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
                    return `${w}×${h}`;
                }
                if ((ext === '.jpg' || ext === '.jpeg') && buf.length > 4) {
                    let i = 2;
                    while (i < buf.length) {
                        const marker = buf.readUInt16BE(i);
                        if (marker >= 0xFFC0 && marker <= 0xFFC3) {
                            const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
                            return `${w}×${h}`;
                        }
                        i += 2 + buf.readUInt16BE(i + 2);
                    }
                }
            } catch (_) {}
            return null;
        })();

        const header = [`Image: ${path.basename(imgPath)}`,
            dims ? `Dimensions: ${dims} px` : '',
            `Size: ${(stat.size / 1024).toFixed(1)} KB`,
            truncated ? `(preview truncated to 512 KB)` : ''].filter(Boolean).join(' | ');

        // Return header as text + image as a data URI text part.
        // The MCP server detects data:image/... parts and promotes them to MCP image content blocks.
        // VS Code Copilot receives both as text parts.
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(header),
            new vscode.LanguageModelTextPart(`data:${mime};base64,${b64}`),
        ]);
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
            // Entries are shown relative to the LISTED BASE (with a header naming
            // it) — relativising against the workspace root prefixed every entry
            // of an outside-the-workspace listing with ../../../.. noise.
            const walk = (dir, d) => {
                if (d > depth || results.length >= maxFiles) return;
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const e of entries) {
                    if (e.name.startsWith('.')) continue;
                    const full = path.join(dir, e.name);
                    const rel  = path.relative(base, full);
                    if (e.isDirectory()) { results.push(rel + '/'); walk(full, d + 1); }
                    else if (!ext || e.name.endsWith(ext.startsWith('.') ? ext : '.' + ext)) results.push(rel);
                    if (results.length >= maxFiles) break;
                }
            };
            walk(base, 0);
            const trunc = results.length >= maxFiles;
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `base: ${base}\n` +
                (results.join('\n') + (trunc ? '\n[truncated at 500 entries]' : '') || '(empty directory)'))]);
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
// AskSpecialistTool
// ---------------------------------------------------------------------------

class AskSpecialistTool {
    /**
     * @param {() => import('./askSpecialistPanel').AskSpecialistPanel} getPanel
     */
    constructor(getPanel) {
        this._getPanel = getPanel;
    }

    async prepareInvocation(options, _token) {
        const { question } = options.input;
        return {
            invocationMessage: `🔔 Asking specialist: ${String(question).slice(0, 80)}${String(question).length > 80 ? '…' : ''}`,
        };
    }

    async invoke(options, _token) {
        const { question, context } = options.input;

        // Focus the Ask Specialist panel so the user sees the blinking panel
        try {
            await vscode.commands.executeCommand('wolfbook.askSpecialist.focus');
        } catch (_) { /* panel may not be visible yet — ask() will buffer the question */ }

        const panel = this._getPanel();
        if (!panel) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Ask Specialist panel is not available. Ask the user directly.'
                ),
            ]);
        }

        const reply = await panel.ask(String(question), context ? String(context) : '');

        if (!reply) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'The user dismissed the Ask Specialist panel without replying. ' +
                    'Use your best judgment or re-ask later if the question is critical.'
                ),
            ]);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Specialist replied: "${reply}". Incorporate this into your plan and proceed.`
            ),
        ]);
    }
}

// ---------------------------------------------------------------------------
// Registration helper — called from extension.js activate()
// ---------------------------------------------------------------------------

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
                case 'read':       return await this._read(options);
                case 'bibtex':     return await this._bibtex(options);
                case 'bibitem':    return await this._bibitem(options);
                case 'references': return await this._references(options);
                case 'citations':  return await this._citations(options);
                default:
                    return this._result(`Unknown action "${action}". Use: search, read, bibtex, bibitem, references, citations.`);
            }
        } catch (e) {
            return this._result(`Error: ${e.message}`);
        }
    }

    /**
     * action:'read' — fetch a paper's FULL TEXT (ar5iv / arXiv-HTML; abstract page as
     * last resort) and return headings, numbered display equations (LaTeX), and the
     * body text most relevant to an optional focus query. Closes the gap where agents
     * could find/cite papers but not actually read them.
     */
    async _read(options) {
        const id = String(options.input?.identifier || '').replace(/^arXiv:/i, '').trim();
        if (!/^\d{4}\.\d{4,5}(v\d+)?$/.test(id) && !/^[a-z][a-z.-]+\/\d{7}(v\d+)?$/i.test(id)) {
            return this._result('Error: action "read" requires an arXiv ID (e.g. "2103.15840" or "hep-th/0212208"). Use action "search" first to find it.');
        }
        const fetched = await paperSearch.fetchPaperHtml(id);
        if (!fetched.html) return this._result(`Could not fetch any text for arXiv:${id}.`);

        const maxEqs = Math.min(Number(options.input?.maxEquations) || 40, 120);
        const sections = paperSearch.extractSections(fetched.html, { maxText: 24000, maxEqs, maxSections: 40 });

        // Optional focus query: return the most relevant text chunks instead of the head.
        const query = String(options.input?.query || '').trim();
        const text = sections.textSample || '';
        let excerpt;
        if (query && text.length > 3000) {
            const kw = new Set(query.toLowerCase().match(/[a-z0-9$-]+/g) || []);
            const CHUNK = 2000;
            const chunks = [];
            for (let i = 0; i < text.length; i += CHUNK) chunks.push({ i, c: text.slice(i, i + CHUNK) });
            const scored = chunks.map(({ i, c }) => {
                const toks = new Set(c.toLowerCase().match(/[a-z0-9$-]+/g) || []);
                let hit = 0; for (const t of kw) if (toks.has(t)) hit++;
                return { i, c, score: kw.size ? hit / kw.size : 0 };
            }).sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.i - b.i);
            excerpt = scored.map(s => `…${s.c}…`).join('\n\n---\n\n');
        } else {
            excerpt = text.slice(0, 6000);
        }

        const eqLines = (sections.equationsTagged && sections.equationsTagged.length)
            ? sections.equationsTagged.map(e => (e.eqNumber ? `(${e.eqNumber})  ` : '      ') + e.latex)
            : (sections.equations || []);

        const lines = [
            `**arXiv:${id}** — full text: ${fetched.hasFullText ? 'YES' : 'NO (abstract page only — equations unreliable)'} (source: ${fetched.source})`,
            '',
            '**Sections:** ' + (sections.headings || []).slice(0, 30).join(' | '),
            '',
            `**Display equations (${eqLines.length}${sections.equationsTagged ? ', numbered where the paper numbers them' : ''}):**`,
            ...eqLines.map(l => '  ' + l),
            '',
            query ? `**Text most relevant to "${query}":**` : '**Text (beginning):**',
            excerpt,
            '',
            '_Equations are HTML-extracted transcriptions — verify in the kernel before relying on them._',
        ];
        return this._result(lines.join('\n'));
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

// ---------------------------------------------------------------------------
// wolfbook_skilxiv — compact action-dispatch gateway to the SkilXiv lifecycle.
// One shallow schema avoids adding dozens of tool definitions to model context.
// ---------------------------------------------------------------------------

const SKILXIV_ACTION_RISK = Object.freeze({
    report_outcome: 'uploads-user-text', create_draft: 'private-write', update_draft: 'private-write',
    publish_draft: 'public-write', delete_draft: 'destructive', create_revision: 'private-write',
    create_pack: 'private-write', remix: 'private-write', create_collection: 'private-write',
    add_collection_item: 'private-write', share_collection: 'public-write',
    unshare_collection: 'public-write', request_skill: 'public-write', claim_request: 'public-write',
    fulfil_request: 'public-write',
});

class SkilXivTool {
    constructor(context) { this._context = context; }

    async prepareInvocation(options, _token) {
        const action = String(options.input?.action || 'help');
        const result = { invocationMessage: `SkilXiv: ${action}` };
        const risk = SKILXIV_ACTION_RISK[action];
        if (risk) {
            result.confirmationMessages = {
                title: `Allow SkilXiv action “${action}”?`,
                message: `Risk: ${risk}. This action changes server state or may upload information. Review the supplied parameters and destination registry before continuing.`,
            };
        }
        return result;
    }

    async invoke(options, _token) {
        const action = String(options.input?.action || 'help');
        const p = options.input?.params || {};
        try {
            if (action === 'help') return this._result(this._help());
            const client = await this._client();
            const result = await this._dispatch(client, action, p);
            return this._result(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
        } catch (e) {
            return this._result(JSON.stringify({ ok: false, action, error: e.message }, null, 2));
        }
    }

    async _client() {
        const cfg = vscode.workspace.getConfiguration('wolfbook.oberon.recall.skilxiv');
        return require('../oberon/fairy/skilxivCredentials').createClient({ baseUrl: cfg.get('baseUrl', 'https://skilxiv.org') });
    }

    _need(p, ...keys) {
        for (const key of keys) if (p[key] === undefined || p[key] === null || p[key] === '') {
            throw new Error(`params.${key} is required`);
        }
    }

    async _dispatch(c, action, p) {
        const e = encodeURIComponent;
        switch (action) {
            case 'search':
                return c.search(p.query || '', { tags: p.tags, limit: p.limit || 5, minTier: p.min_tier || 0 });
            case 'get_skill':
                this._need(p, 'namespace', 'name'); return c.getSkill(e(p.namespace), e(p.name), p.version && e(p.version));
            case 'get_versions':
                this._need(p, 'namespace', 'name'); return c.request(`/skills/${e(p.namespace)}/${e(p.name)}/versions`);
            case 'diff_versions':
                this._need(p, 'namespace', 'name', 'from', 'to'); return c.request(`/skills/${e(p.namespace)}/${e(p.name)}/diff`, { query: { from: p.from, to: p.to } });
            case 'citation':
                this._need(p, 'namespace', 'name'); return c.request(`/skills/${e(p.namespace)}/${e(p.name)}/citation`, { query: { version: p.version, format: p.format || 'bibtex' }, accept: '*/*' });
            case 'report_outcome':
                this._need(p, 'skill', 'outcome', 'event_id'); return c.reportUsage({ skill: p.skill, outcome: p.outcome, eventId: p.event_id, environmentClass: p.environment_class, agentReport: p.agent_report, sharePublicly: p.share_publicly, reasonCode: p.reason_code, feedbackNote: p.feedback_note });
            case 'list_drafts': return c.request('/drafts');
            case 'get_draft': this._need(p, 'id'); return c.request(`/drafts/${e(p.id)}`);
            case 'create_draft': this._need(p, 'skill_md'); return c.createDraft({ skillMd: p.skill_md, transcript: p.transcript, transcriptPublic: p.transcript_public, agentModel: p.agent_model, idempotencyKey: p.idempotency_key });
            case 'update_draft': this._need(p, 'id', 'skill_md'); return c.updateDraft(p.id, { skillMd: p.skill_md });
            case 'publish_draft': this._need(p, 'id'); return c.request(`/drafts/${e(p.id)}/publish`, { method: 'POST', body: {} });
            case 'delete_draft': this._need(p, 'id'); return c.request(`/drafts/${e(p.id)}`, { method: 'DELETE' });
            case 'author_overview': return c.request('/author/overview');
            case 'author_skills': return c.request('/author/skills', { query: { q: p.query, filter: p.filter } });
            case 'skill_feedback': this._need(p, 'namespace', 'name'); return c.request(`/author/skills/${e(p.namespace)}/${e(p.name)}`);
            case 'create_revision': this._need(p, 'namespace', 'name'); return c.request(`/author/skills/${e(p.namespace)}/${e(p.name)}/revision-drafts`, { method: 'POST', body: { bump: p.bump || 'patch', reason_code: p.reason_code, environment_class: p.environment_class } });
            case 'resolve_pack': this._need(p, 'skills'); return c.request('/packs/resolve', { method: 'POST', body: { skills: p.skills } });
            case 'list_packs': return c.request('/packs');
            case 'create_pack': this._need(p, 'name', 'items'); return c.request('/packs', { method: 'POST', body: p });
            case 'templates': return c.request('/templates');
            case 'remix': this._need(p, 'namespace', 'name', 'new_name'); return c.request('/remix', { method: 'POST', body: p });
            case 'list_collections': return c.request('/collections');
            case 'create_collection': this._need(p, 'name'); return c.request('/collections', { method: 'POST', body: { name: p.name } });
            case 'add_collection_item': this._need(p, 'collection_id', 'skill_ref'); return c.request(`/collections/${e(p.collection_id)}/items`, { method: 'POST', body: { skill_ref: p.skill_ref, note: p.note } });
            case 'share_collection': this._need(p, 'collection_id'); return c.request(`/collections/${e(p.collection_id)}/share`, { method: 'POST', body: {} });
            case 'unshare_collection': this._need(p, 'collection_id'); return c.request(`/collections/${e(p.collection_id)}/share`, { method: 'DELETE' });
            case 'list_requests': return c.request('/skill-requests');
            case 'request_skill': this._need(p, 'topic', 'consent_to_publish'); if (p.consent_to_publish !== true) throw new Error('params.consent_to_publish must be true after the user reviews the request'); return c.requestSkill({ ...p, consentToPublish: p.consent_to_publish });
            case 'claim_request': this._need(p, 'id'); return c.request(`/skill-requests/${e(p.id)}/claim`, { method: 'POST', body: {} });
            case 'fulfil_request': this._need(p, 'id', 'skill_ref'); return c.request(`/skill-requests/${e(p.id)}/fulfil`, { method: 'POST', body: { skill_ref: p.skill_ref } });
            default: throw new Error(`Unknown action “${action}”. Use action “help” for the action catalogue.`);
        }
    }

    _help() {
        return JSON.stringify({
            tool: 'wolfbook_skilxiv',
            usage: { action: 'search', params: { query: 'natural-language problem', limit: 5 } },
            actions: {
                discovery: ['search', 'get_skill', 'get_versions', 'diff_versions', 'citation'],
                usage: ['report_outcome'],
                drafts: ['list_drafts', 'get_draft', 'create_draft', 'update_draft', 'publish_draft', 'delete_draft'],
                maintenance: ['author_overview', 'author_skills', 'skill_feedback', 'create_revision'],
                composition: ['resolve_pack', 'list_packs', 'create_pack', 'templates', 'remix', 'list_collections', 'create_collection', 'add_collection_item', 'share_collection', 'unshare_collection'],
                requests: ['list_requests', 'request_skill', 'claim_request', 'fulfil_request'],
            },
            actionRisk: SKILXIV_ACTION_RISK,
            safety: 'All private writes, public writes, destructive actions, and optional text uploads require user confirmation. Skill requests also require params.consent_to_publish=true after review.',
        }, null, 2);
    }

    _result(text) { return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]); }
}

// ---------------------------------------------------------------------------
// wolfbook_fairy_dispatch / wolfbook_fairy_status — the Oberon Fairy as a
// background computation sub-agent for outside agents (Claude, Codex, …).
//
// The Fairy is a cheap (DeepSeek-priced) LLM loop over the LIVE Wolfram kernel
// with a heavy verification harness (recorded chain → fresh-kernel replay →
// validation checks → deterministic self-verify). Dispatch is fire-and-forget;
// the caller polls status. Both tools are thin wrappers over headless
// wolfbook.oberon.* commands so all run logic stays in the oberon module.
// ---------------------------------------------------------------------------

class FairyDispatchTool {
    async prepareInvocation(options, _token) {
        const t = String(options.input?.task || '').slice(0, 80);
        return { invocationMessage: `Fairy dispatch: ${t}` };
    }

    async invoke(options, _token) {
        const task = String(options.input?.task || '').trim();
        if (!task) return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('task is required — a complete, self-contained computation spec.')]);
        const args = {
            task,
            validationChecks: Array.isArray(options.input?.validationChecks) ? options.input.validationChecks : [],
        };
        let res;
        try { res = await vscode.commands.executeCommand('wolfbook.oberon.fairyDispatch', args); }
        catch (e) { res = { ok: false, error: `Oberon is not available: ${e.message}` }; }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(res, null, 2))]);
    }
}

class FairyStatusTool {
    async prepareInvocation(options, _token) {
        return { invocationMessage: `Fairy status: ${options.input?.runId || 'latest run'}` };
    }

    async invoke(options, _token) {
        let res;
        try { res = await vscode.commands.executeCommand('wolfbook.oberon.fairyStatus', { runId: options.input?.runId }); }
        catch (e) { res = { ok: false, error: `Oberon is not available: ${e.message}` }; }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(res, null, 2))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_gold_run / wolfbook_gold_status — the kernel-verified gold task
// suite (Stage 0 of the agent-upgrade plan). Thin wrappers over headless
// wolfbook.oberon.goldRun / goldStatus commands; grading is machine-only
// (fresh-kernel replay + per-task WL verifier), never an LLM judge.
// ---------------------------------------------------------------------------

class GoldRunTool {
    async prepareInvocation(options, _token) {
        const t = options.input?.tasks;
        return { invocationMessage: `Gold suite: ${Array.isArray(t) && t.length ? t.join(', ') : 'all tasks'}` };
    }

    async invoke(options, _token) {
        const args = {
            tasks: Array.isArray(options.input?.tasks) ? options.input.tasks : undefined,
            label: options.input?.label ? String(options.input.label) : undefined,
        };
        let res;
        try { res = await vscode.commands.executeCommand('wolfbook.oberon.goldRun', args); }
        catch (e) { res = { ok: false, error: `Oberon is not available: ${e.message}` }; }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(res, null, 2))]);
    }
}

class GoldStatusTool {
    async prepareInvocation(_options, _token) {
        return { invocationMessage: 'Gold suite status' };
    }

    async invoke(_options, _token) {
        let res;
        try { res = await vscode.commands.executeCommand('wolfbook.oberon.goldStatus'); }
        catch (e) { res = { ok: false, error: `Oberon is not available: ${e.message}` }; }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(res, null, 2))]);
    }
}

// ---------------------------------------------------------------------------
// wolfbook_remote_checkpoint — agent-facing working-memory tool
// ---------------------------------------------------------------------------
//
// Persists a checkpoint markdown file under the active notebook's `.img/`
// sidecar directory and emits a `checkpoint` event on the remote event bus
// so any paired iOS device can show it on its activity timeline.
//
// The directory subpath is configurable via `wolfbook.remote.checkpointDirectoryName`
// (default: "wolfremote/checkpoints"). Files are named
// `<ISO-timestamp>-<short-id>.md`.
//
// The tool's textual reply is intentionally rich: it lists prior checkpoints
// in the same notebook, instructing the agent to read them at session start.
// This is what motivates the agent to actually call the tool — it's working
// memory, not just user-facing telemetry.
// ---------------------------------------------------------------------------

const _kEventBus = require('../remote/eventBus');
const _kPath     = require('path');
const _kFs       = require('fs');

/**
 * Compress a LanguageModelToolResult down to a short string for iOS timeline.
 * Caps at ~500 chars. Returns null on null/undefined.
 */
function _summariseToolResult(result) {
    if (!result) return null;
    let text = '';
    try {
        const content = result.content || [];
        for (const part of content) {
            if (part && typeof part.value === 'string') text += part.value;
            else if (part && typeof part === 'object' && 'value' in part) text += String(part.value);
        }
    } catch (_) {}
    if (!text) return null;
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 500) text = text.slice(0, 497) + '…';
    return text;
}

class RemoteCheckpointTool {
    async prepareInvocation(options, _token) {
        const kind = options.input?.kind || 'finding';
        const summary = options.input?.summary || '';
        const short = summary.length > 80 ? summary.slice(0, 77) + '…' : summary;
        return { invocationMessage: `Checkpoint [${kind}]: ${short}` };
    }

    async invoke(options, _token) {
        const inp = options.input || {};
        const kind = inp.kind || 'finding';
        const summary = String(inp.summary || '').trim();
        const detail  = String(inp.detail  || '').trim();
        if (!summary) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: wolfbook_remote_checkpoint requires a non-empty `summary` field.')]);
        }

        // Find the active wolfbook notebook to anchor the .img directory.
        const ed = vscode.window.activeNotebookEditor;
        const nb = ed?.notebook;
        if (!nb || nb.notebookType !== 'extended-wolfram-notebook') {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: wolfbook_remote_checkpoint requires an active Wolfbook notebook.')]);
        }
        const nbPath = nb.uri.fsPath;
        if (!nbPath || !nbPath.endsWith('.wb') && !nbPath.endsWith('.evsnb') && !nbPath.endsWith('.vsnb')) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                'Error: active notebook has no on-disk path; save it first.')]);
        }

        const cfg = vscode.workspace.getConfiguration('wolfbook.remote');
        const subdir = cfg.get('checkpointDirectoryName', 'wolfremote/checkpoints');
        const imgDir = nbPath + '.img';
        const dir = _kPath.join(imgDir, subdir);
        try { _kFs.mkdirSync(dir, { recursive: true }); } catch (_) {}

        const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const shortId = require('crypto').randomBytes(2).toString('hex');
        const filename = `${ts.replace(/:/g, '-')}-${shortId}.md`;
        const fpath = _kPath.join(dir, filename);

        const body =
`---
kind: ${kind}
summary: ${JSON.stringify(summary)}
ts: ${ts}
relatedCells: ${JSON.stringify(inp.relatedCells || [])}
relatedFiles: ${JSON.stringify(inp.relatedFiles || [])}
notebook: ${_kPath.basename(nbPath)}
---

# ${summary}

${detail}
`;
        try { _kFs.writeFileSync(fpath, body, 'utf8'); }
        catch (err) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                `Error writing checkpoint: ${err?.message || err}`)]);
        }

        // Emit on the remote bus (no-op if no listeners)
        try {
            _kEventBus.emit('checkpoint', {
                docId: nb.uri.toString(),
                fsPath: nbPath,
                file: fpath,
                kind, summary, detail,
                relatedCells: inp.relatedCells || [],
                relatedFiles: inp.relatedFiles || [],
                ts: Date.now(),
            });
        } catch (_) {}

        // Build the prior-checkpoints listing for the agent's reply.
        let prior = [];
        try {
            const entries = _kFs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== filename);
            entries.sort().reverse();
            for (const f of entries.slice(0, 12)) {
                let kindTag = '?', sumLine = '';
                try {
                    const head = _kFs.readFileSync(_kPath.join(dir, f), 'utf8').split('\n').slice(0, 8).join('\n');
                    const km = head.match(/^kind:\s*(\S+)/m);
                    const sm = head.match(/^summary:\s*"?(.+?)"?$/m);
                    if (km) kindTag = km[1];
                    if (sm) sumLine = sm[1];
                } catch (_) {}
                prior.push(`  - ${f}  [${kindTag}]  ${sumLine}`);
            }
        } catch (_) {}

        const relPath = _kPath.relative(_kPath.dirname(nbPath), fpath);
        const replyLines = [
            `Checkpoint saved: ${relPath}`,
            ''
        ];
        if (prior.length > 0) {
            replyLines.push(`Prior checkpoints in this notebook (most recent first):`);
            replyLines.push(...prior);
            replyLines.push('');
            replyLines.push('To read any checkpoint, use your file-read tool with the path. Recommended: read the most recent 2-3 plan and decision checkpoints at the start of each session.');
        } else {
            replyLines.push('(This is the first checkpoint in this notebook.)');
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(replyLines.join('\n'))]);
    }
}

function registerTools(context, getController, debugCtrl, getAskPanel) {
    // alias(impl, defaults): register one implementation under a second name.
    // Returns a fresh delegate object so the invoke-wrap loop below installs a
    // per-name wrapper (journal/toolUsage report the name the agent actually
    // called). `defaults` merge UNDER caller args — explicit input always wins.
    const _withDefaults = (options, defaults) => (!defaults ? options
        : { ...options, input: { ...defaults, ...(options?.input || {}) } });
    // The wrap loop below replaces the primary instance's invoke; the alias must
    // call the pre-wrap original (__wolfbookOrigInvoke) or a call would pass
    // through BOTH wrappers (double operation records / toolUsage events).
    const alias = (impl, defaults) => ({
        prepareInvocation: (o, t) => impl.prepareInvocation?.(_withDefaults(o, defaults), t),
        invoke:            (o, t) => (impl.__wolfbookOrigInvoke || impl.invoke).call(impl, _withDefaults(o, defaults), t),
    });

    const runCellTool = new RunCellTool(getController);
    const kernelManagerTool = new KernelManagerTool(getController);
    const inspectSymbolsTool = new InspectSymbolsTool(getController);
    const statusTool = new StatusTool(getController);
    const evaluationJournalTool = new EvaluationJournalTool(getController);
    // Lazy accessor: the self-test exercises the FINISHED (wrapped) delegates.
    let toolMap = null;
    const selfTestTool = new SelfTestTool(getController, () => toolMap);
    const tools = [
        // Wolfbook TeX — the paper_* surface (Stage 1: read + guarded edit)
        { name: 'paper_getOutline',        impl: new PaperGetOutlineTool() },
        { name: 'paper_getObject',         impl: new PaperGetObjectTool() },
        { name: 'paper_getSection',        impl: new PaperGetSectionTool() },
        { name: 'paper_findReferences',    impl: new PaperFindReferencesTool() },
        { name: 'paper_search',            impl: new PaperSearchObjectsTool() },
        { name: 'paper_mathematicaBlocks', impl: new PaperMathematicaBlocksTool() },
        { name: 'paper_previewEdit',       impl: new PaperPreviewEditTool() },
        { name: 'paper_applyEdit',         impl: new PaperApplyEditTool() },

        // Core notebook tools (visible in chat panel)
        { name: 'wolfbook_newNotebook',        impl: new NewNotebookTool(getController) },
        { name: 'wolfbook_getNotebookContext', impl: new GetNotebookContextTool(getController, context) },
        { name: 'wolfbook_evaluateExpression', impl: new EvaluateExpressionTool(getController) },
        { name: 'wolfbook_lookupSymbol',       impl: new LookupSymbolTool(getController) },
        { name: 'wolfbook_insertCells',        impl: new InsertCellsTool(getController) },
        { name: 'wolfbook_editCell',           impl: new EditCellTool(getController) },
        { name: 'wolfbook_runCell',            impl: runCellTool },
        // wolfbook_runCells: run a contiguous range of cells (startCell/endCell, 1-based)
        { name: 'wolfbook_runCells',           impl: alias(runCellTool) },
        { name: 'wolfbook_getCellOutput',      impl: new GetCellOutputTool(getController) },
        { name: 'wolfbook_validateSyntax',     impl: new ValidateSyntaxTool(getController) },
        { name: 'wolfbook_latex',              impl: new LatexTool() },
        { name: 'wolfbook_deleteCell',         impl: new DeleteCellTool() },
        { name: 'wolfbook_searchCells',        impl: new SearchCellsTool() },
        // wolfbook_inspectSymbols is the canonical name — "getKernelState" read as
        // a status probe but it EVALUATES in the kernel (feedback §4.1).
        { name: 'wolfbook_inspectSymbols',     impl: inspectSymbolsTool },
        { name: 'wolfbook_getKernelState',     impl: alias(inspectSymbolsTool) },
        // wolfbook_status is the ONE side-effect-free status surface; kernelStatus
        // stays as a legacy-shape alias (raw arbiter JSON).
        { name: 'wolfbook_status',             impl: statusTool },
        { name: 'wolfbook_kernelStatus',       impl: alias(statusTool, { _legacyShape: true }) },
        { name: 'wolfbook_operationStatus',    impl: new OperationStatusTool(getController) },
        { name: 'wolfbook_evaluationJournal',  impl: evaluationJournalTool },
        { name: 'wolfbook_journalDigest',      impl: alias(evaluationJournalTool, { action: 'digest' }) },
        { name: 'wolfbook_exportSessionReport',impl: alias(evaluationJournalTool, { action: 'export' }) },
        { name: 'wolfbook_cancelOperation',    impl: new CancelOperationTool(getController) },
        { name: 'wolfbook_selfTest',           impl: selfTestTool },
        { name: 'wolfbook_saveNotebook',       impl: new SaveNotebookTool() },
        { name: 'wolfbook_getResult',           impl: new GetResultTool(getController) },
        // Agent-only tools (not shown in chat panel)
        { name: 'wolfbook_moveCell',           impl: new MoveCellTool() },
        { name: 'wolfbook_restoreDeletedCells',impl: new RestoreDeletedCellsTool() },
        { name: 'wolfbook_kernelControl',      impl: new KernelControlTool(getController) },
        { name: 'wolfbook_kernelManager',      impl: kernelManagerTool },
        { name: 'wolfbook_selectKernel',       impl: alias(kernelManagerTool) },
        { name: 'wolfbook_kernelCrashLog',     impl: new KernelCrashLogTool() },
        { name: 'wolfbook_findPackage',        impl: new FindPackageTool(getController) },
        { name: 'wolfbook_debugCell',          impl: new DebugCellTool(getController, debugCtrl) },
        { name: 'wolfbook_fileOps',            impl: new FileOpsTool() },
        { name: 'wolfbook_showImage',          impl: new ShowImageTool() },
        { name: 'wolfbook_runTerminal',        impl: new RunTerminalTool() },
        { name: 'wolfbook_paperSearch',        impl: new PaperSearchTool() },
        { name: 'wolfbook_skilxiv',            impl: new SkilXivTool(context) },
        { name: 'wolfbook_fairy_dispatch',     impl: new FairyDispatchTool() },
        { name: 'wolfbook_fairy_status',       impl: new FairyStatusTool() },
        { name: 'wolfbook_gold_run',           impl: new GoldRunTool() },
        { name: 'wolfbook_gold_status',        impl: new GoldStatusTool() },
        // Wolfteam tools
        { name: 'wolfteam_proposePlan',        impl: new ProposePlanTool() },
        { name: 'wolfteam_askDecision',        impl: new AskDecisionTool() },
        { name: 'wolfteam_checkpoint',         impl: new CheckpointTool() },
        { name: 'wolfteam_askSpecialist',      impl: new AskSpecialistTool(getAskPanel || (() => null)) },
        // Wolfbook Remote — agent-facing checkpoint tool (working memory + iOS timeline)
        { name: 'wolfbook_remote_checkpoint',  impl: new RemoteCheckpointTool() },
        // Wolfslide tools
        { name: 'wolfslide_getContext',      impl: new WolfslideGetContextTool() },
        { name: 'wolfslide_listSlides',      impl: new WolfslideListSlidesTool() },
        { name: 'wolfslide_getSlide',        impl: new WolfslideGetSlideTool() },
        { name: 'wolfslide_getSlideHtml',    impl: new WolfslideGetSlideHtmlTool() },
        { name: 'wolfslide_getImageDimensions', impl: new WolfslideGetImageDimensionsTool() },
        { name: 'wolfslide_insertSlide',     impl: new WolfslideInsertSlideTool() },
        { name: 'wolfslide_replaceSlide',    impl: new WolfslideReplaceSlideTool() },
        { name: 'wolfslide_editSlide',       impl: new WolfslideEditSlideTool() },
        { name: 'wolfslide_deleteSlide',     impl: new WolfslideDeleteSlideTool() },
        { name: 'wolfslide_deleteSlides',    impl: new WolfslideDeleteSlidesTool() },
        { name: 'wolfslide_duplicateSlide',  impl: new WolfslideDuplicateSlideTool() },
        { name: 'wolfslide_moveSlide',       impl: new WolfslideMoveSlideTool() },
        { name: 'wolfslide_searchSlides',    impl: new WolfslideSearchSlidesTool() },
        { name: 'wolfslide_block',           impl: new WolfslideBlockTool() },
        { name: 'wolfslide_patchBlock',      impl: new WolfslidePatchBlockTool() },
        { name: 'wolfslide_advanced',        impl: new WolfslideAdvancedTool() },
        { name: 'wolfslide_arrange',         impl: new WolfslideArrangeTool() },
        { name: 'wolfslide_undo',            impl: new WolfslideUndoTool() },
        { name: 'wolfslide_reload',          impl: new WolfslideReloadTool() },
        { name: 'wolfslide_saveFile',        impl: new WolfslideSaveFileTool() },
        { name: 'wolfslide_exportHtml',      impl: new WolfslideExportHtmlTool() },
        { name: 'wolfslide_setTheme',        impl: new WolfslideSetThemeTool() },
        { name: 'wolfslide_bulkInsert',      impl: new WolfslideBulkInsertTool() },
        { name: 'wolfslide_copySlides',      impl: new WolfslideCopySlides() },
        { name: 'wolfslide_imageAsset',      impl: new WolfslideImageAssetTool() },
        { name: 'wolfslide_insertEvalBlock', impl: new WolfslideInsertEvalBlockTool(getController) },
        { name: 'wolfslide_runEvalBlock',    impl: new WolfslideRunEvalBlockTool(getController) },
        // Shadow VS Code's built-in notebook tools — only redirects when a Wolfbook notebook is active.
        // For other notebook types (Python, Jupyter) the model should use the built-in tools directly;
        // we return a neutral pass-through message so Copilot falls back to its own handling.
        { name: 'edit_notebook_file', impl: {
            prepareInvocation: () => ({ invocationMessage: 'Checking notebook type…' }),
            invoke: () => {
                const nb = vscode.window.activeNotebookEditor?.notebook;
                const isWolfbook = nb && /\.(wb|evsnb|vsnb)$/.test(nb.uri.fsPath);
                if (!isWolfbook) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    'This is not a Wolfbook notebook — use the standard edit_notebook_file tool directly.'
                )]);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    'ERROR: Do NOT use edit_notebook_file on Wolfbook (.wb/.evsnb) notebooks. ' +
                    'Use wolfbook_insertCells (with evaluate:true to auto-run), wolfbook_editCell, ' +
                    'wolfbook_deleteCell, or wolfbook_moveCell instead. ' +
                    'These tools handle the custom Wolfbook cell format correctly and support live kernel evaluation.'
                )]);
            },
        }},
        { name: 'run_notebook_cell', impl: {
            prepareInvocation: () => ({ invocationMessage: 'Checking notebook type…' }),
            invoke: () => {
                const nb = vscode.window.activeNotebookEditor?.notebook;
                const isWolfbook = nb && /\.(wb|evsnb|vsnb)$/.test(nb.uri.fsPath);
                if (!isWolfbook) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    'This is not a Wolfbook notebook — use the standard run_notebook_cell tool directly.'
                )]);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    'ERROR: Do NOT use run_notebook_cell on Wolfbook (.wb/.evsnb) notebooks. ' +
                    'Use wolfbook_runCell (by cellId or cellNumber) or wolfbook_insertCells with evaluate:true instead.'
                )]);
            },
        }},
        // Intercept replace_string_in_file when used on .wb/.evsnb notebooks.
        // These files store cell content as JSON with escaped chars — on-disk edits silently
        // corrupt the format.  Return a clear error with the correct alternatives.
        { name: 'replace_string_in_file', impl: {
            prepareInvocation: (options) => {
                const fp = options.input?.filePath || options.input?.path || '';
                if (/\.(wb|evsnb|vsnb)$/i.test(fp)) {
                    return { invocationMessage: `⛔ Blocked: replace_string_in_file on Wolfbook file` };
                }
                return { invocationMessage: `Edit file: ${fp.split('/').pop() || fp}` };
            },
            invoke: (options) => {
                const fp = options.input?.filePath || options.input?.path || '';
                if (/\.(wb|evsnb|vsnb)$/i.test(fp)) {
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                        `ERROR: replace_string_in_file must NOT be used on Wolfbook notebooks (${fp.split('/').pop()}).\n` +
                        '.wb/.evsnb files store cell content as JSON with escaped characters; direct file edits silently corrupt the format.\n\n' +
                        'Use the correct Wolfbook tools instead:\n' +
                        '  • wolfbook_editCell(cellId, newSource) — replace the source of an existing cell\n' +
                        '  • wolfbook_insertCells(cells, position) — insert new cells\n' +
                        '  • wolfbook_deleteCell(cellId/cellNumber) — delete a cell\n' +
                        '  • wolfbook_moveCell(cellId/cellNumber, newPosition) — reorder cells\n' +
                        'Call wolfbook_getNotebookContext first to get cell IDs.'
                    )]);
                }
                // Not a wolfbook file — return a pass-through so Copilot uses its built-in tool
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                    'This is not a Wolfbook notebook file — use the standard replace_string_in_file tool directly.'
                )]);
            },
        }},
    ];

    for (const { name, impl } of tools) {
        // Wrap the tool's invoke() so we can emit a `toolUsage` event on the
        // remote event bus. The wrap is no-op when there are no listeners
        // (typical desktop case without a paired iOS device).
        if (typeof impl.invoke === 'function' && !impl.__wolfbookRemoteWrapped) {
            const _origInvoke = impl.invoke.bind(impl);
            impl.__wolfbookOrigInvoke = _origInvoke;   // aliases call this to skip the wrapper
            impl.invoke = async function (options, token) {
                const startedAt = Date.now();
                const operationTools = new Set([
                    'wolfbook_evaluateExpression', 'wolfbook_insertCells', 'wolfbook_editCell',
                    'wolfbook_runCell', 'wolfbook_runCells'
                ]);
                const input = options?.input || {};
                const editEvaluates = name !== 'wolfbook_editCell' || (Array.isArray(input.cells)
                    ? input.cells.some(cell => cell?.evaluate === true || (cell?.evaluate == null && input.evaluate !== false))
                    : input.evaluate === true);
                const insertEvaluates = name !== 'wolfbook_insertCells' || input.evaluate !== false;
                const shouldTrackOperation = operationTools.has(name) && editEvaluates && insertEvaluates;
                const controller = shouldTrackOperation ? getController?.(input) : null;
                let operation = null;
                if (controller?.operations) {
                    operation = controller.operations.create({
                        id: options?.input?._operationId,
                        tool: name, owner: 'mcp', caption: options?.input?.caption,
                        argsSummary: (() => { try { return JSON.stringify(options?.input || {}); } catch (_) { return ''; } })(),
                        notebook: options?.input?.notebook,
                        kernelId: controller.kernelIdentity?.kernel_id || null,
                        kernelLabel: controller.kernelIdentity?.label || null,
                        cellId: options?.input?.cellId,
                        cellNumber: options?.input?.cellNumber,
                        background: options?.input?.wait_mode === 'async',
                    });
                    controller.operations.start(operation.id);
                    options = { ...options, input: { ...(options?.input || {}), _operationId: operation.id } };
                    const progressSymbol = String(options.input.progress_symbol || '').trim();
                    if (progressSymbol && /^[A-Za-z$][A-Za-z0-9$`]*$/.test(progressSymbol) && controller.session?.subAuto) {
                        const interval = Math.max(1000, Math.min(30000, Number(options.input.progress_interval_ms) || 2000));
                        const sample = async () => {
                            const op = controller.operations.get(operation.id);
                            if (!op || !['pending', 'running'].includes(op.state)) return;
                            try {
                                const value = await controller.session.subAuto(`ToString[${progressSymbol},InputForm]`);
                                controller.operations.appendProgress(operation.id, 'monitor', value?.value ?? value);
                            } catch (_) {
                                controller.operations.appendProgress(operation.id, 'monitor', 'unavailable');
                                return;
                            }
                            setTimeout(sample, interval);
                        };
                        setTimeout(sample, interval);
                    }
                }
                const settleOperationResult = (completedResult) => {
                    if (!operation) return;
                    if (completedResult?.__wolfbookBusy) {
                        controller.operations.fail(operation.id, 'kernel busy; request not started');
                        return;
                    }
                    const finish = () => {
                        const status = controller.arbiter?.status(controller);
                        const ownsKernel = status?.activeOperation?.operationId === operation.id;
                        if (ownsKernel && status.busy) { setTimeout(finish, 250); return; }
                        let fullResult = (completedResult?.content || [])
                            .map(part => String(part?.value ?? part?.text ?? '')).join('\n').slice(0, 1048576);
                        if (/timed out|still running/i.test(fullResult)) {
                            const completedCells = controller.operations.get(operation.id)?.cells || [];
                            const recovered = completedCells
                                .filter(cell => cell.status !== 'running')
                                .map(cell => `Cell ${cell.cellNumber ?? '?'}: ${cell.resultPreview || '(no output)'}`)
                                .join('\n');
                            if (recovered) fullResult = recovered.slice(0, 1048576);
                        }
                        controller.operations.complete(operation.id, fullResult, fullResult.slice(0, 1000));
                    };
                    finish();
                };

                if (operation && options?.input?.wait_mode === 'async') {
                    let backgroundResult;
                    let backgroundOk = true;
                    Promise.resolve().then(() => _origInvoke(options, token)).then(result => {
                        backgroundResult = result;
                        settleOperationResult(result);
                    }).catch(err => {
                        backgroundOk = false;
                        controller.operations.fail(operation.id, err);
                    }).finally(() => {
                        try {
                            if (_kEventBus.listenerCount('toolUsage') > 0) {
                                _kEventBus.emit('toolUsage', {
                                    tool: name, args: options?.input ?? null,
                                    result: _summariseToolResult(backgroundResult), background: true,
                                    ok: backgroundOk, durationMs: Date.now() - startedAt, ts: Date.now(),
                                });
                            }
                        } catch (_) {}
                    });
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
                        `Operation started asynchronously.\n\nOperation ID: ${operation.id}\n\n` +
                        `Kernel ID: ${controller.kernelIdentity?.kernel_id || 'unknown'}\n\n` +
                        `Use wolfbook_operationStatus or wolfbook_waitEvaluation with operation_id="${operation.id}".`
                    )]);
                }
                let result;
                let ok = true;
                try {
                    result = await _origInvoke(options, token);
                    if (operation) {
                        settleOperationResult(result);
                        if (result?.__wolfbookBusy) return result;
                        result = new vscode.LanguageModelToolResult([
                            ...(result?.content || []),
                            new vscode.LanguageModelTextPart(`\nOperation ID: ${operation.id}\nKernel ID: ${controller.kernelIdentity?.kernel_id || 'unknown'}`)
                        ]);
                    }
                    return result;
                } catch (err) {
                    ok = false;
                    if (operation) controller.operations.fail(operation.id, err);
                    throw err;
                } finally {
                    try {
                        if (_kEventBus.listenerCount('toolUsage') > 0) {
                            _kEventBus.emit('toolUsage', {
                                tool: name,
                                args: options?.input ?? null,
                                result: _summariseToolResult(result),
                                ok,
                                durationMs: Date.now() - startedAt,
                                ts: Date.now(),
                            });
                        }
                    } catch (_) {}
                }
            };
            impl.__wolfbookRemoteWrapped = true;
        }
        if (vscode.lm && vscode.lm.registerTool) {
            try {
                context.subscriptions.push(vscode.lm.registerTool(name, impl));
            } catch (regErr) {
                const msg = regErr?.message ?? String(regErr);
                if (/was not contributed/i.test(msg)) {
                    console.warn(`[wolfbook] Skipping LM tool "${name}" because this VS Code build requires contributed tools.`);
                } else {
                    console.error(`[wolfbook] Failed to register LM tool "${name}":`, msg);
                }
            }
        }
    }

    // Build and return tool map for MCP server use
    toolMap = new Map(tools.map(({ name, impl }) => [name, impl]));
    return toolMap;
}

// ---------------------------------------------------------------------------
// @wolfbook chat participant
// ---------------------------------------------------------------------------

const _WOLFBOOK_SYSTEM_PROMPT_PATH = path.join(__dirname, 'wolfbook-system-prompt.md');
const _WOLFBOOK_PROMPTS_DIR  = path.join(require('os').homedir(), '.wolfbook', 'prompts');
// Active preset is stored per-workspace in VS Code settings (wolfbook.activeSystemPrompt).
const _WOLFBOOK_ACTIVE_PRESET_KEY = 'activeSystemPrompt';

// Read the active user preset from ~/.wolfbook/prompts/, falling back to the
// bundled default.  Reads fresh on every call so edits take effect immediately.
function _getWolfbookSystemPrompt() {
    try {
        const name = vscode.workspace.getConfiguration('wolfbook').get(_WOLFBOOK_ACTIVE_PRESET_KEY, '');
        if (name) {
            const p = require('path').join(_WOLFBOOK_PROMPTS_DIR, name + '.md');
            if (require('fs').existsSync(p)) return require('fs').readFileSync(p, 'utf8');
        }
    } catch (_) {}
    // Fall back to bundled extension default
    try { return fs.readFileSync(_WOLFBOOK_SYSTEM_PROMPT_PATH, 'utf8'); } catch (_) { return ''; }
}
let WOLFBOOK_SYSTEM_PROMPT = _getWolfbookSystemPrompt();

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
                        stateLines.push(`- Cell ${start0 + 1} (CellId: ${getCellToolId(c)})`);
                    } else {
                        stateLines.push(`- Cells ${start0 + 1}-${end0 + 1}`);
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
        // Check for custom pre-prompt in notebook settings
        let customPrePrompt = '';
        if (editor && editor.notebook && editor.notebook.metadata?.wolframSettings?.copilotPrePrompt) {
            customPrePrompt = '\n\n## User pre-prompt\n' + editor.notebook.metadata.wolframSettings.copilotPrePrompt;
        }
        const sysMsg = _getWolfbookSystemPrompt() +
            customPrePrompt +
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
            'wolfbook_insertCells', 'wolfbook_editCell', 'wolfbook_runCell', 'wolfbook_runRange',
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
                        stateLines.push(`- Cell ${start0 + 1} (CellId: ${getCellToolId(c)})`);
                    } else {
                        stateLines.push(`- Cells ${start0 + 1}-${end0 + 1}`);
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
            'wolfbook_insertCells', 'wolfbook_editCell', 'wolfbook_runCell', 'wolfbook_runRange',
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

module.exports = { registerTools, registerChatParticipant, registerWolfteamParticipant, buildTranscript, clearEvalLog, AskSpecialistTool, setNotebookResolvedCallback,
    // pure helpers exported for headless tests
    _buildExpectCheck, _buildOutputFormWrapper, _parseAssertPrefix, _stripJsonFallback, _describeExpect, _deTexUsage,
    renderJournalDigest, filterJournal, _journalFilters, renderSessionReport, classifyCellOutputs, CancelOperationTool };
