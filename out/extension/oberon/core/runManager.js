'use strict';
/**
 * Oberon — RunManager.
 *
 * Owns the lifecycle of the (at most one, v1) active Oberon run. Holds the
 * RunSummary snapshot, dispatches events to subscribers (the two UI surfaces),
 * and is the single touch-point through which `extension.js` interacts with
 * Oberon's runtime state.
 *
 * v1: one active run per workspace. (Future: indexed by notebook URI.)
 */

const { EventEmitter } = require('events');
const fsp     = require('fs/promises');
const path    = require('path');

const project  = require('../memory/project');
const circle   = require('./circle');
const settings = require('../config/settings');

class RunManager extends EventEmitter {
    /**
     * @param {import('../telemetry/bus').TelemetryBus} bus
     */
    constructor(bus) {
        super();
        this.setMaxListeners(64);
        this._bus = bus;
        /** @type {import('./types').RunSummary | null} */
        this._summary = null;
        /** @type {boolean} */
        this._aborting = false;
        /** @type {AbortController|null} active long-running operation */
        this._abort = null;
        /** @type {boolean} true once a per-run budget cap has been breached */
        this._budgetExhausted = false;

        // Mirror every bus event into our own listeners and update the summary.
        bus.on('event', (ev) => this._onBusEvent(ev));
        bus.on('runBegin', ({ runId }) => this.emit('runBegin', runId));
        bus.on('runEnd',   ({ runId }) => this.emit('runEnd',   runId));
    }

    /** @returns {import('./types').RunSummary | null} */
    get summary() { return this._summary; }

    /** @returns {boolean} */
    get isActive() {
        return !!this._summary && this._summary.state !== 'IDLE'
            && this._summary.state !== 'ABORTED' && this._summary.state !== 'ERROR';
    }

    /** Begin a new run. Resolves once telemetry is open. */
    async beginRun({ brief = null } = {}) {
        if (this.isActive) {
            throw new Error('Oberon: a run is already active. Abort it first.');
        }
        const runId = project.makeRunId();
        await this._bus.beginRun(runId);
        this._summary = {
            runId,
            startedAt: new Date().toISOString(),
            endedAt: null,
            state: 'BRIEFING',
            questId: null,
            charmId: null,
            eventCount: 0,
            llmCallCount: 0,
            totalCostUSD: 0,
            totalUsage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            },
        };
        this._aborting = false;
        this._budgetExhausted = false;
        await this._bus.appendEvent('circle.transition', {
            from: 'IDLE', to: 'BRIEFING', brief: brief ? String(brief).slice(0, 4000) : null,
        });
        this.emit('summary', this._summary);
        await this._persistState();
        return this._summary;
    }

    /** End the active run cleanly. */
    async endRun({ state = 'IDLE' } = {}) {
        if (!this._summary) return;
        await this._bus.appendEvent('circle.transition', {
            from: this._summary.state, to: state,
        });
        this._summary.state   = state;
        this._summary.endedAt = new Date().toISOString();
        await this._bus.flush();
        await this._bus.endRun();
        this.emit('summary', this._summary);
        await this._persistState();
    }

    /** Request abort of the active run. Marks state; consumers must honour. */
    async abortRun(reason = 'user') {
        if (!this._summary) return;
        this._aborting = true;
        try { if (this._abort) this._abort.abort(); } catch (_) {}
        await this._bus.appendEvent('omen', { kind: 'abort_requested', message: `Abort requested by ${reason}` });
        await this.endRun({ state: 'ABORTED' });
    }

    get isAborting() { return this._aborting; }
    /** True once a per-run budget cap fired during this run. */
    get isBudgetExhausted() { return this._budgetExhausted; }

    /**
     * Attach an AbortController for the current in-flight operation so the
     * Abort button can interrupt it. Returns the controller for convenience.
     * @returns {AbortController}
     */
    newAbortController() {
        this._abort = new AbortController();
        return this._abort;
    }
    clearAbortController() { this._abort = null; }

    /**
     * FSM-validated transition. Emits a `circle.transition` event on success.
     * On invalid transitions emits an `omen{kind:'illegal_transition'}` and
     * leaves the state unchanged so the run keeps going safely.
     *
     * @param {string} to
     * @param {object} [payload] extra fields (e.g. {questId})
     */
    async transition(to, payload = {}) {
        if (!this._summary) throw new Error('transition: no active run');
        const from = this._summary.state;
        const v = circle.validate(from, to);
        if (!v.ok) {
            await this._bus.appendEvent('omen', {
                kind: 'illegal_transition',
                message: v.error,
                detail: { from, to },
            });
            return false;
        }
        await this._bus.appendEvent('circle.transition', { from, to, ...payload });
        // _onBusEvent will mirror the new state into the summary.
        return true;
    }

    /** Drop the current run from memory (file is preserved). */
    forget() {
        this._summary = null;
        this._aborting = false;
        this.emit('summary', null);
    }

    /** @returns {object[]} most recent telemetry events */
    recentEvents(limit) { return this._bus.recent(limit); }

    /**
     * Restore the last RunSummary written by `_persistState()`.
     * Does NOT reopen the JSONL file; the run is treated as historical.
     */
    async restoreLastSummary() {
        const p = project.stateFilePath();
        if (!p) return null;
        try {
            const raw = await fsp.readFile(p, 'utf8');
            const obj = JSON.parse(raw);
            if (obj && obj.runId) {
                this._summary = obj;
                // Restored runs are dormant — caller decides whether to resume.
                this._summary.state = obj.state || 'IDLE';
                this.emit('summary', this._summary);
                return this._summary;
            }
        } catch (_) { /* no prior state, fine */ }
        return null;
    }

    // ── internals ───────────────────────────────────────────────────────────

    async _persistState() {
        const p = project.stateFilePath();
        if (!p || !this._summary) return;
        try {
            await project.ensureOberonLayout();
            const tmp = p + '.tmp';
            await fsp.writeFile(tmp, JSON.stringify(this._summary, null, 2), 'utf8');
            await fsp.rename(tmp, p);
        } catch (_) { /* best-effort */ }
    }

    _onBusEvent(ev) {
        if (!this._summary) return;
        this._summary.eventCount += 1;
        if (ev.type === 'circle.transition' && ev.payload && ev.payload.to) {
            this._summary.state = ev.payload.to;
        }
        if (ev.questId) this._summary.questId = ev.questId;
        if (ev.charmId) this._summary.charmId = ev.charmId;
        if (ev.type === 'llm.call' && ev.payload) {
            this._summary.llmCallCount += 1;
            const u = ev.payload.usage || {};
            const t = this._summary.totalUsage;
            t.inputTokens      += Number(u.inputTokens      || 0);
            t.outputTokens     += Number(u.outputTokens     || 0);
            if (u.cacheReadTokens  != null) t.cacheReadTokens  += Number(u.cacheReadTokens);
            if (u.cacheWriteTokens != null) t.cacheWriteTokens += Number(u.cacheWriteTokens);
            if (typeof ev.payload.costUSD === 'number') {
                this._summary.totalCostUSD += ev.payload.costUSD;
            }
            this._checkRunBudget();
        }
        this.emit('summary', this._summary);
        // Persist asynchronously; no await — best-effort.
        this._persistState();
    }

    /**
     * Check whether the cumulative run cost / LLM-call count has breached
     * the per-run budget. If so, mark the run as budget-exhausted, abort the
     * active controller (so in-flight LLM/tool work cancels), and emit a
     * single `budget.exhausted` event. Subsequent budget checks are no-ops.
     * Caller is responsible for synthesising a fallback Scroll.
     */
    _checkRunBudget() {
        if (this._budgetExhausted || !this._summary) return;
        let budget;
        try { budget = settings.runBudget(); } catch (_) { return; }
        if (!budget) return;
        const overUSD   = Number(budget.runUSD)      > 0 && this._summary.totalCostUSD  >= Number(budget.runUSD);
        const overCalls = Number(budget.runLlmCalls) > 0 && this._summary.llmCallCount  >= Number(budget.runLlmCalls);
        if (!overUSD && !overCalls) return;
        this._budgetExhausted = true;
        // We deliberately do NOT abort the in-flight controller here — that
        // would also kill the downstream Skeptic/Wards/Scribe phases that
        // produce the user-visible Verdict. Instead we let the current LLM
        // call complete and rely on cooperative breakout: callers observe
        // `isBudgetExhausted` / the emitted event and stop scheduling new
        // expensive work.
        this._bus.appendEvent('budget.exhausted', {
            kind:          overUSD ? 'run_usd' : 'run_llm_calls',
            limitUSD:      Number(budget.runUSD) || null,
            limitLlmCalls: Number(budget.runLlmCalls) || null,
            totalCostUSD:  this._summary.totalCostUSD,
            llmCallCount:  this._summary.llmCallCount,
            message: overUSD
                ? `Per-run cost cap reached: $${this._summary.totalCostUSD.toFixed(4)} ≥ $${Number(budget.runUSD).toFixed(2)}. Aborting in-flight work; a fallback Scroll will be synthesised.`
                : `Per-run LLM-call cap reached: ${this._summary.llmCallCount} ≥ ${Number(budget.runLlmCalls)}. Aborting in-flight work; a fallback Scroll will be synthesised.`,
        }, { questId: this._summary.questId, charmId: this._summary.charmId }).catch(() => {});
    }
}

module.exports = { RunManager };
