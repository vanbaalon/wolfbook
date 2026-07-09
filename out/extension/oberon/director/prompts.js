'use strict';
/**
 * Oberon Director — prompts + reply parsers.
 *
 * Four LLM interactions, all on the `director` role (falls back to the
 * `oberon` binding — the strongest configured planner model):
 *
 *   1. PLAN       goal → research programme (1–6 fairy-sized stages)
 *   2. ASSESS     delivered stage (clean.wb digest + scroll + facts) → verdict,
 *                 key results, and ONE plan action (continue / revise / insert /
 *                 drop / consult_literature / ask_user / stop_*)
 *   3. SYNTHESIS  all assessments + key results → abstract, conclusions,
 *                 literature comparison, novelty verdict
 *   4. REPORT     synthesis → concise LaTeX report body
 *
 * Parsers are tolerant (fence stripping, first-object extraction) but validate
 * structure; callers run ONE repair turn on failure.
 */

const state = require('./state');

// ── shared JSON helpers ───────────────────────────────────────────────────────

/** Strip fences, extract the first balanced {...}, parse. */
function tryParseJson(text) {
    const s = String(text || '').trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return { ok: true, value: JSON.parse(s) }; } catch (_) { /* fall through */ }
    const start = s.indexOf('{');
    if (start >= 0) {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\' && inStr) { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try { return { ok: true, value: JSON.parse(s.slice(start, i + 1)) }; }
                    catch (e) { return { ok: false, error: `JSON parse failed: ${e.message}` }; }
                }
            }
        }
    }
    return { ok: false, error: 'no JSON object found in reply' };
}

const REPAIR_MSG = (errors) =>
    `Your previous reply was invalid. Errors:\n${errors.map(e => '- ' + e).join('\n')}\n\n` +
    'Reply again with ONLY the JSON object in the required schema. No prose, no fences.';

// ── system prompt ─────────────────────────────────────────────────────────────

const DIRECTOR_SYSTEM_PROMPT = [
    'You are OBERON DIRECTOR — the research director of an autonomous mathematical-physics',
    'research system built on Wolfram Mathematica. You do not compute anything yourself.',
    'You plan, delegate, analyse, and decide.',
    '',
    'Your worker is the FAIRY: a separate LLM agent with a live Wolfram kernel. Per stage it',
    'explores with probes, records a verified derivation chain, and delivers a clean notebook',
    '(clean.wb) that re-executes top-to-bottom in a fresh kernel, plus machine-readable facts.',
    'A fairy stage costs real money and 5–30 minutes. Typical capacity of ONE stage: one',
    'focused computation campaign (build an object, compute a quantity, run one systematic',
    'scan, verify against a known case). It CANNOT do open-ended multi-question research in',
    'one stage, and it starts with NO memory beyond the task text you write.',
    '',
    'RULES:',
    '1. Every stage task must be a complete, self-contained computation spec: state the exact',
    '   objects (with sizes/parameters), conventions (e.g. Pauli vs spin operators, coupling',
    '   signs, boundary conditions), the quantities to produce, and the check that makes the',
    '   stage verifiable (compare to exact diagonalization, known limit, symmetry, etc.).',
    '2. Prefer FEW stages that build on each other over many shallow ones. 2–4 stages is the',
    '   sweet spot; never exceed 6. Early stages should de-risk (small sizes, known limits);',
    '   later stages extend (larger sizes, the actually novel computation).',
    '3. Stage tasks must state numbers, not vibes: "L=8" not "moderate size"; "10 digits" not',
    '   "high precision".',
    '4. When you analyse a delivered stage, judge ONLY from the evidence shown (notebook',
    '   outputs, facts, findings). Never invent results that are not in the material.',
    '5. Key results you extract must each be a single falsifiable statement with the evidence',
    '   that supports it (a number, an equation match, a residual). These are the building',
    '   blocks of the final report — write them so a physicist can quote them.',
    '6. Be decisive about plan changes. A failed stage with a diagnosable cause → revise it',
    '   once with the fix spelled out. A surprising result that opens a better route → say so',
    '   and re-plan. A dead end → stop and report honestly. Do not burn stages repeating a',
    '   failing approach.',
    '6b. PARTIAL deliveries are half-solved problems, not failures. Extract what IS',
    '   established as key results (the fairy\'s verified utilities and facts are',
    '   automatically re-loaded into the next stage\'s kernel and shown in its task, so',
    '   nothing established is lost). Then isolate the precise blocker. If the blocker looks',
    '   like a known problem, consult_literature on it FIRST, then revise_stage with a task',
    '   that (a) names the established results to build on, and (b) spells out the',
    '   literature-informed method for the blocked part. Never write a revised task that',
    '   restarts from scratch when half the work is banked.',
    '7. Literature consults are for: verifying whether a result is known, fetching a needed',
    '   equation/convention, comparing your numbers to published ones, or cracking the',
    '   blocker of a partially-solved stage. Ask ONE sharp question per consult.',
    '8. You never fabricate literature. Comparison claims in the synthesis/report must come',
    '   from the literature briefs you were shown, or be marked as "not checked against',
    '   literature".',
    '9. Reply format is ALWAYS a single JSON object exactly matching the requested schema —',
    '   no markdown fences, no commentary outside JSON (the report step, which asks for',
    '   LaTeX between markers, is the only exception).',
].join('\n');

// ── 1. PLAN ───────────────────────────────────────────────────────────────────

const PLAN_SCHEMA_NOTE = [
    'Reply ONLY with JSON:',
    '{',
    '  "title": "short programme title (≤120 chars)",',
    '  "shortName": "snake_case_slug",',
    '  "objective": "one-paragraph restatement of the research goal (≤800 chars)",',
    '  "finalDeliverable": "what the final report must contain to call this a success (≤400 chars)",',
    '  "missingInfo": ["<parameter> (default: <value>)", ...],   // ≤6; ONLY genuinely under-specified inputs; [] if none',
    '  "stages": [                                               // 1–6 items, executed strictly in order',
    '    {',
    '      "title": "≤120 chars",',
    '      "task": "complete self-contained fairy task (see rules; ≤4000 chars)",',
    '      "successCriteria": ["...", ...],                      // ≤6, each a checkable statement',
    '      "validationChecks": ["<Wolfram expression or check description>", ...],  // ≤4',
    '      "rationale": "why this stage, in one sentence"',
    '    }, ...',
    '  ]',
    '}',
].join('\n');

function buildPlanMessages({ goal, skillHits, grimoireNote, extraNote }) {
    const user = [
        'RESEARCH GOAL (from the user):',
        String(goal || '').slice(0, 6000),
        '',
        skillHits ? `SKILXIV SKILLS that may be relevant (the fairy can recall them; design stages to exploit them):\n${skillHits}\n` : '',
        grimoireNote ? `PRIOR PROJECT KNOWLEDGE:\n${grimoireNote}\n` : '',
        extraNote ? `${extraNote}\n` : '',
        'Design the research programme.',
        '',
        PLAN_SCHEMA_NOTE,
    ].filter(s => s !== '').join('\n');
    return [
        { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
        { role: 'user',   content: user },
    ];
}

function parsePlanReply(text) {
    const p = tryParseJson(text);
    if (!p.ok) return { ok: false, errors: [p.error] };
    const v = p.value || {};
    const errors = [];
    if (!v.title || typeof v.title !== 'string') errors.push('title: required string');
    if (!v.objective || typeof v.objective !== 'string') errors.push('objective: required string');
    if (!Array.isArray(v.stages) || v.stages.length < 1) errors.push('stages: required non-empty array');
    else {
        v.stages = v.stages.slice(0, 6);
        v.stages.forEach((s, i) => {
            if (!s || typeof s !== 'object') { errors.push(`stages[${i}]: must be object`); return; }
            if (!s.title || typeof s.title !== 'string') errors.push(`stages[${i}].title: required string`);
            if (!s.task || typeof s.task !== 'string' || s.task.trim().length < 40) {
                errors.push(`stages[${i}].task: required string (a complete task spec, ≥40 chars)`);
            }
        });
    }
    if (errors.length) return { ok: false, errors };
    return {
        ok: true,
        value: {
            title:            String(v.title).slice(0, 200),
            shortName:        state.slugify(v.shortName || v.title),
            objective:        String(v.objective).slice(0, 2000),
            finalDeliverable: String(v.finalDeliverable || '').slice(0, 800),
            missingInfo:      state.clampStrArray(v.missingInfo, 6, 200),
            stages: v.stages.map(s => ({
                title:            String(s.title).slice(0, 200),
                task:             String(s.task).slice(0, 5500),
                successCriteria:  state.clampStrArray(s.successCriteria, 8, 400),
                validationChecks: state.clampStrArray(s.validationChecks, 6, 400),
                rationale:        String(s.rationale || '').slice(0, 500),
            })),
        },
    };
}

// ── 2. ASSESS ─────────────────────────────────────────────────────────────────

const ASSESS_ACTIONS = Object.freeze([
    'continue', 'revise_stage', 'insert_stage', 'drop_stage',
    'consult_literature', 'ask_user', 'stop_success', 'stop_failure',
]);

const ASSESS_SCHEMA_NOTE = [
    'Reply ONLY with JSON:',
    '{',
    '  "verdict": "achieved" | "partial" | "failed",   // did THIS stage meet its success criteria, judged from evidence',
    '  "surprise": "none" | "minor" | "major",         // did the results deviate from expectation in a way that matters',
    '  "keyResults": [                                  // ≤6; only kernel-evidenced, quotable results',
    '    { "statement": "single falsifiable claim with numbers", "evidence": "which output/fact supports it", "confidence": 0.0-1.0 }',
    '  ],',
    '  "issues": ["problem observed", ...],             // ≤4; [] if clean',
    '  "stageNotes": "≤600 chars — what the NEXT stage must know (conventions fixed, symbols defined, pitfalls found)",',
    '  "action": "continue" | "revise_stage" | "insert_stage" | "drop_stage" | "consult_literature" | "ask_user" | "stop_success" | "stop_failure",',
    '  "reason": "≤400 chars — why this action",',
    '  "revisedStage": { "title", "task", "successCriteria": [], "validationChecks": [] },   // ONLY for revise_stage: the corrected spec for re-running THIS stage',
    '  "newStage":     { "title", "task", "successCriteria": [], "validationChecks": [], "rationale" },  // ONLY for insert_stage: runs immediately next',
    '  "dropStageId": "S03",                            // ONLY for drop_stage: a FUTURE pending stage that is now unnecessary',
    '  "literatureQuestion": "one sharp question",      // ONLY for consult_literature',
    '  "userQuestion": "one question for the human"     // ONLY for ask_user',
    '}',
    '',
    'Action semantics: your verdict + keyResults are banked REGARDLESS of action. "continue"',
    'proceeds to the next pending stage (or synthesis if none remain). "revise_stage" re-runs',
    'the CURRENT stage with your corrected task — use when the cause of failure is diagnosable.',
    '"stop_success" means the goal is already achieved — remaining stages are unnecessary.',
    '"stop_failure" means further stages cannot rescue the programme — be honest.',
    '',
    'On a PARTIAL verdict: the re-run does NOT start from scratch — the verified utilities and',
    'facts of this attempt are re-seeded into the next run\'s kernel, and your banked key',
    'results appear in its task as ESTABLISHED RESULTS. So the ideal partial-recovery play is:',
    'bank the solved half as keyResults now; if the blocker may be known in the literature,',
    'action=consult_literature with a question about the BLOCKER (you will then be asked to',
    'decide again); finally action=revise_stage whose task says "building on <established>,',
    'apply <informed method> to <the blocked part>".',
].join('\n');

function buildAssessMessages({ programme, stage, digest, planView, budgetsNote, litNote }) {
    const user = [
        `PROGRAMME GOAL: ${programme.goal.slice(0, 1200)}`,
        programme.plan && programme.plan.finalDeliverable
            ? `FINAL DELIVERABLE: ${programme.plan.finalDeliverable}` : '',
        '',
        `PLAN STATE:\n${planView}`,
        '',
        `STAGE ${stage.id} "${stage.title}" JUST FINISHED (attempt ${stage.attempt}). Its task was:`,
        String(stage.task).slice(0, 1500),
        '',
        'EVIDENCE (delivered notebook digest, scroll, kernel-verified facts):',
        digest,
        '',
        programme.keyResults.length
            ? `KEY RESULTS BANKED SO FAR:\n${programme.keyResults.map(k => `- [${k.id}/${k.stageId}] ${k.statement}`).join('\n').slice(0, 2000)}\n`
            : '',
        litNote ? `LITERATURE BRIEF (your consult, just completed):\n${litNote}\n` : '',
        budgetsNote ? `BUDGETS: ${budgetsNote}` : '',
        '',
        'Assess this stage and decide the next action.',
        '',
        ASSESS_SCHEMA_NOTE,
    ].filter(s => s !== '').join('\n');
    return [
        { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
        { role: 'user',   content: user },
    ];
}

function parseAssessReply(text) {
    const p = tryParseJson(text);
    if (!p.ok) return { ok: false, errors: [p.error] };
    const v = p.value || {};
    const errors = [];
    if (!['achieved', 'partial', 'failed'].includes(v.verdict)) errors.push("verdict: must be 'achieved'|'partial'|'failed'");
    if (!ASSESS_ACTIONS.includes(v.action)) errors.push(`action: must be one of ${ASSESS_ACTIONS.join('|')}`);
    if (v.action === 'revise_stage' && !(v.revisedStage && typeof v.revisedStage.task === 'string' && v.revisedStage.task.trim().length >= 40)) {
        errors.push('revisedStage.task: required (≥40 chars) when action is revise_stage');
    }
    if (v.action === 'insert_stage' && !(v.newStage && typeof v.newStage.task === 'string' && v.newStage.task.trim().length >= 40)) {
        errors.push('newStage.task: required (≥40 chars) when action is insert_stage');
    }
    if (v.action === 'drop_stage' && !(typeof v.dropStageId === 'string' && v.dropStageId.trim())) {
        errors.push('dropStageId: required when action is drop_stage');
    }
    if (v.action === 'consult_literature' && !(typeof v.literatureQuestion === 'string' && v.literatureQuestion.trim())) {
        errors.push('literatureQuestion: required when action is consult_literature');
    }
    if (v.action === 'ask_user' && !(typeof v.userQuestion === 'string' && v.userQuestion.trim())) {
        errors.push('userQuestion: required when action is ask_user');
    }
    if (errors.length) return { ok: false, errors };

    const cleanStageSpec = (s) => s && typeof s === 'object' ? {
        title:            String(s.title || '').slice(0, 200),
        task:             String(s.task || '').slice(0, 5500),
        successCriteria:  state.clampStrArray(s.successCriteria, 8, 400),
        validationChecks: state.clampStrArray(s.validationChecks, 6, 400),
        rationale:        String(s.rationale || '').slice(0, 500),
    } : null;

    return {
        ok: true,
        value: {
            verdict:  v.verdict,
            surprise: ['none', 'minor', 'major'].includes(v.surprise) ? v.surprise : 'none',
            keyResults: Array.isArray(v.keyResults)
                ? v.keyResults.slice(0, 6).map(k => ({
                    statement:  String((k && k.statement) || '').slice(0, 1200),
                    evidence:   String((k && k.evidence)  || '').slice(0, 800),
                    confidence: (k && typeof k.confidence === 'number') ? Math.max(0, Math.min(1, k.confidence)) : 0.5,
                })).filter(k => k.statement)
                : [],
            issues:     state.clampStrArray(v.issues, 4, 400),
            stageNotes: String(v.stageNotes || '').slice(0, 600),
            action:     v.action,
            reason:     String(v.reason || '').slice(0, 400),
            revisedStage:       cleanStageSpec(v.revisedStage),
            newStage:           cleanStageSpec(v.newStage),
            dropStageId:        v.dropStageId ? String(v.dropStageId).trim() : null,
            literatureQuestion: v.literatureQuestion ? String(v.literatureQuestion).slice(0, 500) : null,
            userQuestion:       v.userQuestion ? String(v.userQuestion).slice(0, 500) : null,
        },
    };
}

// ── 3. SYNTHESIS ──────────────────────────────────────────────────────────────

const SYNTHESIS_SCHEMA_NOTE = [
    'Reply ONLY with JSON:',
    '{',
    '  "abstract": "≤1200 chars — the abstract of the final report: goal, method, headline results with numbers",',
    '  "conclusions": ["numbered conclusion with its supporting evidence", ...],   // ≤8',
    '  "methodSummary": "≤1200 chars — how the results were obtained (kernel-verified pipeline, sizes, checks)",',
    '  "literatureComparison": "≤1000 chars — how the results relate to the consulted papers; or state that no comparison was made",',
    '  "openProblems": ["...", ...],   // ≤6',
    '  "novelty": {',
    '    "considerable": true|false,   // is there a genuinely reusable NEW result/method worth a SkilXiv skill',
    '    "why": "≤400 chars",',
    '    "skillTitle": "≤120 chars — only if considerable",',
    '    "skillSummary": "≤400 chars — what the skill lets an agent do, stated generally",',
    '    "skillMethod": "≤800 chars — the method, stated generally enough to reuse"',
    '  }',
    '}',
    '',
    'Novelty bar: "considerable" means a physicist would learn something from it (a new method',
    'that works, a verified formula/spectrum not in the consulted literature, a nontrivial',
    'negative result with a diagnosis). Routine application of textbook methods is NOT novel.',
].join('\n');

function buildSynthesisMessages({ programme, stageSummaries, literatureNote }) {
    const outcomeCounts = {};
    for (const s of (programme.plan && programme.plan.stages) || []) {
        outcomeCounts[s.status] = (outcomeCounts[s.status] || 0) + 1;
    }
    const user = [
        `PROGRAMME GOAL: ${programme.goal.slice(0, 2000)}`,
        programme.plan && programme.plan.finalDeliverable
            ? `FINAL DELIVERABLE REQUIRED: ${programme.plan.finalDeliverable}` : '',
        programme.assumptions.length
            ? `DECLARED ASSUMPTIONS:\n${programme.assumptions.map(a => `- ${a.statement || a}`).join('\n')}` : '',
        '',
        `STAGE OUTCOMES (${JSON.stringify(outcomeCounts)}):`,
        stageSummaries,
        '',
        'KEY RESULTS (kernel-verified building blocks — quote these):',
        programme.keyResults.length
            ? programme.keyResults.map(k =>
                `- [${k.id}/${k.stageId} conf ${Number(k.confidence).toFixed(2)}] ${k.statement}` +
                (k.evidence ? `  (evidence: ${k.evidence})` : '')).join('\n').slice(0, 6000)
            : '(none banked)',
        '',
        literatureNote ? `LITERATURE CONSULTED:\n${literatureNote}\n` : 'LITERATURE: none consulted during this programme.',
        '',
        'Synthesise the programme findings.',
        '',
        SYNTHESIS_SCHEMA_NOTE,
    ].filter(s => s !== '').join('\n');
    return [
        { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
        { role: 'user',   content: user },
    ];
}

function parseSynthesisReply(text) {
    const p = tryParseJson(text);
    if (!p.ok) return { ok: false, errors: [p.error] };
    const v = p.value || {};
    const errors = [];
    if (!v.abstract || typeof v.abstract !== 'string') errors.push('abstract: required string');
    if (!Array.isArray(v.conclusions) || !v.conclusions.length) errors.push('conclusions: required non-empty array');
    if (errors.length) return { ok: false, errors };
    const nov = (v.novelty && typeof v.novelty === 'object') ? v.novelty : {};
    return {
        ok: true,
        value: {
            abstract:             String(v.abstract).slice(0, 2000),
            conclusions:          state.clampStrArray(v.conclusions, 8, 1200),
            methodSummary:        String(v.methodSummary || '').slice(0, 2000),
            literatureComparison: String(v.literatureComparison || '').slice(0, 1500),
            openProblems:         state.clampStrArray(v.openProblems, 6, 400),
            novelty: {
                considerable: !!nov.considerable,
                why:          String(nov.why || '').slice(0, 400),
                skillTitle:   String(nov.skillTitle || '').slice(0, 120),
                skillSummary: String(nov.skillSummary || '').slice(0, 400),
                skillMethod:  String(nov.skillMethod || '').slice(0, 800),
            },
        },
    };
}

// ── 4. REPORT (LaTeX) ─────────────────────────────────────────────────────────

const REPORT_BEGIN = '%%BEGIN_REPORT';
const REPORT_END   = '%%END_REPORT';

function buildReportMessages({ programme, synthesis, citeKeys }) {
    const user = [
        'Write the FINAL REPORT of the research programme as CONCISE LaTeX (target 2–3 pages).',
        '',
        `TITLE: ${programme.title}`,
        `GOAL: ${programme.goal.slice(0, 1500)}`,
        programme.assumptions.length
            ? `ASSUMPTIONS (declare in the setup section):\n${programme.assumptions.map(a => `- ${a.statement || a}`).join('\n')}` : '',
        '',
        'SYNTHESIS (your own, from the previous step — expand into the report):',
        JSON.stringify(synthesis, null, 2).slice(0, 7000),
        '',
        'KEY RESULTS (each must appear in the report, with its numbers):',
        programme.keyResults.map(k =>
            `- [${k.id} conf ${Number(k.confidence).toFixed(2)}] ${k.statement}`).join('\n').slice(0, 6000) || '(none)',
        '',
        citeKeys && citeKeys.length
            ? 'AVAILABLE CITATIONS — cite with \\cite{<key>}; the bibliography is appended automatically; use ONLY these keys:\n'
              + citeKeys.map(c => `- ${c.key}: ${c.label}`).join('\n')
            : 'CITATIONS: none available — do not use \\cite.',
        '',
        'REQUIREMENTS:',
        `- Output ONLY LaTeX between the exact markers ${REPORT_BEGIN} and ${REPORT_END}.`,
        '- Do NOT include \\documentclass, \\usepackage, \\begin{document}, \\end{document},',
        '  \\maketitle, or any bibliography environment — the wrapper adds them.',
        '- Start with \\begin{abstract}...\\end{abstract}, then \\section{}s: Setup (conventions +',
        '  assumptions), Results (the core — equations and numbers from the key results, use',
        '  equation/align environments), Method (brief; mention every result was kernel-verified',
        '  and the notebooks re-execute cleanly), Discussion (literature comparison, open problems).',
        '- Concise and quantitative. No filler prose. Every numeric claim must come from the key',
        '  results or synthesis above — do not invent numbers.',
        '- Use standard AMS math only (amsmath/amssymb are loaded).',
    ].filter(s => s !== '').join('\n');
    return [
        { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
        { role: 'user',   content: user },
    ];
}

/** Extract the LaTeX body between markers (fallback: whole reply, fences stripped). */
function parseReportReply(text) {
    let s = String(text || '');
    const i = s.indexOf(REPORT_BEGIN);
    const j = s.lastIndexOf(REPORT_END);
    if (i >= 0 && j > i) {
        s = s.slice(i + REPORT_BEGIN.length, j);
    } else {
        s = s.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```\s*$/i, '');
    }
    // Strip anything the wrapper provides (defensive — the model was told not to).
    s = s.replace(/\\documentclass[^\n]*\n/g, '')
         .replace(/\\usepackage[^\n]*\n/g, '')
         .replace(/\\(?:begin|end)\{document\}/g, '')
         .replace(/\\maketitle/g, '')
         .replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, '');
    const body = s.trim();
    if (body.length < 200) return { ok: false, errors: ['report body too short (<200 chars) — write the full report'] };
    return { ok: true, value: body };
}

module.exports = {
    DIRECTOR_SYSTEM_PROMPT,
    tryParseJson, REPAIR_MSG,
    buildPlanMessages, parsePlanReply,
    buildAssessMessages, parseAssessReply, ASSESS_ACTIONS,
    buildSynthesisMessages, parseSynthesisReply,
    buildReportMessages, parseReportReply, REPORT_BEGIN, REPORT_END,
};
