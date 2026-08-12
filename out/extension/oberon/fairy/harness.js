'use strict';
/**
 * Oberon Fairy — compile and verify harness.
 *
 * compile(workDir, targetStepId, opts):
 *   Computes the dependency closure of targetStepId, runs static checks,
 *   writes clean.wb, and returns a compile result.
 *
 * (The old verify()/kernelVerifier subprocess path was removed 2026-08-01 —
 *  run_clean via the NotebookController is the live fresh-kernel replay.)
 *
 * No LLM calls. No vscode dependency.
 */

const { analyzeCode } = require('./depAnalyzer');

// ── Topological ordering (H1, run Q_3VRPXL) ────────────────────────────────
//
// Steps are recorded in EXPLORATION order, which is NOT dependency order: the
// model routinely records a corrected definition (gmGens) AFTER the steps that
// use it. clean.wb replays cells top-to-bottom, so exploration order fails on a
// fresh kernel with "symbol undefined" cascades that polish cannot repair
// (edit_cell cannot move cells). Sort the closure by symbol-level dependency
// edges (definer → user), stable w.r.t. recorded order; on a cycle, fall back
// to recorded order for the tangled remainder and emit a diagnostic.

/**
 * @param {object[]} steps        closure steps in recorded order
 * @param {object[]} diagnostics  mutated: receives {type:'reordered'|'dependency_cycle'}
 * @returns {object[]}            dependency-ordered steps
 */
function topoSortSteps(steps, diagnostics = []) {
    const n = steps.length;
    if (n <= 1) return steps.slice();

    // Last definer wins (matches the redefinition resolution): symbol → step index.
    const definerOf = new Map();
    steps.forEach((s, i) => {
        for (const sym of (s.definesSymbols || [])) definerOf.set(sym, i);
    });

    // Edges: definer → user (symbol-level) ∪ dependsOn (id-level).
    const idIndex = new Map(steps.map((s, i) => [s.id, i]));
    const adj = Array.from({ length: n }, () => new Set());
    const indeg = new Array(n).fill(0);
    const addEdge = (from, to) => {
        if (from === to || adj[from].has(to)) return;
        adj[from].add(to);
        indeg[to]++;
    };
    steps.forEach((s, i) => {
        for (const sym of (s.usesSymbols || [])) {
            const d = definerOf.get(sym);
            if (d !== undefined && d !== i && !(s.definesSymbols || []).includes(sym)) addEdge(d, i);
        }
        for (const dep of (s.dependsOn || [])) {
            const d = idIndex.get(dep);
            if (d !== undefined) addEdge(d, i);
        }
    });

    // Kahn's algorithm, tie-broken by recorded order (stable).
    const out = [];
    const ready = [];
    for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);
    while (ready.length) {
        ready.sort((a, b) => a - b);
        const i = ready.shift();
        out.push(i);
        for (const j of adj[i]) if (--indeg[j] === 0) ready.push(j);
    }
    if (out.length < n) {
        // Cycle (mutual redefinition) — append the remainder in recorded order.
        const placed = new Set(out);
        for (let i = 0; i < n; i++) if (!placed.has(i)) out.push(i);
        diagnostics.push({
            type: 'dependency_cycle',
            details: 'Dependency cycle among recorded steps — cyclic part left in recorded order.',
        });
    }
    const changed = out.some((v, k) => v !== k);
    if (changed) {
        diagnostics.push({
            type: 'reordered',
            details: `Steps reordered by dependency: ${out.map(i => steps[i].id).join(' → ')}`,
        });
    }
    return out.map(i => steps[i]);
}

// ── Probe auto-recovery (H2, run Q_3VRPXL) ─────────────────────────────────
//
// The model records a fraction of its clean probes (6 of 37 in Q_3VRPXL); the
// rest live only in probe history. When a closure step USES a symbol that no
// recorded step / util / input defines, the derivation exists — it just was
// never recorded. Recover it: find the latest clean probe that defines the
// symbol and inject it as a synthetic step (auto:true, visibly marked in the
// notebook). Iterates because a recovered probe may itself use further
// unrecorded symbols.

/**
 * @param {object[]} ordered      current closure steps
 * @param {object[]} allProbes    all persisted probes (any order; must carry .ok/.code)
 * @param {Set<string>} known     symbols defined outside steps (utils, inputs)
 * @param {object[]} diagnostics  mutated with {type:'auto_recovered_probe'} entries
 * @returns {object[]}            steps including synthetic recovered ones
 */
function recoverMissingDefiners(ordered, allProbes, known, diagnostics = []) {
    const steps = ordered.slice();
    const okProbes = (allProbes || []).filter(p => p && p.ok && p.code);
    // Latest clean probe defining each symbol (probe ids sort chronologically: p001…).
    const probeDefiner = new Map();
    for (const p of okProbes.sort((a, b) => String(a.probeId).localeCompare(String(b.probeId)))) {
        const { definesSymbols } = analyzeCode(p.code);
        for (const sym of definesSymbols) probeDefiner.set(sym, p);
    }

    for (let round = 0; round < 10; round++) {
        const defined = new Set(known);
        for (const s of steps) for (const sym of (s.definesSymbols || [])) defined.add(sym);
        const inChain = new Set(steps.map(s => s.probeId).filter(Boolean));

        const missing = [];
        for (const s of steps) {
            for (const sym of (s.usesSymbols || [])) {
                if (!defined.has(sym) && !missing.includes(sym)) missing.push(sym);
            }
        }
        const recoverable = missing.filter(sym => {
            const p = probeDefiner.get(sym);
            return p && !inChain.has(p.probeId);
        });
        if (!recoverable.length) break;

        const added = new Set();
        for (const sym of recoverable) {
            const p = probeDefiner.get(sym);
            if (added.has(p.probeId)) continue;
            added.add(p.probeId);
            const a = analyzeCode(p.code);
            steps.push({
                id:             `auto_${p.probeId}`,
                probeId:        p.probeId,
                code:           p.code,
                resultRef:      p.probeId,
                dependsOn:      [],
                usesSymbols:    a.usesSymbols.slice(0, 40),
                definesSymbols: a.definesSymbols,
                note:           `auto-recovered from probe ${p.probeId} (defines ${a.definesSymbols.slice(0, 4).join(', ')}) — the agent used this result but never recorded it`,
                status:         'valid',
                auto:           true,
            });
            diagnostics.push({
                type:    'auto_recovered_probe',
                probeId: p.probeId,
                symbols: a.definesSymbols.slice(0, 6),
                details: `Unrecorded probe ${p.probeId} injected — closure needed ${sym}.`,
            });
        }
    }
    return steps;
}

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

    // H2 (run Q_3VRPXL): recover unrecorded definer probes — the model records a
    // fraction of its clean probes; symbols the chain USES but never RECORDED are
    // pulled in from probe history as clearly-marked synthetic steps.
    try {
        const allProbes = typeof workDir.loadAllProbes === 'function'
            ? await workDir.loadAllProbes()
            : await workDir.loadRecentProbes(500).catch(() => []);
        const known = new Set();
        for (const u of loadedUtils)  if (u && u.name) known.add(u.name);
        for (const inp of loadedInputs) {
            const a = analyzeCode((inp && inp.code) || '');
            for (const sym of a.definesSymbols) known.add(sym);
        }
        ordered = recoverMissingDefiners(ordered, allProbes, known, allDiagnostics);
    } catch (_) { /* recovery is best-effort — compile proceeds with recorded steps */ }

    // H1 (run Q_3VRPXL): dependency-order the closure. Exploration order put a
    // gmGens-USING cell four cells before the gmGens-DEFINING cell; polish cannot
    // move cells, so the run died. Recorded order is only a tie-breaker now.
    ordered = topoSortSteps(ordered, allDiagnostics);

    // Step 1: Always write clean.wb as raw JSON to disk first.
    // run_clean reads the file via fsp.readFile, so it must be on disk before the
    // polish phase starts. The VS Code writeNotebook callback (step 2) may overwrite
    // the file, but step 1 guarantees a readable file at polish entry.
    //
    // I1 (run Q_2N8616): the deliverable no longer embeds an Off[...] suppression
    // cell — shipping "## Suppressed non-critical warnings" in a verified notebook
    // reads as hiding problems. Verification behaviour is unchanged: run_clean's
    // kernel restart re-applies the suppression via the post-restart seeder, and the
    // message classifier already treats those tags as non-failing. A user re-running
    // clean.wb may see the soft solver warnings — that is honest.
    const cleanNbPath = await workDir.writeCleanNotebook({
        steps:       ordered,
        inputs:      loadedInputs,
        assumptions: loadedAssumptions,
        taskTitle,
        utils:       loadedUtils,
        skillsBlock,
    });

    // Step 2: If a VS Code API callback is provided, open the notebook as a live
    // notebook document so the user sees it with proper cell rendering.
    // Non-fatal: run_clean still works even if the callback fails.
    if (typeof writeNotebook === 'function') {
        const { buildCleanCells } = require('./workDir');
        const cells = buildCleanCells({ steps: ordered, inputs: loadedInputs, assumptions: loadedAssumptions, taskTitle, utils: loadedUtils, skillsBlock });
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

module.exports = { compile, computeClosure, staticCheck, topoSortSteps, recoverMissingDefiners };
