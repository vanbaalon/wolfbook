'use strict';
/**
 * Oberon — TestSuiteRunner.
 *
 * Runs the 10 standard test problems sequentially, collects per-test stats,
 * then calls the Fairy LLM to assess whether each problem was solved.  The
 * analytics call is NOT counted in costs (pricing: null).
 *
 * Events emitted:
 *   'started'          — suite begun
 *   'testStarted'      { index, test }
 *   'testDone'         { result }  (one per test, see _runOne return shape)
 *   'suiteComplete'    { results, analytics }
 *   'error'            Error
 */

const { EventEmitter } = require('events');
const { runOneResearch } = require('../core/research');
const { getAdapter }     = require('../providers');
const roles              = require('../config/roles');
const wolframShim        = require('../core/wolframShim');
const SUITE              = require('./suite');

class TestSuiteRunner extends EventEmitter {
    /**
     * @param {{
     *   bus:        import('../telemetry/bus').TelemetryBus,
     *   runManager: import('../core/runManager').RunManager,
     * }} opts
     */
    constructor({ bus, runManager }) {
        super();
        this._bus        = bus;
        this._runManager = runManager;
        this._running    = false;
        /** @type {AbortController|null} */
        this._outerAbort = null;
    }

    get isRunning() { return this._running; }

    /** Abort a running suite. */
    abort() {
        if (this._outerAbort) { try { this._outerAbort.abort(); } catch (_) {} }
    }

    /**
     * Run all 10 tests.  Resolves when complete (or on abort/error).
     * Safe to call while _running is true — returns immediately in that case.
     */
    async run() {
        if (this._running) return;
        this._running    = true;
        this._outerAbort = new AbortController();

        console.log('[testRunner] emitting started')
        this.emit('started');
        const results = [];

        // Preflight: kernel must be reachable for benchmark problems that need
        // verification. If the user hasn't started the kernel, fail fast with
        // a clear message rather than producing 10 low-confidence text-only
        // scrolls.
        try {
            const kStatus = wolframShim.kernelStatus();
            if (!kStatus.available) {
                const msg = `Wolfram kernel is not available (${kStatus.reason}). Start a kernel (open any .wb notebook) before running the test suite.`;
                try {
                    await this._bus.appendEvent('omen', {
                        kind: 'kernel_unavailable_preflight',
                        message: msg,
                    });
                } catch (_) {}
                this.emit('error', new Error(msg));
                this._running    = false;
                this._outerAbort = null;
                return;
            }
        } catch (e) {
            // Defensive: if preflight itself throws, fall through to run anyway.
        }

        try {
            for (let i = 0; i < SUITE.length; i++) {
                if (this._outerAbort.signal.aborted) break;
                const test = SUITE[i];
                this.emit('testStarted', { index: i, test });
                let result;
                try {
                    result = await this._runOne(i, test, this._outerAbort.signal);
                } catch (e) {
                    result = this._errorResult(i, test, e);
                }
                results.push(result);
                this.emit('testDone', { result });
            }

            // Analytics — ask LLM to assess each problem
            let analytics = null;
            try {
                analytics = await this._runAnalytics(results);
            } catch (e) {
                analytics = { error: String(e && e.message || e) };
            }

            this.emit('suiteComplete', { results, analytics });
        } catch (e) {
            this.emit('error', e);
        } finally {
            this._running    = false;
            this._outerAbort = null;
        }
    }

    // ── private ─────────────────────────────────────────────────────────────

    /**
     * @param {number} index
     * @param {{ id: string, title: string, brief: string }} test
     * @param {AbortSignal} signal
     */
    async _runOne(index, test, signal) {
        const { _bus: bus, _runManager: runManager } = this;
        const startedAt = Date.now();

        await runManager.beginRun({ brief: test.brief });
        let scroll = null;
        try {
            const res = await runOneResearch({ brief: test.brief, bus, runManager, signal });
            scroll = res.scroll;

            // Capture stats BEFORE endRun closes the bus run.
            const snap   = { ...runManager.summary };
            const events = bus.recent(50000);
            const toolCallCount = events.filter(e => e.type === 'tool.call').length;
            const concl = [...events].reverse().find(e => e.type === 'research.conclusion');
            const skEv  = [...events].reverse().find(e => e.type === 'skeptic.verdict');
            const obEv  = [...events].reverse().find(e => e.type === 'oberon.verdict');

            // Sample first 2 evidence items for analytics input.
            const evidenceSamples = (scroll && Array.isArray(scroll.evidence))
                ? scroll.evidence.slice(0, 2).map(e => ({
                    tool: e.tool, expression: e.expression, output: e.output, ok: !!e.ok,
                }))
                : [];

            await runManager.endRun({ state: 'IDLE' });

            return {
                index,
                id:           test.id,
                title:        test.title,
                brief:        test.brief,
                questId:      snap.questId || null,
                scrollSummary: (concl && concl.payload && concl.payload.summary) || (scroll && scroll.summary) || '',
                confidence:   (concl && concl.payload && typeof concl.payload.confidence === 'number')
                    ? concl.payload.confidence
                    : (scroll && typeof scroll.confidence === 'number' ? scroll.confidence : null),
                findings:     (concl && concl.payload && Array.isArray(concl.payload.findings))
                    ? concl.payload.findings.slice(0, 8)
                    : [],
                openQuestions: (concl && concl.payload && Array.isArray(concl.payload.openQuestions))
                    ? concl.payload.openQuestions.slice(0, 3)
                    : [],
                evidenceSamples,
                skepticVerdict:  skEv && skEv.payload && skEv.payload.verdict || null,
                skepticReason:   skEv && skEv.payload && (skEv.payload.objections || []).join('; ') || null,
                skepticChecks:   skEv && skEv.payload && skEv.payload.summary || null,
                oberonVerdict:   obEv && obEv.payload && obEv.payload.verdict || null,
                oberonReason:    obEv && obEv.payload && obEv.payload.narrative || null,
                oberonCounts:    obEv && obEv.payload && obEv.payload.counts || null,
                llmCallCount:  snap.llmCallCount  || 0,
                toolCallCount,
                totalCostUSD:  snap.totalCostUSD  || 0,
                totalUsage:    snap.totalUsage    || null,
                durationMs:    Date.now() - startedAt,
                state:        'done',
                error:        null,
            };

        } catch (e) {
            const aborted = runManager.isAborting
                || (e && e.kind === 'provider_error' && /abort/i.test(String(e.message)));
            const snap = { ...runManager.summary };
            if (runManager.isActive) {
                const targetState = aborted ? 'ABORTED' : 'ERROR';
                if (!aborted) {
                    try {
                        await bus.appendEvent('omen', {
                            kind:    (e && e.kind) || 'test_failed',
                            message: e && e.message || String(e),
                        });
                    } catch (_) {}
                }
                try { await runManager.transition(targetState); } catch (_) {}
                try { await runManager.endRun({ state: targetState }); } catch (_) {}
            }

            return this._errorResult(index, test, e, snap, Date.now() - startedAt);
        }
    }

    _errorResult(index, test, e, snap = null, durationMs = 0) {
        return {
            index,
            id:            test.id,
            title:         test.title,
            brief:         test.brief,
            questId:       snap && snap.questId || null,
            scrollSummary: '',
            confidence:    null,
            findings:      [],
            openQuestions: [],
            llmCallCount:  snap && snap.llmCallCount  || 0,
            toolCallCount: 0,
            totalCostUSD:  snap && snap.totalCostUSD  || 0,
            totalUsage:    snap && snap.totalUsage    || null,
            durationMs,
            state:         'error',
            error:         e && e.message || String(e),
        };
    }

    /**
     * Call the Fairy LLM to assess each result.
     * pricing: null → not counted in cost totals.
     */
    async _runAnalytics(results) {
        const binding = roles.resolveRole('fairy');
        if (!binding.configured) {
            return { text: '(analytics skipped — fairy role not configured)', modelCalled: false };
        }

        const adapter = getAdapter(binding.provider);

        const summaries = results.map((r, i) => {
            const allFindings = (r.findings || []).map(f => f.claim || f).filter(Boolean);
            const findingsBlock = allFindings.length
                ? allFindings.map((f, k) => `     ${k + 1}. ${String(f).slice(0, 400)}`).join('\n')
                : '     (none)';
            const evidenceBlock = (r.evidenceSamples && r.evidenceSamples.length)
                ? r.evidenceSamples.map((ev, k) =>
                    `     E${k + 1}. ${ev.ok ? 'OK' : 'FAIL'} ${String(ev.tool || '').slice(0, 20)} ` +
                    `expr=${String(ev.expression || '').slice(0, 120).replace(/\s+/g, ' ')}` +
                    ` => ${String(ev.output || '').slice(0, 240).replace(/\s+/g, ' ')}`).join('\n')
                : '     (none)';
            const skBlock = r.skepticVerdict
                ? `   Skeptic: ${r.skepticVerdict}` +
                  (r.skepticReason ? ` — ${String(r.skepticReason).slice(0, 240)}` : '') +
                  (r.skepticChecks ? ` (checks: ${r.skepticChecks.passed}/${r.skepticChecks.total})` : '')
                : '';
            const obBlock = r.oberonVerdict
                ? `   Oberon verdict: ${r.oberonVerdict}` +
                  (r.oberonReason ? ` — ${String(r.oberonReason).slice(0, 240)}` : '')
                : '';
            return `${i + 1}. [${r.id}] ${r.title}\n` +
                `   Brief: ${r.brief.slice(0, 200)}${r.brief.length > 200 ? '...' : ''}\n` +
                `   Status: ${r.state}${r.error ? ` (error: ${r.error})` : ''}\n` +
                `   Summary: ${r.scrollSummary ? r.scrollSummary.slice(0, 600) : '(none)'}\n` +
                `   Confidence: ${r.confidence !== null ? r.confidence.toFixed(3) : 'n/a'}\n` +
                `   Findings (${allFindings.length}):\n${findingsBlock}\n` +
                `   Evidence samples:\n${evidenceBlock}` +
                (skBlock ? `\n${skBlock}` : '') +
                (obBlock ? `\n${obBlock}` : '') +
                `\n   LLM calls: ${r.llmCallCount} | Tool calls: ${r.toolCallCount} | Cost: $${r.totalCostUSD.toFixed(4)}`;
        }).join('\n\n');

        const prompt = `You are evaluating an AI research agent's results on ${results.length} standard physics and mathematics benchmark problems.

For each problem below, assign a verdict and write one sentence of explanation that will appear directly in the results table.

Verdict definitions:
SUCCESS      = the agent produced a correct, complete, and verifiable answer to all main sub-tasks.
PARTIAL      = the agent made meaningful progress but the answer is incomplete, some sub-tasks are missing, or correctness is unverified.
FAILED       = the agent did not produce a useful answer (ran out of budget, wrong approach, no substantive result, or the summary is empty).
NEEDS_REVIEW = the run completed but the output is ambiguous — a human should check before accepting it.

Important: a run with state "done" does NOT automatically mean SUCCESS. Judge the content of the summary, the findings, the cited evidence outputs, and the Skeptic / Oberon verdict when present. If the Skeptic disputed the Scroll, lean toward NEEDS_REVIEW or PARTIAL; if the Oberon verdict was "success", lean SUCCESS but still verify the findings look substantive.

Results:

${summaries}

Reply with a JSON object (no prose, no fences) with this exact structure:
{
  "verdicts": [
    { "id": "TS01", "verdict": "SUCCESS|PARTIAL|FAILED|NEEDS_REVIEW", "reason": "one sentence visible to the user in the table" },
    ...
  ],
  "narrative": "2-3 sentences summarising what types of problems the agent handles well and where it struggles",
  "overallScore": "<success_count>/<total>"
}`;

        const resp = await adapter.chatComplete({
            model:     binding.model,
            messages:  [{ role: 'user', content: prompt }],
            maxTokens: 3000,
        }, { pricing: null });

        let parsed = null;
        try {
            // Strip markdown fences if present, then try strict parse
            const raw = (resp.content || '').replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            parsed = JSON.parse(raw);
        } catch (_) {
            // Fallback: extract verdicts from raw text via regex so the table
            // still shows badges even when the JSON is slightly malformed.
            try {
                const text = resp.content || '';
                const verdicts = [];
                const re = /"id"\s*:\s*"(TS\d+)"[^}]*"verdict"\s*:\s*"([A-Z_]+)"[^}]*"reason"\s*:\s*"([^"]+)"/g;
                let m;
                while ((m = re.exec(text)) !== null) {
                    verdicts.push({ id: m[1], verdict: m[2], reason: m[3] });
                }
                const narr = text.match(/"narrative"\s*:\s*"([^"]{10,})"/);
                const score = text.match(/"overallScore"\s*:\s*"([^"]+)"/);
                if (verdicts.length > 0) {
                    parsed = {
                        verdicts,
                        narrative:    narr  ? narr[1]  : '',
                        overallScore: score ? score[1] : '',
                        _partial: true,
                    };
                }
            } catch (_2) { /* silently ignore */ }
        }

        return {
            text:         resp.content || '',
            parsed,
            modelCalled:  true,
            model:        binding.model,
            inputTokens:  resp.usage && resp.usage.inputTokens  || 0,
            outputTokens: resp.usage && resp.usage.outputTokens || 0,
        };
    }
}

module.exports = { TestSuiteRunner, SUITE };
