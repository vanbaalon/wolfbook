'use strict';

const crypto = require('crypto');
const path = require('path');

const BINDINGS_KEY = 'wolfbook.kernelBindings.v1';
const POOL_KEY = 'wolfbook.kernelPool.v1';
const DEFAULT_LABEL_KEY = 'wolfbook.defaultKernelLabel.v1';

function canonicalNotebook(value) {
    const raw = typeof value === 'string' ? value : (value?.uri?.fsPath || value?.fsPath || value?.toString?.() || '');
    if (!raw) return '';
    const normalized = path.normalize(raw).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

class KernelManager {
    constructor(context, options = {}) {
        this.context = context;
        this.experimental = !!options.experimental;
        this.maximum = Math.max(1, Math.min(8, Number(options.maximum) || 3));
        this._factory = options.factory || null;
        this._labelAllocator = options.labelAllocator || null;
        this._labelReleaser = options.labelReleaser || null;
        this._entries = new Map();
        this._bindings = new Map(Object.entries(context?.workspaceState?.get?.(BINDINGS_KEY, {}) || {}));
        this._savedPool = Array.isArray(context?.workspaceState?.get?.(POOL_KEY, []))
            ? context.workspaceState.get(POOL_KEY, []).filter(item => item?.slotKey && item.slotKey !== 'default')
            : [];
        // Pre-slot builds persisted ephemeral k-... capabilities. They cannot
        // safely identify a process after an extension-host reload.
        for (const [notebook, slotKey] of this._bindings) {
            if (String(slotKey).startsWith('k-')) this._bindings.delete(notebook);
        }
        this._nextLabel = 1;
        this._listeners = new Set();
    }

    addDefault(controller) {
        if (this._entries.size) throw new Error('Default kernel already registered');
        const preferredLabel = this.context?.workspaceState?.get?.(DEFAULT_LABEL_KEY, null) || null;
        const entry = this._add(controller, { isDefault: true, slotKey: 'default', label: preferredLabel });
        this.context?.workspaceState?.update?.(DEFAULT_LABEL_KEY, entry.label)?.then?.(() => {}, () => {});
        return entry;
    }

    _add(controller, options = {}) {
        const id = options.id || `k-${crypto.randomBytes(4).toString('hex')}`;
        if (this._entries.has(id)) return this._entries.get(id);
        const label = this._labelAllocator?.(id, options.label) || options.label || `K${this._nextLabel++}`;
        const entry = {
            id, label, controller,
            arbiter: controller.arbiter, operations: controller.operations,
            isDefault: !!options.isDefault, remote: !!options.remote,
            ownerClientId: options.ownerClientId || null, ownerGeneration: options.ownerGeneration || null,
            workerPort: options.workerPort || null, createdAt: Date.now(), executable: null,
            slotKey: options.slotKey || (options.remote ? `remote:${options.ownerClientId || 'unknown'}:${id}` : `slot-${crypto.randomUUID()}`),
        };
        Object.defineProperty(entry, 'metadata', { enumerable: true, get: () => controller.kernelMetadata || null });
        controller.kernelIdentity = { kernel_id: id, label: entry.label, is_default: entry.isDefault };
        if (controller._controller) controller._controller.label = `Wolfram ${entry.label}`;
        this._entries.set(id, entry);
        this._emit();
        return entry;
    }

    get defaultEntry() { return [...this._entries.values()].find(e => e.isDefault) || null; }
    get size() { return this._entries.size; }
    get(id) { return this._entries.get(String(id || '')) || null; }

    bindingFor(notebook) {
        const key = canonicalNotebook(notebook);
        const slotKey = this._bindings.get(key);
        const bound = [...this._entries.values()].find(entry => entry.slotKey === slotKey);
        if (bound) return bound;
        // Existing zero-config behavior: an open notebook without an explicit
        // local binding uses the shared default kernel.
        return this.defaultEntry;
    }

    explicitBindingFor(notebook) {
        const key = canonicalNotebook(notebook);
        const slotKey = this._bindings.get(key);
        return [...this._entries.values()].find(entry => entry.slotKey === slotKey) || null;
    }

    resolve(spec = {}) {
        const notebook = spec.notebook || spec.notebookUri || null;
        const bound = notebook ? this.bindingFor(notebook) : null;
        const asserted = spec.kernel_id || spec.kernelId || null;
        if (spec.requireExplicit && this.size > 1 && !asserted) {
            throw this._kernelChoiceError('kernel_id is required for this kernel-scoped operation because this window has multiple live kernels.', 'KERNEL_ID_REQUIRED');
        }
        if (asserted) {
            const entry = this.get(asserted);
            if (!entry) throw this._kernelChoiceError(`Unknown kernel_id: ${asserted}.`, 'UNKNOWN_KERNEL_ID');
            if (bound && entry.id !== bound.id) {
                const err = new Error(`Kernel target changed: notebook is bound to ${bound.label} (${bound.id}), not ${asserted}.`);
                err.code = 'KERNEL_TARGET_CHANGED'; err.binding = this.describe(bound, notebook);
                throw err;
            }
            return entry;
        }
        if (bound) return bound;
        if (this.size === 1) return this.defaultEntry;
        throw this._kernelChoiceError('kernel_id is required because this window has multiple live kernels.', 'KERNEL_ID_REQUIRED');
    }

    /** Actionable error: names every live kernel so the caller can self-heal in one retry. */
    _kernelChoiceError(message, code) {
        const rows = [...this._entries.values()].map(entry => {
            const status = entry.controller?.arbiter?.status?.(entry.controller);
            const kind = entry.remote
                ? `remote via ${entry.ownerClientId || 'unknown window'}${entry.ownerUnavailable ? ', owner unavailable' : ''}`
                : 'local';
            return `${entry.label} ${entry.id} (${kind}${status?.lifecycle ? `, ${status.lifecycle}` : ''})`;
        });
        const err = new Error(`${message} Kernels in this window: ${rows.join('; ') || '(none)'}. ` +
            'Pass kernel_id="k-…", or notebook="<name>.wb" to resolve by binding.');
        err.code = code;
        err.kernels = this.list();
        return err;
    }

    /** Find the entry whose per-controller OperationRegistry holds this operation id. */
    findEntryByOperation(operationId) {
        const id = String(operationId || '').trim();
        if (!id) return null;
        for (const entry of this._entries.values()) {
            if (entry.operations?.get?.(id)) return entry;
        }
        return null;
    }

    findControllerByOperation(operationId) {
        return this.findEntryByOperation(operationId)?.controller || null;
    }

    resolveController(spec = {}) { return this.resolve(spec).controller; }

    async create(options = {}) {
        if (!this.experimental && !options.restore) throw new Error('Additional kernels require wolfbook.kernels.experimentalIsolation.');
        if (!this._factory) throw new Error('Kernel factory is unavailable.');
        const localCount = [...this._entries.values()].filter(entry => !entry.remote).length;
        if (localCount >= this.maximum) throw new Error(`Kernel limit reached (${this.maximum}).`);
        const controller = await this._factory();
        const entry = this._add(controller, { label: options.label, slotKey: options.slotKey });
        if (options.launch !== false) await controller.launchKernel();
        if (!options.restore) {
            this._savedPool.push({ slotKey: entry.slotKey, label: entry.label });
            await this._persistPool();
        }
        return entry;
    }

    async restore() {
        const restored = [];
        for (const saved of this._savedPool.slice(0, Math.max(0, this.maximum - 1))) {
            if ([...this._entries.values()].some(entry => entry.slotKey === saved.slotKey)) continue;
            restored.push(await this.create({ restore: true, slotKey: saved.slotKey, label: saved.label }));
        }
        return restored;
    }

    addRemote(controller, descriptor) {
        return this._add(controller, {
            id: descriptor.kernel_id, label: descriptor.kernel_label, remote: true,
            ownerClientId: descriptor.clientId, ownerGeneration: descriptor.generation,
            workerPort: descriptor.workerPort,
            slotKey: `remote:${descriptor.clientId || 'unknown'}:${descriptor.kernel_slot || descriptor.kernel_id}`,
        });
    }

    removeRemote(kernelId) {
        const entry = this.get(kernelId);
        if (!entry?.remote) return false;
        entry.controller?.dispose?.();
        this._entries.delete(entry.id);
        for (const [key, slotKey] of this._bindings) if (slotKey === entry.slotKey) this._bindings.delete(key);
        this._persist().catch(() => {}); this._emit(); return true;
    }

    async bind(notebook, kernelId) {
        const key = canonicalNotebook(notebook);
        if (!key) throw new Error('Notebook is required.');
        const destination = this.get(kernelId);
        if (!destination) throw new Error(`Unknown kernel_id: ${kernelId}`);
        const source = this.bindingFor(key);
        if (source?.controller?.arbiter?.status(source.controller)?.busy ||
            destination.controller?.arbiter?.status(destination.controller)?.busy) {
            throw new Error('Cannot rebind while the source or destination kernel is busy; abort first.');
        }
        this._bindings.set(key, destination.slotKey);
        await this._persist();
        this._emit();
        return this.describe(destination, key);
    }

    async unbind(notebook) {
        this._bindings.delete(canonicalNotebook(notebook));
        await this._persist();
        this._emit();
        return this.describe(this.defaultEntry, notebook);
    }

    async stop(kernelId) {
        const entry = this.get(kernelId);
        if (!entry) throw new Error(`Unknown kernel_id: ${kernelId}`);
        if (entry.remote) { this.removeRemote(entry.id); return; }
        if (entry.isDefault) throw new Error('The default kernel cannot be removed; restart or stop it instead.');
        if (entry.controller?.arbiter?.status(entry.controller)?.busy) throw new Error('Cannot stop a busy kernel; abort first.');
        await entry.controller?.quitKernel?.();
        entry.controller?.dispose?.();
        this._entries.delete(entry.id);
        this._labelReleaser?.(entry.id);
        for (const [key, slotKey] of this._bindings) if (slotKey === entry.slotKey) this._bindings.delete(key);
        this._savedPool = this._savedPool.filter(saved => saved.slotKey !== entry.slotKey);
        await this._persist();
        await this._persistPool();
        this._emit();
    }

    rename(kernelId, label) {
        const entry = this.get(kernelId);
        if (!entry) throw new Error(`Unknown kernel_id: ${kernelId}`);
        if (entry.remote) throw new Error('Rename this kernel in its owning VS Code window.');
        const clean = String(label || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!clean) throw new Error('Kernel label cannot be empty.');
        entry.label = clean;
        const saved = this._savedPool.find(item => item.slotKey === entry.slotKey);
        if (saved) { saved.label = clean; this._persistPool().catch(() => {}); }
        entry.controller.kernelIdentity.label = clean;
        if (entry.controller._controller) entry.controller._controller.label = `Wolfram ${clean}`;
        this._emit();
        return this.describe(entry);
    }

    describe(entry, notebook = null) {
        if (!entry) return { kernel_id: null, kernel_label: null, lifecycle: 'unbound' };
        const status = entry.controller?.arbiter?.status(entry.controller) || {};
        const metadata = entry.controller?.kernelMetadata || {};
        return {
            kernel_id: entry.id, kernel_slot: entry.slotKey, kernel_label: entry.label, is_default: entry.isDefault,
            remote: !!entry.remote, owner_client_id: entry.ownerClientId || null,
            owner_generation: entry.ownerGeneration || null, worker_port: entry.workerPort || null,
            lifecycle: status.lifecycle || entry.controller?.kernelStatusString || 'offline',
            busy: !!status.busy, notebook: notebook ? canonicalNotebook(notebook) : null,
            created_at: new Date(entry.createdAt).toISOString(),
            started_at: metadata.startedAt ? new Date(metadata.startedAt).toISOString() : null,
            process_id: metadata.pid || null,
            wolfram_version: metadata.wolframVersion || null,
            executable: metadata.executable || null,
            active_operation: status.activeOperation || null,
        };
    }

    list(notebooks = []) {
        return [...this._entries.values()].map(entry => ({
            ...this.describe(entry),
            notebooks: notebooks.map(canonicalNotebook).filter(nb => this.bindingFor(nb)?.id === entry.id),
        }));
    }

    annotateNotebook(notebook) { return this.describe(this.bindingFor(notebook), notebook); }
    releaseLabels() { for (const entry of this._entries.values()) this._labelReleaser?.(entry.id); }
    onDidChange(listener) { this._listeners.add(listener); return { dispose: () => this._listeners.delete(listener) }; }
    _emit() { for (const listener of this._listeners) { try { listener(); } catch (_) {} } }
    async _persist() { await this.context?.workspaceState?.update?.(BINDINGS_KEY, Object.fromEntries(this._bindings)); }
    async _persistPool() { await this.context?.workspaceState?.update?.(POOL_KEY, this._savedPool); }
}

module.exports = { KernelManager, canonicalNotebook, BINDINGS_KEY, POOL_KEY, DEFAULT_LABEL_KEY };
