'use strict';
/**
 * Oberon Fairy — finite state machine.
 *
 * Tracks current phase, budgets, and enforces the probe-reserve rule:
 *   - During Explore: effective probe budget = probe_budget - diagnose_probe_reserve
 *   - During Diagnose: the reserve probes become available
 *
 * Phases: intake → explore → compile → polish → delivered | failed | escalate
 *                                             → diagnose → explore | compile | failed | escalate
 *
 * Polish phase: agent must call run_clean (allClean: true) before emitting clean_verified.
 *
 * The FSM is a plain synchronous object — no async, no I/O. Callers (harness,
 * Fairy loop) read state and call transition/consume methods.
 */

const VALID_PHASES = new Set([
    'intake', 'explore', 'compile', 'verify', 'polish',
    'diagnose', 'delivered', 'failed', 'escalate',
    'partial_report', 'partial_delivered',
]);

const TERMINAL_PHASES = new Set(['delivered', 'failed', 'escalate', 'partial_delivered']);

const DEFAULTS = {
    // probe_budget/max_turns raised 40→60 / 80→120 (2026-08-02): a verified
    // research-grade run (TS03, run 21-32-31) legitimately needed 56 probes and
    // forced two continuation dialogs; trivial tasks don't consume the slack.
    probe_budget:                60,
    diagnose_probe_reserve:      3,
    max_turns:                   120,
    max_backtracks:              3,
    max_diagnose_turns:          6,
    numeric_tol:                 1e-10,
    verify_auto_correct:         2,
    polish_run_clean_max:        6,   // max run_clean calls in polish phase
    polish_turns_max:            12,  // max model turns in polish phase
    partial_report_turns_max:    6,   // bonus turns for writing clean_partial.wb
};

class FairyFSM {
    /**
     * @param {Partial<typeof DEFAULTS>} [cfg]
     */
    constructor(cfg = {}) {
        const c                         = { ...DEFAULTS, ...cfg };
        this._probe_budget              = c.probe_budget;
        this._diagnose_probe_reserve    = c.diagnose_probe_reserve;
        this._max_turns                 = c.max_turns;
        this._max_backtracks            = c.max_backtracks;
        this._max_diagnose_turns        = c.max_diagnose_turns;
        this._verify_auto_correct       = c.verify_auto_correct;
        this._polish_run_clean_max          = c.polish_run_clean_max;
        this._polish_turns_max              = c.polish_turns_max;
        this._partial_report_turns_max      = c.partial_report_turns_max;

        // public (readable by harness/loop)
        this.numeric_tol                = c.numeric_tol;
        this.verify_auto_correct_limit  = c.verify_auto_correct;

        // mutable state
        this._phase                     = 'intake';
        this._probes_used               = 0;
        this._turns_used                = 0;
        this._backtracks_used           = 0;
        this._diagnose_turns_used       = 0;
        this._verify_corrections_used   = 0;
        this._polish_run_cleans_used    = 0;
        this._polish_turns_used         = 0;
        this._partial_report_turns_used = 0;

        // phase history for diagnostics / telemetry
        this._phase_history             = ['intake'];
    }

    // ── Phase ─────────────────────────────────────────────────────────────

    get phase() { return this._phase; }

    get isTerminal() { return TERMINAL_PHASES.has(this._phase); }

    /**
     * Transition to a new phase. Resets per-phase counters where applicable.
     * @param {'intake'|'explore'|'compile'|'verify'|'diagnose'|'delivered'|'failed'|'escalate'} newPhase
     */
    transitionTo(newPhase) {
        if (!VALID_PHASES.has(newPhase) && !TERMINAL_PHASES.has(newPhase)) throw new Error(`Unknown phase: '${newPhase}'`);
        if (TERMINAL_PHASES.has(this._phase)) {
            throw new Error(`Cannot leave terminal phase '${this._phase}'`);
        }
        if (newPhase === 'diagnose') {
            this._diagnose_turns_used = 0;  // reset per Diagnose entry
        }
        if (newPhase === 'partial_report') {
            this._partial_report_turns_used = 0;
        }
        this._phase = newPhase;
        this._phase_history.push(newPhase);
    }

    // ── Probe budget ──────────────────────────────────────────────────────

    get probesUsed()     { return this._probes_used; }
    get probesRemaining() {
        return Math.max(0, this._probe_budget - this._probes_used);
    }
    get exploreProbesRemaining() {
        // In Explore, the reserve is withheld
        return Math.max(0, this._probe_budget - this._diagnose_probe_reserve - this._probes_used);
    }
    get diagnoseProbesRemaining() {
        return Math.max(0, this._probe_budget - this._probes_used);
    }

    /**
     * Can the model call `probe` right now?
     * Explore: must leave at least diagnose_probe_reserve.
     * Diagnose: can use the full remaining budget (including reserve).
     */
    canProbe() {
        if (this._phase === 'explore') {
            return this.exploreProbesRemaining > 0;
        }
        if (this._phase === 'diagnose') {
            return this.diagnoseProbesRemaining > 0;
        }
        return false;
    }

    consumeProbe() {
        if (!this.canProbe()) {
            throw new Error(`probe budget exhausted (phase=${this._phase}, used=${this._probes_used}/${this._probe_budget})`);
        }
        this._probes_used++;
    }

    // ── Turn counter ──────────────────────────────────────────────────────

    get turnsUsed()      { return this._turns_used; }
    get turnsRemaining() { return Math.max(0, this._max_turns - this._turns_used); }

    canTurn() { return !this.isTerminal && this.turnsRemaining > 0; }

    incrementTurn() {
        this._turns_used++;
        if (this._phase === 'diagnose') {
            this._diagnose_turns_used++;
        }
    }

    /**
     * Extend the run's budget without losing any recorded state — used when the user
     * opts to "continue" after exhaustion/escalation. Adds to the probe and turn caps
     * so the agent can resume Explore from where it left off.
     * @param {{ probes?: number, turns?: number, backtracks?: number }} extra
     */
    grantMoreBudget({ probes = 0, turns = 0, backtracks = 0, polishTurns = 0, polishRunCleans = 0 } = {}) {
        this._probe_budget        += Math.max(0, probes);
        this._max_turns           += Math.max(0, turns);
        this._max_backtracks      += Math.max(0, backtracks);
        this._polish_turns_max    += Math.max(0, polishTurns);
        this._polish_run_clean_max += Math.max(0, polishRunCleans);
        return { probeBudget: this._probe_budget, maxTurns: this._max_turns };
    }

    // ── Backtrack counter ─────────────────────────────────────────────────

    get backtracksUsed()      { return this._backtracks_used; }
    get backtracksRemaining() { return Math.max(0, this._max_backtracks - this._backtracks_used); }

    canBacktrack() { return this.backtracksRemaining > 0; }

    consumeBacktrack() {
        if (!this.canBacktrack()) {
            throw new Error(`max_backtracks exhausted (used=${this._backtracks_used}/${this._max_backtracks})`);
        }
        this._backtracks_used++;
    }

    // ── Diagnose-turn limit ────────────────────────────────────────────────

    get diagnose_turns_used()     { return this._diagnose_turns_used; }
    get diagnose_turns_remaining() { return Math.max(0, this._max_diagnose_turns - this._diagnose_turns_used); }

    canDiagnoseTurn() {
        return this._phase === 'diagnose' && this.diagnose_turns_remaining > 0;
    }

    // ── Verify auto-correct ───────────────────────────────────────────────

    get verifyCorrectionsUsed()      { return this._verify_corrections_used; }
    get verifyCorrectionsRemaining() { return Math.max(0, this._verify_auto_correct - this._verify_corrections_used); }

    canAutoCorrect() { return this.verifyCorrectionsRemaining > 0; }

    consumeAutoCorrect() {
        if (!this.canAutoCorrect()) {
            throw new Error(`verify_auto_correct limit reached (used=${this._verify_corrections_used}/${this._verify_auto_correct})`);
        }
        this._verify_corrections_used++;
    }

    // ── Polish phase ──────────────────────────────────────────────────────────

    get polishRunCleansUsed()      { return this._polish_run_cleans_used; }
    get polishRunCleansRemaining() { return Math.max(0, this._polish_run_clean_max - this._polish_run_cleans_used); }
    get polishTurnsUsed()          { return this._polish_turns_used; }
    get polishTurnsRemaining()     { return Math.max(0, this._polish_turns_max - this._polish_turns_used); }

    canPolishRunClean()   { return this.polishRunCleansRemaining > 0; }
    canPolishTurn()       { return this.polishTurnsRemaining > 0; }

    consumePolishRunClean() {
        if (!this.canPolishRunClean()) {
            throw new Error(`polish run_clean limit reached (used=${this._polish_run_cleans_used}/${this._polish_run_clean_max})`);
        }
        this._polish_run_cleans_used++;
    }

    incrementPolishTurn() {
        this._polish_turns_used++;
        this._turns_used++;  // also counts against total turns
    }

    // ── Partial-report phase ──────────────────────────────────────────────────

    get partialReportTurnsUsed()      { return this._partial_report_turns_used; }
    get partialReportTurnsRemaining() { return Math.max(0, this._partial_report_turns_max - this._partial_report_turns_used); }

    canPartialReportTurn() { return this.partialReportTurnsRemaining > 0; }

    incrementPartialReportTurn() {
        this._partial_report_turns_used++;
        this._turns_used++;
    }

    // ── Budget summary (for model context injection) ───────────────────────

    getBudgetStatus() {
        return {
            phase:                        this._phase,
            probesUsed:                   this._probes_used,
            probesRemaining:              this.probesRemaining,
            exploreProbesRemaining:       this.exploreProbesRemaining,
            diagnoseProbesRemaining:      this.diagnoseProbesRemaining,
            turnsUsed:                    this._turns_used,
            turnsRemaining:               this.turnsRemaining,
            backtracksUsed:               this._backtracks_used,
            backtracksRemaining:          this.backtracksRemaining,
            diagnoseTurnsUsed:            this._diagnose_turns_used,
            diagnoseTurnsRemaining:       this.diagnose_turns_remaining,
            polishRunCleansUsed:          this._polish_run_cleans_used,
            polishRunCleansRemaining:     this.polishRunCleansRemaining,
            polishTurnsRemaining:         this.polishTurnsRemaining,
            partialReportTurnsRemaining:  this.partialReportTurnsRemaining,
        };
    }

    get phaseHistory() { return [...this._phase_history]; }
}

module.exports = { FairyFSM, DEFAULTS };
