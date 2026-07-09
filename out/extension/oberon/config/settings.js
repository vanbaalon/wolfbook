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
/** Per-request timeout (ms) for DeepSeek calls. Applies to time-to-first-byte on
 *  streaming calls (a live stream is then guarded by the SSE stall detector). */
function deepseekTimeoutMs() { return Number(get('providers.deepseek.timeoutMs', 120000)) || 120000; }

// O1: frontier-provider keys — mirror the deepseek getter exactly. The adapters read
// their own config blocks directly; these getters exist for roles.providerConfigured.
function anthropicApiKey() {
    const explicit = (get('providers.anthropic.apiKey', '') || '').trim();
    if (explicit) return explicit;
    const envName = (get('providers.anthropic.apiKeyEnv', 'ANTHROPIC_API_KEY') || '').trim();
    if (envName && process.env[envName]) return process.env[envName];
    return '';
}
function openaiApiKey() {
    const explicit = (get('providers.openai.apiKey', '') || '').trim();
    if (explicit) return explicit;
    const envName = (get('providers.openai.apiKeyEnv', 'OPENAI_API_KEY') || '').trim();
    if (envName && process.env[envName]) return process.env[envName];
    return '';
}

function roleBinding(role) {
    // role ∈ 'oberon' | 'fairy' | 'postmortem' | 'fairy_summariser' | 'literature' | 'director'
    const direct = get(`roles.${role}`, null);
    if (direct && Object.keys(direct).length) return direct;
    if (role === 'postmortem') return get('roles.fairy', null);
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
        // Default ON (run Q29): with autoDispatch off, a failed first charm ended
        // the whole run with a toast nobody clicked — "Oberon must not give up"
        // (FM-6) only works if the follow-up actually dispatches. Bounded by
        // maxAutoFollowups, so runaway recursion stays impossible.
        autoDispatch:      !!get('executive.autoDispatch', true),
        maxAutoFollowups:  Math.max(0, Math.min(6, Number(get('executive.maxAutoFollowups', 2)) || 0)),
        maxPerQuest:       Math.max(1, Math.min(8, Number(get('executive.maxPerQuest', 2)) || 1)),
    };
}

function memory() {
    return {
        extractPartialFacts: !!get('memory.extractPartialFacts', true),
    };
}

/**
 * Oberon Director (the LLM layer above the Fairy) — bounded multi-stage
 * research programmes. All caps are hard limits enforced inside the loop.
 */
function director() {
    const clampInt = (v, lo, hi, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
    };
    return {
        maxStages:       clampInt(get('director.maxStages', 6), 1, 12, 6),
        maxReplans:      clampInt(get('director.maxReplans', 4), 0, 12, 4),
        maxLitConsults:  clampInt(get('director.maxLitConsults', 2), 0, 8, 2),
        maxAskUser:      clampInt(get('director.maxAskUser', 1), 0, 4, 1),
        maxUSD:          Math.max(0, Number(get('director.maxUSD', 15)) || 0),
        maxLlmCalls:     clampInt(get('director.maxLlmCalls', 400), 0, 5000, 400),
        compilePdf:      !!get('director.compilePdf', true),
        skillCandidate:  !!get('director.skillCandidate', true),
        autoSubmitSkill: !!get('director.autoSubmitSkill', false),
        // Auto-grant this many fairy budget continuations per stage (no dialogs).
        stageContinuations: clampInt(get('director.stageContinuations', 1), 0, 4, 1),
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
    deepseekApiKey, deepseekBaseUrl, deepseekTimeoutMs,
    anthropicApiKey, openaiApiKey,
    roleBinding, fairyDefaultBudget, runBudget,
    priceTablePath,
    telemetry, mathematica, postmortem, git,
    notebookFirstExecution,
    executive, memory, director, replayPerCellTimeoutSeconds,
    fairy, recall, contribution,
    toolLoopMultiplier,
    openSettingsUI, openProviderSettingsUI,
    onDidChange,
};
