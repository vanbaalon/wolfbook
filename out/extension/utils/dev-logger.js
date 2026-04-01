"use strict";
/*
 * utils/dev-logger.js — Wolfbook developer diagnostics
 *
 * Provides DEV_MODE flag, scrollLog(), dynLog() and _hexDump() helpers.
 * All output is suppressed on non-dev machines (detection by OS username)
 * so no log noise reaches end-user installs.
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

const SCROLL_DEBUG = DEV_MODE;

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
 * No-op on non-dev machines.
 */
function scrollLog(...args) {
    if (!SCROLL_DEBUG) return;
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
 * Truncated (file recreated) on each kernel start.  No-op on non-dev machines.
 */
function dynLog(...args) {
    if (!DEV_MODE) return;
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
 * _hexDump — format first N bytes of a string as 'XX XX …' for encoding diagnosis.
 */
function _hexDump(str, n) {
    const buf = Buffer.from(String(str).slice(0, n * 4), 'utf8').slice(0, n);
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * wstpLog — append a WSTP traffic entry to wstp.log (dev machines only).
 * Each call writes one line: timestamp, direction tag, trimmed expression/result.
 */
function wstpLog(...args) {
    if (!DEV_MODE) return;
    const msg = args.join(' ');
    _resolveScrollLogPath();  // ensures _wstpLogPath is set
    if (_wstpLogPath) {
        try {
            require('fs').appendFileSync(_wstpLogPath, '[' + new Date().toISOString() + '] ' + msg + '\n');
        } catch (_) {}
    }
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

module.exports = { DEV_MODE, SCROLL_DEBUG, scrollLog, dynLog, wstpLog, _hexDump, truncateLogs };
