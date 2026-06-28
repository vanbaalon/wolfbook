'use strict';
/**
 * Oberon — Skeptic / Critic (deterministic Reviewer).
 *
 * Architecture (Session 16 update)
 * --------------------------------
 * The Skeptic — also referred to as "the Critic" in user-facing text — runs
 * AFTER the Fairy submits a Scroll and BEFORE the run ends.  It does not
 * call an LLM: every check is a direct kernel evaluation, so the Fairy
 * cannot influence the outcome.
 *
 * For each cited evidence item the Skeptic now performs up to TWO layers of
 * checks:
 *
 *   • LAYER 1 — Re-evaluation (always attempted)
 *       Re-runs the cited Wolfram expression through `wolframShim.evalOnce`
 *       and compares the new output to the value the Fairy reported, with
 *       tolerance for numeric scalars and short numeric vectors.  This
 *       catches output drift, stale state, and outright fabrication.
 *
 *   • LAYER 2 — Deep verification ("Wards") (attempted when shape allows)
 *       Tries to *prove* the underlying claim by an independent path:
 *         - boolean output           → `evaluateBoolean`
 *         - finite real output       → `numericProbe` at N[…, 20]
 *         - top-level `lhs == rhs`   → `symbolicSimplify` (FullSimplify) and,
 *                                      when symbolic doesn't resolve and
 *                                      free symbols are present, a
 *                                      numeric random test
 *         - anything else            → conservatively skipped
 *
 *       Each Layer-2 check emits a `ward.requested` event before it runs
 *       and a `ward.result` event with the outcome.  In the timeline a
 *       Critic check therefore appears as a small pair: "Critic asked for
 *       verification X" → "result passed/failed".  We deliberately use the
 *       existing `ward.*` event type so the UI keeps working unchanged.
 *
 * Verdict policy
 * --------------
 *   accept(verified)   = re-eval all-matched AND ≥1 ward passed AND no ward failed
 *   accept(heuristic)  = re-eval all-matched AND no ward ran/passed
 *   dispute            = any re-eval mismatch OR any ward failed
 *   needs_review       = no evidence to check
 *
 * The structured return adds a `verificationLevel` field
 * ('verified' | 'heuristic' | 'partial' | 'disputed' | 'none') that
 * `reviewLoop.buildOberonVerdict` consumes to refine the user-facing
 * narrative.  The `verdict` field stays in {accept, dispute, needs_review}
 * for backward compatibility with the existing schema.
 */

const wolframShim = require('./wolframShim');
const mathematica = require('../tools/mathematica');
const { makeSpanId } = require('../telemetry/bus');
const settings = require('../config/settings');
const { createCriticNotebookWriter } = require('../memory/criticNotebook');
const { checkMarkdownKaTeX } = require('../../tools/shared');

const RECHECK_TIMEOUT_S    = 20;
const WARD_TIMEOUT_S       = 20;
const NUMERIC_REL_TOL      = 1e-6;
const NUMERIC_ABS_TOL      = 1e-9;
const RANDOM_TEST_TOL      = 1e-6;
const RANDOM_TEST_SAMPLES  = 3;
const SUBSTRING_MIN_LENGTH = 20;
const MAX_EVIDENCE_CHECKED = 16;
const {
    EXPR_PREVIEW_CHARS, previewExpr, truncate, parseFiniteNumber,
    formatNum, splitTopLevelEquality,
} = require('./checkUtils');

async function runSkeptic({ scroll, quest, charm, bus, signal, charmNotebookPath = null, priorChecks = null }) {
    const spanId   = makeSpanId();
    const evidence = Array.isArray(scroll && scroll.evidence) ? scroll.evidence : [];
    const checks   = [];
    const wardResults = [];
    const vc = { reEval: 0, boolean: 0, numeric: 0, symbolic: 0, random: 0, none: 0, cached: 0 };

    // Stage-3 verified-evidence cache. On revision rounds, reviewLoop hands us
    // the prior round's `checks` array. Any evidence whose expression matches
    // a prior check that BOTH (a) re-evaluated successfully with match===true
    // AND (b) had no failed deep checks is considered already-verified and
    // skipped — we re-emit the prior check unchanged. The kernel was restarted
    // & the notebook replayed before this Skeptic pass, so deterministic
    // expressions yield the same result; skipping is safe and saves cost+time.
    const priorIndex = new Map();
    if (Array.isArray(priorChecks)) {
        for (const pc of priorChecks) {
            if (!pc || pc.match !== true || !pc.recheckOk) continue;
            const allDeepOk = !pc.deepChecks || pc.deepChecks.every(d => d.passed !== false);
            if (!allDeepOk) continue;
            const key = String(pc.expression || '').trim();
            if (key) priorIndex.set(key, pc);
        }
    }

    // Stage-3 pre-flight evidence dedupe — if the Scroll repeats the same
    // expression twice, the second is folded into the first (we still emit a
    // skipped entry so the indices line up for objection bookkeeping).
    const seenInScroll = new Map();

    // Create the Critic working notebook up-front so partial results are
    // preserved even if the Skeptic phase is aborted.
    const criticWriter = createCriticNotebookWriter({ quest, charm, bus });
    await criticWriter.init();
    await criticWriter.appendMarkdown(
        `# Critic Notebook \u2014 ${charm.id}\n\n` +
        `**Quest:** ${quest.title || quest.id}  \n` +
        `**Scroll:** ${scroll && scroll.id || 'unknown'}  \n` +
        (charmNotebookPath ? `**Charm notebook:** \`${charmNotebookPath}\`  \n` : '') +
        `**Started:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
    );

    if (evidence.length === 0) {
        const verdict = 'needs_review';
        const objections = ['Scroll cites no executable evidence — claims cannot be re-verified.'];
        const summary = { total: 0, matched: 0, failed: 0, skipped: 0 };
        const wardSummary = emptyWardSummary();
        await criticWriter.appendMarkdown('> _No executable evidence cited — cannot re-verify._');
        await criticWriter.appendVerdictSummary({ verdict, verificationLevel: 'none', objections, summary, wardSummary });
        await criticWriter.save();
        await bus.appendEvent('skeptic.verdict', {
            questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
            verdict, verificationLevel: 'none',
            objections, summary, checks: [], verificationCounts: vc, wardSummary,
            charmNotebookPath,
        }, { spanId, questId: quest.id, charmId: charm.id });
        return { verdict, verificationLevel: 'none', objections, checks, wardResults,
                 wardSummary, summary, verificationCounts: vc, spanId,
                 criticNotebookPath: criticWriter.notebookPath, charmNotebookPath };
    }

    const toCheck = evidence.slice(0, MAX_EVIDENCE_CHECKED);
    let wardCounter = 0;

    for (const [evIdx, ev] of toCheck.entries()) {
        if (signal && signal.aborted) break;
        const tool = String(ev && ev.tool || '');
        const expression = String(ev && ev.expression || '').trim();
        const citedOutput = String(ev && ev.output || '').trim();

        const checkBase = {
            tool, expression,
            originalOutput: ev && ev.output,
            recheckOutput:  null,
            originalOk:     !!(ev && ev.ok),
            recheckOk:      null,
            kind:           'skipped',
            match:          null,
            durationMs:     0,
            reason:         null,
            error:          null,
            deepChecks:     [],
        };

        if (!expression || (tool && tool !== 'wolfram_eval')) {
            const skippedCheck = Object.assign({}, checkBase, {
                reason: expression ? `unsupported tool '${tool}'` : 'empty expression',
            });
            checks.push(skippedCheck);
            await criticWriter.appendEvidenceCheck(ev, skippedCheck);
            continue;
        }

        // Stage-3 prior-verified cache hit — skip re-eval entirely.
        if (priorIndex.has(expression)) {
            const cached = priorIndex.get(expression);
            const cachedCheck = Object.assign({}, checkBase, {
                recheckOutput:   cached.recheckOutput,
                recheckOk:       true,
                kind:            cached.kind || 'ok',
                match:           true,
                durationMs:      0,
                error:           null,
                recheckMessages: cached.recheckMessages || null,
                deepChecks:      Array.isArray(cached.deepChecks) ? cached.deepChecks.slice() : [],
                reason:          'reused from prior revision (kernel state replayed)',
                cached:          true,
            });
            for (const d of cachedCheck.deepChecks) {
                wardResults.push(d);
                vc[d.method] = (vc[d.method] || 0) + 1;
            }
            vc.cached += 1;
            checks.push(cachedCheck);
            await criticWriter.appendEvidenceCheck(ev, cachedCheck);
            try {
                await bus.appendEvent('skeptic.cache_hit', {
                    questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
                    expressionPreview: expression.replace(/\s+/g, ' ').slice(0, 120),
                }, { spanId, questId: quest.id, charmId: charm.id });
            } catch (_) {}
            continue;
        }

        // Stage-3 intra-scroll dedupe — same expression appearing twice in one Scroll.
        if (seenInScroll.has(expression)) {
            const dup = seenInScroll.get(expression);
            const dedupCheck = Object.assign({}, checkBase, {
                recheckOutput:   dup.recheckOutput,
                recheckOk:       dup.recheckOk,
                kind:            dup.kind,
                match:           dup.match,
                durationMs:      0,
                error:           dup.error,
                recheckMessages: dup.recheckMessages || null,
                deepChecks:      [], // already counted on first occurrence
                reason:          'duplicate of an earlier evidence item in this Scroll',
                cached:          true,
            });
            vc.cached += 1;
            checks.push(dedupCheck);
            await criticWriter.appendEvidenceCheck(ev, dedupCheck);
            continue;
        }

        let r;
        try {
            r = await wolframShim.evalOnce({
                expression, timeoutSeconds: RECHECK_TIMEOUT_S, signal,
            });
        } catch (e) {
            r = { ok: false, kind: 'exception', value: '', error: String(e && e.message || e), durationMs: 0 };
        }

        vc.reEval += 1;
        // A 'busy' kernel result means the infrastructure couldn't evaluate
        // the expression — this is not a mathematical dispute. Treat it as
        // inconclusive (match: null) so it doesn't inflate the failed count
        // and does not trigger a 'dispute' verdict.
        const isBusy = r.kind === 'busy';
        const check = Object.assign({}, checkBase, {
            recheckOutput:   r.value,
            recheckOk:       !!r.ok,
            kind:            isBusy ? 'busy' : (r.kind || (r.ok ? 'ok' : 'error')),
            match:           isBusy ? null : (r.ok ? compareOutputs(ev && ev.output, r.value) : false),
            durationMs:      r.durationMs || 0,
            error:           r.error || null,
            recheckMessages: r.messages || null,   // kernel warnings during re-eval
        });

        if (r.ok && !(signal && signal.aborted) && settings.wardsEnabled()) {
            const deep = await runDeepChecksForEvidence({
                wardCounter: wardCounter + 1,
                quest, charm, scroll, bus, signal,
                expression, citedOutput,
            });
            wardCounter += deep.consumed;
            check.deepChecks = deep.checks.map(d => ({ ...d, evidenceIndex: evIdx }));
            for (const d of check.deepChecks) {
                wardResults.push(d);
                vc[d.method] = (vc[d.method] || 0) + 1;
            }
        }

        checks.push(check);
        seenInScroll.set(expression, check);
        await criticWriter.appendEvidenceCheck(ev, check);
    }

    // ── Holistic chain consistency check ──────────────────────────────────
    // When every deep check hits the "no applicable method" path, run all
    // successfully-re-evaluated expressions as a sequential compound expression
    // to test whether the computation chain is internally self-consistent.
    // This catches inter-dependent assignment chains (e.g. BAE root sets) that
    // individually pass re-eval but may contradict each other when composed.
    if (settings.wardsEnabled()) {
        const allDeepNone = checks.every(c =>
            !c.deepChecks ||
            c.deepChecks.length === 0 ||
            c.deepChecks.every(d => d.method === 'none'));
        const chainable = checks.filter(c => c.recheckOk && c.expression && c.kind !== 'skipped');
        if (allDeepNone && chainable.length >= 2 && !(signal && signal.aborted)) {
            wardCounter += 1;
            const chainWardId = padWardId(wardCounter);
            try {
                await bus.appendEvent('ward.requested', {
                    questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
                    wardId: chainWardId, method: 'chain',
                    expression: `${chainable.length}-expression sequence`,
                    detail: 'holistic chain consistency: run all evidence expressions in sequence',
                }, { questId: quest.id, charmId: charm.id });
            } catch (_) {}
            const chainExpr = `(${chainable.map(c => c.expression).join(';\n')}; "chain_ok")`;
            let chainResult;
            try {
                chainResult = await wolframShim.evalOnce({
                    expression: chainExpr,
                    timeoutSeconds: Math.min(RECHECK_TIMEOUT_S * chainable.length, 60),
                    signal,
                });
            } catch (e) {
                chainResult = { ok: false, error: String(e && e.message || e), durationMs: 0 };
            }
            const chainPassed = chainResult.ok && chainResult.value === 'chain_ok';
            const chainWard = {
                wardId:        chainWardId,
                status:        chainPassed ? 'passed' : (chainResult.ok ? 'skipped' : 'errored'),
                method:        'chain',
                passed:        chainPassed,
                evidenceIndex: null,   // applies to the whole chain
                detail:        chainPassed
                    ? `All ${chainable.length} expressions ran in sequence without fatal error.`
                    : `Chain halted: ${String(chainResult.error || chainResult.value || '').slice(0, 200)}`,
                expression:    `${chainable.length}-expression chain`,
                durationMs:    chainResult.durationMs || 0,
                error:         chainResult.error || null,
            };
            wardResults.push(chainWard);
            vc.chain = (vc.chain || 0) + 1;
            try {
                await bus.appendEvent('ward.result', {
                    questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
                    wardId: chainWard.wardId, wardType: 'chain', status: chainWard.status,
                    method: 'chain', passed: chainWard.passed, detail: chainWard.detail,
                    expression: chainWard.expression, durationMs: chainWard.durationMs,
                    error: chainWard.error,
                }, { questId: quest.id, charmId: charm.id });
            } catch (_) {}
            await criticWriter.appendEvidenceCheck(
                { tool: 'chain', expression: chainExpr.slice(0, 300) }, chainWard);
        }
    }

    // ── Charm-level validation checks ────────────────────────────────────────
    // validationChecks are domain-knowledge expressions generated by the Planner
    // (an LLM with broad knowledge) and embedded in the Charm definition. They
    // test correctness from first principles — independent of what the Fairy did.
    // IMPORTANT: We build kernel state by re-running all chainable evidence in one
    // compound expression BEFORE each validation check, so that variables assigned
    // by the Fairy (e.g. H, eigenvalues) are in scope even if the chain ward or
    // earlier re-eval calls left the kernel in an uncertain state.
    if (settings.wardsEnabled()) {
        const validations = Array.isArray(charm.validationChecks)
            ? charm.validationChecks.filter(s => typeof s === 'string' && s.trim())
            : [];

        // Build a state-setup prefix from all successfully re-evaluated evidence.
        const chainable = checks.filter(c => c.recheckOk && c.expression && c.kind !== 'skipped');
        const setupPrefix = chainable.length > 0
            ? chainable.map(c => c.expression).join(';\n') + ';\n'
            : '';

        for (const expr of validations) {
            if (signal && signal.aborted) break;
            wardCounter += 1;
            const valWardId = padWardId(wardCounter);
            try {
                await bus.appendEvent('ward.requested', {
                    questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
                    wardId: valWardId, method: 'validation',
                    expression: expr,
                    detail: 'planner-generated domain validation check',
                }, { questId: quest.id, charmId: charm.id });
            } catch (_) {}
            // Wrap: run setup (to define Fairy-assigned vars) then run the check.
            const wrappedExpr = setupPrefix
                ? `(${setupPrefix}${expr})`
                : expr;
            let vResult;
            try {
                vResult = await wolframShim.evalOnce({
                    expression: wrappedExpr,
                    timeoutSeconds: RECHECK_TIMEOUT_S + (setupPrefix ? Math.min(chainable.length * 5, 30) : 0),
                    signal,
                });
            } catch (e) {
                vResult = { ok: false, error: String(e && e.message || e), durationMs: 0 };
            }
            // Pass when ok:true AND (value === "True" OR abs(numeric) < 1e-8)
            const valStr   = String(vResult.value || '').trim();
            const isTrue   = valStr === 'True';
            const numVal   = parseFloat(valStr);
            const isNearZero = !isNaN(numVal) && Math.abs(numVal) < 1e-8;
            const passed   = vResult.ok && (isTrue || isNearZero);
            const valWard  = {
                wardId:        valWardId,
                status:        passed ? 'passed' : (vResult.ok ? 'failed' : 'errored'),
                method:        'validation',
                passed,
                evidenceIndex: null,
                detail:        passed
                    ? `Validation check passed: ${expr.slice(0, 120)} → ${valStr.slice(0, 80)}`
                    : `Validation check FAILED: ${expr.slice(0, 120)} → ${(vResult.error || valStr).slice(0, 200)}`,
                expression:    expr,
                durationMs:    vResult.durationMs || 0,
                error:         vResult.error || null,
            };
            wardResults.push(valWard);
            vc.validation = (vc.validation || 0) + 1;
            try {
                await bus.appendEvent('ward.result', {
                    questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
                    wardId: valWard.wardId, wardType: 'validation', status: valWard.status,
                    method: 'validation', passed: valWard.passed, detail: valWard.detail,
                    expression: valWard.expression, durationMs: valWard.durationMs,
                    error: valWard.error,
                }, { questId: quest.id, charmId: charm.id });
            } catch (_) {}
            await criticWriter.appendEvidenceCheck(
                { tool: 'validation', expression: expr }, valWard);
        }
    }

    const summary = {
        total:   checks.length,
        matched: checks.filter(c => c.match === true).length,
        failed:  checks.filter(c => c.match === false).length,
        skipped: checks.filter(c => c.match === null).length,
    };
    const wardSummary = rollupWards(wardResults);

    const reEvalAllMatched = summary.total > 0 && summary.failed === 0 && summary.matched > 0;
    const anyWardFailed    = wardSummary.failed > 0;
    const anyWardPassed    = wardSummary.passed > 0;

    let verdict, verificationLevel;
    const objections = [];

    if (reEvalAllMatched && !anyWardFailed && anyWardPassed) {
        verdict = 'accept';
        verificationLevel = 'verified';
    } else if (reEvalAllMatched && !anyWardFailed && !anyWardPassed) {
        verdict = 'accept';
        verificationLevel = 'heuristic';
    } else if (summary.failed > 0 || anyWardFailed) {
        verdict = 'dispute';
        verificationLevel = (summary.matched > 0 || anyWardPassed) ? 'partial' : 'disputed';

        for (const c of checks) {
            if (c.match !== false) continue;
            const exprPreview = c.expression.replace(/\s+/g, ' ').slice(0, 120);
            if (c.recheckOk) {
                const orig = String(c.originalOutput || '').replace(/\s+/g, ' ').slice(0, 200);
                const re   = String(c.recheckOutput   || '').replace(/\s+/g, ' ').slice(0, 200);
                objections.push(
                    `Re-evaluation of "${exprPreview}" produced "${re}", but the Scroll cites "${orig}". Please reconcile or correct the cited output.`,
                );
            } else {
                objections.push(
                    `Re-evaluation of "${exprPreview}" failed (${c.kind}${c.error ? `: ${String(c.error).slice(0, 200)}` : ''}). The Scroll claimed this evaluation succeeded — please re-run and reconcile.`,
                );
            }
            if (objections.length >= 6) break;
        }
        for (const w of wardResults) {
            if (w.status !== 'failed') continue;
            objections.push(
                `Verification failed (${w.method}): ${String(w.detail || '').slice(0, 240)} — expression: ${String(w.expression || '').slice(0, 120)}`,
            );
            if (objections.length >= 8) break;
        }
    } else if (summary.matched === 0 && summary.skipped === summary.total) {
        verdict = 'needs_review';
        verificationLevel = 'none';
        objections.push('No evidence could be independently re-checked — verdict cannot be issued automatically.');
    } else {
        verdict = 'accept';
        verificationLevel = anyWardPassed ? 'verified' : 'heuristic';
    }

    // ── LaTeX quality check in Scroll text fields ─────────────────────────
    // Zero-tolerance policy: any broken LaTeX in user-facing prose triggers
    // a dispute so the Fairy is forced to fix it before the run accepts.
    {
        const latexIssues = checkScrollLatex(scroll);
        if (latexIssues.length > 0) {
            for (const issue of latexIssues.slice(0, 4)) {
                objections.push(`LaTeX error in Scroll text: ${issue}`);
            }
            // Escalate verdict if we were about to accept
            if (verdict === 'accept') {
                verdict = 'dispute';
                verificationLevel = 'partial';
            }
        }
    }

    // ── Kernel warning objections (independent of match/ward verdict) ──────
    // Report re-evaluation warnings even on an otherwise-accepted scroll so
    // the user sees them in the Critic notebook and the Skeptic verdict event.
    {
        const warned = checks.filter(c => c.recheckMessages && c.recheckOk);
        for (const c of warned) {
            const warnMatches = (c.recheckMessages.match(/\w+::\w+/g) || []);
            const warnCount   = warnMatches.length;
            const hasStop     = /General::stop/i.test(c.recheckMessages);
            if (warnCount >= 3 || hasStop) {
                const exprPreview = c.expression.replace(/\s+/g, ' ').slice(0, 80);
                objections.push(
                    `Kernel warnings during re-eval of "${exprPreview}" ` +
                    `(${warnCount} message${warnCount !== 1 ? 's' : ''}` +
                    `${hasStop ? ', General::stop triggered' : ''}): ` +
                    c.recheckMessages.slice(0, 300),
                );
                // Escalate verdict if we were about to accept
                if (verdict === 'accept') {
                    verdict = 'dispute';
                    verificationLevel = 'partial';
                }
            }
            if (objections.length >= 8) break;
        }
    }

    // Record the verdict in the Critic notebook before emitting the bus event.
    await criticWriter.appendVerdictSummary({ verdict, verificationLevel, objections, summary, wardSummary });
    await criticWriter.save();

    await bus.appendEvent('skeptic.verdict', {
        questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
        verdict, verificationLevel, objections, summary, wardSummary,
        verificationCounts: vc,
        charmNotebookPath,
        checks: checks.map(c => ({
            expression:      String(c.expression).slice(0, 240),
            match:           c.match,
            kind:            c.kind,
            durationMs:      c.durationMs,
            cached:          c.cached === true,
            originalOutput:  String(c.originalOutput  || '').slice(0, 200),
            recheckOutput:   String(c.recheckOutput   || '').slice(0, 200),
            recheckMessages: c.recheckMessages ? String(c.recheckMessages).slice(0, 300) : null,
            error:           c.error || null,
            deepChecks:      (c.deepChecks || []).map(d => ({
                wardId: d.wardId, method: d.method, status: d.status,
                detail: String(d.detail || '').slice(0, 240),
            })),
        })),
    }, { spanId, questId: quest.id, charmId: charm.id });

    return {
        verdict, verificationLevel, objections, checks, wardResults,
        wardSummary, summary, verificationCounts: vc, spanId,
        criticNotebookPath: criticWriter.notebookPath, charmNotebookPath,
    };
}

// ── deep-check dispatcher ──────────────────────────────────────────────────

async function runDeepChecksForEvidence({
    wardCounter, quest, charm, scroll, bus, signal,
    expression, citedOutput,
}) {
    const out = { checks: [], consumed: 0 };
    const emitRequest = async (method, detail) => {
        try {
            await bus.appendEvent('ward.requested', {
                questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
                wardId: padWardId(wardCounter + out.consumed),
                method, expression: previewExpr(expression),
                detail: detail || '',
            }, { questId: quest.id, charmId: charm.id });
        } catch (_) {}
    };
    const emitResult = async (res) => {
        try {
            await bus.appendEvent('ward.result', {
                questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
                wardId: res.wardId, wardType: res.method, status: res.status, method: res.method,
                passed: res.passed, detail: res.detail, expression: res.expression,
                durationMs: res.durationMs, error: res.error,
            }, { questId: quest.id, charmId: charm.id });
        } catch (_) {}
    };

    // 1) Boolean output.
    if (citedOutput === 'True' || citedOutput === 'False') {
        out.consumed += 1;
        const wardId = padWardId(wardCounter + out.consumed - 1);
        await emitRequest('boolean', `expected ${citedOutput}`);
        const r = await mathematica.evaluateBoolean({
            expression, timeoutSeconds: WARD_TIMEOUT_S, signal,
        });
        const w = wardFromBoolean(wardId, expression, citedOutput, r);
        out.checks.push(w);
        await emitResult(w);
        return out;
    }

    // 2) Numeric output — recompute and compare.
    const expectedNumber = parseFiniteNumber(citedOutput);
    if (expectedNumber != null) {
        out.consumed += 1;
        const wardId = padWardId(wardCounter + out.consumed - 1);
        await emitRequest('numeric', `expected ${citedOutput}`);
        // When the Fairy claims a *very small* residual (e.g. 8.7e-83
        // computed at high precision) we MUST NOT compare it against a
        // re-evaluation with the default 1e-6 relative tolerance, because
        // a tiny number times that tolerance is still numerically zero on
        // the order of double precision. Instead, scale the tolerance so
        // a tiny-but-nonzero claim is checked at its own order of
        // magnitude (with one decade of slack), and bump it harder when
        // the expression declares high working precision.
        const magnitude = Math.abs(expectedNumber);
        let tol = NUMERIC_REL_TOL;
        if (magnitude > 0 && magnitude < 1e-10) {
            tol = Math.max(tol, magnitude * 10);
        } else if (magnitude === 0) {
            // Cited literal zero: ensure the re-evaluation is also within
            // a small absolute window.
            tol = Math.max(tol, 1e-12);
        }
        const r = await mathematica.numericProbe({
            expression, expected: expectedNumber,
            tolerance: tol,
            timeoutSeconds: WARD_TIMEOUT_S, signal,
        });
        const w = wardFromNumeric(wardId, expression, expectedNumber, r);
        out.checks.push(w);
        await emitResult(w);
        return out;
    }

    // 3) Top-level equality — try symbolic, then random testing if needed.
    const eq = splitTopLevelEquality(expression);
    if (eq) {
        out.consumed += 1;
        const symWardId = padWardId(wardCounter + out.consumed - 1);
        await emitRequest('symbolic', 'FullSimplify[lhs - rhs]');
        const sr = await mathematica.symbolicSimplify({
            lhs: eq.lhs, rhs: eq.rhs,
            timeoutSeconds: WARD_TIMEOUT_S, signal,
        });
        const symWard = wardFromSymbolic(symWardId, expression, sr);
        out.checks.push(symWard);
        await emitResult(symWard);

        if (symWard.status !== 'passed' && symWard.status !== 'failed' && looksParameterised(expression)) {
            out.consumed += 1;
            const randWardId = padWardId(wardCounter + out.consumed - 1);
            await emitRequest('random', `${RANDOM_TEST_SAMPLES} random substitutions`);
            const rr = await mathematica.numericRandomTest({
                lhs: eq.lhs, rhs: eq.rhs,
                samples: RANDOM_TEST_SAMPLES,
                tolerance: RANDOM_TEST_TOL,
                timeoutSeconds: WARD_TIMEOUT_S, signal,
            });
            const randWard = wardFromRandom(randWardId, expression, rr);
            out.checks.push(randWard);
            await emitResult(randWard);
        }
        return out;
    }

    // 4) Nothing applicable — record a single "skipped" ward.
    out.consumed += 1;
    const wardId = padWardId(wardCounter + out.consumed - 1);
    await emitRequest('none', 'no verification method applies');
    const w = {
        wardId, status: 'skipped', method: 'none', passed: null,
        detail: 'no verification method applies (not boolean, not numeric, not an equality)',
        expression: previewExpr(expression),
        durationMs: 0, error: null,
    };
    out.checks.push(w);
    await emitResult(w);
    return out;
}

// ── ward-result formatters ─────────────────────────────────────────────────

function wardFromBoolean(wardId, expression, citedOutput, r) {
    if (!r.ok) return mkErrored(wardId, expression, 'boolean', `evaluation failed: ${r.error || r.kind}`, r);
    if (r.value === null) {
        return mkSkip(wardId, expression,
            `expected True/False, got ${truncate(r.raw, 80)}`, 'boolean', r.durationMs);
    }
    const expected = (citedOutput === 'True');
    const passed = (r.value === expected);
    return {
        wardId, status: passed ? 'passed' : 'failed', method: 'boolean', passed,
        detail: `expression evaluated to ${r.value}; cited ${expected}`,
        expression: previewExpr(expression),
        durationMs: r.durationMs, error: null,
    };
}

function wardFromNumeric(wardId, expression, expected, r) {
    if (!r.ok) return mkErrored(wardId, expression, 'numeric', `evaluation failed: ${r.error || r.kind}`, r);
    if (r.withinTol === null) {
        return mkSkip(wardId, expression,
            `result not numeric: ${truncate(String(r.value), 80)}`, 'numeric', r.durationMs);
    }
    return {
        wardId, status: r.withinTol ? 'passed' : 'failed', method: 'numeric', passed: r.withinTol,
        detail: `recomputed ${formatNum(r.value)}; cited ${formatNum(expected)}; |diff|=${formatNum(r.diff)}`,
        expression: previewExpr(expression),
        durationMs: r.durationMs, error: null,
    };
}

function wardFromSymbolic(wardId, expression, r) {
    if (!r.ok) return mkErrored(wardId, expression, 'symbolic', `evaluation failed: ${r.error || r.kind}`, r);
    if (r.equal === true) {
        return {
            wardId, status: 'passed', method: 'symbolic', passed: true,
            detail: 'FullSimplify[lhs - rhs] == 0 (PossibleZeroQ true)',
            expression: previewExpr(expression),
            durationMs: r.durationMs, error: null,
        };
    }
    if (r.equal === false) {
        return {
            wardId, status: 'failed', method: 'symbolic', passed: false,
            detail: `residual ≠ 0: ${truncate(r.residual, 120)}`,
            expression: previewExpr(expression),
            durationMs: r.durationMs, error: null,
        };
    }
    return mkSkip(wardId, expression,
        `symbolic simplification unresolved (residual: ${truncate(r.residual, 80)})`,
        'symbolic', r.durationMs);
}

function wardFromRandom(wardId, expression, r) {
    if (!r.ok) return mkErrored(wardId, expression, 'random', `evaluation failed: ${r.error || r.kind}`, r);
    if (r.withinTol === 'all') {
        return {
            wardId, status: 'passed', method: 'random', passed: true,
            detail: `${r.passed}/${r.samples} random samples within tol; worst |res|=${formatNum(r.worstResidual)}`,
            expression: previewExpr(expression),
            durationMs: r.durationMs, error: null,
        };
    }
    if (r.withinTol === 'none' || r.withinTol === 'some') {
        return {
            wardId, status: 'failed', method: 'random', passed: false,
            detail: `${r.failed}/${r.samples} samples produced |res| > tol; worst |res|=${formatNum(r.worstResidual)}`,
            expression: previewExpr(expression),
            durationMs: r.durationMs, error: null,
        };
    }
    return mkSkip(wardId, expression,
        `random testing inconclusive (all ${r.samples} samples non-numeric or skipped)`,
        'random', r.durationMs);
}

// ── helpers ────────────────────────────────────────────────────────────────

function compareOutputs(a, b) {
    if (a == null || b == null) return false;
    const sa = String(a).trim();
    const sb = String(b).trim();
    if (sa === '' || sb === '') return false;

    const na = sa.replace(/\s+/g, ' ');
    const nb = sb.replace(/\s+/g, ' ');
    if (na === nb) return true;

    const fa = parseFloat(sa);
    const fb = parseFloat(sb);
    if (Number.isFinite(fa) && Number.isFinite(fb) && numbersClose(fa, fb)) {
        if (/^[+-]?[\d.eE+\-]+$/.test(sa) && /^[+-]?[\d.eE+\-]+$/.test(sb)) return true;
    }

    const la = extractNumberList(sa);
    const lb = extractNumberList(sb);
    if (la && lb && la.length === lb.length && la.length > 0) {
        if (la.every((x, i) => numbersClose(x, lb[i]))) return true;
    }

    if (na.length >= SUBSTRING_MIN_LENGTH && nb.length >= SUBSTRING_MIN_LENGTH) {
        if (na.includes(nb) || nb.includes(na)) return true;
    }
    return false;
}

function numbersClose(a, b) {
    const diff = Math.abs(a - b);
    if (diff <= NUMERIC_ABS_TOL) return true;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return diff <= NUMERIC_REL_TOL * scale;
}

function extractNumberList(s) {
    const inner = s.replace(/^[\s\{\[\(]+|[\s\}\]\)]+$/g, '');
    if (!inner.includes(',')) return null;
    const parts = inner.split(',').map(t => t.trim());
    if (parts.length === 0) return null;
    const out = [];
    for (const p of parts) {
        const f = parseFloat(p);
        if (!Number.isFinite(f)) return null;
        if (!/^[+-]?[\d.eE+\-]+$/.test(p)) return null;
        out.push(f);
    }
    return out;
}

// parseFiniteNumber + splitTopLevelEquality are now imported from
// ./checkUtils (S3.1).

/**
 * Heuristic: does the expression look like it has free symbols we could
 * usefully randomise?  Strip well-known builtins and numeric literals, then
 * check for any remaining bare identifier.
 */
function looksParameterised(expr) {
    const stripped = String(expr || '')
        .replace(/\b(?:Pi|E|I|True|False|Infinity|Sin|Cos|Tan|Exp|Log|Sqrt|Sum|Integrate|N|Simplify|FullSimplify|Times|Plus|Power|List|Equal|Rule|Function|Hold|Set|SetDelayed)\b/g, '')
        .replace(/\d+(?:\.\d+)?/g, '');
    const m = stripped.match(/[A-Za-z][A-Za-z0-9]*/g) || [];
    return m.length > 0;
}

// previewExpr, truncate, formatNum are now imported from ./checkUtils (S3.1).
function padWardId(n) {
    return 'W' + String(n).padStart(2, '0');
}
function mkSkip(wardId, expression, reason, method = 'none', durationMs = 0) {
    return {
        wardId, status: 'skipped', method,
        passed: null, detail: reason,
        expression: previewExpr(expression),
        durationMs, error: null,
    };
}
function mkErrored(wardId, expression, method, detail, r) {
    return {
        wardId, status: 'errored', method,
        passed: null, detail,
        expression: previewExpr(expression),
        durationMs: r && r.durationMs || 0,
        error: r && r.error || null,
    };
}
function emptyWardSummary() {
    return { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 };
}
function rollupWards(results) {
    return {
        total:   results.length,
        passed:  results.filter(r => r.status === 'passed').length,
        failed:  results.filter(r => r.status === 'failed').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        errored: results.filter(r => r.status === 'errored').length,
    };
}

/**
 * Scan user-facing Scroll text fields for broken LaTeX using the same KaTeX
 * renderer wolfbook uses. Zero-tolerance: any issue triggers a dispute.
 * Returns an array of human-readable issue descriptions.
 */
function checkScrollLatex(scroll) {
    const issues = [];

    const textFields = [
        { name: 'summary',  text: scroll && scroll.summary },
        ...(Array.isArray(scroll && scroll.findings)
            ? scroll.findings.map((f, i) => ({
                name: `findings[${i}]`,
                text: typeof f === 'string' ? f : (f && f.claim || ''),
              }))
            : []),
        ...(Array.isArray(scroll && scroll.openQuestions)
            ? scroll.openQuestions.map((q, i) => ({ name: `openQuestions[${i}]`, text: q }))
            : []),
    ];

    for (const { name, text } of textFields) {
        if (!text || typeof text !== 'string') continue;
        // Use the real KaTeX renderer — same as wolfbook uses for markdown cells.
        const errs = checkMarkdownKaTeX(text);
        for (const { display, latex, message } of errs.slice(0, 3)) {
            const d = display ? '$$' : '$';
            issues.push(
                `KaTeX parse error in ${name}: ${d}${latex.slice(0, 60)}${d} → ${message}. ` +
                `Fix the LaTeX expression.`
            );
        }
        if (issues.length >= 6) break;
    }

    return issues;
}

module.exports = {
    runSkeptic,
    compareOutputs,
    extractNumberList,
    splitTopLevelEquality,
    looksParameterised,
};
