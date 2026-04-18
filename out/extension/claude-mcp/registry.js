'use strict';
// ---------------------------------------------------------------------------
// Wolfbook MCP Registry — shared discovery file for multi-window routing
//
// Every window writes its own entry to ~/.wolfbook-mcp-registry.json when
// it starts a WorkerServer.  The primary reads this file to discover workers
// after an election.  Workers read it to check for collisions when assigning
// their client IDs.
//
// File format:
// [
//   { clientId, workerPort, pid, notebooks, appName, workspace, ts }
// ]
// ---------------------------------------------------------------------------

const fs  = require('fs');
const os  = require('os');
const path = require('path');

const REGISTRY_FILE = path.join(os.homedir(), '.wolfbook-mcp-registry.json');

// ── Internal helpers ────────────────────────────────────────────────────────

function _read() {
    try {
        const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

function _write(entries) {
    try {
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Wolfbook Registry] Write failed:', e.message);
    }
}

function _isAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Remove entries for dead processes.  Returns the cleaned array.
 */
function cleanStale() {
    const entries = _read().filter(e => _isAlive(e.pid));
    _write(entries);
    return entries;
}

/**
 * Write or update this window's entry.
 * entry = { clientId, workerPort, pid, notebooks, appName, workspace }
 */
function writeEntry(entry) {
    const entries = cleanStale();
    const idx = entries.findIndex(e => e.clientId === entry.clientId);
    const full = { ...entry, ts: Date.now() };
    if (idx >= 0) entries[idx] = full;
    else entries.push(full);
    _write(entries);
}

/**
 * Remove this window's entry on deactivation.
 */
function removeEntry(clientId) {
    try {
        const entries = _read().filter(e => e.clientId !== clientId);
        _write(entries);
    } catch {}
}

/**
 * Return all currently alive entries (does NOT rewrite the file).
 */
function listAlive() {
    return _read().filter(e => _isAlive(e.pid));
}

/**
 * Assign a unique client ID for this window.
 *
 * Format:  AppName[WorkspaceName]
 *          AppName[WorkspaceName]#2   (only on collision with an alive entry)
 *
 * appName is normalised:
 *   "Visual Studio Code" / "Code - OSS" / … → "VSCode"
 *   "Antigravity"                            → "Antigravity"
 *   anything else                            → first word
 */
function assignClientId(appName, workspaceName) {
    const app = appName.toLowerCase().includes('antigravity') ? 'Antigravity'
              : appName.toLowerCase().includes('cursor')      ? 'Cursor'
              : (appName.toLowerCase().includes('code') ||
                 appName.toLowerCase().includes('vscode'))    ? 'VSCode'
              : (appName.split(/\s+/)[0] || 'Editor');

    const ws   = (workspaceName || 'untitled').replace(/[[\]#]/g, '_');
    const base = `${app}[${ws}]`;

    const alive = cleanStale();
    const taken = new Set(alive.map(e => e.clientId));

    if (!taken.has(base)) return base;

    // Find the lowest free suffix
    let n = 2;
    while (taken.has(`${base}#${n}`)) n++;
    return `${base}#${n}`;
}

module.exports = { writeEntry, removeEntry, cleanStale, listAlive, assignClientId };
