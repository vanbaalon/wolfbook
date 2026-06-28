'use strict';
/**
 * Oberon — settings reader (thin wrapper over vscode.workspace.getConfiguration).
 *
 * All keys live under `wolfbook.oberon.*` (declared in package.json).
 * This module exists so the rest of Oberon never imports `vscode` for config —
 * tests/headless code can stub this single module.
 */
const vscode = require('vscode');

const PREFIX = 'wolfbook.oberon';

function cfg() { return vscode.workspace.getConfiguration(PREFIX); }

function get(key, fallback) {
    const v = cfg().get(key);
    return v === undefined ? fallback : v;
}

function isEnabled()                  { return !!get('enabled', false); }

function deepseekApiKey() {
    const explicit = (get('providers.deepseek.apiKey', '') || '').trim();
    if (explicit) return explicit;
    const envName = (get('providers.deepseek.apiKeyEnv', 'DEEPSEEK_API_KEY') || '').trim();
    if (envName && process.env[envName]) return process.env[envName];
    return '';
}
function deepseekBaseUrl() { return get('providers.deepseek.baseUrl', 'https://api.deepseek.com'); }

function roleBinding(role) {
    // role ∈ 'oberon' | 'fairy' | 'skeptic' | 'postmortem'
    const direct = get(`roles.${role}`, null);
    if (direct && Object.keys(direct).length) return direct;
    if (role === 'skeptic' || role === 'postmortem') return get('roles.fairy', null);
    return direct;
}

function fairyDefaultBudget() {
    // Deep-merge: stored object overrides per-key; any key absent from stored
    // falls back to the current defaults. This means bumped defaults auto-apply
    // unless the user has explicitly overridden a specific key.
    const defaults = { maxLlmCalls: 12, maxToolCalls: 24, maxOutputTokens: 8000, maxWallClockMs: 360000 };
    const stored = cfg().get('budgets.fairyDefault');
    if (!stored || typeof stored !== 'object') return defaults;
    return Object.assign({}, defaults, stored);
}

/**
 * Per-run hard caps. When either is exceeded mid-run, the RunManager emits a
 * `budget.exhausted` event and aborts the in-flight operation; the caller
 * synthesises a low-confidence fallback Scroll so the user still sees a
 * conclusion. `0` on either field means "no enforcement".
 */
function runBudget() {
    const defaults = { runUSD: 5.00, runLlmCalls: 60 };
    const stored = cfg().get('budgets.run');
    if (!stored || typeof stored !== 'object') return defaults;
    return Object.assign({}, defaults, stored);
}

function priceTablePath()             { return get('priceTablePath', ''); }

function telemetry() {
    return {
        saveRawPrompts:           !!get('telemetry.saveRawPrompts',   false),
        saveRawResponses:         !!get('telemetry.saveRawResponses', false),
        redactSecrets:            !!get('telemetry.redactSecrets',    true),
        retentionDays:    Number(get('telemetry.retentionDays', 30)),
        maxBlobSizeMB:    Number(get('telemetry.maxBlobSizeMB', 10)),
        mirrorGlobalToolEvents:   !!get('telemetry.mirrorGlobalToolEvents', false),
    };
}

function mathematica() {
    return {
        timeConstrainSec:  Number(get('mathematica.timeConstrainSec',  120)),
        memoryConstrainMB: Number(get('mathematica.memoryConstrainMB', 4096)),
        guardMode:         String(get('mathematica.guardMode', 'strict')),
    };
}

function postmortem() {
    return {
        narrativeEnabled: !!get('postmortem.narrativeEnabled', true),
    };
}

function notebookFirstExecution() { return !!get('notebookFirstExecution', true); }

function executive() {
    return {
        autoDispatch:      !!get('executive.autoDispatch', false),
        maxAutoFollowups:  Math.max(0, Math.min(6, Number(get('executive.maxAutoFollowups', 2)) || 0)),
        maxPerQuest:       Math.max(1, Math.min(8, Number(get('executive.maxPerQuest', 2)) || 1)),
    };
}

function memory() {
    return {
        extractPartialFacts: !!get('memory.extractPartialFacts', true),
    };
}

function replayPerCellTimeoutSeconds() {
    const n = Number(get('replay.perCellTimeoutSeconds', 30));
    if (!isFinite(n) || n <= 0) return 30;
    return Math.max(5, Math.min(600, Math.floor(n)));
}

function git() {
    return {
        autoCommitGrimoire: !!get('git.autoCommitGrimoire', true),
    };
}

function recall() {
    return {
        enabled:         !!get('recall.enabled', true),
        usageTelemetry:  !!get('recall.usageTelemetry', true),
        skilxivBaseUrl:  String(get('recall.skilxiv.baseUrl',  'https://skilxiv.org') || 'https://skilxiv.org'),
        skilxivApiToken: String(get('recall.skilxiv.apiToken', '')                     || ''),
    };
}

/**
 * Stage 2 contribution settings.
 *   mode:           'off' — never raise candidates;
 *                   'draft-on-approval' (default) — raise candidates, submit only on human approval.
 *   defaultLicense: license preselected in the review dialog.
 *   defaultVisibility: always 'private' for Stage 2 (public is a separate action).
 */
function contribution() {
    const mode = String(get('contribution.mode', 'draft-on-approval'));
    return {
        mode:             ['off', 'draft-on-approval'].includes(mode) ? mode : 'draft-on-approval',
        defaultLicense:   String(get('contribution.defaultLicense', 'CC-BY-4.0') || 'CC-BY-4.0'),
        defaultVisibility: 'private',
        // Privacy: when off (default), skill usage is reported anonymously (counts only).
        // When on, your GitHub identity + a short agent report may appear on the skill page.
        shareUsagePublicly: !!get('contribution.shareUsagePublicly', false),
    };
}

function fairy() {
    return {
        askSpecialistEnabled: !!get('fairy.askSpecialistEnabled', true),
        rejectRedefinition:   !!get('fairy.rejectRedefinition', true),
    };
}

function wardsEnabled() { return !!get('wardsEnabled', false); }

function toolLoopMultiplier() {
    const v = Number(get('toolLoopMultiplier', 2));
    return Number.isFinite(v) && v >= 1 ? v : 2;
}

/**
 * Open the VS Code settings UI scoped to Oberon's settings.
 */
function openSettingsUI() {
    return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:wolfbook.wolfbook ${PREFIX}`);
}

/**
 * Open just the provider + pricing slice.
 */
function openProviderSettingsUI() {
    return vscode.commands.executeCommand('workbench.action.openSettings', `${PREFIX}.providers ${PREFIX}.roles`);
}

/**
 * Subscribe to changes affecting Oberon settings.
 * @param {(e: vscode.ConfigurationChangeEvent) => void} cb
 */
function onDidChange(cb) {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(PREFIX)) cb(e);
    });
}

module.exports = {
    PREFIX,
    isEnabled,
    deepseekApiKey, deepseekBaseUrl,
    roleBinding, fairyDefaultBudget, runBudget,
    priceTablePath,
    telemetry, mathematica, postmortem, git,
    notebookFirstExecution,
    executive, memory, replayPerCellTimeoutSeconds,
    fairy, recall, contribution,
    wardsEnabled,
    toolLoopMultiplier,
    openSettingsUI, openProviderSettingsUI,
    onDidChange,
};
