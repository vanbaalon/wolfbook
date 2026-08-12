'use strict';
/**
 * Oberon — workspace paths, .oberon/ path guard, .gitignore prompt.
 *
 * Layout (MVP-1):
 *   <workspace>/
 *     .oberon/                       ← OUT-OF-CONTEXT (path-guarded; .gitignored)
 *       telemetry/
 *         runs/<runId>.jsonl
 *         blobs/<sha256>.txt         ← opt-in
 *       postmortems/<date>_<runId>.md
 *       state.json                   ← latest RunSummary for resume
 *     grimoire/                      ← agent-readable (committed by user)
 *       canonical_state.md
 *     quests/                        ← agent-readable
 *       Q01_<shortName>/
 *         inputs/
 *         artefacts/
 *         scrolls/
 */

const vscode   = require('vscode');
const path     = require('path');
const fs       = require('fs');
const fsp      = require('fs/promises');
const logPaths = require('../../utils/log-paths');

const OBERON_DIR_NAME    = '.oberon';
const TELEMETRY_DIR_NAME = 'telemetry';
const RUNS_DIR_NAME      = 'runs';
const BLOBS_DIR_NAME     = 'blobs';
const POSTMORTEMS_DIR    = 'postmortems';
const CONTRIB_DIR_NAME   = 'contributions';
const STATE_FILE_NAME    = 'state.json';
const GRIMOIRE_DIR_NAME  = 'grimoire';
const QUESTS_DIR_NAME    = 'quests';

const GITIGNORE_PROMPT_KEY = 'wolfbook.oberon.gitignorePromptHandled';

/**
 * Resolve the active workspace root. Returns null when no folder is open.
 * Oberon is workspace-scoped — it does not operate on isolated files.
 * @returns {string|null}
 */
function getWorkspaceRoot() {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws || ws.length === 0) return null;
    return ws[0].uri.fsPath;
}

/** @returns {string|null} */
function oberonDir() {
    const root = getWorkspaceRoot();
    return root ? path.join(root, OBERON_DIR_NAME) : null;
}

/**
 * Telemetry run logs. These live under globalStorage, NOT under .oberon/ — a run
 * writes tens of MB of JSONL, and the workspace is routinely Dropbox-synced, where a
 * sync lock can stall an fs write indefinitely (the watchdog in telemetry/bus.js
 * exists because of exactly that). Keyed by workspace so runs stay per-project.
 * Pruned to wolfbook.advanced.telemetryRetainRuns by pruneTelemetry().
 * @returns {string|null}
 */
function telemetryRunsDir() {
    const t = logPaths.telemetryDir(getWorkspaceRoot());
    return t ? path.join(t, RUNS_DIR_NAME) : null;
}

/** @returns {string|null} */
function telemetryBlobsDir() {
    const t = logPaths.telemetryDir(getWorkspaceRoot());
    return t ? path.join(t, BLOBS_DIR_NAME) : null;
}

/**
 * Delete all but the newest N telemetry runs. Call once at activation.
 * Best-effort — never throws.
 * @returns {Promise<number>} number of run logs deleted
 */
async function pruneTelemetry() {
    return logPaths.pruneTelemetryRuns(telemetryRunsDir());
}

/** @returns {string|null} */
function postmortemsDir() {
    const o = oberonDir();
    return o ? path.join(o, POSTMORTEMS_DIR) : null;
}

/**
 * Review inbox for Stage-2 contribution candidates (private, never auto-submitted).
 * @returns {string|null}
 */
function contributionsInboxDir() {
    const o = oberonDir();
    return o ? path.join(o, CONTRIB_DIR_NAME, 'inbox') : null;
}

/** @returns {string|null} */
function stateFilePath() {
    const o = oberonDir();
    return o ? path.join(o, STATE_FILE_NAME) : null;
}

/** @returns {string|null} */
function grimoireDir() {
    const root = getWorkspaceRoot();
    return root ? path.join(root, GRIMOIRE_DIR_NAME) : null;
}

/** @returns {string|null} */
function questsDir() {
    const root = getWorkspaceRoot();
    return root ? path.join(root, QUESTS_DIR_NAME) : null;
}

/**
 * Ensure a directory exists (mkdir -p semantics).
 * @param {string|null} dir
 */
async function ensureDir(dir) {
    if (!dir) return;
    await fsp.mkdir(dir, { recursive: true });
}

/**
 * Ensure all out-of-context Oberon directories exist. Idempotent.
 */
async function ensureOberonLayout() {
    await ensureDir(telemetryRunsDir());
    await ensureDir(telemetryBlobsDir());
    await ensureDir(postmortemsDir());
}

/**
 * Path guard: throws if the resolved path lies under .oberon/.
 * Used to prevent agent tools from reading/writing out-of-context state.
 *
 * @param {string} p
 * @returns {string} the same path (for chaining)
 */
function safePath(p) {
    const root = getWorkspaceRoot();
    if (!root) return p;
    const resolved = path.resolve(p);
    const oberonAbs = path.join(root, OBERON_DIR_NAME);
    // Use path.relative + segment check so '.oberon-other' is NOT matched.
    const rel = path.relative(oberonAbs, resolved);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) {
        throw new Error(`[oberon] path guard: '${p}' lies inside .oberon/ (out-of-context).`);
    }
    return p;
}

/**
 * Returns true if the workspace's git-ignore already excludes .oberon/.
 * Cheap line-by-line check; does not parse globs exhaustively.
 */
async function gitignoreCoversOberon() {
    const root = getWorkspaceRoot();
    if (!root) return false;
    const gi = path.join(root, '.gitignore');
    try {
        const text = await fsp.readFile(gi, 'utf8');
        return text.split(/\r?\n/).some(line => {
            const t = line.trim();
            return t === '.oberon' || t === '.oberon/' || t === '/.oberon' || t === '/.oberon/';
        });
    } catch (_) {
        return false;
    }
}

/**
 * Append `.oberon/` to .gitignore (creating the file if absent).
 */
async function appendOberonToGitignore() {
    const root = getWorkspaceRoot();
    if (!root) return;
    const gi = path.join(root, '.gitignore');
    let prefix = '';
    try {
        const existing = await fsp.readFile(gi, 'utf8');
        if (existing.length && !existing.endsWith('\n')) prefix = '\n';
    } catch (_) {
        // file does not exist — no prefix needed
    }
    const block = `${prefix}# Oberon (out-of-context telemetry, postmortems, raw blobs)\n.oberon/\n`;
    await fsp.appendFile(gi, block, 'utf8');
}

/**
 * First-run prompt to add .oberon/ to .gitignore. Result is cached in
 * extension global state so we never bother the user twice.
 *
 * @param {vscode.ExtensionContext} context
 */
async function maybePromptGitignore(context) {
    if (!getWorkspaceRoot()) return;
    if (context.globalState.get(GITIGNORE_PROMPT_KEY) === true) return;
    if (await gitignoreCoversOberon()) {
        await context.globalState.update(GITIGNORE_PROMPT_KEY, true);
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        'Oberon stores telemetry under .oberon/. Add it to .gitignore?',
        { modal: false },
        'Yes', 'No', "Don't ask again"
    );
    if (choice === 'Yes') {
        try {
            await appendOberonToGitignore();
            await context.globalState.update(GITIGNORE_PROMPT_KEY, true);
            vscode.window.showInformationMessage('Oberon: .oberon/ added to .gitignore.');
        } catch (e) {
            vscode.window.showWarningMessage(`Oberon: failed to update .gitignore: ${e.message}`);
        }
    } else if (choice === "Don't ask again") {
        await context.globalState.update(GITIGNORE_PROMPT_KEY, true);
    }
}

/**
 * Make a fresh run ID. ISO timestamp with ':' replaced for filesystem safety.
 * @returns {string}
 */
function makeRunId() {
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    return `run_${iso}`;
}

module.exports = {
    OBERON_DIR_NAME,
    getWorkspaceRoot,
    oberonDir,
    telemetryRunsDir,
    telemetryBlobsDir,
    pruneTelemetry,
    postmortemsDir,
    contributionsInboxDir,
    stateFilePath,
    grimoireDir,
    questsDir,
    ensureDir,
    ensureOberonLayout,
    safePath,
    gitignoreCoversOberon,
    appendOberonToGitignore,
    maybePromptGitignore,
    makeRunId,
};
