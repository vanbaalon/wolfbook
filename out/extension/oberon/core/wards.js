'use strict';
/**
 * Oberon — Ward runner (MVP-4).
 *
 * After the Skeptic accepts (or `needs_review`s) a Scroll, the Wards do an
 * independent *verification* pass: they don't just re-execute the Fairy's
 * expression and string-compare the output (that's the Skeptic's job).
 * Instead, they try to prove the underlying claim by an independent path:
 *
 *   - If the cited output is `True`/`False`, evaluate the expression and
 *     check the returned boolean matches.
 *   - If the cited output is a finite real number, recompute it with
 *     N[..., 20] and compare to the cited value within tolerance.
 *   - If the cited expression looks like an equality (`a == b` at top level),
 *     run `FullSimplify[a - b]` and `PossibleZeroQ`.
 *   - Otherwise, mark the ward `skipped` with a reason.  Skipping is the
 *     correct conservative behaviour — wards must never claim a hard proof
 *     they did not produce.
 *
 * Each evidence item produces ONE ward result (or is skipped).  Wards are
 * advisory: they do not change the Oberon verdict in this MVP, but their
 * outcomes are emitted as `ward.result` telemetry events and persisted to
 * `<quests>/<id>_<short>/wards/W<NN>.json` for the Run Inspector to surface.
 */

const fs   = require('fs');
const path = require('path');

const mathematica = require('../tools/mathematica');
const { makeSpanId } = require('../telemetry/bus');
const project = require('../memory/project');
const {
    EXPR_PREVIEW_CHARS, previewExpr, truncate, parseFiniteNumber,
    formatNum, splitTopLevelEquality,
} = require('./checkUtils');

const MAX_WARDS_PER_RUN   = 16;
const WARD_TIMEOUT_S      = 20;
const NUMERIC_REL_TOL     = 1e-6;

/**
 * Verify a Scroll by running one Ward per cited evidence item where possible.
 *
 * @param {{
 *   scroll: object,
 *   quest:  object,
 *   charm:  object,
 *   bus:    import('../telemetry/bus').TelemetryBus,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<{
 *   results: object[],
 *   summary: { total:number, passed:number, failed:number, skipped:number, errored:number },
 *   spanId: string,
 *   fileRef: { path: string }|null,
 * }>}
 */
async function runWards({ scroll, quest, charm, bus, signal }) {
    const spanId = makeSpanId();
    const evidence = Array.isArray(scroll && scroll.evidence) ? scroll.evidence : [];
    const results  = [];

    if (evidence.length === 0) {
        await bus.appendEvent('ward.result', {
            questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
            wardId: 'W00', wardType: 'none', status: 'skipped', method: 'none',
            passed: null, detail: 'Scroll cites no evidence — nothing to verify.',
            expression: null, durationMs: 0, error: null,
        }, { spanId, questId: quest.id, charmId: charm.id });
        return { results, summary: emptySummary(), spanId, fileRef: null };
    }

    const toCheck = evidence.slice(0, MAX_WARDS_PER_RUN);
    for (let i = 0; i < toCheck.length; i++) {
        const ev = toCheck[i];
        const wardId = padId(i + 1);
        const expr   = String(ev && ev.expression || '').trim();
        const tool   = String(ev && ev.tool || '');
        const output = String(ev && ev.output || '').trim();

        let res;
        if (signal && signal.aborted) {
            res = {
                wardId, status: 'skipped', method: 'none',
                passed: null, detail: 'aborted before verification',
                expression: previewExpr(expr),
                durationMs: 0, error: 'aborted',
            };
        } else if (!expr) {
            res = mkSkip(wardId, expr, 'empty expression');
        } else if (tool && tool !== 'wolfram_eval') {
            res = mkSkip(wardId, expr, `unsupported tool '${tool}'`);
        } else {
            try {
                res = await verifyOne({ wardId, expression: expr, output, signal });
            } catch (e) {
                res = {
                    wardId, status: 'errored', method: 'unknown',
                    passed: null,
                    detail: `ward threw: ${String(e && e.message || e).slice(0, 200)}`,
                    expression: previewExpr(expr),
                    durationMs: 0,
                    error: String(e && e.message || e),
                };
            }
        }
        results.push(res);

        // Emit per-ward telemetry — bounded payload.
        await bus.appendEvent('ward.result', {
            questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
            wardId: res.wardId,
            wardType: res.method,
            status: res.status,
            method: res.method,
            passed: res.passed,
            detail: res.detail,
            expression: res.expression,
            durationMs: res.durationMs,
            error: res.error,
        }, { spanId, questId: quest.id, charmId: charm.id });

        if (signal && signal.aborted) break;
    }

    const summary = rollup(results);

    // Persist a small artefact under quests/<id>/wards/W.json so future runs
    // (and the Run Inspector "open file" link) have something to point at.
    let fileRef = null;
    try {
        fileRef = persistWardArtefact({ quest, charm, scroll, results, summary });
    } catch (_) { /* persistence is best-effort */ }

    return { results, summary, spanId, fileRef };
}

// ── one-ward dispatcher ────────────────────────────────────────────────────

async function verifyOne({ wardId, expression, output, signal }) {
    // 1) Boolean output.
    if (output === 'True' || output === 'False') {
        const r = await mathematica.evaluateBoolean({
            expression, timeoutSeconds: WARD_TIMEOUT_S, signal,
        });
        if (!r.ok) {
            return mkErrored(wardId, expression, 'boolean_eval',
                `evaluation failed: ${r.error || r.kind}`, r);
        }
        if (r.value === null) {
            return mkSkip(wardId, expression,
                `expected True/False, got ${truncate(r.raw, 80)}`, 'boolean_eval', r.durationMs);
        }
        const expected = (output === 'True');
        const passed   = (r.value === expected);
        return {
            wardId, status: passed ? 'passed' : 'failed', method: 'boolean_eval',
            passed,
            detail: `expression evaluated to ${r.value}; cited ${expected}`,
            expression: previewExpr(expression),
            durationMs: r.durationMs,
            error: null,
        };
    }

    // 2) Numeric output — recompute and compare.
    const numericOutput = parseFiniteNumber(output);
    if (numericOutput != null) {
        const r = await mathematica.numericProbe({
            expression, expected: numericOutput,
            tolerance: NUMERIC_REL_TOL,
            timeoutSeconds: WARD_TIMEOUT_S,
            signal,
        });
        if (!r.ok) {
            return mkErrored(wardId, expression, 'numeric_probe',
                `evaluation failed: ${r.error || r.kind}`, r);
        }
        if (r.withinTol === null) {
            return mkSkip(wardId, expression,
                `result not numeric: ${truncate(String(r.value), 80)}`, 'numeric_probe', r.durationMs);
        }
        return {
            wardId, status: r.withinTol ? 'passed' : 'failed', method: 'numeric_probe',
            passed: r.withinTol,
            detail: `recomputed ${formatNum(r.value)}; cited ${formatNum(numericOutput)}; |diff|=${formatNum(r.diff)}`,
            expression: previewExpr(expression),
            durationMs: r.durationMs,
            error: null,
        };
    }

    // 3) Equality expression — try a symbolic identity check.
    const eq = splitTopLevelEquality(expression);
    if (eq) {
        const r = await mathematica.symbolicSimplify({
            lhs: eq.lhs, rhs: eq.rhs,
            timeoutSeconds: WARD_TIMEOUT_S, signal,
        });
        if (!r.ok) {
            return mkErrored(wardId, expression, 'symbolic_simplify',
                `evaluation failed: ${r.error || r.kind}`, r);
        }
        if (r.equal === true) {
            return {
                wardId, status: 'passed', method: 'symbolic_simplify', passed: true,
                detail: 'FullSimplify[lhs - rhs] == 0 (PossibleZeroQ true)',
                expression: previewExpr(expression),
                durationMs: r.durationMs, error: null,
            };
        }
        if (r.equal === false) {
            return {
                wardId, status: 'failed', method: 'symbolic_simplify', passed: false,
                detail: `residual ≠ 0: ${truncate(r.residual, 120)}`,
                expression: previewExpr(expression),
                durationMs: r.durationMs, error: null,
            };
        }
        return mkSkip(wardId, expression,
            `symbolic simplification unresolved (residual: ${truncate(r.residual, 80)})`,
            'symbolic_simplify', r.durationMs);
    }

    // 4) Nothing applicable — conservative skip.
    return mkSkip(wardId, expression,
        'no verification method applies to this evidence shape (not boolean, not numeric, not an equality)');
}

// ── helpers ────────────────────────────────────────────────────────────────

function padId(n) {
    return 'W' + String(n).padStart(2, '0');
}

// previewExpr, truncate, parseFiniteNumber, formatNum, splitTopLevelEquality
// are now imported from ./checkUtils (S3.1).

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

function emptySummary() {
    return { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 };
}

function rollup(results) {
    return {
        total:   results.length,
        passed:  results.filter(r => r.status === 'passed').length,
        failed:  results.filter(r => r.status === 'failed').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        errored: results.filter(r => r.status === 'errored').length,
    };
}

function persistWardArtefact({ quest, charm, scroll, results, summary }) {
    const root = project.questsDir && project.questsDir();
    if (!root) return null;
    const shortName = (quest && quest.shortName) || 'quest';
    const dir = path.join(root, `${quest.id}_${shortName}`, 'wards');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${(scroll && scroll.id) || 'S00'}_${ts}.json`);
    const body = {
        questId: quest.id, charmId: charm.id, scrollId: scroll && scroll.id,
        createdAt: new Date().toISOString(),
        summary, results,
    };
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return { path: file };
}

/**
 * Session-16 helper: turn the deep-check results that the Skeptic produced
 * (Layer-2 ward results, already emitted as `ward.requested` / `ward.result`
 * events from inside the Skeptic) into the legacy `wardOut` shape so that
 * the Scribe, Postmortem and Run Inspector all continue to work without
 * change.
 *
 * Idempotent and side-effect-light: it only persists a small JSON artefact
 * under `<quests>/<id>_<short>/wards/<scrollId>_<ts>.json`.  Returns the
 * same object shape as the legacy `runWards`.
 *
 * @param {{
 *   skeptic: object,                // result of runSkeptic()
 *   quest: object, charm: object, scroll: object,
 * }} args
 * @returns {{ results: object[], summary: object, spanId: string|null, fileRef: object|null }}
 */
function synthesizeWardOutFromSkeptic({ skeptic, quest, charm, scroll }) {
    const results = Array.isArray(skeptic && skeptic.wardResults) ? skeptic.wardResults.slice() : [];
    const summary = (skeptic && skeptic.wardSummary)
        ? { ...skeptic.wardSummary }
        : { total: results.length, passed: 0, failed: 0, skipped: 0, errored: 0 };
    let fileRef = null;
    if (results.length > 0) {
        try { fileRef = persistWardArtefact({ quest, charm, scroll, results, summary }); }
        catch (_) { /* persistence is best-effort */ }
    }
    return {
        results, summary, spanId: (skeptic && skeptic.spanId) || null, fileRef,
    };
}

module.exports = { runWards, splitTopLevelEquality, parseFiniteNumber, synthesizeWardOutFromSkeptic };
