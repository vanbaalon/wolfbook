'use strict';
/**
 * Oberon — Live notebook writer.
 *
 * Creates, opens, and incrementally populates a .wb notebook during a
 * Fairy or Skeptic phase, so the user can see live progress rather than
 * a post-hoc report.
 *
 * Used for:
 *   • charm findings notebooks  (kind='charm')  — driven by runFairy
 *   • critic working notebooks  (kind='critic')  — driven by runSkeptic
 *
 * Key behaviours
 * --------------
 *   init()             — writes skeleton if new; opens in editor; handles rerun
 *   appendToolResult() — appends narrative (markdown) + code cell per tool call
 *   appendMarkdown()   — appends a markdown-only cell (section headers, etc.)
 *   appendCode()       — appends a Wolfram code cell
 *   save()             — saves document; emits notebook.save
 *
 * All VS Code API calls are guarded; failures degrade to `omen` events and
 * never throw. When VS Code APIs are unavailable (e.g. test environment),
 * all operations are silent no-ops.
 *
 * Rerun detection
 * ---------------
 * If the .wb file already exists and has non-empty cells, the writer enters
 * "rerun" mode: instead of creating a fresh skeleton it opens the existing
 * file, inserts a "Rerun — <timestamp>" section header, and continues
 * appending from there.  Emits `rerun.fixup` instead of `notebook.created`.
 *
 * Auto-save
 * ---------
 * Saves automatically after every SAVE_EVERY_N_CELLS new cells so partial
 * work is preserved if the run is aborted or the kernel crashes.
 */

const path = require('path');
const fsp  = require('fs/promises');
const project = require('./project');

const SAVE_EVERY_N_CELLS = 4;

function _getVscode() {
    try { return require('vscode'); } catch (_) { return null; }
}

/**
 * Create a live notebook writer.
 *
 * @param {{
 *   quest:   object,
 *   charm:   object,
 *   bus:     import('../telemetry/bus').TelemetryBus,
 *   kind?:   'charm' | 'critic',    // default 'charm'
 *   nbPath?: string,                // override path (for testing)
 * }} opts
 * @returns {{
 *   init:             () => Promise<void>,
 *   appendToolResult: (opts: object) => Promise<void>,
 *   appendMarkdown:   (text: string) => Promise<void>,
 *   appendCode:       (code: string, opts?: object) => Promise<void>,
 *   save:             () => Promise<void>,
 *   readonly notebookPath: string | null,
 *   readonly isRerun:      boolean,
 *   readonly initialised:  boolean,
 * }}
 */
function createNotebookWriter({ quest, charm, bus, kind = 'charm', nbPath: customPath }) {
    const root   = project.getWorkspaceRoot();
    let   nbPath = customPath || null;

    if (!nbPath && root) {
        const dir = path.join(
            root, 'quests', `${quest.id}_${quest.shortName}`, 'findings');
        nbPath = kind === 'critic'
            ? path.join(dir, `${charm.id}_critic.wb`)
            : path.join(dir, `${charm.id}_findings.wb`);
    }

    let doc               = null;
    let isRerun           = false;
    let existingCellCount = 0;
    let pendingSinceSave  = 0;
    let _initialised      = false;

    // ── helpers ──────────────────────────────────────────────────────────

    async function _detectRerun() {
        if (!nbPath) return false;
        try {
            const raw = await fsp.readFile(nbPath, 'utf8');
            const nb  = JSON.parse(raw);
            return Array.isArray(nb.cells) && nb.cells.length > 0;
        } catch (_) { return false; }
    }

    async function _openDoc() {
        const vscode = _getVscode();
        if (!vscode || !nbPath) return null;
        try {
            const d = await vscode.workspace.openNotebookDocument(
                vscode.Uri.file(nbPath));
            await vscode.window.showNotebookDocument(
                d, { preview: false, preserveFocus: true });
            return d;
        } catch (e) {
            await _omen(`Failed to open notebook: ${e && e.message || String(e)}`);
            return null;
        }
    }

    async function _omen(message) {
        try {
            await bus.appendEvent('omen', {
                kind: 'notebook.failure', message, path: nbPath,
            }, { questId: quest.id, charmId: charm.id });
        } catch (_) {}
    }

    async function _appendCells(cellDescriptors) {
        if (!doc || !cellDescriptors.length) return false;
        const vscode = _getVscode();
        if (!vscode) return false;
        try {
            const startIdx = doc.cellCount;   // index BEFORE insertion
            const cellData = cellDescriptors.map(c => {
                const cellKind = c.kind === 1
                    ? vscode.NotebookCellKind.Markup
                    : vscode.NotebookCellKind.Code;
                return new vscode.NotebookCellData(cellKind, c.value, c.languageId);
            });
            const edit = new vscode.WorkspaceEdit();
            edit.set(doc.uri, [vscode.NotebookEdit.insertCells(doc.cellCount, cellData)]);
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) {
                pendingSinceSave += cellDescriptors.length;
                if (pendingSinceSave >= SAVE_EVERY_N_CELLS) await save();
                // Auto-execute inserted code cells so the user sees live kernel output.
                // Cells marked safe === false (manual-review) are intentionally skipped.
                const codeRanges = [];
                cellDescriptors.forEach((c, i) => {
                    if (c.kind === 2 && c.safe !== false) {
                        codeRanges.push({ start: startIdx + i, end: startIdx + i + 1 });
                    }
                });
                if (codeRanges.length > 0) {
                    vscode.commands.executeCommand('notebook.cell.execute', {
                        ranges: codeRanges,
                        uri: doc.uri,
                    }).catch(() => {});
                }
            }
            return !!ok;
        } catch (e) {
            await _omen(`Failed to append cells: ${e && e.message || String(e)}`);
            return false;
        }
    }

    // ── public API ────────────────────────────────────────────────────────

    /**
     * Create or open the notebook.  Must be called once before appending.
     * Safe to call multiple times (subsequent calls are no-ops).
     */
    async function init() {
        if (_initialised || !nbPath) return;
        const vscode = _getVscode();
        if (!vscode) return;

        isRerun = await _detectRerun();

        try { await fsp.mkdir(path.dirname(nbPath), { recursive: true }); } catch (_) {}

        if (!isRerun) {
            const skeleton = {
                cells: [],
                metadata: {
                    oberon: {
                        questId:     quest.id,
                        charmId:     charm.id,
                        kind,
                        generatedAt: new Date().toISOString(),
                    },
                },
            };
            try {
                await fsp.writeFile(
                    nbPath, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
            } catch (e) {
                await _omen(`Failed to write skeleton: ${e && e.message || String(e)}`);
                return;
            }
        }

        doc = await _openDoc();
        if (!doc) return;

        existingCellCount = doc.cellCount;
        _initialised = true;

        try {
            if (isRerun) {
                await bus.appendEvent('rerun.fixup', {
                    path: nbPath, existingCellCount,
                    appendedAt: new Date().toISOString(),
                    questId: quest.id, charmId: charm.id,
                });
                await _appendCells([{
                    kind: 1, languageId: 'markdown',
                    value: [
                        '',
                        '---',
                        `## Rerun — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
                        '',
                        `_Continuing from ${existingCellCount} existing cell${existingCellCount === 1 ? '' : 's'}._`,
                    ].join('\n'),
                }]);
            } else {
                await bus.appendEvent('notebook.created', {
                    path: nbPath, kind,
                    questId: quest.id, charmId: charm.id,
                });
            }
        } catch (_) {}
    }

    /**
     * Append one narrative-markdown cell + one Wolfram code cell after a
     * tool dispatch.  Both are optional; pass what is available.
     *
     * @param {{
     *   narrative?:  string,   // ≤300 chars — markdown heading text
     *   expression?: string,   // Wolfram code
     *   output?:     string,   // result (used only for metadata comment)
     *   ok?:         boolean,  // was the tool call successful?
     *   durationMs?: number,
     * }} opts
     */
    async function appendToolResult({ narrative, expression, output, ok: callOk, durationMs } = {}) {
        if (!_initialised || !doc) return;
        const cells = [];

        if (narrative) {
            cells.push({
                kind: 1, languageId: 'markdown',
                value: `### ${String(narrative).slice(0, 300)}`,
            });
        }

        if (expression && expression.trim()) {
            const ms      = durationMs != null ? `  (* ${durationMs}ms *)` : '';
            const trimmed = expression.trim();
            let cellValue;
            if (callOk !== false) {
                cellValue = trimmed + ms;
            } else {
                // Failed call — comment out so the user can review safely
                const commented = trimmed.split('\n')
                    .map(l => `(* ${l.replace(/\*\)/g, '* )')} *)`)
                    .join('\n');
                cellValue = `(* FAILED CALL — review before re-running *)\n${commented}`;
            }
            cells.push({ kind: 2, languageId: 'wolfram', value: cellValue, safe: callOk !== false });
        }

        if (cells.length > 0) {
            const appended = await _appendCells(cells);
            if (appended) {
                try {
                    await bus.appendEvent('notebook.checkpoint', {
                        path:      nbPath,
                        cellCount: doc.cellCount,
                        reason:    narrative
                            || (expression && expression.trim().slice(0, 80))
                            || 'tool result',
                    });
                } catch (_) {}
            }
        }
    }

    /**
     * Append a markdown-only cell (section headers, analysis, commentary).
     * @param {string} text
     */
    async function appendMarkdown(text) {
        if (!_initialised || !doc) return;
        await _appendCells([{ kind: 1, languageId: 'markdown', value: text }]);
    }

    /**
     * Append a Wolfram code cell.
     * @param {string} code
     * @param {{ comment?: string, safe?: boolean }} opts
     *   safe=false adds a "manual-review" warning so the Critic knows not to
     *   auto-execute this cell.
     */
    async function appendCode(code, { comment, safe = true } = {}) {
        if (!_initialised || !doc) return;
        const parts = [];
        if (!safe) parts.push('(* manual-review — do not execute automatically *)');
        if (comment) parts.push(`(* ${comment} *)`);
        parts.push(code);
        await _appendCells([{ kind: 2, languageId: 'wolfram', value: parts.join('\n'), safe }]);
    }

    /**
     * Save the notebook to disk.  Auto-called every SAVE_EVERY_N_CELLS cells.
     */
    async function save() {
        if (!doc) return;
        try {
            await doc.save();
            pendingSinceSave = 0;
            try {
                await bus.appendEvent('notebook.save', {
                    path: nbPath, cellCount: doc.cellCount,
                });
            } catch (_) {}
        } catch (e) {
            await _omen(`Failed to save notebook: ${e && e.message || String(e)}`);
        }
    }

    return {
        init, appendToolResult, appendMarkdown, appendCode, save,
        get notebookPath() { return nbPath; },
        get isRerun()      { return isRerun; },
        get initialised()  { return _initialised; },
    };
}

/**
 * Extract a narrative label from a Wolfram expression's leading comment.
 * Returns null if no leading `(* ... *)` comment is found.
 *
 * @param {string} expression
 * @returns {string | null}
 */
function extractNarrativeFromExpression(expression) {
    if (!expression) return null;
    const s = expression.trim();
    if (!s.startsWith('(*')) return null;
    const close = s.indexOf('*)');
    if (close < 0) return null;
    const inner = s.slice(2, close).trim();
    return inner.length > 0 ? inner.slice(0, 200) : null;
}

module.exports = { createNotebookWriter, extractNarrativeFromExpression };
