"use strict";
/*
 * kernel/lifecycle.js — Wolfbook kernel lifecycle management
 *
 * Extracted from controller.js (Round 2 refactoring).
 * All exported functions take the WolframNotebookKernel instance as `self`
 * so they have full access to controller state without being class methods.
 *
 * Public API:
 *   launchKernel(self, WstpSession)
 *   quitKernel(self)
 *   prewarmSubKernel(self, WstpSession)
 *   ensureSubKernel(self, WstpSession, imgDir, imgRel)
 *   applyKernelOfflineUI(self)
 *   clearKernelOfflineUI(self)
 *
 * Internal helpers (not exported):
 *   _setNotebookCellColorsOffline(self, offline)
 *   _toGrayscaleHex(hex)
 */

const vscode = require('vscode');
const path   = require('path');
const { truncateLogs, dynLog, scrollLog } = require('../utils/dev-logger');
const _encoding = require('../utils/encoding');

// ---------------------------------------------------------------------------
// Offline UI — desaturate notebook cell backgrounds while kernel is down

function applyKernelOfflineUI(self) {
    try { self._rendererMessaging.postMessage({ type: 'kernel-offline' }); } catch (_) {}
    _setNotebookCellColorsOffline(self, true);
}

function clearKernelOfflineUI(self) {
    try { self._rendererMessaging.postMessage({ type: 'kernel-online' }); } catch (_) {}
    _setNotebookCellColorsOffline(self, false);
}

// Desaturate / restore notebook cell background colours when the kernel goes offline.
// The cell editor colours live in workbench.colorCustomizations — we cache the originals
// and replace them with luminance-equivalent grays while offline.
function _setNotebookCellColorsOffline(self, offline) {
    try {
        const config = vscode.workspace.getConfiguration('workbench');
        const currentColors = config.get('colorCustomizations') || {};
        const KEYS = [
            'notebook.cellEditorBackground',
            'notebook.editorBackground',
            'notebook.cellBorderColor',
            'notebook.inactiveFocusedCellBorder',
            'notebook.collapsedCellBackground'
        ];
        const hasAny = KEYS.some(k => currentColors[k]);
        if (!hasAny) return;
        if (offline) {
            if (self._notebookColorCache) {
                // Cache was loaded from globalState on reload (constructor path).
                // The workspace may still show original colours if the previous
                // session crashed before quitKernel() wrote the gray values.
                // Derive gray from the cached originals and force-write to workspace.
                const updatedColors = { ...currentColors };
                let anyDirty = false;
                for (const k of KEYS) {
                    const orig = self._notebookColorCache[k];
                    if (orig) {
                        const gray = _toGrayscaleHex(orig);
                        if (currentColors[k] !== gray) { updatedColors[k] = gray; anyDirty = true; }
                    }
                }
                if (anyDirty) config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace).catch(() => {});
                return;
            }
            // First time going offline this session — build cache from current colours.
            self._notebookColorCache = {};
            const updatedColors = { ...currentColors };
            for (const k of KEYS) {
                if (currentColors[k]) {
                    self._notebookColorCache[k] = currentColors[k];
                    updatedColors[k] = _toGrayscaleHex(currentColors[k]);
                }
            }
            // Persist cache to globalState so it survives a VS Code window reload
            // while the kernel is offline (otherwise original colors are lost on reload).
            if (self._extContext) {
                self._extContext.globalState.update('wolfbook.notebookColorCache', self._notebookColorCache).catch(() => {});
            }
            config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace).catch(() => {});
        } else {
            // Restore from cache
            if (!self._notebookColorCache) return;
            const updatedColors = { ...currentColors };
            for (const k of KEYS) {
                if (self._notebookColorCache[k]) updatedColors[k] = self._notebookColorCache[k];
            }
            self._notebookColorCache = null;
            // Clear the persisted cache now that colors are restored.
            if (self._extContext) {
                self._extContext.globalState.update('wolfbook.notebookColorCache', null).catch(() => {});
            }
            config.update('colorCustomizations', updatedColors, vscode.ConfigurationTarget.Workspace).catch(() => {});
        }
    } catch (_) {}
}

// Luminance-preserving hex→gray conversion (e.g. "#F0FFF0" → "#FAFAFA")
function _toGrayscaleHex(hex) {
    try {
        const num = parseInt(hex.replace('#', ''), 16);
        const r = (num >> 16) & 0xFF, g = (num >> 8) & 0xFF, b = num & 0xFF;
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        return '#' + ((1 << 24) | (gray << 16) | (gray << 8) | gray).toString(16).slice(1);
    } catch (_) { return hex; }
}

// ---------------------------------------------------------------------------
// Main kernel launch

async function launchKernel(self, WstpSession) {
    console.log('[launchKernel] entering (WSTP)');

    let kernelInitPath = path.join(self.extensionPath, "resources", "init.wl");
    if (process.platform === "win32") kernelInitPath = kernelInitPath.replace(/\\/g, "/");

    const kernelCommand = self.findKernel.resolveKernel();
    console.log(`[launchKernel] kernel path: ${kernelCommand}`);

    if (!WstpSession) {
        vscode.window.showErrorMessage("wstp.node addon not available — cannot launch kernel.");
        return;
    }

    self.kernelStatusString = 'launching';
    applyKernelOfflineUI(self);  // make sure UI stays gray during launch

    try {
        console.log('[launchKernel] creating WstpSession…');
        // Increment epoch so the renderer knows outputs from this point belong
        // to a fresh session.  Broadcast happens after init.wl loads.
        self._sessionEpoch++;
        // Stop all running Dynamic widgets — they belong to the old session.
        if (self._dynamicWidgets) {
            for (const state of self._dynamicWidgets.values()) state.active = false;
            self._dynamicWidgets.clear();
        }
        // Clear Dynamic widget outputs from all cells so stale content disappears.
        if (self._dynCells) {
            for (const { cell: _dc } of self._dynCells.values()) {
                try {
                    const _clrExec = self._controller.createNotebookCellExecution(_dc);
                    _clrExec.start(Date.now());
                    await _clrExec.replaceOutput([]);
                    _clrExec.end(true, Date.now());
                } catch (_e) { /* cell may already be gone */ }
            }
            self._dynCells.clear();
        }
        // Reset dialog mutex so new widgets start on a clean chain.
        self._dynDialogMutex = Promise.resolve();
        self._dynIdleMutex   = Promise.resolve();
        self._abortPending   = false;
        self._renderingActive = false;
        // Clear per-output registries — Out[N] values don't survive a kernel restart,
        // so any format-switch buttons referencing them must become inert.
        self._outputRegistry.clear();
        self.truncatedOutputCells.clear();
        // Truncate both debug logs on every kernel start so only fresh data is visible.
        truncateLogs();
        dynLog('=== KERNEL START ===', new Date().toISOString());
        self.session = new WstpSession(kernelCommand, { interactive: true });

        // Load init.wl via sub() so it runs as a priority batch call and
        // does NOT count as a user evaluation (does not increment $Line).
        // Pass $wolframResourceDir explicitly via Block so sub-files can be
        // located without relying on $InputFileName (which is unreliable when
        // loaded via EvaluatePacket[ToExpression[...]]).
        console.log(`[launchKernel] loading init.wl from: ${kernelInitPath}`);
        const _resDir = path.join(self.extensionPath, 'resources');
        const _resDirEsc = _resDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const _initEsc = kernelInitPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const initExpr = await self.session.sub(
            `Block[{\$wolframResourceDir="${_resDirEsc}"},Get["${_initEsc}"]]`
        );
        console.log(`[launchKernel] init.wl loaded, result=${JSON.stringify(initExpr)}`);

        // Push initial config
        const cfg = self.config.getKernelRelatedConfigs();
        for (const [k, v] of Object.entries(cfg)) {
            const vStr = typeof v === "string" ? `"${v}"` : String(v);
            await self.session.sub(`$setKernelConfig["${k}", ${vStr}]`).catch(() => {});
        }

        // Set $PageWidth so Print[] / OutputForm wraps at the configured width
        // instead of the default 78 characters.  Two times the default (156)
        // avoids most wrapping while keeping ASCII-art power notation readable.
        const printPageWidth = self.config.get("notebook.print.pageWidth") ?? 156;
        // Update $PageWidth so the Print[] override in init.wl picks up the
        // user-configured value (init.wl sets the default of 156 at launch;
        // this call overrides it with whatever the workspace setting says).
        await self.session.sub(`$PageWidth = ${printPageWidth}`).catch(() => {});

        // Set NotebookDirectory[] to the directory of the currently active wolfram
        // notebook so that Get["relative/path"] and friends work as expected.
        const _wolframNbEditor = vscode.window.visibleNotebookEditors.find(
            ed => ed.notebook.notebookType === 'extended-wolfram-notebook'
        );
        if (_wolframNbEditor) {
            let _nbDir = path.dirname(_wolframNbEditor.notebook.uri.fsPath);
            if (process.platform === 'win32') _nbDir = _nbDir.replace(/\\/g, '/');
            const _nbDirEsc = _nbDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            await self.session.sub(
                `Unprotect[NotebookDirectory]; NotebookDirectory[] = "${_nbDirEsc}"; Protect[NotebookDirectory]`
            ).catch(() => {});
            console.log('[launchKernel] NotebookDirectory set to:', _nbDir);
        }

        // Note: the interrupt → Dialog[] handler is installed by init.wl
        // (Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]).
        // No separate evaluate() call needed here — that would waste a $Line slot
        // (making the user's first cell show In[2] instead of In[1]) and could
        // double-register the handler (two Dialog[] calls per interrupt).

        self.kernelStatusString = "resolved";
        vscode.commands.executeCommand("setContext", "wolframKernelActive", true);
        vscode.window.showInformationMessage("Wolfram kernel launched (WSTP), ready for evaluation.");
        console.log('[launchKernel] kernel ready');
        clearKernelOfflineUI(self);
        // Notify renderer that a new session started — it will remove stale
        // Out[N]= labels and expand banners tagged with the old epoch.
        try {
            self._rendererMessaging.postMessage({ type: 'session-changed', epoch: self._sessionEpoch });
        } catch (_) {}
        // Process any cells that were queued while the kernel was launching
        // (e.g. via preVisualStart before the kernel was ready).
        // .then() callers also invoke checkoutExecutionQueue, but calling it
        // here as well ensures no cell is missed if the caller forgets,
        // and the extra call is always safe (returns immediately if queue[0]
        // is already 'started').
        scrollLog('[launchKernel] resolved — calling checkoutExecutionQueue | queue:', self.executionQueue.queueLength());
        self.checkoutExecutionQueue();
    } catch (err) {
        console.error(`[launchKernel] error: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to launch Wolfram kernel: ${err.message}`);
        self.kernelStatusString = "unresolved";
        applyKernelOfflineUI(self);
    }
}

// ---------------------------------------------------------------------------
// Sub-kernel (used for Dynamic widget SVG rendering in a separate process)

// _prewarmSubKernel — fire-and-forget: start the subkernel and load init.wl
// as soon as the first Dynamic widget is registered, so the first real render
// doesn't pay the cold-start penalty (~1–2 s for a new WstpSession + init.wl).
// ensureSubKernel() will reuse _subKernelInitPromise and just set imgDir.
function prewarmSubKernel(self, WstpSession) {
    if (self._subKernel && self._subKernelReady)  return; // already warm
    if (self._subKernelInitPromise)               return; // already warming
    if (!WstpSession)                             return; // addon unavailable
    const kernelCommand    = self.findKernel.resolveKernel();
    let kernelInitPath     = path.join(self.extensionPath, 'resources', 'init.wl');
    if (process.platform === 'win32') kernelInitPath = kernelInitPath.replace(/\\/g, '/');
    const _initEscaped = kernelInitPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const _resDirEscPre = path.join(self.extensionPath, 'resources').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    console.log('[subKernel] prewarming…');
    self._subKernelInitPromise = (async () => {
        self._subKernel = new WstpSession(kernelCommand, { interactive: false });
        await self._subKernel.sub('Block[{$wolframResourceDir="' + _resDirEscPre + '"},Get["' + _initEscaped + '"]]');
        self._subKernelReady = true;
        console.log('[subKernel] prewarm complete (ready for imgDir)');
    })().catch(e => {
        console.warn('[subKernel] prewarm failed:', e.message);
        self._subKernelInitPromise = null;
        self._subKernel = null;
        self._subKernelReady = false;
    });
}

// ensureSubKernel — lazily boot a second kernel for subsession rendering.
// - Loads the same init.wl so VsCodeRenderExpr is available.
// - Updates VsCodeSetImgDir on every call so SVG files land in the right place.
// - If prewarmSubKernel() already ran, this only sets imgDir (fast path).
async function ensureSubKernel(self, WstpSession, imgDir, imgRel) {
    const _setImgDir = 'VsCodeSetImgDir["' + _encoding.escapeWL(imgDir) + '", "' + _encoding.escapeWL(imgRel) + '"]';
    if (self._subKernel && self._subKernelReady) {
        try { await self._subKernel.sub(_setImgDir); } catch (_) {}
        return self._subKernel;
    }
    if (self._subKernelInitPromise) {
        await self._subKernelInitPromise;
        if (self._subKernel && self._subKernelReady) {
            try { await self._subKernel.sub(_setImgDir); } catch (_) {}
            return self._subKernel;
        }
    }
    self._subKernelInitPromise = (async () => {
        if (!WstpSession) throw new Error('wstp.node addon not available — cannot start subkernel');
        const kernelCommand = self.findKernel.resolveKernel();
        let kernelInitPath = path.join(self.extensionPath, 'resources', 'init.wl');
        if (process.platform === 'win32') kernelInitPath = kernelInitPath.replace(/\\/g, '/');
        const _initEscaped = kernelInitPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const _resDirEscEns = path.join(self.extensionPath, 'resources').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        console.log('[subKernel] launching…');
        self._subKernel = new WstpSession(kernelCommand, { interactive: false });
        await self._subKernel.sub('Block[{$wolframResourceDir="' + _resDirEscEns + '"},Get["' + _initEscaped + '"]]');
        await self._subKernel.sub(_setImgDir);
        self._subKernelReady = true;
        console.log('[subKernel] ready');
    })();
    await self._subKernelInitPromise;
    return self._subKernel;
}

// ---------------------------------------------------------------------------
// Kernel shutdown

function quitKernel(self) {
    console.log('[quitKernel] closing session');
    // Close subkernel first (it has no queue to drain).
    if (self._subKernel) {
        try { self._subKernel.close(); } catch (_) {}
        self._subKernel = null;
        self._subKernelReady = false;
        self._subKernelInitPromise = null;
    }
    if (self.session) {
        try { self.session.close(); } catch (_) {}
        self.session = undefined;
    }
    self.kernelStatusString = "unresolved";
    vscode.commands.executeCommand("setContext", "wolframKernelActive", false);
    applyKernelOfflineUI(self);
}

// ---------------------------------------------------------------------------

module.exports = {
    launchKernel,
    quitKernel,
    prewarmSubKernel,
    ensureSubKernel,
    applyKernelOfflineUI,
    clearKernelOfflineUI,
};
