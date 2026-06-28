'use strict';
/**
 * Oberon — Circle finite-state machine.
 *
 * Pure functions. Caller is responsible for emitting `circle.transition`
 * events and persisting state via RunManager.
 *
 * The state graph from spec §5:
 *
 *   IDLE
 *     → BRIEFING            (start a run with a user brief)
 *     → QUEST_DEFINED       (Planner returns a valid Quest)
 *     → CHARM_DISPATCHED    (Dispatcher builds a Charm)         [MVP-2+]
 *     → FAIRY_WORKING       (one Fairy turn)                    [MVP-2+]
 *     → SCROLL_SUBMITTED    (Fairy returns a Scroll)            [MVP-2+]
 *     → REVIEWING           (Reviewer reads the Scroll)         [MVP-3+]
 *     → WARDS_REQUESTED     (Reviewer asks for wards)           [MVP-4+]
 *     → DECISION            (Reviewer emits a decision)         [MVP-3+]
 *     → GRIMOIRE_UPDATED    (Scribe commits Grimoire delta)     [MVP-4+]
 *     → IDLE                (or back to QUEST_DEFINED)
 *
 * Terminal: ABORTED, ERROR (any state → these).
 *
 * v1 implements only the IDLE↔BRIEFING↔QUEST_DEFINED↔IDLE slice for the
 * Planner-only path. The full graph is encoded here so later MVPs only need
 * to plug in agents — the FSM is already correct.
 */

const STATES = Object.freeze([
    'IDLE', 'BRIEFING', 'QUEST_DEFINED', 'CHARM_DISPATCHED',
    'FAIRY_WORKING', 'SCROLL_SUBMITTED', 'REVIEWING', 'WARDS_REQUESTED',
    'DECISION', 'GRIMOIRE_UPDATED', 'ABORTED', 'ERROR',
]);

// Allowed (from → set of valid to).
const GRAPH = Object.freeze({
    IDLE:              new Set(['BRIEFING']),
    BRIEFING:          new Set(['QUEST_DEFINED', 'IDLE']),  // IDLE = planner failed gracefully
    QUEST_DEFINED:     new Set(['CHARM_DISPATCHED', 'IDLE']),
    CHARM_DISPATCHED:  new Set(['FAIRY_WORKING']),
    FAIRY_WORKING:     new Set(['SCROLL_SUBMITTED']),
    SCROLL_SUBMITTED:  new Set(['REVIEWING', 'IDLE']),  // IDLE = MVP-2 graceful exit before Reviewer exists
    REVIEWING:         new Set(['DECISION', 'WARDS_REQUESTED', 'FAIRY_WORKING', 'IDLE']),
    //                                                          ^^^^^^^^^^^^^^ MVP-3: Skeptic disputes → Fairy revision
    //                                                                          ^^^^ MVP-3: Skeptic finalises directly
    WARDS_REQUESTED:   new Set(['CHARM_DISPATCHED']),
    DECISION:          new Set(['GRIMOIRE_UPDATED', 'QUEST_DEFINED', 'IDLE']),
    GRIMOIRE_UPDATED:  new Set(['IDLE', 'QUEST_DEFINED']),
    ABORTED:           new Set(['IDLE']),
    ERROR:             new Set(['IDLE']),
});

// ABORT and ERROR are reachable from any non-terminal state.
function canTransition(from, to) {
    if (!STATES.includes(from) || !STATES.includes(to)) return false;
    if (to === 'ABORTED' || to === 'ERROR') return from !== to;
    const allowed = GRAPH[from];
    return !!(allowed && allowed.has(to));
}

/**
 * Validate a proposed transition.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validate(from, to) {
    if (!STATES.includes(from)) return { ok: false, error: `unknown source state '${from}'` };
    if (!STATES.includes(to))   return { ok: false, error: `unknown target state '${to}'` };
    if (!canTransition(from, to)) {
        return { ok: false, error: `illegal transition: ${from} → ${to}` };
    }
    return { ok: true };
}

function isTerminal(state) { return state === 'IDLE' || state === 'ABORTED' || state === 'ERROR'; }

module.exports = { STATES, GRAPH, canTransition, validate, isTerminal };
