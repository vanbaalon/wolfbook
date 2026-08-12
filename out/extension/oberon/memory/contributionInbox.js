'use strict';
/**
 * Oberon — Stage 2 contribution candidate inbox.
 *
 * SAFETY INVARIANTS (from SKILXIV_FAIRY_STAGE2.md — non-negotiable):
 *  - NO auto-submission. A delivered run only writes a LOCAL candidate here.
 *    The human reviews and approves before anything leaves the machine.
 *  - Private/draft by default once submitted; going public is separate.
 *  - A confidential charm produces NO candidate.
 *  - Non-blocking: writing a candidate never interrupts or fails the run.
 *  - Idempotent: a stable candidate id prevents duplicates on re-run.
 *
 * A candidate is a directory under .oberon/contributions/inbox/<id>/ containing:
 *   candidate.json   — manifest + eligibility + status (pending|submitted|declined)
 *   SKILL.md         — the rendered skill draft (definitions + facts + result)
 * The attached clean.wb is referenced by path (not copied).
 */

const fsp     = require('fs/promises');
const path    = require('path');
const crypto  = require('crypto');
const project = require('./project');

function sha8(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

/**
 * Decide whether a delivered run is eligible to raise a contribution candidate.
 * A minimal subset of the skillability gate (full rubric deferred to Stage 3).
 *
 * @param {{
 *   status: string, confidential?: boolean,
 *   inputs?: any[], outputs?: any[],
 *   hasDefinitions: boolean, factsCount: number,
 * }} ctx
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
function evaluateEligibility(ctx) {
    const reasons = [];
    if (ctx.status !== 'delivered')        reasons.push('run did not deliver');
    if (ctx.confidential)                  reasons.push('charm is confidential');
    if (!ctx.hasDefinitions && !(ctx.factsCount > 0))
        reasons.push('no reusable definitions or established results');
    // Statable inputs/outputs → reusable pattern rather than purely project-specific.
    const hasStatableIO = (Array.isArray(ctx.inputs) && ctx.inputs.length > 0)
        || (Array.isArray(ctx.outputs) && ctx.outputs.length > 0)
        || ctx.factsCount > 0;
    if (!hasStatableIO) reasons.push('inputs/outputs not statable (looks project-specific)');
    return { eligible: reasons.length === 0, reasons };
}

/**
 * Render a SKILL.md-style draft body for the candidate.
 * @param {{ title:string, task:string, definitionsLedger:string, factsLedger:string,
 *           generatedWith?:string, derivedFrom?:string }} a
 * @returns {string}
 */
function renderSkillMd(a) {
    const inputs = Array.isArray(a.inputs) ? a.inputs : [];
    const outputs = Array.isArray(a.outputs) ? a.outputs : [];
    const lines = [
        '---',
        'schema_version: "1.0"',
        `name: ${slug(a.title)}`,
        'namespace: "@draft"',
        'version: 0.1.0',
        'license: CC-BY-4.0',
        `summary: ${JSON.stringify((a.task || a.title).slice(0, 480))}`,
        'runtime: wolfram',
        inputs.length ? 'inputs:' : '',
        ...inputs.slice(0, 12).map((x, i) => `  - name: ${slug((x && x.name) || `input-${i + 1}`)}\n    type: ${JSON.stringify(String((x && x.type) || 'expression'))}\n    description: ${JSON.stringify(String((x && x.description) || 'Input inferred from the verified run.').slice(0, 300))}`),
        outputs.length ? 'outputs:' : '',
        ...outputs.slice(0, 12).map((x, i) => `  - name: ${slug((x && x.name) || `output-${i + 1}`)}\n    type: ${JSON.stringify(String((x && x.type) || 'expression'))}\n    description: ${JSON.stringify(String((x && x.description) || 'Output produced by the verified run.').slice(0, 300))}`),
        'visibility: private',
        a.derivedFrom ? `derived_from: ["${a.derivedFrom}"]` : 'derived_from: []',
        a.generatedWith ? `generated_with: "${a.generatedWith}"` : '',
        '---',
        '',
        `# ${a.title}`,
        '',
        '## Task',
        a.task || a.title,
        '',
    ];
    if (a.definitionsLedger) {
        lines.push('## Verified definitions', '```wolfram', a.definitionsLedger, '```', '');
    }
    if (a.factsLedger) {
        lines.push('## Established results', a.factsLedger, '');
    }
    return lines.filter(l => l !== undefined).join('\n');
}

function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

/**
 * Write a contribution candidate to the review inbox. Non-blocking, idempotent.
 * Returns the candidate descriptor, or null if not eligible / no workspace.
 *
 * @param {{
 *   charmId:string, questId:string, title:string, task:string,
 *   status:string, confidential?:boolean, inputs?:any[], outputs?:any[],
 *   definitionsLedger:string, factsLedger:string, factsCount:number,
 *   cleanNbPath?:string, derivedFrom?:string, generatedWith?:string,
 * }} a
 * @returns {Promise<null | { id:string, dir:string, eligible:boolean, reasons:string[] }>}
 */
async function writeCandidate(a) {
    const inbox = project.contributionsInboxDir();
    if (!inbox) return null;

    const elig = evaluateEligibility({
        status: a.status, confidential: a.confidential,
        inputs: a.inputs, outputs: a.outputs,
        hasDefinitions: !!a.definitionsLedger, factsCount: a.factsCount || 0,
    });
    if (!elig.eligible) return { id: null, dir: null, eligible: false, reasons: elig.reasons };

    // Stable id → re-running the same charm overwrites rather than duplicates.
    const id  = `${a.charmId}-${sha8(a.title + '|' + a.task)}`;
    const dir = path.join(inbox, id);
    await fsp.mkdir(dir, { recursive: true });

    const skillMd = renderSkillMd({
        title: a.title, task: a.task,
        definitionsLedger: a.definitionsLedger, factsLedger: a.factsLedger,
        derivedFrom: a.derivedFrom, generatedWith: a.generatedWith,
        inputs: a.inputs, outputs: a.outputs,
    });
    await fsp.writeFile(path.join(dir, 'SKILL.md'), skillMd, 'utf8');

    const manifest = {
        id,
        status:        'pending',            // pending | submitted | declined
        createdAt:     new Date().toISOString(),
        questId:       a.questId,
        charmId:       a.charmId,
        title:         a.title,
        task:          a.task,
        cleanNbPath:   a.cleanNbPath || null,
        derivedFrom:   a.derivedFrom || null,
        generatedWith: a.generatedWith || null,
        eligible:      true,
        // Evidence (Stage 2 surfaces these; verification pipeline is Stage 3).
        evidence:      { executed_fresh: a.status === 'delivered', skill_self_tests_passed: null },
        redaction: {
            uploadedAutomatically: false,
            included: ['the editable SKILL.md shown in the review panel'],
            omitted: ['raw notebook cells', 'undisplayed task/query text', 'local file paths', 'kernel logs', 'secrets and environment variables'],
        },
        // Filled in by the submit handler after the user approves.
        draftId:       null,
        draftUrl:      null,
        idempotencyKey: id,
    };
    await fsp.writeFile(path.join(dir, 'candidate.json'), JSON.stringify(manifest, null, 2), 'utf8');

    return { id, dir, eligible: true, reasons: [] };
}

/** List all candidates in the inbox (newest first). */
async function listCandidates() {
    const inbox = project.contributionsInboxDir();
    if (!inbox) return [];
    let entries = [];
    try { entries = await fsp.readdir(inbox); } catch (_) { return []; }
    const out = [];
    for (const name of entries) {
        try {
            const m = JSON.parse(await fsp.readFile(path.join(inbox, name, 'candidate.json'), 'utf8'));
            out.push(m);
        } catch (_) { /* skip malformed */ }
    }
    out.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    return out;
}

module.exports = { evaluateEligibility, renderSkillMd, writeCandidate, listCandidates, slug };
