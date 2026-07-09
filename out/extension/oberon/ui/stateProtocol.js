'use strict';
/**
 * Oberon — shared message contract used by BOTH the Control Room sidebar
 * (WebviewViewProvider) and the Run Inspector tab (WebviewPanel).
 *
 * Keeping the protocol in one place means the two webview frontends can be
 * developed independently while staying interoperable; later, a single
 * dispatch function `applyMessage(state, msg)` can live alongside.
 *
 * Extension → Webview commands:
 *   snapshot.full      { run: RunSummary|null, settings, roles, recentEvents }
 *   event.append       { event: TelemetryEvent }
 *   event.batch        { events: TelemetryEvent[] }
 *   metrics.update     { metrics }
 *   settings.snapshot  { settings, roles }
 *   omen               { omen }
 *
 * Webview → Extension commands:
 *   scriptLoaded                  (MANDATORY — race fix; provider replays state)
 *   abortRun                      ()
 *   startResearch                 { brief }
 *   openRunInspector              ()
 *   openSettings                  ()
 *   configureProviders            ()
 *   emitMockEvents                ()
 *   runVSCodeCommand              { id, args? }
 */

const TO_WEBVIEW = Object.freeze({
    SNAPSHOT_FULL:          'snapshot.full',
    EVENT_APPEND:           'event.append',
    EVENT_BATCH:            'event.batch',
    METRICS_UPDATE:         'metrics.update',
    SETTINGS_SNAPSHOT:      'settings.snapshot',
    OMEN:                   'omen',
    HISTORICAL_RUN_LIST:    'historicalRun.list',
    HISTORICAL_RUN_LOADED:  'historicalRun.loaded',
    CHARM_EXAMPLES:         'charmExamples',
    ISOLATED_RUN_EVENT:     'isolatedRun.event',
    ISOLATED_RUN_DONE:      'isolatedRun.done',
    PROMPTS_SNAPSHOT:       'prompts.snapshot',
});

const FROM_WEBVIEW = Object.freeze({
    SCRIPT_LOADED:           'scriptLoaded',
    ABORT_RUN:               'abortRun',
    START_RESEARCH:          'startResearch',
    START_FAIRY:             'startFairy',
    START_DIRECTOR:          'startDirector',
    OPEN_RUN_INSPECTOR:      'openRunInspector',
    OPEN_SETTINGS:           'openSettings',
    CONFIGURE_PROVIDERS:     'configureProviders',
    EMIT_MOCK_EVENTS:        'emitMockEvents',
    RUN_VSCODE_COMMAND:      'runVSCodeCommand',
    LIST_HISTORICAL_RUNS:    'listHistoricalRuns',
    LOAD_HISTORICAL_RUN:     'loadHistoricalRun',
    UPDATE_SETTING:          'updateSetting',
    OPEN_CHARM_DEBUGGER:     'openCharmDebugger',
    LIST_CHARM_EXAMPLES:     'listCharmExamples',
    RERUN_CHARM:             'rerunCharm',
    ABORT_ISOLATED_RUN:      'abortIsolatedRun',
    GET_PROMPTS:             'getPrompts',
    SUBMIT_STEER:            'submitSteer',
});

module.exports = { TO_WEBVIEW, FROM_WEBVIEW };
