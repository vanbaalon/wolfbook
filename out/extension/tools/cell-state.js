'use strict';

// Shared cell-state vocabulary (feedback 2026-08-18 §4.3): a state word must
// claim only what the evidence supports. In particular:
//  - "evaluated-no-output" renders as "evaluated, no output" — never
//    "definition or suppressed expression", which asserts a reason the code
//    cannot know (and was actively misleading during the phantom-run bug).
//  - "dispatched-unconfirmed" / "not-dispatched" are honest uncertainty states;
//    they always carry a remedy so the agent can recover in one step.

const CELL_STATE = {
    NEVER_RUN: 'never-run',
    EVALUATED_WITH_OUTPUT: 'evaluated-with-output',
    EVALUATED_NO_OUTPUT: 'evaluated-no-output',
    EVALUATED_WITH_MESSAGES: 'evaluated-with-messages',
    FAILED: 'failed',
    ABORTED: 'aborted',
    STALE: 'stale',
    TIMEOUT: 'timeout',
    DISPATCHED_UNCONFIRMED: 'dispatched-unconfirmed',
    NOT_DISPATCHED: 'not-dispatched',
};

const _LABELS = {
    [CELL_STATE.NEVER_RUN]: '(not evaluated)',
    [CELL_STATE.EVALUATED_WITH_OUTPUT]: 'evaluated',
    [CELL_STATE.EVALUATED_NO_OUTPUT]: 'evaluated, no output',
    [CELL_STATE.EVALUATED_WITH_MESSAGES]: 'evaluated with kernel messages',
    [CELL_STATE.FAILED]: 'failed',
    [CELL_STATE.ABORTED]: 'aborted',
    [CELL_STATE.STALE]: 'source changed during evaluation (stale result)',
    [CELL_STATE.TIMEOUT]: 'timed out',
    [CELL_STATE.DISPATCHED_UNCONFIRMED]: 'dispatched but NOT confirmed to have reached the kernel',
    [CELL_STATE.NOT_DISPATCHED]: 'NOT executed',
};

/** Human/agent-readable label for a state. */
function stateLabel(state) {
    return _LABELS[state] || state || 'unknown';
}

/** Is this a state whose result the agent can trust as an actual evaluation? */
function isConfirmed(state) {
    return [
        CELL_STATE.EVALUATED_WITH_OUTPUT, CELL_STATE.EVALUATED_NO_OUTPUT,
        CELL_STATE.EVALUATED_WITH_MESSAGES, CELL_STATE.FAILED, CELL_STATE.ABORTED,
    ].includes(state);
}

/** Remedy line for the two unconfirmed states (empty string otherwise). */
function stateRemedy(state, { kernelLabel } = {}) {
    if (state === CELL_STATE.DISPATCHED_UNCONFIRMED) {
        return `The code was not confirmed to reach ${kernelLabel ? `kernel ${kernelLabel}` : 'the kernel'}. ` +
            'Verify with wolfbook_evaluateExpression (e.g. ValueQ of a symbol the cell defines), or re-run the cell.';
    }
    if (state === CELL_STATE.NOT_DISPATCHED) {
        return 'The cell was NOT executed. Re-run it; if this repeats, check the kernel binding ' +
            'with wolfbook_kernelManager action:"list" and bind the notebook explicitly.';
    }
    return '';
}

module.exports = { CELL_STATE, stateLabel, stateRemedy, isConfirmed };
