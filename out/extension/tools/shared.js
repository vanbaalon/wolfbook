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

async function acquireKernelForAgent(ctrl, options = {}) {
    if (!ctrl?.arbiter) return { lease: null };
    const configured = vscode.workspace.getConfiguration('wolfbook').get('ai.busyPolicy', 'reject');
    const requested = options.policyOverride || options.policy || 'reject';
    const policy = requested === 'preempt' && configured === 'preempt' ? 'preempt' : 'reject';
    const acquired = await ctrl.arbiter.acquire(ctrl, { ...options, policy });
    if (acquired.lease) {
        // Keep the full user-facing WL input in extension memory for the kernel
        // indicator's "View Full WL Task" action. The arbiter intentionally
        // exposes only a short preview in status payloads.
        if (options.source != null) {
            ctrl._lastWolframTask = {
                source: String(options.source).slice(0, 1048576),
                caption: acquired.lease.caption,
                notebook: acquired.lease.notebook || null,
                cellNumber: acquired.lease.cellNumber || null,
                operationId: acquired.lease.operationId || null,
                startedAt: acquired.lease.startedAt || Date.now(),
            };
        }
        return acquired;
    }
    const busy = acquired.busy;
    const text = [
        'Kernel is busy; the running evaluation was not interrupted.',
        '',
        '```json', JSON.stringify(busy, null, 2), '```',
        '',
        busy.operation_id
            ? `Use wolfbook_operationStatus with operation_id="${busy.operation_id}" (wait_seconds waits for it), or explicitly abort it.`
            : 'Use wolfbook_kernelStatus to inspect it, wait, or explicitly abort it.',
    ].join('\n');
    const error = new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    error.__wolfbookBusy = true;
    return { busy, error, result: error };
}

function releaseKernelForAgent(ctrl, lease, outcome = 'completed') {
    if (!ctrl?.arbiter || !lease) return;
    const isBusy = () => !!(ctrl._evalDispatched || Number(ctrl._directEvaluationCount || 0) > 0 || ctrl.isAborting || ctrl._abortPending ||
        (ctrl.executionQueue?.queueLength?.() || 0) > 0);
    if (!isBusy()) { ctrl.arbiter.release(lease, outcome); return; }
    // The MCP observation timeout may expire while the notebook execution keeps
    // running. Retain ownership until two consecutive idle samples so another
    // agent cannot claim and preempt/overlap the still-active kernel work.
    let idleSamples = 0;
    const poll = () => {
        if (!ctrl.arbiter?.status(ctrl).activeOperation ||
            ctrl.arbiter.status(ctrl).activeOperation.operationId !== lease.operationId) return;
        if (isBusy()) idleSamples = 0;
        else if (++idleSamples >= 2) { ctrl.arbiter.release(lease, outcome); return; }
        setTimeout(poll, 200);
    };
    setTimeout(poll, 200);
}

function trackedKernelEvaluate(controller, expression, options) {
    controller._directEvaluationCount = Number(controller._directEvaluationCount || 0) + 1;
    let promise;
    try { promise = controller.session.evaluate(expression, options); }
    catch (err) {
        controller._directEvaluationCount = Math.max(0, controller._directEvaluationCount - 1);
        throw err;
    }
    return Promise.resolve(promise).finally(() => {
        controller._directEvaluationCount = Math.max(0, Number(controller._directEvaluationCount || 1) - 1);
    });
}

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
/**
 * Markdown-only: rewrite LaTeX's native math delimiters to the $ forms.
 *
 * Wolfbook renders \( … \) and \[ … \] in its own viewer, but the text stored in
 * the .wb does not render anywhere else — GitHub, exported HTML, other markdown
 * tools. Agents and paste-from-paper overwhelmingly produce the LaTeX form, so
 * normalising at insert time keeps the notebook portable.
 *
 * MUST NOT be applied to code cells: \( … \) is Wolfram box syntax and \[Alpha]
 * is a named character. Even here, display math is distinguished from a named
 * character by the ESCAPED closer (\] vs a plain ]), and fenced/inline code is
 * masked out.
 *
 * @returns {{ text: string, converted: boolean }}
 */
function normalizeMarkdownMath(src) {
    const input = String(src);
    if (input.indexOf('\\') === -1) return { text: input, converted: false };
    const parts = input.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
    let converted = false;
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) continue;               // code region — never rewrite
        const before = parts[i];
        parts[i] = before
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, b) => '$$' + b + '$$')
            .replace(/\\\(([\s\S]+?)\\\)/g, (_m, b) => '$' + b + '$');
        if (parts[i] !== before) converted = true;
    }
    return { text: parts.join(''), converted };
}

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

// Raw C0 controls are never meaningful notebook source. Keep the three
// whitespace controls that are valid in both WL and Markdown.
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

function findControlChar(text) {
    const value = String(text);
    const match = CONTROL_CHAR_RE.exec(value);
    if (!match) return null;
    const index = match.index;
    const before = value.slice(0, index);
    const line = before.split('\n').length;
    const lastNewline = before.lastIndexOf('\n');
    return {
        index,
        code: match[0].charCodeAt(0),
        line,
        col: index - lastNewline,
        context: value.slice(Math.max(0, index - 20), Math.min(value.length, index + 21)),
    };
}

function decodeToolContent(raw, encoding) {
    // MCP/LM tool arguments have already been decoded from JSON when they reach
    // this function.  The resulting JavaScript string is the source of truth:
    // applying the old compatibility normalizer by default can corrupt valid WL
    // strings such as "std\\nall entries" and valid LaTeX such as \\frac.
    // Keep `auto` as an explicit legacy opt-in, but preserve omitted content.
    const mode = encoding == null || encoding === '' ? 'raw' : String(encoding);
    const value = String(raw ?? '');
    if (mode === 'raw') return value;
    if (mode === 'auto') return normalizeToolContent(value);
    if (mode !== 'base64') throw new Error(`Invalid content_encoding ${JSON.stringify(mode)}. Use "auto", "raw", or "base64".`);
    if (value === '') return '';
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('Invalid base64 content: use standard base64 with valid padding. No cells were modified.');
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
        throw new Error('Invalid base64 content: round-trip validation failed. No cells were modified.');
    }
    return decoded.toString('utf8');
}

function prepareCellContent({ content, kind, encoding }) {
    const text = decodeToolContent(content, encoding);
    const bad = findControlChar(text);
    if (bad) {
        const code = `U+${bad.code.toString(16).toUpperCase().padStart(4, '0')}`;
        throw new Error(
            `Rejected control character ${code} at ${bad.line}:${bad.col} near ${JSON.stringify(bad.context)}. ` +
            'No cells were modified. The supplied value contains an actual C0 control character; resend it as the intended printable text or literal backslash sequence.'
        );
    }
    if (String(kind).toLowerCase() === 'markdown') {
        const normalized = normalizeMarkdownMath(text);
        return { text: normalized.text, converted: normalized.converted, encoding: encoding || 'raw' };
    }
    return { text, converted: false, encoding: encoding || 'raw' };
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
                    '\\ii': '\\mathrm{i}',
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
let _followAgentEnabled = false;
let _followAgentStatus = null;
let _followAgentRegistered = false;
let _lastAgentActivity = null;
let _lastAgentNotebook = null;
let _agentControllerProvider = null;
// One toast per notebook at a time; repeated cell operations are coalesced.
const _agentNotices = new Map();
const _agentActivities = new WeakMap();
const _backgroundEditors = new WeakMap();
const AGENT_NOTICE_COOLDOWN_MS = 60000;

function _sameNotebook(a, b) {
    return !!a && !!b && a.uri?.toString?.() === b.uri?.toString?.();
}

function _updateFollowStatus() {
    if (!_followAgentStatus) return;
    if (!_followAgentEnabled) { _followAgentStatus.hide(); return; }
    const name = path.basename(
        _lastAgentNotebook?.uri?.fsPath ||
        _lastAgentActivity?.editor?.notebook?.uri?.fsPath ||
        'notebook'
    );
    _followAgentStatus.text = '$(eye) Following AI';
    _followAgentStatus.tooltip = `Following AI activity in ${name}. Click to stop.`;
    _followAgentStatus.show();
}

async function _revealAgentCell(editor, cellIndex, takeFocus) {
    const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
    let targetEditor = editor;
    if (takeFocus) {
        try {
            targetEditor = await vscode.window.showNotebookDocument(editor.notebook, { preserveFocus: false, preview: false });
        } catch (_) {}
    }
    if (!targetEditor.notebook.cellCount) return targetEditor;
    cellIndex = Math.max(0, Math.min(cellIndex, targetEditor.notebook.cellCount - 1));
    targetEditor.revealRange(new RC(cellIndex, cellIndex + 1),
        vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    if (!_cellGlowDeco && vscode.notebooks?.createNotebookEditorDecorationType) {
        _cellGlowDeco = vscode.notebooks.createNotebookEditorDecorationType({
            backgroundColor: 'rgba(100, 180, 255, 0.12)',
            borderColor: 'rgba(100, 180, 255, 0.75)',
        });
    }
    if (_cellGlowDeco) {
        targetEditor.setDecorations(_cellGlowDeco, [new RC(cellIndex, cellIndex + 1)]);
        setTimeout(() => {
            try { targetEditor.setDecorations(_cellGlowDeco, []); } catch (_) {}
        }, 1800);
    }
    return targetEditor;
}

function setAgentControllerProvider(provider) { _agentControllerProvider = provider; }

async function _openAgentNotebook(notebook) {
    if (!notebook) return null;
    try {
        const latest = _agentActivities.get(notebook);
        const editor = latest
            ? await _revealAgentCell(latest.editor, latest.cellIndex, true)
            : await vscode.window.showNotebookDocument(notebook, { preserveFocus: false, preview: false });
        // The user explicitly opened this notebook. Complete first-time kernel
        // selection now, so subsequent agent runs can stay in the background.
        const controller = _agentControllerProvider?.({ notebook: notebook.uri.fsPath });
        if (controller) {
            await require('../kernel/association').associateNotebook(controller, notebook, { allowReveal: false });
        }
        return editor;
    } catch (_) { return null; }
}

/** Register the in-window Follow Agent mode and its clickable status item. */
function registerAgentFollow(context) {
    if (_followAgentRegistered) return;
    _followAgentRegistered = true;
    try {
        _followAgentStatus = vscode.window.createStatusBarItem(
            'wolfbook-follow-agent', vscode.StatusBarAlignment.Right, 99
        );
        _followAgentStatus.name = 'Wolfbook Follow Agent';
        _followAgentStatus.command = 'wolfbook.stopFollowingAgent';
        context.subscriptions.push(_followAgentStatus);
    } catch (_) {}
    try {
        context.subscriptions.push(vscode.commands.registerCommand('wolfbook.followAgent', async () => {
            _followAgentEnabled = true;
            _updateFollowStatus();
            const notebook = _lastAgentNotebook || _lastAgentActivity?.editor?.notebook;
            if (notebook) await _openAgentNotebook(notebook);
        }));
        context.subscriptions.push(vscode.commands.registerCommand('wolfbook.stopFollowingAgent', () => {
            _followAgentEnabled = false;
            _updateFollowStatus();
            vscode.window.showInformationMessage('Wolfbook stopped following AI activity.');
        }));
    } catch (_) {}
}

/**
 * Notify without opening a tab or holding up an agent response. Navigation is
 * exclusively the toast action (or the user's explicit Follow Agent command).
 */
async function notifyAgentNotebookEvent(event) {
    try {
        const ref = event?.notebook;
        let notebook = ref?.notebook?.uri ? ref.notebook : (ref?.uri ? ref : null);
        if (!notebook && typeof ref === 'string') notebook = await resolveNotebookDocument(ref);
        if (!notebook) return;
        _lastAgentNotebook = notebook;
        _updateFollowStatus();
        if (_followAgentEnabled) {
            void _openAgentNotebook(notebook);
            return;
        }
        if (_sameNotebook(vscode.window.activeNotebookEditor?.notebook, notebook)) return;

        const uri = notebook.uri.toString();
        const previous = _agentNotices.get(uri);
        if (previous?.pending || (previous && Date.now() - previous.at < AGENT_NOTICE_COOLDOWN_MS)) return;
        const notice = { pending: true, at: Date.now() };
        _agentNotices.set(uri, notice);
        // Bound notice history even if a long-running agent visits many files.
        if (_agentNotices.size > 100) {
            for (const [key, entry] of _agentNotices) {
                if (!entry.pending && key !== uri) { _agentNotices.delete(key); break; }
            }
        }
        const name = path.basename(notebook.uri.fsPath);
        const verb = event?.kind === 'created' ? 'created' : event?.kind === 'switched' ? 'selected' : 'is working in';
        try {
            const choice = await vscode.window.showInformationMessage(
                `Wolfbook AI ${verb} "${name}" in the background.`, 'Open Notebook'
            );
            if (choice === 'Open Notebook') await _openAgentNotebook(notebook);
        } finally {
            notice.pending = false;
        }
    } catch (_) {}
}

async function flashCell(editor, cellIndex) {
    try {
        _lastAgentActivity = { editor, cellIndex };
        _agentActivities.set(editor.notebook, _lastAgentActivity);
        _lastAgentNotebook = editor.notebook;
        _updateFollowStatus();
        if (_followAgentEnabled) {
            await _revealAgentCell(editor, cellIndex, true);
            return;
        }
        // An existing collaboration pane may follow cells, but agent activity
        // must never open a new pane or replace the paper the user is reading.
        if (_isCollabMode()) {
            const rightEd = vscode.window.visibleNotebookEditors.find(ed =>
                ed.viewColumn === vscode.ViewColumn.Two && _sameNotebook(ed.notebook, editor.notebook));
            if (rightEd) await _revealAgentCell(rightEd, cellIndex, false);
        }
        void notifyAgentNotebookEvent({ notebook: editor.notebook });
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
function _canonCellId(uriOrId) {
    let value = String(uriOrId ?? '');
    const hash = value.lastIndexOf('#');
    if (hash >= 0) value = value.slice(hash + 1);
    try { value = decodeURIComponent(value); } catch (_) {}
    return value.replace(/=+$/, '');
}

/** Get (or lazily assign) a stable CellId that survives move operations.
 *  Returns only the fragment portion of the vscode-notebook-cell URI — short, unique,
 *  and stable within a session. Old full-URI stored values are migrated on the fly. */
function getCellToolId(cell) {
    const meta = cell?.metadata;
    if (meta?.toolId) return _canonCellId(meta.toolId);
    return _canonCellId(cell?.document?.uri?.toString?.() || '');
}

/** Assign a stable toolId to a cell's metadata if it doesn't already have one.
 *  Returns the assigned/existing toolId (short fragment form). */
async function _ensureCellToolId(notebook, cellIndex) {
    const cell = notebook.cellAt(cellIndex);
    const existing = cell.metadata?.toolId;
    if (existing) return _canonCellId(existing);
    const id = _canonCellId(cell.document.uri.toString());
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

        const canonical = _canonCellId(raw);
        for (let i = 0; i < count; i++) {
            const id = getCellToolId(notebook.cellAt(i));
            if (_canonCellId(id) === canonical) return { idx: i };
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
 * READ-ONLY notebook resolution: returns a NotebookDocument without ever
 * calling showNotebookDocument or firing _onNotebookResolved.  Reads must not
 * change the active editor, steal focus, or set the Copilot session target —
 * a read that mutates routing is a trap (feedback 2026-08-18 §3.3).
 *
 * Law: explicit name (basename or absolute path) → exact match or null, NO
 * fallback.  No name → the active wolfbook notebook, else the sole open
 * wolfbook notebook (zero ambiguity), else null.
 *
 * @param {string} [targetName]
 * @returns {Promise<import('vscode').NotebookDocument|null>}
 */
async function resolveNotebookDocument(targetName) {
    const _openWithTimeout = async (uri, ms = 8000) => {
        let timer;
        try {
            return await Promise.race([
                vscode.workspace.openNotebookDocument(uri),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('openNotebookDocument timed out')), ms); }),
            ]);
        } finally { clearTimeout(timer); }
    };
    if (targetName) {
        const norm = String(targetName).trim().toLowerCase();
        for (const [fsPath, uri] of _allNotebookUris()) {
            const base = fsPath.split('/').pop().toLowerCase();
            if (base !== norm && fsPath.toLowerCase() !== norm) continue;
            const loaded = vscode.workspace.notebookDocuments.find(d => d.uri.fsPath === fsPath);
            if (loaded) return loaded;
            try { return await _openWithTimeout(uri); } catch (_) { return null; }
        }
        return null;
    }
    const active = vscode.window.activeNotebookEditor?.notebook;
    if (active && NB_EXTS.some(ext => active.uri.fsPath.endsWith(ext))) return active;
    const all = [..._allNotebookUris().entries()];
    if (all.length === 1) {
        const [fsPath, uri] = all[0];
        const loaded = vscode.workspace.notebookDocuments.find(d => d.uri.fsPath === fsPath);
        if (loaded) return loaded;
        try { return await _openWithTimeout(uri); } catch (_) { return null; }
    }
    return null;
}

/**
 * Supply the document and cell selection expected by editing/evaluation tools
 * without creating an editor tab. A real visible editor is reused when present.
 * Background selection is retained between tool calls and has no UI effects.
 */
function notebookToolEditor(notebook) {
    const visible = vscode.window.visibleNotebookEditors.find(ed => _sameNotebook(ed.notebook, notebook));
    if (visible) return visible;
    let editor = _backgroundEditors.get(notebook);
    if (!editor) {
        const RC = vscode.NotebookRange ?? vscode.NotebookCellRange;
        editor = {
            notebook, visibleRanges: [], selections: [new RC(0, Math.min(1, notebook.cellCount || 0))],
            get selection() { return this.selections[0]; },
            set selection(value) { this.selections = [value]; },
            revealRange() {}, setDecorations() {},
        };
        _backgroundEditors.set(notebook, editor);
    }
    return editor;
}

/**
 * Resolve an agent's target without changing the user's active tab. Loading a
 * document is enough for edits and for evaluation on an associated controller.
 * `preserveFocus:false` is reserved for callers explicitly requesting navigation.
 */
async function resolveNotebookEditor(targetName, opts = {}) {
    let notebook;
    if (targetName) {
        notebook = await resolveNotebookDocument(targetName);
    } else {
        notebook = vscode.window.activeNotebookEditor?.notebook
            || vscode.window.visibleNotebookEditors.find(ed => NB_EXTS.some(ext => ed.notebook.uri.fsPath.endsWith(ext)))?.notebook
            || vscode.workspace.notebookDocuments.find(doc => NB_EXTS.some(ext => doc.uri.fsPath.endsWith(ext)))
            || await resolveNotebookDocument();
    }
    if (!notebook) return null;
    const editor = opts.preserveFocus === false
        ? await vscode.window.showNotebookDocument(notebook, { preserveFocus: false, preview: false })
        : notebookToolEditor(notebook);
    _onNotebookResolved?.(path.basename(notebook.uri.fsPath));
    if (opts.notify !== false) void notifyAgentNotebookEvent({ notebook });
    return editor;
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
    normalizeMarkdownMath,
    CONTROL_CHAR_RE,
    findControlChar,
    decodeToolContent,
    prepareCellContent,
    splitWLIntoStatements,
    checkMarkdownKaTeX,
    _katexWarnings,
    _katexWarningsForCells,
    _isCollabMode,
    _ensureCollabEditor,
    registerAgentFollow,
    setAgentControllerProvider,
    notifyAgentNotebookEvent,
    flashCell,
    _snapshotViewport,
    _restoreViewport,
    buildTranscript,
    getCellToolId,
    _canonCellId,
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
    notebookToolEditor,
    resolveNotebookDocument,
    noEditorMsg,
    setMcpCallActive,
    acquireKernelForAgent,
    releaseKernelForAgent,
    trackedKernelEvaluate,
};
