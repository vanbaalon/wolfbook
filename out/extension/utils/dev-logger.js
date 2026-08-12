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
// The usernames are matched by SHA-256 prefix rather than as plaintext literals:
// this repo is public, and the behaviour is identical either way. Set
// WOLFBOOK_DEV=1 to force dev mode on any machine.
const DEV_MODE = (() => {
    if (process.env.WOLFBOOK_DEV === '1') return true;
    try {
        const _u = require('os').userInfo().username;
        const _h = require('crypto').createHash('sha256').update(_u).digest('hex').slice(0, 16);
        return ['df8bf20ffe645ce3', '4f96b2cb54873e10', '9b6ce9bfec2e421b'].includes(_h);
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

// Default: all channels ON for dev.  Persisted to the user's home directory so
// the setting survives across version deploys (each new version has a fresh extension folder).
const _PREFS_FILE = require('path').join(require('os').homedir(), '.wolfbook-dev-log-prefs.json');
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
    } catch (_) {
        // New prefs file doesn't exist yet — try to migrate from old location inside
        // the extension folder (used before v2.6.49).
        try {
            const _oldPrefs = require('path').join(__dirname, '.dev-log-prefs.json');
            const raw = require('fs').readFileSync(_oldPrefs, 'utf8');
            const v = JSON.parse(raw).mask;
            if (typeof v === 'number') {
                // Persist to new stable location so future loads work.
                _saveMask(v);
                return v;
            }
        } catch (_2) {}
        return _allMask();
    }
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

// Log file paths. These used to live in <workspace>/Temporary Docs/, which meant every
// keystroke of diagnostics was written into a Dropbox-synced folder. They now go to
// globalStorage via utils/log-paths.js, and only when the user opts in via
// wolfbook.advanced.diagnosticLogs.
//
// Resolved on each call rather than cached: the setting can be toggled at runtime, and
// workspaceLogFile() returns null while diagnostics are off.
function _logFile(name) {
    try {
        return require('./log-paths').workspaceLogFile(name);
    } catch (_) {
        return null;
    }
}

function _scrollLogPath() { return _logFile('wolfbook-extension-debug.log'); }
function _dynLogPath()    { return _logFile('wolfbook-dynamic-debug.log'); }
function _wstpLogPath()   { return _logFile('wstp.log'); }

/**
 * scrollLog — writes to DevTools console + wolfbook-extension-debug.log.
 * Gated by LOG_CHANNELS.SCROLL. No-op on non-dev machines.
 */
function scrollLog(...args) {
    if (!isChannelEnabled(LOG_CHANNELS.SCROLL)) return;
    const msg = '[scroll] ' + args.join(' ');
    console.log(msg);
    const p = _scrollLogPath();
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
    const p = _dynLogPath();
    if (p) {
        try {
            require('fs').appendFileSync(p, '[' + new Date().toISOString() + '] ' + msg + '\n');
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
    const p = _scrollLogPath();
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
 * If notebookFsPath is an absolute path, writes to that notebook's log dir under
 * globalStorage; otherwise to the shared workspace wstp.log. Both are no-ops unless
 * wolfbook.advanced.diagnosticLogs is on.
 * Trims to last 400 lines if the file grows too large.
 */
function wstpLog(notebookFsPath, ...args) {
    if (!DEV_MODE) return;
    const _path = require('path');
    const msg = args.join(' ');
    let logPath;
    if (typeof notebookFsPath === 'string' && _path.isAbsolute(notebookFsPath)) {
        try {
            logPath = require('./log-paths').notebookLogFile(notebookFsPath, 'wstp.log');
        } catch (_) { logPath = null; }
    } else {
        logPath = _wstpLogPath();
    }
    if (!logPath) return;
    try {
        const fs = require('fs');
        fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\n');
        const _lines = fs.readFileSync(logPath, 'utf8').split('\n');
        if (_lines.length > 400) fs.writeFileSync(logPath, _lines.slice(-400).join('\n'));
    } catch (_) {}
}

/**
 * truncateLogs — wipe the workspace debug logs at kernel start so only fresh data
 * is visible. No-op when diagnostics are off (the paths resolve to null).
 */
function truncateLogs() {
    for (const p of [_dynLogPath(), _scrollLogPath(), _wstpLogPath()]) {
        if (p) try { require('fs').writeFileSync(p, ''); } catch (_) {}
    }
}

module.exports = {
    DEV_MODE, SCROLL_DEBUG,
    LOG_CHANNELS, LOG_CHANNEL_LABELS,
    getLogMask, setLogMask, isChannelEnabled,
    scrollLog, dynLog, devLog, wstpLog, _hexDump, truncateLogs,
};
