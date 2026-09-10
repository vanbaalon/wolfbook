'use strict';

const path = require('path');
const vscode = require('vscode');
const defaultEventBus = require('../remote/eventBus');

const STORAGE_KEY = 'wolfbook.recentMcpFiles.v1';
const NOTEBOOK_EXTENSIONS = new Set(['.wb', '.evsnb', '.vsnb']);
const MAX_RECENT_FILES = 10;

function _canonicalCellId(value) {
    let id = String(value || '');
    const hash = id.lastIndexOf('#');
    if (hash >= 0) id = id.slice(hash + 1);
    try { id = decodeURIComponent(id); } catch (_) {}
    return id.replace(/=+$/, '');
}

function _isNotebookPath(value) {
    return NOTEBOOK_EXTENSIONS.has(path.extname(String(value || '')).toLowerCase());
}

function _isSlidePath(value) {
    return path.extname(String(value || '')).toLowerCase() === '.wslide';
}

function _allKnownPaths(kind) {
    const paths = [];
    if (kind === 'notebook') {
        for (const doc of vscode.workspace.notebookDocuments || []) {
            if (_isNotebookPath(doc?.uri?.fsPath)) paths.push(doc.uri.fsPath);
        }
    } else {
        for (const doc of vscode.workspace.textDocuments || []) {
            if (_isSlidePath(doc?.uri?.fsPath)) paths.push(doc.uri.fsPath);
        }
        try {
            const provider = require('../slideEditorProvider').SlideEditorProvider.getInstance();
            for (const entry of provider?._panels?.values?.() || []) {
                if (_isSlidePath(entry?.document?.uri?.fsPath)) paths.push(entry.document.uri.fsPath);
            }
        } catch (_) {}
    }
    return paths;
}

function _toFsPath(raw, kind) {
    if (raw?.fsPath) return path.normalize(raw.fsPath);
    let value = String(raw || '').trim();
    if (!value || /^(active|current)$/i.test(value)) return null;
    if (/^(?:file:|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)) {
        try { value = vscode.Uri.parse(value).fsPath; } catch (_) {}
    }
    const known = _allKnownPaths(kind);
    const normalized = value.replace(/\\/g, '/').toLowerCase();
    const exact = known.find(candidate => candidate.replace(/\\/g, '/').toLowerCase() === normalized);
    if (exact) return path.normalize(exact);
    const base = path.basename(value).toLowerCase();
    const byBase = known.find(candidate => path.basename(candidate).toLowerCase() === base);
    if (byBase) return path.normalize(byBase);
    if (path.isAbsolute(value)) return path.normalize(value);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    return folder ? path.resolve(folder, value) : path.resolve(value);
}

function _toolAction(tool, input = {}) {
    const notebookActions = {
        wolfbook_insertCells: 'inserted cells',
        wolfbook_editCell: 'edited cell',
        wolfbook_runCell: 'ran cell',
        wolfbook_runCells: 'ran cells',
        wolfbook_deleteCell: 'deleted cell',
        wolfbook_moveCell: input.copy === true ? 'copied cell' : 'moved cell',
    };
    if (notebookActions[tool]) return { kind: 'notebook', action: notebookActions[tool] };
    if (tool === 'wolfbook_restoreDeletedCells' && input.action === 'restore') {
        return { kind: 'notebook', action: 'restored cell' };
    }

    const slideActions = {
        wolfslide_insertSlide: 'inserted slide',
        wolfslide_replaceSlide: 'replaced slide',
        wolfslide_editSlide: 'edited slide',
        wolfslide_deleteSlide: 'deleted slide',
        wolfslide_deleteSlides: 'deleted slides',
        wolfslide_duplicateSlide: 'duplicated slide',
        wolfslide_moveSlide: 'moved slide',
        wolfslide_insertEvalBlock: 'inserted eval block',
        wolfslide_runEvalBlock: 'ran eval block',
        wolfslide_arrange: 'arranged blocks',
        wolfslide_setTheme: 'changed theme',
        wolfslide_undo: 'undid edit',
        wolfslide_bulkInsert: 'inserted slides',
    };
    if (slideActions[tool]) return { kind: 'slide', action: slideActions[tool] };
    if (tool === 'wolfslide_patchBlock') {
        const patch = input.patch ?? input.updates;
        if (patch && typeof patch === 'object' && Object.keys(patch).length) {
            return { kind: 'slide', action: 'edited block' };
        }
        return null;
    }
    if (tool === 'wolfslide_block') {
        const actions = { insert: 'inserted block', edit: 'edited block', delete: 'deleted block',
            move: 'moved block', bulkEdit: 'edited blocks', bulkPatch: 'edited blocks' };
        return actions[input.action] ? { kind: 'slide', action: actions[input.action] } : null;
    }
    if (tool === 'wolfslide_advanced') {
        const actions = { duplicate: 'duplicated slide', reorderFragments: 'reordered fragments',
            promoteStyle: 'promoted style' };
        return actions[input.action] ? { kind: 'slide', action: actions[input.action] } : null;
    }
    if (tool === 'wolfslide_imageAsset' && input.action === 'insert') {
        return { kind: 'slide', action: 'inserted image' };
    }
    return null;
}

/** Capture the target before a potentially long-running tool call begins. */
function captureMcpFileTarget(tool, input = {}) {
    const spec = _toolAction(tool, input);
    if (!spec) return null;
    if (spec.kind === 'notebook') {
        const raw = tool === 'wolfbook_moveCell'
            ? (input.targetNotebook || input.notebook || input.sourceNotebook)
            : input.notebook;
        const active = vscode.window.activeNotebookEditor?.notebook?.uri?.fsPath;
        const file = _toFsPath(raw || active, 'notebook');
        return file && _isNotebookPath(file) ? { kind: 'notebook', path: file } : null;
    }
    let raw = input.docUri;
    if (!raw) {
        try {
            raw = require('../slideEditorProvider').SlideEditorProvider.getInstance()
                ?.getActiveEntry?.()?.document?.uri?.fsPath;
        } catch (_) {}
    }
    const file = _toFsPath(raw, 'slide');
    return file && _isSlidePath(file) ? { kind: 'slide', path: file } : null;
}

function _resultText(value) {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function _successful(event, input) {
    if (event?.ok === false || input?.dryRun === true) return false;
    const text = _resultText(event?.result);
    if (!text) return true;
    if (/^(?:Error\b|Unknown\b|Invalid\b|Required:|Provide\b|Cannot\b|Nothing to\b|No (?:active|notebook|\.wslide|deck|recovery)|All edits failed|Source notebook\b|Target notebook\b)/i.test(text)) return false;
    if (/"state"\s*:\s*"conflict"|not found|nothing to run|NOT executed|dispatched-unconfirmed|already at that position|no change made|kernel (?:is )?busy|kernel is not running|request not started|^Cancelled\b/i.test(text)) return false;
    if (/^Batch-edited 0\//i.test(text)) return false;
    return true;
}

function _lastMatch(text, regex, group = 1) {
    let found = null;
    for (const match of String(text || '').matchAll(regex)) found = match[group];
    return found;
}

function _notebookLocation(tool, input, result) {
    const cells = Array.isArray(input.cells) ? input.cells : [];
    const lastInput = cells[cells.length - 1] || input;
    let cellNumber = Number(_lastMatch(result, /\bCell\s+(\d+)\b/gi));
    if (!Number.isInteger(cellNumber) || cellNumber < 1) {
        const rangeEnd = _lastMatch(result, /\bCells?\s+\d+\s*[–-]\s*(\d+)\b/gi);
        cellNumber = Number(rangeEnd || lastInput.cellNumber || input.endCell || input.startCell);
    }
    if (!Number.isInteger(cellNumber) || cellNumber < 1) cellNumber = null;
    const resultId = _lastMatch(result, /CellId:\s*([^;,\s)]+)/gi);
    const cellId = _canonicalCellId(resultId || lastInput.cellId || input.cellId) || null;
    return { cellNumber, cellId, location: cellNumber ? `Cell ${cellNumber}` : (cellId ? `Cell ${cellId.slice(0, 10)}` : 'Notebook') };
}

function _slideLocation(tool, input, result) {
    let slideNumber = null;
    if (/insertSlide|duplicateSlide|moveSlide/.test(tool)) {
        slideNumber = Number(_lastMatch(result, /\b(?:inserted at |to )?position\s+(\d+)\b/gi));
    } else if (tool === 'wolfslide_bulkInsert') {
        slideNumber = Number(_lastMatch(result, /\bposition\s+\d+\s*[–-]\s*(\d+)\b/gi));
    }
    if (!Number.isInteger(slideNumber) || slideNumber < 1) {
        slideNumber = Number(_lastMatch(result, /\bslide\s+(\d+)\b/gi));
    }
    if (!Number.isInteger(slideNumber) || slideNumber < 1) {
        slideNumber = Number(input.slideIndex ?? input.slideNumber);
    }
    if (!Number.isInteger(slideNumber) || slideNumber < 1) slideNumber = null;
    const blockId = String(input.blockId || input.blockName ||
        _lastMatch(result, /\bblock(?:\s+id=|\s+")([A-Za-z0-9_.:-]+)/gi) || '').replace(/^"|"$/g, '') || null;
    let location = slideNumber ? `Slide ${slideNumber}` : 'Slide deck';
    if (blockId) location += ` · Block ${blockId}`;
    return { slideNumber, blockId, location };
}

class RecentMcpFiles {
    constructor(context, options = {}) {
        this._context = context;
        this._eventBus = options.eventBus || defaultEventBus;
        this._getSlideProvider = options.getSlideProvider || (() => {
            try { return require('../slideEditorProvider').SlideEditorProvider.getInstance(); } catch (_) { return null; }
        });
        const saved = context?.workspaceState?.get?.(STORAGE_KEY, []);
        this._history = Array.isArray(saved) ? saved.filter(entry => entry?.path && (_isNotebookPath(entry.path) || _isSlidePath(entry.path))).slice(0, MAX_RECENT_FILES) : [];
        this._item = vscode.window.createStatusBarItem(
            'wolfbook-mcp-recent-files', vscode.StatusBarAlignment.Right, 101
        );
        this._item.name = 'Recent MCP notebook activity';
        this._item.command = 'wolfbook.showRecentMcpFiles';
        this._command = vscode.commands.registerCommand('wolfbook.showRecentMcpFiles', () => this.show());
        this._off = this._eventBus.on('toolUsage', event => this.record(event));
        this._refresh();
        context?.subscriptions?.push(this);
    }

    record(event) {
        const input = event?.args || {};
        if (input?._activityContext?.source !== 'mcp') return false;
        const spec = _toolAction(event.tool, input);
        if (!spec || !_successful(event, input)) return false;
        const target = event.target || captureMcpFileTarget(event.tool, input);
        if (!target?.path || target.kind !== spec.kind) return false;
        const result = _resultText(event.result);
        const where = spec.kind === 'notebook'
            ? _notebookLocation(event.tool, input, result)
            : _slideLocation(event.tool, input, result);
        const entry = {
            path: path.normalize(target.path), kind: spec.kind, action: spec.action,
            ...where, timestamp: Number(event.ts) || Date.now(),
        };
        const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
        this._history = [entry, ...this._history.filter(item =>
            (process.platform === 'win32' ? item.path.toLowerCase() : item.path) !== key
        )].slice(0, MAX_RECENT_FILES);
        try { Promise.resolve(this._context?.workspaceState?.update?.(STORAGE_KEY, this._history)).catch(() => {}); } catch (_) {}
        this._refresh();
        return true;
    }

    _refresh() {
        const latest = this._history[0];
        if (!latest) { this._item.hide(); return; }
        this._item.text = `$(history) ${path.basename(latest.path)}`;
        this._item.tooltip = `Last MCP activity: ${latest.action} · ${latest.location}\n${latest.path}\nClick to open recent notebook and slide activity.`;
        this._item.accessibilityInformation = {
            label: `Recent MCP notebook activity. Last: ${path.basename(latest.path)}, ${latest.action}, ${latest.location}.`,
            role: 'button',
        };
        this._item.show();
    }

    async show() {
        if (!this._history.length) {
            return vscode.window.showInformationMessage('No MCP notebook or slide edits have been recorded in this VS Code window yet.');
        }
        const picks = this._history.map(entry => ({
            label: `${entry.kind === 'slide' ? '$(preview)' : '$(notebook)'} ${path.basename(entry.path)}`,
            description: `${entry.location} · ${entry.action}`,
            detail: entry.path,
            entry,
        }));
        const picked = await vscode.window.showQuickPick(picks, {
            title: 'Recent MCP notebook activity',
            placeHolder: 'Open a file at its last MCP-touched cell or slide',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (picked?.entry) await this._open(picked.entry);
    }

    async _open(entry) {
        try {
            const uri = vscode.Uri.file(entry.path);
            if (entry.kind === 'slide') {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'wolfbook.slideEditor');
                if (entry.slideNumber) {
                    // Custom-editor resolution can finish a frame after openWith.
                    // Retry briefly so a cold deck opens at the requested slide too.
                    for (let attempt = 0; attempt < 6; attempt++) {
                        const provider = this._getSlideProvider();
                        if (provider?.revealSlide && await provider.revealSlide(
                            entry.slideNumber - 1, uri.toString(), entry.blockId
                        )) return;
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                }
                return;
            }
            const document = (vscode.workspace.notebookDocuments || []).find(doc => doc.uri.fsPath === entry.path)
                || await vscode.workspace.openNotebookDocument(uri);
            const editor = await vscode.window.showNotebookDocument(document, { preserveFocus: false });
            let index = -1;
            if (entry.cellId) {
                const wanted = _canonicalCellId(entry.cellId);
                for (let i = 0; i < document.cellCount; i++) {
                    const cell = document.cellAt(i);
                    const id = _canonicalCellId(cell.metadata?.toolId || cell.metadata?.id || cell.metadata?.cellId || cell.document?.uri?.toString?.());
                    if (id === wanted) { index = i; break; }
                }
            }
            if (index < 0 && entry.cellNumber) index = entry.cellNumber - 1;
            if (document.cellCount > 0 && index >= 0) {
                index = Math.max(0, Math.min(index, document.cellCount - 1));
                const range = new vscode.NotebookRange(index, index + 1);
                editor.selection = range;
                editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not open ${path.basename(entry.path)}: ${error.message || error}`);
        }
    }

    dispose() {
        try { this._off?.(); } catch (_) {}
        try { this._command?.dispose?.(); } catch (_) {}
        try { this._item?.dispose?.(); } catch (_) {}
    }
}

function registerRecentMcpFiles(context, options) {
    return new RecentMcpFiles(context, options);
}

module.exports = {
    RecentMcpFiles, registerRecentMcpFiles, captureMcpFileTarget,
    _toolAction, _notebookLocation, _slideLocation,
};
