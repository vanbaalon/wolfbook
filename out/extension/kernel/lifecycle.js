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
const _diagnose = require('./diagnose');

// ---------------------------------------------------------------------------
// Host record — ~/.wolfbook/host.json
//
// A durable note of what THIS host resolved, for out-of-process consumers such
// as wolfbook-serve (which drives the same kernel and the same resources/*.wl
// from plain Node, so a browser client can work with no VS Code window open).
//
// Deliberately a plain file, not extension state: it must be readable when
// VS Code is not running, which rules out globalState, and it must outlive a
// clean shutdown, which rules out ~/.wolfbook-mcp-registry.json.
//
// Written on every successful launch, so it self-heals when Wolfram is upgraded
// or the extension is updated. Best-effort throughout: this is a convenience for
// other processes and must never affect the kernel that is starting.

const HOST_RECORD_PATH = path.join(os.homedir(), '.wolfbook', 'host.json');

function writeHostRecord(self) {
    const executable = self.kernelMetadata?.executable;
    if (!executable) return;                     // nothing worth recording yet

    const record = {
        version: 1,
        extensionDir:     self.extensionPath || null,
        resourcesDir:     self.extensionPath ? path.join(self.extensionPath, 'resources') : null,
        kernelExecutable: executable,
        wolframVersion:   self.kernelMetadata?.wolframVersion || null,
        platform:         `${process.platform}-${process.arch}`,
        resolvedAt:       new Date().toISOString(),
    };

    // Rewrite only when something actually changed, so we are not touching the
    // file on every kernel restart.
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(HOST_RECORD_PATH, 'utf8')); } catch (_) {}
    if (existing
        && existing.extensionDir     === record.extensionDir
        && existing.kernelExecutable === record.kernelExecutable
        && existing.wolframVersion   === record.wolframVersion) return;

    fs.mkdirSync(path.dirname(HOST_RECORD_PATH), { recursive: true });
    // Write-then-rename: a reader must never observe a half-written file.
    const tmp = `${HOST_RECORD_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    fs.renameSync(tmp, HOST_RECORD_PATH);
    devLog(LOG_CHANNELS.KERNEL, `[hostRecord] wrote ${HOST_RECORD_PATH}`, record.kernelExecutable);
}

// ---------------------------------------------------------------------------
// Launch-failure diagnostics: figure out WHY the kernel didn't come up
// (not installed? license? WSTP layer?) and show an actionable message.
// The heavy lifting (direct-spawn probe, output classification) lives in
// kernel/diagnose.js; this helper only renders the result.

let _diagChannel = null;   // lazily-created "Wolfbook Kernel Diagnostics" output channel

async function _reportKernelFailure(self, kernelCommand, wstpError, { addonLoaded = true } = {}) {
    let diag;
    try {
        const configCompat = require('../config-compat');
        const customPath = configCompat.getSetting('systemKernel', 'Automatic') !== 'Automatic';
        let discovered = [];
        try { discovered = self.findKernel.discoverKernels(); } catch (_) {}
        diag = await _diagnose.diagnoseKernelLaunch(kernelCommand, {
            wstpError, customPath, discovered, addonLoaded,
        });
    } catch (e) {
        // Diagnostics must never mask the original failure.
        diag = { cause: 'unknown',
                 summary: `Failed to launch Wolfram kernel: ${wstpError || e.message}`,
                 detailLines: [String(e.stack || e)] };
    }
    scrollLog('[kernel-diag]', diag.cause, diag.sub || '', '—', diag.summary);

    if (!_diagChannel) _diagChannel = vscode.window.createOutputChannel('Wolfbook Kernel Diagnostics');
    _diagChannel.appendLine('');
    _diagChannel.appendLine(`═══ Kernel launch failure — cause: ${diag.cause}${diag.sub ? ' / ' + diag.sub : ''} ═══`);
    for (const l of diag.detailLines) _diagChannel.appendLine(l);
    _diagChannel.appendLine(`summary         : ${diag.summary}`);

    const buttons = ['Show Details'];
    const pathIssue = diag.cause === 'not-installed' || diag.cause === 'custom-path-missing';
    if (pathIssue) buttons.push('Open Settings');
    if (diag.cause !== 'not-installed') buttons.push('Retry');

    // Fire-and-forget: launchKernel must not stay pending on user interaction.
    vscode.window.showErrorMessage(`Wolfram kernel: ${diag.summary}`, ...buttons).then(choice => {
        if (choice === 'Show Details') _diagChannel.show(true);
        else if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'wolfbook.systemKernel');
        } else if (choice === 'Retry') {
            vscode.commands.executeCommand('wolfbook.launchKernel');
        }
    });
    return diag;
}

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
// Reap a kernel WE spawned (listen-mode addon only). The addon kills only the
// kernels it launched itself, so without this a restart would leave the old
// kernel alive, holding a licence seat and a stale SharedMemory link.
function _reapExternalKernel(self) {
    const proc = self && self._externalKernelProc;
    if (!proc) return;
    self._externalKernelProc = null;
    try { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM'); } catch (_) {}
}

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
        // Single source of truth: gray/restore EXACTLY the keys applyNotebookSettings
        // writes (notebook-settings.js), so no coloured element (focused/selected/
        // hover cell background, etc.) is left un-grayed while the kernel reloads or
        // only partially restored once it is alive again. Lazily required to avoid any
        // module load-order coupling.
        const { NOTEBOOK_COLOR_KEYS } = require('../notebook-settings');
        const KEYS = NOTEBOOK_COLOR_KEYS;
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
    _reapExternalKernel(self);
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
    self.kernelMetadata = {
        executable: kernelCommand,
        startedAt: Date.now(),
        pid: null,
        wolframVersion: null,
    };
    devLog(LOG_CHANNELS.KERNEL, `[launchKernel] kernel path: ${kernelCommand}`);

    if (!WstpSession) {
        self.kernelStatusString = 'unresolved';
        applyKernelOfflineUI(self);
        await _reportKernelFailure(self, kernelCommand, 'wstp.node addon not available', { addonLoaded: false });
        return;
    }

    // Fail fast with a clear message when no kernel binary exists — don't let
    // the WSTP addon try to launch the literal string "kernel-not-found".
    if (!kernelCommand || kernelCommand === 'kernel-not-found' || !fs.existsSync(kernelCommand)) {
        self.kernelStatusString = 'unresolved';
        applyKernelOfflineUI(self);
        await _reportKernelFailure(self, kernelCommand, null);
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
        // ── Kernel link-up: two addon flavours, detected not assumed ────────
        // The macOS/Windows addon opens the WSTP link with `-linkmode launch`,
        // i.e. it forks the kernel itself, and the constructor is all that is
        // needed. The Linux addon cannot do that: forking inside Electron trips
        // FD-ownership enforcement (SIGTRAP), so it opens a *listen* link and
        // something else must spawn a kernel that connects back to it.
        //
        // Regression this fixes (2.8.4, Linux): the listen-mode session was
        // constructed and then nothing ever spawned a kernel, so every
        // evaluation failed instantly with "Session is closed" while the link
        // sat Idle/Alive with kernelPid=0.
        //
        // Capability detection rather than `process.platform === 'linux'`: the
        // deciding factor is which addon was bundled, and a listen-mode build
        // is the only one that exposes a link name. A launch-mode Linux build
        // (or a future unified addon) therefore keeps working untouched.
        const _rawSession = new WstpSession(kernelCommand, { interactive: true });
        let _listenLink = null;
        try {
            const _n = _rawSession.linkName;
            if (typeof _n === 'string' && _n.length > 0) _listenLink = _n;
        } catch (_) { /* launch-mode addon: no linkName — nothing to do */ }

        if (_listenLink) {
            devLog(LOG_CHANNELS.KERNEL, `[launchKernel] listen-mode addon; WSTP link: ${_listenLink}`);
            const _cpMod = require('child_process');
            const _kernelProc = _cpMod.spawn(kernelCommand, [
                '-wstp',
                '-linkname',     _listenLink,
                '-linkmode',     'connect',
                '-linkprotocol', 'SharedMemory',
            ], { detached: false, stdio: 'ignore' });
            _kernelProc.on('error', (e) => {
                try { scrollLog(`[launchKernel] kernel spawn error: ${e.message}`); } catch (_) {}
            });
            // Remember it so stopKernel/relaunch can reap the process we own.
            // The addon only kills kernels it launched itself.
            self._externalKernelProc = _kernelProc;
            devLog(LOG_CHANNELS.KERNEL, `[launchKernel] kernel spawned pid=${_kernelProc.pid}; connecting…`);
            _rawSession.connect();
        }
        self.session = _wstpWrap(_rawSession, 'main');

        // Load init.wl via sub() so it runs as a priority batch call and
        // does NOT count as a user evaluation (does not increment $Line).
        // Pass $wolframResourceDir explicitly via Block so sub-files can be
        // located without relying on $InputFileName (which is unreliable when
        // loaded via EvaluatePacket[ToExpression[...]]).
        devLog(LOG_CHANNELS.KERNEL, `[launchKernel] loading init.wl from: ${kernelInitPath}`);
        const _resDir = path.join(self.extensionPath, 'resources');
        const _resDirEsc = _resDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const _initEsc = kernelInitPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        // Guard the first WSTP round-trip with a timeout: if the kernel came up
        // half-dead (stalled license-server lookup, waiting on activation, …)
        // this await would otherwise hang forever with the UI stuck on
        // "launching" and no error shown.  On timeout the throw lands in the
        // catch below, which runs the launch-failure diagnostics.
        const _INIT_TIMEOUT_MS = 120000;
        const initExpr = await Promise.race([
            self.session.evaluate(
                `Block[{\$wolframResourceDir="${_resDirEsc}"},Get["${_initEsc}"]]`, { interactive: false }
            ),
            new Promise((_, rej) => setTimeout(() =>
                rej(new Error(`kernel connected but did not respond within ${_INIT_TIMEOUT_MS / 1000} s (init.wl load timed out)`)),
                _INIT_TIMEOUT_MS)),
        ]);
        devLog(LOG_CHANNELS.KERNEL, `[launchKernel] init.wl loaded, result=${JSON.stringify(initExpr)}`);

        // Push initial config
        const cfg = self.config.getKernelRelatedConfigs();
        for (const [k, v] of Object.entries(cfg)) {
            // String(true) is "true" — an ordinary symbol in WL, NOT True, which
            // silently turns every boolean setting false on the kernel side.
            const vStr = typeof v === "string"  ? `"${v}"`
                       : typeof v === "boolean" ? (v ? "True" : "False")
                       : String(v);
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
        // Always define them (even with no notebook open yet — fallback to $HomeDirectory)
        // so that WBDirectory[] never returns unevaluated.  checkout.js updates
        // $WBNotebookDirectory before each cell evaluation, which is picked up
        // dynamically by the := definitions.
        {
            // Determine initial directory: prefer active wolfram notebook, fall back
            // to the first visible wolfram notebook, then to $HomeDirectory.
            const _wolframNbEditor =
                (vscode.window.activeNotebookEditor?.notebook?.notebookType === 'extended-wolfram-notebook'
                    ? vscode.window.activeNotebookEditor
                    : null) ||
                vscode.window.visibleNotebookEditors.find(
                    ed => ed.notebook.notebookType === 'extended-wolfram-notebook'
                );
            let _nbDir;
            if (_wolframNbEditor) {
                _nbDir = path.dirname(_wolframNbEditor.notebook.uri.fsPath);
            } else {
                _nbDir = process.env.HOME || process.env.USERPROFILE || '.';
            }
            if (process.platform === 'win32') _nbDir = _nbDir.replace(/\\/g, '/');
            const _nbDirEsc = _nbDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            // Use a dynamic := definition backed by $WBNotebookDirectory so that
            // switching between notebooks updates the value without a kernel restart.
            // Before each cell executes, checkout.js refreshes $WBNotebookDirectory
            // to the directory of the notebook that owns that cell.
            await self.session.evaluate(
                `Unprotect[NotebookDirectory, WBDirectory, $WBNotebookDirectory]; ` +
                `$WBNotebookDirectory = "${_nbDirEsc}"; ` +
                `NotebookDirectory[] := $WBNotebookDirectory; ` +
                `WBDirectory[]       := $WBNotebookDirectory; ` +
                `WBDirectory::usage  = "WBDirectory[] returns the directory of the currently active Wolfbook notebook. ` +
                `Equivalent to NotebookDirectory[] in the standard Wolfram frontend. ` +
                `The value is updated automatically before each cell evaluation to reflect the notebook currently being run."; ` +
                `Protect[NotebookDirectory, WBDirectory]`, { interactive: false }
            ).catch(() => {});
            devLog(LOG_CHANNELS.KERNEL, '[launchKernel] NotebookDirectory/WBDirectory defined, dir:', _nbDir);
        }

        // Set $PlotTheme based on the current VS Code colour theme so that
        // kernel-generated plots blend with the editor background.
        {
            const _themeKind = vscode.window.activeColorTheme?.kind;
            const _isDarkTheme = _themeKind === 2 || _themeKind === 3;
            const _plotThemeExpr = _isDarkTheme ? '$PlotTheme = "BlackBackground"' : '$PlotTheme = Automatic';
            await self.session.evaluate(_plotThemeExpr, { interactive: false }).catch(() => {});
        }

        // Note: the interrupt → Dialog[] handler is installed by init.wl
        // (Quiet[Internal`AddHandler["Interrupt", Function[{}, Dialog[]]]]).
        // No separate evaluate() call needed here — that would waste a $Line slot
        // (making the user's first cell show In[2] instead of In[1]) and could
        // double-register the handler (two Dialog[] calls per interrupt).

        // kernelStatusString remains "launching" until $ProcessID eval completes below.
        // Do NOT set it to "resolved" here — that would allow user-queued cells to race
        // with the $ProcessID evaluate() call, causing a fatal WSTP concurrency crash.
        vscode.commands.executeCommand("setContext", "wolframKernelActive", true);
        vscode.window.showInformationMessage("Wolfram kernel launched (WSTP), ready for evaluation.");
        devLog(LOG_CHANNELS.KERNEL, '[launchKernel] kernel ready');
        // Notify any registered listener (e.g. watch panel deferred refresh)
        if (typeof self._onKernelReady === 'function') {
            try { self._onKernelReady(); } catch (_) {}
        }

        // Track PID so we can kill the process if VS Code crashes before quitKernel()
        try {
            const _pidExpr = await self.session.evaluate('$ProcessID', { interactive: false });
            if (_pidExpr?.type === 'integer' && typeof _pidExpr.value === 'number') {
                self.kernelMetadata.pid = _pidExpr.value;
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

        try {
            // evaluate() resolves to an EvalResult, whose `.result` is the WExpr —
            // testing `_versionExpr.type` therefore never matched, and every kernel
            // reported wolframVersion: null (visible as "wolfram_version": null in
            // ~/.wolfbook-mcp-registry.json). Accept either shape so this keeps
            // working if the call is ever switched to sub().
            const _versionExpr = await self.session.evaluate('$Version', { interactive: false });
            const _versionW = _versionExpr?.result ?? _versionExpr;
            if (_versionW?.type === 'string') self.kernelMetadata.wolframVersion = _versionW.value;
        } catch (_) {}

        // Record where this host found everything, for out-of-process clients.
        //
        // WHY: headless consumers (wolfbook-serve, and through it the browser
        // clients) need the SAME kernel this extension resolved, and they cannot
        // ask for it — find-kernel.js requires 'vscode', and the MCP registry is
        // live-routing state that removeEntry() deletes on a clean shutdown. So
        // nothing durable survives VS Code exiting.
        //
        // Re-deriving it is not a safe alternative: picking a kernel means
        // ranking installs by VERSION (this machine has 14.1 and 15.0.1 side by
        // side), and a second copy of that logic would silently choose the wrong
        // one. Writing down the answer is cheaper and cannot drift.
        //
        // extensionDir is recorded too: it locates resources/*.wl and the
        // prebuilt N-API addons, which a glob of ~/.vscode/extensions would miss
        // for portable installs, --extensions-dir, Insiders and remote hosts.
        try { writeHostRecord(self); } catch (_) { /* never block kernel launch */ }

        // Only mark kernel as resolved AFTER the $ProcessID eval completes.
        // Setting 'resolved' earlier would allow user-queued cells to race with
        // the $ProcessID evaluate() call, causing a fatal WSTP concurrency crash.
        self.kernelStatusString = "resolved";

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

        // Pre-warm the SVG/graphics renderer.  The first ExportString[…,"SVG"] call
        // initialises Mathematica's internal MathematicaServer (~4 s cold-start).
        // subWhenIdle fires only when the kernel is idle (no user cell executing),
        // so this never races with queued user cells.
        self.session.subWhenIdle('Quiet[ExportString[Graphics[{}],"SVG"]]').catch(() => {});
        scrollLog('[launchKernel] graphics warmup scheduled via subWhenIdle');

        // Pre-warm the graphics OPTION machinery too.  The first AbsoluteOptions
        // call of a session costs ~0.75 s to initialise and ~7 ms thereafter, and
        // the interactive-3D mesh export needs it for PlotRange/Ticks/Lighting.
        // Without this the first 3D output in a session pays the whole 0.75 s.
        self.session.subWhenIdle('Quiet[Wolfbook`Private`wb3dWarmup[]]').catch(() => {});
        self.session.subWhenIdle('Quiet[Wolfbook`Private`wb2dWarmup[]]').catch(() => {});
        scrollLog('[launchKernel] 3D/2D option warmup scheduled via subWhenIdle');

        // Start keepalive heartbeat: pings kernel every 3 minutes via subWhenIdle.
        // Prevents macOS App Nap suspension; auto-relaunches if the kernel dies.
        _startKeepalive(self, WstpSession);
        scrollLog('[launchKernel] keepalive started (interval:', _KEEPALIVE_INTERVAL_MS / 1000, 's)');
    } catch (err) {
        console.error(`[launchKernel] error: ${err.message}`);
        self.kernelStatusString = "unresolved";
        applyKernelOfflineUI(self);
        // Close the half-open session (if any) BEFORE the diagnostic probe:
        // the probe launches a second kernel process, and on single-seat
        // licenses the dead-but-open link could otherwise hold the seat.
        try { if (self.session) { self.session.close(); self.session = undefined; } } catch (_) {}
        _reapExternalKernel(self);
        await _reportKernelFailure(self, kernelCommand, err.message);
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
        _reapExternalKernel(self);
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
