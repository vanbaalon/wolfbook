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
const os     = require('os');
const fs     = require('fs');
const { truncateLogs, dynLog, scrollLog, devLog, wstpLog, DEV_MODE, LOG_CHANNELS } = require('../utils/dev-logger');
const _encoding = require('../utils/encoding');
const { clearEvalLog } = require('../tools/index');

// ---------------------------------------------------------------------------
// Orphan-kernel protection: track PIDs in a temp file
//
// On VS Code window reload, deactivate() is called and quitKernel() runs.
// On crash / SIGKILL of the extension host, no cleanup runs — the next
// launchKernel() detects stale PIDs and kills those processes before starting
// a fresh kernel.

const _PID_FILE = path.join(os.tmpdir(), 'wolfbook_kernel_pids.json');

function _savePidFile(pids) {
    try { fs.writeFileSync(_PID_FILE, JSON.stringify(pids)); } catch(_) {}
}
function _loadPidFile() {
    try { return JSON.parse(fs.readFileSync(_PID_FILE, 'utf8')); } catch(_) { return []; }
}
function _clearPidFile() {
    try { fs.unlinkSync(_PID_FILE); } catch(_) {}
}

/** Kill a process by PID. Tries SIGTERM; schedules SIGKILL 1.5s later in case
 *  WolframKernel is stuck inside Dialog[] and ignores SIGTERM. */
function _killPid(pid) {
    try {
        process.kill(pid, 0); // throws if PID doesn't exist
        if (process.platform === 'win32') {
            // On Windows, process.kill is TerminateProcess — immediate.
            process.kill(pid);
        } else {
            process.kill(pid, 'SIGTERM');
            // Belt-and-suspenders: SIGKILL if still alive after 1.5 s
            setTimeout(() => {
                try { process.kill(pid, 'SIGKILL'); } catch(_) {}
            }, 1500);
        }
        devLog(LOG_CHANNELS.KERNEL, '[lifecycle] killed stale kernel PID:', pid);
    } catch(_) { /* process already gone */ }
}

/** Read the PID file, kill every listed process, and delete the file. */
function _killStalePids() {
    const pids = _loadPidFile();
    if (pids.length > 0) {
        scrollLog('[lifecycle] killing stale kernel PIDs from previous session:', pids);
        for (const pid of pids) _killPid(pid);
        _clearPidFile();
    }
}

/** Append a PID to the PID file (called after kernel/subkernel starts). */
function _appendPid(pid) {
    const pids = _loadPidFile();
    if (!pids.includes(pid)) {
        pids.push(pid);
        _savePidFile(pids);
    }
}

// Wrap a WstpSession in a Proxy that records all WSTP method calls to wstp.log.
// Returns the proxy — callers MUST assign the return value.
// Uses a Proxy instead of Object.defineProperty so it works even when the
// underlying native-addon object has non-configurable / non-writable properties.
// The active notebook path is looked up dynamically on each call so it is always
// current even if no notebook was open when the session was created.
function _wstpWrap(sess, label) {
    if (!DEV_MODE) return sess;
    const _METHODS = ['evaluate', 'sub', 'subAuto', 'subWhenIdle'];
    return new Proxy(sess, {
        get(target, prop, receiver) {
            // Important for native addon objects: use the real target as receiver.
            // Using the Proxy as receiver can trigger "Illegal invocation".
            const val = Reflect.get(target, prop, target);
            if (_METHODS.includes(prop) && typeof val === 'function') {
                return async function(expr, ...args) {
                    const _t = Date.now();
                    // Look up active notebook path dynamically — may change between calls
                    let _nbp;
                    try {
                        const _ed = vscode.window.activeNotebookEditor ||
                            vscode.window.visibleNotebookEditors.find(
                                e => e.notebook.notebookType === 'extended-wolfram-notebook'
                            );
                        _nbp = _ed?.notebook.uri?.fsPath;
                    } catch (_) {}
                    wstpLog(_nbp, `→ [${label}.${prop}]  ${String(expr).slice(0, 200)}`);
                    try {
                        const r = await val.call(target, expr, ...args);
                        let _rs;
                        try { _rs = JSON.stringify(r); } catch (_) { _rs = String(r); }
                        wstpLog(_nbp, `← [${label}.${prop}]  ok  ${Date.now()-_t}ms  ${_rs.slice(0, 200)}`);
                        return r;
                    } catch (e) {
                        wstpLog(_nbp, `← [${label}.${prop}]  ERR  ${Date.now()-_t}ms  ${e.message}`);
                        throw e;
                    }
                };
            }
            // Keep native-addon method `this` bound to the real target.
            // Without this, calls like registerDynamic/getDynamicResults can
            // run with `this=Proxy` and silently fail.
            if (typeof val === 'function') return val.bind(target);
            return val;
        }
    });
}

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
// Keepalive heartbeat
//
// Problem: after a long period of inactivity (hours to a day) the WolframKernel
// process can become unresponsive for several reasons:
//   1. macOS App Nap: macOS moves background processes into a low-power "nap"
//      state after ~10 minutes of no user-visible activity; the WolframKernel
//      child process can be suspended entirely, making the WSTP link go silent.
//   2. OS-level socket/pipe buffer drain: an idle full-duplex pipe can be
//      reclaimed by the OS on memory-pressure events.
//   3. WolframKernel memory OOM or crash: the process dies silently; the extension
//      never knows because there is no "onClose" event on the WstpSession.
//
// Fix: a periodic lightweight subWhenIdle('Null') ping keeps the WSTP pipe warm,
// exercises the kernel's main loop (preventing deep suspension), and provides
// real liveness detection.  If the ping fails or isOpen flips to false, the
// extension automatically relaunches the kernel and notifies the user.
//
// Additionally, on macOS we call `caffeinate -i` on the WolframKernel process
// or simply disable App Nap via NSProcessInfo — both are OS-level mechanisms
// that tell macOS "this process should not be suspended".  The approach used
// here is a cross-platform background `subWhenIdle` heartbeat with auto-relaunch.

const _KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000;  // 3 minutes

// Per-controller keepalive timer handle.  Stored on `self` so quitKernel
// can stop it.  We use a plain `setInterval` (not rescheduled setTimeout)
// so VS Code's event loop keeps running without cascading micro-delays.
//
// NOTE: the subWhenIdle ping with a hard timeout was removed because it caused
// false restarts during long-running calculations: if the kernel became briefly
// "idle" between sub-evaluations the ping would queue, then time out 15 s later
// and trigger an unnecessary restart.  The only restart that happens now is when
// session.isOpen flips to false — i.e. the kernel process has actually died.
function _startKeepalive(self, WstpSession) {
    _stopKeepalive(self);  // safety: never double-schedule
    self._keepaliveTimer = setInterval(() => {
        if (!self.session) return;

        // Check isOpen without sending anything.
        // isOpen → false means the kernel process has actually died.
        if (!self.session.isOpen) {
            scrollLog('[keepalive] session.isOpen = false — kernel died, relaunching');
            clearInterval(self._keepaliveTimer);
            self._keepaliveTimer = null;
            vscode.window.showWarningMessage(
                'Wolfram kernel stopped (connection lost). Relaunching…',
                'Dismiss'
            );
            _lifecycle_relaunch(self, WstpSession);
        }
        // No ping sent — avoids any risk of interfering with long evaluations.
    }, _KEEPALIVE_INTERVAL_MS);
}

function _stopKeepalive(self) {
    if (self._keepaliveTimer) {
        clearInterval(self._keepaliveTimer);
        self._keepaliveTimer = null;
    }
}

// Auto-relaunch: close the dead session cleanly then call launchKernel.
// Runs on a microtask so the caller (setInterval callback) can return first.
async function _lifecycle_relaunch(self, WstpSession) {
    // Close the stale session object so its resources are freed
    try { if (self.session) self.session.close(); } catch (_) {}
    self.session = undefined;
    self.kernelStatusString = 'unresolved';
    vscode.commands.executeCommand('setContext', 'wolframKernelActive', false);
    applyKernelOfflineUI(self);
    // Warn the user before relaunching — all kernel variables will be lost
    const choice = await vscode.window.showWarningMessage(
        'The Wolfram kernel has stopped responding and will be restarted. All kernel variables and definitions will be lost.',
        'Restart Now',
        'Cancel'
    );
    if (choice !== 'Restart Now') {
        scrollLog('[lifecycle] Auto-relaunch cancelled by user.');
        return;
    }
    await launchKernel(self, WstpSession);
}



async function launchKernel(self, WstpSession) {
    devLog(LOG_CHANNELS.KERNEL, '[launchKernel] entering (WSTP)');

    // Kill any WolframKernel processes abandoned by a previous VS Code session
    // (crash, SIGKILL of extension host, etc.).
    _killStalePids();

    let kernelInitPath = path.join(self.extensionPath, "resources", "init.wl");
    if (process.platform === "win32") kernelInitPath = kernelInitPath.replace(/\\/g, "/");

    const kernelCommand = self.findKernel.resolveKernel();
    devLog(LOG_CHANNELS.KERNEL, `[launchKernel] kernel path: ${kernelCommand}`);

    if (!WstpSession) {
        vscode.window.showErrorMessage("wstp.node addon not available — cannot launch kernel.");
        return;
    }

    self.kernelStatusString = 'launching';
    applyKernelOfflineUI(self);  // make sure UI stays gray during launch

    try {
        devLog(LOG_CHANNELS.KERNEL, '[launchKernel] creating WstpSession…');
        // Increment epoch so the renderer knows outputs from this point belong
        // to a fresh session.  Broadcast happens after init.wl loads.
        self._sessionEpoch++;
        // Append a kernel restart marker to the persistent AI action log.
        clearEvalLog();
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
                    try {
                        await _clrExec.replaceOutput([]);
                        _clrExec.end(true, Date.now());
                    } catch (_e) {
                        // replaceOutput failed (cell edited/deleted mid-flight) — still end
                        try { _clrExec.end(false, Date.now()); } catch (_) {}
                    }
                } catch (_e) { /* createNotebookCellExecution or start() threw — cell gone */ }
            }
            self._dynCells.clear();
        }
        self._abortPending   = false;
        self._lastMainImgDir = null;
        self._lastMainImgRel = null;
        self._interruptHandlerInstalled = false;
        // Clear per-output registries — Out[N] values don't survive a kernel restart,
        // so any format-switch buttons referencing them must become inert.
        self._outputRegistry.clear();
        self.truncatedOutputCells.clear();
        // Truncate all debug logs on every kernel start so only fresh data is visible.
        truncateLogs();
        if (typeof self.clearDebugLog === 'function') self.clearDebugLog();
        dynLog('=== KERNEL START ===', new Date().toISOString());
        self.session = _wstpWrap(new WstpSession(kernelCommand, { interactive: true }), 'main');

        // Load init.wl via sub() so it runs as a priority batch call and
        // does NOT count as a user evaluation (does not increment $Line).
        // Pass $wolframResourceDir explicitly via Block so sub-files can be
        // located without relying on $InputFileName (which is unreliable when
        // loaded via EvaluatePacket[ToExpression[...]]).
        devLog(LOG_CHANNELS.KERNEL, `[launchKernel] loading init.wl from: ${kernelInitPath}`);
        const _resDir = path.join(self.extensionPath, 'resources');
        const _resDirEsc = _resDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const _initEsc = kernelInitPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const initExpr = await self.session.evaluate(
            `Block[{\$wolframResourceDir="${_resDirEsc}"},Get["${_initEsc}"]]`, { interactive: false }
        );
        devLog(LOG_CHANNELS.KERNEL, `[launchKernel] init.wl loaded, result=${JSON.stringify(initExpr)}`);

        // Push initial config
        const cfg = self.config.getKernelRelatedConfigs();
        for (const [k, v] of Object.entries(cfg)) {
            const vStr = typeof v === "string" ? `"${v}"` : String(v);
            await self.session.evaluate(`$setKernelConfig["${k}", ${vStr}]`, { interactive: false }).catch(() => {});
        }

        // Push extension + addon version strings so WBVersion[] can report them
        {
            const _pkgPath = require('path').join(self.extensionPath, 'package.json');
            let _extVer = 'unknown';
            try { _extVer = require(_pkgPath).version; } catch (_) {}

            // Read BTL version from the already-loaded addon (if available)
            let _btlVer = 'unknown', _btlDate = 'unknown';
            try {
                const _btlAddonPath = require('path').join(self.extensionPath, 'wllatex-addon', 'wolfbook_btl.node');
                const _btlAddon = require(_btlAddonPath);
                if (typeof _btlAddon.version === 'string')   _btlVer  = _btlAddon.version;
                if (typeof _btlAddon.buildDate === 'string') _btlDate = _btlAddon.buildDate;
            } catch (_) {}

            // Read WSTP addon version (already loaded as WstpSession's parent module)
            let _wstpVer = 'unknown', _wstpDate = 'unknown';
            try {
                const _wstpFs   = require('fs');
                const _wstpPath = require('path');
                const _wstpPlat = process.platform, _wstpArch = process.arch;
                const _wstpDir  = _wstpPath.join(self.extensionPath, 'wstp');
                const _wstpPre  = _wstpPath.join(_wstpDir, 'prebuilt', `wstp-${_wstpPlat}-${_wstpArch}.node`);
                const _wstpFb   = _wstpPath.join(_wstpDir, 'build', 'Release', 'wstp.node');
                const _wstpAddon = require(_wstpFs.existsSync(_wstpPre) ? _wstpPre : _wstpFb);
                if (typeof _wstpAddon.version === 'string')   _wstpVer  = _wstpAddon.version;
                if (typeof _wstpAddon.buildDate === 'string') _wstpDate = _wstpAddon.buildDate;
            } catch (_) {}

            // Extension install date from package.json mtime
            let _extDate = 'unknown';
            try { _extDate = new Date(require('fs').statSync(_pkgPath).mtimeMs).toISOString().slice(0, 10); } catch (_) {}

            await self.session.evaluate(`$setKernelConfig["wolfbookVersion",      "${_extVer}"]`, { interactive: false }).catch(() => {});
            await self.session.evaluate(`$setKernelConfig["wolfbookBuildDate",    "${_extDate}"]`, { interactive: false }).catch(() => {});
            await self.session.evaluate(`$setKernelConfig["wolfbookBtlVersion",   "${_btlVer}"]`, { interactive: false }).catch(() => {});
            await self.session.evaluate(`$setKernelConfig["wolfbookBtlBuildDate", "${_btlDate}"]`, { interactive: false }).catch(() => {});
            await self.session.evaluate(`$setKernelConfig["wolfbookWstpVersion",  "${_wstpVer}"]`, { interactive: false }).catch(() => {});
            await self.session.evaluate(`$setKernelConfig["wolfbookWstpBuildDate","${_wstpDate}"]`, { interactive: false }).catch(() => {});
        }

        // Set $PageWidth so Print[] / OutputForm wraps at the configured width
        // instead of the default 78 characters.  Two times the default (156)
        // avoids most wrapping while keeping ASCII-art power notation readable.
        const printPageWidth = self.config.get("notebook.print.pageWidth") ?? 156;
        // Update $PageWidth so the Print[] override in init.wl picks up the
        // user-configured value (init.wl sets the default of 156 at launch;
        // this call overrides it with whatever the workspace setting says).
        await self.session.evaluate(`Unprotect[System\`$PageWidth]; System\`$PageWidth = ${printPageWidth}; Protect[System\`$PageWidth]`, { interactive: false }).catch(() => {});

        // Set NotebookDirectory[] / WBDirectory[] to the directory of the active wolfram
        // notebook so that Get["relative/path"] and friends work as expected.
        // Prefer activeNotebookEditor; fall back to first visible wolfram notebook.
        const _wolframNbEditor =
            (vscode.window.activeNotebookEditor?.notebook?.notebookType === 'extended-wolfram-notebook'
                ? vscode.window.activeNotebookEditor
                : null) ||
            vscode.window.visibleNotebookEditors.find(
                ed => ed.notebook.notebookType === 'extended-wolfram-notebook'
            );
        if (_wolframNbEditor) {
            let _nbDir = path.dirname(_wolframNbEditor.notebook.uri.fsPath);
            if (process.platform === 'win32') _nbDir = _nbDir.replace(/\\/g, '/');
            const _nbDirEsc = _nbDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            await self.session.evaluate(
                `Unprotect[NotebookDirectory, WBDirectory]; NotebookDirectory[] = "${_nbDirEsc}"; Protect[NotebookDirectory]; WBDirectory[] = "${_nbDirEsc}"; Protect[WBDirectory]`, { interactive: false }
            ).catch(() => {});
            devLog(LOG_CHANNELS.KERNEL, '[launchKernel] NotebookDirectory set to:', _nbDir);
        }

        // Note: the interrupt → Dialog[] handler is installed by init.wl
        // (Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]).
        // No separate evaluate() call needed here — that would waste a $Line slot
        // (making the user's first cell show In[2] instead of In[1]) and could
        // double-register the handler (two Dialog[] calls per interrupt).

        self.kernelStatusString = "resolved";
        vscode.commands.executeCommand("setContext", "wolframKernelActive", true);
        vscode.window.showInformationMessage("Wolfram kernel launched (WSTP), ready for evaluation.");
        devLog(LOG_CHANNELS.KERNEL, '[launchKernel] kernel ready');

        // Track PID so we can kill the process if VS Code crashes before quitKernel()
        try {
            const _pidExpr = await self.session.evaluate('$ProcessID', { interactive: false });
            if (_pidExpr?.type === 'integer' && typeof _pidExpr.value === 'number') {
                _appendPid(_pidExpr.value);
                scrollLog('[launchKernel] kernel PID registered:', _pidExpr.value);

                // macOS App Nap prevention: launch `caffeinate -w <pid>` as a companion
                // process.  caffeinate holds a "user-activity assertion" tied to the
                // WolframKernel PID; macOS will not put the kernel into low-power
                // nap mode for as long as caffeinate is alive.  The companion process
                // exits automatically if WolframKernel dies (the -w flag waits for the
                // target PID).  It is also tracked so quitKernel() can kill it.
                if (process.platform === 'darwin') {
                    try {
                        const _cp = require('child_process');
                        const _caffPid = _pidExpr.value;
                        if (self._caffeinateProc) {
                            try { self._caffeinateProc.kill(); } catch (_) {}
                        }
                        self._caffeinateProc = _cp.spawn(
                            'caffeinate', ['-i', '-w', String(_caffPid)],
                            { detached: false, stdio: 'ignore' }
                        );
                        self._caffeinateProc.on('error', () => {}); // ignore ENOENT
                        scrollLog('[launchKernel] caffeinate -i -w', _caffPid, 'started (App Nap disabled)');
                    } catch (_) {
                        scrollLog('[launchKernel] caffeinate spawn failed (non-fatal)');
                    }
                }
            }
        } catch(_) {}

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

        // Start keepalive heartbeat: pings kernel every 3 minutes via subWhenIdle.
        // Prevents macOS App Nap suspension; auto-relaunches if the kernel dies.
        _startKeepalive(self, WstpSession);
        scrollLog('[launchKernel] keepalive started (interval:', _KEEPALIVE_INTERVAL_MS / 1000, 's)');
    } catch (err) {
        console.error(`[launchKernel] error: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to launch Wolfram kernel: ${err.message}`);
        self.kernelStatusString = "unresolved";
        applyKernelOfflineUI(self);
    }
}

// ---------------------------------------------------------------------------
// (sub-process subkernel removed — rendering runs on main kernel via subAuto)

function prewarmSubKernel(self, WstpSession) { /* no-op: subkernel removed */ }

async function ensureSubKernel(self, WstpSession, imgDir, imgRel) { throw new Error('subkernel removed'); }

// ---------------------------------------------------------------------------
// Kernel shutdown

function quitKernel(self) {
    devLog(LOG_CHANNELS.KERNEL, '[quitKernel] closing session');
    // Stop keepalive heartbeat before closing the session so no ping fires
    // after close() and triggers a spurious relaunch.
    _stopKeepalive(self);
    // Kill caffeinate companion (macOS App Nap guard) — it would exit on its own
    // when WolframKernel dies, but it's cleaner to kill it explicitly here.
    if (self._caffeinateProc) {
        try { self._caffeinateProc.kill(); } catch (_) {}
        self._caffeinateProc = null;
    }
    if (self.session) {
        try { self.session.close(); } catch (_) {}
        self.session = undefined;
    }
    self._lastMainImgDir = null;
    self._lastMainImgRel = null;
    self._interruptHandlerInstalled = false;
    // Clean exit — remove the PID file so the next launch doesn't try to kill
    // processes that are already gone.
    _clearPidFile();
    self.kernelStatusString = "unresolved";
    vscode.commands.executeCommand("setContext", "wolframKernelActive", false);
    applyKernelOfflineUI(self);
}

// ---------------------------------------------------------------------------

module.exports = {
    launchKernel,
    quitKernel,
    prewarmSubKernel,
    applyKernelOfflineUI,
    clearKernelOfflineUI,
};
