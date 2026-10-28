'use strict';

const crypto = require('crypto');
const path = require('path');
const {AsyncLocalStorage}=require('async_hooks');
const {canonicalPath,assertKernelScope,scopedPath,scopeError}=require('./agentScope');

const BINDINGS_KEY = 'wolfbook.kernelBindings.v1';
const POOL_KEY = 'wolfbook.kernelPool.v1';
const DEFAULT_LABEL_KEY = 'wolfbook.defaultKernelLabel.v1';

function canonicalNotebook(value) {
    const raw = typeof value === 'string' ? value : (value?.uri?.fsPath || value?.fsPath || value?.toString?.() || '');
    if (!raw) return '';
    const normalized = canonicalPath(raw);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

class KernelManager {
    constructor(context, options = {}) {
        this.context = context;
        this.experimental = !!options.experimental;
        this.maximum = Math.max(1, Number(options.maximum) || 3); // recommended pool size
        // Stable pool slot, scoped to this VS Code workspace. Runtime kernel
        // IDs and labels change across reloads/renames and are not preferences.
        this.newNotebookDefaultSlot = String(options.newNotebookDefaultSlot || '');
        this._factory = options.factory || null;
        this._labelAllocator = options.labelAllocator || null;
        this._labelReleaser = options.labelReleaser || null;
        this._labelRenamer = options.labelRenamer || null;
        this._entries = new Map();
        this._bindings = new Map(Object.entries(context?.workspaceState?.get?.(BINDINGS_KEY, {}) || {}).map(([nb,slot])=>[canonicalNotebook(nb),slot]));
        this._savedPool = Array.isArray(context?.workspaceState?.get?.(POOL_KEY, []))
            ? context.workspaceState.get(POOL_KEY, []).filter(item => item?.slotKey && item.slotKey !== 'default')
            : [];
        // Pre-slot builds persisted ephemeral k-... capabilities. They cannot
        // safely identify a process after an extension-host reload.
        for (const [notebook, slotKey] of this._bindings) {
            if (String(slotKey).startsWith('k-')) this._bindings.delete(notebook);
        }
        this._nextLabel = 1;
        this._toolTargets=new AsyncLocalStorage();
        this._allocating=0;
        this._bindingRevisions=new Map();
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
        const label = (options.remote ? options.label : this._labelAllocator?.(id, options.label)) || options.label || `K${this._nextLabel++}`;
        const entry = {
            id, label, controller,
            arbiter: controller.arbiter, operations: controller.operations,
            isDefault: !!options.isDefault, remote: !!options.remote,
            ownerClientId: options.ownerClientId || null, ownerGeneration: options.ownerGeneration || null,
            workerPort: options.workerPort || null, createdAt: Date.now(), executable: null,
            slotKey: options.slotKey || (options.remote ? `remote:${options.ownerClientId || 'unknown'}:${id}` : `slot-${crypto.randomUUID()}`),
            ownerFolder:options.owner_folder ? canonicalPath(options.owner_folder) : null,
            ownerScopeId:options.owner_scope_id || null,sharing:options.sharing || 'shared',
        };
        const storageRoot = this.context?.globalStorageUri?.fsPath;
        if (storageRoot && controller.operations?.setPersistence) {
            const slotHash = crypto.createHash('sha256').update(entry.slotKey).digest('hex').slice(0, 24);
            controller.operations.setPersistence(path.join(storageRoot, 'kernel-operations', `${slotHash}.json`));
        }
        Object.defineProperty(entry, 'metadata', { enumerable: true, get: () => controller.kernelMetadata || null });
        controller.kernelIdentity = { kernel_id: id, label: entry.label, is_default: entry.isDefault };
        if (controller._controller) controller._controller.label = `Wolfram ${entry.label}`;
        this._entries.set(id, entry);
        this._emit();
        return entry;
    }

    get defaultEntry() { return [...this._entries.values()].find(e => e.isDefault) || null; }
    get newNotebookDefaultEntry() {
        return this.newNotebookDefaultSlot
            ? [...this._entries.values()].find(e => e.slotKey === this.newNotebookDefaultSlot) || null : null;
    }
    setNewNotebookDefaultSlot(slot) {
        const next = String(slot || '');
        if (next === this.newNotebookDefaultSlot) return;
        this.newNotebookDefaultSlot = next;
        this._emit();
    }
    hasNotebookBinding(notebook) { return this._bindings.has(canonicalNotebook(notebook)); }
    notebookBindingUnavailable(notebook) {
        return !this.bindingFor(notebook) && (this.hasNotebookBinding(notebook) || !!this.newNotebookDefaultSlot);
    }
    get size() { return this._entries.size; }
    get(id) { return this._entries.get(String(id || '')) || null; }

    bindingFor(notebook) {
        const key = canonicalNotebook(notebook);
        const slotKey = this._bindings.get(key);
        const bound = [...this._entries.values()].find(entry => entry.slotKey === slotKey);
        if (bound) return bound;
        if (slotKey) return null; // a lost/restoring private slot is never K1
        if (this.newNotebookDefaultSlot) return this.newNotebookDefaultEntry;
        // Existing zero-config behavior: an open notebook without an explicit
        // local binding uses the shared default kernel.
        return this.defaultEntry;
    }

    explicitBindingFor(notebook) {
        const key = canonicalNotebook(notebook);
        const slotKey = this._bindings.get(key);
        return [...this._entries.values()].find(entry => entry.slotKey === slotKey) || null;
    }

    toolInput(input = {}) {
        const inherited=this._toolTargets.getStore();
        if(!inherited)return input;
        const base={notebook:inherited.notebook,kernel_id:inherited.kernel_id,_agentScope:inherited._agentScope};
        if(input._kernelOnly && !Object.prototype.hasOwnProperty.call(input,'notebook'))delete base.notebook;
        return {...base,...input};
    }
    withToolInput(input,callback) { return this._toolTargets.run(input,callback); }

    resolve(spec = {}) {
        spec=this.toolInput(spec);
        const notebook = spec.notebook || spec.notebookUri || null;
        const bound = notebook ? this.bindingFor(notebook) : null;
        const asserted = spec.kernel_id || spec.kernelId || null;
        if (notebook && this.notebookBindingUnavailable(notebook))
            throw scopeError('KERNEL_BINDING_UNAVAILABLE','The notebook’s assigned kernel is unavailable or restoring. Select a kernel explicitly; the default was not substituted.');
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
            if (spec._agentScope) {
                if (notebook) scopedPath(spec._agentScope,notebook);
                assertKernelScope(spec._agentScope,entry);
            }
            return entry;
        }
        if (bound) { if(spec._agentScope){scopedPath(spec._agentScope,notebook);assertKernelScope(spec._agentScope,bound);} return bound; }
        if (this.size === 1) return this.defaultEntry || [...this._entries.values()][0];
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
        if (!this._factory) throw new Error('Kernel factory is unavailable.');
        this._allocating++;
        let controller,entry;
        try {
            controller=await this._factory();
            this._allocating--;
            try {entry=this._add(controller,options);} catch(error) {this._allocating++;throw error;}
            controller=null;
            if(options.launch!==false)await entry.controller.launchKernel();
            if(!options.restore){
                this._savedPool.push({slotKey:entry.slotKey,label:entry.label,
                    owner_folder:entry.ownerFolder,owner_scope_id:entry.ownerScopeId,sharing:entry.sharing});
                await this._persistPool();
            }
            return entry;
        } catch(error) {
            if(!entry)this._allocating--;
            if(entry){this._entries.delete(entry.id);this._labelReleaser?.(entry.id);
                if(!options.restore)this._savedPool=this._savedPool.filter(s=>s.slotKey!==entry.slotKey);this._emit();}
            const failed=entry?.controller || controller;
            try{await failed?.quitKernel?.();}catch(_){}finally{try{failed?.dispose?.();}catch(_){}}
            throw error;
        }
    }

    async createAndBind(notebook, options = {}) {
        const entry = await this.create(options);
        try { await this.bind(notebook,entry.id); return entry; }
        catch(error) { try { await this.stop(entry.id); } catch(_) {} throw error; }
    }

    async restore() {
        const restored = [];
        this.restoreErrors=[];
        for (const saved of this._savedPool) {
            if ([...this._entries.values()].some(entry => entry.slotKey === saved.slotKey)) continue;
            try {restored.push(await this.create({...saved,restore:true,launch:false}));}
            catch(error){this.restoreErrors.push({slot:saved.slotKey,message:error.message});}
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
        // Retain unavailable bindings; never send their notebooks to K1.
        this._persist().catch(() => {}); this._emit(); return true;
    }

    async bind(notebook, kernelId) {
        const key = canonicalNotebook(notebook);
        if (!key) throw new Error('Notebook is required.');
        const destination = this.get(kernelId);
        if (!destination) throw new Error(`Unknown kernel_id: ${kernelId}`);
        const implicit = this.bindingFor(key);
        const activeNotebook=implicit?.controller?.arbiter?.status(implicit.controller)?.activeOperation?.notebook;
        const source = this.explicitBindingFor(key) || (activeNotebook && canonicalNotebook(activeNotebook)===key ? implicit : null);
        // Same kernel is not a move, so "busy" is irrelevant. VS Code re-selects a
        // notebook's controller whenever it gets an editor — an in-memory notebook
        // an agent is running cells in, opened as a tab mid-run, landed here and
        // threw "Cannot rebind while … busy" at the user for a no-op.
        if (this.bindingFor(key)?.id === destination.id) {
            if (this._bindings.get(key) !== destination.slotKey) {
                this._bindings.set(key, destination.slotKey);
                await this._persist();
                this._emit();
            }
            return this.describe(destination, key);
        }
        if (source?.controller?.arbiter?.status(source.controller)?.busy ||
            destination.controller?.arbiter?.status(destination.controller)?.busy) {
            throw new Error('Cannot rebind while the source or destination kernel is busy; abort first.');
        }
        const previousSlot=this._bindings.get(key),previousRevision=this._bindingRevisions.get(key) || 0;
        this._bindings.set(key, destination.slotKey);
        this._bindingRevisions.set(key,previousRevision+1);
        try {await this._persist();} catch(error) {
            if(previousSlot)this._bindings.set(key,previousSlot);else this._bindings.delete(key);
            this._bindingRevisions.set(key,previousRevision);throw error;
        }
        this._emit();
        return this.describe(destination, key);
    }

    async unbind(notebook) {
        return this.bind(notebook,this.defaultEntry.id);
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
        // Explicit unbind/reassignment is required after a kernel is removed.
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
        if ([...this._entries.values()].some(other => other.id !== entry.id && other.label.toLowerCase() === clean.toLowerCase())) {
            throw new Error(`Kernel name “${clean}” is already in use.`);
        }
        this._labelRenamer?.(entry.id, clean);
        entry.label = clean;
        if (entry.isDefault) this.context?.workspaceState?.update?.(DEFAULT_LABEL_KEY, clean)?.then?.(() => {}, () => {});
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
        const capacity=this.capacity();
        return {
            kernel_id: entry.id, kernel_slot: entry.slotKey, kernel_label: entry.label, is_default: entry.isDefault,
            is_new_notebook_default: !!this.newNotebookDefaultSlot && entry.slotKey === this.newNotebookDefaultSlot,
            remote: !!entry.remote, owner_client_id: entry.ownerClientId || null,
            owner_folder:entry.ownerFolder,owner_scope_id:entry.ownerScopeId,sharing:entry.sharing,
            ...(capacity.above_recommended ? { capacity_advisory: capacity.recommendation } : {}),
            binding_revision:notebook ? this._bindingRevisions.get(canonicalNotebook(notebook)) || 0 : null,
            owner_generation: entry.ownerGeneration || null, worker_port: entry.workerPort || null,
            lifecycle: status.lifecycle || entry.controller?.kernelStatusString || 'offline',
            controller_selected: notebook ? [...(entry.controller?.selectedNotebooks || [])].some(nb=>canonicalNotebook(nb)===canonicalNotebook(notebook)) : undefined,
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
            bindings:notebooks.filter(nb=>this.bindingFor(nb)?.id===entry.id).map(nb=>this.annotateNotebook(nb)),
        }));
    }

    annotateNotebook(notebook) {
        const entry=this.bindingFor(notebook),key=canonicalNotebook(notebook);
        return {...this.describe(entry,notebook),notebook:key,
            binding_state:entry ? 'bound' : this._bindings.has(key) ? 'unavailable' : 'unbound',
            kernel_slot:entry?.slotKey || this._bindings.get(key) || null};
    }

    capacity() {
        const live = [...this._entries.values()].filter(entry => !entry.remote).length;
        const above = live + this._allocating > this.maximum;
        return { local_kernels: live, starting: this._allocating, recommended: this.maximum,
            hard_limit: null, above_recommended: above,
            ...(above ? { recommendation: `This window exceeds the recommended ${this.maximum} kernels. Prefer reusing a repository kernel; creating another is allowed when its process cost is acknowledged.` } : {}) };
    }

    acceptSelection(notebook,kernelId,{fromKernelId} = {}) {
        const slot=this._bindings.get(canonicalNotebook(notebook)) || this.newNotebookDefaultSlot;
        if (!slot || this.get(kernelId)?.slotKey===slot) return true;
        // A picker may replace the controller actually selected for this
        // notebook. Initial/automatic selection has no such source receipt:
        // it must not overwrite a saved private or unavailable binding.
        return !!this.get(kernelId) && !!fromKernelId &&
            this.bindingFor(notebook)?.id===fromKernelId;
    }

    assertToolScope(name,input) {
        const scope=input?._agentScope;
        if(!scope)return;
        if(input.notebook)scopedPath(scope,input.notebook);
        const management=/^wolfbook_(kernelManager|selectKernel)$/.test(name);
        if(management && ['list','create'].includes(input.action || 'list'))return;
        if(name==='wolfbook_newNotebook')return; // validated before any file write
        const operation=input.operation_id || input.handle;
        let entry=operation ? this.findEntryByOperation(operation) : null;
        if(operation && entry){const op=entry.operations?.get(operation);if(op?.notebook)scopedPath(scope,op.notebook);}
        entry=entry || (input.kernel_id ? this.get(input.kernel_id) : input.notebook ? this.bindingFor(input.notebook) : this.size===1 ? this.defaultEntry || [...this._entries.values()][0] : null);
        if(input.notebook && input.kernel_id && !management && this.bindingFor(input.notebook)?.id!==input.kernel_id)
            throw scopeError('KERNEL_TARGET_CHANGED','The notebook binding changed. Select its current kernel explicitly.');
        if(input.notebook && this.notebookBindingUnavailable(input.notebook) && !management)
            throw scopeError('KERNEL_BINDING_UNAVAILABLE','The assigned kernel is unavailable; it was not replaced by K1.');
        if(/^wolfbook_(runCell|runCells|insertCells|editCell|deleteCell|moveCell|restoreDeletedCells|getNotebookContext|getCellOutput|searchCells)$/.test(name) && !input.notebook)
            throw scopeError('SCOPED_TARGET_REQUIRED','Select or name the notebook to avoid editing an ambiguous target.');
        if(entry)assertKernelScope(scope,entry);
        else if (/^wolfbook_(evaluateExpression|runCell|runCells|insertCells|editCell|deleteCell|moveCell|restoreDeletedCells|getNotebookContext|getCellOutput|searchCells|inspectSymbols|getKernelState|kernelControl|operationStatus|cancelOperation|getResult|debugCell|journal|replay|checkpoint)/.test(name) || /^wolfslide_(insert|run)EvalBlock$/.test(name))
            throw scopeError('SCOPED_TARGET_REQUIRED','Select a notebook or kernel before running this tool. Repository association is a recommendation.');
        if(management && ['default','unbind'].includes(input.action))assertKernelScope(scope,this.defaultEntry);
    }
    reconcileLabels() {
        if (!this._labelAllocator) return;
        let changed = false;
        for (const entry of this._entries.values()) {
            if (entry.remote) continue;
            const label = this._labelAllocator(entry.id, entry.label);
            if (!label || label === entry.label) continue;
            entry.label = label;
            entry.controller.kernelIdentity.label = label;
            if (entry.controller._controller) entry.controller._controller.label = `Wolfram ${label}`;
            if (entry.isDefault) this.context?.workspaceState?.update?.(DEFAULT_LABEL_KEY, label)?.then?.(() => {}, () => {});
            const saved = this._savedPool.find(item => item.slotKey === entry.slotKey);
            if (saved) saved.label = label;
            changed = true;
        }
        if (changed) { this._persistPool().catch(() => {}); this._emit(); }
    }

    releaseLabels() { for (const entry of this._entries.values()) if (!entry.remote) this._labelReleaser?.(entry.id); }
    onDidChange(listener) { this._listeners.add(listener); return { dispose: () => this._listeners.delete(listener) }; }
    _emit() { for (const listener of this._listeners) { try { listener(); } catch (_) {} } }
    async _persist() { await this.context?.workspaceState?.update?.(BINDINGS_KEY, Object.fromEntries(this._bindings)); }
    async _persistPool() { await this.context?.workspaceState?.update?.(POOL_KEY, this._savedPool); }
}

module.exports = { KernelManager, canonicalNotebook, BINDINGS_KEY, POOL_KEY, DEFAULT_LABEL_KEY };
