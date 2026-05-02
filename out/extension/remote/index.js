"use strict";
/*
 * wolfbook.remote.* — command surface for the Wolfbook Remote Host addon extension.
 *
 * This module exposes a narrow, secret-gated set of vscode.commands that the
 * companion `wolfbook.wolfbook-remote-host` extension uses as its bridge into
 * the main Wolfbook extension.  It does NOT open any network ports — that is
 * the addon's responsibility.  All commands here run in-process and return
 * plain JSON-shaped objects.
 *
 * Trust model
 * -----------
 *   1. On first activation we mint a 32-byte random secret and stash it in
 *      context.globalState (key: wolfbook.remote.hostSecret).
 *   2. The addon calls `wolfbook.remote.handshake({ extensionId, requestedCapabilities })`
 *      which (a) verifies that the live extension ID matches the expected
 *      addon ID, (b) checks the per-workspace user consent ("allow Wolfbook
 *      Remote Host?"), and (c) returns the secret on allow.
 *   3. Every other `wolfbook.remote.*` command takes the secret as its first
 *      positional argument and rejects with { error: "bad_secret" } otherwise.
 *
 * Slide and Copilot-mirror surfaces are stubbed for v0.1 — see PLAN §1.5 R2/R3.
 */

const vscode    = require('vscode');
const crypto    = require('crypto');
const shared    = require('../tools/shared');
const eventBus  = require('./eventBus');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOST_EXTENSION_ID    = 'wolfbook.wolfbook-remote-host';
const SECRET_STATE_KEY     = 'wolfbook.remote.hostSecret';
const ALLOW_STATE_KEY      = 'wolfbook.remote.allowHostExtension.confirmed';
const PROTOCOL_VERSIONS    = [1];
const NB_TYPE              = 'extended-wolfram-notebook';
const SUB_BUFFER_LIMIT     = 1000;

// ---------------------------------------------------------------------------
// Subscription registry (in-memory, per-window)
// ---------------------------------------------------------------------------
//
// Each subscription = { id, channels: Set<string>, buffer: Array<RemoteEvent>,
//                       seq: number (monotonic), lastDeliveredSeq: number }
// Buffer is a bounded ring (length SUB_BUFFER_LIMIT). When pull() requests an
// `afterSeq` older than the oldest buffered seq, we return { dropped: true }.

const _subscriptions = new Map();   // subId → subscription
let   _subSeqCounter = 0;

function _newSubId() {
    return crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Tool-usage classification (used to render the iOS activity timeline)
// ---------------------------------------------------------------------------

const _TOOL_KIND_MAP = {
    'wolfbook_getNotebookContext': 'context',
    'wolfbook_getCellOutput':      'read',
    'wolfbook_searchCells':        'read',
    'wolfbook_getKernelState':     'read',
    'wolfbook_lookupSymbol':       'read',
    'wolfbook_findPackage':        'read',
    'wolfbook_paperSearch':        'read',
    'wolfbook_validateSyntax':     'read',
    'wolfbook_editCell':           'edit',
    'wolfbook_insertCells':        'edit',
    'wolfbook_deleteCell':         'edit',
    'wolfbook_moveCell':           'edit',
    'wolfbook_restoreDeletedCells':'edit',
    'wolfbook_runCell':            'run',
    'wolfbook_runRange':           'run',
    'wolfbook_evaluateExpression': 'run',
    'wolfbook_kernelControl':      'run',
    'wolfbook_debugCell':          'run',
    'wolfbook_remote_checkpoint':  'checkpoint',
    'wolfbook_fileOps':            'edit',
    'wolfbook_runTerminal':        'run',
    'wolfbook_latex':              'other',
    'wolfbook_kernelCrashLog':     'read',
};

function _classifyToolKind(tool) {
    if (_TOOL_KIND_MAP[tool]) return _TOOL_KIND_MAP[tool];
    if (tool.startsWith('wolfteam_'))  return 'other';
    if (tool.startsWith('wolfslide_')) return tool.includes('insert') || tool.includes('edit') || tool.includes('move') || tool.includes('delete') ? 'edit' : 'read';
    return 'other';
}

function _previewArgs(tool, args) {
    if (!args || typeof args !== 'object') return '';
    try {
        switch (tool) {
            case 'wolfbook_runCell':
            case 'wolfbook_runRange': {
                const sc = args.startCell ?? args.cellId ?? args.cellNumber;
                const ec = args.endCell;
                if (ec != null && sc !== ec) return `cells ${sc}–${ec}`;
                return `cell ${sc ?? '?'}`;
            }
            case 'wolfbook_editCell': {
                const id = args.cellId ?? args.cellNumber;
                const len = (args.newSource ?? args.source ?? '').length;
                return `cell ${id ?? '?'} (${len} chars)`;
            }
            case 'wolfbook_insertCells': {
                const n = (args.cells || []).length;
                return `${n} cell${n === 1 ? '' : 's'} at ${args.position ?? args.afterCell ?? '?'}`;
            }
            case 'wolfbook_evaluateExpression': {
                const e = String(args.expression ?? args.code ?? '');
                return e.length > 60 ? e.slice(0, 57) + '…' : e;
            }
            case 'wolfbook_lookupSymbol':
                return String(args.symbol ?? args.name ?? '');
            case 'wolfbook_searchCells':
                return String(args.query ?? '');
            case 'wolfbook_getNotebookContext':
                return args.action || 'read';
            case 'wolfbook_remote_checkpoint':
                return `[${args.kind || '?'}] ${String(args.summary || '').slice(0, 80)}`;
            default: {
                // Generic JSON fallback, capped
                const s = JSON.stringify(args);
                return s.length > 200 ? s.slice(0, 197) + '…' : s;
            }
        }
    } catch (_) { return ''; }
}

function _emitToSubs(channel, payload) {
    _subSeqCounter++;
    const seq = _subSeqCounter;
    const event = { v: 1, seq, type: payload.type, ...payload };
    delete event.type; event.type = payload.type; // ensure type stays
    for (const sub of _subscriptions.values()) {
        if (!sub.channels.has(channel)) continue;
        sub.buffer.push(event);
        if (sub.buffer.length > SUB_BUFFER_LIMIT) sub.buffer.shift();
    }
}

// ---------------------------------------------------------------------------
// Document descriptor helpers
// ---------------------------------------------------------------------------

const NB_EXTS    = ['.wb', '.evsnb', '.vsnb'];
const KIND_BY_EXT = {
    '.wb':     'notebook',
    '.evsnb':  'notebook',
    '.vsnb':   'notebook',
    '.wslide': 'slides',     // present in protocol; commands stubbed in v0.1
    '.md':     'markdown',
    '.tex':    'tex',
    '.wl':     'script',
    '.m':      'script',
    '.wls':    'script',
};

function _kindFor(uri) {
    const path = uri.fsPath || uri.path || '';
    const dot  = path.lastIndexOf('.');
    if (dot < 0) return 'plaintext';
    return KIND_BY_EXT[path.slice(dot)] || 'plaintext';
}

function _docIdFor(uri) {
    return uri.toString();
}

function _basename(p) {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
}

function _allKnownDocuments() {
    const map = new Map(); // docId → DocumentDescriptor
    for (const doc of vscode.workspace.notebookDocuments) {
        if (doc.notebookType !== NB_TYPE) continue;
        map.set(_docIdFor(doc.uri), {
            docId:    _docIdFor(doc.uri),
            kind:     'notebook',
            fileName: _basename(doc.uri.fsPath),
            fsPath:   doc.uri.fsPath,
            cellCount: doc.cellCount,
            dirty:    doc.isDirty || false,
        });
    }
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== 'file') continue;
        const k = _kindFor(doc.uri);
        if (k === 'plaintext') continue;
        if (map.has(_docIdFor(doc.uri))) continue;
        map.set(_docIdFor(doc.uri), {
            docId:    _docIdFor(doc.uri),
            kind:     k,
            fileName: _basename(doc.uri.fsPath),
            fsPath:   doc.uri.fsPath,
            dirty:    doc.isDirty || false,
        });
    }
    // Tabs that aren't loaded yet (background tabs)
    try {
        for (const group of (vscode.window.tabGroups?.all || [])) {
            for (const tab of (group.tabs || [])) {
                const uri = tab.input?.uri || tab.input?.modified;
                if (!uri) continue;
                const k = _kindFor(uri);
                if (k === 'plaintext') continue;
                const id = _docIdFor(uri);
                if (map.has(id)) continue;
                map.set(id, {
                    docId:    id,
                    kind:     k,
                    fileName: _basename(uri.fsPath),
                    fsPath:   uri.fsPath,
                    dirty:    tab.isDirty || false,
                });
            }
        }
    } catch (_) {}
    return map;
}

function _activeDocId() {
    const ed = vscode.window.activeNotebookEditor;
    if (ed) return _docIdFor(ed.notebook.uri);
    const txt = vscode.window.activeTextEditor;
    if (txt) return _docIdFor(txt.document.uri);
    return null;
}

function _findNotebookByDocId(docId) {
    for (const doc of vscode.workspace.notebookDocuments) {
        if (_docIdFor(doc.uri) === docId) return doc;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Cell snapshot
// ---------------------------------------------------------------------------

const _decoder = new (require('util').TextDecoder)();
const _fs_remote   = require('fs');
const _path_remote = require('path');

/**
 * Replace <img src="relative/path"> in Wolfbook HTML output with inline
 * data URIs so that iOS WKWebView (which can't access the Mac filesystem)
 * can display plot graphics.
 */
function _inlineHtmlImages(html, nbFsPath) {
    if (!html || !nbFsPath) return html;
    const dir = _path_remote.dirname(nbFsPath);
    return html.replace(/(<img\s[^>]*src=")([^"]+)(")/gi, (match, pre, src, post) => {
        if (src.startsWith('data:') || src.startsWith('http')) return match;
        try {
            const abs = _path_remote.isAbsolute(src) ? src : _path_remote.resolve(dir, src);
            const buf = _fs_remote.readFileSync(abs);
            const ext = _path_remote.extname(abs).toLowerCase();
            const mime = ext === '.svg' ? 'image/svg+xml' : 'image/png';
            return `${pre}data:${mime};base64,${buf.toString('base64')}${post}`;
        } catch (_) { return match; }
    });
}

function _cellSnapshot(cell, index) {
    const cellId = shared.getCellToolId(cell);
    const kind   = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code';
    const input  = cell.document.getText();
    const nbFsPath = cell.notebook?.uri?.fsPath;
    const outs   = [];
    for (const out of cell.outputs) {
        const items = [];
        for (const it of out.items) {
            const item = { mime: it.mime };
            const sizeLimit = (it.mime === 'x-application/wolfram-language-html' ||
                               it.mime === 'x-application/wolfram-language-katex')
                ? 4 * 1024 * 1024   // 4 MB for rich output types (images get inlined)
                : 512 * 1024;
            if (typeof it.data?.length === 'number' && it.data.length < sizeLimit) {
                if (it.mime.startsWith('text/') || it.mime === 'application/vnd.code.notebook.error' ||
                    it.mime === 'x-application/wolfram-language-html' ||
                    it.mime === 'x-application/wolfram-language-katex') {
                    try {
                        let decoded = _decoder.decode(it.data);
                        if (it.mime === 'x-application/wolfram-language-html') {
                            decoded = _inlineHtmlImages(decoded, nbFsPath);
                        }
                        item.text = decoded;
                    } catch (_) {}
                } else {
                    item.bytes = Buffer.from(it.data).toString('base64');
                }
            }
            items.push(item);
        }
        outs.push({ items });
    }
    return {
        cellId,
        cellNumber: index + 1,
        kind,
        input,
        outputs: outs,
        cellVersion: cell.document.version,
        executionOrder: cell.executionSummary?.executionOrder ?? null,
        success:        cell.executionSummary?.success ?? null,
    };
}

// ---------------------------------------------------------------------------
// Secret/handshake handling
// ---------------------------------------------------------------------------

let _ctx = null;            // set in register()
let _cachedSecret = null;

function _ensureSecret() {
    if (_cachedSecret) return _cachedSecret;
    let s = _ctx.globalState.get(SECRET_STATE_KEY);
    if (!s || typeof s !== 'string' || s.length < 32) {
        s = crypto.randomBytes(32).toString('hex');
        _ctx.globalState.update(SECRET_STATE_KEY, s);
    }
    _cachedSecret = s;
    return s;
}

function _checkAllowed() {
    const cfg = vscode.workspace.getConfiguration('wolfbook.remote');
    if (cfg.get('allowHostExtension', true) === false) return 'disabled_by_main_extension';
    return null;
}

async function _confirmConsent() {
    if (_ctx.workspaceState.get(ALLOW_STATE_KEY) === true) return true;
    const choice = await vscode.window.showInformationMessage(
        'Wolfbook Remote Host wants to control this Wolfbook session. Allow this workspace?',
        { modal: true, detail: 'You can revoke this from Wolfbook Remote: Manage Connected Devices.' },
        'Allow', 'Deny'
    );
    if (choice === 'Allow') {
        await _ctx.workspaceState.update(ALLOW_STATE_KEY, true);
        return true;
    }
    return false;
}

function _bad(reason) { return { error: reason }; }

function _checkSecret(secret) {
    if (typeof secret !== 'string') return false;
    const expected = _cachedSecret || _ctx.globalState.get(SECRET_STATE_KEY);
    if (!expected || expected.length !== secret.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(secret, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Eval orchestration helpers
// ---------------------------------------------------------------------------

const _evalsInFlight = new Map();   // evalId → { docId, cellId, startedAt }

function _newEvalId() { return crypto.randomBytes(6).toString('hex'); }

async function _waitIdle(controller, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const idle = !controller._evalDispatched && controller.executionQueue.queueLength() === 0;
        if (idle) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function _makeApi(getController, getToolMap) {

    async function handshake(args) {
        if (!args || typeof args !== 'object') return _bad('bad_args');
        const blocked = _checkAllowed();
        if (blocked) return _bad(blocked);
        if (args.extensionId !== HOST_EXTENSION_ID) return _bad('untrusted_caller');
        const ext = vscode.extensions.getExtension(HOST_EXTENSION_ID);
        if (!ext) return _bad('host_not_found');
        const ok = await _confirmConsent();
        if (!ok) return _bad('denied');
        const _result = {
            secret: _ensureSecret(),
            protocolVersions: PROTOCOL_VERSIONS,
            mainExtensionVersion: vscode.extensions.getExtension('wolfbook.wolfbook')?.packageJSON?.version || null,
        };
        eventBus.emit('remoteConnected', { connected: true });
        return _result;
    }

    async function listDocuments(secret /*, args */) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        const map  = _allKnownDocuments();
        const docs = [...map.values()];
        const activeId = _activeDocId();
        for (const d of docs) d.active = (d.docId === activeId);
        return { documents: docs };
    }

    async function focusDocument(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId) return _bad('bad_args');
        const uri = vscode.Uri.parse(args.docId);
        const stealFocus = !!args.stealFocus;
        try {
            if (uri.fsPath.endsWith('.wb') || uri.fsPath.endsWith('.evsnb') || uri.fsPath.endsWith('.vsnb')) {
                const doc = await vscode.workspace.openNotebookDocument(uri);
                await vscode.window.showNotebookDocument(doc, { preserveFocus: !stealFocus });
            } else {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preserveFocus: !stealFocus });
            }
            return { ok: true };
        } catch (err) {
            return _bad('open_failed:' + (err?.message || 'unknown'));
        }
    }

    async function getDocumentState(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (nb) {
            const cells = [];
            for (let i = 0; i < nb.cellCount; i++) cells.push(_cellSnapshot(nb.cellAt(i), i));
            const themeKind = vscode.window.activeColorTheme?.kind ?? 1;
            const nbSettings = nb.metadata?.wolframSettings ?? {};
            const backgroundColor = nbSettings.backgroundColor ?? '';
            return { kind: 'notebook', payload: {
                docId:     args.docId,
                fileName:  _basename(nb.uri.fsPath),
                cellCount: nb.cellCount,
                dirty:     nb.isDirty,
                cells,
                themeKind,
                backgroundColor,
            } };
        }
        // Plain text fallback
        try {
            const uri = vscode.Uri.parse(args.docId);
            const doc = await vscode.workspace.openTextDocument(uri);
            return { kind: _kindFor(uri), payload: {
                docId:    args.docId,
                fileName: _basename(uri.fsPath),
                text:     doc.getText(),
                dirty:    doc.isDirty,
            } };
        } catch (err) {
            return _bad('open_failed:' + (err?.message || 'unknown'));
        }
    }

    async function getCell(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (!nb) return _bad('not_a_notebook');
        const ref = args.cellId ?? args.cellNumber;
        const r = shared.resolveCellIndex(nb, ref, args.cellId != null ? 'cellId' : 'cellNumber');
        if (r.error) return _bad('cell_not_found');
        return _cellSnapshot(nb.cellAt(r.idx), r.idx);
    }

    async function editCell(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (!nb) return _bad('not_a_notebook');
        const ref = args.cellId ?? args.cellNumber;
        const r = shared.resolveCellIndex(nb, ref, args.cellId != null ? 'cellId' : 'cellNumber');
        if (r.error) return _bad('cell_not_found');
        const cell = nb.cellAt(r.idx);
        if (typeof args.baseVersion === 'number' && cell.document.version !== args.baseVersion) {
            return { ok: false, error: 'stale_version', currentVersion: cell.document.version };
        }
        const newContent = String(args.newInput ?? '');
        if (typeof args.contentHash === 'string') {
            const h = crypto.createHash('sha256').update(newContent, 'utf8').digest('hex');
            if (h !== args.contentHash) return _bad('hash_mismatch');
        }
        const cellDoc = cell.document;
        const lastLine = Math.max(0, cellDoc.lineCount - 1);
        const fullRange = new vscode.Range(0, 0, lastLine, cellDoc.lineAt(lastLine).text.length);
        const edit = new vscode.WorkspaceEdit();
        edit.set(cellDoc.uri, [new vscode.TextEdit(fullRange, newContent)]);
        const ok = await vscode.workspace.applyEdit(edit);
        return { ok, version: nb.cellAt(r.idx).document.version, cellId: shared.getCellToolId(nb.cellAt(r.idx)) };
    }

    async function insertCell(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (!nb) return _bad('not_a_notebook');
        // Determine insert position: after afterCellId, or at end if omitted/null
        let insertIdx = nb.cellCount;  // default: append at end
        if (args.afterCellId != null) {
            const r = shared.resolveCellIndex(nb, args.afterCellId, 'cellId');
            if (!r.error) insertIdx = r.idx + 1;
        }
        const cellKind = args.kind === 'markdown'
            ? vscode.NotebookCellKind.Markup
            : vscode.NotebookCellKind.Code;
        const cellData = new vscode.NotebookCellData(cellKind, args.source ?? '', 'wolfram');
        const edit = new vscode.WorkspaceEdit();
        edit.set(nb.uri, [vscode.NotebookEdit.insertCells(insertIdx, [cellData])]);
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) return { ok: false, error: 'apply_edit_failed' };
        // Return the new cell's ID (it's now at insertIdx)
        const newCell = nb.cellAt(Math.min(insertIdx, nb.cellCount - 1));
        return { ok: true, cellId: shared.getCellToolId(newCell) };
    }

    async function evalCell(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (!nb) return _bad('not_a_notebook');
        const ref = args.cellId ?? args.cellNumber;
        const r = shared.resolveCellIndex(nb, ref, args.cellId != null ? 'cellId' : 'cellNumber');
        if (r.error) return _bad('cell_not_found');
        const cell = nb.cellAt(r.idx);
        if (cell.kind === vscode.NotebookCellKind.Markup) return _bad('markup_cell');
        if (typeof args.cellVersion === 'number' && cell.document.version !== args.cellVersion) {
            return _bad('stale_version');
        }
        const ctrl = getController?.();
        if (!ctrl || ctrl.kernelStatusString !== 'resolved' || typeof ctrl.execute !== 'function') {
            return _bad('kernel_not_ready');
        }
        const evalId = _newEvalId();
        _evalsInFlight.set(evalId, { docId: args.docId, cellId: shared.getCellToolId(cell), startedAt: Date.now() });
        try {
            ctrl._silentExecution = true;
            ctrl._wolframExecPending = true;
            ctrl.execute([cell], nb, ctrl._controller);
        } finally {
            // Don't clear _silentExecution here — checkout pipeline does it after the cell completes.
            // Clear it after a short async tick to avoid suppressing user evals indefinitely if execute() throws.
            setTimeout(() => { try { ctrl._silentExecution = false; } catch (_) {} }, 50);
        }
        // Emit eval.started immediately
        _emitToSubs('cells', { type: 'eval.started', docId: args.docId, cellId: shared.getCellToolId(cell), evalId });
        return { evalId };
    }

    async function abortEval(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        const ctrl = getController?.();
        if (!ctrl) return _bad('kernel_not_ready');
        try { await ctrl.abortAndWait?.(5000); } catch (_) {}
        if (args?.evalId) _evalsInFlight.delete(args.evalId);
        return { ok: true };
    }

    async function saveFile(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId) return _bad('bad_args');
        const uri = vscode.Uri.parse(args.docId);
        try {
            await vscode.workspace.save(uri);
            return { ok: true };
        } catch (err) {
            return _bad('save_failed:' + (err?.message || 'unknown'));
        }
    }

    async function restartKernel(secret /*, args */) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        try {
            await vscode.commands.executeCommand('wolfbook.restartKernel');
            return { ok: true };
        } catch (err) {
            return _bad('restart_failed:' + (err?.message || 'unknown'));
        }
    }

    /**
     * Submit a prompt to Copilot Chat in any mode (`agent` by default).
     * Send-only: we cannot mirror the assistant's reply stream from a
     * bystander extension, but agent activity surfaces via the toolUsage
     * and checkpoint event channels.
     *
     * args = { text, mode? = 'agent'|'ask'|'edit', target?, newChat? = true }
     */
    async function copilotSubmit(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.text || typeof args.text !== 'string') return _bad('bad_args');
        const target = args.target || 'none';
        const prefix = target === 'none' ? '' :
                       target === 'agent' ? '' :
                       target === 'wolfteam' ? '@wolfteam ' :
                       target === 'wolfbook' ? '@wolfbook ' :
                       `@${target} `;
        const mode = args.mode || 'agent';
        try {
            if (args.newChat !== false) {
                try { await vscode.commands.executeCommand('workbench.action.chat.newChat'); } catch (_) {}
            }
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prefix + args.text,
                mode,
                isPartialQuery: false,
            });
            return { ok: true };
        } catch (err) {
            return _bad('chat_open_failed:' + (err?.message || 'unknown'));
        }
    }

    async function copilotAbort(secret) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        try { await vscode.commands.executeCommand('workbench.action.chat.cancel'); return { ok: true }; }
        catch (err) { return _bad('chat_cancel_failed:' + (err?.message || 'unknown')); }
    }

    // ---- Slide stubs (v0.1) ----
    function notImplemented() { return { error: 'notImplementedV0_1' }; }
    async function getSlideState(secret) { return _checkSecret(secret) ? notImplemented() : _bad('bad_secret'); }
    async function slideAdvance(secret)  { return _checkSecret(secret) ? notImplemented() : _bad('bad_secret'); }
    async function slideGoto(secret)     { return _checkSecret(secret) ? notImplemented() : _bad('bad_secret'); }

    // ---- Subscriptions ----

    async function subscribe(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!Array.isArray(args?.channels)) return _bad('bad_args');
        const subId = _newSubId();
        const buffer = [];
        const beforeSeq = _subSeqCounter;

        // Seed buffer with initial cell state for "cells" channel subscribers.
        // Iterate all open notebooks so iOS gets cells immediately regardless of focus.
        if (args.channels.includes('cells')) {
            for (const doc of vscode.workspace.notebookDocuments) {
                if (doc.notebookType !== NB_TYPE) continue;
                const docId = _docIdFor(doc.uri);
                for (let i = 0; i < doc.cellCount; i++) {
                    const cell = doc.cellAt(i);
                    const cellId = shared.getCellToolId(cell);
                    const ss = _cellSnapshot(cell, i);
                    // Strip outputs from initial seed to keep pull_reply under
                    // DataChannel's 256KB max-message-size. Outputs arrive via
                    // cell.update events from onDidChangeNotebookDocument.
                    const seedSnapshot = { ...ss, outputs: [] };
                    _subSeqCounter++;
                    buffer.push({
                        v: 1, seq: _subSeqCounter, type: 'cell.inserted',
                        docId, cellId, index: i, snapshot: seedSnapshot,
                    });
                }
            }
        }

        _subscriptions.set(subId, {
            id: subId,
            channels: new Set(args.channels),
            buffer,
            firstSeq: _subSeqCounter + 1,
        });
        return { subId, lastSeq: beforeSeq };
    }

    async function pull(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        const sub = _subscriptions.get(args?.subId);
        if (!sub) return _bad('unknown_subscription');
        const after = typeof args.afterSeq === 'number' ? args.afterSeq : -1;
        // Detect drop: if afterSeq < oldest buffered seq AND buffer is full to capacity
        if (sub.buffer.length === SUB_BUFFER_LIMIT && after < sub.buffer[0].seq - 1) {
            // We've evicted events the caller hasn't seen
            return { error: 'dropped', resubscribeNeeded: true };
        }
        const events = sub.buffer.filter(e => e.seq > after);
        const lastSeq = events.length > 0 ? events[events.length - 1].seq : after;
        // Trim buffer up to delivered seq (best-effort: keep last 64 for re-pull)
        if (events.length > 64) {
            sub.buffer.splice(0, sub.buffer.length - 64);
        }
        return { events, lastSeq };
    }

    async function unsubscribe(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        _subscriptions.delete(args?.subId);
        return { ok: true };
    }

    async function scrollToCell(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        const cellId = args?.cellId ?? '';
        if (!cellId) return { ok: false };
        const nb = _findNotebookByDocId(args?.docId ?? '');
        if (!nb) return { ok: false };
        const r = shared.resolveCellIndex(nb, cellId, 'cellId');
        if (r?.error) return { ok: false };
        const ed = vscode.window.visibleNotebookEditors?.find(e => e.notebook === nb)
                ?? vscode.window.activeNotebookEditor;
        if (ed && ed.notebook === nb) {
            const range = new vscode.NotebookRange(r.idx, r.idx + 1);
            ed.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
        }
        return { ok: true };
    }

    async function deleteCell(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId || !args?.cellId) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (!nb) return { ok: false };
        const r = shared.resolveCellIndex(nb, args.cellId, 'cellId');
        if (r?.error) return { ok: false };
        const edit = new vscode.WorkspaceEdit();
        edit.set(nb.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(r.idx, r.idx + 1))]);
        await vscode.workspace.applyEdit(edit);
        return { ok: true };
    }

    async function moveCell(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId || !args?.cellId) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (!nb) return { ok: false };
        const r = shared.resolveCellIndex(nb, args.cellId, 'cellId');
        if (r?.error) return { ok: false };
        const fromIdx = r.idx;
        const toIdx = args.direction === 'up' ? fromIdx - 1 : fromIdx + 1;
        if (toIdx < 0 || toIdx >= nb.cellCount) return { ok: true }; // already at boundary
        const cell = nb.cellAt(fromIdx);
        const cellData = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
        cellData.metadata = { ...(cell.metadata || {}) };
        // Preserve outputs so they survive the delete+insert round-trip.
        if (cell.outputs && cell.outputs.length > 0) {
            cellData.outputs = cell.outputs.map(out =>
                new vscode.NotebookCellOutput(
                    out.items.map(item => new vscode.NotebookCellOutputItem(item.data, item.mime)),
                    out.metadata
                )
            );
        }
        // Insert position: moving up means insert before fromIdx-1, i.e. at fromIdx-1
        // moving down means insert after fromIdx+1, i.e. at fromIdx+2 (before delete shifts it)
        const insertAt = args.direction === 'up' ? fromIdx - 1 : fromIdx + 2;
        const clampedInsert = Math.max(0, Math.min(nb.cellCount, insertAt));
        const edit = new vscode.WorkspaceEdit();
        edit.set(nb.uri, [
            vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(fromIdx, fromIdx + 1)),
            vscode.NotebookEdit.insertCells(clampedInsert > fromIdx ? clampedInsert - 1 : clampedInsert, [cellData]),
        ]);
        await vscode.workspace.applyEdit(edit);
        return { ok: true };
    }

    async function changeCellKind(secret, args) {
        if (!_checkSecret(secret)) return _bad('bad_secret');
        if (!args?.docId || !args?.cellId || !args?.newKind) return _bad('bad_args');
        const nb = _findNotebookByDocId(args.docId);
        if (!nb) return { ok: false };
        const r = shared.resolveCellIndex(nb, args.cellId, 'cellId');
        if (r?.error) return { ok: false };
        const cell = nb.cellAt(r.idx);
        const newKind = args.newKind === 'markdown'
            ? vscode.NotebookCellKind.Markup
            : vscode.NotebookCellKind.Code;
        const newLang = args.newKind === 'markdown' ? 'markdown' : 'wolfram';
        const cellData = new vscode.NotebookCellData(newKind, cell.document.getText(), newLang);
        cellData.metadata = { ...(cell.metadata || {}) };
        const edit = new vscode.WorkspaceEdit();
        edit.set(nb.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(r.idx, r.idx + 1), [cellData])]);
        await vscode.workspace.applyEdit(edit);
        return { ok: true };
    }

    return {
        handshake, listDocuments, focusDocument, getDocumentState, getCell,
        editCell, insertCell, evalCell, abortEval, saveFile, restartKernel,
        copilotSubmit, copilotAbort,
        getSlideState, slideAdvance, slideGoto,
        subscribe, pull, unsubscribe,
        scrollToCell, deleteCell, moveCell, changeCellKind,
    };
}

// ---------------------------------------------------------------------------
// Event listeners — feed subscription buffers
// ---------------------------------------------------------------------------

function _registerEventListeners(context, getController) {
    const { onDidChangeNotebookDocument, onDidOpenNotebookDocument, onDidCloseNotebookDocument } = vscode.workspace;

    if (typeof onDidChangeNotebookDocument === 'function') {
        context.subscriptions.push(onDidChangeNotebookDocument(ev => {
            try {
                if (ev.notebook.notebookType !== NB_TYPE) return;
                const docId = _docIdFor(ev.notebook.uri);
                for (const cc of (ev.cellChanges || [])) {
                    const cell = cc.cell;
                    const cellId = shared.getCellToolId(cell);
                    if (cc.executionSummary) {
                        const es = cc.executionSummary;
                        if (es.success != null) {
                            // Eval finished — find evalId by cellId (best-effort)
                            let evalId = null;
                            for (const [id, info] of _evalsInFlight) {
                                if (info.docId === docId && info.cellId === cellId) { evalId = id; break; }
                            }
                            const durationMs = (es.timing?.endTime && es.timing?.startTime)
                                ? Math.round(es.timing.endTime - es.timing.startTime) : 0;
                            if (es.success) {
                                _emitToSubs('cells', { type: 'eval.done', docId, cellId, evalId: evalId ?? '', durationMs });
                            } else {
                                _emitToSubs('cells', { type: 'eval.error', docId, cellId, evalId: evalId ?? '', message: 'execution reported failure' });
                            }
                            if (evalId) _evalsInFlight.delete(evalId);
                        }
                    }
                    if (cc.document || cc.outputs) {
                        const idx = cell.index ?? 0;
                        _emitToSubs('cells', {
                            type: 'cell.update',
                            docId,
                            cellId,
                            cellVersion: cell.document.version,
                            input: cell.document.getText(),
                            output: { kind: 'snapshot', outputs: _cellSnapshot(cell, idx).outputs },
                        });
                    }
                }
                for (const ch of (ev.contentChanges || [])) {
                    for (const removed of (ch.removedCells || [])) {
                        _emitToSubs('cells', { type: 'cell.deleted', docId, cellId: shared.getCellToolId(removed) });
                    }
                    let i = ch.range.start;
                    for (const added of (ch.addedCells || [])) {
                        _emitToSubs('cells', {
                            type: 'cell.inserted', docId,
                            cellId: shared.getCellToolId(added),
                            index: i,
                            snapshot: _cellSnapshot(added, i),
                        });
                        i++;
                    }
                }
            } catch (_) { /* never let listener errors break VS Code */ }
        }));
    }

    if (typeof onDidOpenNotebookDocument === 'function') {
        context.subscriptions.push(onDidOpenNotebookDocument(doc => {
            if (doc.notebookType !== NB_TYPE) return;
            _emitToSubs('documents', {
                type: 'document.opened',
                descriptor: {
                    docId: _docIdFor(doc.uri), kind: 'notebook',
                    fileName: _basename(doc.uri.fsPath),
                    fsPath: doc.uri.fsPath, cellCount: doc.cellCount, dirty: doc.isDirty || false,
                },
            });
        }));
    }
    if (typeof onDidCloseNotebookDocument === 'function') {
        context.subscriptions.push(onDidCloseNotebookDocument(doc => {
            if (doc.notebookType !== NB_TYPE) return;
            _emitToSubs('documents', { type: 'document.closed', docId: _docIdFor(doc.uri) });
        }));
    }
    context.subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(ed => {
        if (ed) _emitToSubs('documents', { type: 'document.focused', docId: _docIdFor(ed.notebook.uri) });
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(ed => {
        if (ed) {
            const k = _kindFor(ed.document.uri);
            if (k !== 'plaintext') _emitToSubs('documents', { type: 'document.focused', docId: _docIdFor(ed.document.uri) });
        }
    }));

    // ── Bridge from in-process eventBus → subscription buffers ─────────────
    // Only emit when at least one subscriber is listening on the channel
    // (the buffers themselves don't care, but this keeps emit() cheap).
    context.subscriptions.push({ dispose: eventBus.on('toolUsage', (ev) => {
        _emitToSubs('toolUsage', {
            type: 'wolfbook_tool_use',
            tool:          ev.tool,
            kind:          _classifyToolKind(ev.tool),
            argsPreview:   _previewArgs(ev.tool, ev.args),
            resultPreview: ev.result || '',
            ok:            ev.ok !== false,
            durationMs:    ev.durationMs || 0,
            ts:            ev.ts || Date.now(),
        });
    })});
    context.subscriptions.push({ dispose: eventBus.on('checkpoint', (ev) => {
        _emitToSubs('checkpoint', {
            type: 'wolfbook_checkpoint',
            docId:        ev.docId,
            kind:         ev.kind,
            summary:      ev.summary,
            detail:       ev.detail,
            relatedCells: ev.relatedCells || [],
            relatedFiles: ev.relatedFiles || [],
            uri:          ev.file,
            ts:           ev.ts || Date.now(),
        });
    })});

    // Kernel-state poller (lightweight)
    let lastKernelState = null;
    const tick = setInterval(() => {
        const ctrl = getController?.();
        if (!ctrl) return;
        const s = ctrl.kernelStatusString === 'resolved'
            ? ((ctrl._evalDispatched || ctrl.executionQueue.queueLength() > 0) ? 'busy' : 'idle')
            : ctrl.kernelStatusString === 'unresolved' ? 'dead' : 'starting';
        if (s !== lastKernelState) {
            lastKernelState = s;
            _emitToSubs('kernel', { type: 'kernel.state', state: s });
        }
    }, 1000);
    context.subscriptions.push({ dispose: () => clearInterval(tick) });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Register the wolfbook.remote.* command surface.
 * Called once from extension.js after `controller` is constructed.
 *
 * @param {vscode.ExtensionContext} context
 * @param {() => any} getController
 * @param {() => Map<string, any>} [getToolMap]
 */
function register(context, getController, getToolMap) {
    _ctx = context;
    _ensureSecret();   // mint on first activation
    _registerEventListeners(context, getController);

    const api = _makeApi(getController, getToolMap);

    const REGISTERED = [
        ['wolfbook.remote.handshake',        api.handshake],
        ['wolfbook.remote.listDocuments',    api.listDocuments],
        ['wolfbook.remote.focusDocument',    api.focusDocument],
        ['wolfbook.remote.getDocumentState', api.getDocumentState],
        ['wolfbook.remote.getCell',          api.getCell],
        ['wolfbook.remote.editCell',         api.editCell],
        ['wolfbook.remote.insertCell',       api.insertCell],
        ['wolfbook.remote.evalCell',         api.evalCell],
        ['wolfbook.remote.abortEval',        api.abortEval],
        ['wolfbook.remote.saveFile',         api.saveFile],
        ['wolfbook.remote.restartKernel',    api.restartKernel],
        ['wolfbook.remote.copilotSubmit',    api.copilotSubmit],
        ['wolfbook.remote.copilotAbort',     api.copilotAbort],
        ['wolfbook.remote.getSlideState',    api.getSlideState],
        ['wolfbook.remote.slideAdvance',     api.slideAdvance],
        ['wolfbook.remote.slideGoto',        api.slideGoto],
        ['wolfbook.remote.subscribe',        api.subscribe],
        ['wolfbook.remote.pull',             api.pull],
        ['wolfbook.remote.unsubscribe',      api.unsubscribe],
        ['wolfbook.remote.scrollToCell',     api.scrollToCell],
        ['wolfbook.remote.deleteCell',        api.deleteCell],
        ['wolfbook.remote.moveCell',          api.moveCell],
        ['wolfbook.remote.changeCellKind',    api.changeCellKind],
    ];
    for (const [name, fn] of REGISTERED) {
        context.subscriptions.push(vscode.commands.registerCommand(name, fn));
    }
}

module.exports = { register };
