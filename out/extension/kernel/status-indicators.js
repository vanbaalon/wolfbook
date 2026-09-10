'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

function _canonicalCellId(value) {
    let id = String(value || '');
    const hash = id.lastIndexOf('#');
    if (hash >= 0) id = id.slice(hash + 1);
    try { id = decodeURIComponent(id); } catch (_) {}
    return id.replace(/=+$/, '');
}

function _cellSource(ref) {
    if (!ref?.notebook) return null;
    const wanted = String(ref.notebook).replace(/\\/g, '/').toLowerCase();
    const wantedBase = path.basename(wanted);
    const document = (vscode.workspace.notebookDocuments || []).find(doc => {
        const full = String(doc.uri?.fsPath || '').replace(/\\/g, '/').toLowerCase();
        return full === wanted || path.basename(full) === wantedBase;
    });
    if (!document) return null;
    if (Number.isInteger(ref.cellNumber) && ref.cellNumber >= 1 && ref.cellNumber <= document.cellCount) {
        return document.cellAt(ref.cellNumber - 1).document.getText();
    }
    const wantedId = _canonicalCellId(ref.cellId);
    if (!wantedId) return null;
    for (let i = 0; i < document.cellCount; i++) {
        const cell = document.cellAt(i);
        const id = _canonicalCellId(cell.metadata?.toolId || cell.document.uri?.toString?.());
        if (id === wantedId) return cell.document.getText();
    }
    return null;
}

function _sourceFromArgs(op) {
    let args = null;
    try { args = JSON.parse(op?.argsSummary || ''); } catch (_) {}
    if (!args || typeof args !== 'object') return null;
    if (typeof args.expression === 'string') return args.expression;
    if (typeof args.content === 'string') return args.content;
    if (Array.isArray(args.cells)) {
        const source = args.cells.map(cell => cell?.content ?? cell?.value)
            .filter(value => typeof value === 'string').join('\n\n');
        if (source) return source;
    }
    return _cellSource({
        notebook: args.notebook || op?.notebook,
        cellNumber: args.cellNumber ?? op?.cellNumber,
        cellId: args.cellId || op?.cellId,
    });
}

function lastWolframTask(entry, snapshot = {}) {
    const controller = entry?.controller;
    const recorded = controller?._lastWolframTask || null;
    const active = snapshot.active_operation || snapshot.activeOperation ||
        controller?.arbiter?.status?.(controller)?.activeOperation || null;
    const activeRegistry = active?.operationId ? controller?.operations?.get?.(active.operationId) :
        controller?.operations?.active?.();
    const activeOperationId = active?.operationId || active?.operation_id || null;
    const recordedMatchesActive = recorded && (
        (activeOperationId && recorded.operationId === activeOperationId) ||
        (!activeOperationId && Number(recorded.startedAt || 0) >= Number(active?.startedAt || active?.started_at || 0))
    );
    const activeCell = activeRegistry?.cells?.length
        ? [...activeRegistry.cells].reverse().find(cell => cell.status === 'running') || activeRegistry.cells.at(-1)
        : null;
    const activeSource = (recordedMatchesActive ? recorded.source : null) ||
        activeCell?.source || activeRegistry?.source || _sourceFromArgs(activeRegistry) || active?.sourcePreview ||
        _cellSource({
            notebook: activeCell?.notebook || active?.notebook,
            cellNumber: activeCell?.cellNumber ?? active?.cellNumber ?? active?.cell_number,
            cellId: activeCell?.cellId || active?.cellId || active?.cell_id,
        });
    if (activeSource || active?.caption) {
        return {
            source: activeSource || null,
            caption: active?.caption || activeRegistry?.caption || 'Wolfram evaluation',
            startedAt: active?.startedAt || active?.started_at || activeRegistry?.startedAt || null,
            active: true,
        };
    }

    const order = controller?.operations?._order || [];
    const latestOp = order.length ? controller.operations.get(order[order.length - 1]) : null;
    const completed = snapshot.lastCompleted || controller?.arbiter?.status?.(controller)?.lastCompleted || null;
    const candidates = [
        latestOp && {
            source: latestOp.cells?.at?.(-1)?.source || latestOp.source || _sourceFromArgs(latestOp), caption: latestOp.caption,
            startedAt: latestOp.startedAt || 0, active: false,
        },
        recorded && { ...recorded, active: false },
        completed && {
            source: completed.sourcePreview || null, caption: completed.caption,
            startedAt: completed.startedAt || 0, active: false,
        },
    ].filter(Boolean).sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
    return candidates[0] || { source: null, caption: 'No Wolfram task recorded yet.', startedAt: null, active: false };
}

function _formatStartedAt(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown';
    try { return new Date(timestamp).toLocaleString(); } catch (_) { return 'unknown'; }
}

function _taskDialogDetail(snapshot, task, source) {
    const state = snapshot.lifecycle || (snapshot.busy ? 'busy' : 'unknown');
    const lines = [
        `State: ${state}`,
        `Last task: ${task.caption || 'unknown'}`,
        `Started: ${_formatStartedAt(task.startedAt)}`,
    ];
    const trimmed = source.trim();
    if (trimmed) {
        const limit = 900;
        const snippet = trimmed.slice(0, limit);
        lines.push('', 'Wolfram Language:', snippet + (trimmed.length > limit ? '\n…' : ''));
        if (trimmed.length > limit) {
            lines.push('', `Showing the first ${limit.toLocaleString()} of ${trimmed.length.toLocaleString()} characters.`);
        }
    } else {
        lines.push('', 'No Wolfram Language source was recorded for this task.');
    }
    return lines.join('\n');
}

class KernelStatusIndicators {
    constructor(context, manager, options = {}) {
        this._manager = manager;
        this._options = options;
        this._items = new Map();
        this._disposables = [];
        this._disposables.push(vscode.commands.registerCommand(
            'wolfbook.showKernelActivity', kernelId => this._showKernel(kernelId)
        ));
        if (manager?.onDidChange) this._disposables.push(manager.onDidChange(() => this.refresh()));
        const refreshMs = options.refreshMs === undefined ? 500 : Number(options.refreshMs);
        if (refreshMs > 0) {
            this._timer = setInterval(() => this.refresh(), refreshMs);
            this._disposables.push({ dispose: () => clearInterval(this._timer) });
        }
        this.refresh();
        context?.subscriptions?.push(this);
    }

    _snapshot(entry) {
        return this._options.getSnapshot?.(entry) || this._manager?.describe?.(entry) || {};
    }

    _isLive(entry, snapshot) {
        const lifecycle = snapshot.lifecycle || entry.controller?.arbiter?.status?.(entry.controller)?.lifecycle;
        return !!snapshot.busy || lifecycle === 'busy' || lifecycle === 'aborting' || lifecycle === 'idle' ||
            lifecycle === 'launching' || lifecycle === 'faulted' ||
            (!!entry.controller?.session && entry.controller?.kernelStatusString !== 'unresolved');
    }

    refresh() {
        const entries = [...(this._manager?._entries?.values?.() || [])];
        const liveIds = new Set();
        for (const entry of entries) {
            const snapshot = this._snapshot(entry);
            if (!this._isLive(entry, snapshot)) continue;
            liveIds.add(entry.id);
            let item = this._items.get(entry.id);
            if (!item) {
                item = vscode.window.createStatusBarItem(
                    `wolfbook-kernel-activity-${entry.id}`, vscode.StatusBarAlignment.Right, 102
                );
                item.name = `Wolfram ${entry.label} activity`;
                item.command = {
                    title: `Inspect Wolfram ${entry.label}`,
                    command: 'wolfbook.showKernelActivity',
                    arguments: [entry.id],
                };
                this._items.set(entry.id, item);
            }
            const busy = !!snapshot.busy || ['busy', 'aborting'].includes(snapshot.lifecycle);
            const task = lastWolframTask(entry, snapshot);
            item.text = entry.label;
            item.color = new vscode.ThemeColor(busy ? 'charts.green' : 'descriptionForeground');
            item.accessibilityInformation = {
                label: `Wolfram ${entry.label}, ${busy ? 'in use' : 'not in use'}. Click for kernel controls.`,
                role: 'button',
            };
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`**Wolfram ${entry.label}** — ${busy ? 'in use' : 'not in use'}  \n`);
            tooltip.appendMarkdown(`State: ${snapshot.lifecycle || 'unknown'}  \n`);
            tooltip.appendMarkdown(`Last task: ${task.caption || 'unknown'}  \n`);
            if (task.source) tooltip.appendCodeblock(String(task.source).slice(0, 500), 'wolfram');
            tooltip.appendMarkdown('\nClick to view the full WL task or control this kernel.');
            item.tooltip = tooltip;
            item.show();
        }
        for (const [id, item] of this._items) {
            if (liveIds.has(id)) continue;
            item.dispose();
            this._items.delete(id);
        }
    }

    async _showKernel(kernelId) {
        const entry = this._manager?.get?.(kernelId);
        if (!entry) return vscode.window.showInformationMessage('That Wolfram kernel is no longer active.');
        const snapshot = this._snapshot(entry);
        const busy = !!snapshot.busy || ['busy', 'aborting'].includes(snapshot.lifecycle);
        const task = lastWolframTask(entry, snapshot);
        const source = task.source ? String(task.source) : '';
        const actions = [];
        if (source.trim()) actions.push('View Full WL Code');
        if (busy) actions.push('Abort Task');
        actions.push('Restart Kernel', 'Stop Kernel Completely');
        const picked = await vscode.window.showInformationMessage(
            `Wolfram ${entry.label} is ${busy ? 'in use' : 'idle'}.`,
            { modal: true, detail: _taskDialogDetail(snapshot, task, source) },
            ...actions
        );
        if (!picked) return;
        try {
            if (picked === 'View Full WL Code') {
                await this._openTaskSource(entry, task, source);
                return;
            }
            if (picked === 'Abort Task') await this._options.abort?.(entry, snapshot);
            else if (picked === 'Restart Kernel') {
                const confirmed = await vscode.window.showWarningMessage(
                    `Restart Wolfram ${entry.label}?`,
                    { modal: true, detail: 'All in-memory Wolfram definitions in this kernel will be discarded.' },
                    'Restart Kernel'
                );
                if (confirmed !== 'Restart Kernel') return;
                await this._options.restart?.(entry, snapshot);
            } else if (picked === 'Stop Kernel Completely') {
                const confirmed = await vscode.window.showWarningMessage(
                    `Stop Wolfram ${entry.label} completely?`,
                    { modal: true, detail: 'The Wolfram process will end and its in-memory definitions will be discarded.' },
                    'Stop Kernel Completely'
                );
                if (confirmed !== 'Stop Kernel Completely') return;
                await this._options.stop?.(entry, snapshot);
            }
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Wolfram ${entry.label}: ${error.message || error}`);
        }
    }

    async _openTaskSource(entry, task, source) {
        const safeLabel = String(entry.label || 'kernel').replace(/[^A-Za-z0-9_-]+/g, '-');
        const file = path.join(os.tmpdir(), `wolfbook-${safeLabel}-task-${Date.now()}.wl`);
        fs.writeFileSync(file, source || `(* ${task.caption || 'No Wolfram Language source available.'} *)\n`, 'utf8');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    }

    dispose() {
        for (const disposable of this._disposables.splice(0)) {
            try { disposable.dispose(); } catch (_) {}
        }
        for (const item of this._items.values()) {
            try { item.dispose(); } catch (_) {}
        }
        this._items.clear();
    }
}

function registerKernelStatusIndicators(context, manager, options) {
    return new KernelStatusIndicators(context, manager, options);
}

module.exports = { KernelStatusIndicators, registerKernelStatusIndicators, lastWolframTask };
