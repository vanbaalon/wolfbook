'use strict';
/**
 * Oberon — TestSuiteRunner.
 *
 * Thin EventEmitter shell over the gold-suite engine (tests/goldRunner.js):
 * drives the LIVE quick-compute pipeline (the same `startFairy` dispatch path
 * used by wolfbook_fairy_dispatch) task by task, then grades each run with a
 * fresh-kernel machine verifier. Grading is kernel-based — the old LLM
 * analytics call was removed with the Stage-0 rebuild (2026-08-01); the
 * `analytics` payload is now deterministic (goldRunner.buildAnalytics).
 *
 * Events (contract with ui/testResultsPanel.js — do not change):
 *   'started'          — suite begun
 *   'testStarted'      { index, test }
 *   'testDone'         { result }   (panel-shaped record, `gold` carries the full engine record)
 *   'suiteComplete'    { results, analytics, report }
 *   'error'            Error
 */

const { EventEmitter } = require('events');
const wolframShim      = require('../core/wolframShim');
const gold             = require('./goldRunner');
const SUITE            = require('./suite');

class TestSuiteRunner extends EventEmitter {
    /**
     * @param {{
     *   bus:           import('../telemetry/bus').TelemetryBus,
     *   runManager:    import('../core/runManager').RunManager,
     *   dispatchBrief: (payload:{brief:string,questId:string,shortName:string,validationChecks:string[]}) => Promise<any>,
     *   outDir?:       string|null,
     * }} opts
     */
    constructor({ bus, runManager, dispatchBrief, outDir = null }) {
        super();
        this._bus           = bus;
        this._runManager    = runManager;
        this._dispatchBrief = dispatchBrief;
        this._outDir        = outDir;
        this._running       = false;
        this._lastReport    = null;
        /** @type {AbortController|null} */
        this._outerAbort    = null;
    }

    get isRunning()  { return this._running; }
    get lastReport() { return this._lastReport; }

    /** Abort: stop scheduling new tasks AND interrupt the in-flight fairy run. */
    abort() {
        if (this._outerAbort) { try { this._outerAbort.abort(); } catch (_) {} }
        try {
            if (this._runManager.isActive) this._runManager.abortRun('test suite abort');
        } catch (_) {}
    }

    /**
     * Run the suite (all tasks, or a subset via opts.taskIds).
     * Safe to call while running — returns immediately in that case.
     * @param {{ taskIds?: string[]|string, label?: string }} [opts]
     */
    async run(opts = {}) {
        if (this._running) return null;
        if (typeof this._dispatchBrief !== 'function') {
            const e = new Error('TestSuiteRunner is not wired to the pipeline (dispatchBrief missing).');
            this.emit('error', e);
            return null;
        }
        this._running    = true;
        this._outerAbort = new AbortController();
        this.emit('started');

        const results = [];
        try {
            const report = await gold.runGoldSuite({
                dispatchBrief: this._dispatchBrief,
                bus:           this._bus,
                runManager:    this._runManager,
                shim: {
                    restartKernel: (...a) => wolframShim.restartKernel(...a),
                    runNotebook:   (...a) => wolframShim.runNotebook(...a),
                    evalOnce:      (...a) => wolframShim.evalOnce(...a),
                    kernelStatus:  ()     => wolframShim.kernelStatus(),
                },
                outDir: this._outDir,
                log: (m) => { try { console.log('[testRunner]', m); } catch (_) {} },
            }, {
                taskIds: opts.taskIds,
                label:   opts.label || 'suite',
                signal:  this._outerAbort.signal,
                onTaskStarted: ({ index, task }) => this.emit('testStarted', { index, test: task }),
                onTaskDone:    ({ index, task, result }) => {
                    const shaped = panelShape(index, task, result);
                    results.push(shaped);
                    this.emit('testDone', { result: shaped });
                },
            });

            this._lastReport = report;
            const analytics = gold.buildAnalytics(report.tasks);
            this.emit('suiteComplete', { results, analytics, report });
        } catch (e) {
            this.emit('error', e);
        } finally {
            this._running    = false;
            this._outerAbort = null;
        }
        return this._lastReport;
    }
}

/** Map an engine task record onto the shape ui/testResultsPanel.webview.js renders. */
function panelShape(index, task, r) {
    const verifierLine = r.verifier
        ? (r.verifier.pass ? `verifier PASS (${r.verifier.detail})` : `verifier FAIL — ${r.verifier.detail}`)
        : (r.verifyError ? `verifier error — ${r.verifyError}` : 'no verifiable artifact');
    return {
        index,
        id:            task.id,
        title:         task.title,
        brief:         task.brief,
        questId:       r.questId,
        scrollSummary: `[${r.verdict}] run status: ${r.status}; ${verifierLine}`,
        confidence:    r.scrollConfidence,
        findings:      [],
        openQuestions: [],
        llmCallCount:  r.economics.llmCalls,
        toolCallCount: r.economics.toolCalls,
        totalCostUSD:  r.economics.costUSD,
        totalUsage:    r.economics.tokens,
        durationMs:    r.economics.durationMs,
        state:         r.error ? 'error' : 'done',
        error:         r.error,
        gold:          r,
    };
}

module.exports = { TestSuiteRunner, SUITE };
