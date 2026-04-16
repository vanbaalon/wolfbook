"use strict";
/*
 * utils/dev-logger.js — Wolfbook developer diagnostics
 *
 * Provides DEV_MODE flag, scrollLog(), dynLog() and _hexDump() helpers.
 * All output is suppressed on non-dev machines (detection by OS username)
 * so no log noise reaches end-user installs.
 *
 * On dev machines, individual log channels can be toggled via the
 * Notebook Settings → Developer Logs submenu.
 *
 * This module has NO dependency on vscode APIs or other extension modules.
 */

// Detect developer machine by OS username.  Constant — evaluated once at load.
const DEV_MODE = (() => {
    try {
        const _u = require('os').userInfo().username;
        return _u === 'k0959535' || _u === 'nikolay';
    } catch (_) { return false; }
})();

// ── Log channels (bitmask) ────────────────────────────────────────────────────
// Channel IDs — exported so settings UI can reference them by name.
const LOG_CHANNELS = {
    SCROLL:    0x01,   // [scroll] / [live-watch] — watch panel & eval scroll
    DYNAMICS:  0x02,   // [dyn-dbg] — Dynamic[] rendering
    KERNEL:    0x04,   // [launchKernel] / [lifecycle] / [quitKernel]
    DEBUGGER:  0x08,   // [wolfbook-debug] / [wolfbook-dap] / [wolfbook-bp]
    EXTENSION: 0x10,   // [Extension] — general extension events
    UNICODE:   0x20,   // [Unicode Replacer]
    SLIDE:     0x40,   // [wslide-eval] / [wslide-ext]
};

const LOG_CHANNEL_LABELS = {
    SCROLL:    'Watch panel / eval scroll',
    DYNAMICS:  'Dynamic[] rendering',
    KERNEL:    'Kernel lifecycle',
    DEBUGGER:  'Debugger (DAP / breakpoints)',
    EXTENSION: 'Extension general',
    UNICODE:   'Unicode replacer',
    SLIDE:     'Slide editor eval',
};

// Default: all channels ON for dev.  Persisted to a JSON sidecar next to this file.
const _PREFS_FILE = require('path').join(__dirname, '.dev-log-prefs.json');
let _enabledMask = _loadMask();

function _allMask() {
    return Object.values(LOG_CHANNELS).reduce((a, b) => a | b, 0);
}

function _loadMask() {
    if (!DEV_MODE) return 0;
    try {
        const raw = require('fs').readFileSync(_PREFS_FILE, 'utf8');
        const v = JSON.parse(raw).mask;
        return (typeof v === 'number') ? v : _allMask();
    } catch (_) { return _allMask(); }
}

function _saveMask(mask) {
    try { require('fs').writeFileSync(_PREFS_FILE, JSON.stringify({ mask })); } catch (_) {}
}

/** Returns the current enabled-channel bitmask (0 on non-dev). */
function getLogMask()        { return _enabledMask; }

/** Set which channels are active. Persisted across sessions. */
function setLogMask(mask)    { _enabledMask = mask; _saveMask(mask); }

/** Returns true if the given channel flag is currently enabled. */
function isChannelEnabled(ch) { return DEV_MODE && !!((_enabledMask) & ch); }

// Backwards-compat: SCROLL_DEBUG is true when SCROLL channel is on.
// Code that calls scrollLog() already checks this implicitly via scrollLog().
const SCROLL_DEBUG = DEV_MODE;  // kept for import compat — real check is in scrollLog()

// Log file paths — resolved lazily on first write so the workspace folder list
// is available (it isn't populated at require() time).
let _scrollLogPath = null;
let _dynLogPath    = null;
let _wstpLogPath   = null;

function _resolveScrollLogPath() {
    if (_scrollLogPath) return _scrollLogPath;
    try {
        const vscode  = require('vscode');
        const folders = vscode.workspace && vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return null;
        const extFolder = folders.find(f => f.name === 'VSCodeWolframExtension');
        const base = extFolder ? extFolder.uri.fsPath : folders[0].uri.fsPath;
        _scrollLogPath = require('path').join(base, 'Temporary Docs', 'wolfbook-extension-debug.log');
        _dynLogPath    = require('path').join(base, 'Temporary Docs', 'wolfbook-dynamic-debug.log');
        _wstpLogPath   = require('path').join(base, 'Temporary Docs', 'wstp.log');
    } catch (_) {}
    return _scrollLogPath;
}

/**
 * scrollLog — writes to DevTools console + wolfbook-extension-debug.log.
 * Gated by LOG_CHANNELS.SCROLL. No-op on non-dev machines.
 */
function scrollLog(...args) {
    if (!isChannelEnabled(LOG_CHANNELS.SCROLL)) return;
    const msg = '[scroll] ' + args.join(' ');
    console.log(msg);
    const p = _resolveScrollLogPath();
    if (p) {
        try {
            require('fs').appendFileSync(p, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch (_) {}
    }
}

/**
 * dynLog — dedicated diagnostic log for the Dynamic rendering subsystem.
 * Gated by LOG_CHANNELS.DYNAMICS. No-op on non-dev machines.
 */
function dynLog(...args) {
    if (!isChannelEnabled(LOG_CHANNELS.DYNAMICS)) return;
    const msg = args.join(' ');
    console.log('[dyn-dbg] ' + msg);
    _resolveScrollLogPath();  // ensure _dynLogPath is set
    if (_dynLogPath) {
        try {
            require('fs').appendFileSync(_dynLogPath, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch (_) {}
    }
}

/**
 * devLog(channel, prefix, ...args) — generic dev log for any registered channel.
 * channel  — one of LOG_CHANNELS values (e.g. LOG_CHANNELS.KERNEL)
 * prefix   — string prepended in brackets, e.g. '[launchKernel]'
 */
function devLog(channel, prefix, ...args) {
    if (!isChannelEnabled(channel)) return;
    const msg = prefix + ' ' + args.join(' ');
    console.log(msg);
    const p = _resolveScrollLogPath();
    if (p) {
        try {
            require('fs').appendFileSync(p, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch (_) {}
    }
}

/**
 * _hexDump — format first N bytes of a string as 'XX XX …' for encoding diagnosis.
 */
function _hexDump(str, n) {
    const buf = Buffer.from(String(str).slice(0, n * 4), 'utf8').slice(0, n);
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * wstpLog — append a WSTP traffic entry to wstp.log (dev machines only).
 * If notebookFsPath is an absolute path, writes to img/<notebook>/wstp.log.
 * Otherwise writes to global Temporary Docs/wstp.log.
 * Trims to last 400 lines if the file grows too large.
 */
function wstpLog(notebookFsPath, ...args) {
    if (!DEV_MODE) return;
    const _path = require('path');
    const msg = args.join(' ');
    let logPath;
    if (typeof notebookFsPath === 'string' && _path.isAbsolute(notebookFsPath)) {
        const nbBase = _path.basename(notebookFsPath, _path.extname(notebookFsPath));
        logPath = _path.join(_path.dirname(notebookFsPath), 'img', nbBase, 'wstp.log');
    } else {
        _resolveScrollLogPath();
        logPath = _wstpLogPath;
    }
    if (!logPath) return;
    try {
        const fs = require('fs');
        fs.mkdirSync(_path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\n');
        const _lines = fs.readFileSync(logPath, 'utf8').split('\n');
        if (_lines.length > 400) fs.writeFileSync(logPath, _lines.slice(-400).join('\n'));
    } catch (_) {}
}

/**
 * truncateLogs — wipe all debug log files at kernel start so only fresh data
 * is visible.  No-op if paths haven't been resolved yet or on non-dev machines.
 */
function truncateLogs() {
    _resolveScrollLogPath();
    if (_dynLogPath)    try { require('fs').writeFileSync(_dynLogPath,    ''); } catch(_){}
    if (_scrollLogPath) try { require('fs').writeFileSync(_scrollLogPath, ''); } catch(_){}
    if (_wstpLogPath)   try { require('fs').writeFileSync(_wstpLogPath,   ''); } catch(_){}
}

module.exports = {
    DEV_MODE, SCROLL_DEBUG,
    LOG_CHANNELS, LOG_CHANNEL_LABELS,
    getLogMask, setLogMask, isChannelEnabled,
    scrollLog, dynLog, devLog, wstpLog, _hexDump, truncateLogs,
};
