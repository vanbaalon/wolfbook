'use strict';

/**
 * Capability-based evaluation for Oberon research runs.
 *
 * This module deliberately separates observable harness evidence from semantic
 * scientific judgement. Deterministic telemetry can establish reproducibility,
 * activity, or the presence of artefacts; it cannot establish that a model,
 * interpretation, literature claim, or novelty claim is scientifically correct.
 */

const RUBRIC_VERSION = 'oberon-research-capabilities/1.0.0';
const STATUSES = new Set(['pass', 'partial', 'fail', 'unassessed']);

const CAPABILITIES = Object.freeze([
    cap('problem_formulation', 1.0, 'Problem formulation', 'Scope, conventions, missing parameters, and assumptions are explicit.'),
    cap('literature_grounding', 0.8, 'Literature grounding', 'Canonical sources are found and precise claims are traceable to them.'),
    cap('hypothesis_quality', 0.8, 'Hypothesis quality', 'Competing, falsifiable hypotheses and predictions are stated before testing.'),
    cap('experimental_design', 1.0, 'Experimental design', 'Methods, controls, baselines, stopping rules, and discriminating tests are explicit.'),
    cap('implementation_correctness', 1.2, 'Implementation correctness', 'Executable work implements the intended method without runtime or semantic defects.'),
    cap('numerical_validity', 1.2, 'Numerical validity', 'Precision, conditioning, convergence, stability, and residuals are addressed.'),
    cap('coverage_completeness', 1.2, 'Coverage and completeness', 'All requested sectors, branches, cases, or parameter ranges are accounted for.'),
    cap('interpretation', 1.0, 'Interpretation', 'Conclusions follow from observations and distinguish evidence from speculation.'),
    cap('reproducibility', 1.2, 'Reproducibility', 'Artefacts execute in a fresh environment and provenance is retained.'),
    cap('uncertainty_calibration', 0.8, 'Uncertainty calibration', 'Uncertainty is decomposed and confidence is empirically calibrated.'),
    cap('novelty_assessment', 0.8, 'Novelty assessment', 'Novelty is supported by prior-art search and reviewed evidence.'),
]);

function cap(id, weight, label, description) {
    return Object.freeze({ id, weight, label, description });
}

function blankAssessment(id) {
    const def = CAPABILITIES.find(c => c.id === id);
    if (!def) throw new Error(`Unknown research capability: ${id}`);
    return {
        capability: id,
        status: 'unassessed',
        score: null,
        grader: 'none',
        rationale: 'No admissible evidence was available for this capability.',
        evidence: [],
    };
}

function eventPayloads(events, type) {
    return (events || []).filter(e => e && e.type === type).map(e => e.payload || {});
}

function latest(events, type) {
    const xs = eventPayloads(events, type);
    return xs.length ? xs[xs.length - 1] : null;
}

function evidence(type, statement, ref = null) {
    return { type, statement: String(statement), ref };
}

/**
 * Produce conservative deterministic assessments from one run's telemetry.
 * Unobservable scientific dimensions remain unassessed instead of receiving
 * an invented neutral score.
 */
function assessTelemetry(events, meta = {}) {
    const assessments = Object.fromEntries(CAPABILITIES.map(c => [c.id, blankAssessment(c.id)]));
    const quest = latest(events, 'quest.accepted');
    const scrolls = eventPayloads(events, 'scroll.submitted');
    const metrics = eventPayloads(events, 'fairy.run_metrics');
    const phases = eventPayloads(events, 'fairy.phase');
    const lit = eventPayloads(events, 'literature.brief');
    const checks = eventPayloads(events, 'validation.check');
    const checkpoints = eventPayloads(events, 'checkpoint.recorded');
    const terminal = scrolls.length ? scrolls[scrolls.length - 1] : null;

    if (quest) {
        const criteria = Array.isArray(quest.successCriteria) ? quest.successCriteria : [];
        assessments.problem_formulation = judgement(
            criteria.length ? 'partial' : 'fail',
            criteria.length ? 0.65 : 0.2,
            'deterministic',
            criteria.length
                ? 'The accepted Quest records explicit success criteria; semantic adequacy still requires expert grading.'
                : 'The accepted Quest has no explicit success criteria.',
            [evidence('telemetry', `${criteria.length} success criterion/criteria recorded`, 'quest.accepted')],
        );
    }

    if (lit.length) {
        const papers = lit.reduce((n, x) => n + (Array.isArray(x.papers) ? x.papers.length : 0), 0);
        assessments.literature_grounding = judgement(
            papers > 0 ? 'partial' : 'fail', papers > 0 ? 0.5 : 0.1, 'deterministic',
            papers > 0
                ? 'Literature was consulted, but telemetry alone cannot establish that cited papers support the exact claims.'
                : 'Literature activity produced no paper evidence.',
            [evidence('telemetry', `${lit.length} literature brief(s), ${papers} paper entry/entries`, 'literature.brief')],
        );
    }

    const allClean = terminal && terminal.status === 'delivered' && terminal.cleanNbPath;
    const partial = terminal && terminal.status === 'partial_delivered';
    if (terminal) {
        assessments.reproducibility = judgement(
            allClean ? 'pass' : (partial ? 'partial' : 'fail'),
            allClean ? 1 : (partial ? 0.45 : 0),
            'deterministic',
            allClean
                ? 'A clean notebook artefact was delivered after the fresh-kernel replay path.'
                : (partial ? 'Only a partial notebook was delivered; full clean replay was not established.' : 'No clean replay artefact was delivered.'),
            [evidence('artifact', terminal.cleanNbPath || terminal.partialNbPath || 'no notebook path', 'scroll.submitted')],
        );
    }

    if (metrics.length) {
        const probesOk = metrics.reduce((n, m) => n + (Number(m.probesOk) || 0), 0);
        const probesFailed = metrics.reduce((n, m) => n + (Number(m.probesFailed) || 0), 0);
        const records = metrics.reduce((n, m) => n + (Number(m.records) || 0), 0);
        assessments.implementation_correctness = judgement(
            allClean ? 'partial' : (probesOk ? 'partial' : 'fail'),
            allClean ? 0.75 : (probesOk ? 0.4 : 0.05),
            'deterministic',
            allClean
                ? 'Recorded code replayed, but whether it implements the intended scientific object requires semantic grading.'
                : 'Some code may have executed, but no complete clean replay established implementation correctness.',
            [evidence('telemetry', `${probesOk} successful probe(s), ${probesFailed} failed, ${records} recorded step(s)`, 'fairy.run_metrics')],
        );
    }

    if (checks.length) {
        const failed = checks.filter(c => c.ok === false || c.passed === false).length;
        assessments.numerical_validity = judgement(
            failed ? 'fail' : 'partial', failed ? 0.15 : 0.55, 'deterministic',
            failed
                ? `${failed} validation check(s) failed.`
                : 'Recorded validation checks passed, but convergence and conditioning require claim-specific grading.',
            [evidence('telemetry', `${checks.length - failed}/${checks.length} validation check(s) passed`, 'validation.check')],
        );
    }

    const crosschecks = (terminal && Array.isArray(terminal.steps))
        ? terminal.steps.filter(s => s && s.role === 'crosscheck').length : 0;
    if (terminal && Array.isArray(terminal.steps)) {
        assessments.experimental_design = judgement(
            crosschecks ? 'partial' : 'fail', crosschecks ? 0.5 : 0.15, 'deterministic',
            crosschecks
                ? 'At least one cross-check was recorded; controls, baselines, and discrimination among hypotheses remain semantically unassessed.'
                : 'No recorded cross-check was visible in the terminal artefact.',
            [evidence('artifact', `${crosschecks} recorded cross-check step(s)`, 'scroll.submitted.steps')],
        );
    }

    return makeReport({
        assessments: Object.entries(assessments).map(([capability, assessment]) => ({
            capability, ...assessment,
        })),
        meta: {
            runId: meta.runId || ((events || [])[0] && events[0].runId) || null,
            build: meta.build || (metrics.length && metrics[metrics.length - 1].build) || null,
            eventCount: (events || []).length,
            phaseCount: phases.length,
            checkpointCount: checkpoints.length,
            source: meta.source || 'telemetry',
        },
    });
}

function judgement(status, score, grader, rationale, evidenceItems = []) {
    if (!STATUSES.has(status)) throw new Error(`Invalid capability status: ${status}`);
    if (status === 'unassessed') score = null;
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 1)) {
        throw new Error(`Capability score must be in [0,1] or null: ${score}`);
    }
    return { status, score, grader, rationale: String(rationale || ''), evidence: evidenceItems.slice() };
}

function normalizeAssessment(a) {
    const base = blankAssessment(a.capability);
    const j = judgement(a.status || base.status, a.score === undefined ? base.score : a.score,
        a.grader || base.grader, a.rationale || base.rationale,
        Array.isArray(a.evidence) ? a.evidence : []);
    return { capability: a.capability, ...j };
}

function makeReport({ assessments, meta = {} }) {
    const byId = new Map((assessments || []).map(a => [a.capability, normalizeAssessment(a)]));
    const ordered = CAPABILITIES.map(c => byId.get(c.id) || blankAssessment(c.id));
    let weighted = 0, assessedWeight = 0, totalWeight = 0;
    for (const c of CAPABILITIES) {
        totalWeight += c.weight;
        const a = ordered.find(x => x.capability === c.id);
        if (a.score !== null) {
            weighted += a.score * c.weight;
            assessedWeight += c.weight;
        }
    }
    return {
        schemaVersion: RUBRIC_VERSION,
        generatedAt: new Date().toISOString(),
        meta,
        summary: {
            score: assessedWeight ? +(weighted / assessedWeight).toFixed(3) : null,
            assessmentCoverage: totalWeight ? +(assessedWeight / totalWeight).toFixed(3) : 0,
            assessedCapabilities: ordered.filter(a => a.score !== null).length,
            totalCapabilities: CAPABILITIES.length,
            statusCounts: Object.fromEntries([...STATUSES].map(s => [s, ordered.filter(a => a.status === s).length])),
        },
        assessments: ordered,
    };
}

function compareReports(baseline, candidate, tolerance = 0.02) {
    const b = new Map((baseline.assessments || []).map(a => [a.capability, a]));
    const c = new Map((candidate.assessments || []).map(a => [a.capability, a]));
    const changes = [];
    for (const def of CAPABILITIES) {
        const before = b.get(def.id), after = c.get(def.id);
        const beforeScore = before && before.score;
        const afterScore = after && after.score;
        let classification = 'uncomparable';
        let delta = null;
        if (beforeScore !== null && beforeScore !== undefined && afterScore !== null && afterScore !== undefined) {
            delta = +(afterScore - beforeScore).toFixed(3);
            classification = delta < -tolerance ? 'regression' : (delta > tolerance ? 'improvement' : 'stable');
        }
        changes.push({ capability: def.id, before: beforeScore ?? null, after: afterScore ?? null, delta, classification });
    }
    return {
        tolerance,
        regressions: changes.filter(x => x.classification === 'regression'),
        improvements: changes.filter(x => x.classification === 'improvement'),
        changes,
    };
}

function toMarkdown(report) {
    const lines = [
        `# Oberon research capability report`, '',
        `- Rubric: \`${report.schemaVersion}\``,
        `- Run: \`${report.meta.runId || 'unknown'}\``,
        `- Assessed score: ${report.summary.score === null ? 'n/a' : report.summary.score.toFixed(3)}`,
        `- Assessment coverage: ${(report.summary.assessmentCoverage * 100).toFixed(1)}%`, '',
        '| Capability | Status | Score | Grader | Rationale |',
        '|---|---:|---:|---|---|',
    ];
    for (const a of report.assessments) {
        const def = CAPABILITIES.find(c => c.id === a.capability);
        lines.push(`| ${def.label} | ${a.status} | ${a.score === null ? '—' : a.score.toFixed(2)} | ${a.grader} | ${a.rationale.replace(/\|/g, '\\|')} |`);
    }
    lines.push('', '> Unassessed capabilities are intentionally excluded from the score; coverage must be read alongside it.', '');
    return lines.join('\n');
}

module.exports = {
    RUBRIC_VERSION, CAPABILITIES, assessTelemetry, makeReport,
    compareReports, toMarkdown, judgement, blankAssessment,
};
