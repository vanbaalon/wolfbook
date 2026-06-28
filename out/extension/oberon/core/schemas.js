'use strict';
/**
 * Oberon — lightweight structural validators.
 *
 * v1 intentionally avoids `ajv` to keep the extension dependency footprint
 * unchanged. The validators here check shape, types, and bounds — enough to
 * gate Planner output before it is written to disk. When a real ajv-based
 * schema layer lands (MVP-2c), these stand-ins map 1:1 to JSON schemas.
 *
 * Every validator returns `{ ok: true, value }` or
 * `{ ok: false, errors: string[] }`.
 */

const ID_RE        = /^Q\d{2,4}([A-Za-z0-9_\-]*)?$/;
const CHARM_ID_RE  = /^C\d{2,4}([A-Za-z0-9_\-]*)?$/;
const SCROLL_ID_RE = /^S\d{2,4}([A-Za-z0-9_\-]*)?$/;
const SHORT_NAME   = /^[a-z][a-z0-9_]{0,40}$/;

function isStr(v, max = 4000) { return typeof v === 'string' && v.length <= max; }
function isNonEmptyStr(v, max = 4000) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function isStrArray(v, max = 32, maxLen = 1000) {
    if (!Array.isArray(v) || v.length > max) return false;
    return v.every(s => isStr(s, maxLen));
}

/**
 * Validate a Quest object (see spec §6.1).
 * Status defaults to 'open' if missing. createdAt defaults to now.
 *
 * @param {any} q
 * @returns {{ok:true, value: object} | {ok:false, errors: string[]}}
 */
function validateQuest(q) {
    const errors = [];
    if (!q || typeof q !== 'object') return { ok: false, errors: ['Quest is not an object'] };

    if (!isNonEmptyStr(q.id, 32))          errors.push('id: missing or invalid string');
    else if (!ID_RE.test(q.id))            errors.push(`id: must match ${ID_RE}`);

    // Normalise shortName to lowercase before validating — LLMs frequently
    // emit mixed-case slugs (e.g. "su4_L4") that are otherwise valid.
    if (q.shortName && typeof q.shortName === 'string') {
        q = { ...q, shortName: q.shortName.toLowerCase() };
    }
    if (!isNonEmptyStr(q.shortName, 40))   errors.push('shortName: missing or invalid string');
    else if (!SHORT_NAME.test(q.shortName)) errors.push(`shortName: must match ${SHORT_NAME}`);

    if (!isNonEmptyStr(q.title, 200))      errors.push('title: missing (max 200 chars)');
    if (!isNonEmptyStr(q.objective, 4000)) errors.push('objective: missing (max 4000 chars)');

    if (!isStrArray(q.successCriteria, 12, 500)) errors.push('successCriteria: must be string[] (≤12, each ≤500 chars)');
    if (!isStrArray(q.risks, 12, 500))           errors.push('risks: must be string[] (≤12, each ≤500 chars)');

    if (q.status !== undefined && !['open', 'blocked', 'done'].includes(q.status)) {
        errors.push("status: must be 'open' | 'blocked' | 'done'");
    }
    if (q.createdAt !== undefined && !isStr(q.createdAt, 40)) errors.push('createdAt: must be ISO string');

    // Optional multi-Charm decomposition: each item is the full task text for one Charm.
    if (q.subtasks !== undefined) {
        if (!Array.isArray(q.subtasks) || q.subtasks.length > 4) {
            errors.push('subtasks: must be string[] (≤4 items)');
        } else if (q.subtasks.some(s => typeof s !== 'string' || s.length > 2000)) {
            errors.push('subtasks: each item must be a non-empty string ≤2000 chars');
        }
    }
    if (q.validationChecks !== undefined && !isStrArray(q.validationChecks, 8, 500)) {
        errors.push('validationChecks: must be string[] (≤8, each ≤500 chars)');
    }

    if (errors.length) return { ok: false, errors };

    const value = {
        id:               String(q.id),
        shortName:        String(q.shortName),
        title:            String(q.title),
        objective:        String(q.objective),
        successCriteria:  q.successCriteria.slice(),
        risks:            q.risks.slice(),
        subtasks:         Array.isArray(q.subtasks) && q.subtasks.length > 0 ? q.subtasks.map(String) : [],
        validationChecks: Array.isArray(q.validationChecks) ? q.validationChecks.slice() : [],
        status:           q.status || 'open',
        createdAt:        q.createdAt || new Date().toISOString(),
    };
    return { ok: true, value };
}

module.exports = { validateQuest, validateCharm, validateScroll, validateSkepticVerdict, validateOberonVerdict };

// ── Charm ────────────────────────────────────────────────────────────────
/**
 * Validate a Charm object — a single, scoped work unit derived from a Quest.
 * Charms are emitted by the Dispatcher (deterministic in MVP-2) and consumed
 * by the Fairy. They are persisted under quests/<qid>/charms/<cid>.json.
 *
 * @param {any} c
 * @returns {{ok:true, value: object} | {ok:false, errors: string[]}}
 */
function validateCharm(c) {
    const errors = [];
    if (!c || typeof c !== 'object') return { ok: false, errors: ['Charm is not an object'] };

    if (!isNonEmptyStr(c.id, 32))             errors.push('id: missing or invalid string');
    else if (!CHARM_ID_RE.test(c.id))         errors.push(`id: must match ${CHARM_ID_RE}`);

    if (!isNonEmptyStr(c.questId, 32))        errors.push('questId: missing');
    else if (!ID_RE.test(c.questId))          errors.push(`questId: must match ${ID_RE}`);

    if (!isNonEmptyStr(c.title, 200))         errors.push('title: missing (max 200 chars)');
    if (!isNonEmptyStr(c.task, 8000))         errors.push('task: missing (max 8000 chars)');

    if (c.deliverables !== undefined && !isStrArray(c.deliverables, 12, 500)) {
        errors.push('deliverables: must be string[] (≤12, each ≤500 chars)');
    }
    if (c.constraints !== undefined && !isStrArray(c.constraints, 12, 500)) {
        errors.push('constraints: must be string[] (≤12, each ≤500 chars)');
    }
    if (c.validationChecks !== undefined && !isStrArray(c.validationChecks, 8, 500)) {
        errors.push('validationChecks: must be string[] (≤8, each ≤500 chars)');
    }
    if (c.createdAt !== undefined && !isStr(c.createdAt, 40)) {
        errors.push('createdAt: must be ISO string');
    }
    if (errors.length) return { ok: false, errors };

    const value = {
        id:               String(c.id),
        questId:          String(c.questId),
        title:            String(c.title),
        task:             String(c.task),
        deliverables:     Array.isArray(c.deliverables)     ? c.deliverables.slice()     : [],
        constraints:      Array.isArray(c.constraints)      ? c.constraints.slice()      : [],
        validationChecks: Array.isArray(c.validationChecks) ? c.validationChecks.slice() : [],
        createdAt:        c.createdAt || new Date().toISOString(),
    };
    return { ok: true, value };
}

// ── Scroll ───────────────────────────────────────────────────────────────
/**
 * Validate a Scroll object — the Fairy's structured text output for a Charm.
 *
 * MVP-2: text-only. Tools/citations land in MVP-2b. Wards land in MVP-3+.
 *
 * @param {any} s
 * @returns {{ok:true, value: object} | {ok:false, errors: string[]}}
 */
function validateScroll(s) {
    const errors = [];
    if (!s || typeof s !== 'object') return { ok: false, errors: ['Scroll is not an object'] };

    if (!isNonEmptyStr(s.id, 32))            errors.push('id: missing or invalid string');
    else if (!SCROLL_ID_RE.test(s.id))       errors.push(`id: must match ${SCROLL_ID_RE}`);

    if (!isNonEmptyStr(s.charmId, 32))       errors.push('charmId: missing');
    else if (!CHARM_ID_RE.test(s.charmId))   errors.push(`charmId: must match ${CHARM_ID_RE}`);

    if (!isNonEmptyStr(s.questId, 32))       errors.push('questId: missing');
    else if (!ID_RE.test(s.questId))         errors.push(`questId: must match ${ID_RE}`);

    if (!isNonEmptyStr(s.summary, 1000))     errors.push('summary: missing (max 1000 chars)');

    if (!Array.isArray(s.findings) || s.findings.length === 0 || s.findings.length > 32) {
        errors.push('findings: must be string[] (1-32 items)');
    } else if (!s.findings.every(x => isStr(x, 4000))) {
        errors.push('findings: each item must be a string ≤4000 chars');
    }

    if (s.openQuestions !== undefined && !isStrArray(s.openQuestions, 12, 500)) {
        errors.push('openQuestions: must be string[] (≤12, each ≤500 chars)');
    }

    if (typeof s.confidence !== 'number' || !(s.confidence >= 0 && s.confidence <= 1)) {
        errors.push('confidence: must be a number in [0, 1]');
    }

    if (s.selfChecks !== undefined) {
        if (!Array.isArray(s.selfChecks) || s.selfChecks.length > 12) {
            errors.push('selfChecks: must be array (≤12 items)');
        } else {
            for (let i = 0; i < s.selfChecks.length; i++) {
                const x = s.selfChecks[i];
                if (!x || typeof x !== 'object'
                    || !isStr(x.description, 500)
                    || typeof x.passed !== 'boolean') {
                    errors.push(`selfChecks[${i}]: must be { description: string, passed: bool }`);
                    break;
                }
            }
        }
    }

    if (s.evidence !== undefined) {
        if (!Array.isArray(s.evidence) || s.evidence.length > 32) {
            errors.push('evidence: must be array (≤32 items)');
        } else {
            for (let i = 0; i < s.evidence.length; i++) {
                const x = s.evidence[i];
                if (!x || typeof x !== 'object'
                    || !isStr(x.tool, 40)
                    || !isStr(x.expression, 1000)
                    || !isStr(x.output, 4000)
                    || typeof x.ok !== 'boolean') {
                    errors.push(`evidence[${i}]: must be { tool: string≤40, expression: string≤1000, output: string≤4000, ok: bool, durationMs?: number }`);
                    break;
                }
                if (x.durationMs !== undefined && typeof x.durationMs !== 'number') {
                    errors.push(`evidence[${i}].durationMs: must be number when present`);
                    break;
                }
            }
        }
    }

    if (s.createdAt !== undefined && !isStr(s.createdAt, 40)) {
        errors.push('createdAt: must be ISO string');
    }
    if (errors.length) return { ok: false, errors };

    const checks = Array.isArray(s.selfChecks)
        ? s.selfChecks.map(x => ({
            description: String(x.description),
            passed:      !!x.passed,
        }))
        : [];

    const evidence = Array.isArray(s.evidence)
        ? s.evidence.map(x => ({
            tool:       String(x.tool),
            expression: String(x.expression),
            output:     String(x.output),
            ok:         !!x.ok,
            durationMs: typeof x.durationMs === 'number' ? x.durationMs : null,
        }))
        : [];

    // Preserve self_review if present — validated lightly (object with string arrays).
    let selfReview = null;
    if (s.self_review && typeof s.self_review === 'object') {
        selfReview = {
            passed:          Array.isArray(s.self_review.passed) ? s.self_review.passed.map(String) : [],
            failed:          Array.isArray(s.self_review.failed) ? s.self_review.failed.map(String) : [],
            confidence_note: typeof s.self_review.confidence_note === 'string'
                ? s.self_review.confidence_note.slice(0, 500) : '',
        };
    }

    const value = {
        id:            String(s.id),
        charmId:       String(s.charmId),
        questId:       String(s.questId),
        summary:       String(s.summary),
        findings:      s.findings.slice(),
        openQuestions: Array.isArray(s.openQuestions) ? s.openQuestions.slice() : [],
        confidence:    Number(s.confidence),
        selfChecks:    checks,
        evidence:      evidence,
        createdAt:     s.createdAt || new Date().toISOString(),
        ...(selfReview ? { self_review: selfReview } : {}),
        ...(s.fallback  ? { fallback: true }  : {}),
    };
    return { ok: true, value };
}

// ── Skeptic verdict ─────────────────────────────────────────────────────
const SKEPTIC_VERDICTS = new Set(['accept', 'dispute', 'needs_review']);

/**
 * @param {any} v
 * @returns {{ok:true, value: object} | {ok:false, errors: string[]}}
 */
function validateSkepticVerdict(v) {
    const errors = [];
    if (!v || typeof v !== 'object') return { ok: false, errors: ['SkepticVerdict is not an object'] };
    if (!SKEPTIC_VERDICTS.has(v.verdict)) errors.push(`verdict: must be one of ${[...SKEPTIC_VERDICTS].join('|')}`);
    if (v.objections !== undefined && !isStrArray(v.objections, 16, 1000)) errors.push('objections: must be string[] (≤16, each ≤1000 chars)');
    if (!v.summary || typeof v.summary !== 'object') errors.push('summary: required object');
    else {
        for (const k of ['total', 'matched', 'failed', 'skipped']) {
            if (typeof v.summary[k] !== 'number') { errors.push(`summary.${k}: must be number`); break; }
        }
    }
    if (errors.length) return { ok: false, errors };
    return {
        ok: true,
        value: {
            verdict:    String(v.verdict),
            objections: Array.isArray(v.objections) ? v.objections.slice() : [],
            summary:    { ...v.summary },
        },
    };
}

// ── Oberon final verdict ────────────────────────────────────────────────
const OBERON_VERDICTS = new Set(['success', 'partial_success', 'failed', 'needs_review']);

/**
 * @param {any} v
 * @returns {{ok:true, value: object} | {ok:false, errors: string[]}}
 */
function validateOberonVerdict(v) {
    const errors = [];
    if (!v || typeof v !== 'object') return { ok: false, errors: ['OberonVerdict is not an object'] };
    if (!OBERON_VERDICTS.has(v.verdict)) errors.push(`verdict: must be one of ${[...OBERON_VERDICTS].join('|')}`);
    if (typeof v.narrative !== 'string' || v.narrative.length === 0 || v.narrative.length > 2000) {
        errors.push('narrative: required string ≤2000 chars');
    }
    if (!v.counts || typeof v.counts !== 'object') errors.push('counts: required object');
    if (v.mainEvidence !== undefined && !isStr(v.mainEvidence, 2000)) errors.push('mainEvidence: must be string ≤2000');
    if (v.mainFailure !== undefined && !isStr(v.mainFailure, 1000)) errors.push('mainFailure: must be string ≤1000');
    if (v.recommendedAction !== undefined && !isStr(v.recommendedAction, 1000)) errors.push('recommendedAction: must be string ≤1000');
    if (errors.length) return { ok: false, errors };
    return {
        ok: true,
        value: {
            verdict:          String(v.verdict),
            narrative:        String(v.narrative),
            counts:           { ...v.counts },
            mainEvidence:     v.mainEvidence ? String(v.mainEvidence) : '',
            mainFailure:      v.mainFailure  ? String(v.mainFailure)  : '',
            recommendedAction: v.recommendedAction ? String(v.recommendedAction) : '',
            // Session-16 additive fields — passed through verbatim when present.
            ...(v.verificationLevel ? { verificationLevel: String(v.verificationLevel) } : {}),
            ...(v.verificationLabel ? { verificationLabel: String(v.verificationLabel) } : {}),
            ...(v.wardSummary       ? { wardSummary: { ...v.wardSummary } }              : {}),
        },
    };
}
