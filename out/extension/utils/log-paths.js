"use strict";
/*
 * utils/log-paths.js — single source of truth for where diagnostic logs are written.
 *
 * Logs NEVER go inside the workspace. Workspaces are routinely Dropbox-synced, and a
 * sync lock can stall an fs write indefinitely — the watchdog in
 * oberon/telemetry/bus.js exists precisely because of that. Writing logs beside the
 * user's notebooks also littered every notebook folder with an img/<nb>/*.log file
 * that Dropbox re-synced on every cell evaluation.
 *
 * Everything lives under the extension's globalStorage:
 *
 *   <globalStorage>/logs/
 *     notebooks/<base>-<hash>/      btl.log, ai_eval_log.md, wolfram-kernel-debug.log, wstp.log
 *     workspace/                    wolfbook-extension-debug.log, wolfbook-dynamic-debug.log, wstp.log
 *     telemetry/<ws>-<hash>/runs/   Oberon run JSONL
 *
 * Per-notebook dirs are keyed by basename + a hash of the full path so two notebooks
 * with the same basename don't collide.
 *
 * Per-notebook and workspace debug logs are OFF unless `wolfbook.advanced.diagnosticLogs`
 * is enabled. Oberon telemetry is always on (the Run Inspector needs it) but is pruned
 * to the most recent `wolfbook.advanced.telemetryRetainRuns` runs.
 */

const path   = require('path');
const fs     = require('fs');
const fsp    = require('fs/promises');
const os     = require('os');
const crypto = require('crypto');

const DEFAULT_RETAIN_RUNS = 20;

/** @type {string|null} Set once from activate(); <globalStorage>/logs */
let _root = null;

/**
 * Capture the extension's globalStorage path. Call once from activate().
 * @param {import('vscode').ExtensionContext} context
 * @returns {string|null} the resolved log root
 */
function init(context) {
    try {
        _root = path.join(context.globalStorageUri.fsPath, 'logs');
    } catch (_) {
        _root = null;
    }
    return logRoot();
}

/**
 * The log root. Falls back to a temp dir if init() hasn't run, so a missed
 * init can never send a write back into the workspace.
 * @returns {string}
 */
function logRoot() {
    if (_root) return _root;
    return path.join(os.tmpdir(), 'wolfbook-logs');
}

/** @param {string} p @returns {string} the same path, for chaining */
function ensureDirSync(p) {
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
    return p;
}

/**
 * True when the user has opted into per-notebook / workspace diagnostic logs.
 * Reads the setting live so toggling it takes effect without a reload.
 * @returns {boolean}
 */
function diagnosticsEnabled() {
    try {
        const vscode = require('vscode');
        return vscode.workspace
            .getConfiguration('wolfbook')
            .get('advanced.diagnosticLogs', false) === true;
    } catch (_) {
        return false;
    }
}

/** @param {string} s @returns {string} short stable hash */
function _hash(s) {
    return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}

/** @param {string} s @returns {string} filesystem-safe slug */
function _slug(s) {
    return String(s).replace(/[^\w.-]+/g, '_').slice(0, 48) || 'unnamed';
}

/**
 * Directory holding a notebook's diagnostic logs.
 * @param {string} nbFsPath absolute path to the notebook
 * @returns {string|null} null when diagnostics are off or the path is unusable
 */
function notebookLogDir(nbFsPath) {
    if (!diagnosticsEnabled()) return null;
    if (typeof nbFsPath !== 'string' || !path.isAbsolute(nbFsPath)) return null;
    const base = _slug(path.basename(nbFsPath, path.extname(nbFsPath)));
    return path.join(logRoot(), 'notebooks', `${base}-${_hash(nbFsPath)}`);
}

/**
 * Full path to one of a notebook's log files, with the directory created.
 * Returns null when diagnostics are off — callers treat null as "don't log".
 * @param {string} nbFsPath
 * @param {string} name e.g. 'btl.log'
 * @returns {string|null}
 */
function notebookLogFile(nbFsPath, name) {
    const dir = notebookLogDir(nbFsPath);
    if (!dir) return null;
    ensureDirSync(dir);
    return path.join(dir, name);
}

/**
 * Full path to a workspace-wide debug log (the old `Temporary Docs/*.log` family).
 * Returns null when diagnostics are off.
 * @param {string} name e.g. 'wolfbook-extension-debug.log'
 * @returns {string|null}
 */
function workspaceLogFile(name) {
    if (!diagnosticsEnabled()) return null;
    const dir = path.join(logRoot(), 'workspace');
    ensureDirSync(dir);
    return path.join(dir, name);
}

/**
 * Telemetry root for a workspace. Unlike the debug logs this is NOT gated — Oberon's
 * Run Inspector, postmortems and example extractor all read it — but it lives outside
 * the workspace and is pruned by pruneTelemetryRuns().
 * @param {string|null} workspaceRoot
 * @returns {string|null} null when no workspace is open
 */
function telemetryDir(workspaceRoot) {
    if (!workspaceRoot) return null;
    const base = _slug(path.basename(workspaceRoot));
    return path.join(logRoot(), 'telemetry', `${base}-${_hash(workspaceRoot)}`);
}

/** @returns {number} how many run logs to keep */
function telemetryRetainRuns() {
    try {
        const vscode = require('vscode');
        const n = vscode.workspace
            .getConfiguration('wolfbook')
            .get('advanced.telemetryRetainRuns', DEFAULT_RETAIN_RUNS);
        // 0 means "keep everything".
        return (typeof n === 'number' && n >= 0) ? n : DEFAULT_RETAIN_RUNS;
    } catch (_) {
        return DEFAULT_RETAIN_RUNS;
    }
}

/**
 * Delete all but the newest `keep` run logs. Run ids are ISO-timestamped, so a
 * lexicographic sort is chronological. Best-effort: never throws.
 * @param {string|null} runsDir
 * @param {number} [keep]
 * @returns {Promise<number>} number of files deleted
 */
async function pruneTelemetryRuns(runsDir, keep) {
    const limit = (typeof keep === 'number') ? keep : telemetryRetainRuns();
    if (!runsDir || limit === 0) return 0;
    let deleted = 0;
    try {
        const files = (await fsp.readdir(runsDir)).filter(f => f.endsWith('.jsonl')).sort();
        const stale = files.slice(0, Math.max(0, files.length - limit));
        for (const f of stale) {
            try { await fsp.unlink(path.join(runsDir, f)); deleted++; } catch (_) {}
        }
    } catch (_) {}
    return deleted;
}

module.exports = {
    init,
    logRoot,
    ensureDirSync,
    diagnosticsEnabled,
    notebookLogDir,
    notebookLogFile,
    workspaceLogFile,
    telemetryDir,
    telemetryRetainRuns,
    pruneTelemetryRuns,
};
