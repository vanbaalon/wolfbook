'use strict';
/**
 * Oberon Fairy — compile and verify harness.
 *
 * compile(workDir, targetStepId, opts):
 *   Computes the dependency closure of targetStepId, runs static checks,
 *   writes clean.wb, and returns a compile result.
 *
 * verify(workDir, targetStepId, opts):
 *   Delegates to kernelVerifier.js to run fresh-kernel verification.
 *   Returns a classification and details for routing.
 *
 * No LLM calls. No vscode dependency.
 */

const { verifyCleanNotebook } = require('./kernelVerifier');

// ── Compile ───────────────────────────────────────────────────────────────

/**
 * Compute the transitive dependency closure of `targetStepId` within the
 * given steps array (valid steps only).
 *
 * @param {object[]} steps        - valid steps from workDir.loadValidSteps()
 * @param {string}   targetStepId
 * @param {string[]} includeSteps - force-include additional stepIds
 * @param {string[]} excludeSteps - force-exclude stepIds (rare override)
 * @returns {{ closure: Set<string>, ordered: object[], missing: string[] }}
 *   `ordered` = steps in recorded order (always topologically valid)
 *   `missing`  = stepIds referenced in dependsOn that don't exist in steps
 */
function computeClosure(steps, targetStepId, includeSteps = [], excludeSteps = []) {
    const byId = new Map(steps.map(s => [s.id, s]));

    if (!byId.has(targetStepId)) {
        return {
            closure:  new Set(),
            ordered:  [],
            missing:  [targetStepId],
        };
    }

    const closure = new Set([targetStepId, ...includeSteps]);
    const exclude = new Set(excludeSteps);

    // BFS: expand dependsOn transitively
    const queue = [...closure];
    const missing = [];
    while (queue.length) {
        const id = queue.shift();
        if (exclude.has(id)) continue;
        const step = byId.get(id);
        if (!step) {
            if (!missing.includes(id)) missing.push(id);
            continue;
        }
        for (const dep of (step.dependsOn || [])) {
            if (!closure.has(dep) && !exclude.has(dep)) {
                closure.add(dep);
                queue.push(dep);
            }
        }
    }

    // Remove excluded from closure
    for (const ex of exclude) closure.delete(ex);

    // Ordered: filter recorded-order list down to closure
    const ordered = steps.filter(s => closure.has(s.id));

    return { closure, ordered, missing };
}

/**
 * Run static checks on a proposed closure:
 *   1. Redefinition conflict: two steps define the same symbol → resolve
 *      deterministically by last-definition-wins (linear-notebook semantics).
 *      The harness drops earlier redundant definers; the caller re-runs
 *      closure computation. The model is never involved in this decision.
 *   2. Missing dependency: step uses a symbol not defined in closure — but
 *      some OTHER valid step defines it → add to closure (auto-extend).
 *   3. Missing dependency with no known step → symbol_not_in_closure warning
 *      (verifier will catch genuine runtime failures).
 *
 * @param {object[]} closureSteps   - steps in the current closure (ordered)
 * @param {object[]} allValidSteps  - all valid steps (for auto-extend lookup)
 * @returns {{
 *   ok: boolean,
 *   extendedWith: string[],      // stepIds auto-added to resolve missing deps
 *   dropRedefsWith: string[],    // stepIds to DROP because a later step redefines their symbol
 *   diagnose: boolean,           // route to Diagnose (only genuinely unresolvable errors)
 *   diagnostics: object[]        // array of { type, symbol, stepId?, details }
 * }}
 */
function staticCheck(closureSteps, allValidSteps) {
    // Build "who defines what" maps
    // closureDefines tracks the LAST (winning) definer: we overwrite on each
    // encounter so closureDefines[sym] ends up as the latest step id.
    const closureDefines = new Map();   // symbol → latest stepId in closure
    const allDefines     = new Map();   // symbol → first stepId anywhere

    for (const s of closureSteps) {
        for (const sym of (s.definesSymbols || [])) {
            closureDefines.set(sym, s.id);   // intentionally overwrites — last wins
        }
    }
    for (const s of allValidSteps) {
        for (const sym of (s.definesSymbols || [])) {
            if (!allDefines.has(sym)) allDefines.set(sym, s.id);
        }
    }

    const diagnostics   = [];
    const extendedWith  = [];
    const dropRedefsWith = [];
    let   diagnose      = false;

    // Check 1: redefinition conflicts — resolve last-definition-wins.
    // For each symbol defined by more than one step, keep only the LATEST
    // definer (last in recorded order = last in closureSteps). Drop all
    // earlier definers from the closure so clean.wb runs without symbol
    // shadowing surprises. This matches linear-notebook semantics and
    // never triggers Diagnose.
    const redefinitions = new Map();  // symbol → [stepId, ...] in recorded order
    for (const s of closureSteps) {
        for (const sym of (s.definesSymbols || [])) {
            if (!redefinitions.has(sym)) redefinitions.set(sym, []);
            redefinitions.get(sym).push(s.id);
        }
    }
    for (const [sym, ids] of redefinitions) {
        if (ids.length > 1) {
            const keptStep    = ids[ids.length - 1];   // latest — the winner
            const droppedSteps = ids.slice(0, -1);     // earlier — redundant definers
            for (const dropped of droppedSteps) {
                if (!dropRedefsWith.includes(dropped)) dropRedefsWith.push(dropped);
            }
            diagnostics.push({
                type:         'redefinition_resolved',
                symbol:       sym,
                keptStep,
                droppedSteps,
                details:      `Symbol '${sym}' multiply defined — keeping last definer '${keptStep}', dropping: ${droppedSteps.join(', ')}`,
            });
        }
    }

    // Check 2: missing dependencies
    for (const s of closureSteps) {
        for (const sym of (s.usesSymbols || [])) {
            if (closureDefines.has(sym)) continue;  // defined in closure — ok
            // Not in closure. Is it defined by some other valid step?
            if (allDefines.has(sym)) {
                const defStepId = allDefines.get(sym);
                if (!extendedWith.includes(defStepId)) {
                    extendedWith.push(defStepId);
                    diagnostics.push({
                        type:     'auto_extend',
                        symbol:   sym,
                        stepId:   defStepId,
                        usedBy:   s.id,
                        details:  `'${sym}' used by step '${s.id}' is defined by '${defStepId}' (auto-extending closure)`,
                    });
                }
            } else {
                // No step defines this symbol — could be a WL built-in missed by
                // the blocklist, or a genuine missing dep. Flag as warning only
                // (not diagnose) — the verifier will surface real missing-symbol errors.
                diagnostics.push({
                    type:    'symbol_not_in_closure',
                    symbol:  sym,
                    usedBy:  s.id,
                    details: `'${sym}' used by step '${s.id}' has no defining step (may be a built-in or external — verifier will catch it)`,
                });
            }
        }
    }

    return {
        ok:              !diagnose,
        extendedWith,
        dropRedefsWith,
        diagnose,
        diagnostics,
    };
}

/**
 * Compile phase: compute closure, run static checks (with auto-extend),
 * write clean.wb.
 *
 * Returns a compile result object. Does not call the verifier.
 *
 * @param {import('./workDir').WorkDir} workDir
 * @param {string} targetStepId
 * @param {{ includeSteps?: string[], excludeSteps?: string[], taskTitle?: string, inputs?: object[], assumptions?: object[] }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   phase: 'verify' | 'diagnose',
 *   closureSteps: object[],
 *   diagnostics: object[],
 *   cleanNbPath: string | null,
 *   targetStepMissing: boolean,
 * }>}
 */
async function compile(workDir, targetStepId, opts = {}) {
    const { includeSteps = [], excludeSteps = [], taskTitle, inputs, assumptions, writeNotebook, skillsBlock } = opts;

    const allValid = await workDir.loadValidSteps();
    const loadedInputs      = inputs      ?? await workDir.loadInputs();
    const loadedAssumptions = assumptions ?? await workDir.loadAssumptions();
    const loadedUtils       = await workDir.loadUtils().catch(() => []);

    // The recorded chain IS the curated derivation — the model only records steps it
    // will build on. So clean.wb should contain ALL recorded valid steps (in order),
    // not just the dependency closure of the target. A purely-literal final step (e.g.
    // `result = {…}`) has no dependsOn and would otherwise orphan the whole derivation.
    // We seed the closure with every valid step; excludeSteps still prunes, and the
    // redefinition last-wins logic still applies.
    const allStepIds = allValid.map(s => s.id);
    const effectiveInclude = [...new Set([...allStepIds, ...includeSteps])];

    // Initial closure
    let { closure, ordered, missing } = computeClosure(allValid, targetStepId, effectiveInclude, excludeSteps);

    if (missing.includes(targetStepId)) {
        return {
            ok:                 false,
            phase:              'diagnose',
            closureSteps:       [],
            diagnostics:        [{ type: 'target_missing', stepId: targetStepId, details: `Target step '${targetStepId}' not found in valid steps` }],
            cleanNbPath:        null,
            targetStepMissing:  true,
        };
    }

    const allDiagnostics = [];
    let   autoExtendRounds = 0;
    // Accumulate exclusions from last-wins redefinition resolution across rounds.
    const resolvedExcludes = new Set(excludeSteps);

    // Iterative stabilisation: each pass may extend closure (auto-extend missing
    // deps) or shrink it (drop redundant redefinition steps). Loop until stable.
    while (true) {
        const check = staticCheck(ordered, allValid);
        allDiagnostics.push(...check.diagnostics);

        if (check.diagnose) {
            return {
                ok:                false,
                phase:             'diagnose',
                closureSteps:      ordered,
                diagnostics:       allDiagnostics,
                cleanNbPath:       null,
                targetStepMissing: false,
            };
        }

        const needsChange = check.extendedWith.length > 0 || check.dropRedefsWith.length > 0;
        if (!needsChange) break;  // stable

        // Apply redefinition drops (last-wins): exclude earlier redundant definers.
        for (const id of check.dropRedefsWith) {
            resolvedExcludes.add(id);
        }

        // Apply auto-extends (missing deps).
        for (const id of check.extendedWith) {
            closure.add(id);
        }

        // Re-compute closure with updated include + exclude sets.
        const expanded = computeClosure(allValid, targetStepId, [...closure], [...resolvedExcludes]);
        closure  = expanded.closure;
        ordered  = expanded.ordered;

        if (++autoExtendRounds > 10) {
            // Safety guard against infinite loops in pathological dep graphs
            allDiagnostics.push({ type: 'auto_extend_limit', details: 'Auto-extend exceeded 10 rounds — possible dep cycle' });
            break;
        }
    }

    // Step 1: Always write clean.wb as raw JSON to disk first.
    // run_clean reads the file via fsp.readFile, so it must be on disk before the
    // polish phase starts. The VS Code writeNotebook callback (step 2) may overwrite
    // the file, but step 1 guarantees a readable file at polish entry.
    const suppressionCode = require('../core/wolframShim').buildSuppressionCode();
    const cleanNbPath = await workDir.writeCleanNotebook({
        steps:       ordered,
        inputs:      loadedInputs,
        assumptions: loadedAssumptions,
        taskTitle,
        utils:       loadedUtils,
        skillsBlock,
        suppressionCode,
    });

    // Step 2: If a VS Code API callback is provided, open the notebook as a live
    // notebook document so the user sees it with proper cell rendering.
    // Non-fatal: run_clean still works even if the callback fails.
    if (typeof writeNotebook === 'function') {
        const { buildCleanCells } = require('./workDir');
        const cells = buildCleanCells({ steps: ordered, inputs: loadedInputs, assumptions: loadedAssumptions, taskTitle, utils: loadedUtils, skillsBlock, suppressionCode });
        await writeNotebook(cells, workDir.cleanNb).catch(() => {});
    }

    return {
        ok:                true,
        phase:             'verify',
        closureSteps:      ordered,
        diagnostics:       allDiagnostics,
        cleanNbPath,
        targetStepMissing: false,
    };
}

// ── Verify ────────────────────────────────────────────────────────────────

/**
 * Verify phase: call kernelVerifier to replay clean.wb in a fresh kernel.
 *
 * @param {import('./workDir').WorkDir} workDir
 * @param {string} targetStepId
 * @param {string} recordedValue  - the InputForm string from results/<probeId>.json
 * @param {{ wolframscriptBin: string, numeric_tol?: number, timeoutPerCell?: number }} opts
 * @returns {Promise<{
 *   classification: 'delivered' | 'missing_step' | 'cell_errored' | 'output_differs',
 *   firstFailureCell: string | null,
 *   freshOutput: string | null,
 *   recordedOutput: string | null,
 *   messages: string[] | null,
 *   details: string,
 * }>}
 */
async function verify(workDir, targetStepId, recordedValue, opts = {}) {
    return verifyCleanNotebook(workDir.cleanNb, targetStepId, recordedValue, opts);
}

// ── Auto-correct (missing_step) ───────────────────────────────────────────

/**
 * Attempt to auto-correct a `missing_step` verify result by finding which
 * valid step defines the missing symbol and re-compiling with it included.
 *
 * Returns the extended includeSteps list if auto-correct is possible, or null.
 *
 * @param {{ classification: string, firstFailureCell: string | null, freshOutput: string | null }} verifyResult
 * @param {object[]} allValidSteps
 * @param {string[]} currentIncludeSteps
 * @returns {string[] | null}  updated includeSteps, or null if cannot auto-correct
 */
function autoCorrectMissingStep(verifyResult, allValidSteps, currentIncludeSteps) {
    if (verifyResult.classification !== 'missing_step') return null;

    // Extract the undefined symbol from the fresh output / error message
    // Wolfram typically says: "Symbol 'foo' in context 'Global`' is not defined."
    // or "foo::shdw" / "foo is not defined"
    const raw = verifyResult.freshOutput || '';
    // Handles both:
    //   "Symbol "foo" is not defined"
    //   "Symbol "foo" in context "Global`" is not defined"
    const symbolMatch = raw.match(/Symbol\s+"?([A-Za-z$][A-Za-z0-9$`]*)"?[^\n]*\bis\s+not\s+defined/)
        || raw.match(/"([A-Za-z$][A-Za-z0-9$`]*)"\s+is\s+undefined/)
        || raw.match(/^([A-Za-z$][A-Za-z0-9$`]*)::shdw/m);

    if (!symbolMatch) return null;

    const sym = symbolMatch[1].replace(/`[^`]*$/, '');  // strip context prefix

    // Find a valid step that defines this symbol and is not yet in the closure
    for (const s of allValidSteps) {
        if ((s.definesSymbols || []).includes(sym) && !currentIncludeSteps.includes(s.id)) {
            return [...currentIncludeSteps, s.id];
        }
    }
    return null;
}

module.exports = { compile, verify, computeClosure, staticCheck, autoCorrectMissingStep };
